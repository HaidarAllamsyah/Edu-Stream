// ============================================================
// EDUSTREAM - WEBRTC VIDEO CONFERENCE (v6 - FIXED RECORDING & SYNC)
// Features:
// - Canvas-based composite recording (semua peserta + audio mix)
// - Avatar nama saat kamera mati
// - Virtual background (blur)
// - Android screen share fix
// - Host-only recording
// - FIXED: Recording merekam SEMUA peserta (video+audio+chat+screenshare)
// - FIXED: Sinkronisasi peer real-time tanpa refresh
// - FIXED: ICE candidate buffering
// - FIXED: Background tab recording (setInterval fallback)
// ============================================================
'use strict';

const BASE_PATH = window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/') + 1);
const API_SYNC = BASE_PATH + 'api/sync.php';
const API_RECORDING = BASE_PATH + 'api/recording.php';

// ── State ────────────────────────────────────────────────────
let roomId, userName, clientId;
let localStream = null;
let processedStream = null; // stream setelah virtual bg
let screenStream = null;
let peers = {};
let isHost = false;
let micEnabled = true;
let camEnabled = true;
let screenSharing = false;
let chatOpen = false;
let unreadChat = 0;
let lastSignalId = '';
let lastChatId = 0;
let heartbeatTimer = null;
let knownUsers = {};
let seenChatKeys = new Set();
let segmentModel = null;
const POLL_FAST = 300;
const POLL_NORMAL = 1500;

// Recording
let mediaRecorder = null;
let recordingActive = false;
let recordingFileName = null;
let recordedChunks = [];
let chunkFlushTimer = null;
let recCanvas = null;
let recCtx = null;
let recDrawTimer = null;  // setInterval instead of rAF
let recVideoElements = {};
let audioCtx = null;
let audioDest = null;
let audioSources = {};
let placeholderCanvas = null;
let placeholderAnimId = null;
let placeholderStream = null;
let placeholderTrack = null;

// ICE candidate buffering
let iceCandidateBuffer = {}; // peerId -> [candidates]

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
  iceCandidatePoolSize: 10,
  iceTransportPolicy: 'all',
};

// ── Init ─────────────────────────────────────────────────────
async function init() {
  const p = new URLSearchParams(window.location.search);
  roomId = p.get('room');
  userName = localStorage.getItem('userName') || 'User';
  clientId = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  const wantToBeHost = localStorage.getItem('isHost') === 'true';

  if (!roomId) { window.location.href = 'lobby.html'; return; }
  document.getElementById('roomDisplay').textContent = roomId;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
    });
  } catch (e) {
    try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e2) { alert('Gagal akses kamera/mic: ' + e2.message); return; }
  }

  processedStream = localStream;
  renderLocalTile();
  bindToolbar();
  bindChat();

  const jr = await api('join', { roomId, clientId, userName, wantToBeHost });
  if (!jr || !jr.success) {
    alert(jr && jr.error ? jr.error : 'Gagal join room, refresh halaman');
    localStorage.removeItem('isHost');
    window.location.href = 'lobby.html';
    return;
  }
  isHost = jr.isHost;
  console.log('[INIT] Joined as host:', isHost, 'Response:', jr);
  setRecUI(jr.recording);
  updateHostUI();

  // Connect ke SEMUA existing peers — kedua sisi akan coba offer
  if (jr.users && jr.users.length > 0) {
    jr.users.forEach(u => {
      knownUsers[u.clientId] = u.userName;
      // Selalu kirim offer ke semua existing peer
      console.log('[INIT] Creating offer to existing peer:', u.clientId, u.userName);
      createOffer(u.clientId);
    });
  }

  scheduleHeartbeat(0);
  window.addEventListener('beforeunload', leaveRoom);
}

// ── Host UI ───────────────────────────────────────────────────
function updateHostUI() {
  const btn = document.getElementById('btnRecord');
  if (!btn) {
    console.warn('[HOST] Record button not found in DOM');
    return;
  }
  console.log('[HOST] updateHostUI called, isHost=' + isHost);
  if (isHost) {
    btn.classList.add('visible');
    btn.title = 'Mulai Rekaman (Host)';
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
    console.log('[HOST] Record button shown for host');
  } else {
    btn.classList.remove('visible');
    console.log('[HOST] Record button hidden (not host)');
  }
  console.log('[HOST] Button display:', window.getComputedStyle(btn).display);
}

function ensurePlaceholderStream() {
  if (placeholderStream && placeholderTrack && placeholderTrack.readyState !== 'ended') return placeholderStream;
  if (placeholderAnimId) cancelAnimationFrame(placeholderAnimId);
  if (!placeholderCanvas) {
    placeholderCanvas = document.createElement('canvas');
    placeholderCanvas.width = 640;
    placeholderCanvas.height = 360;
  }
  const ctx = placeholderCanvas.getContext('2d');

  function drawPlaceholder() {
    ctx.fillStyle = '#202124';
    ctx.fillRect(0, 0, placeholderCanvas.width, placeholderCanvas.height);
    ctx.fillStyle = '#3c4043';
    ctx.fillRect(0, 0, placeholderCanvas.width, placeholderCanvas.height);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 36px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(userName || 'User', placeholderCanvas.width / 2, placeholderCanvas.height / 2);
    placeholderAnimId = requestAnimationFrame(drawPlaceholder);
  }

  drawPlaceholder();
  placeholderStream = placeholderCanvas.captureStream(15);
  placeholderTrack = placeholderStream.getVideoTracks()[0];
  placeholderTrack.addEventListener('ended', () => {
    placeholderStream = null;
    placeholderTrack = null;
    if (placeholderAnimId) { cancelAnimationFrame(placeholderAnimId); placeholderAnimId = null; }
  });

  return placeholderStream;
}

function getLocalDisplayStream() {
  if (camEnabled && processedStream) return processedStream;
  return ensurePlaceholderStream();
}

function getSendableVideoTrack() {
  if (screenSharing && screenStream && screenStream.getVideoTracks().length) {
    return screenStream.getVideoTracks()[0];
  }
  if (camEnabled && processedStream && processedStream.getVideoTracks().length) {
    return processedStream.getVideoTracks()[0];
  }
  return ensurePlaceholderStream().getVideoTracks()[0];
}

function getOutboundStream() {
  const stream = new MediaStream();
  const track = getSendableVideoTrack();
  if (track) stream.addTrack(track);
  if (localStream && localStream.getAudioTracks) {
    localStream.getAudioTracks().forEach(t => stream.addTrack(t));
  }
  return stream;
}

function replaceLocalVideoTrack(track) {
  if (!track) return;
  Object.values(peers).forEach(({ pc }) => {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) sender.replaceTrack(track);
  });
}

function updateLocalTileStream() {
  const v = document.querySelector('#tile-' + clientId + ' video');
  if (v) v.srcObject = getLocalDisplayStream();
}

// ── Local Tile ────────────────────────────────────────────────
function renderLocalTile() {
  const grid = document.getElementById('video-grid');
  grid.innerHTML = '';
  grid.appendChild(makeTile(clientId, userName + ' (Anda)', getLocalDisplayStream(), true));
  refreshGrid();
}

// ── Tile Factory ─────────────────────────────────────────────
function makeTile(id, label, stream, isLocal) {
  const old = document.getElementById('tile-' + id);
  if (old) old.remove();

  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = 'tile-' + id;

  const vid = document.createElement('video');
  vid.autoplay = true; vid.playsInline = true; vid.muted = isLocal;
  if (stream) vid.srcObject = stream;
  vid.setAttribute('data-peer', id);
  vid.addEventListener('loadedmetadata', () => {
    vid.play().catch(() => { });
  });
  vid.addEventListener('emptied', () => {
    if (stream) vid.srcObject = stream;
  });

  // Avatar overlay (tampil saat kamera mati)
  const av = document.createElement('div');
  av.className = 'avatar-overlay';
  av.id = 'avatar-' + id;
  av.style.display = 'none';

  const avCircle = document.createElement('div');
  avCircle.className = 'avatar-circle';
  avCircle.textContent = (label || 'U')[0].toUpperCase();

  const avName = document.createElement('div');
  avName.className = 'avatar-name';
  avName.textContent = label.replace(' (Anda)', '');

  av.append(avCircle, avName);

  const lbl = document.createElement('div');
  lbl.className = 'video-label';
  lbl.textContent = label;

  tile.append(vid, av, lbl);
  return tile;
}

function showAvatar(id, show) {
  const av = document.getElementById('avatar-' + id);
  const vid = document.querySelector('#tile-' + id + ' video');
  if (!av || !vid) return;
  av.style.display = show ? 'flex' : 'none';
  vid.style.opacity = show ? '0' : '1';
}

function removeTile(id) {
  const t = document.getElementById('tile-' + id);
  if (t) t.remove();
  refreshGrid();
}

function refreshGrid() {
  const grid = document.getElementById('video-grid');
  const count = grid.querySelectorAll('.video-tile:not(.screen-share-tile)').length
    + (screenSharing ? 1 : 0);
  grid.className = 'count-' + Math.max(1, Math.min(count, 9));
  if (screenSharing) grid.classList.add('screenshare-mode');
  document.getElementById('countDisplay').textContent =
    grid.querySelectorAll('.video-tile').length;
}

// ── WebRTC ────────────────────────────────────────────────────
async function createOffer(peerId) {
  if (peers[peerId]) {
    const st = peers[peerId].pc.connectionState;
    if (st === 'connected' || st === 'connecting') {
      console.log('[OFFER] Peer', peerId, 'already', st, '- skipping');
      return;
    }
    closePeer(peerId);
  }
  console.log('[OFFER] Creating offer to', peerId);
  const pc = buildPC(peerId);
  try {
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    await sendSig(peerId, 'offer', pc.localDescription);
    console.log('[OFFER] Offer sent to', peerId);
  } catch (e) { console.error('[offer]', e); }
}

function buildPC(peerId) {
  closePeer(peerId);
  const remoteStream = new MediaStream();
  const pc = new RTCPeerConnection(ICE_CONFIG);
  peers[peerId] = { pc, stream: remoteStream, connected: false };

  // Inisialisasi ICE candidate buffer untuk peer ini
  if (!iceCandidateBuffer[peerId]) iceCandidateBuffer[peerId] = [];

  const outbound = getOutboundStream();
  outbound.getTracks().forEach(t => pc.addTrack(t, outbound));

  pc.onicecandidate = e => {
    if (e.candidate) sendSig(peerId, 'ice-candidate', e.candidate.toJSON());
  };

  pc.ontrack = e => {
    console.log('[TRACK] Received track from', peerId, 'kind:', e.track.kind, 'readyState:', e.track.readyState);

    // Tambahkan semua track ke remoteStream
    e.streams[0].getTracks().forEach(t => {
      // Cek apakah track sudah ada di stream
      const existing = remoteStream.getTracks().find(et => et.id === t.id);
      if (!existing) {
        remoteStream.addTrack(t);
        console.log('[TRACK] Added', t.kind, 'track to remoteStream for', peerId);
      }
    });

    const name = knownUsers[peerId] || 'User';

    // SELALU buat atau update tile
    let tile = document.getElementById('tile-' + peerId);
    if (!tile) {
      console.log('[TRACK] Creating new tile for', peerId, name);
      tile = makeTile(peerId, name, remoteStream, false);
      document.getElementById('video-grid').appendChild(tile);
      refreshGrid();
    } else {
      // Update video srcObject jika berbeda
      const v = tile.querySelector('video');
      if (v && v.srcObject !== remoteStream) {
        console.log('[TRACK] Updating srcObject for tile', peerId);
        v.srcObject = remoteStream;
      }
    }

    // Deteksi kamera mati dari remote
    e.streams[0].getVideoTracks().forEach(t => {
      t.onmute = () => showAvatar(peerId, true);
      t.onunmute = () => showAvatar(peerId, false);
    });

    // Connect audio ke recording mixer jika recording aktif
    if (recordingActive && audioCtx && audioDest) {
      console.log('[REC] Remote track arrived during recording, connecting audio for', peerId);
      connectAudioSource(remoteStream, peerId);
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    console.log('[CONN STATE]', peerId, '->', s);
    console.log('[CONN]', peerId, 'connectionState:', s);

    if (peers[peerId]) {
      peers[peerId].connected = (s === 'connected');
    }

    if (s === 'connected') {
      console.log('[CONN] Successfully connected to', peerId);
    } else if (s === 'disconnected') {
      // Tunggu 3 detik sebelum reconnect — mungkin hanya temporary
      setTimeout(() => {
        if (peers[peerId] && peers[peerId].pc.connectionState === 'disconnected') {
          console.log('[CONN] Peer', peerId, 'still disconnected, reconnecting...');
          showNotif('Reconnecting ' + (knownUsers[peerId] || peerId) + '...');
          createOffer(peerId);
        }
      }, 3000);
    } else if (s === 'failed') {
      showNotif('Reconnecting ' + (knownUsers[peerId] || peerId) + '...');
      setTimeout(() => {
        if (knownUsers[peerId]) {
          console.log('[CONN] Peer', peerId, 'failed, retrying...');
          createOffer(peerId);
        }
      }, 1500);
    }
  };

  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;
    console.log('[ICE STATE]', peerId, '->', state);

    if (state === 'connected' || state === 'completed') {
      if (peers[peerId]) peers[peerId].connected = true;
      console.log('[PEER] Connected:', peerId);
    }

    if (state === 'failed') {
      console.warn('[PEER] Connection failed, attempting restart:', peerId);
      restartPeerIce(peerId);
    }

    if (state === 'disconnected') {
      console.warn('[PEER] Disconnected:', peerId, '- waiting to recover...');
      setTimeout(() => {
        if (peers[peerId]?.pc.iceConnectionState === 'disconnected') {
          console.warn('[PEER] Still disconnected, restarting ICE:', peerId);
          restartPeerIce(peerId);
        }
      }, 5000);
    }
  };

  pc.onicegatheringstatechange = () => {
    console.log('[ICE] Gathering state for', peerId, ':', pc.iceGatheringState);
  };

  return pc;
}

async function restartPeerIce(peerId) {
  const peer = peers[peerId];
  const pc = peer && peer.pc;
  if (!pc || pc.signalingState === 'closed') return;

  try {
    if (typeof pc.restartIce === 'function') pc.restartIce();
  } catch (e) {
    console.warn('[PEER] restartIce failed before offer:', e);
  }

  setTimeout(async () => {
    const current = peers[peerId];
    if (!current || current.pc !== pc || pc.signalingState === 'closed') return;
    try {
      const offer = await pc.createOffer({ iceRestart: true, offerToReceiveAudio: true, offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);
      await sendSig(peerId, 'offer', pc.localDescription);
      console.log('[PEER] ICE restart offer sent to', peerId);
    } catch (e) {
      console.error('[PEER] ICE restart failed:', e);
    }
  }, 1000);
}

async function handleIceCandidate(peerId, candidate) {
  const p = peers[peerId];
  const pc = p && p.pc;

  if (!pc) {
    if (!iceCandidateBuffer[peerId]) iceCandidateBuffer[peerId] = [];
    iceCandidateBuffer[peerId].push(candidate);
    console.log('[ICE] Buffered candidate for unknown peer', peerId);
    return;
  }

  if (!pc.remoteDescription || !pc.remoteDescription.type) {
    if (!iceCandidateBuffer[peerId]) iceCandidateBuffer[peerId] = [];
    iceCandidateBuffer[peerId].push(candidate);
    console.log('[ICE] Buffered candidate for', peerId);
    return;
  }

  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
    console.log('[ICE] Applied candidate for', peerId);
  } catch (e) {
    console.warn('[ICE] Failed to add candidate:', e);
  }
}

// Flush buffered ICE candidates setelah remoteDescription di-set
async function flushIceCandidates(peerId) {
  const buffered = iceCandidateBuffer[peerId] || [];
  const p = peers[peerId];
  if (!p || !p.pc.remoteDescription || !p.pc.remoteDescription.type) return;

  console.log('[ICE] Flushing', buffered.length, 'buffered candidates for', peerId);
  const candidates = buffered.splice(0);
  for (const c of candidates) {
    try {
      await p.pc.addIceCandidate(new RTCIceCandidate(c));
      console.log('[ICE] Applied buffered candidate for', peerId);
    } catch (e) {
      console.warn('[ICE] Flush failed:', e);
    }
  }
  iceCandidateBuffer[peerId] = [];
}

async function handleSignal(sig) {
  const { from, type, data } = sig;
  if (!knownUsers[from]) knownUsers[from] = 'User';

  if (type === 'offer') {
    console.log('[SIGNAL] Received offer from', from);

    // Tetap terima offer saat sudah connected agar ICE restart/renegotiation bisa jalan
    if (peers[from] && peers[from].pc.connectionState === 'connected') {
      console.log('[SIGNAL] Already connected to', from, '- accepting renegotiation offer');
    }

    // Glare resolution: jika kedua sisi kirim offer bersamaan,
    // yang clientId lebih kecil menang sebagai offerer
    if (peers[from] && peers[from].pc.signalingState === 'have-local-offer') {
      if (clientId < from) {
        console.log('[SIGNAL] Glare detected, I win (my ID < their ID), ignoring their offer');
        return;
      } else {
        console.log('[SIGNAL] Glare detected, they win (their ID < my ID), accepting their offer');
        closePeer(from);
      }
    }

    const pc = buildPC(from);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data));
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      await sendSig(from, 'answer', pc.localDescription);
      console.log('[SIGNAL] Answer sent to', from);
      // Flush buffered ICE candidates
      await flushIceCandidates(from);
    } catch (e) { console.error('[answer]', e); }

  } else if (type === 'answer') {
    const p = peers[from];
    if (!p) {
      console.warn('[SIGNAL] Received answer from', from, 'but no peer connection exists');
      return;
    }
    try {
      if (p.pc.signalingState === 'have-local-offer') {
        await p.pc.setRemoteDescription(new RTCSessionDescription(data));
        console.log('[SIGNAL] Answer applied from', from);
        // Flush buffered ICE candidates
        await flushIceCandidates(from);
      } else {
        console.warn('[SIGNAL] Unexpected signalingState for answer:', p.pc.signalingState);
      }
    } catch (e) { console.error('[setRemote]', e); }

  } else if (type === 'ice-candidate') {
    await handleIceCandidate(from, data);
    return;

    const p = peers[from];
    if (!p) {
      // Buffer candidate — peer connection belum dibuat
      if (!iceCandidateBuffer[from]) iceCandidateBuffer[from] = [];
      iceCandidateBuffer[from].push(data);
      console.log('[ICE] Buffered candidate for unknown peer', from);
      return;
    }

    if (!p.pc.remoteDescription) {
      // Buffer candidate — remoteDescription belum di-set
      if (!iceCandidateBuffer[from]) iceCandidateBuffer[from] = [];
      iceCandidateBuffer[from].push(data);
      console.log('[ICE] Buffered candidate for', from, '(no remoteDescription yet)');
      return;
    }

    try {
      await p.pc.addIceCandidate(new RTCIceCandidate(data));
    } catch (e) {
      console.warn('[ICE] Failed to add candidate:', e);
    }
  }
}

function closePeer(id) {
  if (peers[id]) {
    try { peers[id].pc.close(); } catch (_) { }
    delete peers[id];
  }
  // Clean up ICE buffer
  delete iceCandidateBuffer[id];
  // Clean up audio source
  if (audioSources[id]) {
    try { audioSources[id].disconnect(); } catch (_) { }
    delete audioSources[id];
  }
}

// ── Heartbeat ─────────────────────────────────────────────────
let hbRunning = false;

function getActivePollInterval() {
  const isNegotiating = Object.values(peers).some(p =>
    !p.connected ||
    p.pc.iceConnectionState === 'checking' ||
    p.pc.signalingState !== 'stable'
  );
  return isNegotiating ? POLL_FAST : POLL_NORMAL;
}

function scheduleHeartbeat(delay = getActivePollInterval()) {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  heartbeatTimer = setTimeout(heartbeat, delay);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function apiWithRetry(action, data, retries = 3, delayMs = 500) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await api(action, data);
    if (res) return res;
    console.warn('[ICE] API retry', attempt, 'failed for', action);
    if (attempt < retries) await wait(delayMs);
  }
  return null;
}

async function heartbeat() {
  if (hbRunning) {
    scheduleHeartbeat();
    return;
  }
  hbRunning = true;
  try {
    const res = await apiWithRetry('heartbeat', { roomId, clientId, lastSignalId, lastChatId });
    if (!res) return;
    if (res.error === 'not_in_room') { await api('join', { roomId, clientId, userName }); return; }

    const prevHost = isHost;
    isHost = res.isHost;
    if (isHost !== prevHost) {
      console.log('[HEARTBEAT] Host status changed from', prevHost, 'to', isHost);
      updateHostUI();
    }
    setRecUI(res.recording);

    if (res.users) {
      const sids = new Set(res.users.map(u => u.clientId));

      res.users.forEach(u => {
        if (u.clientId === clientId) return;
        const isNew = !knownUsers[u.clientId];
        knownUsers[u.clientId] = u.userName;

        if (isNew) {
          showNotif(u.userName + ' bergabung');
          console.log('[HEARTBEAT] New user detected:', u.clientId, u.userName);
          // SELALU kirim offer ke peer baru — glare resolution akan handle duplikat
          createOffer(u.clientId);
        } else {
          // Cek apakah koneksi ke peer ini masih hidup
          const peer = peers[u.clientId];
          if (!peer) {
            // Peer ada di room tapi tidak ada WebRTC connection — reconnect
            console.log('[HEARTBEAT] Known user', u.clientId, 'has no peer connection, creating offer');
            createOffer(u.clientId);
          } else {
            const state = peer.pc.connectionState;
            if (state !== 'connected' && state !== 'connecting' && state !== 'new') {
              console.log('[HEARTBEAT] Peer', u.clientId, 'in state', state, '- reconnecting');
              createOffer(u.clientId);
            }
          }
        }
      });

      // Remove peers yang sudah tidak ada di room
      Object.keys(knownUsers).forEach(id => {
        if (id === clientId || sids.has(id)) return;
        showNotif((knownUsers[id] || id) + ' keluar');
        delete knownUsers[id];
        closePeer(id);
        removeTile(id);
      });
    }

    // Process signals
    if (res.signals && res.signals.length > 0) {
      for (const s of res.signals) {
        await handleSignal(s);
      }
    }
    if (res.lastSignalId) lastSignalId = res.lastSignalId;

    if (res.chat && res.chat.length > 0) {
      let nc = 0;
      res.chat.forEach(msg => {
        const k = msg.sentAt + '_' + msg.clientId + '_' + msg.message;
        if (seenChatKeys.has(k)) return;
        seenChatKeys.add(k);
        if (msg.clientId === clientId) return;
        appendChat(msg); nc++;
      });
      if (!chatOpen && nc > 0) { unreadChat += nc; updateBadge(); }
    }
    if (typeof res.lastChatId === 'number') lastChatId = res.lastChatId;
  } finally {
    hbRunning = false;
    scheduleHeartbeat();
  }
}

// ── Toolbar ───────────────────────────────────────────────────
function bindToolbar() {
  // MIC
  document.getElementById('btnMic').addEventListener('click', () => {
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
    const btn = document.getElementById('btnMic');
    btn.classList.toggle('active', micEnabled);
    btn.title = micEnabled ? 'Matikan Mic' : 'Nyalakan Mic';
  });

  // CAMERA
  document.getElementById('btnCamera').addEventListener('click', () => {
    camEnabled = !camEnabled;
    localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
    const btn = document.getElementById('btnCamera');
    btn.classList.toggle('active', camEnabled);
    btn.title = camEnabled ? 'Matikan Kamera' : 'Nyalakan Kamera';
    updateLocalTileStream();
    replaceLocalVideoTrack(getSendableVideoTrack());
  });

  // SCREEN SHARE
  document.getElementById('btnScreenShare').addEventListener('click', async () => {
    if (screenSharing) {
      stopScreenShare();
      return;
    }

    if (!navigator.mediaDevices?.getDisplayMedia) {
      alert('Browser atau device ini tidak mendukung screen share.');
      return;
    }

    let capturedScreenStream;
    try {
      capturedScreenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'monitor',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: true,
      });
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        return;
      }
      console.error('[SCREEN] getDisplayMedia error:', err);
      alert('Gagal memulai screen share: ' + err.message);
      return;
    }

    startScreenShare(capturedScreenStream);
  });

  // RECORD
  document.getElementById('btnRecord').addEventListener('click', toggleRecord);

  // CHAT
  document.getElementById('btnChat').addEventListener('click', () => {
    chatOpen = !chatOpen;
    document.getElementById('chatPanel').classList.toggle('open', chatOpen);
    if (chatOpen) { unreadChat = 0; updateBadge(); document.getElementById('chatInput').focus(); }
  });
  document.getElementById('btnCloseChat').addEventListener('click', () => {
    chatOpen = false;
    document.getElementById('chatPanel').classList.remove('open');
  });

  // RECORDINGS
  document.getElementById('btnRecordings').addEventListener('click', () => window.location.href = 'recordings.html');

  // LEAVE
  document.getElementById('btnLeave').addEventListener('click', leaveRoom);
}

// ── Screen Share ──────────────────────────────────────────────
function stopScreenShare() {
  const btn = document.getElementById('btnScreenShare');

  screenSharing = false;
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }

  replaceLocalVideoTrack(getSendableVideoTrack());
  updateLocalTileStream();
  const st = document.getElementById('tile-screen');
  if (st) st.remove();
  btn.classList.remove('active');
  refreshGrid();
}

function startScreenShare(capturedScreenStream) {
  const btn = document.getElementById('btnScreenShare');
  screenStream = capturedScreenStream;
  screenSharing = true;
  const track = screenStream.getVideoTracks()[0];

  replaceLocalVideoTrack(track);

  const grid = document.getElementById('video-grid');
  const st = makeTile('screen', 'Layar Anda', screenStream, true);
  st.id = 'tile-screen';
  st.classList.add('screen-share-tile');
  grid.insertBefore(st, grid.firstChild);
  btn.classList.add('active');
  refreshGrid();
  track.addEventListener('ended', () => { if (screenSharing) stopScreenShare(); });
}

function stopVBG() {
  // Virtual background disabled; no action required.
}

function updateLocalVideo(stream) {
  const v = document.querySelector('#tile-' + clientId + ' video');
  if (v) v.srcObject = stream;
}

function updatePeerTracks(newVideoTrack) {
  if (!newVideoTrack) return;
  Object.values(peers).forEach(({ pc }) => {
    const s = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (s) s.replaceTrack(newVideoTrack);
  });
}

function connectAudioSource(stream, id) {
  if (!audioCtx || !audioDest || !stream) return;
  const tracks = stream.getAudioTracks();
  const liveTracks = tracks.filter(t => t.readyState === 'live');
  if (!liveTracks.length) {
    console.log('[REC] Audio source skipped, no live audio track for', id);
    return;
  }
  if (audioSources[id]) {
    console.log('[REC] Audio source already connected for', id);
    return;
  }
  try {
    // Pastikan audioCtx active
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    const src = audioCtx.createMediaStreamSource(stream);
    src.connect(audioDest);
    audioSources[id] = src;
    console.log('[REC] Audio source connected for', id, 'tracks:', liveTracks.length);
  } catch (e) { console.warn('[REC] audio mix failed for', id, e); }
}

// ── Canvas Composite Recording ────────────────────────────────
// Merekam semua tile yang tampil di layar menggunakan Canvas API
// Menggunakan setInterval bukan requestAnimationFrame agar tetap jalan di background tab

function buildRecordingCanvas() {
  const W = 1280, H = 720;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  recVideoElements = {};
  console.log('[REC] Recording canvas created', W + 'x' + H);

  // Layout: sama persis seperti CSS grid
  function getLayout(n) {
    if (n === 1) return { cols: 1, rows: 1 };
    if (n === 2) return { cols: 2, rows: 1 };
    if (n <= 4) return { cols: 2, rows: 2 };
    if (n <= 6) return { cols: 3, rows: 2 };
    return { cols: 3, rows: 3 };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function hasLiveTrack(stream, kind) {
    if (!stream) return false;
    return stream.getTracks().some(t => t.kind === kind && t.readyState === 'live');
  }

  function getRecordingVideo(id, stream) {
    if (!stream) return null;
    let vid = recVideoElements[id];
    if (!vid) {
      vid = document.createElement('video');
      vid.autoplay = true;
      vid.playsInline = true;
      vid.muted = true;
      vid.style.position = 'fixed';
      vid.style.left = '-99999px';
      vid.style.top = '-99999px';
      vid.style.width = '1px';
      vid.style.height = '1px';
      vid.setAttribute('data-rec-peer', id);
      document.body.appendChild(vid);
      recVideoElements[id] = vid;
      console.log('[REC] Created recording video element for', id);
    }
    if (vid.srcObject !== stream) {
      vid.srcObject = stream;
      console.log('[REC] Recording video srcObject updated for', id);
    }
    if (vid.paused || vid.readyState < 2) {
      vid.play().catch(e => console.warn('[REC] recording video play failed for', id, e));
    }
    return vid;
  }

  function getLiveRecordingSources() {
    const sources = [];

    if (screenSharing && screenStream && hasLiveTrack(screenStream, 'video')) {
      sources.push({
        id: 'local-screen',
        label: 'Layar Anda',
        stream: screenStream,
        isScreen: true,
      });
    }

    sources.push({
      id: 'local',
      label: (userName || 'Anda') + ' (Anda)',
      stream: getLocalDisplayStream(),
      isScreen: false,
    });

    Object.entries(peers).forEach(([id, peer]) => {
      if (!peer || !peer.stream) return;
      const hasVideo = hasLiveTrack(peer.stream, 'video');
      const hasAudio = hasLiveTrack(peer.stream, 'audio');
      if (!hasVideo && !hasAudio) return;
      sources.push({
        id,
        label: knownUsers[id] || 'User',
        stream: peer.stream,
        isScreen: false,
      });
    });

    return sources;
  }

  function drawFrame() {
    if (!recordingActive) return;

    const allSources = getLiveRecordingSources();
    if (allSources.length === 0) return;

    // Background Canvas
    ctx.fillStyle = '#111315';
    ctx.fillRect(0, 0, W, H);

    const pad = 24;
    const gap = 16;
    const chatH = 120;

    const gridW = W - (pad * 2);
    const gridH = H - chatH - pad; // Jarak atas pad, jarak bawah sebelum chat 0 (karena chatH sudah memiliki ruang)
    const gridX = pad;
    const gridY = pad;

    const isScreenshareMode = allSources.some(s => s.isScreen);

    if (isScreenshareMode) {
      // Screenshare layout (Kiri besar, kanan list kecil)
      const screenSource = allSources.find(s => s.isScreen);
      const participantSources = allSources.filter(s => !s.isScreen);

      const screenW = gridW * 0.75 - (gap / 2);
      const pW = gridW * 0.25 - (gap / 2);

      if (screenSource) {
        drawSingleSource(screenSource, gridX, gridY, screenW, gridH);
      }

      const pCount = participantSources.length;
      const pH = pCount > 0 ? (gridH - (gap * (pCount - 1))) / pCount : gridH;

      participantSources.forEach((source, i) => {
        drawSingleSource(source, gridX + screenW + gap, gridY + i * (pH + gap), pW, pH);
      });

    } else {
      // Grid layout normal
      const n = allSources.length;
      const { cols, rows } = getLayout(n);

      const tw = (gridW - (gap * (cols - 1))) / cols;
      const th = (gridH - (gap * (rows - 1))) / rows;

      allSources.forEach((source, i) => {
        const col = i % cols, row = Math.floor(i / cols);
        const x = gridX + col * (tw + gap);
        const y = gridY + row * (th + gap);
        drawSingleSource(source, x, y, tw, th);
      });
    }

    // Overlay chat di area khusus bawah
    drawChatOverlay(ctx, W, H, chatH);
  }

  function drawSingleSource(source, x, y, tw, th) {
    const vid = getRecordingVideo(source.id, source.stream);
    const videoTracks = source.stream ? source.stream.getVideoTracks() : [];
    const camOff = !videoTracks.some(t => t.readyState === 'live' && t.enabled !== false);
    ctx.save();

    // Rounded corners & Background Tile
    roundRect(ctx, x, y, tw, th, 18);
    ctx.fillStyle = '#3c4043';
    ctx.fill();
    ctx.clip();

    const videoReady = vid && vid.readyState >= 2 && vid.videoWidth > 16 && vid.videoHeight > 16;

    if (!camOff && videoReady) {
      const vr = vid.videoWidth / vid.videoHeight || 16 / 9;
      const cr = tw / th;
      let dw, dh, dx, dy;
      if (vr > cr) { dw = tw; dh = tw / vr; dx = x; dy = y + (th - dh) / 2; }
      else { dh = th; dw = th * vr; dy = y; dx = x + (tw - dw) / 2; }
      try {
        ctx.drawImage(vid, dx, dy, dw, dh);
      } catch (e) {
        drawAvatarFallback(ctx, x, y, tw, th, source.label);
      }
    } else {
      drawAvatarFallback(ctx, x, y, tw, th, source.label);
    }

    // Label nama di pojok kiri bawah (tanpa background, pakai text shadow)
    if (source.label) {
      const labelText = source.label;
      ctx.font = '600 14px sans-serif';

      ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
      ctx.shadowBlur = 4;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 1;

      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(labelText, x + 16, y + th - 12);

      ctx.shadowColor = 'transparent'; // reset
    }

    ctx.restore();
  }

  const FPS = 25;
  const FRAME_INTERVAL = 1000 / FPS;
  let lastFrameTime = 0;

  function drawLoop(timestamp) {
    if (!recordingActive) return;
    if (timestamp - lastFrameTime >= FRAME_INTERVAL) {
      lastFrameTime = timestamp;
      drawFrame();
    }
    recDrawTimer = requestAnimationFrame(drawLoop);
  }

  function start() {
    if (recDrawTimer) cancelAnimationFrame(recDrawTimer);
    lastFrameTime = document.timeline ? document.timeline.currentTime : performance.now();
    recDrawTimer = requestAnimationFrame(drawLoop);
  }

  return { canvas: c, start };
}

function drawAvatarFallback(ctx, x, y, tw, th, lbl) {
  // Lingkaran avatar
  const r = Math.min(tw, th) * 0.2;
  const cx = x + tw / 2, cy = y + th / 2 - r * 0.3;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  const grad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
  grad.addColorStop(0, '#667eea'); grad.addColorStop(1, '#764ba2');
  ctx.fillStyle = grad; ctx.fill();

  // Inisial
  const labelText = typeof lbl === 'string' ? lbl : (lbl ? lbl.textContent : '');
  const initial = (labelText ? labelText[0] : '?').toUpperCase();
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${r}px sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(initial, cx, cy);

  // Nama
  const name = labelText ? labelText.replace(' (Anda)', '') : '';
  ctx.font = `bold ${r * 0.4}px sans-serif`;
  ctx.fillText(name, cx, cy + r * 1.5);
}

function drawChatOverlay(ctx, W, H, chatH) {
  const pad = 24;
  const chatY = H - chatH;

  // Background panel chat
  ctx.fillStyle = '#202124';
  ctx.fillRect(0, chatY, W, chatH);

  // Border atas panel chat
  ctx.strokeStyle = '#3c4043';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, chatY);
  ctx.lineTo(W, chatY);
  ctx.stroke();

  const msgs = Array.from(document.querySelectorAll('#chatMessages .chat-message')).slice(-3);
  if (!msgs.length) {
    ctx.fillStyle = '#9aa0a6';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Ruang Obrolan (Belum ada pesan)', W / 2, chatY + chatH / 2);
    return;
  }

  let msgY = chatY + 24;
  msgs.forEach((m) => {
    const meta = m.querySelector('.chat-meta');
    const bbl = m.querySelector('.chat-bubble');
    if (!meta || !bbl) return;

    const own = m.classList.contains('own');

    // Nama pengirim
    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = own ? '#8ab4f8' : '#9aa0a6';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    const author = meta.textContent.split('·')[0].trim();
    ctx.fillText(author + ':', pad, msgY);

    const authorWidth = ctx.measureText(author + ':').width;

    // Isi Pesan
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#e8eaed';
    let text = bbl.textContent;
    if (text.length > 150) text = text.slice(0, 147) + '...';

    ctx.fillText(text, pad + authorWidth + 8, msgY - 1);

    msgY += 28;
  });
}

// ── Audio Mix ─────────────────────────────────────────────────
function buildAudioMix() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  audioDest = audioCtx.createMediaStreamDestination();
  audioSources = {}; // reset
  console.log('[REC] Audio mix context created');

  // Lokal
  if (localStream) connectAudioSource(localStream, 'local');

  // Remote peers — connect SEMUA yang sudah ada
  Object.entries(peers).forEach(([id, peer]) => {
    if (peer.stream) {
      connectAudioSource(peer.stream, id);
    }
  });

  console.log('[REC] Initial audio sources:', Object.keys(audioSources).join(', ') || '(none)');

  return audioDest.stream;
}

function waitForRecordingPeersReady(timeoutMs = 2000) {
  const startedAt = Date.now();

  function peerHasLiveTrack(peer) {
    if (!peer || !peer.stream) return false;
    return peer.stream.getTracks().some(t => t.readyState === 'live');
  }

  return new Promise(resolve => {
    function check() {
      const entries = Object.entries(peers);
      const ready = entries.every(([, peer]) => peerHasLiveTrack(peer));
      const elapsed = Date.now() - startedAt;
      if (ready || elapsed >= timeoutMs) {
        console.log('[REC] Peer readiness wait finished', {
          ready,
          elapsed,
          peers: entries.map(([id, peer]) => ({
            id,
            connected: !!(peer && peer.connected),
            tracks: peer && peer.stream ? peer.stream.getTracks().map(t => t.kind + ':' + t.readyState) : [],
          })),
        });
        resolve();
        return;
      }
      setTimeout(check, 100);
    }
    check();
  });
}

function cleanupRecordingResources() {
  if (recDrawTimer) { cancelAnimationFrame(recDrawTimer); recDrawTimer = null; }

  Object.values(recVideoElements).forEach(vid => {
    try {
      vid.pause();
      vid.srcObject = null;
      vid.remove();
    } catch (_) { }
  });
  recVideoElements = {};

  if (audioCtx) {
    try { audioCtx.close(); } catch (_) { }
  }
  audioCtx = null;
  audioDest = null;
  audioSources = {};
  recCanvas = null;
  recCtx = null;

  console.log('[REC] Recording resources cleaned up');
}

// ── Recording ─────────────────────────────────────────────────
async function toggleRecord() {
  console.log('[REC] Toggle requested. isHost=' + isHost + ', recordingActive=' + recordingActive);
  if (!isHost) {
    showNotif('Hanya host yang bisa merekam');
    console.log('[REC] Toggle rejected because current user is not host');
    return;
  }
  recordingActive ? await stopRec() : await startRec();
}

function getSupportedMimeType() {
  const types = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus', 
    'video/webm;codecs=h264,opus',
    'video/webm',
    'video/mp4;codecs=h264,aac',
    'video/mp4'
  ];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) {
      console.log('[REC] Using MIME type:', type);
      return type;
    }
  }
  console.warn('[REC] No preferred MIME type supported, using default');
  return '';
}

async function startRec() {
  console.log('[REC] Start requested');
  const r = await api('recording-start', { roomId, clientId });
  if (r && r.error) { console.log('[REC] recording-start rejected:', r.error); showNotif(r.error); return; }

  recordingFileName = generateRecordingFilename();
  console.log('[REC] Recording filename generated:', recordingFileName);

  await waitForRecordingPeersReady(2000);

  // Buat canvas gabungan + audio mix
  const { canvas, start } = buildRecordingCanvas();
  recCanvas = canvas; recCtx = recCanvas.getContext('2d');

  const audioMixStream = buildAudioMix();
  const canvasStream = canvas.captureStream(25); // 25 fps
  console.log('[REC] Canvas stream captured at 25fps');

  // Gabungkan video canvas + audio mix
  const allTracks = [
    ...canvasStream.getVideoTracks(),
    ...audioMixStream.getAudioTracks(),
  ];
  const compositeStream = new MediaStream(allTracks);
  console.log('[REC] Composite stream prepared', {
    videoTracks: compositeStream.getVideoTracks().length,
    audioTracks: compositeStream.getAudioTracks().length,
  });

  const mime = getSupportedMimeType();

  try {
    mediaRecorder = new MediaRecorder(compositeStream, {
      mimeType: mime,
      videoBitsPerSecond: 2500000,
      audioBitsPerSecond: 128000,
    });
  } catch (e) { console.log('[REC] MediaRecorder creation failed:', e); showNotif('MediaRecorder error: ' + e.message); return; }

  recordedChunks = [];
  recordingActive = true;

  mediaRecorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) {
      recordedChunks.push(e.data);
      console.log('[REC] Chunk collected, size:', e.data.size);
    }
  };

  mediaRecorder.onstop = async () => {
    console.log('[REC] MediaRecorder stopped');
    cleanupRecordingResources();

    if (recordedChunks.length > 0) {
      showNotif('Menyimpan rekaman... (harap tunggu)');
      console.log('[REC] Building final blob from', recordedChunks.length, 'chunks');
      const finalMime = mediaRecorder.mimeType || 'video/webm';
      const finalBlob = new Blob(recordedChunks, { type: finalMime });
      console.log('[REC] Final blob size:', finalBlob.size, 'bytes');
      await uploadFinalRecording(finalBlob);
      recordedChunks.length = 0; // clear memory
    }
    
    await api('recording-stop', { roomId, clientId });
    recordingFileName = null;
    console.log('[REC] Recording state stopped');
  };

  mediaRecorder.start();
  start(); // mulai loop canvas via requestAnimationFrame
  console.log('[REC] MediaRecorder started');

  setRecUI('recording');
  showNotif('Rekaman dimulai - merekam semua peserta');
  console.log('[REC] Started recording with', Object.keys(peers).length, 'peers');
}

async function stopRec() {
  console.log('[REC] Stop requested');
  recordingActive = false;
  
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  } else {
    cleanupRecordingResources();
    setRecUI('idle');
  }
}

function generateRecordingFilename() {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `rec_${roomId}_${ts}.webm`;
}

async function uploadFinalRecording(blob) {
  const MAX_RETRY = 3;
  const RETRY_DELAY = 2000;
  const filename = recordingFileName || generateRecordingFilename();

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      console.log('[UPLOAD] Attempt', attempt, 'of', MAX_RETRY, '— size:', (blob.size/1024/1024).toFixed(2), 'MB');
      setRecUI('uploading', `Menyimpan rekaman... (percobaan ${attempt})`);

      // Kirim sebagai binary octet-stream (bukan FormData)
      // agar tidak terkena batas upload_max_filesize PHP
      const response = await fetch(
        `api/recording.php?action=save&room=${encodeURIComponent(roomId)}&filename=${encodeURIComponent(filename)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: blob,
        }
      );

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();

      if (result.success) {
        console.log('[UPLOAD] Success on attempt', attempt, ':', result.filename);
        setRecUI('done', 'Rekaman berhasil disimpan');
        return;
      } else {
        throw new Error(result.error || 'Server error');
      }

    } catch (err) {
      console.warn('[UPLOAD] Attempt', attempt, 'failed:', err.message);

      if (attempt < MAX_RETRY) {
        setRecUI('uploading', `Gagal, mencoba ulang dalam ${RETRY_DELAY/1000} detik...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      } else {
        console.error('[UPLOAD] All attempts failed');
        setRecUI('error', 'Rekaman gagal disimpan. Hubungi administrator.');
      }
    }
  }
}

function setRecUI(state, message) {
  const btn = document.getElementById('btnRecord');
  const statusEl = document.getElementById('rec-status');
  const oldInd = document.getElementById('recordingIndicator');

  const REC_CLASSES = ['recording-active', 'recording-uploading', 'recording-done', 'recording-error'];

  const states = {
    idle: {
      btnText: 'Record',
      btnClass: null,
      statusText: '',
      statusVisible: false,
      btnDisabled: false,
    },
    recording: {
      btnText: '⏹ Stop Recording',
      btnClass: 'recording-active',
      statusText: '🔴 Sedang merekam...',
      statusVisible: true,
      btnDisabled: false,
    },
    uploading: {
      btnText: '⏳ Menyimpan...',
      btnClass: 'recording-uploading',
      statusText: message || '⏳ Menyimpan rekaman ke server...',
      statusVisible: true,
      btnDisabled: true,
    },
    done: {
      btnText: 'Record',
      btnClass: 'recording-done',
      statusText: '✅ Rekaman berhasil disimpan',
      statusVisible: true,
      btnDisabled: false,
    },
    error: {
      btnText: 'Record',
      btnClass: 'recording-error',
      statusText: message || '❌ Gagal menyimpan rekaman',
      statusVisible: true,
      btnDisabled: false,
    },
  };

  const s = states[state] || states.idle;

  if (btn) {
    // Hapus hanya class recording-* tanpa menyentuh class lain (mis. toolbar-btn)
    REC_CLASSES.forEach(c => btn.classList.remove(c));
    if (s.btnClass) btn.classList.add(s.btnClass);
    btn.textContent = s.btnText;
    btn.disabled = s.btnDisabled;
  }

  if (statusEl) {
    statusEl.textContent = s.statusText;
    statusEl.style.display = s.statusVisible ? 'block' : 'none';
  }

  // Indikator REC pojok atas
  if (oldInd) {
    if (state === 'recording') {
      oldInd.style.display = 'flex';
      oldInd.innerHTML = '<span class="rec-dot"></span> REC';
    } else if (state === 'uploading') {
      oldInd.style.display = 'flex';
      oldInd.innerHTML = '<span class="rec-dot" style="background:#f1c40f"></span> Uploading...';
    } else {
      oldInd.style.display = 'none';
    }
  }

  // Auto-reset setelah done/error
  if (state === 'done' || state === 'error') {
    setTimeout(() => setRecUI('idle'), 5000);
  }
}

// ── Chat ──────────────────────────────────────────────────────
function bindChat() {
  document.getElementById('chatForm').addEventListener('submit', async e => {
    e.preventDefault();
    const inp = document.getElementById('chatInput');
    const msg = inp.value.trim();
    if (!msg) return;
    inp.value = '';
    const sentAt = Date.now();
    seenChatKeys.add(sentAt + '_' + clientId + '_' + msg);
    appendChat({ clientId, userName, message: msg, sentAt });
    await api('chat', { roomId, clientId, userName, message: msg });
  });
}

function appendChat(msg) {
  const box = document.getElementById('chatMessages');
  const own = msg.clientId === clientId;
  const div = document.createElement('div');
  div.className = 'chat-message' + (own ? ' own' : '');
  const t = new Date(msg.sentAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  div.innerHTML = `<div class="chat-meta">${own ? 'Anda' : esc(msg.userName)} · ${t}</div>
                   <div class="chat-bubble">${esc(msg.message)}</div>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function updateBadge() {
  const b = document.getElementById('chatBadge');
  b.style.display = unreadChat > 0 ? 'flex' : 'none';
  b.textContent = unreadChat > 9 ? '9+' : unreadChat;
}

// ── Leave ─────────────────────────────────────────────────────
async function leaveRoom() {
  clearTimeout(heartbeatTimer);
  heartbeatTimer = null;
  if (recordingActive) await stopRec();
  Object.keys(peers).forEach(id => { closePeer(id); removeTile(id); });
  stopVBG();
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (screenStream) screenStream.getTracks().forEach(t => t.stop());
  await api('leave', { roomId, clientId }).catch(() => { });
  localStorage.removeItem('isHost');
  window.location.href = 'lobby.html';
}

// ── Signal / API ──────────────────────────────────────────────
async function sendSig(to, type, data) {
  await api('signal', { roomId, from: clientId, to, type, data });
}

async function api(action, data) {
  try {
    const res = await fetch(API_SYNC + '?action=' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } catch (e) { console.error('[api]', action, e.message); return null; }
}

// ── Utils ──────────────────────────────────────────────────────
function showNotif(msg) {
  const el = document.createElement('div');
  el.className = 'notification'; el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

window.addEventListener('DOMContentLoaded', init);
