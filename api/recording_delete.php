<?php
/**
 * EduStream - Delete Recording API (FIXED)
 */

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

$RECORDINGS_DIR = rtrim(str_replace('\\', '/', __DIR__ . '/../recordings'), '/');

$raw      = file_get_contents('php://input');
$input    = json_decode($raw, true);
$filename = isset($input['filename']) ? basename($input['filename']) : '';

if (!$filename || !preg_match('/^[a-zA-Z0-9_-]+\.(webm|mp4)$/', $filename)) {
    http_response_code(400);
    echo json_encode(['error' => 'Nama file tidak valid']);
    exit;
}

$filePath = $RECORDINGS_DIR . '/' . $filename;

if (!file_exists($filePath) || !is_file($filePath)) {
    http_response_code(404);
    echo json_encode(['error' => 'File tidak ditemukan']);
    exit;
}

if (unlink($filePath)) {
    echo json_encode(['success' => true]);
} else {
    http_response_code(500);
    echo json_encode(['error' => 'Gagal menghapus file']);
}