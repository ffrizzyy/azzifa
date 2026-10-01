# Azzifa

Jurnal harian dengan mood tracker (beberapa catatan per hari), dashboard tren mood, pengamatan pola AI mingguan, dan rangkuman kegiatan AI — versi standalone yang bisa dijalankan sendiri atau di-deploy ke server mana pun.

## Fitur

- **Hari ini** — pilih mood, tulis dengan mode Check Up (pertanyaan acak) atau Harian (empat langkah tetap + rangkuman AI). Kartu **Hari ini di masa lalu** menampilkan catatanmu seminggu, sebulan, 3 dan 6 bulan lalu, serta tanggal yang sama di tahun-tahun sebelumnya.
- **Dashboard** — streak, grafik mood 7/30 hari, pengamatan AI mingguan, **kalender mood** per bulan (ketuk tanggal untuk membuka catatannya), dan **streak bareng**.
- **Riwayat** — **pencarian**, saringan mood, **#tag** (tulis `#kerja` di catatan, otomatis jadi tag), **favorit** (bintang per catatan), rangkuman AI, ekspor `.txt`, cetak/PDF, serta **cadangan `.json`** yang bisa dipulihkan lagi.
- **Akun** — satu server bisa dipakai beberapa orang. Tiap akun punya jurnal sendiri yang tidak bisa dibaca akun lain.

### Streak bareng

Dua orang atau lebih bisa menjaga streak bersama. Buat grup di Dashboard, bagikan kode undangannya (6 karakter), lalu teman bergabung dengan kode itu dari akunnya sendiri di server yang sama.

- Streak grup naik satu untuk setiap hari **semua** anggotanya menulis.
- Hari ini yang belum lengkap tidak langsung memutus streak; streak baru putus kalau satu hari penuh terlewat.
- Hari sebelum seseorang bergabung tidak dihitung untuk orang itu, dan streak baru mulai berjalan setelah grup punya minimal dua anggota.
- Yang terlihat anggota lain hanya **nama panggilan** dan **sudah atau belum menulis hari ini**. Isi catatan dan mood tidak pernah dibagikan.
- Pergantian hari memakai UTC (sama dengan bagian aplikasi lainnya), jadi semua anggota grup berbagi batas hari yang sama. Di WIB, hari berganti pukul 07.00.

## Menjalankan lokal

```bash
npm install
cp .env.example .env
npm start
```

Buka `http://localhost:3000`.

Kedua fitur AI (pengamatan mingguan di Dashboard, rangkuman kegiatan di Riwayat) bersifat opsional — tanpa `.env` diisi, seluruh aplikasi tetap jalan normal, dua kotak itu saja yang bilang belum dikonfigurasi (bukan error diam-diam).

## Pakai AI dari provider lain

`AI_PROVIDER` di `.env` menentukan provider mana yang dipanggil server. Kodenya satu abstraksi (`server/ai.js`), jadi ganti provider = ganti `.env`, bukan ganti kode.

| `AI_PROVIDER` | Butuh diisi | Contoh |
|---|---|---|
| `anthropic` (default) | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Claude |
| `openai` | `OPENAI_API_KEY`, `OPENAI_MODEL` | GPT |
| `openai_compatible` | `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY` (opsional) | Groq, Together AI, Mistral, atau model lokal (mis. Ollama) lewat proxy yang meniru endpoint `chat/completions` OpenAI |

Lihat `.env.example` untuk daftar lengkap variabelnya.

## Deploy

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

**Platform dengan disk persisten (Render, Railway, Fly.io, dll.):** set environment variables lewat dashboard platform tersebut, lalu pastikan folder `data/` dipetakan ke volume/disk persisten — bukan sekadar filesystem sementara, atau riwayat jurnal akan hilang saat container di-restart.

**Yang TIDAK akan berfungsi:** platform serverless/edge murni (Vercel Functions, Netlify Functions, Cloudflare Workers). Azzifa memakai file SQLite di disk, dan platform-platform itu tidak punya filesystem persisten antar request. Kalau memang butuh serverless, itu berarti mengganti `server/db.js` ke database terkelola (Postgres, Turso, dsb.) — perubahan arsitektur, bukan sekadar konfigurasi.

Ada endpoint `GET /healthz` yang mengembalikan `{ok:true}` untuk health check platform deploy.

## Arsitektur

- **Frontend** (`public/index.html`) — satu file HTML/CSS/JS vanilla, tidak ada build step. Bicara ke backend lewat `fetch()` biasa.
- **Backend** (`server/index.js`) — Express, menyajikan file statis dari `public/` sekaligus REST API di `/api/*`.
- **AI** (`server/ai.js`) — satu fungsi `generateText(prompt)` yang menyembunyikan provider mana yang sebenarnya dipanggil.
- **Akun** (`server/auth.js`) — daftar, masuk, keluar. Kata sandi di-hash dengan scrypt + salt per akun; sesi berupa token acak di cookie `HttpOnly`, dan database hanya menyimpan hash SHA-256 dari token itu.
- **Streak bareng** (`server/circles.js`) — grup, kode undangan, dan perhitungan streak grup.
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
│   ├── ai.js       # abstraksi provider AI
│   └── db.js       # koneksi SQLite + skema tabel + migrasi
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
| GET | `/api/entries` | Ambil 2000 hari terbaru, masing-masing dengan array `notes` |
| GET | `/api/export.json` | Unduh cadangan lengkap (catatan, favorit, rangkuman harian) |
| POST | `/api/import` | Pulihkan cadangan `{entries:[...]}`. Tanggal yang sama ditimpa, tanggal lain dibiarkan |
| PUT | `/api/entries/:date` | Simpan/tambah catatan tanggal tsb (`{mood, prompt, text, notes, daySummary}`) |
| DELETE | `/api/entries/:date` | Hapus seluruh catatan tanggal tsb |
| GET | `/api/settings` | Ambil pengaturan pengingat + cache pengamatan/rangkuman |
| PUT | `/api/settings` | Perbarui sebagian pengaturan |
| GET | `/api/export.txt` | Unduh seluruh riwayat + rangkuman (kalau ada) sebagai teks polos |
| POST | `/api/insight` | Pengamatan pola mingguan dari 14 catatan terakhir (butuh AI provider terkonfigurasi) |
| POST | `/api/summary` | Rangkuman kegiatan `{range: 7\|30}` hari terakhir (butuh AI provider terkonfigurasi) |
| POST | `/api/entries/:date/day-summary` | Rangkuman satu hari itu saja (mode "Harian"), tersimpan di baris entri itu sendiri (butuh AI provider terkonfigurasi) |
| GET | `/healthz` | `{ok:true}` — untuk health check |

Satu hari kini bisa punya beberapa catatan terpisah (kolom `notes`, JSON array `{prompt, text, at, fav?}`; `fav` menandai favorit, dan tag tidak disimpan terpisah melainkan dibaca dari `#kata` di dalam `text`). Baris yang dibuat sebelum kolom ini ada tetap terbaca sebagai satu catatan, dari kolom `prompt`/`text` lama — tidak ada migrasi manual yang perlu dijalankan.

## Catatan jujur soal keterbatasan

- **Akun sederhana.** Ada daftar/masuk/keluar, tapi belum ada ganti kata sandi, lupa kata sandi, atau hapus akun dari antarmuka. Kalau lupa kata sandi, satu-satunya jalan saat ini adalah mengubah database langsung.
- **Pendaftaran terbuka secara default.** Siapa pun yang tahu alamat server bisa membuat akun (jurnal tiap akun tetap terpisah). Set `ALLOW_SIGNUP=false` setelah semua orang yang kamu ajak sudah mendaftar.
- **Pakai HTTPS kalau di-deploy.** Kata sandi dikirim saat masuk; tanpa HTTPS ia lewat jaringan tanpa enkripsi. Di balik reverse proxy HTTPS, cookie sesi otomatis diberi tanda `Secure`.
- **Streak bareng hanya antar akun di server yang sama.** Dua instalasi Azzifa yang terpisah tidak bisa saling terhubung.
- **Kunci AI dipakai bersama.** Semua akun memakai provider AI yang sama dari `.env`, jadi biayanya ditanggung pemilik server.
- **Input suara** pakai Web Speech API bawaan browser — tidak jalan di Firefox, dan tetap butuh koneksi internet meski datanya sendiri sudah lokal.
- **Pengingat** cuma aktif kalau tab browser terbuka (pakai Notification API bawaan browser). Bubble di dalam aplikasi tetap jadi jaring pengaman kalau notifikasi tidak didukung/ditolak.
- **Cara saya menguji ini**, karena sandbox saya tidak punya akses internet untuk `npm install`: saya jalankan JavaScript frontend-nya langsung di Node lewat DOM tiruan sambil mem-palsukan seluruh backend (`fetch` yang meniru setiap route), lalu simulasikan skenario pakai sungguhan — simpan beberapa catatan dalam satu hari, minta pengamatan AI, minta rangkuman, ganti provider AI, matikan koneksi ke server. Untuk lapisan database, saya ambil string SQL yang persis sama dari `db.js`/`index.js` dan jalankan langsung di SQLite asli (lewat Python) untuk membuktikan skema, upsert, dan migrasi kolom `notes` benar. Catatan itu berlaku untuk versi awal. Versi dengan akun, streak bareng, kalender, pencarian, tag, favorit, dan cadangan sudah dijalankan sungguhan (`npm install` + server asli + SQLite asli) dan diuji lewat Chrome headless: migrasi dari database satu-pengguna, isolasi jurnal antar akun, aturan streak grup, serta alur masuk dan ketiga tab di layar ponsel dan desktop. Yang **belum** diuji: fitur AI dengan kunci API sungguhan, input suara, notifikasi pengingat, dan deploy lewat Docker.
