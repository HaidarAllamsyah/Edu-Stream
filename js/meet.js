// ============================================================
// EDUSTREAM - WEBRTC VIDEO CONFERENCE (FIXED v4)
// - TURN server untuk konek via ngrok/NAT
// - Polling lebih agresif (800ms)
// - Offer hanya dari 1 sisi (user dengan clientId lebih kecil)
// ============================================================
'use strict';

const BASE_PATH = window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/') + 1);
const API_SYNC = BASE_PATH + 'api/sync.php';
const API_RECORDING = BASE_PATH + 'api/recording.php';

// ── State ────────────────────────────────────────────────────
let roomId, userName, clientId;
let localStream = null;
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

// Recording
let mediaRecorder = null;
let recordingActive = false;
let recordingFileName = null;
let recordedChunks = [];
let chunkFlushTimer = null;

// ICE Config dengan TURN server gratis (OpenRelay)
const ICE_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
  iceTransportPolicy: 'all',
  iceCandidatePoolSize: 10,
};

// ── Init ─────────────────────────────────────────────────────
async function init() {
  const p = new URLSearchParams(window.location.search);
  roomId = p.get('room');
  userName = localStorage.getItem('userName') || 'User';
  // clientId unik per tab, berbasis waktu
  clientId = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);

  if (!roomId) { window.location.href = 'lobby.html'; return; }

  document.getElementById('roomDisplay').textContent = roomId;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e2) { alert('Gagal akses kamera/mic: ' + e2.message); return; }
  }

  renderLocalTile();
  bindToolbar();
  bindChat();

  const jr = await api('join', { roomId, clientId, userName });
  if (!jr || !jr.success) { alert('Gagal join room, coba refresh'); return; }

  isHost = jr.isHost;
  setRecUI(jr.recording);

  // Kirim offer ke user yang sudah ada
  if (jr.users && jr.users.length > 0) {
    jr.users.forEach(u => {
      knownUsers[u.clientId] = u.userName;
      // Hanya 1 sisi yang offer: yang clientId-nya lebih kecil secara string
      if (clientId < u.clientId) {
        createOffer(u.clientId);
      }
    });
  }

  // Polling setiap 800ms agar sinyal cepat sampai
  heartbeatTimer = setInterval(heartbeat, 800);
  window.addEventListener('beforeunload', leaveRoom);
}

// ── Tiles ────────────────────────────────────────────────────
function renderLocalTile() {
  const grid = document.getElementById('video-grid');
  grid.innerHTML = '';
  grid.appendChild(makeTile(clientId, userName + ' (Anda)', localStream, true));
  refreshGrid();
}

function makeTile(id, label, stream, isLocal) {
  const old = document.getElementById('tile-' + id);
  if (old) old.remove();

  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = 'tile-' + id;

  const vid = document.createElement('video');
  vid.autoplay = true; vid.playsInline = true; vid.muted = isLocal;
  if (stream) vid.srcObject = stream;

  const lbl = document.createElement('div');
  lbl.className = 'video-label'; lbl.textContent = label;

  const av = document.createElement('div');
  av.className = 'avatar-placeholder'; av.id = 'avatar-' + id;
  av.textContent = (label || 'U')[0].toUpperCase();

  tile.append(vid, lbl, av);
  return tile;
}

function removeTile(id) {
  const t = document.getElementById('tile-' + id);
  if (t) t.remove();
  refreshGrid();
}

function refreshGrid() {
  const grid = document.getElementById('video-grid');
  const count = grid.querySelectorAll('.video-tile').length;
  grid.className = 'count-' + Math.max(1, Math.min(count, 9));
  if (screenSharing) grid.classList.add('screenshare-mode');
  document.getElementById('countDisplay').textContent = count;
}

// ── WebRTC ───────────────────────────────────────────────────
async function createOffer(peerId) {
  if (peers[peerId]) {
    const st = peers[peerId].pc.connectionState;
    if (st === 'connected' || st === 'connecting') return;
    closePeer(peerId);
  }
  const pc = buildPC(peerId);
  try {
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    await sendSig(peerId, 'offer', pc.localDescription);
  } catch (e) { console.error('[offer]', e); }
}

function buildPC(peerId) {
  closePeer(peerId);

  const remoteStream = new MediaStream();
  const pc = new RTCPeerConnection(ICE_CONFIG);
  peers[peerId] = { pc, stream: remoteStream };

  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.onicecandidate = e => {
    if (e.candidate) sendSig(peerId, 'ice-candidate', e.candidate.toJSON());
  };

  pc.oniceconnectionstatechange = () => {
    console.log('[ICE ' + peerId.slice(0, 6) + ']', pc.iceConnectionState);
  };

  pc.ontrack = e => {
    e.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
    const name = knownUsers[peerId] || 'User';
    let tile = document.getElementById('tile-' + peerId);
    if (!tile) {
      tile = makeTile(peerId, name, remoteStream, false);
      document.getElementById('video-grid').appendChild(tile);
      refreshGrid();
    } else {
      const v = tile.querySelector('video');
      if (v && v.srcObject !== remoteStream) v.srcObject = remoteStream;
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    console.log('[PC ' + peerId.slice(0, 6) + ']', s);
    if (s === 'failed') {
      showNotif('⚠️ Reconnecting...');
      setTimeout(() => {
        if (knownUsers[peerId]) createOffer(peerId);
      }, 2000);
    }
  };

  return pc;
}

async function handleSignal(sig) {
  const { from, type, data } = sig;
  if (!knownUsers[from]) knownUsers[from] = 'User';

  if (type === 'offer') {
    const pc = buildPC(from);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data));
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      await sendSig(from, 'answer', pc.localDescription);
    } catch (e) { console.error('[answer]', e); }

  } else if (type === 'answer') {
    const p = peers[from];
    if (!p) return;
    try {
      if (p.pc.signalingState === 'have-local-offer') {
        await p.pc.setRemoteDescription(new RTCSessionDescription(data));
      }
    } catch (e) { console.error('[setRemote answer]', e); }

  } else if (type === 'ice-candidate') {
    const p = peers[from];
    if (!p) return;
    try {
      if (p.pc.remoteDescription) {
        await p.pc.addIceCandidate(new RTCIceCandidate(data));
      }
    } catch (_) { }
  }
}

function closePeer(id) {
  if (peers[id]) { try { peers[id].pc.close(); } catch (_) { } delete peers[id]; }
}

// ── Heartbeat ────────────────────────────────────────────────
let hbRunning = false;
async function heartbeat() {
  if (hbRunning) return; // hindari overlap
  hbRunning = true;
  try {
    const res = await api('heartbeat', { roomId, clientId, lastSignalId, lastChatId });
    if (!res) return;

    if (res.error === 'not_in_room') {
      await api('join', { roomId, clientId, userName });
      return;
    }

    isHost = res.isHost;
    setRecUI(res.recording);

    if (res.users) {
      const sids = new Set(res.users.map(u => u.clientId));

      res.users.forEach(u => {
        if (u.clientId === clientId) return;
        const isNew = !knownUsers[u.clientId];
        knownUsers[u.clientId] = u.userName;
        if (isNew) {
          showNotif('👋 ' + u.userName + ' bergabung');
          // Offer hanya dari yang clientId-nya lebih kecil
          if (clientId < u.clientId) createOffer(u.clientId);
        }
      });

      Object.keys(knownUsers).forEach(id => {
        if (id === clientId) return;
        if (!sids.has(id)) {
          showNotif('👋 ' + (knownUsers[id] || id) + ' keluar');
          delete knownUsers[id];
          closePeer(id);
          removeTile(id);
        }
      });
    }

    if (res.signals && res.signals.length > 0) {
      for (const s of res.signals) await handleSignal(s);
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

  } finally { hbRunning = false; }
}

// ── Toolbar ──────────────────────────────────────────────────
function bindToolbar() {
  document.getElementById('btnMic').addEventListener('click', () => {
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
    const btn = document.getElementById('btnMic');
    btn.classList.toggle('active', micEnabled);
    btn.querySelector('span').textContent = micEnabled ? '🎤' : '🔇';
  });

  document.getElementById('btnCamera').addEventListener('click', () => {
    camEnabled = !camEnabled;
    localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
    const btn = document.getElementById('btnCamera');
    btn.classList.toggle('active', camEnabled);
    btn.querySelector('span').textContent = camEnabled ? '📹' : '📷';
    const av = document.getElementById('avatar-' + clientId);
    if (av) av.style.display = camEnabled ? 'none' : 'flex';
  });

  document.getElementById('btnScreenShare').addEventListener('click', toggleScreen);
  document.getElementById('btnRecord').addEventListener('click', toggleRecord);

  document.getElementById('btnChat').addEventListener('click', () => {
    chatOpen = !chatOpen;
    document.getElementById('chatPanel').classList.toggle('open', chatOpen);
    if (chatOpen) { unreadChat = 0; updateBadge(); document.getElementById('chatInput').focus(); }
  });
  document.getElementById('btnCloseChat').addEventListener('click', () => {
    chatOpen = false;
    document.getElementById('chatPanel').classList.remove('open');
  });

  document.getElementById('btnRecordings').addEventListener('click', () => window.open('recordings.html', '_blank'));
  document.getElementById('btnLeave').addEventListener('click', leaveRoom);
}

// ── Screen Share ─────────────────────────────────────────────
async function toggleScreen() {
  const btn = document.getElementById('btnScreenShare');
  if (screenSharing) {
    screenSharing = false;
    if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
    const camTrack = localStream.getVideoTracks()[0];
    if (camTrack) Object.values(peers).forEach(({ pc }) => {
      const s = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (s) s.replaceTrack(camTrack);
    });
    const lv = document.querySelector('#tile-' + clientId + ' video');
    if (lv) lv.srcObject = localStream;
    const st = document.getElementById('tile-screen');
    if (st) st.remove();
    btn.classList.remove('active');
    refreshGrid();
  } else {
    try { screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true }); }
    catch (e) { showNotif('❌ Gagal berbagi layar'); return; }
    screenSharing = true;
    const track = screenStream.getVideoTracks()[0];
    Object.values(peers).forEach(({ pc }) => {
      const s = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (s) s.replaceTrack(track);
    });
    const grid = document.getElementById('video-grid');
    const st = makeTile('screen', '🖥️ Layar Anda', screenStream, true);
    st.id = 'tile-screen';
    st.classList.add('screen-share-tile');
    grid.insertBefore(st, grid.firstChild);
    btn.classList.add('active');
    refreshGrid();
    track.addEventListener('ended', () => { if (screenSharing) toggleScreen(); });
  }
}

// ── Chat ─────────────────────────────────────────────────────
function bindChat() {
  document.getElementById('chatForm').addEventListener('submit', async e => {
    e.preventDefault();
    const inp = document.getElementById('chatInput');
    const msg = inp.value.trim();
    if (!msg) return;
    inp.value = '';
    const sentAt = Date.now();
    const k = sentAt + '_' + clientId + '_' + msg;
    seenChatKeys.add(k);
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

// ── Recording ────────────────────────────────────────────────
async function toggleRecord() {
  if (!isHost) { showNotif('❌ Hanya host yang bisa merekam'); return; }
  recordingActive ? await stopRec() : await startRec();
}

async function startRec() {
  const r = await api('recording-start', { roomId, clientId });
  if (r && r.error) { showNotif('❌ ' + r.error); return; }

  const sr = await fetch(API_RECORDING + '?action=start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1' },
    body: JSON.stringify({ roomId }),
  }).then(r => r.json()).catch(() => null);

  if (!sr || !sr.fileName) { showNotif('❌ Gagal init file rekaman'); return; }
  recordingFileName = sr.fileName;

  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';

  try { mediaRecorder = new MediaRecorder(localStream, { mimeType: mime, videoBitsPerSecond: 2_500_000 }); }
  catch (e) { showNotif('❌ ' + e.message); return; }

  recordedChunks = []; recordingActive = true;
  mediaRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = async () => {
    if (recordedChunks.length > 0) { await uploadChunk(new Blob(recordedChunks, { type: mime })); recordedChunks = []; }
    await fetch(API_RECORDING + '?action=stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1' },
      body: JSON.stringify({ fileName: recordingFileName }),
    }).catch(() => { });
    recordingFileName = null; showNotif('✅ Rekaman disimpan');
  };
  mediaRecorder.start(2000);
  chunkFlushTimer = setInterval(async () => {
    if (recordedChunks.length) { const c = recordedChunks.splice(0); await uploadChunk(new Blob(c, { type: mime })); }
  }, 5000);
  setRecUI(true); showNotif('🔴 Rekaman dimulai');
}

async function stopRec() {
  recordingActive = false;
  if (chunkFlushTimer) { clearInterval(chunkFlushTimer); chunkFlushTimer = null; }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  await api('recording-stop', { roomId, clientId });
  setRecUI(false);
}

async function uploadChunk(blob) {
  if (!recordingFileName || !blob.size) return;
  await fetch(API_RECORDING + '?action=chunk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': recordingFileName, 'ngrok-skip-browser-warning': '1' },
    body: blob,
  }).catch(e => console.error('[chunk]', e));
}

function setRecUI(on) {
  document.getElementById('recordingIndicator').style.display = on ? 'flex' : 'none';
  document.getElementById('btnRecord').classList.toggle('recording', !!on);
}

// ── Leave ────────────────────────────────────────────────────
async function leaveRoom() {
  clearInterval(heartbeatTimer);
  if (recordingActive) await stopRec();
  Object.keys(peers).forEach(id => { closePeer(id); removeTile(id); });
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (screenStream) screenStream.getTracks().forEach(t => t.stop());
  await api('leave', { roomId, clientId }).catch(() => { });
  window.location.href = 'lobby.html';
}

// ── Signal ───────────────────────────────────────────────────
async function sendSig(to, type, data) {
  await api('signal', { roomId, from: clientId, to, type, data });
}

// ── API ──────────────────────────────────────────────────────
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

// ── Utils ────────────────────────────────────────────────────
function showNotif(msg) {
  const el = document.createElement('div');
  el.className = 'notification'; el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

window.addEventListener('DOMContentLoaded', init);