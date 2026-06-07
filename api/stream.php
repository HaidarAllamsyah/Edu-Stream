<?php
/**
 * EduStream - Stream/Download Recording (FIXED)
 *
 * Perbaikan:
 * - Path menggunakan forward slash (aman di Windows XAMPP & Linux)
 * - Content-Type spesifik: video/webm
 * - Tambah header untuk kompatibilitas browser dan ngrok
 * - Validasi nama file lebih ketat
 */

// Hentikan buffering PHP agar streaming lancar
if (ob_get_level()) ob_end_clean();

$RECORDINGS_DIR = rtrim(str_replace('\\', '/', __DIR__ . '/../recordings'), '/');

$filename = isset($_GET['file']) ? basename($_GET['file']) : '';
$download = isset($_GET['download']) && $_GET['download'];

// Validasi nama file
if (!$filename || !preg_match('/^[a-zA-Z0-9_-]+\.(webm|mp4)$/', $filename)) {
    http_response_code(400);
    header('Content-Type: text/plain');
    echo 'Invalid or missing file parameter';
    exit;
}

$filePath = $RECORDINGS_DIR . '/' . $filename;

if (!file_exists($filePath) || !is_file($filePath)) {
    http_response_code(404);
    header('Content-Type: text/plain');
    echo 'File not found';
    exit;
}

$fileSize = filesize($filePath);
$ext      = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
$mimeType = ($ext === 'mp4') ? 'video/mp4' : 'video/webm';

// Header umum
header('Access-Control-Allow-Origin: *');
header('Cache-Control: public, max-age=3600');

if ($download) {
    header('Content-Type: application/octet-stream');
    header('Content-Disposition: attachment; filename="' . $filename . '"');
    header('Content-Length: ' . $fileSize);
    readfile($filePath);
    exit;
}

// Streaming dengan Range support (wajib untuk video seekable)
header('Accept-Ranges: bytes');
header('Content-Type: ' . $mimeType);

$range = isset($_SERVER['HTTP_RANGE']) ? trim($_SERVER['HTTP_RANGE']) : '';

if ($range) {
    // Parse "bytes=start-end"
    if (!preg_match('/^bytes=(\d*)-(\d*)$/', $range, $m)) {
        http_response_code(416);
        header('Content-Range: bytes */' . $fileSize);
        exit;
    }

    $start = $m[1] !== '' ? (int)$m[1] : 0;
    $end   = $m[2] !== '' ? (int)$m[2] : $fileSize - 1;

    if ($end >= $fileSize) $end = $fileSize - 1;

    if ($start > $end || $start >= $fileSize || $start < 0) {
        http_response_code(416);
        header('Content-Range: bytes */' . $fileSize);
        exit;
    }

    $length = $end - $start + 1;

    http_response_code(206);
    header('Content-Range: bytes ' . $start . '-' . $end . '/' . $fileSize);
    header('Content-Length: ' . $length);

    $fp = fopen($filePath, 'rb');
    fseek($fp, $start);

    $remaining = $length;
    $chunkSize = 1024 * 64; // 64 KB per baca

    while ($remaining > 0 && !feof($fp)) {
        $read = min($chunkSize, $remaining);
        echo fread($fp, $read);
        flush();
        $remaining -= $read;
    }
    fclose($fp);

} else {
    // Kirim seluruh file
    header('Content-Length: ' . $fileSize);

    $fp        = fopen($filePath, 'rb');
    $chunkSize = 1024 * 64;

    while (!feof($fp)) {
        echo fread($fp, $chunkSize);
        flush();
    }
    fclose($fp);
}