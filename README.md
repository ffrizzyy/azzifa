# Azzifa

Jurnal harian dengan mood tracker (beberapa catatan per hari), dashboard tren mood, pengamatan pola AI mingguan, dan rangkuman kegiatan AI — versi standalone yang bisa dijalankan sendiri atau di-deploy ke server mana pun.

## Fitur

- **Hari ini** — halaman dibuka langsung pada **kartu tulis**, fitur utamanya: kartu terbesar di halaman, berisi pilihan mode, pertanyaan, kotak tulis, foto, perasaan hari ini, dan tombol simpan. Tulis dengan mode Harian (empat langkah tetap + rangkuman AI; ini yang terbuka duluan) atau Check Up (pertanyaan acak). Tiap catatan bisa diberi **foto** dari kamera atau galeri (maksimal 4 per catatan; catatan boleh hanya berisi foto). Kartu **Hari ini di masa lalu** menampilkan catatanmu seminggu, sebulan, 3 dan 6 bulan lalu, serta tanggal yang sama di tahun-tahun sebelumnya.
- **Dashboard** — streak, grafik mood 7/30 hari, pengamatan AI mingguan, **kalender mood** per bulan (ketuk tanggal untuk membuka catatannya), dan **streak bareng**.
- **Riwayat** — **pencarian**, saringan mood, **#tag** (tulis `#kerja` di catatan, otomatis jadi tag), **favorit** (bintang per catatan), rangkuman AI, ekspor `.txt`, cetak/PDF, serta **cadangan `.json`** yang bisa dipulihkan lagi.
- **Tur fitur** — saat pertama kali masuk, tiap akun diajak keliling langkah demi langkah (17 langkah, bisa dilewati) melewati semua fitur di ketiga halaman. Tur bisa dibuka lagi kapan saja lewat ikon lonceng.
- **Akun** — satu server bisa dipakai beberapa orang. Tiap akun punya jurnal sendiri yang tidak bisa dibaca akun lain.

### Streak bareng

Dua orang atau lebih bisa menjaga streak bersama. Buat grup di Dashboard, bagikan kode undangannya (6 karakter), lalu teman bergabung dengan kode itu dari akunnya sendiri di server yang sama.

- Streak grup naik satu untuk setiap hari **semua** anggotanya menulis.
- Hari ini yang belum lengkap tidak langsung memutus streak; streak baru putus kalau satu hari penuh terlewat.
- Hari sebelum seseorang bergabung tidak dihitung untuk orang itu, dan streak baru mulai berjalan setelah grup punya minimal dua anggota.
- Yang terlihat anggota lain hanya **nama panggilan** dan **sudah atau belum menulis hari ini**. Isi catatan dan mood tidak pernah dibagikan.
- Pergantian hari mengikuti **tanggal lokal** tiap anggota (tengah malam di perangkatnya), sama seperti bagian aplikasi lainnya. Anggota di zona waktu yang sama berbagi batas hari yang sama; kalau zona waktunya berbeda, masing-masing dihitung menurut harinya sendiri.

## Menjalankan lokal

```bash
npm install
cp .env.example .env
npm start
```

Buka `http://localhost:3000`.

Fitur AI (pengamatan mingguan di Dashboard, rangkuman kegiatan di Riwayat, rangkuman harian di mode Harian) bersifat opsional — tanpa kunci API di `.env`, seluruh aplikasi tetap jalan normal, dan kotak-kotak itu menjelaskan sendiri bahwa AI belum diaktifkan (tanpa tombol yang pasti gagal, tanpa pesan error teknis).

```bash
npm test   # menjalankan server sungguhan dengan database sementara, lalu mengujinya lewat HTTP
```

### Variabel lingkungan

| Variabel | Default | Fungsi |
|---|---|---|
| `PORT` | `3000` | Port server |
| `DATA_DIR` | `./data` | Folder tempat `azzifa.sqlite` disimpan. Arahkan ke disk persisten saat deploy |
| `ALLOW_SIGNUP` | `true` | `false` menutup pendaftaran akun baru (akun pertama selalu bisa dibuat) |
| `SIGNUPS_PER_HOUR` | `10` | Batas pembuatan akun per jam dari satu alamat IP |
| `AI_DAILY_LIMIT` | `30` | Batas permintaan AI per akun per hari, karena semua akun memakai kunci API yang sama |
| `PHOTO_LIMIT` | `2000` | Jumlah foto maksimal per akun |
| `SIGNUP_CODE` | kosong | Kalau diisi, pendaftaran akun butuh kode ini. Isi kalau dipasang di internet |
| `TRUST_PROXY` | kosong | Jumlah proxy di depan aplikasi (biasanya `1` di hosting). Kosongkan saat dijalankan langsung |
| `AI_PROVIDER` dan kuncinya | `anthropic` | Lihat bagian di bawah |

## Pakai AI dari provider lain

`AI_PROVIDER` di `.env` menentukan provider mana yang dipanggil server. Kodenya satu abstraksi (`server/ai.js`), jadi ganti provider = ganti `.env`, bukan ganti kode.

| `AI_PROVIDER` | Butuh diisi | Contoh |
|---|---|---|
| `anthropic` (default) | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Claude |
| `openai` | `OPENAI_API_KEY`, `OPENAI_MODEL` | GPT |
| `openai_compatible` | `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY` (opsional) | Groq, Together AI, Mistral, atau model lokal (mis. Ollama) lewat proxy yang meniru endpoint `chat/completions` OpenAI |

Lihat `.env.example` untuk daftar lengkap variabelnya.

## Deploy

**Panduan lengkap memasang di internet ada di [DEPLOY.md](DEPLOY.md)** (Fly.io, Railway, Render, atau VPS sendiri dengan HTTPS otomatis), termasuk kode pendaftaran dan cadangan rutin. Ringkasnya:

**Docker (cara termudah):**
```bash
cp .env.example .env   # isi provider AI kalau mau
docker compose up -d --build
```
Data SQLite tersimpan di volume bernama `azzifa-data`, jadi tetap ada walau container dihapus dan dibuat ulang.

**VPS / server sendiri (tanpa Docker):**
```bash
npm ci --omit=dev
cp .env.example .env
npm start   # pakai pm2 atau systemd supaya tetap jalan setelah SSH ditutup
```

**Platform dengan disk persisten (Render, Railway, Fly.io, dll.):** set environment variables lewat dashboard platform tersebut, lalu pastikan folder `data/` dipetakan ke volume/disk persisten (atau set `DATA_DIR` ke lokasi disk itu) — bukan sekadar filesystem sementara, atau riwayat jurnal akan hilang saat container di-restart.

**Yang TIDAK akan berfungsi:** platform serverless/edge murni (Vercel Functions, Netlify Functions, Cloudflare Workers). Azzifa memakai file SQLite di disk, dan platform-platform itu tidak punya filesystem persisten antar request. Kalau memang butuh serverless, itu berarti mengganti `server/db.js` ke database terkelola (Postgres, Turso, dsb.) — perubahan arsitektur, bukan sekadar konfigurasi.

Ada endpoint `GET /healthz` yang mengembalikan `{ok:true}` untuk health check platform deploy.

## Arsitektur

- **Frontend** (`public/index.html`) — satu file HTML/CSS/JS vanilla, tidak ada build step. Bicara ke backend lewat `fetch()` biasa.
- **Backend** (`server/index.js`) — Express, menyajikan file statis dari `public/` sekaligus REST API di `/api/*`.
- **AI** (`server/ai.js`) — satu fungsi `generateText(prompt)` yang menyembunyikan provider mana yang sebenarnya dipanggil.
- **Akun** (`server/auth.js`) — daftar, masuk, keluar. Kata sandi di-hash dengan scrypt + salt per akun; sesi berupa token acak di cookie `HttpOnly`, dan database hanya menyimpan hash SHA-256 dari token itu.
- **Streak bareng** (`server/circles.js`) — grup, kode undangan, dan perhitungan streak grup.
- **Tanggal** (`server/day.js`) — "hari ini" adalah tanggal lokal penulisnya, bukan jam server. Browser mengirimnya di header `X-Local-Date` pada setiap permintaan; server hanya menerimanya kalau selisihnya paling banyak satu hari dari tanggal UTC server (tidak ada zona waktu yang lebih jauh dari itu), selain itu server memakai tanggal UTC-nya sendiri.
- **Keamanan dasar** — semua masukan catatan dibersihkan di server sebelum disimpan (tanggal harus nyata, mood harus dikenal, catatan hanya membawa field yang dipakai aplikasi), respons membawa `Content-Security-Policy`, `X-Content-Type-Options`, dan `Referrer-Policy`, dan semua error dijawab dalam JSON.
- **Database** (`server/db.js`) — SQLite lewat `better-sqlite3`, satu file di `data/azzifa.sqlite`. Skema di-migrasi otomatis: database dari versi satu-pengguna dibangun ulang dengan kolom `user_id`, dan seluruh catatan lamanya diwarisi oleh **akun pertama yang mendaftar**.

```
azzifa-app/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── .env.example
├── server/
│   ├── index.js    # Express app + route jurnal, pengaturan, ekspor, AI
│   ├── auth.js     # akun + sesi
│   ├── circles.js  # streak bareng
│   ├── photos.js   # foto di catatan
│   ├── day.js      # tanggal lokal penulis
│   ├── ai.js       # abstraksi provider AI
│   └── db.js       # koneksi SQLite + skema tabel + migrasi
├── test/           # npm test
├── public/
│   └── index.html  # seluruh frontend
└── data/           # dibuat otomatis, isi: azzifa.sqlite (jangan di-commit)
```

## API

Semua route `/api/*` selain `/api/auth/*` butuh sesi masuk (cookie) dan hanya menyentuh data akun yang sedang masuk; tanpa sesi jawabannya `401`.

| Method | Path | Fungsi |
|---|---|---|
| GET | `/api/auth/config` | `{signup, firstAccount}` — apakah pendaftaran dibuka, dan apakah server ini belum punya akun |
| POST | `/api/auth/register` | Buat akun `{username, name, password}` lalu langsung masuk |
| POST | `/api/auth/login` | Masuk `{username, password}`. 8 kali gagal = terkunci 10 menit |
| POST | `/api/auth/logout` | Keluar; sesi dihapus di server |
| GET | `/api/me` | Akun yang sedang masuk |
| GET | `/api/circles` | Grup streak yang kamu ikuti: streak, anggota, siapa yang sudah menulis hari ini |
| POST | `/api/circles` | Buat grup `{name}` |
| POST | `/api/circles/join` | Gabung dengan kode undangan `{code}` |
| DELETE | `/api/circles/:id/membership` | Keluar dari grup (grup terhapus kalau anggotanya habis) |
| POST | `/api/photos` | Unggah satu foto (isi permintaan = byte gambar JPEG/PNG/WebP, maksimal 4 MB). Jawabannya `{id}`, yang lalu dimasukkan ke `photos` sebuah catatan |
| GET | `/api/photos/:id` | Ambil foto. Hanya pemiliknya yang bisa; untuk akun lain jawabannya `404` |
| GET | `/api/entries` | Ambil 2000 hari terbaru, masing-masing dengan array `notes` |
| GET | `/api/export.json` | Unduh cadangan lengkap (catatan, favorit, rangkuman harian) |
| POST | `/api/import` | Pulihkan cadangan `{entries:[...]}`. Tanggal yang sama ditimpa, tanggal lain dibiarkan |
| PUT | `/api/entries/:date` | Simpan seluruh catatan tanggal tsb (`{mood, notes, daySummary}`). `400` kalau tanggalnya tidak nyata atau tidak ada catatan berisi teks |
| DELETE | `/api/entries/:date` | Hapus seluruh catatan tanggal tsb |
| GET | `/api/settings` | Pengaturan pengingat, cache pengamatan/rangkuman, dan `ai: {configured, label}` |
| PUT | `/api/settings` | Perbarui `reminderEnabled`, `reminderTime`, `summaryRange`, `dayMode`, `tourDone`. Kunci lain diabaikan |
| GET | `/api/export.txt` | Unduh seluruh riwayat + rangkuman (kalau ada) sebagai teks polos |
| POST | `/api/insight` | Pengamatan pola mingguan dari 14 catatan terakhir (butuh AI provider terkonfigurasi) |
| POST | `/api/summary` | Rangkuman kegiatan `{range: 7\|30}` hari terakhir (butuh AI provider terkonfigurasi) |
| POST | `/api/entries/:date/day-summary` | Rangkuman satu hari itu saja (mode "Harian"), tersimpan di baris entri itu sendiri (butuh AI provider terkonfigurasi) |
| GET | `/healthz` | `{ok:true}` — untuk health check |

Satu hari kini bisa punya beberapa catatan terpisah (kolom `notes`, JSON array `{prompt, text, at, fav?, photos?}`; `fav` menandai favorit, `photos` berisi id foto, dan tag tidak disimpan terpisah melainkan dibaca dari `#kata` di dalam `text`). Baris yang dibuat sebelum kolom ini ada tetap terbaca sebagai satu catatan, dari kolom `prompt`/`text` lama — tidak ada migrasi manual yang perlu dijalankan.

## Catatan jujur soal keterbatasan

- **Akun sederhana.** Ada daftar/masuk/keluar, tapi belum ada ganti kata sandi, lupa kata sandi, atau hapus akun dari antarmuka. Kalau lupa kata sandi, satu-satunya jalan saat ini adalah mengubah database langsung.
- **Pendaftaran terbuka secara default.** Siapa pun yang tahu alamat server bisa membuat akun (jurnal tiap akun tetap terpisah). Set `ALLOW_SIGNUP=false` setelah semua orang yang kamu ajak sudah mendaftar.
- **Pakai HTTPS kalau di-deploy.** Kata sandi dikirim saat masuk; tanpa HTTPS ia lewat jaringan tanpa enkripsi. Di balik reverse proxy HTTPS, cookie sesi otomatis diberi tanda `Secure`.
- **Streak bareng hanya antar akun di server yang sama.** Dua instalasi Azzifa yang terpisah tidak bisa saling terhubung.
- **Kunci AI dipakai bersama.** Semua akun memakai provider AI yang sama dari `.env`, jadi biayanya ditanggung pemilik server.
- **Input suara** pakai Web Speech API bawaan browser — tidak jalan di Firefox, dan tetap butuh koneksi internet meski datanya sendiri sudah lokal.
- **Pengingat** cuma aktif kalau tab browser masih terbuka (pakai Notification API bawaan browser), dan muncul saat tab itu sedang tidak dilihat. Sapaan di dalam aplikasi tetap jadi jaring pengaman kalau notifikasi tidak didukung/ditolak.
- **Catatan lama memakai tanggal UTC.** Versi awal menentukan "hari ini" dengan UTC, jadi catatan yang ditulis sebelum pukul 07.00 WIB tersimpan di tanggal sehari sebelumnya. Catatan baru memakai tanggal lokal; catatan lama tidak digeser otomatis.
- **Satu hari disimpan utuh.** Kalau jurnal yang sama dibuka di dua perangkat sekaligus dan keduanya menyimpan catatan untuk hari yang sama, simpanan terakhir yang menang.
- **Draf tersimpan di browser.** Tulisan yang belum disimpan diingat di perangkat itu (bukan di server) sampai disimpan atau sampai keluar akun.
- **Foto disimpan di dalam database.** Sebelum diunggah, browser mengecilkan tiap foto (sisi terpanjang 1600 px, JPEG), yang sekaligus membuang data lokasi dari kamera. Foto tersimpan di `azzifa.sqlite` bersama catatannya, jadi memindahkan satu file itu sudah membawa semuanya, tapi ukuran file ikut membesar. Foto ikut terhapus saat catatannya dihapus, dan ikut masuk ke cadangan `.json`.
- **Kamera butuh HTTPS atau localhost.** Tombol Kamera menyalakan kamera langsung di halaman (pratinjau, tombol jepret, ganti kamera) di ponsel maupun komputer, tapi browser hanya mengizinkannya lewat HTTPS atau `localhost`. Kalau Azzifa dibuka lewat alamat `http://` biasa (misalnya IP di jaringan rumah), tombol itu jatuh ke pemilih bawaan perangkat: di ponsel tetap membuka aplikasi kamera, di komputer membuka pemilih file.
- **Foto tidak dikirim ke AI.** Rangkuman dan pengamatan hanya membaca teks catatan.

## Pengujian

`npm test` menjalankan server sungguhan dengan database sementara dan mengujinya lewat HTTP: akun dan sesi, isolasi jurnal antar akun, validasi catatan, tanggal lokal, cadangan dan pemulihan, aturan streak grup, foto (unggah, privasi antar akun, pembersihan, cadangan), jawaban saat AI belum diaktifkan, dan header keamanan.

Di luar itu, halaman sudah dijalankan di Chrome headless (ponsel dan desktop, terang dan gelap) untuk memeriksa alur daftar/masuk, ketiga tab, pemulihan draf, perubahan mood, foto dan kamera (dengan perangkat kamera simulasi), seluruh langkah tur fitur, tanggal di beberapa zona waktu, dan bahwa tidak ada pelanggaran Content-Security-Policy.

Yang **belum** diuji: fitur AI dengan kunci API sungguhan, input suara, notifikasi pengingat, kamera di perangkat sungguhan, dan deploy lewat Docker.
