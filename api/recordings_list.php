<?php
/**
 * EduStream - List Recordings API (FIXED)
 * Path menggunakan forward slash agar aman di XAMPP Windows
 */

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Cache-Control: no-store');

$RECORDINGS_DIR = rtrim(str_replace('\\', '/', __DIR__ . '/../recordings'), '/');

if (!is_dir($RECORDINGS_DIR)) {
    mkdir($RECORDINGS_DIR, 0777, true);
    echo json_encode([]);
    exit;
}

$files = [];
$items = scandir($RECORDINGS_DIR);

foreach ($items as $name) {
    if ($name === '.' || $name === '..') continue;
    $path = $RECORDINGS_DIR . '/' . $name;
    if (!is_file($path)) continue;

    $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    if (!in_array($ext, ['webm', 'mp4'])) continue;

    // Lewati file kosong (rekaman gagal)
    $size = filesize($path);
    if ($size < 100) continue;

    $stat    = stat($path);
    $files[] = [
        'name'     => $name,
        'size'     => $size,
        'created'  => date('c', $stat['ctime']),
        'modified' => date('c', $stat['mtime']),
    ];
}

echo json_encode($files);