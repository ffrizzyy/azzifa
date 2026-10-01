# Azzifa

Jurnal harian dengan mood tracker (beberapa catatan per hari), dashboard tren mood, pengamatan pola AI mingguan, dan rangkuman kegiatan AI — versi standalone yang bisa dijalankan sendiri atau di-deploy ke server mana pun.

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
- **Database** (`server/db.js`) — SQLite lewat `better-sqlite3`, satu file di `data/azzifa.sqlite`. Skema di-migrasi otomatis kalau kolom baru belum ada (lihat catatan `notes` di bawah).

```
azzifa-app/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── .env.example
├── server/
│   ├── index.js    # Express app + semua route API
│   ├── ai.js       # abstraksi provider AI
│   └── db.js       # koneksi SQLite + skema tabel
├── public/
│   └── index.html  # seluruh frontend
└── data/           # dibuat otomatis, isi: azzifa.sqlite (jangan di-commit)
```

## API

| Method | Path | Fungsi |
|---|---|---|
| GET | `/api/entries` | Ambil 400 catatan terbaru, masing-masing dengan array `notes` |
| PUT | `/api/entries/:date` | Simpan/tambah catatan tanggal tsb (`{mood, prompt, text, notes, daySummary}`) |
| DELETE | `/api/entries/:date` | Hapus seluruh catatan tanggal tsb |
| GET | `/api/settings` | Ambil pengaturan pengingat + cache pengamatan/rangkuman |
| PUT | `/api/settings` | Perbarui sebagian pengaturan |
| GET | `/api/export.txt` | Unduh seluruh riwayat + rangkuman (kalau ada) sebagai teks polos |
| POST | `/api/insight` | Pengamatan pola mingguan dari 14 catatan terakhir (butuh AI provider terkonfigurasi) |
| POST | `/api/summary` | Rangkuman kegiatan `{range: 7\|30}` hari terakhir (butuh AI provider terkonfigurasi) |
| POST | `/api/entries/:date/day-summary` | Rangkuman satu hari itu saja (mode "Harian"), tersimpan di baris entri itu sendiri (butuh AI provider terkonfigurasi) |
| GET | `/healthz` | `{ok:true}` — untuk health check |

Satu hari kini bisa punya beberapa catatan terpisah (kolom `notes`, JSON array `{prompt, text, at}`). Baris yang dibuat sebelum kolom ini ada tetap terbaca sebagai satu catatan, dari kolom `prompt`/`text` lama — tidak ada migrasi manual yang perlu dijalankan.

## Catatan jujur soal keterbatasan

- **Single-user, tanpa login.** Semua data di satu file SQLite, cocok dipakai sendiri di satu server. Belum ada sistem akun — kalau butuh multi-pengguna, itu pekerjaan tambahan, bukan cuma nyalain fitur.
- **Input suara** pakai Web Speech API bawaan browser — tidak jalan di Firefox, dan tetap butuh koneksi internet meski datanya sendiri sudah lokal.
- **Pengingat** cuma aktif kalau tab browser terbuka (pakai Notification API bawaan browser). Bubble di dalam aplikasi tetap jadi jaring pengaman kalau notifikasi tidak didukung/ditolak.
- **Cara saya menguji ini**, karena sandbox saya tidak punya akses internet untuk `npm install`: saya jalankan JavaScript frontend-nya langsung di Node lewat DOM tiruan sambil mem-palsukan seluruh backend (`fetch` yang meniru setiap route), lalu simulasikan skenario pakai sungguhan — simpan beberapa catatan dalam satu hari, minta pengamatan AI, minta rangkuman, ganti provider AI, matikan koneksi ke server. Untuk lapisan database, saya ambil string SQL yang persis sama dari `db.js`/`index.js` dan jalankan langsung di SQLite asli (lewat Python) untuk membuktikan skema, upsert, dan migrasi kolom `notes` benar. Yang **belum** saya coba: menjalankan `npm install` sungguhan (perlu mengunduh `better-sqlite3`) dan mengetes lewat browser asli. Jalankan `npm install && npm start` begitu diekstrak, dan kabari kalau ada error saat startup.
