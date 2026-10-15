# Calendar App (Offline PWA) v1.2.2

A standalone, local-first Personal Calendar & Daily Organizer Progressive Web App (PWA) powered by client-side **SQLite (WASM)** and **IndexedDB** local storage with **AES-256-GCM hardware-accelerated encryption at rest for both database and file attachments**.

> **Production PWA (v1.2.2)**  
> Fully client-side, local-first calendar with ACID SQLite storage, Web Crypto AES-256-GCM encryption at rest for database and attachments, Emergency Recovery Key kit with 1-click email/download options, forgot PIN reset loop, enforced 6+ character PIN/passphrase protection, SHA-256 verified backup archives, smart restore re-encryption, wrapped biometric unlock, and 100% offline capabilities.

---

## 🌟 Key Features

- **Local-First & Offline Architecture:** Calendar data and attachments are stored exclusively on your device in IndexedDB. All assets including SQLite WASM (`sql.js`), PDF.js, and workers are bundled locally so core features work 100% offline once installed or cached.
- **Embedded SQLite WASM Engine (`sql.js`):** Embedded relational database providing SQL queries, atomic transaction guarantees on schedule saves, and direct `.db` file exports.
- **Hardware-Accelerated AES-256-GCM Database & Attachment Encryption at Rest:**
  - Transparently encrypts the SQLite database, all historical snapshots, and all ticket attachments stored in browser IndexedDB with authenticated **AES-256-GCM**.
  - Keys derived via **PBKDF2** (100,000 iterations, SHA-256) with cryptographic salts from the user's private PIN / Passphrase (minimum 6 characters, up to 64 characters).
  - Interactive first-time PIN setup prompts the user to choose their own Security PIN (no hardcoded defaults).
  - Secure **Fingerprint & Face ID** biometric quick-unlock via WebAuthn platform authenticators with wrapped key protection.
  - Zero-knowledge architecture: data is encrypted exclusively inside your device browser and never sent to any server.
- **Emergency Recovery Key (Cryptographic Recovery Kit):**
  - High-entropy 20-character Emergency Recovery Key (`SRG-XXXX-XXXX-XXXX-XXXX`) generated during PIN setup and PIN changes.
  - Secure PBKDF2 (100,000 iterations) + AES-GCM recovery vault unlocks and unwraps the master key if you forget your PIN.
  - 1-click **"Email to Myself"** (`mailto:`), **"Download (.txt)"**, and **"Copy"** options so you never lose access.
  - **"Forgot PIN / Passphrase?"** recovery loop on the lock screen resets your PIN, restores your calendar, and re-encrypts all database records, snapshots, and attachments with your new key.
- **IndexedDB Persistence (`SRGCalendarDB`):** Automatically persists edits, schedules, daily notes, financial entries, and file attachments in browser storage.
- **Atomic 1-Click Complete Backup & Restore (`.zip`):**
  - **Full Export:** Creates an archive containing your SQLite database, an integrity manifest with per-file SHA-256 hashes, and deduplicated ticket attachments (PDFs & images). Supports optional **AES-256 PIN encryption** for both database and all attachments so exported archives can be safely stored on cloud drives (Google Drive, OneDrive, iCloud) or USB drives.
  - **Atomic Restore & Smart Re-Encryption:** Verifies SHA-256 file hashes before committing changes. Automatically detects whether the backup archive or `.db` file is encrypted or unencrypted. When restoring on a device with an existing PIN, decrypts using the backup PIN and immediately re-encrypts using this device's current PIN so keys and tokens stay in sync. Pre-validates the archive and stages all attachments in memory before activating the new database. Automatically rolls back to the previous database if restoration fails.
- **Local Snapshots:** Save named encrypted database safety snapshots in browser storage anytime. When changing PIN, all past snapshots and attachments are atomically re-encrypted under the new key.
- **PWA (Progressive Web App):**
  - Installable directly to home screen or desktop from Chrome, Edge, Safari, or Brave.
  - Version-scoped Service Worker cache cleanup (`v1.2.2`).
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
- **Event Reminders & Local Notifications:**
  - Integrated Web Notification API alerts with dynamic countdown display and synthetic offline Web Audio chime.
  - Customizable alert timing per schedule (15 min, 30 min, 1 hour, 2 hours, or exact start time; default 30 min for travel).
  - *Note:* Reminders trigger reliably while the app or browser tab is active or backgrounded. When the browser is closed, delivery depends on OS background policies.
- **Statements & Accounting Reports:**
  - Free Days Report
  - Journal & Ledger Accounts
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
- **User-Defined Security PIN / Passphrase:** First launch prompts you to create a private PIN or Passphrase (minimum 6 characters, up to 64 characters). Keys are derived via PBKDF2 (100,000 iterations, SHA-256) with unique cryptographic salts.
- **Hardened Biometric Unlock:** Secure Fingerprint and Face ID quick-unlock via WebAuthn platform authenticators during active browser sessions without exposing or storing raw master keys on disk.
- **Emergency Recovery Kit & Forgot PIN Loop:** Generate a 20-character cryptographic recovery key during PIN setup. Email it to yourself via `mailto:`, download it as a `.txt` file, or copy it. If you forget your PIN, tap "Forgot PIN / Passphrase?" to unlock and re-encrypt the vault without data loss.
- **Atomic Change PIN:** Open the side drawer -> tap **"Change Security PIN"** to derive a new key with a fresh salt, re-encrypt the active database, re-encrypt all historical snapshots, and re-encrypt all stored attachments atomically.
- **Zero-Knowledge Privacy:** Your PIN, database, and attachments are encrypted strictly inside your browser. No data or keys are ever transmitted to any external server.

---

## 💾 Backup, Restore & Data Migration

Because Calendar App is a single-device, local-first application, all your data lives inside your device's browser profile. **Always keep recent full backups!**

### 1. Complete Full Backup & Restore (`.zip`) — Recommended
- **To Backup:** Click the database icon in the top header -> Click **"💾 Export Full (.zip)"**. This generates an integrity-hashed `.zip` containing your SQLite database and all uploaded ticket PDFs/images.
- **To Restore:** Click **"📁 Restore Full (.zip)"** -> Select your backup `.zip` file. Staged atomically with pre-restore fallback rollback.

### 2. Database-Only Backup & Restore (`.db`)
- **To Backup:** Click **"📥 Download DB (.db)"** to download just the SQLite database file.
- **To Restore:** Click **"📤 Restore DB (.db)"** -> Select your `.db` file.

### 3. Attachments-Only Backup & Restore (`.zip`)
- **To Backup:** In the backup dialog, click **"📦 Backup Files (.zip)"**.
- **To Restore:** Click **"📥 Restore Files (.zip)"** -> Select your attachments `.zip` file.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE) - see the [LICENSE](LICENSE) file for details.
