# SRG Calendar Pro (Local DB - Single Device PWA)

A fully standalone, 100% offline Personal Calendar & Daily Organizer Progressive Web App (PWA) with client-side **SQLite (WASM)** and **IndexedDB** local storage.

---

## 🌟 Key Features

- **100% Offline & Private:** Runs entirely inside your browser. No web server, PHP, or cloud database required. All data remains exclusively on your device.
- **SQLite WASM Engine (`sql.js`):** Embedded relational database providing full ACID compliance, lightning-fast queries, and easy `.db` file exports.
- **IndexedDB Persistence (`SRGCalendarDB`):** Automatically saves every edit, schedule, note, and attachment into your browser's persistent storage.
- **Local Snapshots & Backups:** 
  - Save named local snapshots directly in browser storage.
  - Export full SQLite `.db` database files to disk anytime with a single click.
  - Restore anytime from a `.db` file.
- **PWA (Progressive Web App):** Installable as a desktop or mobile application directly from Chrome, Edge, Safari, or Brave.
- **Comprehensive Calendar Tools:**
  - **Month Calendar View** with status dots and badges.
  - **Portrait 30-Day Table View** with day notes, income/expense totals, and travel leg badges.
  - **Day View** with hourly blocks, daily notes editor, and double-entry transaction manager.
  - **Agenda View** with multi-date selection and filtering.
- **Travel Management & IRCTC PDF Ticket Parser:**
  - Schedule travel with onward/return legs, PNR, train/flight details, departure/arrival times (with overnight auto-calculation).
  - Attach e-tickets (PDF/Images) and automatically parse IRCTC PDF tickets client-side.
- **Statements & Accounting Reports:**
  - Free Days Report
  - Journal & Ledger Accounts
  - Schedules & Summary Reports
  - Travel Ticket Cost Statement
  - Ticket Reimbursement Claim Statement with embedded ticket copies and print-ready layout.
- **App Security PIN:**
  - Lock/Unlock your calendar with a secure 4-digit PIN (Default PIN: `1234`).

---

## 🚀 How to Run

### Method 1: Python Local Server (Easiest & Recommended)
Modern browsers require HTTP/HTTPS to load WebAssembly (`.wasm`) files due to CORS security policies on `file://` URLs.

1. Open PowerShell or Terminal in this `localdb` folder:
   ```bash
   cd path/to/localdb
   ```
2. Run Python's built-in lightweight web server:
   ```bash
   python -m http.server 8080
   ```
3. Open your browser and navigate to:
   [http://localhost:8080](http://localhost:8080)

---

### Method 2: Node.js `npx serve` or `http-server`
If you have Node.js installed:
```bash
npx serve . -p 8080
```
Then visit [http://localhost:8080](http://localhost:8080).

---

### Method 3: VS Code / Cursor "Live Server" Extension
1. Open the `localdb` folder in VS Code or Cursor.
2. Right-click `index.html` and click **"Open with Live Server"**.

---

## 📲 How to Install as a PWA (Desktop / Mobile)

1. Open the app in **Google Chrome**, **Microsoft Edge**, or **Brave** at `http://localhost:8080`.
2. Look for the **Install App** icon in the browser address bar (top right) or open the browser menu (`⋮`) and select **"Install SRG Calendar Pro"**.
3. Once installed, launch the app directly from your Desktop, Taskbar, or Start Menu like a native desktop app.

---

## 🔐 Default Access PIN

- **Default PIN:** `1234`
- To change the PIN: Click on the shield/lock icon or gear menu -> **Change Security PIN**.

---

## 💾 Backup & Data Safety

- Your calendar data is stored in the browser's IndexedDB database named `SRGCalendarDB`.
- **Regular Backups:** Click **"Backup & Restore"** (database icon in the top header) and click **"Download SQLite File (.db)"** to keep a portable `.db` file on your PC or flash drive.
- **Restore:** In the same dialog, click **"Upload & Restore Database (.db)"** to restore your data on any device or new browser anytime.
