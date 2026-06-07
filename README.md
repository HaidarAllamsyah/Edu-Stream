# 🎥 EduStream - Web-Based Video Conference Application (XAMPP PHP Version)

Aplikasi video conference berbasis web yang **LENGKAP** dan **SIAP DIJALANKAN** di bawah **XAMPP (Apache + PHP)** dan **ngrok** tanpa memerlukan instalasi Node.js.

## ✅ Fitur Utama
- **WebRTC video/audio streaming** (peer-to-peer real-time dengan STUN/TURN servers).
- **Layout grid dinamis** otomatis menyesuaikan jumlah peserta (seperti Google Meet).
- **Screen sharing** dengan layout presentasi (layar utama besar + sidebar peserta).
- **Perekaman Layar (Recording)** dengan composite video, audio, dan chat overlay langsung disimpan ke server PHP.
- **Chat Room** real-time terintegrasi di sidebar.
- **Daftar Rekaman** untuk memutar (dengan HTTP Range/Seekable), mendownload, atau menghapus file rekaman `.webm`.
- **Signaling via AJAX Polling** ke PHP backend (tidak membutuhkan Socket.io / WebSocket server).

---

## 🚀 Cara Menjalankan dengan XAMPP

### 1. Penempatan Folder
Pindahkan/letakkan seluruh folder `EDUSTREAMFIX` ini ke dalam direktori `htdocs` dari instalasi XAMPP Anda.
Contoh path di Windows:
`C:\xampp\htdocs\EDUSTREAMFIX`

### 2. Jalankan XAMPP Control Panel
- Buka **XAMPP Control Panel**.
- Jalankan modul **Apache** (klik **Start**).

### 3. Akses via Browser (Localhost)
- Buka browser (Chrome, Firefox, Edge).
- Kunjungi: `http://localhost/EDUSTREAMFIX/`
- Browser secara otomatis akan mengarahkan Anda ke halaman `login.html`.

---

## 🌐 Menghubungkan Device Lain (Menggunakan ngrok)
Karena WebRTC membutuhkan HTTPS atau localhost untuk mengakses kamera & mikrofon, jika Anda ingin mengakses dari handphone atau device lain, Anda harus menggunakan **ngrok** yang sudah disediakan di folder ini.

### Langkah-langkah:
1. Buka Command Prompt (cmd) atau PowerShell di Windows.
2. Masuk ke direktori ngrok:
   ```cmd
   cd "C:\xampp\htdocs\EDUSTREAMFIX\ngrok-v3-stable-windows-amd64"
   ```
3. Jalankan ngrok untuk meneruskan port 80 (Apache):
   ```cmd
   ./ngrok.exe http 80
   ```
4. Ngrok akan menampilkan URL HTTPS acak, misalnya: `https://abcd-123-45-67.ngrok-free.app`
5. Akses URL tersebut melalui browser di handphone atau device lain dengan menambahkan sub-path `/EDUSTREAMFIX/`:
   `https://abcd-123-45-67.ngrok-free.app/EDUSTREAMFIX/`
6. Masukkan nama yang berbeda dan bergabunglah ke Room ID yang sama untuk mulai berkonferensi!

---

## 📁 Struktur Folder Proyek
```
EDUSTREAMFIX/
├── api/                       ← Backend Signaling & File Management (PHP)
│   ├── sync.php               ← AJAX Polling signaling (join, heartbeat, signal, chat)
│   ├── recording.php          ← Mengelola upload chunk video rekaman
│   ├── recordings_list.php    ← Mengambil daftar file rekaman .webm
│   ├── recording_delete.php   ← Menghapus file rekaman dari server
│   └── stream.php             ← Streaming/download file rekaman (dengan HTTP Range)
├── css/
│   └── style.css              ← Styling interface + grid layout dinamis
├── js/
│   └── meet.js                ← Logika WebRTC, polling signaling, recording canvas & chat
├── data/                      ← Folder otomatis dibuat oleh PHP untuk menyimpan data room
├── recordings/                ← Folder otomatis dibuat oleh PHP untuk menampung rekaman video .webm
├── ngrok-v3-stable-windows-amd64/ ← Bundle utilitas ngrok.exe
├── index.html                 ← Auto-redirect ke login.html
├── login.html                 ← Halaman Input Nama
├── lobby.html                 ← Pembuatan/join room ID (8 karakter)
├── meet.html                  ← Halaman Video Conference utama
└── recordings.html            ← Halaman daftar rekaman & video player
```

---

## 🔧 Spesifikasi Teknis WebRTC
- **ICE Servers**: Google STUN Servers & Metered.ca TURN Servers (untuk koneksi antar jaringan berbeda/NAT traversal).
- **Codecs**: VP8/VP9 (video) + Opus (audio).
- **Bitrate**: 2.5 Mbps video + 128 Kbps audio.
- **MIME Type**: `video/webm` (dengan fallback codec dinamis sesuai browser).

