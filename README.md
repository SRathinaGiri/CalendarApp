# Calendar App (Offline PWA) v1.4.1

A standalone, local-first Personal Calendar & Daily Organizer Progressive Web App (PWA) powered by client-side **SQLite (WASM)** and **IndexedDB** local storage with **AES-256-GCM hardware-accelerated encryption at rest for both database and file attachments**.

> **Production PWA (v1.4.1)**  
> Fully client-side, local-first calendar with ACID SQLite storage, Web Crypto AES-256-GCM encryption at rest for database and attachments, OWASP-compliant 600,000-iteration PBKDF2 key derivation with versioned headers (`SRGE3` data-key envelope; `SRGE1`/`SRGE2` still readable), non-extractable in-memory runtime keys, dual-tier WebAuthn biometrics (Hardware PRF `SRGBIO1` & Platform User Verification `SRGBIO2` with mobile gesture tap-to-scan hero card and passkey autofill), virtual keyboard suppression on biometric lock screens, 5-minute inactivity auto-lock and progressive PIN attempt throttling, fail-closed persistence guarantees, strict Content Security Policy (CSP), safe Emergency Recovery Kit, forgot PIN reset loop, enforced 6+ character PIN/passphrase protection, SHA-256 corruption-verified backup archives, optional AES-256 encrypted backups, atomic single-transaction restore & re-encryption including the recovery vault, robust offline attachment encryption migration, and 100% offline capabilities.

---

## 🌟 Key Features

- **Local-First & Offline Architecture:** Calendar data and attachments are stored exclusively on your device in IndexedDB. All assets — SQLite WASM (`sql.js`), PDF.js and its worker, JSZip, pako, Font Awesome icons and the Plus Jakarta Sans font — are bundled locally, so the app makes **zero third-party network requests** and works 100% offline once installed or cached.
- **Accurate Money Totals:** Receipts, payments, ledgers and travel/claim totals are summed in integer paise (no floating-point drift) and displayed with Indian digit grouping (₹1,23,456.78).
- **Embedded SQLite WASM Engine (`sql.js`):** Embedded relational database providing SQL queries, atomic transaction guarantees on schedule saves, and direct `.db` file exports.
- **Hardware-Accelerated AES-256-GCM Database & Attachment Encryption at Rest:**
  - Transparently encrypts the SQLite database, all historical snapshots, and all ticket attachments stored in browser IndexedDB with authenticated **AES-256-GCM**.
  - **Envelope encryption (v1.4.1+):** a random 256-bit **data key** encrypts the database (`SRGE3` header), snapshots and attachments once and never changes. Your PIN (PBKDF2-SHA256, 600,000 iterations, own salt), the fingerprint token and the Emergency Recovery Key each only *wrap* that same data key, so changing the PIN rewrites a 48-byte wrapper and never re-encrypts your data. Older `SRGE1`/`SRGE2` PIN-derived data is upgraded automatically at the first PIN unlock (atomic, nothing deleted; items no key opens are reported).
  - Runtime master keys are imported strictly with `extractable: false` and kept in memory only—never written to `sessionStorage` or `localStorage`. Raw key bytes are zeroed out immediately after derivation.
  - Fail-closed storage guarantees: database, snapshot, and attachment persistence strictly refuse to write unencrypted data if a PIN has been configured.
  - Automatic Inactivity Lock: 5-minute idle auto-lock with progressive PIN throttling delays (3s, 10s, 30s) after consecutive failed attempts.
  - After every unlock a background **integrity check** confirms that each attachment referenced by a schedule opens with the data key, and warns (and logs to Diagnostics) if any does not.
  - The key envelope (`srg_key_envelope`) and recovery vault are stored in IndexedDB (localStorage holds only a cache) and are committed in the same transaction as the data during the upgrade.
  - Interactive first-time PIN setup prompts the user to choose their own Security PIN (no hardcoded defaults).
  - Secure **Fingerprint & Face ID** biometric unlock via WebAuthn Level 3 `prf` extension (hardware-backed key wrapping) with zero fallback to plaintext key storage.
  - Private Client-Side Architecture: data is encrypted exclusively inside your device browser and never sent to any server.
  - Automatic post-unlock migration automatically detects and upgrades any legacy plaintext attachments to AES-256-GCM encryption at rest.
- **Emergency Recovery Key (Zero-Disk Cryptographic Recovery Kit):**
  - High-entropy 20-character Emergency Recovery Key (`SRG-XXXX-XXXX-XXXX-XXXX`) generated during PIN setup (and once more when older data is upgraded). It stays valid across PIN changes.
  - Secure PBKDF2 (600,000 iterations) + AES-GCM recovery vault unwraps the data key if you forget your PIN.
  - Never stored on disk or in browser storage: shown only ephemerally on creation or explicit PIN verification. Download file names are generic (`CalendarApp-Recovery-Kit.txt`) to prevent key leakage in sync logs.
  - 1-click **"Email to Myself"** (`mailto:`) with security warning, **"Download (.txt)"**, and **"Copy"** options so you never lose access.
  - **"Forgot PIN / Passphrase?"** recovery loop on the lock screen sets a new PIN by re-wrapping the data key. Your data, fingerprint unlock and the recovery key itself are unchanged.
- **IndexedDB Persistence (`SRGCalendarDB`):** Automatically persists edits, schedules, daily notes, financial entries, and file attachments in browser storage.
- **Atomic 1-Click Complete Backup & Restore (`.zip`):**
  - **Full Export:** Creates an archive containing your SQLite database, an integrity manifest with per-file SHA-256 hashes for corruption detection, and deduplicated ticket attachments (PDFs & images). Supports optional **AES-256 PIN encryption** for both database and all attachments so exported archives are cryptographically protected against eavesdropping and tampering when stored on cloud drives (Google Drive, OneDrive, iCloud) or USB drives.
  - **Atomic Restore & Smart Re-Encryption:** Verifies SHA-256 file hashes to detect accidental archive corruption before committing changes. Automatically detects whether the backup archive or `.db` file is encrypted or unencrypted (old `SRGE1`/`SRGE2` backups stay restorable). Encrypted backups use a key derived from your PIN and the backup's own salt, so they restore with the PIN alone; on this device the restored data is re-encrypted under the data key. On a fresh device, the backup PIN becomes the device PIN and a new data key and recovery key are created. Pre-validates the archive and stages all attachments in memory before activating the new database. Automatically rolls back to the previous database if restoration fails.
- **Local Snapshots:** Save named encrypted database safety snapshots in browser storage anytime. Snapshots use the same data key, so PIN changes never touch them.
- **PWA (Progressive Web App):**
  - Installable directly to home screen or desktop from Chrome, Edge, Safari, or Brave.
  - Version-scoped Service Worker cache cleanup (`v1.4.1`).
  - In-app install and check for updates buttons.
- **Comprehensive Calendar Views:**
  - **Calendar View:** 7-column month grid. In portrait mode, uniform square day cells with center indicator badges and a bottom day schedule agenda panel maximize usability. Long-pressing any day initiates multi-date selection for batch scheduling with single-tap date addition/removal. In landscape mode, full titles, times, and notes are shown.
  - **Portrait Month View:** 30-day tabular view with day notes, income/expense totals, and travel leg badges.
  - **Day View:** Hourly timeline, daily notes editor, and double-entry transaction manager.
  - **Agenda View:** Bi-directional timeline centered on Today, with one-tap jump to Today and load earlier/later navigation.
- **Travel Management & IRCTC PDF Ticket Parser:**
  - Schedule travel with onward/return legs, PNR, train/flight details, and overnight arrival calculation.
  - Attach e-tickets (PDF/Images) and parse IRCTC PDF tickets client-side using bundled offline PDF.js.
- **Print / PDF Monthly Calendar Export:**
  - 1-click export of the active month to clean, formatted PDF or paper printer.
  - Supports **Landscape 7-Column Wall Calendar Grid** and **Portrait 30-Day Detailed Diary Table**.
  - Accessible via top toolbar printer icon, side menu drawer, or Statements & Reports module.
- **Chart of Accounts & Double-Entry Vouchers:**
  - Standardized chart of accounts with account types (Asset, Liability, Equity / Capital, Revenue, Expenditure); accounts already used in past entries are imported automatically for classification.
  - Rename accounts or merge duplicates (e.g. "SBI" into "SBI Bank"); every existing entry is updated atomically.
  - Four voucher types: Receipt, Payment, Contra (cash ↔ bank) and Journal (non-cash adjustment). Only receipts and payments count toward cash-flow totals.
- **Statements & Accounting Reports:**
  - Free Days Report
  - Journal & Ledger Accounts (ledger balances shown as Dr / Cr, with opening balance b/f)
  - Trial Balance and Balance Sheet as on any date; Income Statement for any From–To period. The books are continuous (no financial-year closing): the Balance Sheet carries revenue less expenditure to date into Equity as an accumulated surplus.
  - Schedules & Summary Reports
  - Travel Ticket Cost Statement
  - Ticket Reimbursement Claim Statement with embedded ticket copies and print-ready layout.

---

## 🚀 How to Run

### Method 1: Python Local Server (Recommended for local dev)
Modern browsers require HTTP/HTTPS to load WebAssembly (`.wasm`) files due to browser security policies on `file://` URLs.

1. Open PowerShell or Terminal in the project folder:
   ```bash
   cd CalendarApp
   ```
2. Run Python's built-in web server:
   ```bash
   python -m http.server 8080
   ```
3. Open your browser and navigate to:
   [http://localhost:8080](http://localhost:8080)

---

### Method 2: Node.js `npx serve`
```bash
npx serve . -p 8080
```
Then visit [http://localhost:8080](http://localhost:8080).

---

### Method 3: GitHub Pages
The web app is deployed directly at:
[https://srathinagiri.github.io/CalendarApp/](https://srathinagiri.github.io/CalendarApp/)

---

## 📲 How to Install as a PWA (Desktop / Mobile)

1. Open the app in **Google Chrome**, **Microsoft Edge**, **Safari**, or **Brave** at `http://localhost:8080` or via GitHub Pages.
2. Look for the **Install App** icon in the address bar or tap **"Install / Update App"** in the app's side drawer.
3. Once installed, launch the app directly from your mobile home screen, Desktop, Taskbar, or Start Menu like a native app.

---

## 🔐 App Security & Privacy

- **Hardware-Accelerated AES-256-GCM Encryption:** All SQLite database records, daily notes, transactions, snapshots, and file attachments stored in browser IndexedDB are encrypted at rest using AES-256-GCM via the browser's native Web Crypto API.
- **Fail-Closed Persistence:** The app strictly refuses to write unencrypted database files, snapshots, or attachments if a Security PIN has been configured.
- **OWASP-Compliant PBKDF2 Key Derivation:** PIN derivation uses 600,000 iterations of PBKDF2-HMAC-SHA256 with unique 16-byte random salts. Headers are versioned (`SRGE2`), maintaining backward compatibility with `SRGE1` (100,000 iterations).
- **Strict In-Memory Non-Extractable Keys:** Master keys are imported with `extractable: false` and kept in volatile JavaScript memory only. The app completely purges `srg_session_key` from `sessionStorage`. Ephemeral raw master keys used during setup/reset are explicitly zeroed out in memory immediately after vault generation.
- **Hardware-Bound Biometrics (WebAuthn PRF):** Biometric unlock leverages the WebAuthn Level 3 HMAC-secret / PRF (`pseudo-random function`) extension to cryptographically wrap the master key with authenticator-derived entropy. No plaintext master keys are ever cached in browser session or local storage.
- **Inactivity Auto-Lock & Attempt Throttling:** 5-minute idle auto-lock engages on user inactivity or tab switching. PIN verification enforces progressive delays (3s, 10s, 30s) after consecutive failed attempts to thwart automated brute-force attacks.
- **Emergency Recovery Kit & Forgot PIN Loop:** Generate a 20-character cryptographic recovery key during PIN setup. Email it to yourself via `mailto:` with explicit security warning, download it as a generic text file (`CalendarApp-Recovery-Kit.txt`), or copy it. The recovery key is never stored on disk or in browser storage. If you forget your PIN, tap "Forgot PIN / Passphrase?" to unwrap the vault and set a new PIN without data loss.
- **Change PIN without re-encryption:** Open the side drawer -> tap **"Change Security PIN"**. Only the PIN wrapper of the data key is replaced; the database, snapshots, attachments, fingerprint link and recovery key are untouched.
- **Private Client-Side Encryption:** Your PIN, database, and attachments are encrypted strictly inside your browser. No data or keys are ever transmitted to any external server.
- **Strict Content Security Policy (CSP):** Enforced via meta tags with `'wasm-unsafe-eval'` scoped exclusively to WebAssembly runtime execution without allowing arbitrary JavaScript `eval()`. PDF.js runs with `isEvalSupported: false`.

---

## 💾 Backup, Restore & Data Migration

Because Calendar App is a single-device, local-first application, all your data lives inside your device's browser profile. **Always keep recent full backups!**

### 1. Complete Full Backup & Restore (`.zip`) — Recommended
- **Corruption Detection vs Encrypted Backups:** Full backup exports compute per-file SHA-256 hashes in `manifest.json` to detect accidental file corruption or truncation during transfer. For storage on cloud drives (Google Drive, OneDrive, iCloud) or shared USB drives where secrecy and tamper-proof security against adversaries are required, enable **"Encrypt Backup with PIN"** to authenticate and encrypt both the database and all attachments with AES-256-GCM.
- **To Backup:** Click the database icon in the top header -> Click **"💾 Export Full (.zip)"**. This generates an integrity-hashed `.zip` containing your SQLite database and all uploaded ticket PDFs/images.
- **To Restore:** Click **"📁 Restore Full (.zip)"** -> Select your backup `.zip` file. Staged atomically with pre-restore fallback rollback.

### 2. Database-Only Backup & Restore (`.db`)
- **To Backup:** Click **"📥 Download DB (.db)"** to download just the SQLite database file.
- **To Restore:** Click **"📤 Restore DB (.db)"** -> Select your `.db` file.

### 3. Attachments-Only Backup & Restore (`.zip`)
- **To Backup:** In the backup dialog, click **"📦 Backup Files (.zip)"**.
- **To Restore:** Click **"📥 Restore Files (.zip)"** -> Select your attachments `.zip` file.

---

## 🕵️ Privacy

- No accounts, no analytics, no telemetry, no ads, no cookies.
- The app never sends your calendar, notes, transactions or attachments anywhere. The only outbound actions are ones you trigger yourself (e.g. the optional *Email to Myself* recovery link opens your own mail client).
- You can confirm this: open DevTools → **Network** while using the app — every request is to the app's own origin.

## ⚠️ Disclaimer & Limitations

- The **daily finance / receipts & payments** module is a personal record-keeping aid. It is **not** accounting, bookkeeping or tax software, and its reports are not intended to be filed with or certified to any authority. Verify figures independently before relying on them.
- The travel **reimbursement claim statement** is a convenience printout; check it against your actual tickets and your organisation's rules.
- Data lives only in this browser profile. Clearing site data, uninstalling the browser or losing the device deletes it — keep regular full backups.
- If you forget your PIN **and** lose the recovery key, your data cannot be recovered. There is no server-side reset.
- See [SECURITY.md](SECURITY.md) for the full threat model and how to report a vulnerability.

---

## 🧰 Project Structure

| Path | Purpose |
|---|---|
| `index.html` | App shell, markup and Content Security Policy |
| `app.js` | All application logic (database, encryption, views, reports) |
| `styles.css` | Styles (dark/light themes, print layouts) |
| `sw.js` | Service worker — offline cache (`CACHE_NAME` must be bumped on every release) |
| `manifest.json`, `icon-*.png` | PWA manifest and icons |
| `taxonomy_seed.js` | Default tag categories/tags for a fresh database (generic, no personal data) |
| `sql-wasm.*`, `pdf*.js`, `jszip.min.js`, `pako.min.js`, `vendor/` | Bundled third-party libraries, fonts and icons — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |

There is no build step: edit the files and reload. When releasing, update `APP_VERSION` in `app.js`, the version badges in `index.html`, `CACHE_NAME` in `sw.js`, and [CHANGELOG.md](CHANGELOG.md).

## 🤝 Contributing

Issues and pull requests are welcome. Please:
- Never include real personal data (names, schedules, PNRs, amounts, PAN/Aadhaar, bank details) in issues, screenshots or test files — use obviously synthetic data.
- Keep the app dependency-free at runtime: no CDN links, no external `fetch()`; bundle any new library locally and add it to `THIRD_PARTY_NOTICES.md` and `sw.js`.
- Report security issues privately as described in [SECURITY.md](SECURITY.md).

---

## 📄 License

This project is licensed under the [MIT License](LICENSE) - see the [LICENSE](LICENSE) file for details. Bundled third-party components retain their own licences — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
