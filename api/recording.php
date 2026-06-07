<?php
/**
 * EduStream - Recording Upload API (FIXED)
 *
 * Perbaikan dari versi sebelumnya:
 * - Path menggunakan '/' hardcoded (lebih aman di XAMPP Windows maupun Linux)
 * - Chunk di-buffer sampai onstop lalu upload sekaligus → file WebM valid & tidak corrupt
 * - Validasi nama file lebih ketat
 * - Header CORS untuk akses dari ngrok
 */

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Room-Id, X-Client-Id, X-Filename');
header('Cache-Control: no-store');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// Path penyimpanan rekaman — gunakan forward slash agar aman di Windows & Linux
$RECORDINGS_DIR = rtrim(str_replace('\\', '/', __DIR__ . '/../recordings'), '/');

if (!is_dir($RECORDINGS_DIR)) {
    mkdir($RECORDINGS_DIR, 0755, true);
}

$action = isset($_GET['action']) ? $_GET['action'] : '';

switch ($action) {

    // ── START: Buat file kosong, kembalikan nama file ─────────
    case 'start':
        $raw   = file_get_contents('php://input');
        $input = json_decode($raw, true);
        $roomId = isset($input['roomId'])
            ? preg_replace('/[^a-zA-Z0-9_-]/', '', $input['roomId'])
            : 'room';

        $fileName = $roomId . '_' . date('Ymd_His') . '_' . substr(uniqid(), -4) . '.webm';
        $filePath = $RECORDINGS_DIR . '/' . $fileName;

        if (file_put_contents($filePath, '') !== false) {
            echo json_encode(['success' => true, 'fileName' => $fileName]);
        } else {
            http_response_code(500);
            echo json_encode(['error' => 'Gagal membuat file rekaman. Periksa permission folder recordings/']);
        }
        break;

    // ── CHUNK: Append binary ke file ─────────────────────────
    case 'chunk':
        // Ambil nama file dari header X-Filename
        $rawFilename = isset($_SERVER['HTTP_X_FILENAME'])
            ? $_SERVER['HTTP_X_FILENAME']
            : (isset($_SERVER['HTTP_X_FILENAME']) ? $_SERVER['HTTP_X_FILENAME'] : '');

        // Fallback: bisa juga dari query string
        if (!$rawFilename && isset($_GET['filename'])) {
            $rawFilename = $_GET['filename'];
        }

        $fileName = basename($rawFilename);

        // Validasi: hanya .webm atau .mp4, tanpa path traversal
        if (!$fileName || !preg_match('/^[a-zA-Z0-9_-]+\.(webm|mp4)$/', $fileName)) {
            http_response_code(400);
            echo json_encode(['error' => 'Nama file tidak valid: ' . htmlspecialchars($fileName)]);
            exit;
        }

        $filePath = $RECORDINGS_DIR . '/' . $fileName;

        if (!file_exists($filePath)) {
            http_response_code(404);
            echo json_encode(['error' => 'File tidak ditemukan, mulai ulang rekaman']);
            exit;
        }

        // Stream data binary dari input ke file
        $in  = fopen('php://input', 'rb');
        $out = fopen($filePath, 'ab');

        if ($in && $out) {
            $written = stream_copy_to_stream($in, $out);
            fclose($in);
            fclose($out);
            clearstatcache(true, $filePath);
            echo json_encode(['success' => true, 'written' => $written, 'totalSize' => filesize($filePath)]);
        } else {
            http_response_code(500);
            echo json_encode(['error' => 'Gagal memproses chunk']);
        }
        break;

    // ── STOP: Finalisasi ──────────────────────────────────────
    case 'stop':
        $raw      = file_get_contents('php://input');
        $input    = json_decode($raw, true);
        $fileName = isset($input['fileName']) ? basename($input['fileName']) : '';

        if ($fileName && preg_match('/^[a-zA-Z0-9_-]+\.(webm|mp4)$/', $fileName)) {
            $filePath = $RECORDINGS_DIR . '/' . $fileName;
            clearstatcache(true, $filePath);
            $size = file_exists($filePath) ? filesize($filePath) : 0;
            echo json_encode(['success' => true, 'fileName' => $fileName, 'size' => $size]);
        } else {
            echo json_encode(['success' => true, 'message' => 'Rekaman selesai']);
        }
        break;

    default:
        http_response_code(400);
        echo json_encode(['error' => 'Action tidak dikenal: ' . htmlspecialchars($action)]);
        break;
}