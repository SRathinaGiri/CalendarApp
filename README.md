# Calendar App (Offline PWA)

A fully standalone, 100% offline Personal Calendar & Daily Organizer Progressive Web App (PWA) with client-side **SQLite (WASM)** and **IndexedDB** local storage.

---

## 🌟 Key Features

- **100% Offline & Private:** Runs entirely inside your browser. No web server, PHP, or external database required. All data remains exclusively on your device.
- **SQLite WASM Engine (`sql.js`):** Embedded relational database providing full ACID compliance, lightning-fast queries, and easy `.db` file exports.
- **IndexedDB Persistence (`SRGCalendarDB`):** Automatically saves every edit, schedule, note, and attachment into your browser's persistent storage.
- **1-Click Complete Backup & Restore (`.zip`):**
  - Export a complete timestamped `.zip` containing both your SQLite database and all uploaded ticket attachments (PDFs & images).
  - Restore anytime from a `.zip` archive on any device with automatic pre-restore safety snapshots.
- **Local Snapshots:** Save named snapshots in browser storage anytime.
- **Biometric & PIN Security:**
  - Native **Fingerprint & Face ID** biometric unlock on mobile and biometric-capable laptops via WebAuthn Platform Authenticator.
  - 4-digit master PIN lock fallback (Default PIN: `1234`).
- **PWA (Progressive Web App):**
  - Installable directly to home screen / desktop from Chrome, Edge, Safari, or Brave.
  - Native offline caching with Service Worker.
  - In-app install and check for updates buttons.
- **Comprehensive Calendar Views:**
  - **Calendar View:** 7-column month grid. In portrait mode, day cards automatically display compact icon indicators (schedules, travel, notes, finance) for clear readability. In landscape mode, full titles, times, and notes are shown.
  - **Portrait Month View:** 30-day tabular view with day notes, income/expense totals, and travel leg badges.
  - **Day View:** Hourly timeline, daily notes editor, and double-entry transaction manager.
  - **Agenda View:** Bi-directional timeline centered on Today, with one-tap jump to Today and load earlier/later buttons.
- **Travel Management & IRCTC PDF Ticket Parser:**
  - Schedule travel with onward/return legs, PNR, train/flight details, departure/arrival times (with overnight auto-calculation).
  - Attach e-tickets (PDF/Images) and automatically parse IRCTC PDF tickets client-side.
- **Statements & Accounting Reports:**
  - Free Days Report
  - Journal & Ledger Accounts
  - Schedules & Summary Reports
  - Travel Ticket Cost Statement
  - Ticket Reimbursement Claim Statement with embedded ticket copies and print-ready layout.

---

## 🚀 How to Run

### Method 1: Python Local Server (Easiest & Recommended)
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
If you have Node.js installed:
```bash
npx serve . -p 8080
```
Then visit [http://localhost:8080](http://localhost:8080).

---

### Method 3: GitHub Pages
The repository is published directly to GitHub Pages at:
[https://srathinagiri.github.io/CalendarApp/](https://srathinagiri.github.io/CalendarApp/)

---

## 📲 How to Install as a PWA (Desktop / Mobile)

1. Open the app in **Google Chrome**, **Microsoft Edge**, or **Brave** at `http://localhost:8080` or via GitHub Pages.
2. Look for the **Install App** icon in the address bar or tap **"Install / Update App"** in the app's side drawer.
3. Once installed, launch the app directly from your mobile home screen, Desktop, Taskbar, or Start Menu like a native app.

---

## 🔐 App Security Lock & Biometrics

- **Default PIN:** `1234`
- **Biometric Unlock:** On mobile devices (Android Fingerprint, iOS Touch ID / Face ID) and laptops with biometric sensors, the app supports instant biometric unlock.
- **Biometric Setup:** Click the lock icon or open the side drawer -> tap **"Biometric / Fingerprint Unlock"**.
- **Change PIN:** Open the side drawer -> tap **"Change Security PIN"**.

---

## 💾 Backup, Restore & Migrating Data Between Devices

All your data is stored in the browser's persistent IndexedDB database (`SRGCalendarDB`).

### 1. Complete Full Backup & Restore (`.zip`) — Recommended
- **To Backup:** Click the database icon in the top header -> Click **"💾 Export Full (.zip)"**. This generates a single archive containing your SQLite database and all uploaded ticket PDFs/images.
- **To Restore:** Click **"📁 Restore Full (.zip)"** -> Select your backup `.zip` file. All schedules, notes, and attachments will be restored immediately.

### 2. Database-Only Backup & Restore (`.db`)
- **To Backup:** Click **"📥 Download DB (.db)"** to download just the SQLite database file.
- **To Restore:** Click **"📤 Restore DB (.db)"** -> Select your `.db` file.

### 3. Attachments-Only Backup & Restore (`.zip`)
- **To Backup:** In the backup dialog, click **"📦 Backup Files (.zip)"**.
- **To Restore:** Click **"📥 Restore Files (.zip)"** -> Select your attachments `.zip` file.
