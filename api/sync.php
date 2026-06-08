<?php
/**
 * EduStream - Signaling Sync API (FIXED)
 *
 * Perubahan dari versi sebelumnya:
 * - Signal cleanup lebih agresif (15 detik bukan 10) agar tidak ada race condition
 * - lastSignalId menggunakan timestamp float bukan uniqid string comparison
 * - Heartbeat timeout dinaikkan ke 12 detik agar tidak terlalu cepat kick user
 * - Signal deduplication: tidak kirim ulang signal yang sudah dikirim
 * - Tambahkan header no-cache agar polling tidak di-cache browser/proxy
 */

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Cache-Control: no-store, no-cache, must-revalidate');
header('Pragma: no-cache');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// ─── Configuration ──────────────────────────────────────────
$DATA_DIR          = __DIR__ . '/../data/rooms';
$HEARTBEAT_TIMEOUT = 12;  // detik
$SIGNAL_MAX_AGE    = 30;  // detik — sinyal lebih lama dari ini dihapus
$SIGNAL_LIMIT      = 300; // maksimal sinyal tersimpan

if (!is_dir($DATA_DIR)) {
    mkdir($DATA_DIR, 0777, true);
}

// ─── Helpers ────────────────────────────────────────────────

function getRoomFile($roomId) {
    global $DATA_DIR;
    // Sanitasi ketat: hanya huruf, angka, dash, underscore
    $safe = preg_replace('/[^a-zA-Z0-9_-]/', '', $roomId);
    if (empty($safe)) return null;
    return $DATA_DIR . '/' . $safe . '.json';
}

function loadRoom($roomId) {
    $file = getRoomFile($roomId);
    if (!$file || !file_exists($file)) {
        return defaultRoom();
    }
    $raw  = file_get_contents($file);
    $data = json_decode($raw, true);
    return is_array($data) ? $data : defaultRoom();
}

function defaultRoom() {
    return [
        'users'         => [],
        'signals'       => [],
        'chat'          => [],
        'hostClientId'  => null,
        'recording'     => false,
        'recordingHost' => null,
    ];
}

function saveRoom($roomId, $data) {
    $file = getRoomFile($roomId);
    if (!$file) return;
    file_put_contents($file, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
}

function cleanupStaleUsers(&$room) {
    global $HEARTBEAT_TIMEOUT;
    $now     = time();
    $removed = [];
    $kept    = [];

    foreach ($room['users'] as $user) {
        $lastSeen = isset($user['lastHeartbeat']) ? (int)$user['lastHeartbeat'] : 0;
        if (($now - $lastSeen) > $HEARTBEAT_TIMEOUT) {
            $removed[] = $user;
        } else {
            $kept[] = $user;
        }
    }

    $room['users'] = $kept;

    if (!empty($removed)) {
        // Cek apakah host masih ada
        $hostExists = false;
        foreach ($room['users'] as $u) {
            if ($u['clientId'] === $room['hostClientId']) {
                $hostExists = true;
                break;
            }
        }
        if (!$hostExists && !empty($room['users'])) {
            $room['hostClientId'] = $room['users'][0]['clientId'];
        }
        if (empty($room['users'])) {
            $room['hostClientId'] = null;
        }

        // Hentikan recording jika recording host pergi
        if ($room['recording']) {
            $recHostExists = false;
            foreach ($room['users'] as $u) {
                if ($u['clientId'] === $room['recordingHost']) {
                    $recHostExists = true;
                    break;
                }
            }
            if (!$recHostExists) {
                $room['recording']     = false;
                $room['recordingHost'] = null;
            }
        }
    }

    return $removed;
}

// Buat ID sinyal berbasis microtime float — mudah dibandingkan secara numerik
function makeSignalId() {
    return number_format(microtime(true), 6, '.', '');
}

// ─── Actions ────────────────────────────────────────────────

$action = isset($_GET['action']) ? $_GET['action'] : '';

$input = [];
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $raw   = file_get_contents('php://input');
    $input = json_decode($raw, true);
    if (!is_array($input)) $input = [];
}

switch ($action) {

    // ── JOIN ─────────────────────────────────────────────────
    case 'join':
        $roomId   = isset($input['roomId'])   ? trim($input['roomId'])   : '';
        $clientId = isset($input['clientId']) ? trim($input['clientId']) : '';
        $userName = '';
        if (isset($input['userName']))  $userName = trim(substr($input['userName'],  0, 50));
        if (!$userName && isset($input['username'])) $userName = trim(substr($input['username'], 0, 50));
        if (!$userName) $userName = 'User';
        $wantToBeHost = isset($input['wantToBeHost']) ? (bool)$input['wantToBeHost'] : false;

        if (!$roomId || !$clientId) {
            http_response_code(400);
            echo json_encode(['error' => 'Missing roomId or clientId']);
            exit;
        }

        $room = loadRoom($roomId);
        cleanupStaleUsers($room);

        // Hapus entry lama jika clientId sama (reconnect)
        $room['users'] = array_values(array_filter($room['users'], function($u) use ($clientId) {
            return $u['clientId'] !== $clientId;
        }));

        // Cek: jika user ingin jadi host tapi sudah ada host, reject
        if ($wantToBeHost && !empty($room['users']) && $room['hostClientId'] !== null) {
            http_response_code(403);
            echo json_encode(['error' => 'Room ini sudah memiliki host. Bergabunglah sebagai peserta.']);
            exit;
        }

        // Set host: jika dia yang pertama di room atau dia mau jadi host
        if (empty($room['users']) || $wantToBeHost) {
            $room['hostClientId'] = $clientId;
        }

        $room['users'][] = [
            'clientId'      => $clientId,
            'userName'      => $userName,
            'lastHeartbeat' => time(),
            'joinedAt'      => time(),
        ];

        saveRoom($roomId, $room);

        // Kirim daftar user yang sudah ada (selain diri sendiri)
        $existingUsers = array_values(array_filter($room['users'], function($u) use ($clientId) {
            return $u['clientId'] !== $clientId;
        }));
        // Sederhanakan data
        $existingUsers = array_map(function($u) {
            return ['clientId' => $u['clientId'], 'userName' => $u['userName']];
        }, $existingUsers);

        echo json_encode([
            'success'      => true,
            'users'        => $existingUsers,
            'hostClientId' => $room['hostClientId'],
            'isHost'       => ($room['hostClientId'] === $clientId),
            'recording'    => (bool)$room['recording'],
        ]);
        break;

    // ── LEAVE ────────────────────────────────────────────────
    case 'leave':
        $roomId   = isset($input['roomId'])   ? trim($input['roomId'])   : '';
        $clientId = isset($input['clientId']) ? trim($input['clientId']) : '';

        if (!$roomId || !$clientId) {
            echo json_encode(['success' => true]);
            exit;
        }

        $room = loadRoom($roomId);

        $room['users'] = array_values(array_filter($room['users'], function($u) use ($clientId) {
            return $u['clientId'] !== $clientId;
        }));

        if ($room['hostClientId'] === $clientId) {
            $room['hostClientId'] = !empty($room['users']) ? $room['users'][0]['clientId'] : null;
        }

        if ($room['recording'] && $room['recordingHost'] === $clientId) {
            $room['recording']     = false;
            $room['recordingHost'] = null;
        }

        if (empty($room['users'])) {
            $file = getRoomFile($roomId);
            if ($file && file_exists($file)) unlink($file);
        } else {
            saveRoom($roomId, $room);
        }

        echo json_encode(['success' => true]);
        break;

    // ── HEARTBEAT ────────────────────────────────────────────
    case 'heartbeat':
        $roomId       = isset($input['roomId'])       ? trim($input['roomId'])       : '';
        $clientId     = isset($input['clientId'])     ? trim($input['clientId'])     : '';
        $lastSignalId = isset($input['lastSignalId']) ? (string)$input['lastSignalId'] : '';
        $lastChatId   = isset($input['lastChatId'])   ? (int)$input['lastChatId']     : 0;

        if (!$roomId || !$clientId) {
            http_response_code(400);
            echo json_encode(['error' => 'Missing roomId or clientId']);
            exit;
        }

        $room = loadRoom($roomId);
        cleanupStaleUsers($room);

        if (empty($room['users'])) {
            // Hapus room file jika kosong
            $file = getRoomFile($roomId);
            if ($file && file_exists($file)) {
                unlink($file);
            }
            echo json_encode(['error' => 'not_in_room']);
            exit;
        }

        // Update heartbeat
        $userFound = false;
        foreach ($room['users'] as &$user) {
            if ($user['clientId'] === $clientId) {
                $user['lastHeartbeat'] = time();
                $userFound = true;
                break;
            }
        }
        unset($user);

        if (!$userFound) {
            echo json_encode(['error' => 'not_in_room']);
            exit;
        }

        $removedUsers = cleanupStaleUsers($room);

        // Kumpulkan sinyal untuk client ini
        $newSignals       = [];
        $remainingSignals = [];
        $latestSignalId   = $lastSignalId;
        $now              = time();

        foreach ($room['signals'] as $sig) {
            $age = $now - (isset($sig['createdAt']) ? $sig['createdAt'] : 0);

            // Buang sinyal yang sudah terlalu lama
            if ($age > $SIGNAL_MAX_AGE) continue;

            if ($sig['to'] === $clientId) {
                // Kirim jika lebih baru dari yang terakhir diterima
                $sigId = isset($sig['id']) ? $sig['id'] : '';
                if (!$lastSignalId || floatval($sigId) > floatval($lastSignalId)) {
                    $newSignals[]   = $sig;
                    $latestSignalId = $sigId;
                }
                // Simpan sementara untuk durasi lebih lama agar tidak hilang
                if ($age < 20) {
                    $remainingSignals[] = $sig;
                }
            } else {
                // Simpan sinyal untuk peer lain
                $remainingSignals[] = $sig;
            }
        }
        $room['signals'] = $remainingSignals;

        // Kumpulkan chat baru
        $newChat = [];
        foreach ($room['chat'] as $idx => $msg) {
            if ($idx >= $lastChatId) {
                $newChat[] = $msg;
            }
        }

        // Batasi chat tersimpan
        if (count($room['chat']) > 200) {
            $room['chat'] = array_slice($room['chat'], -200);
        }

        // Hapus room jika kosong
        if (empty($room['users'])) {
            $file = getRoomFile($roomId);
            if ($file && file_exists($file)) {
                unlink($file);
            }
        } else {
            saveRoom($roomId, $room);
        }

        // Susun daftar user (tanpa lastHeartbeat — info internal)
        $userList = array_map(function($u) {
            return ['clientId' => $u['clientId'], 'userName' => $u['userName']];
        }, $room['users']);

        $removedList = array_map(function($u) {
            return ['clientId' => $u['clientId'], 'userName' => $u['userName']];
        }, $removedUsers);

        echo json_encode([
            'users'        => $userList,
            'hostClientId' => $room['hostClientId'],
            'isHost'       => ($room['hostClientId'] === $clientId),
            'signals'      => $newSignals,
            'lastSignalId' => $latestSignalId,
            'chat'         => $newChat,
            'lastChatId'   => count($room['chat']),
            'removedUsers' => $removedList,
            'recording'    => (bool)$room['recording'],
        ]);
        break;

    // ── SIGNAL ───────────────────────────────────────────────
    case 'signal':
        $roomId = isset($input['roomId']) ? trim($input['roomId']) : '';
        $from   = isset($input['from'])   ? trim($input['from'])   : '';
        $to     = isset($input['to'])     ? trim($input['to'])     : '';
        $type   = isset($input['type'])   ? $input['type']         : '';
        $data   = isset($input['data'])   ? $input['data']         : null;

        if (!$roomId || !$from || !$to || !$type) {
            http_response_code(400);
            echo json_encode(['error' => 'Missing required fields']);
            exit;
        }

        $room = loadRoom($roomId);

        $room['signals'][] = [
            'id'        => makeSignalId(),
            'from'      => $from,
            'to'        => $to,
            'type'      => $type,
            'data'      => $data,
            'createdAt' => time(),
        ];

        // Batasi jumlah sinyal
        if (count($room['signals']) > $SIGNAL_LIMIT) {
            $room['signals'] = array_slice($room['signals'], -$SIGNAL_LIMIT);
        }

        saveRoom($roomId, $room);

        echo json_encode(['success' => true]);
        break;

    // ── CHAT ─────────────────────────────────────────────────
    case 'chat':
        $roomId   = isset($input['roomId'])   ? trim($input['roomId'])   : '';
        $clientId = isset($input['clientId']) ? trim($input['clientId']) : '';
        $userName = isset($input['userName']) ? trim(substr($input['userName'], 0, 50)) : 'User';
        $message  = isset($input['message'])  ? trim(substr($input['message'], 0, 1000)) : '';

        if (!$roomId || !$message) {
            http_response_code(400);
            echo json_encode(['error' => 'Missing fields']);
            exit;
        }

        $room = loadRoom($roomId);
        $room['chat'][] = [
            'clientId' => $clientId,
            'userName' => $userName,
            'message'  => $message,
            'sentAt'   => round(microtime(true) * 1000),
        ];

        saveRoom($roomId, $room);
        echo json_encode(['success' => true]);
        break;

    // ── RECORDING START ───────────────────────────────────────
    case 'recording-start':
        $roomId   = isset($input['roomId'])   ? trim($input['roomId'])   : '';
        $clientId = isset($input['clientId']) ? trim($input['clientId']) : '';

        if (!$roomId || !$clientId) {
            http_response_code(400);
            echo json_encode(['error' => 'Missing fields']);
            exit;
        }

        $room = loadRoom($roomId);

        if ($room['hostClientId'] !== $clientId) {
            echo json_encode(['error' => 'Hanya host yang bisa merekam']);
            exit;
        }

        $room['recording']     = true;
        $room['recordingHost'] = $clientId;
        saveRoom($roomId, $room);

        echo json_encode(['success' => true]);
        break;

    // ── RECORDING STOP ────────────────────────────────────────
    case 'recording-stop':
        $roomId   = isset($input['roomId'])   ? trim($input['roomId'])   : '';
        $clientId = isset($input['clientId']) ? trim($input['clientId']) : '';

        $room = loadRoom($roomId);
        if ($room['recordingHost'] === $clientId || $room['hostClientId'] === $clientId) {
            $room['recording']     = false;
            $room['recordingHost'] = null;
            saveRoom($roomId, $room);
        }

        echo json_encode(['success' => true]);
        break;

    default:
        http_response_code(400);
        echo json_encode(['error' => 'Unknown action: ' . htmlspecialchars($action)]);
        break;
}