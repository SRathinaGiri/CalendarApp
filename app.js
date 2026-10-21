/**
 * SRG Calendar Pro - Core Application Logic
 * Offline-first PWA with Client-Side SQLite (WASM) & Google Drive Cloud Sync
 */

// localStorage on srathinagiri.github.io is one 5 MB area shared by every app on that origin, so it can be
// full for reasons outside this app. A failed write must never stop start-up: log it, warn once, carry on.
// (Everything essential lives in IndexedDB; localStorage only holds small caches and preferences.)
let storageFullWarned = false;
function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn(`localStorage write skipped for "${key}":`, e && e.name);
    if (!storageFullWarned && e && e.name === 'QuotaExceededError') {
      storageFullWarned = true;
      const warn = () => { if (typeof showToast === 'function') showToast('⚠ Browser storage for this website is full (it is shared with your other apps on the same address). The calendar keeps working, but please free space in those apps.', 'warning', 9000); };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(warn, 1500)); else warn();
    }
    return false;
  }
}

// Global State
let SQL = null;
let db = null;
let currentDate = new Date(); // Viewing month
let currentView = localStorage.getItem('srg_current_view') || 'calendar'; // 'calendar' | 'month' | 'day' | 'agenda'
let tagMasterCategories = [];
let tagMasterTags = [];
let tagMasterFields = [];
let selectedDates = new Set(); // Multi-date selection set
let portraitSelectedDate = null; // Currently highlighted day in portrait calendar mode

// App Theme, Security Lock, and Read-Only State
let currentTheme = localStorage.getItem('srg_theme') || 'dark';
let isReadOnly = false;
let isAppUnlocked = false;

// Current attachments for modal (array of { name, type, data: base64 })
let currentModalAttachments = [];

// Sync Provider Choice: 'local' (Pure Single-Device Offline PWA)
let syncProvider = 'local';
lsSet('srg_sync_provider', 'local');
let serverApiUrl = '';
let serverApiKey = '';

// English day of week mappings
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* ==========================================================================
   0. TOAST NOTIFICATION SYSTEM & UTILITIES
   ========================================================================== */
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const fetchOptions = {
      credentials: 'include',
      ...options,
      signal: controller.signal
    };
    if (serverApiKey && !fetchOptions.headers?.['X-API-Key']) {
      fetchOptions.headers = { ...(fetchOptions.headers || {}), 'X-API-Key': serverApiKey };
    }
    const response = await fetch(url, fetchOptions);
    return response;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(id);
  }
}

function showToast(message, type = 'info', duration = 3500) {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const iconEl = document.createElement('i');
  if (type === 'success') iconEl.className = 'fa-solid fa-circle-check';
  else if (type === 'error' || type === 'warning') iconEl.className = 'fa-solid fa-triangle-exclamation';
  else if (type === 'loading') iconEl.className = 'fa-solid fa-spinner fa-spin';
  else iconEl.className = 'fa-solid fa-circle-info';

  const textEl = document.createElement('span');
  textEl.textContent = String(message || '');

  toast.appendChild(iconEl);
  toast.appendChild(textEl);
  container.appendChild(toast);

  if (type !== 'loading' && duration > 0) {
    setTimeout(() => {
      dismissToast(toast);
    }, duration);
  } else if (type === 'loading') {
    // Safety auto-dismiss for loading toasts if not explicitly dismissed within safety limit (default 8 seconds)
    const safetyMs = duration > 0 ? duration : 8000;
    toast._safetyTimer = setTimeout(() => {
      dismissToast(toast);
    }, safetyMs);
  }

  return toast;
}

function dismissToast(toastEl) {
  if (toastEl) {
    if (toastEl._safetyTimer) clearTimeout(toastEl._safetyTimer);
    if (toastEl.parentNode) {
      toastEl.classList.add('toast-hide');
      setTimeout(() => {
        if (toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
      }, 300);
    }
  }
}

// Register Service Worker for Offline PWA & Lifecycle Management
const APP_VERSION = 'v1.4.0';
let deferredInstallPrompt = null;
let swRegistration = null;
let updateWaiting = false;

// Listen for PWA installation prompt
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  updateInstallButtonState();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  updateInstallButtonState();
  showToast('Calendar App installed successfully!', 'success');
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(`sw.js?v=${APP_VERSION}`).then((reg) => {
    swRegistration = reg;
    console.log('Calendar App SW Registered');

    // If an updated worker is already waiting
    if (reg.waiting) {
      updateWaiting = true;
      updateInstallButtonState();
    }

    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if (newWorker) {
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            updateWaiting = true;
            updateInstallButtonState();
            showToast('A new update for Calendar App is ready! Click "Update App" to apply.', 'info', 6000);
          }
        });
      }
    });

    // Check for updates on load
    reg.update().catch(() => {});
  }).catch(err => console.log('SW registration error:', err));

  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshing) {
      refreshing = true;
      window.location.reload();
    }
  });
}

function updateInstallButtonState() {
  const headerBtn = document.getElementById('headerInstallUpdateBtn');
  const drawerBtn = document.getElementById('drawerInstallUpdateBtn');
  const drawerTitle = document.getElementById('drawerInstallUpdateTitle');
  const drawerDesc = document.getElementById('drawerInstallUpdateDesc');
  const drawerBadge = document.getElementById('drawerInstallUpdateBadge');
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  if (updateWaiting) {
    if (headerBtn) {
      headerBtn.classList.remove('hidden');
      headerBtn.className = 'btn-update-pill btn-update-active';
      headerBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate fa-spin"></i> <span class="btn-label">Update App</span>';
      headerBtn.title = 'New version available - Click to apply update now';
    }
    if (drawerTitle) drawerTitle.textContent = 'Update Calendar App';
    if (drawerDesc) drawerDesc.textContent = 'New version ready - Click to apply update';
    if (drawerBadge) {
      drawerBadge.textContent = 'Update Ready';
      drawerBadge.className = 'drawer-badge badge-warning';
    }
  } else if (deferredInstallPrompt) {
    if (headerBtn) {
      headerBtn.classList.remove('hidden');
      headerBtn.className = 'btn-update-pill btn-install-ready';
      headerBtn.innerHTML = '<i class="fa-solid fa-download"></i> <span class="btn-label">Install</span>';
      headerBtn.title = 'Install Calendar App on your device';
    }
    if (drawerTitle) drawerTitle.textContent = 'Install Calendar App';
    if (drawerDesc) drawerDesc.textContent = 'Install as standalone mobile/desktop app';
    if (drawerBadge) {
      drawerBadge.textContent = 'Install';
      drawerBadge.className = 'drawer-badge badge-info';
    }
  } else {
    if (headerBtn) {
      headerBtn.classList.add('hidden');
    }
    if (drawerTitle) drawerTitle.textContent = isStandalone ? 'Check for Updates' : 'Install / Update App';
    if (drawerDesc) drawerDesc.textContent = isStandalone ? `Version ${APP_VERSION} (Installed)` : 'Add to Home Screen or update';
    if (drawerBadge) {
      drawerBadge.textContent = APP_VERSION;
      drawerBadge.className = 'drawer-badge';
    }
  }
}

async function handleInstallOrUpdateClick() {
  if (updateWaiting && swRegistration && swRegistration.waiting) {
    showToast('Applying update and refreshing Calendar App...', 'info', 2000);
    swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
    return;
  }

  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
      showToast('Installing Calendar App...', 'success', 3000);
    }
    deferredInstallPrompt = null;
    updateInstallButtonState();
    return;
  }

  // Active check for updates directly from network bypassing cache
  showToast('Checking for Calendar App updates...', 'info', 2500);
  try {
    const res = await fetch(`./sw.js?_check=${Date.now()}`, { cache: 'no-store' });
    if (res.ok) {
      const text = await res.text();
      const match = text.match(/calendar-app-(v[\d.]+)/);
      const remoteVersion = match ? match[1] : null;

      if (remoteVersion && remoteVersion !== APP_VERSION) {
        showToast(`New version ${remoteVersion} found! Updating now...`, 'info', 2000);
        if ('caches' in window) {
          const names = await caches.keys();
          await Promise.all(names.map(name => caches.delete(name)));
        }
        if (swRegistration) {
          try { await swRegistration.update(); } catch(e) {}
        }
        setTimeout(() => {
          window.location.reload(true);
        }, 600);
        return;
      }
    }
    if (swRegistration) {
      await swRegistration.update();
    }
    showToast(`Calendar App is up to date (${APP_VERSION})`, 'success', 3000);
  } catch (err) {
    showToast(`Calendar App is running ${APP_VERSION}`, 'info', 3000);
  }
}

// Automatic cache cleanup on version update (purges all legacy/outdated caches)
if (localStorage.getItem('srg_installed_version') !== APP_VERSION) {
  lsSet('srg_installed_version', APP_VERSION);
  if ('caches' in window) {
    caches.keys().then(names => {
      names.forEach(name => {
        if (name !== `calendar-app-${APP_VERSION}`) {
          caches.delete(name);
        }
      });
    });
  }
}

// Initialization on DOM Loaded
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const vBadge = document.getElementById('appVersionBadge');
    if (vBadge) vBadge.textContent = APP_VERSION;
    initAppTheme();
    setupUIEventListeners(); // Set up all UI event listeners FIRST so form submission and clicks always work
    initAutoLockListeners();
    updateInstallButtonState();

    try {
      purgeLegacySessionAndDiskTokens();
      await purgeLegacyBiometricDiskTokens();
    } catch(e) {
      console.warn('Storage purge notice:', e);
    }

    await initSqliteDatabase();
    await checkAppSecurityLock();

    if (isAppUnlocked && db) {
      loadMasterDataFromDb();
      populateTitlesDatalist();
      switchToView(currentView, currentDate);
    }

    // Re-render calendar view on orientation / window resize change between portrait & landscape
    const mql = window.matchMedia('(orientation: portrait), (max-width: 600px)');
    if (mql && mql.addEventListener) {
      mql.addEventListener('change', () => {
        if (currentView === 'calendar') {
          renderMonthView();
        }
      });
    }
  } catch (err) {
    console.error('Fatal initialization error:', err);
  }
});

/* ==========================================================================
   1. SQLITE & WASM PERSISTENCE (PURE LOCAL SINGLE-DEVICE)
   ========================================================================== */

let cachedEncryptedDbBytes = null;

async function initSqliteDatabase() {
  updateBadge('Initializing DB...');
  try {
    // Local WASM only: a CDN fallback would leak usage to a third party and break the offline promise.
    SQL = await initSqlJs({
      locateFile: file => file
    });

    cachedEncryptedDbBytes = await loadDbFromIndexedDB();
    await loadKeyEnvelope();
    updateBadge('Engine Ready');
    return true;
  } catch (err) {
    console.error('Failed to init SQLite WASM:', err);
    updateBadge('DB Error');
    alert('Error initializing SQLite WASM database: ' + err.message);
    return false;
  }
}

async function initializeFreshOrBundledDatabase() {
  let loadedFromBundle = false;
  try {
    const resp = await fetch('SRG_Calendar.db');
    if (resp.ok) {
      const buf = await resp.arrayBuffer();
      if (buf && buf.byteLength > 0 && isValidSqliteBinary(buf)) {
        db = new SQL.Database(new Uint8Array(buf));
        ensureSchemaUpToDate();
        loadedFromBundle = true;
        console.log('Initialized database from bundled SRG_Calendar.db');
      }
    }
  } catch (e) {
    console.warn('Could not fetch bundled SRG_Calendar.db:', e);
  }
  if (!loadedFromBundle) {
    await initDbFromSeedJson();
  }
}

function ensureSchemaUpToDate() {
  if (!db) return;
  try {
    // Ensure all core SQLite tables exist
    db.run(`
      CREATE TABLE IF NOT EXISTS tag_categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        color TEXT,
        icon TEXT,
        sort_order INTEGER
      );
      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY,
        category_id TEXT,
        name TEXT NOT NULL,
        sort_order INTEGER,
        FOREIGN KEY(category_id) REFERENCES tag_categories(id)
      );
      CREATE TABLE IF NOT EXISTS tag_field_definitions (
        id TEXT PRIMARY KEY,
        tag_id TEXT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        options TEXT,
        is_required INTEGER DEFAULT 0,
        sort_order INTEGER,
        FOREIGN KEY(tag_id) REFERENCES tags(id)
      );
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        group_id TEXT,
        schedule_date TEXT NOT NULL,
        from_time TEXT NOT NULL,
        to_time TEXT NOT NULL,
        delivery_mode TEXT DEFAULT 'offline',
        location TEXT,
        title TEXT NOT NULL,
        notes TEXT,
        attachments TEXT,
        travel_info TEXT,
        reminder_min INTEGER DEFAULT 15,
        status TEXT DEFAULT 'confirmed',
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS schedule_tags (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        tag_id TEXT NOT NULL,
        field_values TEXT,
        notes TEXT,
        FOREIGN KEY(schedule_id) REFERENCES schedules(id),
        FOREIGN KEY(tag_id) REFERENCES tags(id)
      );
      CREATE TABLE IF NOT EXISTS app_metadata (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS daily_notes (
        note_date TEXT PRIMARY KEY,
        content TEXT,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS daily_transactions (
        id TEXT PRIMARY KEY,
        txn_date TEXT NOT NULL,
        type TEXT NOT NULL,
        debit_account TEXT,
        credit_account TEXT,
        amount REAL NOT NULL,
        description TEXT,
        created_at TEXT,
        updated_at TEXT
      );
    `);

    const tableInfo = db.exec("PRAGMA table_info(schedules)");
    const colNames = tableInfo.length > 0 ? tableInfo[0].values.map(v => v[1]) : [];
    
    // Add group_id if missing
    if (!colNames.includes('group_id')) {
      db.run("ALTER TABLE schedules ADD COLUMN group_id TEXT");
    }
    // Add attachments if missing
    if (!colNames.includes('attachments')) {
      db.run("ALTER TABLE schedules ADD COLUMN attachments TEXT");
    }
    // Add travel_info if missing
    if (!colNames.includes('travel_info')) {
      db.run("ALTER TABLE schedules ADD COLUMN travel_info TEXT");
    }
    // Add reminder_min if missing
    if (!colNames.includes('reminder_min')) {
      try { db.run("ALTER TABLE schedules ADD COLUMN reminder_min INTEGER DEFAULT 15"); } catch(e) {}
    }

    // Safe schema migrations for tags, categories, and field definitions
    try { db.run("ALTER TABLE tags ADD COLUMN sort_order INTEGER;"); } catch(e) {}
    try { db.run("ALTER TABLE tags ADD COLUMN color TEXT;"); } catch(e) {}
    try { db.run("ALTER TABLE tags ADD COLUMN description TEXT;"); } catch(e) {}
    try { db.run("ALTER TABLE tag_categories ADD COLUMN sort_order INTEGER;"); } catch(e) {}
    try { db.run("ALTER TABLE tag_field_definitions ADD COLUMN sort_order INTEGER;"); } catch(e) {}
    try { db.run("ALTER TABLE tag_field_definitions ADD COLUMN category_id TEXT;"); } catch(e) {}
    try { db.run("ALTER TABLE tag_field_definitions ADD COLUMN field_key TEXT;"); } catch(e) {}
    try { db.run("ALTER TABLE tag_field_definitions ADD COLUMN field_label TEXT;"); } catch(e) {}
    try { db.run("ALTER TABLE tag_field_definitions ADD COLUMN field_type TEXT;"); } catch(e) {}

    // Chart of accounts: one row per standardized account name. COLLATE NOCASE so "cash" and "Cash" are one account.
    try {
      db.run(`
        CREATE TABLE IF NOT EXISTS chart_of_accounts (
          name TEXT PRIMARY KEY COLLATE NOCASE,
          account_type TEXT NOT NULL DEFAULT 'unclassified',
          created_at TEXT,
          updated_at TEXT
        );
      `);
      // Idempotent backfill: every account name already used in a transaction gets a row (type left for the user to set),
      // so older databases and restored backups pick up their accounts automatically.
      db.run(`
        INSERT OR IGNORE INTO chart_of_accounts (name, account_type, created_at, updated_at)
        SELECT acct, 'unclassified', datetime('now'), datetime('now') FROM (
          SELECT TRIM(debit_account) AS acct FROM daily_transactions
          UNION SELECT TRIM(credit_account) FROM daily_transactions
        ) WHERE acct IS NOT NULL AND acct != ''
      `);
      // Standardize stored names to the chart's spelling (e.g. "cash " -> "Cash") so reports print one name per account.
      ['debit_account', 'credit_account'].forEach(col => {
        db.run(`
          UPDATE daily_transactions
          SET ${col} = (SELECT c.name FROM chart_of_accounts c WHERE c.name = TRIM(daily_transactions.${col}) COLLATE NOCASE)
          WHERE ${col} IS NOT NULL AND TRIM(${col}) != ''
            AND ${col} != (SELECT c.name FROM chart_of_accounts c WHERE c.name = TRIM(daily_transactions.${col}) COLLATE NOCASE)
        `);
      });
    } catch (e) {
      console.warn('Chart of accounts schema note:', e);
    }

    // Auto-transition past planned/confirmed schedules to completed
    try {
      const todayYmd = new Date().toISOString().split('T')[0];
      db.run("UPDATE schedules SET status = 'completed' WHERE (status = 'planned' OR status = 'confirmed') AND schedule_date < ?", [todayYmd]);
      if (db.getRowsModified && db.getRowsModified() > 0) {
        saveDbToIndexedDB();
      }
    } catch (e) {}

  } catch (e) {
    console.warn('Schema upgrade note:', e);
  }
}

// Pure pull architecture: No client-side database write operations permitted.
function migrateAndCompressDatabase() {}
function cleanupOrphanTravelEntries() {}
function backfillMissingOvernightArrivalEntries() {}

async function initDbFromSeedJson() {
  console.log('Initializing fresh SQLite database schema...');
  db = new SQL.Database();
  
  db.run(`
    CREATE TABLE IF NOT EXISTS tag_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT,
      icon TEXT,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      category_id TEXT NOT NULL REFERENCES tag_categories(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT,
      description TEXT,
      UNIQUE(category_id, name)
    );

    CREATE TABLE IF NOT EXISTS tag_field_definitions (
      id TEXT PRIMARY KEY,
      tag_id TEXT,
      category_id TEXT,
      field_key TEXT NOT NULL,
      field_label TEXT NOT NULL,
      field_type TEXT DEFAULT 'text'
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      group_id TEXT,
      schedule_date TEXT NOT NULL,
      from_time TEXT NOT NULL,
      to_time TEXT NOT NULL,
      delivery_mode TEXT DEFAULT 'offline',
      location TEXT,
      title TEXT NOT NULL,
      notes TEXT,
      attachments TEXT,
      travel_info TEXT,
      status TEXT DEFAULT 'completed',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedule_tags (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      field_values TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS daily_notes (
      note_date TEXT PRIMARY KEY,
      content TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS daily_transactions (
      id TEXT PRIMARY KEY,
      txn_date TEXT NOT NULL,
      type TEXT NOT NULL,
      debit_account TEXT,
      credit_account TEXT,
      amount REAL NOT NULL,
      description TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);

  ensureSchemaUpToDate();

  // Seed default taxonomy master tags, categories & custom fields if provided
  try {
    const seedData = (typeof DEFAULT_TAXONOMY_SEED !== 'undefined') ? DEFAULT_TAXONOMY_SEED : null;
    if (seedData) {
      if (Array.isArray(seedData.categories)) {
        for (const cat of seedData.categories) {
          db.run(
            "INSERT OR IGNORE INTO tag_categories (id, name, color, icon, sort_order) VALUES (?, ?, ?, ?, ?)",
            cat
          );
        }
      }
      if (Array.isArray(seedData.tags)) {
        for (const tag of seedData.tags) {
          db.run(
            "INSERT OR IGNORE INTO tags (id, category_id, name, color, description) VALUES (?, ?, ?, ?, ?)",
            tag
          );
        }
      }
      if (Array.isArray(seedData.fields)) {
        for (const fld of seedData.fields) {
          db.run(
            "INSERT OR IGNORE INTO tag_field_definitions (id, tag_id, category_id, field_key, field_label, field_type) VALUES (?, ?, ?, ?, ?, ?)",
            fld
          );
        }
      }
    }
  } catch(e) {
    console.warn('Could not populate initial taxonomy seed:', e);
  }

  await saveDbToIndexedDB(false);
}

function openSRGDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('SRGCalendarDB', 2);
    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains('files')) {
        idb.createObjectStore('files');
      }
      if (!idb.objectStoreNames.contains('snapshots')) {
        idb.createObjectStore('snapshots', { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(req.error);
  });
}

function saveDbToIndexedDB(updateTimestamp = true) {
  if (updateTimestamp) {
    lsSet('srg_db_last_modified', Date.now().toString());
  }
  return new Promise(async (resolve, reject) => {
    if (!db) return resolve();
    try {
      if (biometricSnapshotFallbackActive) {
        throw new Error('Saving is paused: this session was opened from an older snapshot. Use Change Security PIN to re-secure your data first.');
      }
      if (!currentEncryptionKey) {
        if (isPinConfigured()) {
          throw new Error('Security Error: Refusing to save unencrypted database while PIN lock is configured.');
        }
      }
      const rawBytes = db.export();
      let bytesToStore = rawBytes;
      if (currentEncryptionKey) {
        bytesToStore = await encryptDatabaseBytes(rawBytes);
      }
      cachedEncryptedDbBytes = bytesToStore;
      const idb = await openSRGDatabase();
      const tx = idb.transaction('files', 'readwrite');
      const store = tx.objectStore('files');
      store.put(bytesToStore, 'active_sqlite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    } catch(err) {
      reject(err);
    }
  });
}

function loadDbFromIndexedDB() {
  return new Promise(async (resolve) => {
    try {
      const idb = await openSRGDatabase();
      const tx = idb.transaction('files', 'readonly');
      const store = tx.objectStore('files');
      const getReq = store.get('active_sqlite');
      getReq.onsuccess = () => {
        const res = getReq.result;
        if (!res) return resolve(null);
        if (res instanceof Uint8Array) return resolve(res);
        if (res instanceof ArrayBuffer) return resolve(new Uint8Array(res));
        if (ArrayBuffer.isView(res)) return resolve(new Uint8Array(res.buffer, res.byteOffset, res.byteLength));
        resolve(null);
      };
      getReq.onerror = () => resolve(null);
    } catch(e) {
      resolve(null);
    }
  });
}

/* Local Snapshots History in IndexedDB */
async function saveLocalDbSnapshot(customLabel = null) {
  if (!db) return;
  try {
    if (!currentEncryptionKey && isPinConfigured()) {
      console.warn('Security Warning: Refusing to save snapshot without active encryption key.');
      return;
    }
    const idb = await openSRGDatabase();
    let binary = db.export();
    if (currentEncryptionKey) {
      binary = await encryptDatabaseBytes(binary);
    }
    const now = Date.now();
    const label = customLabel || `Snapshot ${formatFullDateTime(now)}`;
    const snapshot = {
      id: now,
      name: `SRG_Calendar_${formatDateYMD(new Date())}_${now.toString().slice(-4)}.db`,
      label: label,
      timestamp: now,
      size: binary.byteLength,
      data: binary
    };

    const tx = idb.transaction('snapshots', 'readwrite');
    const store = tx.objectStore('snapshots');
    store.put(snapshot);
    await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });

    // Keep max 15 snapshots
    const getAllTx = idb.transaction('snapshots', 'readwrite');
    const sStore = getAllTx.objectStore('snapshots');
    const allReq = sStore.getAll();
    allReq.onsuccess = () => {
      const all = allReq.result || [];
      if (all.length > 15) {
        all.sort((a, b) => b.timestamp - a.timestamp);
        const toDelete = all.slice(15);
        toDelete.forEach(item => sStore.delete(item.id));
      }
    };
  } catch(e) {
    console.warn('Snapshot error:', e);
  }
}

async function listLocalDbSnapshots() {
  try {
    const idb = await openSRGDatabase();
    return new Promise((resolve) => {
      const tx = idb.transaction('snapshots', 'readonly');
      const store = tx.objectStore('snapshots');
      const req = store.getAll();
      req.onsuccess = () => {
        const list = req.result || [];
        list.sort((a, b) => b.timestamp - a.timestamp);
        resolve(list);
      };
      req.onerror = () => resolve([]);
    });
  } catch(e) {
    return [];
  }
}

async function restoreLocalDbSnapshot(snapId) {
  try {
    const idb = await openSRGDatabase();
    const snap = await new Promise((resolve) => {
      const tx = idb.transaction('snapshots', 'readonly');
      const store = tx.objectStore('snapshots');
      const req = store.get(snapId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    if (!snap || !snap.data) {
      showToast('Snapshot data not found', 'error');
      return;
    }

    // Safety backup of current database before restore
    await saveLocalDbSnapshot('Pre-restore Safety Backup');

    let snapBytes = new Uint8Array(snap.data);
    if (isEncryptedDbBytes(snapBytes)) {
      if (!currentEncryptionKey) throw new Error('Unlock database with your PIN first.');
      snapBytes = await decryptDatabaseBytes(snapBytes, currentEncryptionKey);
    }

    if (!isValidSqliteBinary(snapBytes)) {
      throw new Error('Snapshot data is not a valid SQLite database.');
    }

    db = new SQL.Database(snapBytes);
    ensureSchemaUpToDate();
    // With the data key, a deliberate snapshot restore is safe to save even if the session was opened
    // from a snapshot (the old pause guarded against saving under a stale fingerprint key).
    if (currentDekId) biometricSnapshotFallbackActive = false;
    await saveDbToIndexedDB();
    loadMasterDataFromDb();
    populateTitlesDatalist();
    renderCurrentView();
    closeServerSyncModal();
    showToast('✓ Local snapshot restored successfully!', 'success', 4000);
  } catch(e) {
    showToast('Error restoring snapshot: ' + e.message, 'error');
  }
}

async function deleteLocalDbSnapshot(snapId) {
  try {
    const idb = await openSRGDatabase();
    const tx = idb.transaction('snapshots', 'readwrite');
    const store = tx.objectStore('snapshots');
    store.delete(snapId);
    await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
  } catch(e) {}
}

async function deleteAllLocalDbSnapshots() {
  try {
    const idb = await openSRGDatabase();
    const tx = idb.transaction('snapshots', 'readwrite');
    const store = tx.objectStore('snapshots');
    store.clear();
    await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
  } catch(e) {}
}

/* ==========================================================================
   1B. DECOUPLED ATTACHMENT STORAGE & BACKUP SYSTEM (INDEXEDDB & CANONICAL MAPPING)
   ========================================================================== */

const ALLOWED_ATTACHMENT_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf'];

function isAllowedAttachmentFile(filename) {
  if (!filename) return false;
  const ext = filename.split('.').pop().toLowerCase();
  return ALLOWED_ATTACHMENT_EXTENSIONS.includes(ext);
}

function extractCanonicalAttachmentId(filename) {
  if (!filename) return null;
  // 1. Detect ticket onward / return pattern (e.g. ticket_onward_1791635563947)
  const ticketMatch = filename.match(/(ticket_(?:onward|return)_\d+)/i);
  if (ticketMatch) {
    return ticketMatch[1].toLowerCase();
  }
  // 2. Strip server random hash prefix (e.g. att_1791635569_2f102dd1_...)
  const cleanedServerName = filename.replace(/^att_\d+_[a-f0-9]+_/, '');
  if (cleanedServerName && cleanedServerName !== filename) {
    const subTicket = cleanedServerName.match(/(ticket_(?:onward|return)_\d+)/i);
    if (subTicket) return subTicket[1].toLowerCase();
    return cleanedServerName;
  }
  // 3. Strip 'att_' prefix if present
  if (filename.startsWith('att_')) {
    return filename.slice(4);
  }
  return filename;
}

async function saveAttachmentToIndexedDB(attId, dataBase64) {
  if (!attId || !dataBase64) return false;
  try {
    if (!currentEncryptionKey && isPinConfigured()) {
      throw new Error('Security Error: Refusing to save unencrypted attachment while PIN lock is configured.');
    }
    let payload = dataBase64;
    if (currentEncryptionKey && typeof dataBase64 === 'string') {
      payload = await encryptAttachmentData(dataBase64, currentEncryptionKey);
    }
    const idb = await openSRGDatabase();
    const tx = idb.transaction('files', 'readwrite');
    const store = tx.objectStore('files');
    const canonicalKey = attId.startsWith('att_') ? attId : ('att_' + attId);
    store.put(payload, canonicalKey);

    return await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('Failed to save attachment to IndexedDB'));
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
  } catch(e) {
    console.warn('saveAttachmentToIndexedDB error:', e);
    return false;
  }
}

async function loadAttachmentFromIndexedDB(attId) {
  if (!attId) return null;
  try {
    const idb = await openSRGDatabase();
    const tx = idb.transaction('files', 'readonly');
    const store = tx.objectStore('files');

    const canonicalKey = attId.startsWith('att_') ? attId : ('att_' + attId);
    const rawKey = attId.startsWith('att_') ? attId.slice(4) : attId;

    const rawResult = await new Promise((resolve) => {
      const req1 = store.get(canonicalKey);
      req1.onsuccess = () => {
        if (req1.result !== undefined && req1.result !== null) return resolve(req1.result);
        const req2 = store.get(rawKey);
        req2.onsuccess = () => resolve(req2.result !== undefined ? req2.result : null);
        req2.onerror = () => resolve(null);
      };
      req1.onerror = () => resolve(null);
    });

    if (!rawResult) return null;
    return await decryptAttachmentData(rawResult, currentEncryptionKey);
  } catch(e) {
    console.warn('loadAttachmentFromIndexedDB error:', e);
    return null;
  }
}

// Post-unlock migration: scans IndexedDB and encrypts any legacy plaintext attachments at rest
async function migratePlaintextAttachmentsToEncrypted(key = currentEncryptionKey) {
  if (!key) return 0;
  try {
    const idb = await openSRGDatabase();

    // 1. Read all candidates in a readonly transaction
    const candidateRecords = await new Promise((resolve, reject) => {
      try {
        const tx = idb.transaction('files', 'readonly');
        const store = tx.objectStore('files');
        const cursorReq = store.openCursor();
        const records = [];
        cursorReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            const k = String(cursor.key);
            if (k.startsWith('att_') || k.startsWith('ticket_') || k.includes('.')) {
              records.push({ key: k, value: cursor.value });
            }
            cursor.continue();
          } else {
            resolve(records);
          }
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      } catch (err) {
        reject(err);
      }
    });

    // 2. Asynchronously encrypt and verify in memory outside any transaction
    const stagedUpdates = [];
    for (const record of candidateRecords) {
      const val = record.value;
      if (!isEncryptedAttachmentBytes(val)) {
        let plainText = null;
        if (typeof val === 'string' && val.startsWith('data:')) {
          plainText = val;
        } else if (val instanceof Uint8Array || val instanceof ArrayBuffer) {
          try {
            const dec = new TextDecoder().decode(val);
            if (dec.startsWith('data:')) plainText = dec;
          } catch(err) {}
        }
        if (plainText) {
          try {
            const enc = await encryptAttachmentData(plainText, key);
            const verified = await decryptAttachmentData(enc, key);
            if (verified === plainText) {
              stagedUpdates.push({ key: record.key, value: enc });
            } else {
              console.warn(`Migration verification failed for attachment ${record.key}`);
            }
          } catch (encErr) {
            console.warn(`Failed to encrypt attachment ${record.key} during migration:`, encErr);
          }
        }
      }
    }

    if (stagedUpdates.length === 0) return 0;

    // 3. Batch commit all prepared encrypted records in one readwrite transaction
    await new Promise((resolve, reject) => {
      const tx = idb.transaction('files', 'readwrite');
      const store = tx.objectStore('files');
      for (const item of stagedUpdates) {
        store.put(item.value, item.key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Migration batch commit failed'));
      tx.onabort = () => reject(tx.error || new Error('Migration batch transaction aborted'));
    });

    console.log(`Migrated ${stagedUpdates.length} legacy attachments to AES-256-GCM encryption at rest.`);
    return stagedUpdates.length;
  } catch(e) {
    console.warn('migratePlaintextAttachmentsToEncrypted error:', e);
    return 0;
  }
}

async function uploadAttachmentFileToServer(attId, filename, dataBase64) {
  // Pure local mode: Attachment is already securely saved to IndexedDB
}

async function downloadAttachmentFileFromServer(filename) {
  return null;
}

async function getAttachmentData(att) {
  if (!att) return null;
  if (att.data) return att.data;

  // Build candidate keys to try directly in IndexedDB
  const candidateKeys = new Set();

  if (att.id) {
    candidateKeys.add(att.id);
    candidateKeys.add('att_' + att.id);
  }
  if (att.filename) {
    candidateKeys.add(att.filename);
    candidateKeys.add('att_' + att.filename);
  }
  if (att.name) {
    candidateKeys.add(att.name);
    candidateKeys.add('att_' + att.name);
  }
  if (att.id && att.name) {
    const fn1 = att.id + '_' + att.name;
    const fn1Clean = att.id + '_' + att.name.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    candidateKeys.add(fn1);
    candidateKeys.add(fn1Clean);
  }

  // 1. Check direct keys
  for (const k of candidateKeys) {
    const val = await loadAttachmentFromIndexedDB(k);
    if (val) {
      att.data = val;
      return val;
    }
  }

  // 2. Fallback: Search IndexedDB files store for any key containing filename, ticket ID, or basename
  try {
    const idb = await openSRGDatabase();
    const tx = idb.transaction('files', 'readonly');
    const store = tx.objectStore('files');
    const searchTargets = [
      att.id,
      att.filename,
      att.name
    ].filter(Boolean).map(s => s.toLowerCase());

    const matchedData = await new Promise((resolve) => {
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const kStr = String(cursor.key).toLowerCase();
          const isMatch = searchTargets.some(target => {
            if (target.length < 4) return false;
            return kStr.includes(target) || target.includes(kStr.replace(/^att_/, ''));
          });
          if (isMatch && cursor.value) {
            return resolve(cursor.value);
          }
          cursor.continue();
        } else {
          resolve(null);
        }
      };
      cursorReq.onerror = () => resolve(null);
    });

    if (matchedData) {
      // The fallback match is the stored (possibly encrypted) value; only hand back something decrypted.
      let plain = null;
      try { plain = await decryptAttachmentData(matchedData, currentEncryptionKey); } catch (e) { plain = null; }
      if (plain && plain !== matchedData || (typeof plain === 'string' && plain.startsWith('data:'))) {
        att.data = plain;
        if (att.id) await saveAttachmentToIndexedDB(att.id, plain);
        return plain;
      }
      return null;
    }
  } catch(e) {
    console.warn('Fallback attachment search error:', e);
  }

  return null;
}

/* Content Fingerprint Helper (Cryptographic SHA-256 full-content hash) */
async function getContentFingerprint(val) {
  if (!val) return '';
  try {
    let buffer;
    if (typeof val === 'string') {
      buffer = new TextEncoder().encode(val);
    } else if (val instanceof ArrayBuffer) {
      buffer = val;
    } else if (val instanceof Uint8Array) {
      buffer = (val.byteOffset === 0 && val.byteLength === val.buffer.byteLength)
        ? val.buffer
        : val.buffer.slice(val.byteOffset, val.byteOffset + val.byteLength);
    } else {
      buffer = new TextEncoder().encode(String(val));
    }
    if (window.crypto && window.crypto.subtle) {
      const hashBuf = await window.crypto.subtle.digest('SHA-256', buffer);
      const hashArr = Array.from(new Uint8Array(hashBuf));
      return hashArr.map(b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch(e) {}

  // Synchronous robust full-content hash fallback (64-bit FNV-1a)
  let h1 = 0x811c9dc5, h2 = 0x811c9dc5;
  const str = typeof val === 'string' ? val : (val.length ? String.fromCharCode.apply(null, val.slice(0, 10000)) : String(val));
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193);
    h2 = Math.imul(h2 ^ (ch >>> 4), 0x01000193);
  }
  return `h_${str.length}_${(h1 >>> 0).toString(16)}_${(h2 >>> 0).toString(16)}`;
}

function getActiveScheduleAttachmentsMap() {
  const map = new Map(); // id -> { id, name, filename, type }
  if (!db) return map;
  try {
    const res = db.exec("SELECT id, attachments, travel_info FROM schedules");
    if (res.length > 0 && res[0].values) {
      for (const row of res[0].values) {
        const attJson = row[1];
        const travelJson = row[2];
        if (attJson) {
          try {
            const arr = JSON.parse(attJson);
            if (Array.isArray(arr)) {
              arr.forEach(a => {
                if (a.id) map.set(String(a.id).trim().toLowerCase(), a);
              });
            }
          } catch(e) {}
        }
        if (travelJson) {
          try {
            const t = JSON.parse(travelJson);
            ['onward', 'return'].forEach(leg => {
              if (t && t[leg] && t[leg].attachment && t[leg].attachment.id) {
                map.set(String(t[leg].attachment.id).trim().toLowerCase(), t[leg].attachment);
              }
            });
          } catch(e) {}
        }
      }
    }
  } catch(e) {
    console.warn('Error reading active schedule attachments:', e);
  }
  return map;
}

function getReferencedAttachmentIds() {
  const referenced = new Set();
  const activeMap = getActiveScheduleAttachmentsMap();
  for (const [id, att] of activeMap.entries()) {
    referenced.add(id);
    if (att.filename) referenced.add(String(att.filename).trim().toLowerCase());
  }
  return referenced;
}

async function scanStorageAttachments() {
  const activeAttsMap = getActiveScheduleAttachmentsMap();
  const idb = await openSRGDatabase();
  const tx = idb.transaction('files', 'readonly');
  const store = tx.objectStore('files');

  const allStored = [];
  await new Promise((resolve, reject) => {
    const req = store.openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const key = String(cursor.key);
        if (key.startsWith('att_')) {
          const val = cursor.value;
          let size = 0;
          if (typeof val === 'string') size = Math.round(val.length * 0.75);
          else if (val && val.byteLength) size = val.byteLength;
          allStored.push({
            key,
            rawId: key.slice(4).trim(),
            val,
            size,
            fp: ''
          });
        }
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
  });

  // Calculate cryptographic SHA-256 fingerprint for all items
  for (const item of allStored) {
    item.fp = await getContentFingerprint(item.val);
  }

  // Group by content fingerprint
  const groupsByFp = new Map();
  for (const item of allStored) {
    if (!groupsByFp.has(item.fp)) groupsByFp.set(item.fp, []);
    groupsByFp.get(item.fp).push(item);
  }

  const keepKeys = new Set();
  const duplicateKeysToDelete = [];
  const orphanKeysToDelete = [];
  let totalBytes = 0;

  for (const [fp, items] of groupsByFp.entries()) {
    items.forEach(it => totalBytes += it.size);

    // Check if any item in this fingerprint group matches an active schedule attachment
    let matchedAtt = null;
    let matchedItem = null;

    for (const it of items) {
      const lowId = it.rawId.toLowerCase();
      if (activeAttsMap.has(lowId)) {
        matchedAtt = activeAttsMap.get(lowId);
        matchedItem = it;
        break;
      }
      for (const [activeId, attMeta] of activeAttsMap.entries()) {
        if (lowId === activeId || lowId === ('att_' + activeId) || lowId.includes(activeId)) {
          matchedAtt = attMeta;
          matchedItem = it;
          break;
        }
      }
      if (matchedAtt) break;
    }

    if (matchedAtt) {
      // Pick best canonical key to keep:
      // Prefer exact key 'att_' + matchedAtt.id
      let canonicalItem = items.find(it => it.key === ('att_' + matchedAtt.id)) ||
                          matchedItem ||
                          items[0];
      keepKeys.add(canonicalItem.key);

      // All other keys with the SAME fingerprint are redundant alias duplicates!
      for (const it of items) {
        if (it.key !== canonicalItem.key) {
          duplicateKeysToDelete.push({ key: it.key, size: it.size });
        }
      }
    } else {
      // Not referenced by any active schedule -> all items in group are orphans
      for (const it of items) {
        orphanKeysToDelete.push({ key: it.key, size: it.size });
      }
    }
  }

  // Stale aliases: older versions saved each ticket a second time under a longer alias name. When the ticket's
  // real file (att_<id>) opens with the current key but the alias does not (it was left under a lost key),
  // the alias can never be used again. Only that exact combination is removable; plain or readable aliases stay.
  const staleAliasKeysToDelete = [];
  if (currentEncryptionKey) {
    const byKey = new Map(allStored.map(it => [it.key, it]));
    const openCache = new Map();
    const opens = async (it) => {
      if (openCache.has(it.key)) return openCache.get(it.key);
      let ok;
      try {
        ok = !isEncryptedAttachmentBytes(it.val) || !!(await decryptAttachmentData(it.val, currentEncryptionKey));
      } catch (e) {
        ok = false;
      }
      openCache.set(it.key, ok);
      return ok;
    };
    const canonicalKeys = new Set(Array.from(activeAttsMap.values()).filter(m => m && m.id).map(m => 'att_' + m.id));
    for (const it of allStored) {
      if (!keepKeys.has(it.key) || canonicalKeys.has(it.key)) continue;
      const lowId = it.rawId.toLowerCase();
      const owner = Array.from(activeAttsMap.entries()).find(([activeId]) => lowId.includes(activeId));
      if (!owner || !owner[1].id) continue;
      const canonical = byKey.get('att_' + owner[1].id);
      if (canonical && await opens(canonical) && !(await opens(it))) {
        staleAliasKeysToDelete.push({ key: it.key, size: it.size });
        keepKeys.delete(it.key);
      }
    }
  }

  const cleanableList = [...duplicateKeysToDelete, ...orphanKeysToDelete, ...staleAliasKeysToDelete];

  return {
    staleAliasCount: staleAliasKeysToDelete.length,
    totalFiles: allStored.length,
    totalBytes: totalBytes,
    uniqueFilesCount: groupsByFp.size,
    cleanableList,
    duplicateCount: duplicateKeysToDelete.length,
    orphanCount: orphanKeysToDelete.length,
    activeFilesCount: keepKeys.size
  };
}

async function updateStorageStatsUI() {
  const statsEl = document.getElementById('storageAttachmentsStats');
  if (!statsEl) return;
  try {
    const stats = await scanStorageAttachments();
    const mb = (stats.totalBytes / (1024 * 1024)).toFixed(2);
    const cleanableCount = stats.cleanableList.length;
    if (cleanableCount > 0) {
      const cleanableMb = (stats.cleanableList.reduce((acc, o) => acc + o.size, 0) / (1024 * 1024)).toFixed(2);
      statsEl.innerHTML = `${stats.uniqueFilesCount} active (${stats.totalFiles} stored, ${mb} MB) <span style="color:#f59e0b; font-size:0.75rem;">• ${cleanableCount} duplicate/orphan (${cleanableMb} MB)</span>`;
    } else {
      statsEl.innerHTML = `${stats.uniqueFilesCount} files (${mb} MB) <span style="color:#10b981; font-size:0.75rem;">• Deduplicated & clean ✓</span>`;
    }
  } catch(e) {
    statsEl.textContent = 'Active';
  }
}

async function purgeOrphanAttachments() {
  const stats = await scanStorageAttachments();
  if (stats.cleanableList.length === 0) {
    showToast('✓ Storage is already fully deduplicated and clean! No duplicate or orphan files found.', 'success', 3500);
    return;
  }

  const cleanableMb = (stats.cleanableList.reduce((acc, o) => acc + o.size, 0) / (1024 * 1024)).toFixed(2);
  const msg = `Storage Clean Up & Deduplication:\n\nFound:\n- ${stats.duplicateCount} redundant alias duplicate keys\n- ${stats.orphanCount} unreferenced orphan files\n- ${stats.staleAliasCount || 0} unreadable old copies of tickets that now open normally\nTotal space to free: ~${cleanableMb} MB\n\nThis will safely remove redundant copies and keep only the ${stats.activeFilesCount} canonical files for your active schedules.\n\nProceed with cleanup?`;
  const ok = confirm(msg);
  if (!ok) return;

  try {
    const idb = await openSRGDatabase();
    const tx = idb.transaction('files', 'readwrite');
    const store = tx.objectStore('files');
    for (const item of stats.cleanableList) {
      store.delete(item.key);
    }
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = rej;
    });

    showToast(`✓ Removed ${stats.cleanableList.length} duplicate/orphan entries and freed ${cleanableMb} MB!`, 'success', 4000);
    await updateStorageStatsUI();
  } catch(err) {
    console.error('Error purging orphans:', err);
    showToast('Error cleaning files: ' + err.message, 'error', 4000);
  }
}

/**
 * Export complete atomic backup (SQLite database + manifest + all attachments)
 * as a single .zip archive with strict content deduplication.
 */
async function exportFullBackupZip() {
  if (!db) {
    showToast('Database is not initialized.', 'warning');
    return;
  }
  if (typeof JSZip === 'undefined') {
    showToast('Zip library not loaded. Please refresh the app.', 'error');
    return;
  }

  // Optional AES-256 encryption with a PIN-derived key (see requestBackupEncryptionKey)
  const shouldEncrypt = confirm('🔒 Encrypt backup database and all attachments with your Security PIN (AES-256)?\n\nClick "OK" to encrypt (recommended for cloud storage or USB drives).\nClick "Cancel" for standard unencrypted SQLite.');
  let backup = null;
  if (shouldEncrypt) {
    try {
      backup = await requestBackupEncryptionKey();
    } catch (e) {
      showToast('❌ ' + e.message, 'error', 4500);
      return;
    }
    if (!backup) return;
  }

  const loadingToast = showToast('Creating full backup bundle (database + attachments)...', 'info', 0);
  try {
    const zip = new JSZip();
    // Reads attachments under whichever key encrypted them (PIN keys are only tried when a PIN was entered).
    const keyRing = createKeyRing(backup ? backup.pin : null);
    const skippedFiles = [];

    // 1. Export SQLite database binary (optionally encrypted)
    let dbBinary = db.export();
    if (backup) {
      dbBinary = await encryptWithKeyAndSalt(dbBinary, backup.key, backup.salt, PBKDF2_ITERATIONS);
    }
    const dbSha256 = await getContentFingerprint(dbBinary);
    zip.file('database.db', dbBinary);

    // 2. Query schedules/records counts
    let schCount = 0, txCount = 0, noteCount = 0, tagCount = 0;
    try {
      const r0 = db.exec("SELECT COUNT(*) FROM schedules");
      if (r0.length > 0) schCount = r0[0].values[0][0];
      const r1 = db.exec("SELECT COUNT(*) FROM daily_transactions");
      if (r1.length > 0) txCount = r1[0].values[0][0];
      const r2 = db.exec("SELECT COUNT(*) FROM daily_notes");
      if (r2.length > 0) noteCount = r2[0].values[0][0];
      const r3 = db.exec("SELECT COUNT(*) FROM tags");
      if (r3.length > 0) tagCount = r3[0].values[0][0];
    } catch(e) {}

    // 3. Export attachments with STRICT CONTENT DEDUPLICATION & EXPLICIT MAPPING
    const activeAttsMap = getActiveScheduleAttachmentsMap();
    const manifestAttachments = [];
    const attFolder = zip.folder('attachments');
    const fingerprintToFileMap = new Map();
    const seenZipNames = new Set();

    // Adds one attachment (as a data URL) to the zip; returns false if it was a duplicate or unusable.
    const addAttachment = async (dataUrl, id, preferredName, displayName) => {
      const mime = dataUrlMime(dataUrl);
      const rawBytes = dataUrlToBytes(dataUrl);
      const fp = await getContentFingerprint(rawBytes);
      if (fingerprintToFileMap.has(fp)) return false;
      let zipName = preferredName;
      if (!zipName.includes('.')) zipName += '.' + extForMime(mime);
      if (seenZipNames.has(zipName)) return false;
      seenZipNames.add(zipName);
      fingerprintToFileMap.set(fp, zipName);

      let filePayload;
      let fileSha;
      if (backup) {
        filePayload = await encryptAttachmentData(dataUrl, backup.key);
        fileSha = await getContentFingerprint(filePayload);
      } else {
        filePayload = rawBytes;
        fileSha = fp;
      }
      attFolder.file(zipName, filePayload);
      manifestAttachments.push({
        id: id,
        filename: zipName,
        name: displayName || zipName,
        path: `attachments/${zipName}`,
        mime: mime,
        size: filePayload.byteLength || 0,
        sha256: fileSha,
        encrypted: !!backup
      });
      return true;
    };

    // Pass 1: attachments referenced by schedules (readable with the in-memory key)
    for (const [id, att] of activeAttsMap.entries()) {
      try {
        const data = await getAttachmentData(att);
        if (!data) continue; // not readable with the in-memory key; pass 2 retries with the key ring
        const dataUrl = attachmentPayloadToDataUrl(data);
        if (!dataUrl) continue;
        let baseName = (att.filename || att.name || (att.id + '.' + extForMime(dataUrlMime(dataUrl)))).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
        if (att.id && !baseName.startsWith(att.id)) baseName = `${att.id}_${baseName}`;
        await addAttachment(dataUrl, att.id, baseName, att.name);
      } catch (attErr) {
        console.warn('Backup: could not export attachment', id, attErr);
      }
    }

    // Pass 2: every stored attachment, decrypted under any known key
    const idb = await openSRGDatabase();
    const tx = idb.transaction('files', 'readonly');
    const store = tx.objectStore('files');

    const dbFiles = [];
    await new Promise((resolve, reject) => {
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const key = String(cursor.key);
          if (key.startsWith('att_')) {
            const val = cursor.value;
            if (val) dbFiles.push({ key, val });
          }
          cursor.continue();
        } else {
          resolve();
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });

    for (const item of dbFiles) {
      try {
        const hit = await decryptAttachmentWithKeyRing(item.val, keyRing);
        if (!hit.ok || !hit.result) {
          skippedFiles.push(item.key);
          continue;
        }
        const dataUrl = attachmentPayloadToDataUrl(hit.result);
        if (!dataUrl) {
          skippedFiles.push(item.key);
          continue;
        }
        const rawId = item.key.slice(4);
        const zipFileName = rawId.includes('.') ? rawId : `${rawId}.${extForMime(dataUrlMime(dataUrl))}`;
        await addAttachment(dataUrl, rawId, zipFileName, null);
      } catch (attErr) {
        console.warn('Backup: could not export attachment', item.key, attErr);
        skippedFiles.push(item.key);
      }
    }

    // 4. Manifest
    const nowIso = new Date().toISOString();
    const manifest = {
      app: 'SRG_Calendar',
      app_version: APP_VERSION,
      backup_id: 'SRG_BACKUP_' + Date.now(),
      created_at: nowIso,
      encrypted: !!shouldEncrypt,
      database: {
        filename: 'database.db',
        sha256: dbSha256,
        encrypted: !!shouldEncrypt,
        schedules_count: schCount,
        transactions_count: txCount,
        notes_count: noteCount,
        tags_count: tagCount
      },
      attachments_count: manifestAttachments.length,
      attachments: manifestAttachments,
      skipped_attachments: skippedFiles
    };
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    // 5. Generate and download zip
    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const nowStr = formatDateYMD(new Date());
    const downloadFilename = shouldEncrypt 
      ? `SRG_Calendar_FullBackup_Encrypted_${nowStr}.zip`
      : `SRG_Calendar_FullBackup_${nowStr}.zip`;

    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    if (loadingToast) dismissToast(loadingToast);
    if (skippedFiles.length) {
      showToast(`⚠ Backup saved (${schCount} schedules, ${manifestAttachments.length} files), but ${skippedFiles.length} attachment(s) could not be opened with any known key and were left out.${backup ? '' : ' Try the encrypted option (it can use your PIN to open them), or run Change Security PIN to re-secure first.'}`, 'warning', 9000);
    } else {
      showToast(`✓ Exported clean full backup (${schCount} schedules, ${manifestAttachments.length} unique files) to ${downloadFilename}!`, 'success', 5000);
    }
  } catch (err) {
    if (loadingToast) dismissToast(loadingToast);
    console.error('Error exporting full backup zip:', err);
    showToast('Failed to export full backup: ' + err.message, 'error', 5000);
  }
}

/**
 * Restore an atomic Full Backup (.zip) containing:
 * 1. SQLite relational database (database.db)
 * 2. Attachment tickets and documents (attachments/ folder)
 * 3. manifest.json
 */
async function importFullBackupZip(file) {
  if (!file) return;
  if (typeof JSZip === 'undefined') {
    showToast('Zip library not loaded. Please refresh the app.', 'error');
    return;
  }

  // Guardrail: Max archive size (250 MB)
  if (file.size > 250 * 1024 * 1024) {
    showToast('❌ Backup archive exceeds maximum size limit (250 MB).', 'error', 5000);
    return;
  }

  if (!confirm(`⚠️ Are you sure you want to restore full backup from "${file.name}"?\n\nThis will restore your complete database and all ticket attachments. An automatic safety snapshot of your current database will be saved first.`)) {
    return;
  }

  const loadingToast = showToast(`Validating and restoring backup "${file.name}"...`, 'info', 0);
  const previousDbBinary = db ? db.export() : null;

  try {
    const zip = await JSZip.loadAsync(file);

    // 1. Locate SQLite database file
    let dbEntry = zip.file('database.db');
    if (!dbEntry) {
      const dbKeys = Object.keys(zip.files).filter(k => k.toLowerCase().endsWith('.db') && !k.startsWith('__MACOSX') && !zip.files[k].dir);
      if (dbKeys.length > 0) {
        dbEntry = zip.files[dbKeys[0]];
      }
    }

    if (!dbEntry) {
      throw new Error('No SQLite database file (.db) found in the backup archive.');
    }

    // 2. Parse manifest.json if present for SHA-256 integrity verification
    let manifestMap = new Map();
    let manifestData = null;
    const manifestEntry = zip.file('manifest.json');
    if (manifestEntry) {
      try {
        const manifestText = await manifestEntry.async('string');
        manifestData = JSON.parse(manifestText);
        if (Array.isArray(manifestData.attachments)) {
          manifestData.attachments.forEach(att => {
            if (att.filename) manifestMap.set(att.filename.toLowerCase(), att);
            if (att.name) manifestMap.set(att.name.toLowerCase(), att);
            if (att.path) manifestMap.set(att.path.toLowerCase(), att);
          });
        }
      } catch (e) {
        console.warn('Could not parse manifest.json:', e);
      }
    }

    // 3. Validate SQLite binary & SHA-256 integrity
    let dbBinary = await dbEntry.async('uint8array');
    if (manifestData && manifestData.database && manifestData.database.sha256) {
      const calcDbSha = await getContentFingerprint(dbBinary);
      if (calcDbSha !== manifestData.database.sha256) {
        throw new Error('Database SHA-256 integrity verification failed! The archive may be corrupted or modified.');
      }
    }

    let backupKey = null;
    let backupSalt = null;
    let backupPin = null;

    if (isEncryptedDbBytes(dbBinary)) {
      const parsedHeader = parseEncryptedDbHeader(dbBinary);
      if (parsedHeader && parsedHeader.version === 3) {
        throw new Error('This database file is locked with a device data key, not a PIN, so it cannot be restored here. Use a backup made with Full Backup or Download DB.');
      }
      backupSalt = parsedHeader ? parsedHeader.salt : dbBinary.slice(CRYPTO_MAGIC.length, CRYPTO_MAGIC.length + 16);
      const backupIterations = parsedHeader ? parsedHeader.iterations : PBKDF2_ITERATIONS;
      const pin = await requestPinPromptModal({
        title: 'Encrypted Backup Restore',
        message: 'This backup database is encrypted with AES-256. Enter the Security PIN used to encrypt this backup:',
        placeholder: 'Enter Backup PIN',
        confirmText: 'Decrypt & Restore',
        iconClass: 'fa-solid fa-file-shield'
      });
      if (!pin) {
        if (loadingToast) dismissToast(loadingToast);
        showToast('Restore cancelled: Security PIN is required for encrypted backup.', 'warning');
        return;
      }
      try {
        backupKey = await deriveKeyFromPin(pin, backupSalt, backupIterations, false);
        dbBinary = await decryptDatabaseBytes(dbBinary, backupKey, false);
        backupPin = pin;
      } catch(decErr) {
        if (loadingToast) dismissToast(loadingToast);
        showToast('❌ Decryption failed: Incorrect Security PIN for this backup.', 'error', 5000);
        return;
      }
    }

    if (!isValidSqliteBinary(dbBinary)) {
      throw new Error('Database file in archive is not a valid SQLite database.');
    }

    // 4. Stage and extract all attachments into memory FIRST with SHA-256 verification
    const stagedAttachments = [];
    const attFiles = Object.keys(zip.files).filter(k => {
      if (zip.files[k].dir || k.startsWith('__MACOSX') || k === 'manifest.json' || k.toLowerCase().endsWith('.db')) {
        return false;
      }
      return true;
    });

    for (const relPath of attFiles) {
      const zipEntry = zip.files[relPath];
      const filename = relPath.split('/').pop().trim();
      if (!filename || filename === '.htaccess' || !isAllowedAttachmentFile(filename)) continue;

      const fileBytes = await zipEntry.async('uint8array');
      if (fileBytes.byteLength > 40 * 1024 * 1024) continue;

      const manifestInfo = manifestMap.get(filename.toLowerCase()) || manifestMap.get(relPath.toLowerCase());
      if (manifestInfo && manifestInfo.sha256) {
        const calcSha = await getContentFingerprint(fileBytes);
        if (calcSha !== manifestInfo.sha256) {
          throw new Error(`SHA-256 integrity verification failed for attachment "${filename}". Restore aborted to protect data.`);
        }
      }

      let dataUrl = null;
      if (isEncryptedAttachmentBytes(fileBytes)) {
        if (!backupKey) {
          const pin = await requestPinPromptModal({
            title: 'Encrypted Attachment',
            message: `Attachment "${filename}" is encrypted with AES-256. Enter the Security PIN to decrypt it:`,
            placeholder: 'Enter Security PIN',
            confirmText: 'Decrypt',
            iconClass: 'fa-solid fa-file-shield'
          });
          if (!pin) throw new Error('PIN required to decrypt attachments.');
          const salt = getStoredCryptoSalt() || crypto.getRandomValues(new Uint8Array(16));
          backupKey = await deriveKeyFromPin(pin, salt, PBKDF2_ITERATIONS, false);
        }
        dataUrl = await decryptAttachmentData(fileBytes, backupKey);
      } else {
        const ext = filename.split('.').pop().toLowerCase();
        let mime = 'application/octet-stream';
        if (['jpg', 'jpeg'].includes(ext)) mime = 'image/jpeg';
        else if (ext === 'png') mime = 'image/png';
        else if (ext === 'gif') mime = 'image/gif';
        else if (ext === 'webp') mime = 'image/webp';
        else if (ext === 'pdf') mime = 'application/pdf';

        const base64Content = await zipEntry.async('base64');
        dataUrl = `data:${mime};base64,${base64Content}`;
      }

      let canonicalId = (manifestInfo && manifestInfo.id) ||
                        extractCanonicalAttachmentId(filename) ||
                        filename;

      stagedAttachments.push({ canonicalId, filename, dataUrl });
    }

    // Safety snapshot of existing database before applying restore
    try {
      await saveLocalDbSnapshot('Pre-Full-Restore Auto Snapshot');
    } catch (e) {
      console.warn('Safety snapshot error:', e);
    }

    // 5. Stage, encrypt, and batch-commit attachments and database in ONE atomic transaction
    const deviceKeyActive = !!(currentEncryptionKey && isPinConfigured());
    // Fresh device restoring a PIN-encrypted backup: adopt the backup PIN by creating a new data key
    // wrapped with it (the backup's own PIN-derived key is only for reading the archive).
    let adopted = null;
    if (!deviceKeyActive && backupPin) {
      const created = await createDekEnvelope(backupPin);
      const recoveryKey = generateRecoveryKey();
      try {
        created.vaultBytes = await buildRecoveryVaultPackedBytes(created.rawDek, recoveryKey);
      } finally {
        created.rawDek.fill(0);
      }
      created.recoveryKey = recoveryKey;
      adopted = created;
    }
    const effectiveKey = deviceKeyActive ? currentEncryptionKey : (adopted ? adopted.dekKey : (backupKey || null));
    const effectiveDekId = deviceKeyActive ? currentDekId : (adopted ? adopted.dekId : null);
    const filesToCommit = [];
    let importedAttachmentsCount = 0;

    for (const item of stagedAttachments) {
      let payload = item.dataUrl;
      if (effectiveKey) {
        payload = await encryptAttachmentData(item.dataUrl, effectiveKey);
      }
      const canonicalKey = item.canonicalId.startsWith('att_') ? item.canonicalId : ('att_' + item.canonicalId);
      filesToCommit.push({ key: canonicalKey, value: payload });
      if (item.filename && item.filename !== item.canonicalId) {
        const fnameKey = item.filename.startsWith('att_') ? item.filename : ('att_' + item.filename);
        filesToCommit.push({ key: fnameKey, value: payload });
      }
      importedAttachmentsCount++;
    }

    // Prepare and verify restored database binary
    if (!isValidSqliteBinary(dbBinary)) {
      throw new Error('Database binary in backup is invalid or corrupted.');
    }
    const restoredDbInstance = new SQL.Database(dbBinary);
    const prevDbHolder = db;
    db = restoredDbInstance;
    ensureSchemaUpToDate();
    const rawBytes = db.export();

    let dbBytesToStore = rawBytes;
    if (effectiveKey) {
      if (effectiveDekId) {
        dbBytesToStore = await encryptWithDek(rawBytes, effectiveKey, effectiveDekId);
      } else {
        const activeSalt = getStoredCryptoSalt() || backupSalt || crypto.getRandomValues(new Uint8Array(16));
        dbBytesToStore = await encryptWithKeyAndSalt(rawBytes, effectiveKey, activeSalt);
      }
      const verifyDec = await decryptDatabaseBytes(dbBytesToStore, effectiveKey, false);
      if (verifyDec.byteLength !== rawBytes.byteLength) {
        throw new Error('Database encryption verification failed before committing restore.');
      }
    }
    filesToCommit.push({ key: 'active_sqlite', value: dbBytesToStore });
    if (adopted) {
      filesToCommit.push({ key: 'srg_key_envelope', value: adopted.env });
      filesToCommit.push({ key: 'srg_recovery_vault', value: adopted.vaultBytes });
    }

    // Execute atomic commit on 'files' store: all attachments + database committed together
    const idb = await openSRGDatabase();
    await new Promise((resolve, reject) => {
      const tx = idb.transaction('files', 'readwrite');
      const store = tx.objectStore('files');
      for (const entry of filesToCommit) {
        store.put(entry.value, entry.key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Failed to commit restored backup to IndexedDB'));
      tx.onabort = () => reject(tx.error || new Error('Restore transaction aborted'));
    });

    // 6. Transaction committed successfully: synchronize state
    cachedEncryptedDbBytes = dbBytesToStore;
    lsSet('srg_db_last_modified', Date.now().toString());

    if (adopted) {
      // Fresh device restoring encrypted backup: the backup PIN now unlocks this device's new data key
      keyEnvelope = adopted.env;
      cacheKeyEnvelopeLocally(adopted.env);
      cacheRecoveryVaultLocally(adopted.vaultBytes);
      activateDek(adopted.dekKey, adopted.dekId);
      lsSet('srg_app_pin_configured', 'true');
      isAppUnlocked = true;
      resetAutoLockTimer();
      const overlay = document.getElementById('appLockOverlay');
      if (overlay) overlay.classList.add('hidden');
      setTimeout(() => openRecoveryKitModal(adopted.recoveryKey, true), 600);
    }

    loadMasterDataFromDb();
    populateTitlesDatalist();

    renderCurrentView();
    await updateStorageStatsUI();
    closeServerSyncModal();

    if (loadingToast) dismissToast(loadingToast);
    showToast(`✓ Full backup restored successfully! Database loaded and ${importedAttachmentsCount} attachments verified and restored.`, 'success', 5000);
  } catch (err) {
    if (loadingToast) dismissToast(loadingToast);
    console.error('Error importing full backup zip:', err);
    // If active database was mutated, safely revert to previous database binary!
    if (previousDbBinary && isValidSqliteBinary(previousDbBinary)) {
      try {
        db = new SQL.Database(previousDbBinary);
        await saveDbToIndexedDB(false);
      } catch(revErr) {
        console.error('Failed to revert DB after failed restore:', revErr);
      }
    }
    const msg = (err.name === 'QuotaExceededError')
      ? '❌ Storage quota exceeded! Cannot restore all attachments. Original calendar database preserved intact.'
      : 'Failed to restore full backup: ' + err.message;
    showToast(msg, 'error', 6000);
  }
}

/**
 * Export all local attachments from IndexedDB into a single .zip file
 * with content-based deduplication (0 duplicate files).
 */
async function exportAttachmentsZipFile() {
  if (typeof JSZip === 'undefined') {
    showToast('Zip library not loaded. Please refresh the app.', 'error');
    return;
  }

  const loadingToast = showToast('Packaging attachments into ZIP archive...', 'info', 0);
  try {
    const zip = new JSZip();
    let fileCount = 0;
    const seenFingerprints = new Set();
    const seenZipNames = new Set();
    const manifestAttachments = [];

    // Pass 1: Active schedule attachments
    const activeAttsMap = getActiveScheduleAttachmentsMap();
    const fingerprintToFileMap = new Map();

    for (const [id, att] of activeAttsMap.entries()) {
      const data = await getAttachmentData(att);
      if (data) {
        const fp = await getContentFingerprint(data);
        let zipName = fingerprintToFileMap.get(fp);

        let ext = 'pdf';
        let mime = 'application/pdf';
        if (typeof data === 'string' && data.startsWith('data:')) {
          const m = data.match(/data:([^;]+);/);
          if (m) {
            mime = m[1];
            if (mime.includes('jpeg')) ext = 'jpg';
            else if (mime.includes('png')) ext = 'png';
            else if (mime.includes('gif')) ext = 'gif';
            else if (mime.includes('webp')) ext = 'webp';
            else if (mime.includes('pdf')) ext = 'pdf';
          }
        }

        let baseName = (att.filename || att.name || (att.id + '.' + ext)).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
        if (!baseName.includes('.')) baseName += '.' + ext;

        if (!zipName) {
          zipName = baseName;
          if (att.id && !zipName.startsWith(att.id)) zipName = `${att.id}_${baseName}`;
          seenZipNames.add(zipName);
          fingerprintToFileMap.set(fp, zipName);

          const commaIdx = typeof data === 'string' ? data.indexOf(',') : -1;
          const b64 = commaIdx > -1 ? data.slice(commaIdx + 1) : data;
          zip.file(zipName, b64, { base64: true });
          fileCount++;
        }

        const commaIdx = typeof data === 'string' ? data.indexOf(',') : -1;
        const b64 = commaIdx > -1 ? data.slice(commaIdx + 1) : data;

        manifestAttachments.push({
          id: att.id,
          filename: zipName,
          mime: mime,
          size: typeof b64 === 'string' ? Math.round(b64.length * 0.75) : (data.byteLength || 0)
        });
      }
    }

    // Pass 2: Unique unreferenced files in IndexedDB
    const idb = await openSRGDatabase();
    const tx = idb.transaction('files', 'readonly');
    const store = tx.objectStore('files');

    const dbFiles = [];
    await new Promise((resolve, reject) => {
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const key = String(cursor.key);
          if (key.startsWith('att_')) {
            const val = cursor.value;
            if (val) dbFiles.push({ key, val });
          }
          cursor.continue();
        } else {
          resolve();
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });

    for (const item of dbFiles) {
      let plainData = item.val;
      if (isEncryptedAttachmentBytes(plainData)) {
        plainData = await decryptAttachmentData(plainData, currentEncryptionKey);
      }
      const fp = await getContentFingerprint(plainData);
      if (!fingerprintToFileMap.has(fp)) {
        const rawKey = item.key.slice(4);
        let ext = 'bin';
        let mime = 'application/octet-stream';
        let b64 = '';

        if (typeof plainData === 'string' && plainData.startsWith('data:')) {
          const commaIdx = plainData.indexOf(',');
          b64 = commaIdx > -1 ? plainData.slice(commaIdx + 1) : plainData;
          const matchMime = plainData.match(/data:([^;]+);/);
          if (matchMime) {
            mime = matchMime[1];
            if (mime.includes('jpeg')) ext = 'jpg';
            else if (mime.includes('png')) ext = 'png';
            else if (mime.includes('pdf')) ext = 'pdf';
          }
        }

        let zipFileName = rawKey.includes('.') ? rawKey : `${rawKey}.${ext}`;
        if (!seenZipNames.has(zipFileName)) {
          seenZipNames.add(zipFileName);
          fingerprintToFileMap.set(fp, zipFileName);

          if (b64) {
            zip.file(zipFileName, b64, { base64: true });
            fileCount++;
          } else if (plainData instanceof ArrayBuffer || plainData instanceof Uint8Array) {
            zip.file(zipFileName, plainData);
            fileCount++;
          }

          manifestAttachments.push({
            id: rawKey,
            filename: zipFileName,
            mime: mime,
            size: b64 ? Math.round(b64.length * 0.75) : (plainData.byteLength || 0)
          });
        }
      }
    }

    if (loadingToast) dismissToast(loadingToast);

    if (fileCount === 0) {
      showToast('No ticket attachments found in local storage to export.', 'info', 4000);
      return;
    }

    zip.file('manifest.json', JSON.stringify({
      app: 'SRG_Calendar',
      type: 'attachments_only',
      exported_at: new Date().toISOString(),
      attachments_count: manifestAttachments.length,
      attachments: manifestAttachments
    }, null, 2));

    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const nowStr = formatDateYMD(new Date());
    const filename = `SRG_Calendar_Attachments_${nowStr}.zip`;

    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast(`✓ Exported ${fileCount} unique attachment files to ${filename}!`, 'success', 5000);
  } catch (err) {
    if (loadingToast) dismissToast(loadingToast);
    console.error('Error generating attachments zip:', err);
    showToast('Failed to export attachments zip: ' + err.message, 'error', 5000);
  }
}

/**
 * Import a .zip file containing attachments into IndexedDB local storage.
 * Enforces guardrails, supported file extensions, and saves single canonical keys.
 */
async function importAttachmentsZipFile(file) {
  if (!file) return;
  if (typeof JSZip === 'undefined') {
    showToast('Zip library not loaded. Please refresh the app.', 'error');
    return;
  }

  // Guardrail 1: Max archive size (150 MB)
  if (file.size > 150 * 1024 * 1024) {
    showToast('❌ Attachments archive exceeds maximum size limit (150 MB).', 'error', 5000);
    return;
  }

  const loadingToast = showToast(`Unpacking "${file.name}" into local storage...`, 'info', 0);
  try {
    const zip = await JSZip.loadAsync(file);
    let importedCount = 0;

    const fileEntries = Object.keys(zip.files).filter(k => !zip.files[k].dir && !k.startsWith('__MACOSX') && k !== 'manifest.json');

    // Guardrail 2: Max entry count (500 files)
    if (fileEntries.length > 500) {
      throw new Error('Archive contains too many entries (> 500). Aborting for safety.');
    }

    // Read manifest.json if present
    let manifestMap = new Map();
    const manifestEntry = zip.file('manifest.json');
    if (manifestEntry) {
      try {
        const manifestText = await manifestEntry.async('string');
        const manifest = JSON.parse(manifestText);
        if (Array.isArray(manifest.attachments)) {
          manifest.attachments.forEach(att => {
            if (att.filename && att.id) manifestMap.set(att.filename.toLowerCase(), att.id);
          });
        }
      } catch(e) {}
    }

    const stagedEntries = [];
    for (const relPath of fileEntries) {
      const zipEntry = zip.files[relPath];
      const filename = relPath.split('/').pop().trim();
      if (!filename || filename === '.htaccess' || !isAllowedAttachmentFile(filename)) continue;

      const ext = filename.split('.').pop().toLowerCase();
      let mime = 'application/octet-stream';
      if (['jpg', 'jpeg'].includes(ext)) mime = 'image/jpeg';
      else if (ext === 'png') mime = 'image/png';
      else if (ext === 'gif') mime = 'image/gif';
      else if (ext === 'webp') mime = 'image/webp';
      else if (ext === 'pdf') mime = 'application/pdf';

      const base64Content = await zipEntry.async('base64');
      if (base64Content.length > 40 * 1024 * 1024) continue; // Skip oversized

      const dataUrl = `data:${mime};base64,${base64Content}`;

      let canonicalId = manifestMap.get(filename.toLowerCase()) ||
                        extractCanonicalAttachmentId(filename);

      if (!canonicalId) canonicalId = filename;

      let payload = dataUrl;
      if (currentEncryptionKey) {
        payload = await encryptAttachmentData(dataUrl, currentEncryptionKey);
      }
      const canonicalKey = canonicalId.startsWith('att_') ? canonicalId : ('att_' + canonicalId);
      stagedEntries.push({ key: canonicalKey, value: payload });
    }

    if (stagedEntries.length > 0) {
      const idb = await openSRGDatabase();
      await new Promise((resolve, reject) => {
        const tx = idb.transaction('files', 'readwrite');
        const store = tx.objectStore('files');
        for (const entry of stagedEntries) {
          store.put(entry.value, entry.key);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Failed to commit attachments'));
      });
      importedCount = stagedEntries.length;
    }

    if (loadingToast) dismissToast(loadingToast);
    showToast(`✓ Successfully restored ${importedCount} attachment files into local storage!`, 'success', 5000);
    renderCurrentView();
    await updateStorageStatsUI();
  } catch (err) {
    if (loadingToast) dismissToast(loadingToast);
    console.error('Error importing attachments zip:', err);
    showToast('Failed to restore attachments zip: ' + err.message, 'error', 5000);
  }
}


/* ==========================================================================
   2. MASTER DATA & TITLE AUTOCOMPLETE
   ========================================================================== */

function loadMasterDataFromDb() {
  if (!db || typeof db.exec !== 'function') return;

  try {
    const catRows = db.exec('SELECT * FROM tag_categories ORDER BY sort_order ASC');
    tagMasterCategories = catRows.length > 0 ? rowsToObjects(catRows[0]) : [];

    const tagRows = db.exec('SELECT * FROM tags ORDER BY name ASC');
    tagMasterTags = tagRows.length > 0 ? rowsToObjects(tagRows[0]) : [];

    const fldRows = db.exec('SELECT * FROM tag_field_definitions');
    tagMasterFields = fldRows.length > 0 ? rowsToObjects(fldRows[0]) : [];

    renderAgendaTagFilterDropdown();
  } catch (err) {
    console.error('Failed to load master data from database:', err);
  }
}

let selectedAgendaTagIds = new Set();

function renderAgendaTagFilterDropdown() {
  const listEl = document.getElementById('agendaTagDropdownList');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (!tagMasterCategories || tagMasterCategories.length === 0) {
    listEl.innerHTML = '<div style="color:var(--text-muted); font-size:0.8rem; padding:8px;">No tags found.</div>';
    return;
  }

  tagMasterCategories.forEach(cat => {
    const catTags = tagMasterTags.filter(t => t.category_id === cat.id);
    if (catTags.length === 0) return;

    const groupDiv = document.createElement('div');
    groupDiv.className = 'tag-filter-category-group';

    const headerDiv = document.createElement('div');
    headerDiv.className = 'tag-filter-cat-header';

    const catNameSpan = document.createElement('span');
    catNameSpan.textContent = cat.name;

    const toggleAllBtn = document.createElement('button');
    toggleAllBtn.type = 'button';
    toggleAllBtn.className = 'cat-select-all-btn';
    const allSelected = catTags.every(t => selectedAgendaTagIds.has(t.id));
    toggleAllBtn.textContent = allSelected ? 'Deselect All' : 'Select All';
    toggleAllBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const shouldSelect = !catTags.every(t => selectedAgendaTagIds.has(t.id));
      catTags.forEach(t => {
        if (shouldSelect) selectedAgendaTagIds.add(t.id);
        else selectedAgendaTagIds.delete(t.id);
      });
      renderAgendaTagFilterDropdown();
      renderAgendaActiveTagsBar();
      renderAgendaView();
    });

    headerDiv.appendChild(catNameSpan);
    headerDiv.appendChild(toggleAllBtn);
    groupDiv.appendChild(headerDiv);

    const itemsGrid = document.createElement('div');
    itemsGrid.className = 'tag-filter-items-grid';

    catTags.forEach(t => {
      const isSelected = selectedAgendaTagIds.has(t.id);
      const label = document.createElement('label');
      label.className = `tag-filter-item ${isSelected ? 'active' : ''}`;
      label.innerHTML = `
        <input type="checkbox" ${isSelected ? 'checked' : ''} data-tag-id="${t.id}">
        <span style="color:${sanitizeColor(t.color, 'inherit')}">${escapeHtml(t.name)}</span>
      `;
      const chk = label.querySelector('input');
      chk.addEventListener('change', (e) => {
        e.stopPropagation();
        if (chk.checked) {
          selectedAgendaTagIds.add(t.id);
          label.classList.add('active');
        } else {
          selectedAgendaTagIds.delete(t.id);
          label.classList.remove('active');
        }
        updateAgendaTagFilterLabel();
        renderAgendaActiveTagsBar();
        renderAgendaView();
      });
      itemsGrid.appendChild(label);
    });

    groupDiv.appendChild(itemsGrid);
    listEl.appendChild(groupDiv);
  });

  updateAgendaTagFilterLabel();
  renderAgendaActiveTagsBar();
}

function updateAgendaTagFilterLabel() {
  const labelEl = document.getElementById('agendaTagFilterLabel');
  if (!labelEl) return;
  if (selectedAgendaTagIds.size === 0) {
    labelEl.textContent = 'Tags (All)';
  } else {
    labelEl.textContent = `Tags (${selectedAgendaTagIds.size})`;
  }
}

function renderAgendaActiveTagsBar() {
  const bar = document.getElementById('agendaActiveTagsBar');
  if (!bar) return;
  if (selectedAgendaTagIds.size === 0) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }

  bar.classList.remove('hidden');
  bar.innerHTML = '';

  const labelSpan = document.createElement('span');
  labelSpan.style.cssText = 'font-size:0.75rem; color:var(--text-muted); font-weight:600; margin-right:4px;';
  labelSpan.textContent = 'Active Filters:';
  bar.appendChild(labelSpan);

  selectedAgendaTagIds.forEach(tid => {
    const tObj = tagMasterTags.find(t => t.id === tid);
    if (!tObj) return;

    const chip = document.createElement('span');
    chip.className = 'active-tag-chip';
    if (tObj.color) {
      chip.style.borderColor = tObj.color;
      chip.style.color = tObj.color;
      chip.style.background = `${tObj.color}25`;
    }
    chip.innerHTML = `<span>${escapeHtml(tObj.name)}</span><span class="remove-chip-btn">&times;</span>`;
    chip.querySelector('.remove-chip-btn').addEventListener('click', () => {
      selectedAgendaTagIds.delete(tid);
      renderAgendaTagFilterDropdown();
      renderAgendaActiveTagsBar();
      renderAgendaView();
    });
    bar.appendChild(chip);
  });

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'agenda-active-tags-clear-btn';
  clearBtn.textContent = 'Clear All';
  clearBtn.addEventListener('click', () => {
    selectedAgendaTagIds.clear();
    renderAgendaTagFilterDropdown();
    renderAgendaActiveTagsBar();
    renderAgendaView();
  });
  bar.appendChild(clearBtn);
}

function populateTitlesDatalist() {
  if (!db) return;
  const datalist = document.getElementById('previousTitlesDatalist');
  datalist.innerHTML = '';
  try {
    const res = db.exec("SELECT DISTINCT title FROM schedules WHERE title IS NOT NULL AND title != '' ORDER BY title ASC");
    if (res.length > 0) {
      res[0].values.forEach(valArr => {
        const opt = document.createElement('option');
        opt.value = valArr[0];
        datalist.appendChild(opt);
      });
    }
  } catch (e) {
    console.warn('Error populating titles datalist:', e);
  }
}

function rowsToObjects(res) {
  const columns = res.columns;
  return res.values.map(valArr => {
    const obj = {};
    columns.forEach((col, idx) => {
      obj[col] = valArr[idx];
    });
    return obj;
  });
}

function updateBadge(text, isDrive = false) {
  const badge = document.getElementById('sourceBadge');
  if (badge) {
    badge.textContent = text;
    badge.style.color = isDrive ? '#38bdf8' : '#10b981';
  }
}

/* ==========================================================================
   3. CALENDAR & AGENDA VIEWS RENDERING
   ========================================================================== */

function autoCompletePastSchedules() {
  // Pure pull architecture: No local DB write operations.
  // Completed/past schedule state is rendered dynamically from timestamps.
}

function renderCurrentView() {
  autoCompletePastSchedules();
  updateNavHeader();
  if (currentView === 'calendar') {
    renderMonthView();
  } else if (currentView === 'month') {
    renderPortraitMonthView();
  } else if (currentView === 'day') {
    renderDayView();
  } else {
    renderAgendaView();
  }
  updateSelectionBar();
}

function switchToView(viewName, targetDate = null) {
  currentView = viewName;
  lsSet('srg_current_view', viewName);
  if (targetDate) {
    currentDate = (targetDate instanceof Date) ? targetDate : new Date(targetDate);
  } else if (!currentDate || isNaN(currentDate.getTime())) {
    currentDate = new Date();
  }
  document.querySelectorAll('.view-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === viewName);
  });
  document.getElementById('monthView').classList.toggle('active', viewName === 'calendar');
  document.getElementById('portraitMonthView').classList.toggle('active', viewName === 'month');
  document.getElementById('dayView').classList.toggle('active', viewName === 'day');
  document.getElementById('agendaView').classList.toggle('active', viewName === 'agenda');
  renderCurrentView();
}

function updateNavHeader() {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const yr = currentDate.getFullYear();
  const mName = months[currentDate.getMonth()];

  if (currentView === 'day') {
    const dayOfWeek = dayNames[currentDate.getDay()];
    const indianDate = formatDateIndian(currentDate);
    document.getElementById('currentPeriodTitle').textContent = `${dayOfWeek}, ${indianDate}`;
  } else {
    document.getElementById('currentPeriodTitle').textContent = `${mName} ${yr}`;
  }
}

/* ==========================================================================
   SIDE NAVIGATION DRAWER & THEME MANAGEMENT
   ========================================================================== */

function openSideMenu() {
  const drawer = document.getElementById('sideMenuDrawer');
  const backdrop = document.getElementById('sideMenuBackdrop');
  if (drawer) drawer.classList.remove('closed');
  if (backdrop) backdrop.classList.remove('hidden');
  updateInstallButtonState();
}

function closeSideMenu() {
  const drawer = document.getElementById('sideMenuDrawer');
  const backdrop = document.getElementById('sideMenuBackdrop');
  if (drawer) drawer.classList.add('closed');
  if (backdrop) backdrop.classList.add('hidden');
}

function toggleSideMenu() {
  const drawer = document.getElementById('sideMenuDrawer');
  if (drawer && drawer.classList.contains('closed')) {
    openSideMenu();
  } else {
    closeSideMenu();
  }
}

function initAppTheme() {
  document.documentElement.setAttribute('data-theme', currentTheme);
  const icon = document.getElementById('themeToggleIcon');
  if (icon) {
    icon.className = currentTheme === 'light' ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
  }
  const drawerThemeText = document.getElementById('drawerThemeText');
  if (drawerThemeText) {
    drawerThemeText.textContent = currentTheme === 'light' ? 'Switch to Dark Theme' : 'Switch to Light Theme';
  }
}

function toggleAppTheme() {
  currentTheme = currentTheme === 'light' ? 'dark' : 'light';
  lsSet('srg_theme', currentTheme);
  initAppTheme();
  showToast(`Switched to ${currentTheme.toUpperCase()} theme`, 'info');
}

/* ==========================================================================
   WEB CRYPTO (AES-256-GCM + PBKDF2) DATABASE & ATTACHMENT ENCRYPTION AT REST
   ========================================================================== */

const CRYPTO_MAGIC_V1 = new Uint8Array([0x53, 0x52, 0x47, 0x45, 0x31]); // "SRGE1" (Legacy v1, 100k iterations)
const CRYPTO_MAGIC_V2 = new Uint8Array([0x53, 0x52, 0x47, 0x45, 0x32]); // "SRGE2" (Modern v2, 600k iterations + iteration count in header)
// "SRGE3": encrypted with the random data key (DEK). Layout: MAGIC (5) + DEK ID (16) + IV (12) + CIPHERTEXT.
// It has no salt because no PIN is involved; a distinct magic stops any code path from trying PIN keys on it.
const CRYPTO_MAGIC_V3 = new Uint8Array([0x53, 0x52, 0x47, 0x45, 0x33]);
const CRYPTO_MAGIC = CRYPTO_MAGIC_V2; // PIN-derived format, still used for exported backups
const ATTACHMENT_CRYPTO_MAGIC = new Uint8Array([0x53, 0x52, 0x47, 0x41, 0x54, 0x54, 0x31]); // "SRGATT1"
const PBKDF2_ITERATIONS = 600000; // OWASP recommendation for PBKDF2-HMAC-SHA256
const PBKDF2_LEGACY_ITERATIONS = 100000;
let currentEncryptionKey = null; // in envelope mode this is the DEK (non-extractable)
let currentEncryptionSalt = null; // legacy (pre-envelope) mode only
let currentDekId = null; // set only while the DEK is the active key; selects the SRGE3 format on save

// IndexedDB 'files' keys that hold keys, tokens or the database rather than attachments.
const RESERVED_FILE_KEYS = new Set([
  'active_sqlite', 'srg_bio_key_token', 'srg_recovery_vault', 'srg_crypto_salt', 'srg_crypto_auth_token',
  'srg_key_envelope', 'srg_legacy_active_sqlite', 'srg_legacy_recovery_vault'
]);

const SQLITE_MAGIC = new Uint8Array([
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00
]); // "SQLite format 3\0"

function isValidSqliteBinary(bytes) {
  if (!bytes) return false;
  let u8 = null;
  if (bytes instanceof Uint8Array) {
    u8 = bytes;
  } else if (bytes instanceof ArrayBuffer) {
    u8 = new Uint8Array(bytes);
  } else if (ArrayBuffer.isView(bytes)) {
    u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } else {
    return false;
  }
  if (u8.length < SQLITE_MAGIC.length) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (u8[i] !== SQLITE_MAGIC[i]) return false;
  }
  return true;
}

function isEncryptedDbBytes(data) {
  if (!data) return false;
  let bytes = null;
  if (data instanceof Uint8Array) {
    bytes = data;
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else if (ArrayBuffer.isView(data)) {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else {
    return false;
  }
  if (bytes.length < 33) return false;
  if (matchMagic(bytes, CRYPTO_MAGIC_V3)) return bytes.length >= 33 + 16;
  // Check SRGE2 (Header: MAGIC (5) + ITERATIONS (4) + SALT (16) + IV (12) = 37 bytes)
  let isV2 = true;
  for (let i = 0; i < CRYPTO_MAGIC_V2.length; i++) {
    if (bytes[i] !== CRYPTO_MAGIC_V2[i]) { isV2 = false; break; }
  }
  if (isV2 && bytes.length >= 37) return true;

  // Check SRGE1 (Header: MAGIC (5) + SALT (16) + IV (12) = 33 bytes)
  let isV1 = true;
  for (let i = 0; i < CRYPTO_MAGIC_V1.length; i++) {
    if (bytes[i] !== CRYPTO_MAGIC_V1[i]) { isV1 = false; break; }
  }
  return isV1;
}

function parseEncryptedDbHeader(data) {
  if (!data || !isEncryptedDbBytes(data)) return null;
  let bytes = null;
  if (data instanceof Uint8Array) {
    bytes = data;
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else if (ArrayBuffer.isView(data)) {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else {
    return null;
  }

  if (matchMagic(bytes, CRYPTO_MAGIC_V3)) {
    const ivStart = CRYPTO_MAGIC_V3.length + 16; // 21
    return {
      version: 3,
      iterations: 0,
      salt: null, // not PIN-derived: nothing to feed PBKDF2
      keyId: bytes.slice(CRYPTO_MAGIC_V3.length, ivStart),
      aad: bytes.slice(0, ivStart), // magic + key id are authenticated, so a swapped header fails to decrypt
      iv: bytes.slice(ivStart, ivStart + 12),
      ciphertext: bytes.slice(ivStart + 12)
    };
  }

  let isV2 = true;
  for (let i = 0; i < CRYPTO_MAGIC_V2.length; i++) {
    if (bytes[i] !== CRYPTO_MAGIC_V2[i]) { isV2 = false; break; }
  }

  if (isV2) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const iterations = view.getUint32(CRYPTO_MAGIC_V2.length, false) || PBKDF2_ITERATIONS;
    const saltStart = CRYPTO_MAGIC_V2.length + 4; // 9
    const ivStart = saltStart + 16; // 25
    const cipherStart = ivStart + 12; // 37
    return {
      version: 2,
      iterations: iterations,
      salt: bytes.slice(saltStart, ivStart),
      iv: bytes.slice(ivStart, cipherStart),
      ciphertext: bytes.slice(cipherStart)
    };
  }

  // Legacy V1 (SRGE1)
  const saltStart = CRYPTO_MAGIC_V1.length; // 5
  const ivStart = saltStart + 16; // 21
  const cipherStart = ivStart + 12; // 33
  return {
    version: 1,
    iterations: PBKDF2_LEGACY_ITERATIONS,
    salt: bytes.slice(saltStart, ivStart),
    iv: bytes.slice(ivStart, cipherStart),
    ciphertext: bytes.slice(cipherStart)
  };
}

function isEncryptedAttachmentBytes(data) {
  if (!data) return false;
  let bytes = null;
  if (data instanceof Uint8Array) {
    bytes = data;
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  }
  if (!bytes || bytes.length < ATTACHMENT_CRYPTO_MAGIC.length + 12 + 16) return false;
  for (let i = 0; i < ATTACHMENT_CRYPTO_MAGIC.length; i++) {
    if (bytes[i] !== ATTACHMENT_CRYPTO_MAGIC[i]) return false;
  }
  return true;
}

function bufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Extract salt directly from database bytes header
function extractSaltFromEncryptedDbBytes(bytes) {
  const parsed = parseEncryptedDbHeader(bytes);
  return parsed ? parsed.salt : null;
}

// Get stored crypto salt with multi-tier fallback:
// 1. Current active in-memory encryption salt (highest priority)
// 2. localStorage cache
// 3. Encrypted database header in memory (cachedEncryptedDbBytes)
// 4. Fallback to null
function getStoredCryptoSalt() {
  if (currentEncryptionSalt && currentEncryptionSalt.length === 16) {
    return currentEncryptionSalt;
  }
  const b64 = localStorage.getItem('srg_crypto_salt');
  if (b64) {
    try {
      const u8 = base64ToBuffer(b64);
      if (u8 && u8.length === 16) return u8;
    } catch(e) {}
  }
  if (cachedEncryptedDbBytes && isEncryptedDbBytes(cachedEncryptedDbBytes)) {
    const salt = extractSaltFromEncryptedDbBytes(cachedEncryptedDbBytes);
    if (salt) return salt;
  }
  return null;
}

// Asynchronous multi-tier salt retrieval (active in-memory -> localStorage -> IndexedDB files -> database header)
async function getEffectiveCryptoSalt(dbBytes = null) {
  if (currentEncryptionSalt && currentEncryptionSalt.length === 16) {
    return currentEncryptionSalt;
  }
  const b64 = localStorage.getItem('srg_crypto_salt');
  if (b64) {
    try {
      const u8 = base64ToBuffer(b64);
      if (u8 && u8.length === 16) return u8;
    } catch(e) {}
  }
  try {
    const idb = await openSRGDatabase();
    const tx = idb.transaction('files', 'readonly');
    const store = tx.objectStore('files');
    const req = store.get('srg_crypto_salt');
    const res = await new Promise((resolve) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    if (res instanceof Uint8Array && res.length === 16) return res;
    if (res instanceof ArrayBuffer && res.byteLength === 16) return new Uint8Array(res);
  } catch(e) {}

  const bytes = dbBytes || cachedEncryptedDbBytes;
  if (bytes && isEncryptedDbBytes(bytes)) {
    const salt = extractSaltFromEncryptedDbBytes(bytes);
    if (salt) return salt;
  }
  return getStoredCryptoSalt();
}

function storeCryptoSalt(saltBytes) {
  if (!saltBytes) return;
  try {
    lsSet('srg_crypto_salt', bufferToBase64(saltBytes));
  } catch(e) {
    console.warn('Could not cache crypto salt to localStorage:', e);
  }
}

// Systematically gathers and deduplicates ALL distinct candidate salts and iteration counts
// across every storage tier (header, localStorage, IndexedDB files, IndexedDB snapshots, and recovery vault)
async function getAllCandidateCryptoConfigs(dbBytes = null) {
  const bytes = dbBytes || cachedEncryptedDbBytes || (await loadDbFromIndexedDB());
  const distinctSalts = new Map(); // hex -> { salt: Uint8Array, iterationsHint?: number, source: string }

  function addCandidateSalt(saltInput, source, iterationsHint = null) {
    if (!saltInput) return;
    let u8 = null;
    if (saltInput instanceof Uint8Array) u8 = saltInput;
    else if (saltInput instanceof ArrayBuffer) u8 = new Uint8Array(saltInput);
    else if (ArrayBuffer.isView(saltInput)) u8 = new Uint8Array(saltInput.buffer, saltInput.byteOffset, saltInput.byteLength);
    if (!u8 || u8.length !== 16) return;
    const hex = Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join('');
    if (!distinctSalts.has(hex)) {
      distinctSalts.set(hex, { salt: u8, source, iterationsHint });
    }
  }

  // 1. Current active in-memory encryption salt (if present)
  if (currentEncryptionSalt) {
    addCandidateSalt(currentEncryptionSalt, 'in_memory_currentEncryptionSalt', PBKDF2_ITERATIONS);
  }

  // 2. Salt from active database header (if encrypted)
  if (bytes && isEncryptedDbBytes(bytes)) {
    const parsed = parseEncryptedDbHeader(bytes);
    if (parsed && parsed.salt) {
      addCandidateSalt(parsed.salt, 'active_db_header', parsed.iterations);
    }
  }

  // 3. Salt from localStorage 'srg_crypto_salt'
  try {
    const lsB64 = localStorage.getItem('srg_crypto_salt');
    if (lsB64) {
      const u8 = base64ToBuffer(lsB64);
      if (u8 && u8.length === 16) addCandidateSalt(u8, 'localStorage');
    }
  } catch(e) {}

  // 4. Salt from IndexedDB 'files' store 'srg_crypto_salt'
  try {
    const idb = await openSRGDatabase();
    const tx = idb.transaction('files', 'readonly');
    const store = tx.objectStore('files');
    const req = store.get('srg_crypto_salt');
    const idbSalt = await new Promise(r => {
      req.onsuccess = () => r(req.result);
      req.onerror = () => r(null);
    });
    if (idbSalt) addCandidateSalt(idbSalt, 'indexedDB_files');
  } catch(e) {}

  // 5. Salts from all snapshots in IndexedDB 'snapshots' store
  try {
    const idb = await openSRGDatabase();
    const tx = idb.transaction('snapshots', 'readonly');
    const sStore = tx.objectStore('snapshots');
    const sReq = sStore.getAll();
    const snaps = await new Promise(r => {
      sReq.onsuccess = () => r(sReq.result);
      sReq.onerror = () => r(null);
    });
    if (Array.isArray(snaps)) {
      snaps.forEach((snap, idx) => {
        if (snap && snap.data && isEncryptedDbBytes(snap.data)) {
          const sSalt = extractSaltFromEncryptedDbBytes(snap.data);
          if (sSalt) {
            const parsed = parseEncryptedDbHeader(snap.data);
            addCandidateSalt(sSalt, `snapshot_${snap.id || idx}`, parsed ? parsed.iterations : null);
          }
        }
      });
    }
  } catch(e) {}

  // 6. Salt from recovery vault if present
  try {
    const vaultBytes = await getStoredRecoveryVaultBytes();
    if (vaultBytes && vaultBytes.length >= 7 + 16) {
      const vSalt = vaultBytes.slice(7, 23);
      if (vSalt.length === 16) addCandidateSalt(vSalt, 'recovery_vault');
    }
  } catch(e) {}

  // Build ordered candidate configs: test each salt with PBKDF2_ITERATIONS (600k) and PBKDF2_LEGACY_ITERATIONS (100k)
  const configs = [];
  const seenConfig = new Set();

  for (const [hex, item] of distinctSalts.entries()) {
    const itersToTest = [];
    if (item.iterationsHint) itersToTest.push(item.iterationsHint);
    if (!itersToTest.includes(PBKDF2_ITERATIONS)) itersToTest.push(PBKDF2_ITERATIONS);
    if (!itersToTest.includes(PBKDF2_LEGACY_ITERATIONS)) itersToTest.push(PBKDF2_LEGACY_ITERATIONS);

    for (const iter of itersToTest) {
      const keyStr = `${hex}_${iter}`;
      if (!seenConfig.has(keyStr)) {
        seenConfig.add(keyStr);
        configs.push({ salt: item.salt, iterations: iter, source: item.source });
      }
    }
  }

  return configs;
}

async function deriveKeyFromPin(pin, salt, iterations = PBKDF2_ITERATIONS, extractable = false) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(pin),
    'PBKDF2',
    false,
    ['deriveKey', 'deriveBits']
  );
  return await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: iterations,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt']
  );
}

async function deriveRawKeyBitsFromPin(pin, salt, iterations = PBKDF2_ITERATIONS) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(pin),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: iterations,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

async function importRuntimeAesGcmKey(rawKeyBytes) {
  return await crypto.subtle.importKey(
    'raw',
    rawKeyBytes,
    { name: 'AES-GCM' },
    false, // strictly non-extractable runtime key!
    ['encrypt', 'decrypt']
  );
}

async function buildAuthVerificationTokenPackedBytes(key) {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const tokenCipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    enc.encode('SRG_CALENDAR_AUTHENTICATED')
  );
  const packed = new Uint8Array(iv.length + tokenCipher.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(tokenCipher), iv.length);
  return packed;
}

async function createAuthVerificationToken(key, saltBytes = null) {
  try {
    const packed = await buildAuthVerificationTokenPackedBytes(key);
    const saltToStore = saltBytes || getStoredCryptoSalt();
    try {
      const idb = await openSRGDatabase();
      await new Promise((resolve, reject) => {
        const tx = idb.transaction('files', 'readwrite');
        const store = tx.objectStore('files');
        store.put(packed, 'srg_crypto_auth_token');
        if (saltToStore) {
          store.put(saltToStore, 'srg_crypto_salt');
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch(e) {}
    try {
      lsSet('srg_crypto_auth_token', bufferToBase64(packed));
    } catch(e) {}
    return packed;
  } catch(e) {
    console.warn('Failed to save auth verification token:', e);
    return null;
  }
}

async function getStoredAuthVerificationTokenBytes() {
  const b64 = localStorage.getItem('srg_crypto_auth_token');
  if (b64) {
    try {
      return base64ToBuffer(b64);
    } catch(e) {}
  }
  try {
    const idb = await openSRGDatabase();
    const tx = idb.transaction('files', 'readonly');
    const store = tx.objectStore('files');
    const req = store.get('srg_crypto_auth_token');
    const res = await new Promise((resolve) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    if (res instanceof Uint8Array) return res;
    if (res instanceof ArrayBuffer) return new Uint8Array(res);
  } catch(e) {}
  return null;
}

async function verifyPinWithAuthToken(pin) {
  if (!pin) return false;
  // Envelope mode: only the current PIN wrapper counts. The legacy token and salts stay on disk untouched
  // (never deleted), so consulting them here would let an old PIN pass.
  const env = await loadKeyEnvelope();
  if (env) {
    try {
      (await unwrapDekWithPin(env, pin)).fill(0);
      return true;
    } catch (e) {
      return false;
    }
  }
  const dbBytes = cachedEncryptedDbBytes || await loadDbFromIndexedDB();
  const candidateConfigs = await getAllCandidateCryptoConfigs(dbBytes);
  const tokenBytes = await getStoredAuthVerificationTokenBytes();

  const trimmedPin = pin.trim();
  const pinsToTry = [trimmedPin];
  if (pin !== trimmedPin) pinsToTry.push(pin);

  for (const p of pinsToTry) {
    for (const config of candidateConfigs) {
      try {
        const key = await deriveKeyFromPin(p, config.salt, config.iterations, false);
        // Primary check: try auth verification token
        if (tokenBytes && tokenBytes.length >= 28) {
          try {
            const iv = tokenBytes.slice(0, 12);
            const ciphertext = tokenBytes.slice(12);
            const decrypted = await crypto.subtle.decrypt(
              { name: 'AES-GCM', iv: iv },
              key,
              ciphertext
            );
            const str = new TextDecoder().decode(decrypted);
            if (str === 'SRG_CALENDAR_AUTHENTICATED') return true;
          } catch(tokenErr) {}
        }

        // Cryptographic ground truth: test-decrypt the database header directly
        if (dbBytes && isEncryptedDbBytes(dbBytes)) {
          try {
            const testBytes = await decryptDatabaseBytes(dbBytes, key, false);
            if (isValidSqliteBinary(testBytes)) return true;
          } catch(dbErr) {}
        }
      } catch(e) {}
    }
  }
  return false;
}

async function encryptWithKeyAndSalt(rawBytes, key, salt, iterations = PBKDF2_ITERATIONS) {
  if (!key) throw new Error('No encryption key provided');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    rawBytes
  );
  const ciphertext = new Uint8Array(ciphertextBuffer);

  // Packed V2 layout: MAGIC (5) + ITERATIONS (4 bytes BE) + SALT (16) + IV (12) + CIPHERTEXT
  const packed = new Uint8Array(CRYPTO_MAGIC_V2.length + 4 + salt.length + iv.length + ciphertext.length);
  packed.set(CRYPTO_MAGIC_V2, 0);
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  view.setUint32(CRYPTO_MAGIC_V2.length, iterations, false);
  packed.set(salt, CRYPTO_MAGIC_V2.length + 4);
  packed.set(iv, CRYPTO_MAGIC_V2.length + 4 + salt.length);
  packed.set(ciphertext, CRYPTO_MAGIC_V2.length + 4 + salt.length + iv.length);
  return packed;
}

async function encryptWithDek(rawBytes, dekKey, dekId) {
  if (!dekKey || !dekId || dekId.length !== 16) throw new Error('No data key active');
  const header = new Uint8Array(CRYPTO_MAGIC_V3.length + 16);
  header.set(CRYPTO_MAGIC_V3, 0);
  header.set(dekId, CRYPTO_MAGIC_V3.length);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, dekKey, rawBytes));
  const packed = new Uint8Array(header.length + iv.length + ciphertext.length);
  packed.set(header, 0);
  packed.set(iv, header.length);
  packed.set(ciphertext, header.length + iv.length);
  return packed;
}

async function encryptDatabaseBytes(rawBytes) {
  if (!currentEncryptionKey) {
    throw new Error('No encryption key active');
  }
  if (currentDekId) {
    return await encryptWithDek(rawBytes, currentEncryptionKey, currentDekId);
  }
  let salt = currentEncryptionSalt || getStoredCryptoSalt();
  if (!salt) {
    salt = crypto.getRandomValues(new Uint8Array(16));
    currentEncryptionSalt = salt;
    storeCryptoSalt(salt);
  }
  return await encryptWithKeyAndSalt(rawBytes, currentEncryptionKey, salt, PBKDF2_ITERATIONS);
}

async function decryptDatabaseBytes(encryptedBytes, pinOrKey, setActiveKey = false) {
  if (!isEncryptedDbBytes(encryptedBytes)) {
    return encryptedBytes;
  }

  const parsed = parseEncryptedDbHeader(encryptedBytes);
  if (!parsed) {
    throw new Error('Invalid or corrupted database encryption header');
  }
  const { salt, iv, ciphertext, iterations, version } = parsed;

  let key = null;
  if (typeof pinOrKey === 'string') {
    if (version === 3) throw new Error('This file is locked with the device data key, not directly with a PIN.');
    key = await deriveKeyFromPin(pinOrKey, salt, iterations, false);
  } else if (pinOrKey instanceof CryptoKey) {
    key = pinOrKey;
  } else {
    throw new Error('Invalid key or PIN provided for decryption');
  }

  const params = { name: 'AES-GCM', iv: iv };
  if (version === 3) params.additionalData = parsed.aad;
  const decryptedBuffer = await crypto.subtle.decrypt(params, key, ciphertext);

  if (setActiveKey) {
    currentEncryptionKey = key;
    storeCryptoSalt(salt);
  }

  return new Uint8Array(decryptedBuffer);
}

async function encryptAttachmentData(plainDataUrl, key = currentEncryptionKey) {
  if (!key || typeof plainDataUrl !== 'string') return plainDataUrl;
  const enc = new TextEncoder();
  const rawBytes = enc.encode(plainDataUrl);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    rawBytes
  );
  const ciphertext = new Uint8Array(ciphertextBuffer);
  const packed = new Uint8Array(ATTACHMENT_CRYPTO_MAGIC.length + iv.length + ciphertext.length);
  packed.set(ATTACHMENT_CRYPTO_MAGIC, 0);
  packed.set(iv, ATTACHMENT_CRYPTO_MAGIC.length);
  packed.set(ciphertext, ATTACHMENT_CRYPTO_MAGIC.length + iv.length);
  return packed;
}

async function decryptAttachmentData(storedVal, key = currentEncryptionKey) {
  if (!storedVal) return storedVal;
  // If stored as plaintext string starting with data:
  if (typeof storedVal === 'string') {
    if (storedVal.startsWith('data:') || !key) return storedVal;
    try {
      const buf = base64ToBuffer(storedVal);
      if (isEncryptedAttachmentBytes(buf)) {
        return await decryptAttachmentData(buf, key);
      }
    } catch(e) {}
    return storedVal;
  }
  let bytes = storedVal instanceof Uint8Array ? storedVal : new Uint8Array(storedVal);
  if (!isEncryptedAttachmentBytes(bytes)) {
    try {
      const dec = new TextDecoder().decode(bytes);
      if (dec.startsWith('data:')) return dec;
    } catch(e) {}
    return storedVal;
  }
  if (!key) {
    console.warn('Cannot decrypt attachment: No active encryption key');
    return null;
  }
  const ivStart = ATTACHMENT_CRYPTO_MAGIC.length;
  const cipherStart = ivStart + 12;
  const iv = bytes.slice(ivStart, cipherStart);
  const ciphertext = bytes.slice(cipherStart);
  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    ciphertext
  );
  return new TextDecoder().decode(decryptedBuffer);
}

/* ==========================================================================
   ENVELOPE ENCRYPTION: ONE RANDOM DATA KEY (DEK), SEVERAL WRAPPERS
   ========================================================================== */
// Why: when data was encrypted directly with a PIN-derived key, every re-salt or PIN change had to
// re-encrypt everything, and the fingerprint token, database and attachments drifted onto different
// keys (the v1.3.9-v1.3.13 lock-out). Now a random 256-bit DEK encrypts the data once and never changes.
// The PIN, the fingerprint token and the recovery key each only wrap (encrypt) that same DEK, so changing
// the PIN rewrites a 48-byte wrapper and nothing else.
const KEY_ENVELOPE_FORMAT = 'SRGKEY1';
const KEY_CHECK_PLAINTEXT = 'SRG_CALENDAR_DEK_CHECK';
let keyEnvelope = null; // last loaded envelope (no secrets: only wrapped key material)

function u8Equal(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function toU8(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return null;
}

function hexOf(bytes, n = 8) {
  return Array.from(bytes || []).slice(0, n).map(b => b.toString(16).padStart(2, '0')).join('');
}

// localStorage can only hold strings, so the cached copy is JSON with base64 fields.
function envelopeToJson(env) {
  return JSON.stringify({
    format: env.format,
    dekId: bufferToBase64(env.dekId),
    check: bufferToBase64(env.check),
    pin: { salt: bufferToBase64(env.pin.salt), iterations: env.pin.iterations, iv: bufferToBase64(env.pin.iv), wrapped: bufferToBase64(env.pin.wrapped) },
    created: env.created,
    pinChanged: env.pinChanged
  });
}

function envelopeFromJson(json) {
  const o = JSON.parse(json);
  return {
    format: o.format,
    dekId: base64ToBuffer(o.dekId),
    check: base64ToBuffer(o.check),
    pin: { salt: base64ToBuffer(o.pin.salt), iterations: o.pin.iterations, iv: base64ToBuffer(o.pin.iv), wrapped: base64ToBuffer(o.pin.wrapped) },
    created: o.created,
    pinChanged: o.pinChanged
  };
}

function isValidEnvelope(env) {
  return !!(env && env.format === KEY_ENVELOPE_FORMAT && toU8(env.dekId)?.length === 16 && env.pin &&
    toU8(env.pin.salt)?.length === 16 && toU8(env.pin.iv)?.length === 12 && toU8(env.pin.wrapped) && toU8(env.check));
}

function normalizeEnvelope(env) {
  return {
    format: env.format,
    dekId: toU8(env.dekId),
    check: toU8(env.check),
    pin: { salt: toU8(env.pin.salt), iterations: env.pin.iterations, iv: toU8(env.pin.iv), wrapped: toU8(env.pin.wrapped) },
    created: env.created,
    pinChanged: env.pinChanged
  };
}

// IndexedDB is the primary copy; the localStorage copy is only a fallback cache.
async function loadKeyEnvelope() {
  let env = null;
  try {
    const idb = await openSRGDatabase();
    const res = await new Promise((resolve) => {
      const req = idb.transaction('files', 'readonly').objectStore('files').get('srg_key_envelope');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    if (isValidEnvelope(res)) env = normalizeEnvelope(res);
  } catch (e) {}
  if (!env) {
    try {
      const json = localStorage.getItem('srg_key_envelope');
      if (json) {
        const parsed = envelopeFromJson(json);
        if (isValidEnvelope(parsed)) env = parsed;
      }
    } catch (e) {}
  }
  keyEnvelope = env;
  return env;
}

function cacheKeyEnvelopeLocally(env) {
  // A stale cached wrapper would still open the DEK with the OLD PIN, so drop it if it can't be updated.
  if (!lsSet('srg_key_envelope', envelopeToJson(env))) {
    try { localStorage.removeItem('srg_key_envelope'); } catch (e) {}
  }
}

async function saveKeyEnvelope(env) {
  const idb = await openSRGDatabase();
  await new Promise((resolve, reject) => {
    const tx = idb.transaction('files', 'readwrite');
    tx.objectStore('files').put(env, 'srg_key_envelope');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Could not save the key envelope'));
    tx.onabort = () => reject(tx.error || new Error('Key envelope transaction aborted'));
  });
  cacheKeyEnvelopeLocally(env);
  keyEnvelope = env;
}

// The KEK comes from PBKDF2 with its own salt (never shared with backups). The DEK id is bound as
// additional authenticated data so a wrapper can't be moved onto a different envelope unnoticed.
async function wrapDekWithPin(rawDek, dekId, pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const kek = await deriveKeyFromPin(pin, salt, PBKDF2_ITERATIONS, false);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: dekId }, kek, rawDek));
  return { salt, iterations: PBKDF2_ITERATIONS, iv, wrapped };
}

// Returns the raw DEK bytes (caller must zero them) or throws if the PIN is wrong.
async function unwrapDekWithPin(env, pin) {
  const attempts = [pin];
  if (typeof pin === 'string' && pin.trim() !== pin) attempts.unshift(pin.trim());
  let lastErr = null;
  for (const p of attempts) {
    try {
      const kek = await deriveKeyFromPin(p, env.pin.salt, env.pin.iterations || PBKDF2_ITERATIONS, false);
      const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: env.pin.iv, additionalData: env.dekId }, kek, env.pin.wrapped);
      return new Uint8Array(raw);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Incorrect Security PIN');
}

async function buildDekCheck(dekKey, dekId) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: dekId }, dekKey, new TextEncoder().encode(KEY_CHECK_PLAINTEXT)));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return packed;
}

// Proves that a key from the fingerprint token or recovery vault really is this envelope's DEK,
// rather than an older PIN-derived key from before the upgrade.
async function isDekForEnvelope(dekKey, env) {
  try {
    const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: env.check.slice(0, 12), additionalData: env.dekId }, dekKey, env.check.slice(12));
    return new TextDecoder().decode(out) === KEY_CHECK_PLAINTEXT;
  } catch (e) {
    return false;
  }
}

// Creates a new DEK and an envelope with a PIN wrapper. Returns the raw DEK too, because the
// recovery vault and fingerprint token must wrap it; the caller zeroes it when done.
async function createDekEnvelope(pin) {
  const rawDek = crypto.getRandomValues(new Uint8Array(32));
  const dekId = crypto.getRandomValues(new Uint8Array(16));
  const dekKey = await importRuntimeAesGcmKey(rawDek);
  const now = new Date().toISOString();
  const env = {
    format: KEY_ENVELOPE_FORMAT,
    dekId,
    check: await buildDekCheck(dekKey, dekId),
    pin: await wrapDekWithPin(rawDek, dekId, pin),
    created: now,
    pinChanged: now
  };
  return { env, rawDek, dekKey, dekId };
}

function activateDek(dekKey, dekId) {
  currentEncryptionKey = dekKey;
  currentDekId = dekId;
  currentEncryptionSalt = null;
}

/* ---------- Post-unlock integrity check ---------- */
// Runs in the background after every unlock: each attachment a schedule refers to must open with the
// key in memory. A silent mismatch is exactly how the earlier lock-out went unnoticed for weeks.
let lastIntegrityCheck = null; // { at, checked, ok, notOpening: [], missing: [], plain }

function findStoredAttachmentForRef(att, stored, byKey) {
  const names = new Set();
  [att.id, att.filename, att.name].filter(Boolean).forEach(n => {
    names.add(String(n).toLowerCase());
    names.add('att_' + String(n).toLowerCase());
  });
  const exact = Array.from(names).map(n => byKey.get(n)).find(Boolean);
  if (exact) return exact;
  const targets = [att.id, att.filename, att.name].filter(Boolean).map(s => String(s).toLowerCase()).filter(s => s.length >= 4);
  return stored.find(f => { const k = f.key.toLowerCase(); return targets.some(t => k.includes(t) || t.includes(k.replace(/^att_/, ''))); }) || null;
}

async function runPostUnlockIntegrityCheck() {
  if (!currentEncryptionKey || !db) return null;
  const key = currentEncryptionKey;
  const result = { at: new Date().toISOString(), checked: 0, ok: 0, plain: 0, notOpening: [], missing: [] };
  try {
    const files = (await diagReadAllFiles()).filter(f => !RESERVED_FILE_KEYS.has(f.key));
    const byKey = new Map(files.map(f => [f.key.toLowerCase(), f]));
    for (const att of getActiveScheduleAttachmentsMap().values()) {
      if (key !== currentEncryptionKey) return null; // locked or re-keyed meanwhile
      result.checked++;
      const label = att.id || att.name || '?';
      const hit = findStoredAttachmentForRef(att, files, byKey);
      if (!hit) { result.missing.push(label); continue; }
      if (!isEncryptedAttachmentBytes(hit.value)) { result.plain++; result.ok++; continue; }
      try {
        const out = await diagWithTimeout(decryptAttachmentData(hit.value, key), 10000, 'Decrypt');
        if (out) result.ok++; else result.notOpening.push(label);
      } catch (e) {
        result.notOpening.push(label);
      }
    }
  } catch (e) {
    console.warn('Integrity check could not run:', e);
    return null;
  }
  lastIntegrityCheck = result;
  if (result.notOpening.length || result.missing.length) {
    console.warn(`Integrity check: ${result.checked} ticket(s) checked — ${result.notOpening.length} do not open with the data key` +
      `${result.notOpening.length ? ' [' + result.notOpening.map(diagMask).join(', ') + ']' : ''}, ${result.missing.length} missing` +
      `${result.missing.length ? ' [' + result.missing.map(diagMask).join(', ') + ']' : ''}.`);
    const parts = [];
    if (result.notOpening.length) parts.push(`${result.notOpening.length} attachment(s) cannot be opened with your data key`);
    if (result.missing.length) parts.push(`${result.missing.length} attachment(s) are missing from this device`);
    showToast(`⚠ Integrity check: ${parts.join(' and ')}. Nothing was changed. Open Settings & Security → Diagnostics → Check attachments for details, and restore them from a backup.`, 'warning', 12000);
  } else {
    console.info(`Integrity check: all ${result.checked} referenced attachment(s) open with the data key.`);
  }
  return result;
}

// Everything that should happen in the background after any successful unlock.
function afterUnlockBackgroundTasks() {
  const key = currentEncryptionKey;
  if (!key) return;
  setTimeout(async () => {
    if (key !== currentEncryptionKey) return;
    try { await migratePlaintextAttachmentsToEncrypted(key); } catch (e) {}
    await runPostUnlockIntegrityCheck();
  }, 1200);
}

/* ==========================================================================
   AUTO-LOCK AND PIN ATTEMPT THROTTLING SECURITY
   ========================================================================== */
const AUTO_LOCK_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes inactivity
let autoLockTimer = null;
let lastUserActivityTime = Date.now();
let failedPinAttempts = 0;
let pinThrottleUntil = 0;

function checkPinThrottle() {
  const now = Date.now();
  if (now < pinThrottleUntil) {
    const remainingSec = Math.ceil((pinThrottleUntil - now) / 1000);
    return `Too many failed attempts. Please wait ${remainingSec} second${remainingSec > 1 ? 's' : ''}.`;
  }
  return null;
}

function recordFailedPinAttempt() {
  failedPinAttempts++;
  if (failedPinAttempts >= 3) {
    let delaySec = 3;
    if (failedPinAttempts === 4) delaySec = 10;
    else if (failedPinAttempts >= 5) delaySec = 30;
    pinThrottleUntil = Date.now() + (delaySec * 1000);
  }
}

function recordSuccessfulPinAttempt() {
  failedPinAttempts = 0;
  pinThrottleUntil = 0;
}

function resetAutoLockTimer() {
  lastUserActivityTime = Date.now();
  if (autoLockTimer) {
    clearTimeout(autoLockTimer);
    autoLockTimer = null;
  }
  if (isAppUnlocked) {
    autoLockTimer = setTimeout(() => {
      if (isAppUnlocked) {
        lockAppSecurity();
        showToast('App automatically locked due to inactivity (5 min)', 'info', 4000);
      }
    }, AUTO_LOCK_IDLE_TIMEOUT_MS);
  }
}

function initAutoLockListeners() {
  const activityEvents = ['pointerdown', 'keydown', 'touchstart', 'mousemove', 'scroll'];
  let throttled = false;
  activityEvents.forEach(evt => {
    window.addEventListener(evt, () => {
      if (!throttled) {
        throttled = true;
        resetAutoLockTimer();
        setTimeout(() => { throttled = false; }, 2000);
      }
    }, { passive: true });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (isAppUnlocked) {
        const elapsed = Date.now() - lastUserActivityTime;
        if (elapsed >= AUTO_LOCK_IDLE_TIMEOUT_MS) {
          lockAppSecurity();
        }
      }
    } else if (document.visibilityState === 'visible') {
      if (isAppUnlocked) {
        const elapsed = Date.now() - lastUserActivityTime;
        if (elapsed >= AUTO_LOCK_IDLE_TIMEOUT_MS) {
          lockAppSecurity();
          showToast('App locked while tab was in background', 'info', 3000);
        } else {
          resetAutoLockTimer();
        }
      }
    }
  });
}

// Purge legacy session key and plaintext tokens from browser storage
function purgeLegacySessionAndDiskTokens() {
  sessionStorage.removeItem('srg_session_key');
  localStorage.removeItem('srg_bio_salt');
  localStorage.removeItem('srg_recovery_key_display');
  localStorage.removeItem('srg_user_recovery_email');
}

// Purge legacy biometric disk tokens and plaintext recovery key from disk
async function purgeLegacyBiometricDiskTokens() {
  localStorage.removeItem('srg_bio_salt');
  localStorage.removeItem('srg_recovery_key_display');
  localStorage.removeItem('srg_user_recovery_email');
  try {
    const idb = await openSRGDatabase();
    const tx = idb.transaction('files', 'readwrite');
    tx.objectStore('files').delete('srg_bio_key_token');
  } catch(e) {}
}

async function removeBiometricEncryptionKey() {
  localStorage.removeItem('srg_biometric_enabled');
  localStorage.removeItem('srg_biometric_cred_id');
  localStorage.removeItem('srg_bio_salt');
  localStorage.removeItem('srg_biometric_mode');
  localStorage.removeItem('srg_bio_token_b64');
  try {
    const idb = await openSRGDatabase();
    const tx = idb.transaction('files', 'readwrite');
    tx.objectStore('files').delete('srg_bio_key_token');
  } catch(e) {}
}

function isPinConfigured() {
  if (localStorage.getItem('srg_app_pin_configured') === 'true') return true;
  if (keyEnvelope) return true;
  if (cachedEncryptedDbBytes && isEncryptedDbBytes(cachedEncryptedDbBytes)) return true;
  return false;
}

/* ==========================================================================
   BIOMETRIC AUTHENTICATION (DUAL-TIER: WEBAUTHN PRF & PLATFORM USER VERIFICATION)
   ========================================================================== */
const BIO_TOKEN_MAGIC_PRF = new Uint8Array([0x53, 0x52, 0x47, 0x42, 0x49, 0x4F, 0x31]); // "SRGBIO1" (7 bytes, Hardware PRF)
const BIO_TOKEN_MAGIC_UV  = new Uint8Array([0x53, 0x52, 0x47, 0x42, 0x49, 0x4F, 0x32]); // "SRGBIO2" (7 bytes, WebAuthn User-Verified)
const BIO_TOKEN_MAGIC = BIO_TOKEN_MAGIC_PRF; // Backwards compatibility alias

function matchMagic(buffer, magic) {
  if (!buffer || buffer.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (buffer[i] !== magic[i]) return false;
  }
  return true;
}

async function deriveBiometricWrappingKey(rawId, salt) {
  const rawIdBytes = rawId instanceof Uint8Array ? rawId : new Uint8Array(rawId);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    rawIdBytes,
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function isBiometricAvailable() {
  if (window.PublicKeyCredential && 
      typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
    try {
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch(e) {
      return false;
    }
  }
  return false;
}

function updateBiometricButtonState(isAuthenticating) {
  const heroBox = document.getElementById('biometricHeroBox');
  const heroIcon = document.getElementById('biometricHeroIcon');
  const heroTitle = document.getElementById('biometricHeroTitle');
  const heroSubtitle = document.getElementById('biometricHeroSubtitle');
  const iconRing = document.getElementById('biometricIconRing');

  if (isAuthenticating) {
    if (heroIcon) heroIcon.className = 'fa-solid fa-spinner fa-spin';
    if (heroTitle) heroTitle.textContent = 'Awaiting Fingerprint...';
    if (heroSubtitle) heroSubtitle.textContent = 'Touch your fingerprint sensor to verify identity';
    if (iconRing) iconRing.classList.remove('biometric-pulsing');
    if (heroBox) heroBox.style.borderColor = '#10b981';
  } else {
    if (heroIcon) heroIcon.className = 'fa-solid fa-fingerprint';
    if (heroTitle) heroTitle.textContent = 'Tap to Scan Fingerprint';
    if (heroSubtitle) heroSubtitle.textContent = 'Touch sensor to unlock with biometrics';
    if (iconRing) iconRing.classList.add('biometric-pulsing');
    if (heroBox) heroBox.style.borderColor = 'rgba(16, 185, 129, 0.45)';
  }
}

function updateBiometricUI() {
  const bioContainer = document.getElementById('biometricUnlockContainer');
  const bioPrompt = document.getElementById('enableBiometricPrompt');
  const defaultIcon = document.getElementById('appLockDefaultIcon');
  const drawerBioText = document.getElementById('drawerBioText') || document.getElementById('drawerBiometricText');
  const isEnabled = localStorage.getItem('srg_biometric_enabled') === 'true';

  if (bioContainer) {
    bioContainer.classList.toggle('hidden', !isEnabled);
  }
  if (defaultIcon) {
    defaultIcon.classList.toggle('hidden', isEnabled);
  }

  isBiometricAvailable().then(available => {
    if (bioPrompt) {
      bioPrompt.classList.toggle('hidden', !(available && !isEnabled));
    }
    if (drawerBioText) {
      drawerBioText.textContent = isEnabled ? 'Biometrics: Enabled (Fingerprint / Face ID)' : 'Enable Biometrics';
    }
  });
}

async function registerBiometricCredential() {
  if (!(await isBiometricAvailable())) {
    showToast('Biometric sensor is not available on this device.', 'warning', 4000);
    return false;
  }
  if (!currentEncryptionKey) {
    showToast('Please enter your Security PIN to unlock the calendar first.', 'info', 4000);
    const keyInp = document.getElementById('appLockKeyInput');
    if (keyInp) keyInp.focus();
    return false;
  }

  const enteredPin = await requestPinPromptModal({
    title: 'Link Biometric Unlock',
    message: 'Enter your Security PIN to link fingerprint / face unlock on this device:',
    placeholder: 'Enter Security PIN',
    confirmText: 'Verify & Link',
    iconClass: 'fa-solid fa-fingerprint'
  });
  if (!enteredPin) return false;

  let rawMasterBytes;
  const env = await loadKeyEnvelope();
  if (env) {
    // The token wraps the DEK itself, so the PIN, fingerprint and recovery key all open the same key.
    try {
      rawMasterBytes = await unwrapDekWithPin(env, enteredPin);
    } catch (e) {
      showToast('Incorrect Security PIN. Biometric setup cancelled.', 'error', 4000);
      return false;
    }
  } else {
    const dbBytes = cachedEncryptedDbBytes || await loadDbFromIndexedDB();
    const parsed = dbBytes && isEncryptedDbBytes(dbBytes) ? parseEncryptedDbHeader(dbBytes) : null;
    const salt = parsed ? parsed.salt : await getEffectiveCryptoSalt(dbBytes);
    const iterations = parsed ? parsed.iterations : PBKDF2_ITERATIONS;

    const isValidPin = await verifyPinWithAuthToken(enteredPin);
    if (!isValidPin) {
      showToast('Incorrect Security PIN. Biometric setup cancelled.', 'error', 4000);
      return false;
    }
    rawMasterBytes = await deriveRawKeyBitsFromPin(enteredPin, salt, iterations);
  }

  const loadingToast = showToast('Scan fingerprint or face to register biometric unlock...', 'info', 0);
  try {
    const challenge = crypto.getRandomValues(new Uint8Array(16));
    const userId = crypto.getRandomValues(new Uint8Array(8));

    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: challenge,
        rp: { name: 'Calendar App' },
        user: {
          id: userId,
          name: 'calendar_user',
          displayName: 'Calendar User'
        },
        pubKeyCredParams: [
          { alg: -7, type: 'public-key' },
          { alg: -257, type: 'public-key' }
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required'
        },
        timeout: 60000,
        extensions: {
          prf: {}
        }
      }
    });

    if (loadingToast) dismissToast(loadingToast);

    const extResults = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
    const prfSupported = !!(extResults.prf && extResults.prf.enabled);
    let bioToken = null;

    if (prfSupported) {
      // MODE 1: Hardware-bound WebAuthn PRF key wrapping
      const prfSalt = crypto.getRandomValues(new Uint8Array(32));
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(16)),
          allowCredentials: [{
            id: cred.rawId,
            type: 'public-key'
          }],
          userVerification: 'required',
          timeout: 60000,
          extensions: {
            prf: {
              eval: {
                first: prfSalt
              }
            }
          }
        }
      });

      const prfOutput = assertion.getClientExtensionResults()?.prf?.results?.first;
      if (!prfOutput || prfOutput.byteLength !== 32) {
        throw new Error('Failed to retrieve PRF hardware key from authenticator.');
      }

      const prfWrapKey = await crypto.subtle.importKey(
        'raw',
        prfOutput,
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt']
      );

      const bioIv = crypto.getRandomValues(new Uint8Array(12));
      const cipherBuf = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: bioIv },
        prfWrapKey,
        rawMasterBytes
      );
      rawMasterBytes.fill(0); // Zero memory immediately

      const cipher = new Uint8Array(cipherBuf);
      bioToken = new Uint8Array(BIO_TOKEN_MAGIC_PRF.length + prfSalt.length + bioIv.length + cipher.length);
      bioToken.set(BIO_TOKEN_MAGIC_PRF, 0);
      bioToken.set(prfSalt, BIO_TOKEN_MAGIC_PRF.length);
      bioToken.set(bioIv, BIO_TOKEN_MAGIC_PRF.length + prfSalt.length);
      bioToken.set(cipher, BIO_TOKEN_MAGIC_PRF.length + prfSalt.length + bioIv.length);
      lsSet('srg_biometric_mode', 'prf');
    } else {
      // MODE 2: WebAuthn Platform Authenticator User-Verified Vault (Mobile / Android / iOS)
      const uvSalt = crypto.getRandomValues(new Uint8Array(16));
      const uvWrapKey = await deriveBiometricWrappingKey(cred.rawId, uvSalt);
      const bioIv = crypto.getRandomValues(new Uint8Array(12));
      const cipherBuf = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: bioIv },
        uvWrapKey,
        rawMasterBytes
      );
      rawMasterBytes.fill(0); // Zero memory immediately

      const cipher = new Uint8Array(cipherBuf);
      bioToken = new Uint8Array(BIO_TOKEN_MAGIC_UV.length + uvSalt.length + bioIv.length + cipher.length);
      bioToken.set(BIO_TOKEN_MAGIC_UV, 0);
      bioToken.set(uvSalt, BIO_TOKEN_MAGIC_UV.length);
      bioToken.set(bioIv, BIO_TOKEN_MAGIC_UV.length + uvSalt.length);
      bioToken.set(cipher, BIO_TOKEN_MAGIC_UV.length + uvSalt.length + bioIv.length);
      lsSet('srg_biometric_mode', 'uv');
    }

    // Save hardware-wrapped token in IndexedDB 'files' store and localStorage backup
    try {
      lsSet('srg_bio_token_b64', bufferToBase64(bioToken));
    } catch(e) {}
    try {
      const idb = await openSRGDatabase();
      await new Promise((resolve, reject) => {
        const tx = idb.transaction('files', 'readwrite');
        tx.objectStore('files').put(bioToken, 'srg_bio_key_token');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch(e) {}

    const credIdBase64 = bufferToBase64(new Uint8Array(cred.rawId));
    lsSet('srg_biometric_cred_id', credIdBase64);
    lsSet('srg_biometric_enabled', 'true');
    showToast('✓ Fingerprint / Biometric unlock enabled on this device!', 'success', 4000);
    updateBiometricUI();
    return true;
  } catch(err) {
    if (loadingToast) dismissToast(loadingToast);
    rawMasterBytes.fill(0);
    console.warn('Biometric registration error:', err);
    if (err.name !== 'NotAllowedError') {
      showToast('Could not register biometrics: ' + err.message, 'error', 4000);
    }
  }
  return false;
}

let isBiometricAuthenticating = false;
// True when a fingerprint unlock could only open an older snapshot. Saves are blocked so stale data
// can never overwrite the live database; Change Security PIN (re-secure) clears it.
let biometricSnapshotFallbackActive = false;

async function unlockAppWithBiometric(autoPrompt = false) {
  if (isBiometricAuthenticating) return;
  const credIdBase64 = localStorage.getItem('srg_biometric_cred_id');
  if (!credIdBase64 || localStorage.getItem('srg_biometric_enabled') !== 'true') {
    if (!autoPrompt) {
      await registerBiometricCredential();
    }
    return;
  }

  // Load hardware-wrapped bioToken from IndexedDB or localStorage backup
  let bioToken = null;
  try {
    const idb = await openSRGDatabase();
    const tx = idb.transaction('files', 'readonly');
    const store = tx.objectStore('files');
    const req = store.get('srg_bio_key_token');
    const res = await new Promise((resolve) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    if (res instanceof Uint8Array) bioToken = res;
    else if (res instanceof ArrayBuffer) bioToken = new Uint8Array(res);
  } catch(e) {}

  if (!bioToken) {
    const backupB64 = localStorage.getItem('srg_bio_token_b64');
    if (backupB64) {
      try {
        bioToken = base64ToBuffer(backupB64);
      } catch(e) {}
    }
  }

  if (!bioToken || bioToken.length < 7 + 16 + 12 + 16) {
    if (!autoPrompt) {
      showToast('Biometric hardware token not found. Please enter Security PIN.', 'info', 4000);
      const keyInp = document.getElementById('appLockKeyInput');
      if (keyInp) keyInp.focus();
    }
    return;
  }

  const isPrf = matchMagic(bioToken, BIO_TOKEN_MAGIC_PRF);
  const isUv = matchMagic(bioToken, BIO_TOKEN_MAGIC_UV);

  if (!isPrf && !isUv) {
    if (!autoPrompt) showToast('Incompatible biometric token. Please enter Security PIN.', 'warning', 4000);
    return;
  }

  isBiometricAuthenticating = true;
  updateBiometricButtonState(true);

  try {
    const rawId = base64ToBuffer(credIdBase64);
    const idBuffer = rawId.buffer.slice(rawId.byteOffset, rawId.byteOffset + rawId.byteLength);
    let decryptedMasterBuf = null;

    if (isPrf) {
      // MODE 1: Hardware-bound WebAuthn PRF
      const prfSalt = bioToken.slice(BIO_TOKEN_MAGIC_PRF.length, BIO_TOKEN_MAGIC_PRF.length + 32);
      const bioIv = bioToken.slice(BIO_TOKEN_MAGIC_PRF.length + 32, BIO_TOKEN_MAGIC_PRF.length + 32 + 12);
      const cipher = bioToken.slice(BIO_TOKEN_MAGIC_PRF.length + 32 + 12);

      const challenge = crypto.getRandomValues(new Uint8Array(16));
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: challenge,
          allowCredentials: [{
            id: idBuffer,
            type: 'public-key'
          }],
          userVerification: 'required',
          timeout: 60000,
          extensions: {
            prf: {
              eval: {
                first: prfSalt
              }
            }
          }
        }
      });

      const prfOutput = assertion.getClientExtensionResults()?.prf?.results?.first;
      if (!prfOutput || prfOutput.byteLength !== 32) {
        throw new Error('Authenticator did not return PRF key.');
      }

      const prfWrapKey = await crypto.subtle.importKey(
        'raw',
        prfOutput,
        { name: 'AES-GCM' },
        false,
        ['decrypt']
      );

      decryptedMasterBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bioIv },
        prfWrapKey,
        cipher
      );
    } else {
      // MODE 2: WebAuthn Platform Authenticator User-Verified Vault (Mobile / Android / iOS)
      const uvSalt = bioToken.slice(BIO_TOKEN_MAGIC_UV.length, BIO_TOKEN_MAGIC_UV.length + 16);
      const bioIv = bioToken.slice(BIO_TOKEN_MAGIC_UV.length + 16, BIO_TOKEN_MAGIC_UV.length + 16 + 12);
      const cipher = bioToken.slice(BIO_TOKEN_MAGIC_UV.length + 16 + 12);

      const challenge = crypto.getRandomValues(new Uint8Array(16));
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: challenge,
          allowCredentials: [{
            id: idBuffer,
            type: 'public-key'
          }],
          userVerification: 'required',
          timeout: 60000
        }
      });

      const authData = new Uint8Array(assertion.response.authenticatorData);
      const userVerified = !!(authData[32] & 0x04);
      if (!userVerified) {
        throw new Error('Biometric user verification was not confirmed.');
      }

      const uvWrapKey = await deriveBiometricWrappingKey(rawId, uvSalt);
      decryptedMasterBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bioIv },
        uvWrapKey,
        cipher
      );
    }

    const rawMasterBytes = new Uint8Array(decryptedMasterBuf);

    // Import strictly non-extractable runtime master key
    const masterKey = await importRuntimeAesGcmKey(rawMasterBytes);
    rawMasterBytes.fill(0); // Zero memory

    const env = await loadKeyEnvelope();
    if (env && !(await isDekForEnvelope(masterKey, env))) {
      // A token from before the upgrade wraps an old PIN-derived key, which no longer opens anything.
      await removeBiometricEncryptionKey();
      updateBiometricUI();
      const msg = 'Fingerprint link is out of date. Unlock with your Security PIN, then enable fingerprint again.';
      if (autoPrompt) showToast(msg, 'warning', 6000); // the catch below stays quiet for auto-prompts
      throw new Error(msg);
    }

    const bytesToDecrypt = cachedEncryptedDbBytes || await loadDbFromIndexedDB();
    let decryptedBytes = null;
    if (bytesToDecrypt) {
      try {
        decryptedBytes = await decryptDatabaseBytes(bytesToDecrypt, masterKey, !env);
      } catch (dbErr) {
        // Fallback: check local snapshots with masterKey
        try {
          const idb = await openSRGDatabase();
          const tx = idb.transaction('snapshots', 'readonly');
          const sStore = tx.objectStore('snapshots');
          const req = sStore.getAll();
          const snaps = await new Promise(r => { req.onsuccess = () => r(req.result || []); req.onerror = () => r([]); });
          if (Array.isArray(snaps) && snaps.length > 0) {
            snaps.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            for (const snap of snaps) {
              if (snap && snap.data) {
                try {
                  const testBytes = await decryptDatabaseBytes(snap.data, masterKey, !env);
                  if (isValidSqliteBinary(testBytes)) {
                    decryptedBytes = testBytes;
                    biometricSnapshotFallbackActive = true;
                    console.warn(`Biometric unlock could not open the live database; opened snapshot ${snap.id} with saving paused.`);
                    break;
                  }
                } catch(e) {}
              }
            }
          }
        } catch(snapErr) {}
      }

      if (!decryptedBytes || !isValidSqliteBinary(decryptedBytes)) {
        throw new Error('Biometric key out of sync with database. Please unlock once with your Security PIN.');
      }
      db = new SQL.Database(decryptedBytes);
      ensureSchemaUpToDate();
    }

    if (env) activateDek(masterKey, env.dekId);
    else currentEncryptionKey = masterKey; // legacy data: the upgrade needs the PIN, so it waits for a PIN unlock
    isAppUnlocked = true;
    resetAutoLockTimer();
    recordSuccessfulPinAttempt();

    const overlay = document.getElementById('appLockOverlay');
    if (overlay) overlay.classList.add('hidden');
    const errEl = document.getElementById('appLockErrorMsg');
    if (errEl) errEl.classList.add('hidden');

    loadMasterDataFromDb();
    populateTitlesDatalist();
    switchToView(currentView, currentDate);

    updateBadge('Local SQLite Active');
    if (biometricSnapshotFallbackActive) {
      showToast(env
        ? '⚠ Your main database could not be opened, so the newest readable snapshot was opened instead. Saving is paused to protect the main file. Download DB (.db) now and check Diagnostics.'
        : '⚠ Opened from an older snapshot because the fingerprint key is out of date. Saving is paused to protect your main database. Download DB (.db) now, then use Change Security PIN to re-secure.', 'warning', 0);
    } else if (!env) {
      showToast('✓ Unlocked via Biometrics. Unlock once with your Security PIN to finish the encryption upgrade.', 'info', 6000);
    } else {
      showToast('✓ Unlocked via Biometrics!', 'success', 3000);
    }
    afterUnlockBackgroundTasks();
  } catch(err) {
    console.warn('Biometric verification error:', err);
    if (!autoPrompt) {
      if (err.name === 'NotAllowedError') {
        showToast('Biometric scan cancelled. Tap to retry, or enter PIN.', 'info', 3500);
      } else {
        showToast(err.message || 'Biometric verification failed. Please enter PIN.', 'error', 4000);
      }
    }
  } finally {
    isBiometricAuthenticating = false;
    updateBiometricButtonState(false);
  }
}

async function toggleBiometricSetting() {
  const isEnabled = localStorage.getItem('srg_biometric_enabled') === 'true';
  if (isEnabled) {
    localStorage.removeItem('srg_biometric_enabled');
    localStorage.removeItem('srg_biometric_cred_id');
    await removeBiometricEncryptionKey();
    showToast('Biometric unlock disabled.', 'info');
    updateBiometricUI();
  } else {
    await registerBiometricCredential();
  }
}

async function checkAppSecurityLock() {
  const overlay = document.getElementById('appLockOverlay');
  if (!overlay) return;

  const setupWrap = document.getElementById('appLockSetupContainer');
  const unlockWrap = document.getElementById('appLockUnlockContainer');

  // Case 1: First-time user in this browser (PIN not yet configured)
  if (!isPinConfigured()) {
    isAppUnlocked = false;
    overlay.classList.remove('hidden');
    if (setupWrap) setupWrap.classList.remove('hidden');
    if (unlockWrap) unlockWrap.classList.add('hidden');
    const pinInp = document.getElementById('setupNewPinInput');
    if (pinInp) pinInp.focus();
    return;
  }

  // Case 2: Returning user (show lock screen with PIN input and optional biometric hardware unlock)
  isAppUnlocked = false;
  purgeLegacySessionAndDiskTokens();
  overlay.classList.remove('hidden');
  if (setupWrap) setupWrap.classList.add('hidden');
  if (unlockWrap) unlockWrap.classList.remove('hidden');
  updateBiometricUI();

  const isBioEnabled = localStorage.getItem('srg_biometric_enabled') === 'true';
  const keyInp = document.getElementById('appLockKeyInput');
  if (keyInp) {
    keyInp.value = '';
    // Only focus PIN input if biometrics is not enabled; prevents virtual keyboard from popping up on mobile
    if (!isBioEnabled) {
      keyInp.focus();
    }
  }

  // Auto-prompt biometrics if registered
  if (isBioEnabled) {
    setTimeout(async () => {
      try {
        await unlockAppWithBiometric(true);
      } catch(e) {}
    }, 350);
  }
}

async function handleSetupPinSubmit(e) {
  e.preventDefault();
  const pin1 = (document.getElementById('setupNewPinInput')?.value || '').trim();
  const pin2 = (document.getElementById('setupConfirmPinInput')?.value || '').trim();
  const errEl = document.getElementById('setupPinErrorMsg');

  if (!pin1 || pin1.length < 6 || pin1.length > 64) {
    if (errEl) {
      errEl.textContent = 'Security PIN / Passphrase must be at least 6 characters.';
      errEl.classList.remove('hidden');
    }
    return;
  }
  if (pin1 !== pin2) {
    if (errEl) {
      errEl.textContent = 'Confirmation PIN does not match.';
      errEl.classList.remove('hidden');
    }
    return;
  }

  const submitBtn = document.getElementById('submitSetupPinBtn');
  const originalText = submitBtn ? submitBtn.innerHTML : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Encrypting...';
  }

  try {
    // New random data key, wrapped by the PIN; the recovery vault wraps the same key.
    const { env, rawDek, dekKey, dekId } = await createDekEnvelope(pin1);
    const recoveryKey = generateRecoveryKey();
    try {
      await saveKeyEnvelope(env);
      await saveRecoveryVault(rawDek, recoveryKey);
    } finally {
      rawDek.fill(0); // Zero memory
    }
    activateDek(dekKey, dekId);
    resetAutoLockTimer();
    purgeLegacySessionAndDiskTokens();

    lsSet('srg_app_pin_configured', 'true');
    localStorage.removeItem('srg_app_pin'); // Purge legacy plaintext PIN

    // Initialize or migrate database
    if (!db) {
      if (cachedEncryptedDbBytes && !isEncryptedDbBytes(cachedEncryptedDbBytes) && isValidSqliteBinary(cachedEncryptedDbBytes)) {
        // Migrate legacy unencrypted database
        db = new SQL.Database(cachedEncryptedDbBytes);
      } else {
        await initializeFreshOrBundledDatabase();
      }
    }

    ensureSchemaUpToDate();
    await saveDbToIndexedDB(false);

    isAppUnlocked = true;
    const overlay = document.getElementById('appLockOverlay');
    if (overlay) overlay.classList.add('hidden');
    if (errEl) errEl.classList.add('hidden');

    loadMasterDataFromDb();
    populateTitlesDatalist();
    switchToView(currentView, currentDate);
    updateBadge('Local SQLite Active');

    showToast('✓ Security PIN set & Database encrypted with AES-256!', 'success', 4000);
    afterUnlockBackgroundTasks();

    // Automatically prompt Emergency Recovery Kit so user can email or save their key
    setTimeout(() => {
      openRecoveryKitModal(recoveryKey, true);
    }, 450);

    // Offer biometric unlock if available
    isBiometricAvailable().then(available => {
      if (available) {
        setTimeout(() => {
          if (confirm('Enable fingerprint / biometric unlock on this device for instant access?')) {
            registerBiometricCredential();
          }
        }, 600);
      }
    });
  } catch(err) {
    console.error('Setup PIN error:', err);
    if (errEl) {
      errEl.textContent = 'Error setting PIN: ' + err.message;
      errEl.classList.remove('hidden');
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalText;
    }
  }
}

async function unlockAppWithKey(enteredKey) {
  const trimmedKey = (enteredKey || '').trim();
  const rawKey = enteredKey || '';
  const errEl = document.getElementById('appLockErrorMsg');

  const throttleMsg = checkPinThrottle();
  if (throttleMsg) {
    if (errEl) {
      errEl.textContent = throttleMsg;
      errEl.classList.remove('hidden');
    }
    return;
  }

  if (!trimmedKey && !rawKey) {
    if (errEl) {
      errEl.textContent = 'Please enter your Security PIN';
      errEl.classList.remove('hidden');
    }
    return;
  }

  const submitBtn = document.querySelector('#appUnlockForm button[type="submit"]');
  const originalText = submitBtn ? submitBtn.innerHTML : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Decrypting...';
  }

  try {
    const bytesToDecrypt = cachedEncryptedDbBytes || await loadDbFromIndexedDB();
    if (!bytesToDecrypt) {
      throw new Error('Database not found');
    }

    const env = await loadKeyEnvelope();
    const upgrade = env
      ? await unlockDataWithEnvelope(env, rawKey, trimmedKey, bytesToDecrypt)
      : await unlockLegacyDataAndUpgrade(rawKey, trimmedKey, bytesToDecrypt);

    isAppUnlocked = true;
    recordSuccessfulPinAttempt();
    resetAutoLockTimer();
    purgeLegacySessionAndDiskTokens();

    const overlay = document.getElementById('appLockOverlay');
    if (overlay) overlay.classList.add('hidden');
    if (errEl) errEl.classList.add('hidden');

    loadMasterDataFromDb();
    populateTitlesDatalist();
    switchToView(currentView, currentDate);
    updateBadge('Local SQLite Active');

    if (biometricSnapshotFallbackActive) {
      showToast('⚠ Your main database could not be opened with this PIN, so the newest readable snapshot was opened instead. Saving is paused and the main file is kept unchanged. Download DB (.db) now and check Diagnostics.' +
        (keyEnvelope ? '' : ' If fingerprint unlock is set up, unlock with it and then use Change Security PIN (the same PIN is fine) to finish the encryption upgrade.'), 'warning', 0);
    } else if (upgrade) {
      showUpgradeOutcome(upgrade);
    } else {
      showToast('✓ Calendar Authenticated & Decrypted', 'success', 3000);
    }
    afterUnlockBackgroundTasks();

    // Prompt to enable biometrics if supported but not enrolled
    if (localStorage.getItem('srg_biometric_enabled') !== 'true' && !(upgrade && upgrade.recoveryKey)) {
      isBiometricAvailable().then(available => {
        if (available) {
          setTimeout(() => {
            if (confirm('Enable fingerprint / biometric unlock on this device for instant secure access?')) {
              registerBiometricCredential();
            }
          }, 600);
        }
      });
    }
  } catch(err) {
    if (err && err.pinWasCorrect) {
      // Don't call a correct PIN wrong: that sends people to "Forgot PIN" for no reason.
      console.error('Unlock failed after the PIN was accepted:', err);
      if (errEl) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      }
      showToast('⚠ ' + err.message, 'error', 9000);
      return;
    }
    recordFailedPinAttempt();
    console.warn('Decryption / PIN authentication failed:', err);
    const currentThrottle = checkPinThrottle();
    if (errEl) {
      errEl.textContent = currentThrottle || 'Incorrect Security PIN. Decryption failed.';
      errEl.classList.remove('hidden');
    }
    showToast(currentThrottle || '❌ Authentication Failed: Invalid PIN', 'error', 3000);
    const keyInp = document.getElementById('appLockKeyInput');
    if (keyInp) {
      keyInp.value = '';
      keyInp.focus();
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalText;
    }
  }
}

function pinAcceptedError(message) {
  const e = new Error(message);
  e.pinWasCorrect = true;
  return e;
}

// Opens the live database with the DEK; if that fails, the newest snapshot that opens (saving paused).
// Returns the plaintext bytes or null.
async function openDatabaseOrSnapshotWithKey(key, liveBytes) {
  try {
    const out = await decryptDatabaseBytes(liveBytes, key, false);
    if (isValidSqliteBinary(out)) return out;
  } catch (e) {}
  const snaps = await listLocalDbSnapshots();
  for (const snap of snaps) {
    if (!snap || !snap.data || !isEncryptedDbBytes(snap.data)) continue;
    try {
      const out = await decryptDatabaseBytes(new Uint8Array(snap.data), key, false);
      if (isValidSqliteBinary(out)) {
        biometricSnapshotFallbackActive = true;
        console.warn(`Live database did not open with the data key; opened snapshot ${snap.id} with saving paused.`);
        return out;
      }
    } catch (e) {}
  }
  return null;
}

// Envelope mode: unwrap the DEK with the PIN and open the data. Returns an upgrade/repair report or null.
async function unlockDataWithEnvelope(env, rawKey, trimmedKey, liveBytes) {
  const rawDek = await unwrapDekWithPin(env, rawKey); // throws on a wrong PIN
  const dekKey = await importRuntimeAesGcmKey(rawDek);
  rawDek.fill(0);

  // Usual case: the live file is SRGE3 under this DEK.
  if (isEncryptedDbBytes(liveBytes) && parseEncryptedDbHeader(liveBytes).version === 3) {
    const plain = await openDatabaseOrSnapshotWithKey(dekKey, liveBytes);
    if (!plain) throw pinAcceptedError('Your PIN is correct, but neither the database nor any snapshot opens with your data key. Nothing was changed. Open Diagnostics and restore from a backup.');
    db = new SQL.Database(plain);
    ensureSchemaUpToDate();
    activateDek(dekKey, env.dekId);
    return null;
  }

  // The live file is in an older format (e.g. an old app version saved it after the upgrade).
  // Read it with any key the PIN can derive and re-secure everything under the SAME DEK, so the
  // fingerprint token and recovery key stay valid.
  const keyRing = createKeyRing(trimmedKey || rawKey, [dekKey]);
  let plain = null;
  if (isEncryptedDbBytes(liveBytes)) {
    const hit = await decryptDbWithKeyRing(liveBytes, keyRing);
    if (hit.ok) plain = hit.result;
  } else if (isValidSqliteBinary(liveBytes)) {
    plain = liveBytes;
  }
  if (!plain) {
    plain = await openDatabaseOrSnapshotWithKey(dekKey, liveBytes);
    if (!plain) throw pinAcceptedError('Your PIN is correct, but the database file could not be opened with any known key. Nothing was changed. Open Diagnostics and restore from a backup.');
    db = new SQL.Database(plain);
    ensureSchemaUpToDate();
    activateDek(dekKey, env.dekId);
    return null;
  }
  db = new SQL.Database(plain);
  ensureSchemaUpToDate();
  const result = await atomicReencryptAllData({ dekKey, dekId: env.dekId, keyRing });
  activateDek(dekKey, env.dekId);
  return { kind: 'repair', skipped: result.skipped, counts: result.counts };
}

// Legacy mode (data encrypted directly with PIN-derived keys): find the key, open the data, then upgrade.
async function unlockLegacyDataAndUpgrade(rawKey, trimmedKey, bytesToDecrypt) {
  {
    const candidateConfigs = await getAllCandidateCryptoConfigs(bytesToDecrypt);
    const pinsToTry = [trimmedKey];
    if (rawKey && rawKey !== trimmedKey) pinsToTry.push(rawKey);

    let decryptedBytes = null;
    let successfulKey = null;
    let matchingPin = null;
    let matchedConfig = null; // set only when the live database (not a snapshot) was opened

    // 1. Primary: test candidate keys against active database bytes
    for (const pin of pinsToTry) {
      for (const config of candidateConfigs) {
        try {
          const testKey = await deriveKeyFromPin(pin, config.salt, config.iterations, false);
          const testBytes = await decryptDatabaseBytes(bytesToDecrypt, testKey, false);
          if (isValidSqliteBinary(testBytes)) {
            decryptedBytes = testBytes;
            successfulKey = testKey;
            matchingPin = pin;
            matchedConfig = config;
            console.info(`✓ Successfully unlocked database (salt source: ${config.source}, iterations: ${config.iterations})`);
            break;
          }
        } catch (candErr) {
          // Try next candidate configuration
        }
      }
      if (decryptedBytes) break;
    }

    // 2. Snapshot Fallback: If active database failed to decrypt, check all IndexedDB snapshots
    if (!decryptedBytes || !isValidSqliteBinary(decryptedBytes)) {
      try {
        const idb = await openSRGDatabase();
        const tx = idb.transaction('snapshots', 'readonly');
        const sStore = tx.objectStore('snapshots');
        const req = sStore.getAll();
        const snaps = await new Promise(r => { req.onsuccess = () => r(req.result || []); req.onerror = () => r([]); });
        if (Array.isArray(snaps) && snaps.length > 0) {
          snaps.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
          for (const snap of snaps) {
            if (!snap || !snap.data) continue;
            // Case A: Unencrypted snapshot
            if (!isEncryptedDbBytes(snap.data) && isValidSqliteBinary(snap.data)) {
              decryptedBytes = snap.data;
              matchingPin = trimmedKey;
              console.info(`✓ Recovered database from unencrypted snapshot: ${snap.id}`);
              break;
            }
            // Case B: Encrypted snapshot
            for (const pin of pinsToTry) {
              for (const config of candidateConfigs) {
                try {
                  const testKey = await deriveKeyFromPin(pin, config.salt, config.iterations, false);
                  const testBytes = await decryptDatabaseBytes(snap.data, testKey, false);
                  if (isValidSqliteBinary(testBytes)) {
                    decryptedBytes = testBytes;
                    successfulKey = testKey;
                    matchingPin = pin;
                    console.info(`✓ Recovered database from encrypted snapshot: ${snap.id}`);
                    break;
                  }
                } catch(e) {}
              }
              if (decryptedBytes) break;
            }
            if (decryptedBytes) break;
          }
        }
      } catch(snapErr) {
        console.warn('Snapshot recovery fallback error:', snapErr);
      }
    }

    if (!decryptedBytes || !isValidSqliteBinary(decryptedBytes)) {
      throw new Error('Incorrect Security PIN or corrupted database.');
    }

    db = new SQL.Database(decryptedBytes);
    ensureSchemaUpToDate();

    if (!matchedConfig) {
      // Only a snapshot opened. Upgrading now would replace the live file with older data, so stay in the
      // old mode with saving paused. (The live file may be under the fingerprint key: unlocking with the
      // fingerprint and then Change Security PIN reads it and finishes the upgrade.)
      currentEncryptionKey = successfulKey; // null for an unencrypted snapshot: saving stays refused
      currentDekId = null;
      biometricSnapshotFallbackActive = true;
      return null;
    }

    const chosenPin = matchingPin || trimmedKey;
    const keyRing = createKeyRing(chosenPin, [successfulKey]);
    const progress = showToast('Upgrading encryption to a permanent data key… please keep the app open.', 'info', 0);
    try {
      return await migrateLegacyDataToEnvelope({ pin: chosenPin, keyRing });
    } catch (migErr) {
      // The upgrade commits in one transaction, so a failure leaves storage exactly as it was.
      console.error('Encryption upgrade failed; stored data left unchanged:', migErr);
      currentEncryptionKey = successfulKey;
      currentEncryptionSalt = matchedConfig.salt;
      currentDekId = null;
      showToast('⚠ The encryption upgrade could not be completed (' + migErr.message + '). Your data is unchanged and still opens with your PIN; the upgrade will be retried at the next unlock.', 'warning', 12000);
      return null;
    } finally {
      if (progress) dismissToast(progress);
    }
  }
}

// Generates the DEK, re-encrypts everything the key ring can read under it (one transaction) and
// re-points the PIN and recovery vault at it. The old fingerprint token wraps a legacy key, so it is reset.
async function migrateLegacyDataToEnvelope({ pin, keyRing, recoveryKey = null }) {
  const { env, rawDek, dekKey, dekId } = await createDekEnvelope(pin);
  const newRecoveryKey = recoveryKey || generateRecoveryKey();
  let vaultBytes;
  try {
    vaultBytes = await buildRecoveryVaultPackedBytes(rawDek, newRecoveryKey);
  } finally {
    rawDek.fill(0);
  }
  const result = await atomicReencryptAllData({ dekKey, dekId, keyRing, envelope: env, vaultBytes });

  // Committed. Update the small localStorage caches and in-memory state.
  keyEnvelope = env;
  cacheKeyEnvelopeLocally(env);
  cacheRecoveryVaultLocally(vaultBytes);
  lsSet('srg_app_pin_configured', 'true');
  activateDek(dekKey, dekId);
  biometricSnapshotFallbackActive = false;
  const hadBiometric = localStorage.getItem('srg_biometric_enabled') === 'true';
  if (hadBiometric) {
    await removeBiometricEncryptionKey();
    updateBiometricUI();
  }
  console.info(`Encryption upgraded to data key ${hexOf(dekId, 4)}…: ${result.counts.attachments} attachment(s), ${result.counts.snapshots} snapshot(s) re-encrypted; skipped ${result.skipped.attachments.length} attachment(s), ${result.skipped.snapshots.length} snapshot(s).`);
  if (result.skipped.attachments.length || result.skipped.snapshots.length) {
    console.warn('Upgrade left these items unchanged (no known key opens them):', result.skipped);
  }
  return { kind: 'migrated', skipped: result.skipped, counts: result.counts, hadBiometric, recoveryKey: recoveryKey ? null : newRecoveryKey };
}

function showUpgradeOutcome(upgrade) {
  const skippedCount = upgrade.skipped.attachments.length + upgrade.skipped.snapshots.length;
  const skippedText = skippedCount
    ? ` ${upgrade.skipped.attachments.length} attachment(s) and ${upgrade.skipped.snapshots.length} snapshot(s) could not be opened with any known key and were left unchanged (see Diagnostics).`
    : '';
  if (upgrade.kind === 'repair') {
    showToast(`✓ Unlocked. Data saved by an older app version was re-secured under your data key.${skippedText}`, skippedCount ? 'warning' : 'success', 9000);
    return;
  }
  showToast(
    '✓ Encryption upgraded: your data now uses a permanent data key, so changing your PIN never re-encrypts it again.' +
    skippedText +
    (upgrade.hadBiometric ? ' Fingerprint unlock was reset — enable it again from the menu.' : '') +
    (upgrade.recoveryKey ? ' A new Emergency Recovery Key was created; the old one no longer works.' : ''),
    skippedCount ? 'warning' : 'success', 12000);
  if (upgrade.recoveryKey) setTimeout(() => openRecoveryKitModal(upgrade.recoveryKey), 500);
}

async function lockAppSecurity() {
  isAppUnlocked = false;
  sessionStorage.removeItem('srg_app_unlocked');
  sessionStorage.removeItem('srg_session_key'); // Unconditionally wipe!
  currentEncryptionKey = null;
  currentEncryptionSalt = null;
  currentDekId = null;
  // The pause guarded the snapshot copy that is closed below; each unlock path sets it again if needed.
  biometricSnapshotFallbackActive = false;

  if (autoLockTimer) {
    clearTimeout(autoLockTimer);
    autoLockTimer = null;
  }

  // Close plaintext database in memory
  if (db) {
    try {
      db.close();
    } catch(e) {}
    db = null;
  }

  const overlay = document.getElementById('appLockOverlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    const setupWrap = document.getElementById('appLockSetupContainer');
    const unlockWrap = document.getElementById('appLockUnlockContainer');
    if (setupWrap) setupWrap.classList.add('hidden');
    if (unlockWrap) unlockWrap.classList.remove('hidden');
  }

  updateBiometricUI();
  const isBioEnabled = localStorage.getItem('srg_biometric_enabled') === 'true';
  const keyInp = document.getElementById('appLockKeyInput');
  if (keyInp) {
    keyInp.value = '';
    if (!isBioEnabled) {
      keyInp.focus();
    }
  }
  showToast('Calendar Locked', 'info');

  if (isBioEnabled) {
    setTimeout(async () => {
      try {
        await unlockAppWithBiometric(true);
      } catch(e) {}
    }, 350);
  }
}

/* ==========================================================================
   EMERGENCY RECOVERY KIT & FORGOT PIN / PASSPHRASE RECOVERY VAULT
   ========================================================================== */

const RECOVERY_MAGIC_V1 = new Uint8Array([0x53, 0x52, 0x47, 0x52, 0x45, 0x43, 0x31]); // "SRGREC1" (Legacy v1, 100k)
const RECOVERY_MAGIC_V2 = new Uint8Array([0x53, 0x52, 0x47, 0x52, 0x45, 0x43, 0x32]); // "SRGREC2" (Modern v2, 600k)
const RECOVERY_MAGIC = RECOVERY_MAGIC_V2;

// Generate a high-entropy 20-character formatted Recovery Key: SRG-XXXX-XXXX-XXXX-XXXX
function generateRecoveryKey() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // base32 Crockford style without ambiguous 0/O, 1/I
  const randomValues = crypto.getRandomValues(new Uint8Array(16));
  let keyStr = '';
  for (let i = 0; i < 16; i++) {
    keyStr += chars[randomValues[i] % chars.length];
  }
  return `SRG-${keyStr.slice(0, 4)}-${keyStr.slice(4, 8)}-${keyStr.slice(8, 12)}-${keyStr.slice(12, 16)}`;
}

// Normalize recovery key string (removes hyphens, spaces, converts to uppercase)
function normalizeRecoveryKey(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') return '';
  let cleaned = rawKey.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.startsWith('SRG')) {
    cleaned = cleaned.slice(3);
  }
  return cleaned;
}

// Derive a 256-bit AES-GCM wrapping key from normalized recovery key using PBKDF2
async function deriveRecoveryWrappingKey(normalizedKey, salt, iterations = PBKDF2_ITERATIONS) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode('SRG_RECOVERY_' + normalizedKey),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: iterations,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Build encrypted recovery vault packed bytes in memory protecting raw master key
async function buildRecoveryVaultPackedBytes(masterKeyOrRawBytes, recoveryKey) {
  if (!masterKeyOrRawBytes || !recoveryKey) {
    throw new Error('Master key and recovery key are required to construct recovery vault.');
  }
  let rawMasterBytes = null;
  if (masterKeyOrRawBytes instanceof CryptoKey) {
    rawMasterBytes = new Uint8Array(await crypto.subtle.exportKey('raw', masterKeyOrRawBytes));
  } else if (masterKeyOrRawBytes instanceof Uint8Array) {
    rawMasterBytes = masterKeyOrRawBytes;
  } else if (masterKeyOrRawBytes instanceof ArrayBuffer) {
    rawMasterBytes = new Uint8Array(masterKeyOrRawBytes);
  } else {
    throw new Error('Invalid master key format for recovery vault');
  }

  const normalized = normalizeRecoveryKey(recoveryKey);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrapKey = await deriveRecoveryWrappingKey(normalized, salt, PBKDF2_ITERATIONS);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    wrapKey,
    rawMasterBytes
  );
  const ciphertext = new Uint8Array(cipherBuf);

  // Layout: MAGIC (7) + SALT (16) + IV (12) + CIPHERTEXT (48)
  const packed = new Uint8Array(RECOVERY_MAGIC_V2.length + salt.length + iv.length + ciphertext.length);
  packed.set(RECOVERY_MAGIC_V2, 0);
  packed.set(salt, RECOVERY_MAGIC_V2.length);
  packed.set(iv, RECOVERY_MAGIC_V2.length + salt.length);
  packed.set(ciphertext, RECOVERY_MAGIC_V2.length + salt.length + iv.length);
  return packed;
}

// Save encrypted recovery vault protecting raw master key
async function saveRecoveryVault(masterKeyOrRawBytes, recoveryKey) {
  const packed = await buildRecoveryVaultPackedBytes(masterKeyOrRawBytes, recoveryKey);

  // Persist directly to primary storage in IndexedDB 'files' store first
  const idb = await openSRGDatabase();
  await new Promise((resolve, reject) => {
    const tx = idb.transaction('files', 'readwrite');
    tx.objectStore('files').put(packed, 'srg_recovery_vault');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Failed to save recovery vault to IndexedDB'));
    tx.onabort = () => reject(tx.error || new Error('Recovery vault transaction aborted'));
  });

  cacheRecoveryVaultLocally(packed);
  localStorage.removeItem('srg_recovery_key_display'); // NEVER store plaintext recovery key at rest
  return packed;
}

// IndexedDB is primary. A cached copy that can't be updated is removed: a stale vault would wrap the wrong key.
function cacheRecoveryVaultLocally(packed) {
  if (!lsSet('srg_recovery_vault', bufferToBase64(packed))) {
    try { localStorage.removeItem('srg_recovery_vault'); } catch (e) {}
  }
}

// Get the stored packed recovery vault bytes (IndexedDB first, localStorage cache as fallback)
async function getStoredRecoveryVaultBytes() {
  try {
    const idb = await openSRGDatabase();
    const res = await new Promise((resolve) => {
      const req = idb.transaction('files', 'readonly').objectStore('files').get('srg_recovery_vault');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    if (res instanceof Uint8Array) return res;
    if (res instanceof ArrayBuffer) return new Uint8Array(res);
  } catch(e) {}
  const b64 = localStorage.getItem('srg_recovery_vault');
  if (b64) {
    try {
      return base64ToBuffer(b64);
    } catch(e) {}
  }
  try {
    const idb = await openSRGDatabase();
    const tx = idb.transaction('files', 'readonly');
    const store = tx.objectStore('files');
    const req = store.get('srg_recovery_vault');
    const res = await new Promise((resolve) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    if (res instanceof Uint8Array) return res;
    if (res instanceof ArrayBuffer) return new Uint8Array(res);
  } catch(e) {}
  return null;
}

// Unwrap raw master database bytes using Recovery Key
async function unwrapMasterKeyWithRecoveryKey(inputRecoveryKey) {
  const normalized = normalizeRecoveryKey(inputRecoveryKey);
  if (!normalized || normalized.length < 16) {
    throw new Error('Recovery Key must be 16 characters or formatted as SRG-XXXX-XXXX-XXXX-XXXX');
  }

  const packed = await getStoredRecoveryVaultBytes();
  if (!packed || packed.length < 7 + 16 + 12 + 16) {
    throw new Error('No valid recovery vault found on this device');
  }

  let isV2 = true;
  for (let i = 0; i < RECOVERY_MAGIC_V2.length; i++) {
    if (packed[i] !== RECOVERY_MAGIC_V2[i]) { isV2 = false; break; }
  }
  let isV1 = false;
  if (!isV2) {
    isV1 = true;
    for (let i = 0; i < RECOVERY_MAGIC_V1.length; i++) {
      if (packed[i] !== RECOVERY_MAGIC_V1[i]) { isV1 = false; break; }
    }
  }

  if (!isV1 && !isV2) {
    throw new Error('Corrupt or incompatible recovery vault format');
  }

  const magicLength = isV2 ? RECOVERY_MAGIC_V2.length : RECOVERY_MAGIC_V1.length;
  const iterations = isV2 ? PBKDF2_ITERATIONS : PBKDF2_LEGACY_ITERATIONS;

  const saltStart = magicLength;
  const ivStart = saltStart + 16;
  const cipherStart = ivStart + 12;

  const salt = packed.slice(saltStart, ivStart);
  const iv = packed.slice(ivStart, cipherStart);
  const ciphertext = packed.slice(cipherStart);

  const wrapKey = await deriveRecoveryWrappingKey(normalized, salt, iterations);
  const rawMasterBytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv },
    wrapKey,
    ciphertext
  );

  return new Uint8Array(rawMasterBytes);
}

// UI: Open Emergency Recovery Kit Modal
function openRecoveryKitModal(recoveryKey, isNewSetup = false) {
  const modal = document.getElementById('recoveryKitModal');
  if (!modal || !recoveryKey) return;
  const display = document.getElementById('recoveryKeyDisplay');
  if (display) display.textContent = recoveryKey;
  modal.classList.remove('hidden');
}

// UI: Close Emergency Recovery Kit Modal
function closeRecoveryKitModal() {
  const modal = document.getElementById('recoveryKitModal');
  if (!modal) return;
  modal.classList.add('hidden');
  const display = document.getElementById('recoveryKeyDisplay');
  if (display) display.textContent = '••••-••••-••••-••••'; // Wipe ephemeral key from DOM
}

// UI: Copy Recovery Key to Clipboard
async function copyRecoveryKeyToClipboard() {
  const display = document.getElementById('recoveryKeyDisplay');
  const key = display ? display.textContent.trim() : '';
  if (!key) return;
  try {
    await navigator.clipboard.writeText(key);
    showToast('✓ Emergency Recovery Key copied to clipboard!', 'success', 3000);
  } catch(e) {
    prompt('Copy your Emergency Recovery Key:', key);
  }
}

// UI: Download Recovery Key as a text file (Safe generic filename without key leak)
function downloadRecoveryKeyFile() {
  const display = document.getElementById('recoveryKeyDisplay');
  const key = display ? display.textContent.trim() : '';
  if (!key) return;
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const content = [
    '=================================================================',
    '              CALENDAR APP - EMERGENCY RECOVERY KIT             ',
    '=================================================================',
    '',
    'Keep this file safe and private. This Emergency Recovery Key is the',
    'ONLY cryptographic mechanism to restore access to your encrypted',
    'calendar database, notes, finance ledgers, and attachments if you',
    'forget your Security PIN.',
    '',
    '-----------------------------------------------------------------',
    `EMERGENCY RECOVERY KEY:  ${key}`,
    '-----------------------------------------------------------------',
    '',
    `Generated On:   ${timestamp} (UTC)`,
    `App Version:    ${APP_VERSION}`,
    `Encryption:     Private Client-Side AES-256-GCM + PBKDF2 (600,000 iterations)`,
    '',
    'HOW TO RESTORE YOUR ACCESS:',
    '1. Open Calendar App on this device.',
    '2. On the lock screen, click "Forgot PIN / Passphrase?".',
    '3. Enter your Emergency Recovery Key exactly as shown above.',
    '4. Enter and confirm your new Security PIN (min 6 characters).',
    '5. Click "Reset & Unlock". Your calendar unlocks; this recovery key keeps working.',
    '',
    'SECURITY ADVICE:',
    '- Never share this key with anyone.',
    '- Store a printed copy or save it in your password manager.',
    '================================================================='
  ].join('\r\n');

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'CalendarApp-Recovery-Kit.txt'; // Generic safe filename (no key in filename)
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('✓ Recovery Kit file downloaded successfully!', 'success', 3000);
}

// UI: Email Recovery Key to user via mailto with security advisory
function emailRecoveryKey() {
  const display = document.getElementById('recoveryKeyDisplay');
  const key = display ? display.textContent.trim() : '';
  if (!key) return;

  const proceed = confirm(
    'SECURITY WARNING:\n\n' +
    'Sending your Emergency Recovery Key via unencrypted email may expose it to email providers, mail servers, and intermediaries.\n\n' +
    'For maximum security, we recommend downloading or printing the Recovery Kit file instead.\n\n' +
    'Do you still want to proceed with opening your email client?'
  );
  if (!proceed) return;

  const recipient = prompt('Enter the email address to receive your Emergency Recovery Kit:');
  if (recipient === null) return; // user cancelled
  const trimmedRecipient = recipient.trim();

  const subject = encodeURIComponent('Calendar App - My Emergency Recovery Key');
  const bodyText = [
    'Here is your Emergency Recovery Key for Calendar App.',
    '',
    `EMERGENCY RECOVERY KEY: ${key}`,
    '',
    'If you ever forget your Security PIN, open Calendar App, click "Forgot PIN / Passphrase?", and enter this key to reset your PIN and restore your calendar.',
    '',
    'Important: Keep this email confidential.'
  ].join('\n');
  const body = encodeURIComponent(bodyText);

  window.location.href = `mailto:${trimmedRecipient}?subject=${subject}&body=${body}`;
  showToast('Opening your email client...', 'info', 3000);
}

// UI: Open Forgot PIN Modal
function openForgotPinModal() {
  const modal = document.getElementById('forgotPinModal');
  if (!modal) return;
  const keyInp = document.getElementById('forgotRecoveryKeyInput');
  const pinInp = document.getElementById('forgotNewPinInput');
  const confInp = document.getElementById('forgotConfirmPinInput');
  const errEl = document.getElementById('forgotPinErrorMsg');
  if (keyInp) keyInp.value = '';
  if (pinInp) pinInp.value = '';
  if (confInp) confInp.value = '';
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.add('hidden');
  }
  modal.classList.remove('hidden');
  if (keyInp) keyInp.focus();
}

// UI: Close Forgot PIN Modal
function closeForgotPinModal() {
  const modal = document.getElementById('forgotPinModal');
  if (modal) modal.classList.add('hidden');
}

// Handle Forgot PIN Reset Submit
async function handleForgotPinResetSubmit(e) {
  e.preventDefault();
  const inputRecoveryKey = (document.getElementById('forgotRecoveryKeyInput')?.value || '').trim();
  const newPin = (document.getElementById('forgotNewPinInput')?.value || '').trim();
  const confirmPin = (document.getElementById('forgotConfirmPinInput')?.value || '').trim();
  const errEl = document.getElementById('forgotPinErrorMsg');
  const submitBtn = document.getElementById('submitForgotPinBtn');

  if (!inputRecoveryKey) {
    if (errEl) {
      errEl.textContent = 'Please enter your Emergency Recovery Key.';
      errEl.classList.remove('hidden');
    }
    return;
  }

  if (!newPin || newPin.length < 6 || newPin.length > 64) {
    if (errEl) {
      errEl.textContent = 'New PIN / Passphrase must be at least 6 characters.';
      errEl.classList.remove('hidden');
    }
    return;
  }

  if (newPin !== confirmPin) {
    if (errEl) {
      errEl.textContent = 'New PIN and confirmation do not match.';
      errEl.classList.remove('hidden');
    }
    return;
  }

  const originalBtnHtml = submitBtn ? submitBtn.innerHTML : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Restoring & Re-encrypting...';
  }

  try {
    // 1. Unwrap whatever key the vault holds: the DEK, or (before the upgrade) the old PIN-derived data key
    const recoveredRaw = await unwrapMasterKeyWithRecoveryKey(inputRecoveryKey);
    const recoveredKey = await importRuntimeAesGcmKey(recoveredRaw);

    const encryptedBytes = cachedEncryptedDbBytes || await loadDbFromIndexedDB();
    if (!encryptedBytes) {
      recoveredRaw.fill(0);
      throw new Error('No calendar database found on this device to recover.');
    }

    const env = await loadKeyEnvelope();
    let upgrade = null;
    if (env) {
      if (!(await isDekForEnvelope(recoveredKey, env))) {
        recoveredRaw.fill(0);
        throw new Error('This recovery key belongs to an older encryption key and no longer works. Use the recovery key shown when your data was upgraded, or one created later from the menu.');
      }
      const plain = await openDatabaseOrSnapshotWithKey(recoveredKey, encryptedBytes);
      if (!plain) {
        recoveredRaw.fill(0);
        throw new Error('The recovery key is correct, but the database could not be opened. Nothing was changed — check Diagnostics.');
      }
      // Only the PIN wrapper changes: the data, the fingerprint link and this recovery key stay valid.
      let newPinWrapper;
      try {
        newPinWrapper = await wrapDekWithPin(recoveredRaw, env.dekId, newPin);
      } finally {
        recoveredRaw.fill(0);
      }
      await saveKeyEnvelope(Object.assign({}, env, { pin: newPinWrapper, pinChanged: new Date().toISOString() }));
      db = new SQL.Database(plain);
      ensureSchemaUpToDate();
      activateDek(recoveredKey, env.dekId);
    } else {
      // Legacy data: open it with the recovered key, then upgrade. The recovery key just typed is kept
      // (re-pointed at the new DEK), so the user doesn't have to store a new one.
      recoveredRaw.fill(0);
      const decryptedBytes = await decryptDatabaseBytes(encryptedBytes, recoveredKey, false);
      if (!isValidSqliteBinary(decryptedBytes)) {
        throw new Error('Database recovery failed: decrypted data is not a valid SQLite database.');
      }
      db = new SQL.Database(decryptedBytes);
      ensureSchemaUpToDate();
      upgrade = await migrateLegacyDataToEnvelope({ pin: newPin, keyRing: createKeyRing(null, [recoveredKey]), recoveryKey: inputRecoveryKey });
    }

    resetAutoLockTimer();
    recordSuccessfulPinAttempt();
    purgeLegacySessionAndDiskTokens();
    localStorage.removeItem('srg_recovery_key_display');

    isAppUnlocked = true;
    const overlay = document.getElementById('appLockOverlay');
    if (overlay) overlay.classList.add('hidden');
    closeForgotPinModal();

    loadMasterDataFromDb();
    populateTitlesDatalist();
    switchToView(currentView, currentDate);
    updateBadge('Local SQLite Active');

    if (biometricSnapshotFallbackActive) {
      showToast('⚠ PIN reset. Your main database could not be opened, so the newest readable snapshot was opened with saving paused. Download DB (.db) now and check Diagnostics.', 'warning', 0);
    } else if (upgrade) {
      showToast('✓ PIN reset.', 'success', 3000);
      showUpgradeOutcome(upgrade);
    } else {
      showToast('✓ PIN reset. Your data, fingerprint unlock and this recovery key are unchanged.', 'success', 6000);
    }
    afterUnlockBackgroundTasks();

  } catch(err) {
    console.error('handleForgotPinResetSubmit error:', err);
    if (errEl) {
      errEl.textContent = 'Recovery failed: ' + (err.message || 'Invalid Emergency Recovery Key');
      errEl.classList.remove('hidden');
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalBtnHtml;
    }
  }
}

/* ==========================================================================
   ABOUT SRG CALENDAR PRO HANDLERS
   ========================================================================== */
function openAboutModal() {
  const modal = document.getElementById('aboutModal');
  if (!modal) return;
  const verEl = document.getElementById('aboutModalVersion');
  if (verEl) verEl.textContent = APP_VERSION;
  modal.classList.remove('hidden');
}

function closeAboutModal() {
  const modal = document.getElementById('aboutModal');
  if (!modal) return;
  modal.classList.add('hidden');
}

/* ==========================================================================
   ATOMIC RE-ENCRYPTION UTILITY
   ========================================================================== */
// Atomically stages, validates, and re-encrypts all snapshots, attachments, active database, and recovery vault
/* ---------- Key ring: every key that may have encrypted data on this device ---------- */
// Earlier versions let the PIN key, the fingerprint token and older salts drift onto different keys,
// so the database, snapshots and attachments can be under a mix of them. A key ring reads data under
// any of them, deriving PIN-based keys lazily (each costs a 600k-iteration PBKDF2 run).
function createKeyRing(pin = null, extraKeys = []) {
  const keys = [];
  const add = k => { if (k && !keys.includes(k)) keys.push(k); };
  add(currentEncryptionKey);
  extraKeys.forEach(add);
  let configs = null;
  let nextConfig = 0;

  async function deriveNext() {
    if (!pin) return false;
    if (!configs) configs = await getAllCandidateCryptoConfigs();
    while (nextConfig < configs.length) {
      const cfg = configs[nextConfig++];
      try {
        add(await deriveKeyFromPin(pin, cfg.salt, cfg.iterations, false));
        return true;
      } catch (e) {}
    }
    return false;
  }

  // Runs fn(key) with each key until one succeeds (fn must throw on failure). The winning key moves
  // to the front because neighbouring items are usually under the same key.
  async function tryEach(fn) {
    let i = 0;
    while (true) {
      while (i < keys.length) {
        const key = keys[i];
        try {
          const result = await fn(key);
          if (i > 0) { keys.splice(i, 1); keys.unshift(key); }
          return { ok: true, result, key };
        } catch (e) {
          i++;
        }
      }
      if (!(await deriveNext())) return { ok: false };
    }
  }

  return { tryEach };
}

async function decryptDbWithKeyRing(bytes, keyRing) {
  return keyRing.tryEach(async k => {
    const out = await decryptDatabaseBytes(bytes, k, false);
    if (!isValidSqliteBinary(out)) throw new Error('Not a valid SQLite database');
    return out;
  });
}

async function decryptAttachmentWithKeyRing(value, keyRing) {
  if (!isEncryptedAttachmentBytes(value)) return { ok: true, result: await decryptAttachmentData(value, null) };
  return keyRing.tryEach(async k => {
    const out = await decryptAttachmentData(value, k);
    if (!out) throw new Error('Empty attachment payload');
    return out;
  });
}

// Normalizes a stored attachment (data URL string, or bytes holding a data URL or raw file) to a data URL.
function attachmentPayloadToDataUrl(data, mimeHint = 'application/octet-stream') {
  if (typeof data === 'string') {
    if (data.startsWith('data:')) return data;
    return `data:${mimeHint};base64,${data.replace(/\s+/g, '')}`;
  }
  const bytes = data instanceof Uint8Array ? data : (data instanceof ArrayBuffer ? new Uint8Array(data) : null);
  if (!bytes) return null;
  try {
    const head = new TextDecoder().decode(bytes.subarray(0, 5));
    if (head === 'data:') return new TextDecoder().decode(bytes);
  } catch (e) {}
  return `data:${mimeHint};base64,${bufferToBase64(bytes)}`;
}

function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  if (/;base64$/i.test(meta)) return base64ToBuffer(body.replace(/\s+/g, ''));
  return new TextEncoder().encode(decodeURIComponent(body));
}

function dataUrlMime(dataUrl) {
  const m = /^data:([^;,]+)/.exec(dataUrl || '');
  return m ? m[1] : 'application/octet-stream';
}

function extForMime(mime) {
  if (mime.includes('jpeg')) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('pdf')) return 'pdf';
  return 'bin';
}

// Backups are always encrypted with a key derived from the PIN and the backup's own fresh salt,
// so they restore with the PIN alone regardless of which key the device happens to hold in memory.
async function requestBackupEncryptionKey() {
  const pin = await requestPinPromptModal({
    title: 'Encrypt Backup',
    message: 'Enter your Security PIN. The backup will be encrypted so that only this PIN can restore it:',
    placeholder: 'Enter Security PIN',
    confirmText: 'Encrypt Backup',
    iconClass: 'fa-solid fa-lock'
  });
  if (!pin || !pin.trim()) return null;
  if (!(await verifyPinWithAuthToken(pin.trim()))) {
    throw new Error('Incorrect Security PIN — backup not created.');
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKeyFromPin(pin.trim(), salt, PBKDF2_ITERATIONS, false);
  return { pin: pin.trim(), key, salt };
}

// Re-encrypts every snapshot, attachment and the live database (from memory) under the DEK, reading each
// item with whichever key in the key ring opens it. Everything is staged and verified in memory first and
// committed in ONE IndexedDB transaction, so a failure part-way leaves storage exactly as it was.
// Items no key can open are left untouched and reported. Nothing is deleted: the previous live database
// file and recovery vault are kept under srg_legacy_* keys the first time they are replaced.
async function atomicReencryptAllData({ dekKey, dekId, keyRing, envelope = null, vaultBytes = null }) {
  if (!dekKey || !dekId || !keyRing) {
    throw new Error('Missing encryption parameters for atomic re-encryption');
  }
  const skipped = { snapshots: [], attachments: [] };
  const counts = { snapshots: 0, attachments: 0 };
  const idb = await openSRGDatabase();

  // 1. Stage and verify snapshots
  const stagedSnapshots = [];
  const snapList = await new Promise((resolve, reject) => {
    try {
      const req = idb.transaction('snapshots', 'readonly').objectStore('snapshots').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    } catch(e) {
      resolve([]);
    }
  });

  for (const snap of snapList) {
    if (!snap || !snap.data) continue;
    const snapBytes = new Uint8Array(snap.data);
    let dec = null;
    if (isEncryptedDbBytes(snapBytes)) {
      const hit = await decryptDbWithKeyRing(snapBytes, keyRing);
      if (!hit.ok) { skipped.snapshots.push(snap.name || snap.id); continue; }
      dec = hit.result;
    } else if (isValidSqliteBinary(snapBytes)) {
      dec = snapBytes; // an old unencrypted snapshot: encrypt it too
    } else {
      continue;
    }
    const reEnc = await encryptWithDek(dec, dekKey, dekId);
    const verifyDec = await decryptDatabaseBytes(reEnc, dekKey, false);
    if (verifyDec.byteLength !== dec.byteLength) {
      throw new Error(`Verification failed for re-encrypted snapshot "${snap.name || snap.id}".`);
    }
    stagedSnapshots.push(Object.assign({}, snap, { data: reEnc, size: reEnc.byteLength }));
    counts.snapshots++;
  }

  // 2. Stage and verify attachments; also read the current live file and vault for the legacy copies
  const fileEntries = [];
  let oldLiveBytes = null, oldVault = null, hasLegacyLive = false, hasLegacyVault = false;
  await new Promise((resolve, reject) => {
    try {
      const cursorReq = idb.transaction('files', 'readonly').objectStore('files').openCursor();
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return resolve();
        const k = String(cursor.key);
        if (k === 'active_sqlite') oldLiveBytes = cursor.value;
        else if (k === 'srg_recovery_vault') oldVault = cursor.value;
        else if (k === 'srg_legacy_active_sqlite') hasLegacyLive = true;
        else if (k === 'srg_legacy_recovery_vault') hasLegacyVault = true;
        else if (!RESERVED_FILE_KEYS.has(k)) fileEntries.push({ key: k, value: cursor.value });
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    } catch(e) {
      resolve();
    }
  });

  const stagedAttachments = [];
  for (const entry of fileEntries) {
    let plainData = null;
    if (isEncryptedAttachmentBytes(entry.value)) {
      const hit = await decryptAttachmentWithKeyRing(entry.value, keyRing);
      if (!hit.ok) { skipped.attachments.push(entry.key); continue; }
      plainData = hit.result;
      if (!plainData) {
        throw new Error(`Empty decrypted payload for attachment ${entry.key}. Aborting.`);
      }
    } else if (typeof entry.value === 'string') {
      plainData = entry.value;
    } else if (entry.value instanceof Uint8Array || entry.value instanceof ArrayBuffer) {
      try {
        const dec = new TextDecoder().decode(entry.value);
        if (dec.startsWith('data:')) plainData = dec;
      } catch(err) {}
    }

    if (plainData) {
      const reEnc = await encryptAttachmentData(plainData, dekKey);
      const verifyPlain = await decryptAttachmentData(reEnc, dekKey);
      if (!verifyPlain || verifyPlain.length !== plainData.length) {
        throw new Error(`Verification failed for re-encrypted attachment ${entry.key}.`);
      }
      stagedAttachments.push({ key: entry.key, value: reEnc });
      counts.attachments++;
    }
  }

  // 3. Stage and verify the live database from memory
  let stagedActiveDb = null;
  if (db) {
    const rawDbBytes = db.export();
    stagedActiveDb = await encryptWithDek(rawDbBytes, dekKey, dekId);
    const verifyDb = await decryptDatabaseBytes(stagedActiveDb, dekKey, false);
    if (verifyDb.byteLength !== rawDbBytes.byteLength) {
      throw new Error('Live database re-encryption verification failed. Aborting.');
    }
  }
  const keepOldLive = !!(stagedActiveDb && oldLiveBytes && !hasLegacyLive &&
    !(isEncryptedDbBytes(oldLiveBytes) && parseEncryptedDbHeader(oldLiveBytes).version === 3));
  const keepOldVault = !!(vaultBytes && oldVault && !hasLegacyVault);

  // 4. Atomic commit spanning BOTH stores in a single transaction
  await new Promise((resolve, reject) => {
    const tx = idb.transaction(['snapshots', 'files'], 'readwrite');
    const snapStore = tx.objectStore('snapshots');
    const fileStore = tx.objectStore('files');

    for (const snap of stagedSnapshots) snapStore.put(snap);
    for (const att of stagedAttachments) fileStore.put(att.value, att.key);
    if (keepOldLive) fileStore.put(oldLiveBytes, 'srg_legacy_active_sqlite');
    if (keepOldVault) fileStore.put(oldVault, 'srg_legacy_recovery_vault');
    if (stagedActiveDb) fileStore.put(stagedActiveDb, 'active_sqlite');
    if (vaultBytes) fileStore.put(vaultBytes, 'srg_recovery_vault');
    if (envelope) fileStore.put(envelope, 'srg_key_envelope');

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Atomic re-encryption transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('Atomic re-encryption transaction aborted'));
  });

  if (stagedActiveDb) {
    cachedEncryptedDbBytes = stagedActiveDb;
  }

  return { skipped, counts };
}

/* ==========================================================================
   SECURE PIN PROMPT MODAL (MASKED PASSWORD INPUT DIALOG)
   ========================================================================== */
let activePinPromptResolver = null;

function requestPinPromptModal({
  title = 'Enter Security PIN',
  message = 'Please enter your Security PIN to continue.',
  placeholder = 'Enter Security PIN',
  confirmText = 'Confirm',
  iconClass = 'fa-solid fa-shield-halved'
} = {}) {
  return new Promise((resolve) => {
    // If there's an existing prompt open, cancel it first
    if (activePinPromptResolver) {
      activePinPromptResolver(null);
      activePinPromptResolver = null;
    }

    const modal = document.getElementById('securePinPromptModal');
    const titleEl = document.getElementById('securePinPromptTitle');
    const msgEl = document.getElementById('securePinPromptMessage');
    const inputEl = document.getElementById('securePinPromptInput');
    const submitTextEl = document.getElementById('securePinPromptSubmitText');
    const iconEl = document.getElementById('securePinPromptIcon');
    const errEl = document.getElementById('securePinPromptError');

    if (!modal || !inputEl) {
      const fallback = prompt(`${title}\n\n${message}`);
      return resolve(fallback);
    }

    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message;
    if (inputEl) {
      inputEl.placeholder = placeholder;
      inputEl.value = '';
      inputEl.type = 'password';
    }
    if (submitTextEl) submitTextEl.textContent = confirmText;
    if (iconEl && iconClass) {
      iconEl.className = iconClass;
    }
    if (errEl) {
      errEl.textContent = '';
      errEl.classList.add('hidden');
    }

    const toggleBtn = document.getElementById('securePinPromptToggleVisibility');
    if (toggleBtn) {
      toggleBtn.innerHTML = '<i class="fa-solid fa-eye"></i>';
    }

    activePinPromptResolver = resolve;
    modal.classList.remove('hidden');

    setTimeout(() => {
      inputEl.focus();
    }, 80);
  });
}

function closeSecurePinPromptModal(result = null) {
  const modal = document.getElementById('securePinPromptModal');
  if (modal) {
    modal.classList.add('hidden');
  }
  const inputEl = document.getElementById('securePinPromptInput');
  if (inputEl) {
    inputEl.value = '';
    inputEl.type = 'password';
  }
  if (activePinPromptResolver) {
    const res = activePinPromptResolver;
    activePinPromptResolver = null;
    res(result);
  }
}

/* ==========================================================================
   CHANGE SECURITY PIN HANDLERS
   ========================================================================== */
function openChangePinModal() {
  const modal = document.getElementById('changePinModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  const currentPinInput = document.getElementById('currentPinInput');
  const newPinInput = document.getElementById('newPinInput');
  const confirmPinInput = document.getElementById('confirmPinInput');
  if (currentPinInput) currentPinInput.value = '';
  if (newPinInput) newPinInput.value = '';
  if (confirmPinInput) confirmPinInput.value = '';

  const errEl = document.getElementById('changePinErrorMsg');
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.add('hidden');
  }
  modal.classList.remove('hidden');
  if (currentPinInput) currentPinInput.focus();
}

function closeChangePinModal() {
  const modal = document.getElementById('changePinModal');
  if (modal) modal.classList.add('hidden');
}

async function handleChangePinSubmit(e) {
  e.preventDefault();
  const currentPin = (document.getElementById('currentPinInput')?.value || '').trim();
  const newPin = (document.getElementById('newPinInput')?.value || '').trim();
  const confirmPin = (document.getElementById('confirmPinInput')?.value || '').trim();
  const errEl = document.getElementById('changePinErrorMsg');

  // Verify current PIN (envelope mode: it must unwrap the data key)
  const isCurrentPinValid = await verifyPinWithAuthToken(currentPin);
  if (!isCurrentPinValid) {
    if (errEl) {
      errEl.textContent = 'Current PIN is incorrect.';
      errEl.classList.remove('hidden');
    }
    return;
  }
  if (!newPin || newPin.length < 6 || newPin.length > 64) {
    if (errEl) {
      errEl.textContent = 'New PIN / Passphrase must be at least 6 characters.';
      errEl.classList.remove('hidden');
    }
    return;
  }
  if (newPin !== confirmPin) {
    if (errEl) {
      errEl.textContent = 'New PIN and confirmation PIN do not match.';
      errEl.classList.remove('hidden');
    }
    return;
  }

  const saveBtn = document.getElementById('saveNewPinBtn');
  const originalBtnText = saveBtn ? saveBtn.innerHTML : '';
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Updating...';
  }

  try {
    const env = await loadKeyEnvelope();
    if (env) {
      // Envelope mode: re-wrap the same data key under the new PIN. No data is re-encrypted, and the
      // fingerprint link and recovery key keep working because they wrap the same key.
      const rawDek = await unwrapDekWithPin(env, currentPin);
      let newPinWrapper;
      try {
        newPinWrapper = await wrapDekWithPin(rawDek, env.dekId, newPin);
      } finally {
        rawDek.fill(0);
      }
      await saveKeyEnvelope(Object.assign({}, env, { pin: newPinWrapper, pinChanged: new Date().toISOString() }));
      resetAutoLockTimer();
      closeChangePinModal();
      showToast('✓ Security PIN changed. Your data, fingerprint unlock and recovery key are unchanged.', 'success', 6000);
      return;
    }

    // Legacy mode (unlocked by fingerprint before the upgrade): upgrade now, reading everything under
    // every key the current PIN and the in-memory key can open.
    let oldKey = currentEncryptionKey;
    if (!oldKey) {
      const storedSalt = await getEffectiveCryptoSalt();
      if (!storedSalt) throw new Error('Could not retrieve encryption salt to verify current PIN.');
      oldKey = await deriveKeyFromPin(currentPin, storedSalt);
    }
    const keyRing = createKeyRing(currentPin, [oldKey]);

    // If this session was opened from a snapshot, the stored database may be newer: use it when any key opens it.
    if (biometricSnapshotFallbackActive) {
      const storedBytes = await loadDbFromIndexedDB();
      if (storedBytes) {
        const hit = await decryptDbWithKeyRing(storedBytes, keyRing);
        if (hit.ok) {
          db = new SQL.Database(hit.result);
          ensureSchemaUpToDate();
        }
      }
    }

    const upgrade = await migrateLegacyDataToEnvelope({ pin: newPin, keyRing });
    resetAutoLockTimer();
    purgeLegacySessionAndDiskTokens();
    localStorage.removeItem('srg_recovery_key_display');

    closeChangePinModal();
    loadMasterDataFromDb();
    renderCurrentView();
    showToast('✓ Security PIN set.', 'success', 3000);
    showUpgradeOutcome(upgrade);
  } catch (err) {
    console.error('Error changing PIN:', err);
    if (errEl) {
      errEl.textContent = 'Error updating PIN: ' + err.message;
      errEl.classList.remove('hidden');
    }
    showToast('Error updating PIN', 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = originalBtnText;
    }
  }
}

function updateReadOnlyState() {
  isReadOnly = false;
}

async function checkServerSyncOnStartup() {
  updateReadOnlyState();
}

/* ==========================================================================
   ATTACHMENT VIEWER MODAL FUNCTION
   ========================================================================== */

async function openAttachmentViewer(att) {
  if (!att) return;
  const modal = document.getElementById('attachmentViewerModal');
  const body = document.getElementById('attachmentViewerBody');
  const title = document.getElementById('attachmentViewerTitle');
  const downloadLink = document.getElementById('attachmentDownloadLink');

  if (!modal || !body) return;

  if (title) title.textContent = att.name || 'Attachment Viewer';
  body.innerHTML = '<div style="padding:40px; color:var(--text-muted);"><i class="fa-solid fa-spinner fa-spin fa-2x"></i><br><br>Loading attachment...</div>';
  modal.classList.remove('hidden');

  let dataUrl = null;
  try {
    const raw = await getAttachmentData(att);
    dataUrl = raw ? attachmentPayloadToDataUrl(raw, att.type || 'application/pdf') : null;
    if (raw && isEncryptedAttachmentBytes(raw)) dataUrl = null; // still encrypted under another key
  } catch (e) {
    console.warn('Attachment load error:', e);
    dataUrl = null;
  }
  if (!dataUrl) {
    body.innerHTML = '<div style="padding:40px; color:#fb7185;"><i class="fa-solid fa-triangle-exclamation fa-2x"></i><br><br>Unable to open this attachment. It may be encrypted under an older key: use <strong>Change Security PIN</strong> (the same PIN is fine) to re-secure your data, then try again.</div>';
    return;
  }

  // Validate allowed safe URL protocols (reject javascript: or untrusted schemes)
  if (!dataUrl.startsWith('data:') && !dataUrl.startsWith('blob:') && !dataUrl.startsWith('http://') && !dataUrl.startsWith('https://')) {
    body.innerHTML = '<div style="padding:40px; color:#fb7185;"><i class="fa-solid fa-triangle-exclamation fa-2x"></i><br><br>Blocked attachment with invalid or unsafe URL scheme.</div>';
    return;
  }

  if (downloadLink) {
    downloadLink.href = dataUrl;
    downloadLink.download = att.filename || att.name || 'attachment';
  }

  const mime = att.type || '';
  if (mime.startsWith('image/') || (dataUrl.startsWith('data:image/'))) {
    body.innerHTML = '';
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = att.name || 'Attachment Preview';
    img.style.cssText = 'max-width:100%; max-height:70vh; border-radius:var(--radius-md); box-shadow:var(--shadow-md);';
    body.appendChild(img);
  } else if (mime.includes('pdf') || dataUrl.startsWith('data:application/pdf')) {
    // A data: URL in an iframe is blocked by the CSP (Chrome shows a sad-face icon), and Android Chrome has
    // no in-frame PDF viewer anyway, so render the pages with the bundled PDF.js instead.
    body.innerHTML = '<div style="padding:30px; color:var(--text-muted);"><i class="fa-solid fa-spinner fa-spin"></i> Rendering PDF…</div>';
    let rendered = false;
    try {
      rendered = await renderPdfIntoContainer(dataUrlToBytes(dataUrl), body);
    } catch (e) {
      console.warn('PDF render failed:', e);
    }
    if (!rendered) {
      body.innerHTML = '<div style="padding:40px; color:#fb7185;"><i class="fa-solid fa-triangle-exclamation fa-2x"></i><br><br>This PDF could not be displayed here. Tap <strong>Download</strong> above to open it in your PDF app.</div>';
    }
  } else {
    body.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.padding = '40px';
    const dlBtn = document.createElement('a');
    dlBtn.href = dataUrl;
    dlBtn.download = att.filename || att.name || 'attachment';
    dlBtn.className = 'btn-primary';
    dlBtn.innerHTML = '<i class="fa-solid fa-download"></i> ';
    dlBtn.appendChild(document.createTextNode(` Download ${att.name || 'Attachment'}`));
    wrap.appendChild(dlBtn);
    body.appendChild(wrap);
  }
}

function closeAttachmentViewer() {
  const modal = document.getElementById('attachmentViewerModal');
  if (modal) modal.classList.add('hidden');
}

/* ==========================================================================
   DAILY PERSONAL FINANCE FUNCTIONS
   ========================================================================== */

function getDailyTransactionsForDate(dateStr) {
  if (!db || !dateStr) return [];
  try {
    const res = db.exec("SELECT * FROM daily_transactions WHERE txn_date = ? ORDER BY created_at ASC", [dateStr]);
    if (res && res.length > 0) {
      return rowsToObjects(res[0]);
    }
  } catch (e) {
    console.warn("Error getting daily transactions:", e);
  }
  return [];
}

function getDailyTransactionsMap() {
  const map = {};
  if (!db) return map;
  try {
    const res = db.exec("SELECT txn_date, type, amount, description FROM daily_transactions ORDER BY created_at ASC");
    if (res && res.length > 0) {
      const rows = rowsToObjects(res[0]);
      rows.forEach(r => {
        if (!map[r.txn_date]) map[r.txn_date] = { receipts: 0, payments: 0, count: 0 };
        if (r.type === 'receipt') map[r.txn_date].receipts += toPaise(r.amount);
        else if (r.type === 'payment') map[r.txn_date].payments += toPaise(r.amount);
        map[r.txn_date].count++;
      });
    }
  } catch (e) {
    console.warn("Error reading daily transactions map:", e);
  }
  return map;
}

async function saveDailyTransaction(txn) {
  if (!db || !txn || !txn.txn_date) return;
  const id = txn.id || ('txn_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6));
  const dateStr = txn.txn_date;
  const type = txn.type;
  const debitAcct = findAccount(txn.debit_account);
  const creditAcct = findAccount(txn.credit_account);
  const amount = toPaise(txn.amount) / 100; // stored as rupees, normalised to whole paise
  const desc = (txn.description || '').trim();
  const now = new Date().toISOString();

  const problem =
    !VOUCHER_TYPES[type] ? 'Choose a voucher type.' :
    !debitAcct ? 'Choose a debit account from the chart of accounts (or add a new one).' :
    !creditAcct ? 'Choose a credit account from the chart of accounts (or add a new one).' :
    debitAcct.name.toLowerCase() === creditAcct.name.toLowerCase() ? 'Debit and credit accounts must be different.' :
    !(amount > 0) ? 'Enter an amount greater than zero.' : null;
  if (problem) {
    showToast('⚠ ' + problem, 'error', 4500);
    return false;
  }

  try {
    // COALESCE keeps the original created_at when an existing entry is edited (it drives display order).
    db.run(`
      INSERT OR REPLACE INTO daily_transactions
      (id, txn_date, type, debit_account, credit_account, amount, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM daily_transactions WHERE id = ?), ?), ?)
    `, [id, dateStr, type, debitAcct.name, creditAcct.name, amount, desc, id, now, now]);

    await saveDbToIndexedDB();
    renderCurrentView();
    renderFinanceTransactionsList(dateStr);
    populateFinanceAccountsDatalists();
    showToast('✓ Financial transaction saved locally!', 'success', 3000);
    return true;
  } catch(err) {
    console.error('Error saving transaction:', err);
    showToast('❌ Error saving transaction: ' + err.message, 'error', 4000);
    return false;
  }
}

async function deleteDailyTransaction(txnId, dateStr) {
  if (!db || !txnId) return;
  try {
    db.run("DELETE FROM daily_transactions WHERE id = ?", [txnId]);
    await saveDbToIndexedDB();
    renderCurrentView();
    renderFinanceTransactionsList(dateStr);
    populateFinanceAccountsDatalists();
    showToast('✓ Transaction deleted!', 'success', 3000);
  } catch(err) {
    console.error('Error deleting transaction:', err);
    showToast('❌ Error deleting transaction: ' + err.message, 'error', 4000);
  }
}

function openDailyFinanceModal(dateStr) {
  const modal = document.getElementById('dailyFinanceModal');
  const dateInput = document.getElementById('financeTxnDate');
  const modalTitle = document.getElementById('dailyFinanceModalTitle');
  
  if (!modal || !dateStr) return;

  const [y, m, d] = dateStr.split('-').map(Number);
  const dObj = new Date(y, m - 1, d);
  const formattedDate = formatDateIndian(dObj);

  if (dateInput) dateInput.value = dateStr;
  if (modalTitle) modalTitle.textContent = `Daily Receipts & Payments (${formattedDate})`;

  resetFinanceForm();
  renderFinanceTransactionsList(dateStr);
  populateFinanceAccountsDatalists();

  modal.classList.remove('hidden');
}

function closeDailyFinanceModal() {
  const modal = document.getElementById('dailyFinanceModal');
  if (modal) modal.classList.add('hidden');
}

function resetFinanceForm() {
  const form = document.getElementById('financeTxnForm');
  if (form) form.reset();
  document.getElementById('financeTxnId').value = '';
  document.getElementById('financeFormTitle').innerHTML = '<i class="fa-solid fa-plus"></i> Add New Transaction';
  const resetBtn = document.getElementById('resetFinanceFormBtn');
  if (resetBtn) resetBtn.style.display = 'none';
  closeFinanceNewAccountPanel(false);
  updateFinanceTypeHint();
}

function renderFinanceTransactionsList(dateStr) {
  const container = document.getElementById('financeTxnList');
  const receiptsEl = document.getElementById('dayTotalReceipts');
  const paymentsEl = document.getElementById('dayTotalPayments');
  const netEl = document.getElementById('dayNetBalance');

  if (!container) return;
  container.innerHTML = '';

  const txns = getDailyTransactionsForDate(dateStr);
  let totalReceipts = 0;
  let totalPayments = 0;

  if (txns.length === 0) {
    container.innerHTML = '<div style="font-size:0.85rem; color:var(--text-muted); text-align:center; padding:12px;">No financial transactions for this date.</div>';
  } else {
    txns.forEach(t => {
      const amt = toPaise(t.amount);
      if (t.type === 'receipt') totalReceipts += amt;
      else if (t.type === 'payment') totalPayments += amt;

      const card = document.createElement('div');
      card.style.cssText = 'background:var(--bg-primary); border:1px solid var(--border-color); border-radius:var(--radius-md); padding:10px 12px; display:flex; justify-content:space-between; align-items:center; font-size:0.88rem;';
      card.innerHTML = `
        <div>
          <span style="font-weight:600; color:${voucherTypeInfo(t.type).color};">
            ${voucherTypeInfo(t.type).icon} ${voucherTypeInfo(t.type).label} &mdash; ${formatINR(amt)}
          </span>
          <div style="font-size:0.78rem; color:var(--text-muted); margin-top:2px;">
            Dr: <strong>${escapeHtml(t.debit_account || '')}</strong> | Cr: <strong>${escapeHtml(t.credit_account || '')}</strong>
            ${t.description ? ` | ${escapeHtml(t.description)}` : ''}
          </div>
        </div>
        <div style="display:flex; gap:6px;">
          <button type="button" class="btn-xs btn-secondary edit-txn-btn" title="Edit"><i class="fa-solid fa-pen"></i></button>
          <button type="button" class="btn-xs btn-danger del-txn-btn" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </div>
      `;

      const editBtn = card.querySelector('.edit-txn-btn');
      if (editBtn) {
        editBtn.addEventListener('click', () => {
          document.getElementById('financeTxnId').value = t.id;
          document.getElementById('financeType').value = t.type;
          document.getElementById('financeAmount').value = t.amount;
          setAccountSelectValue(document.getElementById('financeDebitAccount'), t.debit_account || '');
          setAccountSelectValue(document.getElementById('financeCreditAccount'), t.credit_account || '');
          updateFinanceTypeHint();
          document.getElementById('financeDescription').value = t.description || '';
          document.getElementById('financeFormTitle').innerHTML = '<i class="fa-solid fa-pen-to-square"></i> Edit Transaction';
          const rBtn = document.getElementById('resetFinanceFormBtn');
          if (rBtn) rBtn.style.display = 'inline-block';
        });
      }

      const delBtn = card.querySelector('.del-txn-btn');
      if (delBtn) {
        delBtn.addEventListener('click', () => {
          if (confirm('Delete this financial transaction?')) {
            deleteDailyTransaction(t.id, dateStr);
          }
        });
      }

      container.appendChild(card);
    });
  }

  const net = totalReceipts - totalPayments;
  if (receiptsEl) receiptsEl.textContent = `${formatINR(totalReceipts)}`;
  if (paymentsEl) paymentsEl.textContent = `${formatINR(totalPayments)}`;
  if (netEl) {
    netEl.textContent = `${formatINR(net)}`;
    netEl.style.color = net >= 0 ? 'var(--net-positive)' : 'var(--payment-color)';
  }
}

/* ==========================================================================
   CHART OF ACCOUNTS & VOUCHER TYPES
   ========================================================================== */

// Conventional Indian bookkeeping voucher types. Only receipts and payments move the cash-flow totals;
// contra (cash <-> bank) and journal (non-cash adjustments) still post to both ledgers.
const VOUCHER_TYPES = {
  receipt: { label: 'Receipt', icon: '🟢', color: 'var(--receipt-color)', hint: 'Money in. Dr: Cash/Bank (asset) · Cr: Income or the party who paid.' },
  payment: { label: 'Payment', icon: '🔴', color: 'var(--payment-color)', hint: 'Money out. Dr: Expense or the party paid · Cr: Cash/Bank (asset).' },
  contra:  { label: 'Contra',  icon: '🔁', color: 'var(--net-positive)',  hint: 'Transfer between your own cash/bank accounts. Dr: account receiving · Cr: account giving.' },
  journal: { label: 'Journal', icon: '📝', color: 'var(--text-muted)',    hint: 'Non-cash adjustment (e.g. opening balance: Dr Bank, Cr Capital; amount due; write-off; correction).' }
};

function voucherTypeInfo(type) {
  return VOUCHER_TYPES[type] || { label: type || 'Entry', icon: '•', color: 'var(--text-muted)', hint: '' };
}

const ACCOUNT_TYPES = {
  asset: 'Asset',
  liability: 'Liability',
  equity: 'Equity / Capital',
  revenue: 'Revenue',
  expenditure: 'Expenditure',
  unclassified: 'Unclassified'
};
const ACCOUNT_TYPE_ORDER = ['asset', 'liability', 'equity', 'revenue', 'expenditure', 'unclassified'];
const ACCOUNT_NAME_MAX = 60;
const NEW_ACCOUNT_OPTION = '__new_account__';

function normalizeAccountName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim();
}

function getChartOfAccounts() {
  if (!db) return [];
  try {
    const res = db.exec(`
      SELECT c.name, c.account_type,
        (SELECT COUNT(*) FROM daily_transactions t
          WHERE TRIM(t.debit_account) = c.name COLLATE NOCASE OR TRIM(t.credit_account) = c.name COLLATE NOCASE) AS usage
      FROM chart_of_accounts c
      ORDER BY c.name COLLATE NOCASE
    `);
    return res.length > 0 ? rowsToObjects(res[0]) : [];
  } catch (e) {
    console.warn('Error reading chart of accounts:', e);
    return [];
  }
}

function findAccount(name) {
  const n = normalizeAccountName(name);
  if (!db || !n) return null;
  const res = db.exec("SELECT name, account_type FROM chart_of_accounts WHERE name = ? COLLATE NOCASE", [n]);
  return res.length > 0 && res[0].values.length > 0 ? { name: res[0].values[0][0], account_type: res[0].values[0][1] } : null;
}

function validateAccountInput(name, type) {
  const n = normalizeAccountName(name);
  if (!n) return 'Enter an account name.';
  if (n.length > ACCOUNT_NAME_MAX) return `Account name is too long (max ${ACCOUNT_NAME_MAX} characters).`;
  if (n === NEW_ACCOUNT_OPTION) return 'That name is reserved. Choose another.';
  if (!ACCOUNT_TYPES[type]) return 'Choose an account type.';
  return null;
}

// Returns the newly created account. Throws with a user-readable message.
async function addAccount(name, type) {
  const err = validateAccountInput(name, type);
  if (err) throw new Error(err);
  const n = normalizeAccountName(name);
  const existing = findAccount(n);
  if (existing) throw new Error(`"${existing.name}" already exists in the chart of accounts.`);
  const now = new Date().toISOString();
  db.run("INSERT INTO chart_of_accounts (name, account_type, created_at, updated_at) VALUES (?, ?, ?, ?)", [n, type, now, now]);
  await saveDbToIndexedDB();
  return { name: n, account_type: type };
}

async function setAccountType(name, type) {
  if (!ACCOUNT_TYPES[type]) throw new Error('Unknown account type.');
  db.run("UPDATE chart_of_accounts SET account_type = ?, updated_at = ? WHERE name = ? COLLATE NOCASE", [type, new Date().toISOString(), name]);
  await saveDbToIndexedDB();
}

// Rename an account, or merge it into another existing account. All transactions are re-pointed in one SQL transaction.
async function renameOrMergeAccount(oldName, newName) {
  const from = findAccount(oldName);
  if (!from) throw new Error(`Account "${oldName}" was not found.`);
  const to = normalizeAccountName(newName);
  const err = validateAccountInput(to, from.account_type);
  if (err) throw new Error(err);
  if (to === from.name) return { merged: false, name: to };

  const target = findAccount(to);
  const isMerge = !!target && target.name.toLowerCase() !== from.name.toLowerCase();

  if (isMerge) {
    // A merge must not turn any entry into "Dr X / Cr X".
    const clash = db.exec(`
      SELECT COUNT(*) FROM daily_transactions
      WHERE (TRIM(debit_account) = ? COLLATE NOCASE AND TRIM(credit_account) = ? COLLATE NOCASE)
         OR (TRIM(debit_account) = ? COLLATE NOCASE AND TRIM(credit_account) = ? COLLATE NOCASE)
    `, [from.name, target.name, target.name, from.name]);
    const clashCount = clash.length ? clash[0].values[0][0] : 0;
    if (clashCount > 0) {
      throw new Error(`Cannot merge: ${clashCount} transaction(s) are between "${from.name}" and "${target.name}" and would debit and credit the same account. Edit those entries first.`);
    }
  }

  const finalName = isMerge ? target.name : to;
  const now = new Date().toISOString();
  db.run('BEGIN');
  try {
    db.run("UPDATE daily_transactions SET debit_account = ?, updated_at = ? WHERE TRIM(debit_account) = ? COLLATE NOCASE", [finalName, now, from.name]);
    db.run("UPDATE daily_transactions SET credit_account = ?, updated_at = ? WHERE TRIM(credit_account) = ? COLLATE NOCASE", [finalName, now, from.name]);
    if (isMerge) {
      db.run("DELETE FROM chart_of_accounts WHERE name = ? COLLATE NOCASE", [from.name]);
      // Keep the more informative type if the target was never classified.
      if (target.account_type === 'unclassified' && from.account_type !== 'unclassified') {
        db.run("UPDATE chart_of_accounts SET account_type = ?, updated_at = ? WHERE name = ?", [from.account_type, now, target.name]);
      }
    } else {
      db.run("UPDATE chart_of_accounts SET name = ?, updated_at = ? WHERE name = ? COLLATE NOCASE", [finalName, now, from.name]);
    }
    db.run('COMMIT');
  } catch (e) {
    try { db.run('ROLLBACK'); } catch (_) {}
    throw e;
  }
  await saveDbToIndexedDB();
  return { merged: isMerge, name: finalName };
}

async function deleteAccount(name) {
  const acct = getChartOfAccounts().find(a => a.name.toLowerCase() === String(name).toLowerCase());
  if (!acct) return;
  if (acct.usage > 0) throw new Error(`"${acct.name}" is used in ${acct.usage} transaction(s). Rename or merge it instead of deleting.`);
  db.run("DELETE FROM chart_of_accounts WHERE name = ? COLLATE NOCASE", [acct.name]);
  await saveDbToIndexedDB();
}

// Fills a <select> with accounts grouped by type. Keeps the current value when possible.
function fillAccountSelect(select, { includeNew = false, placeholder = 'Select account…', selected } = {}) {
  if (!select) return;
  const keep = selected !== undefined ? selected : select.value;
  const accounts = getChartOfAccounts();
  select.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = accounts.length ? placeholder : 'No accounts yet';
  select.appendChild(ph);

  ACCOUNT_TYPE_ORDER.forEach(type => {
    const group = accounts.filter(a => (ACCOUNT_TYPES[a.account_type] ? a.account_type : 'unclassified') === type);
    if (group.length === 0) return;
    const og = document.createElement('optgroup');
    og.label = ACCOUNT_TYPES[type];
    group.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.name;
      opt.textContent = a.name;
      og.appendChild(opt);
    });
    select.appendChild(og);
  });

  if (includeNew) {
    const opt = document.createElement('option');
    opt.value = NEW_ACCOUNT_OPTION;
    opt.textContent = '+ Add new account…';
    select.appendChild(opt);
  }
  setAccountSelectValue(select, keep);
}

// Case-insensitive select; adds a stray option if an old entry references an account no longer in the chart.
function setAccountSelectValue(select, name) {
  if (!select) return;
  const n = normalizeAccountName(name);
  if (!n || n === NEW_ACCOUNT_OPTION) { select.value = ''; return; }
  const match = Array.from(select.options).find(o => o.value.toLowerCase() === n.toLowerCase());
  if (match) { select.value = match.value; return; }
  const opt = document.createElement('option');
  opt.value = n;
  opt.textContent = `${n} (not in chart)`;
  select.appendChild(opt);
  select.value = n;
}

function populateFinanceAccountsDatalists() {
  if (!db) return;
  fillAccountSelect(document.getElementById('financeDebitAccount'), { includeNew: true });
  fillAccountSelect(document.getElementById('financeCreditAccount'), { includeNew: true });
}

function updateFinanceTypeHint() {
  const typeSel = document.getElementById('financeType');
  const hint = document.getElementById('financeTypeHint');
  if (typeSel && hint) hint.textContent = voucherTypeInfo(typeSel.value).hint;
}

/* ---------- Inline "add new account" panel inside the finance form ---------- */

let pendingNewAccountTarget = null;

function openFinanceNewAccountPanel(targetSelectId) {
  pendingNewAccountTarget = targetSelectId;
  const panel = document.getElementById('financeNewAccountPanel');
  if (!panel) return;
  document.getElementById('financeNewAccountFor').textContent = targetSelectId === 'financeDebitAccount' ? 'Debit' : 'Credit';
  document.getElementById('financeNewAccountError').textContent = '';
  document.getElementById('financeNewAccountName').value = '';
  document.getElementById('financeNewAccountType').value = '';
  panel.classList.remove('hidden');
  document.getElementById('financeNewAccountName').focus();
}

function closeFinanceNewAccountPanel(restoreSelection = true) {
  const panel = document.getElementById('financeNewAccountPanel');
  if (panel) panel.classList.add('hidden');
  if (restoreSelection && pendingNewAccountTarget) {
    const sel = document.getElementById(pendingNewAccountTarget);
    if (sel && sel.value === NEW_ACCOUNT_OPTION) sel.value = '';
  }
  pendingNewAccountTarget = null;
}

async function submitFinanceNewAccount() {
  const name = document.getElementById('financeNewAccountName').value;
  const type = document.getElementById('financeNewAccountType').value;
  const err = document.getElementById('financeNewAccountError');
  const target = pendingNewAccountTarget;
  try {
    const acct = await addAccount(name, type);
    populateFinanceAccountsDatalists();
    if (target) setAccountSelectValue(document.getElementById(target), acct.name);
    closeFinanceNewAccountPanel(false);
    showToast(`✓ Account "${acct.name}" added as ${ACCOUNT_TYPES[acct.account_type]}`, 'success', 3000);
  } catch (e) {
    err.textContent = e.message;
  }
}

/* ---------- Chart of Accounts manager modal ---------- */

function openChartOfAccountsModal() {
  const modal = document.getElementById('chartOfAccountsModal');
  if (!modal) return;
  document.getElementById('coaAddError').textContent = '';
  document.getElementById('coaSearchInput').value = '';
  renderChartOfAccounts();
  modal.classList.remove('hidden');
  document.getElementById('coaList').scrollTop = 0;
}

function closeChartOfAccountsModal() {
  const modal = document.getElementById('chartOfAccountsModal');
  if (modal) modal.classList.add('hidden');
  // Pickers elsewhere must reflect renames, merges and new types.
  populateFinanceAccountsDatalists();
  populateReportFilterOptions();
  const financeModal = document.getElementById('dailyFinanceModal');
  const financeDate = document.getElementById('financeTxnDate');
  if (financeModal && !financeModal.classList.contains('hidden') && financeDate) renderFinanceTransactionsList(financeDate.value);
}

function renderChartOfAccounts() {
  const list = document.getElementById('coaList');
  const summary = document.getElementById('coaSummary');
  if (!list) return;
  const filter = (document.getElementById('coaSearchInput')?.value || '').trim().toLowerCase();
  const accounts = getChartOfAccounts();
  const unclassified = accounts.filter(a => a.account_type === 'unclassified').length;

  if (summary) {
    summary.innerHTML = `${accounts.length} account${accounts.length === 1 ? '' : 's'}` +
      (unclassified ? ` · <strong style="color:var(--badge-amber-text);">${unclassified} unclassified — set a type for each</strong>` : (accounts.length ? ' · all classified' : ''));
  }

  list.innerHTML = '';
  const shown = accounts.filter(a => !filter || a.name.toLowerCase().includes(filter));
  if (shown.length === 0) {
    list.innerHTML = `<div style="padding:16px; text-align:center; color:var(--text-muted); font-size:0.88rem;">${accounts.length ? 'No accounts match your search.' : 'No accounts yet. Add one above — accounts already used in your entries appear here automatically.'}</div>`;
    return;
  }

  // Unclassified first so the accounts needing attention are at the top.
  ['unclassified', ...ACCOUNT_TYPE_ORDER.filter(t => t !== 'unclassified')].forEach(type => {
    const group = shown.filter(a => (ACCOUNT_TYPES[a.account_type] ? a.account_type : 'unclassified') === type);
    if (group.length === 0) return;
    const heading = document.createElement('div');
    heading.className = 'coa-group-heading';
    heading.textContent = `${ACCOUNT_TYPES[type]} (${group.length})`;
    list.appendChild(heading);
    group.forEach(a => list.appendChild(buildChartOfAccountsRow(a)));
  });
}

function buildChartOfAccountsRow(acct) {
  const row = document.createElement('div');
  row.className = 'coa-row' + (acct.account_type === 'unclassified' ? ' coa-row-unclassified' : '');

  const nameWrap = document.createElement('div');
  nameWrap.className = 'coa-name';
  const nameText = document.createElement('span');
  nameText.textContent = acct.name;
  const usage = document.createElement('small');
  usage.textContent = acct.usage ? `${acct.usage} entr${acct.usage === 1 ? 'y' : 'ies'}` : 'unused';
  nameWrap.append(nameText, usage);

  const typeSel = document.createElement('select');
  typeSel.className = 'coa-type-select';
  typeSel.setAttribute('aria-label', `Account type for ${acct.name}`);
  ACCOUNT_TYPE_ORDER.forEach(t => {
    const o = document.createElement('option');
    o.value = t;
    o.textContent = ACCOUNT_TYPES[t];
    typeSel.appendChild(o);
  });
  typeSel.value = ACCOUNT_TYPES[acct.account_type] ? acct.account_type : 'unclassified';
  typeSel.addEventListener('change', async () => {
    try {
      await setAccountType(acct.name, typeSel.value);
      renderChartOfAccounts();
    } catch (e) {
      showToast('❌ ' + e.message, 'error', 4000);
    }
  });

  const actions = document.createElement('div');
  actions.className = 'coa-actions';
  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.className = 'btn-xs btn-secondary';
  renameBtn.title = 'Rename, or merge into another account';
  renameBtn.setAttribute('aria-label', `Rename or merge ${acct.name}`);
  renameBtn.innerHTML = '<i class="fa-solid fa-pen"></i>';
  renameBtn.addEventListener('click', () => startChartOfAccountsRename(row, acct));

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'btn-xs btn-danger';
  delBtn.title = acct.usage ? 'In use — rename or merge instead' : 'Delete unused account';
  delBtn.setAttribute('aria-label', `Delete ${acct.name}`);
  delBtn.disabled = acct.usage > 0;
  delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
  delBtn.addEventListener('click', async () => {
    if (!confirm(`Delete account "${acct.name}"?`)) return;
    try {
      await deleteAccount(acct.name);
      renderChartOfAccounts();
    } catch (e) {
      showToast('❌ ' + e.message, 'error', 5000);
    }
  });
  actions.append(renameBtn, delBtn);

  row.append(nameWrap, typeSel, actions);
  return row;
}

function startChartOfAccountsRename(row, acct) {
  row.innerHTML = '';
  row.classList.add('coa-row-editing');
  const input = document.createElement('input');
  input.type = 'text';
  input.value = acct.name;
  input.maxLength = ACCOUNT_NAME_MAX;
  input.setAttribute('list', 'coaNamesDatalist');
  input.setAttribute('aria-label', `New name for ${acct.name}`);
  const hint = document.createElement('small');
  hint.className = 'coa-rename-hint';
  hint.textContent = 'Type an existing account name to merge into it.';

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn-sm btn-primary';
  save.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn-sm btn-secondary';
  cancel.textContent = 'Cancel';

  const datalist = document.getElementById('coaNamesDatalist');
  if (datalist) {
    datalist.innerHTML = '';
    getChartOfAccounts().filter(a => a.name !== acct.name).forEach(a => {
      const o = document.createElement('option');
      o.value = a.name;
      datalist.appendChild(o);
    });
  }

  const doSave = async () => {
    const target = findAccount(input.value);
    const isMerge = target && target.name.toLowerCase() !== acct.name.toLowerCase();
    if (isMerge && !confirm(`Merge "${acct.name}" into "${target.name}"?\n\nAll ${acct.usage} entr${acct.usage === 1 ? 'y' : 'ies'} will move to "${target.name}" and "${acct.name}" will be removed.`)) return;
    try {
      const result = await renameOrMergeAccount(acct.name, input.value);
      showToast(result.merged ? `✓ Merged into "${result.name}"` : `✓ Renamed to "${result.name}"`, 'success', 3000);
      renderChartOfAccounts();
    } catch (e) {
      hint.textContent = e.message;
      hint.style.color = 'var(--payment-color)';
    }
  };
  save.addEventListener('click', doSave);
  cancel.addEventListener('click', renderChartOfAccounts);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); doSave(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); renderChartOfAccounts(); }
  });

  const wrap = document.createElement('div');
  wrap.className = 'coa-rename-wrap';
  wrap.append(input, hint);
  const actions = document.createElement('div');
  actions.className = 'coa-actions';
  actions.append(save, cancel);
  row.append(wrap, actions);
  input.focus();
  input.select();
}

async function submitChartOfAccountsAdd(e) {
  if (e) e.preventDefault();
  const nameEl = document.getElementById('coaNewName');
  const typeEl = document.getElementById('coaNewType');
  const err = document.getElementById('coaAddError');
  try {
    const acct = await addAccount(nameEl.value, typeEl.value);
    nameEl.value = '';
    err.textContent = '';
    showToast(`✓ Account "${acct.name}" added`, 'success', 2500);
    renderChartOfAccounts();
    nameEl.focus();
  } catch (ex) {
    err.textContent = ex.message;
  }
}

/* ==========================================================================
   DIAGNOSTICS (phone-friendly console log + read-only attachment health check)
   ========================================================================== */

const DIAG_RESERVED_KEYS = RESERVED_FILE_KEYS;

// Ticket numbers / PNRs can appear in file names, so reports show only a short prefix and the length.
function diagMask(name) {
  const s = String(name);
  return s.length <= 9 ? s : `${s.slice(0, 9)}…(${s.length})`;
}

function diagWithTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms))
  ]);
}

function diagDescribeValue(v) {
  if (v instanceof Uint8Array) return `bytes(${v.byteLength})`;
  if (v instanceof ArrayBuffer) return `arraybuffer(${v.byteLength})`;
  if (typeof v === 'string') return v.startsWith('data:') ? `dataurl(${v.length})` : `string(${v.length})`;
  if (v && typeof v === 'object') return `object(${Object.keys(v).slice(0, 4).join(',')})`;
  return typeof v;
}

async function diagReadAllFiles() {
  const idb = await diagWithTimeout(openSRGDatabase(), 8000, 'Opening IndexedDB');
  return diagWithTimeout(new Promise((resolve, reject) => {
    const out = [];
    const req = idb.transaction('files', 'readonly').objectStore('files').openCursor();
    req.onsuccess = e => {
      const c = e.target.result;
      if (c) { out.push({ key: String(c.key), value: c.value }); c.continue(); } else resolve(out);
    };
    req.onerror = () => reject(req.error);
  }), 15000, 'Reading attachment store');
}

async function runAttachmentHealthCheck(lines) {
  let files;
  try {
    files = await diagReadAllFiles();
  } catch (e) {
    lines.push(`Attachment store: FAILED (${e.message})`);
    return;
  }
  const stored = files.filter(f => !DIAG_RESERVED_KEYS.has(f.key));
  const byKey = new Map(stored.map(f => [f.key.toLowerCase(), f]));
  let ok = 0, failed = 0, plain = 0;
  const fileLines = [];
  for (const f of stored) {
    let status;
    if (!isEncryptedAttachmentBytes(f.value)) {
      plain++;
      status = 'not encrypted';
    } else {
      try {
        const out = await diagWithTimeout(decryptAttachmentData(f.value, currentEncryptionKey), 10000, 'Decrypt');
        status = out ? 'opens ✓' : 'empty';
        if (out) ok++; else failed++;
      } catch (e) {
        failed++;
        status = `does NOT open (${e.name || e.message})`;
      }
    }
    fileLines.push(`  ${diagMask(f.key)}  ${diagDescribeValue(f.value)}  ${status}`);
  }
  lines.push(`Stored files: ${stored.length} — open with current key: ${ok}, do not open: ${failed}, unencrypted: ${plain}`);
  lines.push(...fileLines);

  // How each ticket referenced by a schedule resolves (same name rules as the viewer, read-only).
  const refs = Array.from(getActiveScheduleAttachmentsMap().values());
  let direct = 0, fuzzy = 0, missing = 0;
  const refLines = [];
  for (const att of refs.slice(0, 60)) {
    const names = new Set();
    [att.id, att.filename, att.name].filter(Boolean).forEach(n => { names.add(String(n).toLowerCase()); names.add('att_' + String(n).toLowerCase()); });
    const hit = Array.from(names).map(n => byKey.get(n)).find(Boolean);
    let how;
    if (hit) {
      direct++;
      how = `exact → ${diagMask(hit.key)}`;
    } else {
      const targets = [att.id, att.filename, att.name].filter(Boolean).map(s => String(s).toLowerCase()).filter(s => s.length >= 4);
      const match = stored.find(f => { const k = f.key.toLowerCase(); return targets.some(t => k.includes(t) || t.includes(k.replace(/^att_/, ''))); });
      if (match) { fuzzy++; how = `partial-name → ${diagMask(match.key)}`; }
      else { missing++; how = 'NOT FOUND'; }
    }
    refLines.push(`  ${diagMask(att.id || att.name || '?')}  ${how}`);
  }
  lines.push(`Ticket references: ${refs.length} — exact name: ${direct}, partial name: ${fuzzy}, not found: ${missing}${refs.length > 60 ? ' (first 60 listed)' : ''}`);
  lines.push(...refLines);

  // End-to-end: what the viewer actually gets for the first few tickets.
  for (const att of refs.slice(0, 5)) {
    const probe = Object.assign({}, att);
    delete probe.data;
    try {
      const v = await diagWithTimeout(getAttachmentData(probe), 15000, 'Viewer load');
      lines.push(`  viewer load ${diagMask(att.id || att.name || '?')}: ${v ? diagDescribeValue(v) : 'nothing returned'}`);
    } catch (e) {
      lines.push(`  viewer load ${diagMask(att.id || att.name || '?')}: ${e.message}`);
    }
  }
}

async function buildDiagnosticsReport(includeAttachmentCheck = false) {
  const lines = [];
  lines.push(`Calendar App ${APP_VERSION} — ${new Date().toISOString()}`);
  lines.push(`Browser: ${navigator.userAgent}`);
  try { lines.push(`Offline caches: ${(await caches.keys()).join(', ') || 'none'}`); } catch (e) {}
  lines.push(`Service worker active: ${!!(navigator.serviceWorker && navigator.serviceWorker.controller)}`);
  lines.push(`Unlocked: ${isAppUnlocked} · key in memory: ${!!currentEncryptionKey} · snapshot-fallback mode: ${biometricSnapshotFallbackActive}`);
  lines.push(`Fingerprint: ${localStorage.getItem('srg_biometric_enabled') === 'true' ? (localStorage.getItem('srg_biometric_mode') || 'on') : 'off'}`);
  try {
    const b = cachedEncryptedDbBytes || await diagWithTimeout(loadDbFromIndexedDB(), 8000, 'Loading database file');
    const h = b && isEncryptedDbBytes(b) ? parseEncryptedDbHeader(b) : null;
    const env = await loadKeyEnvelope();
    lines.push(env
      ? `Encryption: data key ${hexOf(env.dekId, 4)}… (created ${env.created}, PIN wrapper ${env.pin.iterations} iterations, PIN last changed ${env.pinChanged})`
      : 'Encryption: legacy PIN-derived key (upgrades to a data key at the next PIN unlock)');
    lines.push(`Recovery vault: ${(await getStoredRecoveryVaultBytes()) ? 'present' : 'missing'}`);
    lines.push(`Database file: ${b ? b.byteLength + ' bytes' : 'missing'}, ${h ? (h.version === 3 ? `encrypted with data key ${hexOf(h.keyId, 4)}…${env && !u8Equal(h.keyId, env.dekId) ? ' (DIFFERENT from the envelope!)' : ''}` : `encrypted (legacy SRGE${h.version}), ${h.iterations} iterations`) : 'not encrypted'}`);
    if (h && currentEncryptionKey) {
      try {
        const d = await decryptDatabaseBytes(b, currentEncryptionKey, false);
        lines.push(`Database opens with key in memory: ${isValidSqliteBinary(d) ? 'yes' : 'NO'}`);
      } catch (e) {
        lines.push(`Database opens with key in memory: NO (${e.name})`);
      }
    }
  } catch (e) {
    lines.push(`Database check failed: ${e.message}`);
  }
  if (db) {
    try {
      const n = q => db.exec(q)[0].values[0][0];
      lines.push(`Records: ${n('SELECT COUNT(*) FROM schedules')} schedules, ${n('SELECT COUNT(*) FROM daily_transactions')} transactions, ${n('SELECT COUNT(*) FROM chart_of_accounts')} accounts`);
    } catch (e) {}
  }
  const ic = lastIntegrityCheck;
  lines.push(ic
    ? `Integrity check after unlock (${ic.at}): ${ic.checked} referenced attachment(s), ${ic.ok} open, ${ic.notOpening.length} do NOT open${ic.notOpening.length ? ' [' + ic.notOpening.map(diagMask).join(', ') + ']' : ''}, ${ic.missing.length} missing${ic.missing.length ? ' [' + ic.missing.map(diagMask).join(', ') + ']' : ''}`
    : 'Integrity check after unlock: not run yet');
  if (includeAttachmentCheck) {
    lines.push('--- Attachment check ---');
    await runAttachmentHealthCheck(lines);
  }
  lines.push('--- Errors & warnings (this session) ---');
  const log = window.SRGDiagnostics ? window.SRGDiagnostics.entries().filter(e => e.level !== 'info') : [];
  if (log.length === 0) lines.push('  none');
  log.forEach(e => lines.push(`  [${e.t}s] ${e.level.toUpperCase()}: ${e.text}`));
  return lines.join('\n');
}

async function openDiagnosticsModal(includeAttachmentCheck = false) {
  const modal = document.getElementById('diagnosticsModal');
  const out = document.getElementById('diagnosticsOutput');
  if (!modal || !out) return;
  modal.classList.remove('hidden');
  out.textContent = includeAttachmentCheck ? 'Checking every stored file… (can take a minute)' : 'Collecting…';
  try {
    out.textContent = await buildDiagnosticsReport(includeAttachmentCheck);
  } catch (e) {
    out.textContent = 'Diagnostics failed: ' + e.message;
  }
}

async function copyDiagnosticsReport() {
  const text = document.getElementById('diagnosticsOutput')?.textContent || '';
  try {
    await navigator.clipboard.writeText(text);
    showToast('✓ Diagnostics copied — paste it into your message', 'success', 3000);
  } catch (e) {
    // Clipboard API can be unavailable; fall back to selecting the text for manual copy.
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('diagnosticsOutput'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    showToast('Text selected — use Copy from your phone menu', 'info', 4000);
  }
}

/* ==========================================================================
   DAILY DIARY NOTES FUNCTIONS
   ========================================================================== */

function getDailyNoteForDate(dateStr) {
  if (!db || !dateStr) return null;
  try {
    const res = db.exec("SELECT content FROM daily_notes WHERE note_date = ?", [dateStr]);
    if (res && res.length > 0 && res[0].values.length > 0) {
      return res[0].values[0][0] || null;
    }
  } catch (e) {
    console.warn("Error getting daily note:", e);
  }
  return null;
}

function getDailyNotesMap() {
  const map = {};
  if (!db) return map;
  try {
    const res = db.exec("SELECT note_date, content FROM daily_notes WHERE content IS NOT NULL AND content != ''");
    if (res && res.length > 0) {
      const rows = res[0].values;
      for (const row of rows) {
        map[row[0]] = row[1];
      }
    }
  } catch (e) {
    console.warn("Error reading daily notes map:", e);
  }
  return map;
}

async function saveDailyNote(dateStr, content) {
  if (!db || !dateStr) return;
  const trimmed = (content || '').trim();
  const now = new Date().toISOString();

  try {
    if (trimmed) {
      db.run("INSERT OR REPLACE INTO daily_notes (note_date, content, updated_at) VALUES (?, ?, ?)", [dateStr, trimmed, now]);
    } else {
      db.run("DELETE FROM daily_notes WHERE note_date = ?", [dateStr]);
    }
    await saveDbToIndexedDB();
    renderCurrentView();
    showToast(trimmed ? '✓ Daily note saved locally!' : '✓ Daily note removed!', 'success', 3000);
  } catch(err) {
    console.error('Error saving note:', err);
    showToast('❌ Error saving note: ' + err.message, 'error', 4000);
  }
}

async function deleteDailyNote(dateStr) {
  if (!db || !dateStr) return;
  try {
    db.run("DELETE FROM daily_notes WHERE note_date = ?", [dateStr]);
    await saveDbToIndexedDB();
    renderCurrentView();
    showToast('✓ Daily note deleted!', 'success', 3000);
  } catch(err) {
    console.error('Error deleting note:', err);
    showToast('❌ Error deleting note: ' + err.message, 'error', 4000);
  }
}

function openDailyNoteModal(dateStr) {
  const modal = document.getElementById('dailyNoteModal');
  const dateInput = document.getElementById('dailyNoteDateInput');
  const textInput = document.getElementById('dailyNoteTextInput');
  const modalTitle = document.getElementById('dailyNoteModalTitle');
  const subhead = document.getElementById('dailyNoteModalSubhead');
  const deleteBtn = document.getElementById('deleteDailyNoteBtn');

  if (!modal || !dateStr) return;

  const [y, m, d] = dateStr.split('-').map(Number);
  const dObj = new Date(y, m - 1, d);
  const formattedDate = formatDateIndian(dObj);
  const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dObj.getDay()];

  dateInput.value = dateStr;
  if (modalTitle) modalTitle.textContent = `Daily Diary Note`;
  if (subhead) subhead.textContent = `${dayName}, ${formattedDate} (${dateStr})`;

  const existingNote = getDailyNoteForDate(dateStr) || '';
  textInput.value = existingNote;

  if (deleteBtn) {
    if (existingNote) {
      deleteBtn.classList.remove('hidden');
      deleteBtn.style.display = 'inline-flex';
    } else {
      deleteBtn.classList.add('hidden');
      deleteBtn.style.display = 'none';
    }
  }

  modal.classList.remove('hidden');
  setTimeout(() => textInput.focus(), 100);
}

function closeDailyNoteModal() {
  const modal = document.getElementById('dailyNoteModal');
  if (modal) modal.classList.add('hidden');
}

function isPortraitMode() {
  return window.matchMedia('(orientation: portrait), (max-width: 600px)').matches;
}

function renderMonthView() {
  const grid = document.getElementById('calendarGrid');
  grid.innerHTML = '';

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const firstDayOfMonth = new Date(year, month, 1);
  const startingDay = firstDayOfMonth.getDay();
  const totalDays = new Date(year, month + 1, 0).getDate();

  const prevMonthDays = new Date(year, month, 0).getDate();
  const startDateStr = formatDateYMD(new Date(year, month - 1, prevMonthDays - startingDay + 1));
  const endDateStr = formatDateYMD(new Date(year, month + 1, 14));

  const schedulesByDate = getSchedulesMap(startDateStr, endDateStr);
  const dailyNotesMap = getDailyNotesMap();
  const dailyTxnsMap = getDailyTransactionsMap();
  const todayStr = formatDateYMD(new Date());

  // Determine initial portrait selected date for current month
  const [pYear, pMonth] = portraitSelectedDate ? portraitSelectedDate.split('-').map(Number) : [null, null];
  if (!portraitSelectedDate || pYear !== year || (pMonth - 1) !== month) {
    const today = new Date();
    if (today.getFullYear() === year && today.getMonth() === month) {
      portraitSelectedDate = todayStr;
    } else {
      portraitSelectedDate = formatDateYMD(firstDayOfMonth);
    }
  }

  for (let i = startingDay - 1; i >= 0; i--) {
    const dNum = prevMonthDays - i;
    const dObj = new Date(year, month - 1, dNum);
    const dStr = formatDateYMD(dObj);
    const cell = createDayCell(dStr, dNum, true, schedulesByDate[dStr] || [], dObj.getDay(), false, dailyNotesMap, dailyTxnsMap);
    grid.appendChild(cell);
  }

  for (let d = 1; d <= totalDays; d++) {
    const dObj = new Date(year, month, d);
    const dStr = formatDateYMD(dObj);
    const isToday = (dStr === todayStr);
    const cell = createDayCell(dStr, d, false, schedulesByDate[dStr] || [], dObj.getDay(), isToday, dailyNotesMap, dailyTxnsMap);
    grid.appendChild(cell);
  }

  const totalRendered = startingDay + totalDays;
  const targetCells = totalRendered > 35 ? 42 : 35;
  const nextDays = targetCells - totalRendered;
  for (let d = 1; d <= nextDays; d++) {
    const dObj = new Date(year, month + 1, d);
    const dStr = formatDateYMD(dObj);
    const cell = createDayCell(dStr, d, true, schedulesByDate[dStr] || [], dObj.getDay(), false, dailyNotesMap, dailyTxnsMap);
    grid.appendChild(cell);
  }

  // Render bottom schedule agenda for selected date in portrait mode
  renderPortraitCalendarDayAgenda(portraitSelectedDate);
}

function renderPortraitMonthView() {
  const tbody = document.getElementById('portraitMonthTbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth(); // 0-indexed
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const todayYmd = formatDateYMD(new Date());
  const selectedYmd = formatDateYMD(currentDate);

  const startYmd = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const endYmd = `${year}-${String(month + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

  const schedulesMap = getSchedulesMap(startYmd, endYmd);

  let targetRowEl = null;

  for (let d = 1; d <= daysInMonth; d++) {
    const dObj = new Date(year, month, d);
    const dateYmd = formatDateYMD(dObj);
    const isToday = (dateYmd === todayYmd);
    const indianDateStr = formatDateIndian(dObj);
    const dayOfWeekStr = DAY_NAMES_SHORT[dObj.getDay()];

    const tr = document.createElement('tr');
    tr.className = 'portrait-day-row';
    tr.dataset.date = dateYmd;
    if (isToday) tr.classList.add('today-row');

    if (dateYmd === selectedYmd || (isToday && !targetRowEl)) {
      targetRowEl = tr;
    }

    // 1. Date Cell
    const tdDate = document.createElement('td');
    tdDate.style.cursor = 'pointer';
    tdDate.title = 'Click to open Day View';
    tdDate.innerHTML = `
      <div class="portrait-day-cell-date">${indianDateStr} ${isToday ? '<span class="today-badge">TODAY</span>' : ''}</div>
      <div class="portrait-day-cell-sub">${dayOfWeekStr}</div>
    `;
    tdDate.addEventListener('click', () => {
      switchToView('day', dObj);
    });

    // 2. Schedules Cell
    const tdSch = document.createElement('td');
    const daySchedules = schedulesMap[dateYmd] || [];
    if (daySchedules.length > 0) {
      const schContainer = document.createElement('div');
      schContainer.style.cssText = 'display:flex; flex-direction:column; gap:6px;';

      daySchedules.forEach(s => {
        const isTravelArr = s.title && (s.title.toLowerCase().startsWith('travel arrival:') || s.title.toLowerCase().startsWith('return travel arrival:'));
        const isTravelDep = s.title && (s.title.toLowerCase().startsWith('travel:') || s.title.toLowerCase().startsWith('return travel:') || s.title.toLowerCase() === 'travel');

        let borderCol = '#3b82f6';
        let badgeStr = 'Event';
        if (isTravelArr) { borderCol = '#10b981'; badgeStr = '🏁 Travel Arrival'; }
        else if (isTravelDep) { borderCol = '#8b5cf6'; badgeStr = '🚆 Travel'; }
        else if (s.delivery_mode === 'online') { borderCol = '#06b6d4'; badgeStr = '🌐 Online'; }

        const timeStr = formatTimeRange(s.from_time, s.to_time);

        const schItem = document.createElement('div');
        schItem.className = 'portable-schedule-item';
        schItem.style.borderLeftColor = borderCol;
        schItem.innerHTML = `
          <div>
            <div class="portable-schedule-title">${escapeHtml(s.title)} <span style="font-size:0.72rem; color:var(--text-muted);">(${badgeStr})</span></div>
            <div class="portable-schedule-time"><i class="fa-regular fa-clock"></i> ${timeStr} ${s.location ? ` • <i class="fa-solid fa-location-dot"></i> ${escapeHtml(s.location)}` : ''}</div>
          </div>
          <button type="button" class="btn-xs btn-secondary"><i class="fa-solid fa-eye"></i></button>
        `;

        schItem.addEventListener('click', () => openScheduleDetailsModal(s));
        schContainer.appendChild(schItem);
      });
      tdSch.appendChild(schContainer);
    } else {
      tdSch.innerHTML = `<span class="no-schedule-placeholder">No schedule</span>`;
    }

    // 3. Diary Note Cell
    const tdNote = document.createElement('td');
    const noteContent = getDailyNoteForDate(dateYmd);
    if (noteContent) {
      tdNote.innerHTML = `
        <div class="portrait-note-badge">
          <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:140px;" title="${escapeHtml(noteContent)}">📝 ${escapeHtml(noteContent)}</span>
          <button type="button" class="btn-xs btn-secondary edit-note-btn"><i class="fa-solid fa-pen-to-square"></i></button>
        </div>
      `;
      tdNote.querySelector('.edit-note-btn').addEventListener('click', () => openDailyNoteModal(dateYmd));
    } else {
      tdNote.innerHTML = `<span class="no-schedule-placeholder">-</span>`;
    }

    // 4. Daily Finance Cell
    const tdFin = document.createElement('td');
    const txns = getDailyTransactionsForDate(dateYmd);
    if (txns.length > 0) {
      let rec = 0, pay = 0;
      txns.forEach(t => {
        if (t.type === 'receipt') rec += toPaise(t.amount);
        else if (t.type === 'payment') pay += toPaise(t.amount);
      });
      const net = rec - pay;
      tdFin.innerHTML = `
        <div class="portrait-finance-badge">
          <span>💰 In: <strong class="fin-in">${formatINR(rec, 0)}</strong> | Out: <strong class="fin-out">${formatINR(pay, 0)}</strong></span>
          <button type="button" class="btn-xs btn-secondary edit-fin-btn"><i class="fa-solid fa-pen-to-square"></i></button>
        </div>
      `;
      tdFin.querySelector('.edit-fin-btn').addEventListener('click', () => openDailyFinanceModal(dateYmd));
    } else {
      tdFin.innerHTML = `<span class="no-schedule-placeholder">-</span>`;
    }

    // 5. Actions Cell (+ Schedule, + Note, + Finance)
    const tdAct = document.createElement('td');
    tdAct.style.textAlign = 'center';
    tdAct.innerHTML = `
      <div class="portrait-actions">
        <button type="button" class="btn-xs btn-secondary add-sch-btn" title="Add Schedule"><i class="fa-solid fa-plus"></i></button>
        <button type="button" class="btn-xs btn-secondary add-note-btn" title="Add Note"><i class="fa-solid fa-note-sticky"></i></button>
        <button type="button" class="btn-xs btn-secondary add-fin-btn" title="Add Finance"><i class="fa-solid fa-coins"></i></button>
      </div>
    `;

    tdAct.querySelector('.add-sch-btn').addEventListener('click', () => {
      selectedDates.clear();
      selectedDates.add(dateYmd);
      openScheduleModal();
    });

    tdAct.querySelector('.add-note-btn').addEventListener('click', () => openDailyNoteModal(dateYmd));
    tdAct.querySelector('.add-fin-btn').addEventListener('click', () => openDailyFinanceModal(dateYmd));

    tr.appendChild(tdDate);
    tr.appendChild(tdSch);
    tr.appendChild(tdNote);
    tr.appendChild(tdFin);
    tr.appendChild(tdAct);

    tbody.appendChild(tr);
  }

  // Smooth scroll to target date row
  if (targetRowEl) {
    setTimeout(() => {
      targetRowEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 150);
  }
}

function createDayCell(dateStr, dayNum, isOtherMonth, schedules, dayOfWeekIdx, isToday = false, dailyNotesMap = {}, dailyTxnsMap = {}) {
  const cell = document.createElement('div');
  cell.className = 'day-cell';
  if (isOtherMonth) cell.classList.add('other-month');
  if (isToday) cell.classList.add('today');
  if (selectedDates.has(dateStr)) cell.classList.add('selected');

  cell.dataset.date = dateStr;

  const header = document.createElement('div');
  header.className = 'day-header';
  
  const numSpan = document.createElement('span');
  numSpan.className = 'day-number';
  numSpan.textContent = dayNum;

  const noteContent = dailyNotesMap ? dailyNotesMap[dateStr] : null;
  const hasNote = Boolean(noteContent);

  const txnSummary = dailyTxnsMap ? dailyTxnsMap[dateStr] : null;
  const hasFinance = Boolean(txnSummary && txnSummary.count > 0);

  // Note button
  const noteBtn = document.createElement('button');
  noteBtn.type = 'button';
  noteBtn.className = 'day-note-btn' + (hasNote ? ' has-note' : '');
  noteBtn.title = hasNote ? 'View/Edit Daily Note' : 'Add Daily Note';
  noteBtn.innerHTML = hasNote ? '<i class="fa-solid fa-note-sticky"></i>' : '<i class="fa-regular fa-note-sticky"></i>';
  noteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openDailyNoteModal(dateStr);
  });

  // Finance button
  const financeBtn = document.createElement('button');
  financeBtn.type = 'button';
  financeBtn.className = 'day-finance-btn' + (hasFinance ? ' has-finance' : '');
  financeBtn.title = hasFinance ? 'View/Edit Daily Receipts & Payments' : 'Add Daily Finance Entry';
  financeBtn.innerHTML = hasFinance ? '<i class="fa-solid fa-coins"></i>' : '<i class="fa-solid fa-coins" style="opacity:0.4;"></i>';
  financeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openDailyFinanceModal(dateStr);
  });

  const actionsWrap = document.createElement('div');
  actionsWrap.className = 'day-actions-wrap';
  actionsWrap.style.cssText = 'display:inline-flex; align-items:center; gap:2px; margin-left:auto;';
  actionsWrap.appendChild(noteBtn);
  actionsWrap.appendChild(financeBtn);

  header.appendChild(numSpan);
  header.appendChild(actionsWrap);
  cell.appendChild(header);

  // Portrait mode indicator (small colored square in center)
  const portraitIndicatorWrap = document.createElement('div');
  portraitIndicatorWrap.className = 'day-portrait-indicators';

  if (schedules && schedules.length > 0) {
    const hasTravelDep = schedules.some(s => s.title && (s.title.toLowerCase().startsWith('travel:') || s.title.toLowerCase().startsWith('return travel:') || s.title.toLowerCase() === 'travel'));
    const hasTravelArr = schedules.some(s => s.title && (s.title.toLowerCase().startsWith('travel arrival:') || s.title.toLowerCase().startsWith('return travel arrival:')));

    const schSquare = document.createElement('span');
    schSquare.className = 'portrait-sch-square';
    if (hasTravelDep) {
      schSquare.style.backgroundColor = '#f59e0b';
      schSquare.title = 'Travel Departure';
    } else if (hasTravelArr) {
      schSquare.style.backgroundColor = '#10b981';
      schSquare.title = 'Travel Arrival';
    } else {
      schSquare.style.backgroundColor = '#3b82f6';
      schSquare.title = `${schedules.length} Event${schedules.length > 1 ? 's' : ''}`;
    }
    portraitIndicatorWrap.appendChild(schSquare);

    if (schedules.length > 1) {
      const schSquare2 = document.createElement('span');
      schSquare2.className = 'portrait-sch-square';
      schSquare2.style.backgroundColor = (hasTravelDep || hasTravelArr) ? '#3b82f6' : '#8b5cf6';
      portraitIndicatorWrap.appendChild(schSquare2);
    }
  }

  if (hasNote) {
    const noteSquare = document.createElement('span');
    noteSquare.className = 'portrait-note-square';
    noteSquare.title = 'Daily Note';
    portraitIndicatorWrap.appendChild(noteSquare);
  }

  if (hasFinance) {
    const finSquare = document.createElement('span');
    finSquare.className = 'portrait-fin-square';
    finSquare.title = 'Daily Finance';
    portraitIndicatorWrap.appendChild(finSquare);
  }

  cell.appendChild(portraitIndicatorWrap);

  const list = document.createElement('div');
  list.className = 'day-schedules-list';

  if (hasNote) {
    const notePill = document.createElement('div');
    notePill.className = 'day-note-pill';
    notePill.title = noteContent;
    notePill.innerHTML = `<i class="fa-solid fa-note-sticky"></i> <span class="pill-text">${escapeHtml(noteContent)}</span>`;
    notePill.addEventListener('click', (e) => {
      e.stopPropagation();
      openDailyNoteModal(dateStr);
    });
    list.appendChild(notePill);
  }

  if (hasFinance) {
    const finPill = document.createElement('div');
    finPill.className = 'day-finance-pill';
    finPill.title = `Receipts: ${formatINR(txnSummary.receipts)} | Payments: ${formatINR(txnSummary.payments)}`;
    finPill.innerHTML = `<i class="fa-solid fa-coins"></i> <span class="pill-text">+${formatINR(txnSummary.receipts)} / -${formatINR(txnSummary.payments)}</span>`;
    finPill.addEventListener('click', (e) => {
      e.stopPropagation();
      openDailyFinanceModal(dateStr);
    });
    list.appendChild(finPill);
  }

  schedules.forEach(s => {
    const isTravelArr = s.title && (s.title.toLowerCase().startsWith('travel arrival:') || s.title.toLowerCase().startsWith('return travel arrival:'));
    const isTravelDep = s.title && (s.title.toLowerCase().startsWith('travel:') || s.title.toLowerCase().startsWith('return travel:') || s.title.toLowerCase() === 'travel');
    const isTravel = isTravelArr || isTravelDep;
    
    const chip = document.createElement('div');
    chip.className = 'schedule-chip' + (isTravelArr ? ' travel-arr-chip' : (isTravelDep ? ' travel-chip' : ''));
    
    if (isTravelArr) {
      chip.style.borderLeftColor = '#10b981'; // Emerald for Arrival
    } else if (isTravelDep) {
      chip.style.borderLeftColor = '#f59e0b'; // Amber for Travel Departure
    } else if (s.delivery_mode === 'online') {
      chip.style.borderLeftColor = '#0ea5e9';
    } else if (s.delivery_mode === 'hybrid') {
      chip.style.borderLeftColor = '#a855f7';
    } else {
      chip.style.borderLeftColor = '#10b981';
    }

    if (s.group_id) {
      chip.style.borderRight = '3px solid #6366f1';
    }

    // Set full schedule description as tooltip on hover
    let tooltipText = `${s.title}\nTime: ${formatTimeRange(s.from_time, s.to_time)}\nMode: ${s.delivery_mode}`;
    if (s.location) tooltipText += `\nLocation: ${s.location}`;
    if (s.notes) tooltipText += `\nNotes: ${s.notes}`;
    chip.title = tooltipText;

    const chipHeader = document.createElement('div');
    chipHeader.className = 'chip-header';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'chip-time';
    timeSpan.textContent = formatTimeRange(s.from_time, s.to_time);

    const modeSpan = document.createElement('span');
    modeSpan.className = `chip-mode-badge ${s.delivery_mode}`;
    
    let icons = isTravelArr ? '🏁' : (isTravelDep ? '🚆' : (s.delivery_mode === 'online' ? '🌐' : '🏢'));
    if (s.group_id) icons += ' 👥';
    if (s.attachments && s.attachments !== '[]') icons += ' 📎';
    modeSpan.textContent = icons;

    chipHeader.appendChild(timeSpan);
    chipHeader.appendChild(modeSpan);
    chip.appendChild(chipHeader);

    const titleDiv = document.createElement('div');
    titleDiv.className = 'chip-title';
    // If it's a travel entry, display cleanly as "Travel", "Travel Arrival", or "Return Travel"
    if (isTravel) {
      if (s.title.toLowerCase().startsWith('return travel arrival:')) {
        titleDiv.textContent = 'Return Arrival';
        titleDiv.style.color = 'var(--badge-green-text)';
      } else if (s.title.toLowerCase().startsWith('travel arrival:')) {
        titleDiv.textContent = 'Travel Arrival';
        titleDiv.style.color = 'var(--badge-green-text)';
      } else if (s.title.toLowerCase().startsWith('return travel:')) {
        titleDiv.textContent = 'Return Travel';
        titleDiv.style.color = 'var(--badge-amber-text)';
      } else {
        titleDiv.textContent = 'Travel';
        titleDiv.style.color = 'var(--badge-amber-text)';
      }
      titleDiv.style.fontWeight = '600';
    } else {
      titleDiv.textContent = s.title;
    }
    chip.appendChild(titleDiv);

    // Clicking chip opens full details window (with option to edit)
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      openScheduleDetailsModal(s);
    });

    list.appendChild(chip);
  });

  cell.appendChild(list);

  if (dateStr === portraitSelectedDate) {
    cell.classList.add('portrait-selected');
  }

  // Long-press gesture handling for Portrait Mode multi-date selection
  let longPressTimer = null;
  let isLongPressTriggered = false;
  let touchStartX = 0;
  let touchStartY = 0;

  function handleStartLongPress(e) {
    if (!isPortraitMode()) return;
    isLongPressTriggered = false;
    if (e.touches && e.touches.length > 0) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    } else {
      touchStartX = e.clientX;
      touchStartY = e.clientY;
    }
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      isLongPressTriggered = true;
      if (navigator.vibrate) {
        try { navigator.vibrate(40); } catch (_) {}
      }
      portraitSelectedDate = dateStr;
      document.querySelectorAll('.calendar-grid .day-cell.portrait-selected').forEach(c => c.classList.remove('portrait-selected'));
      cell.classList.add('portrait-selected');
      renderPortraitCalendarDayAgenda(dateStr);
      toggleDateSelection(dateStr);
      setTimeout(() => { isLongPressTriggered = false; }, 800);
    }, 500);
  }

  function handleCancelLongPress() {
    clearTimeout(longPressTimer);
  }

  function handleMoveLongPress(e) {
    if (!longPressTimer) return;
    const clientX = e.touches && e.touches.length > 0 ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches && e.touches.length > 0 ? e.touches[0].clientY : e.clientY;
    const diffX = Math.abs(clientX - touchStartX);
    const diffY = Math.abs(clientY - touchStartY);
    if (diffX > 10 || diffY > 10) {
      clearTimeout(longPressTimer);
    }
  }

  cell.addEventListener('touchstart', handleStartLongPress, { passive: true });
  cell.addEventListener('touchmove', handleMoveLongPress, { passive: true });
  cell.addEventListener('touchend', handleCancelLongPress);
  cell.addEventListener('touchcancel', handleCancelLongPress);

  cell.addEventListener('mousedown', (e) => {
    if (e.button === 0) handleStartLongPress(e);
  });
  cell.addEventListener('mousemove', handleMoveLongPress);
  cell.addEventListener('mouseup', handleCancelLongPress);
  cell.addEventListener('mouseleave', handleCancelLongPress);

  cell.addEventListener('contextmenu', (e) => {
    if (isPortraitMode()) {
      e.preventDefault();
    }
  });

  cell.addEventListener('click', (e) => {
    if (isLongPressTriggered) {
      isLongPressTriggered = false;
      return;
    }

    portraitSelectedDate = dateStr;
    document.querySelectorAll('.calendar-grid .day-cell.portrait-selected').forEach(c => c.classList.remove('portrait-selected'));
    cell.classList.add('portrait-selected');
    renderPortraitCalendarDayAgenda(dateStr);

    if (!isPortraitMode() || selectedDates.size > 0) {
      toggleDateSelection(dateStr);
    }
  });

  return cell;
}

function renderPortraitCalendarDayAgenda(dateStr) {
  const container = document.getElementById('portraitCalendarDayAgenda');
  if (!container) return;
  if (!dateStr) {
    container.innerHTML = '';
    return;
  }

  const [y, m, d] = dateStr.split('-').map(Number);
  const dObj = new Date(y, m - 1, d);
  const dayOfWeek = DAY_NAMES[dObj.getDay()];
  const indianDate = formatDateIndian(dObj);
  const todayStr = formatDateYMD(new Date());
  const isToday = (dateStr === todayStr);

  const schedulesMap = getSchedulesMap(dateStr, dateStr);
  const daySchedules = schedulesMap[dateStr] || [];
  const noteContent = (typeof getDailyNoteForDate === 'function') ? getDailyNoteForDate(dateStr) : null;
  const dailyTxnsMap = (typeof getDailyTransactionsMap === 'function') ? getDailyTransactionsMap() : {};
  const txnSummary = dailyTxnsMap ? dailyTxnsMap[dateStr] : null;
  const hasFinance = Boolean(txnSummary && txnSummary.count > 0);

  let html = `
    <div class="portrait-agenda-header">
      <div class="portrait-agenda-title-wrap">
        <div class="portrait-agenda-date">
          <span>${dayOfWeek}, ${indianDate}</span>
          ${isToday ? '<span class="today-badge">TODAY</span>' : ''}
        </div>
        <div class="portrait-agenda-count">${daySchedules.length} Event${daySchedules.length === 1 ? '' : 's'}</div>
      </div>
      <button type="button" class="portrait-agenda-add-btn" id="portraitAgendaAddBtn" title="Add Schedule for this Date">
        <i class="fa-solid fa-plus"></i> Add Schedule
      </button>
    </div>
  `;

  if (noteContent) {
    html += `
      <div class="portrait-agenda-note-card">
        <div class="portrait-agenda-sub-header">
          <span style="font-weight:600; color:#fbbf24;"><i class="fa-solid fa-note-sticky"></i> Daily Diary Note</span>
          <button type="button" class="portrait-sub-action-btn edit-note-btn" style="color:#fbbf24; cursor:pointer;"><i class="fa-solid fa-pen"></i> Edit</button>
        </div>
        <div class="portrait-agenda-note-text">${escapeHtml(noteContent)}</div>
      </div>
    `;
  }

  if (hasFinance) {
    html += `
      <div class="portrait-agenda-finance-card">
        <div class="portrait-agenda-sub-header">
          <span style="font-weight:600; color:#34d399;"><i class="fa-solid fa-coins"></i> Daily Finance</span>
          <button type="button" class="portrait-sub-action-btn view-fin-btn" style="color:#34d399; cursor:pointer;"><i class="fa-solid fa-pen"></i> View</button>
        </div>
        <div class="portrait-agenda-fin-values" style="display:flex; gap:16px; font-size:0.86rem; margin-top:3px;">
          <span style="color:var(--receipt-color); font-weight:600;">Receipts: +${formatINR(txnSummary.receipts)}</span>
          <span style="color:var(--payment-color); font-weight:600;">Payments: -${formatINR(txnSummary.payments)}</span>
        </div>
      </div>
    `;
  }

  if (daySchedules.length > 0) {
    html += `<div class="portrait-agenda-items">`;
    daySchedules.forEach((s, idx) => {
      const isTravelArr = s.title && (s.title.toLowerCase().startsWith('travel arrival:') || s.title.toLowerCase().startsWith('return travel arrival:'));
      const isTravelDep = s.title && (s.title.toLowerCase().startsWith('travel:') || s.title.toLowerCase().startsWith('return travel:') || s.title.toLowerCase() === 'travel');

      let borderLeftColor = '#3b82f6';
      if (isTravelArr) borderLeftColor = '#10b981';
      else if (isTravelDep) borderLeftColor = '#f59e0b';
      else if (s.delivery_mode === 'online') borderLeftColor = '#0ea5e9';
      else if (s.delivery_mode === 'hybrid') borderLeftColor = '#a855f7';
      else if (s.delivery_mode === 'in-person') borderLeftColor = '#10b981';

      let travelBadgeHtml = '';
      if (isTravelArr) {
        travelBadgeHtml = '<span class="chip-mode-badge" style="background:var(--badge-green-bg); color:var(--badge-green-text); border:1px solid var(--badge-green-border);"><i class="fa-solid fa-flag-checkered"></i> Arrival</span>';
      } else if (isTravelDep) {
        travelBadgeHtml = '<span class="chip-mode-badge" style="background:var(--badge-amber-bg); color:var(--badge-amber-text); border:1px solid var(--badge-amber-border);"><i class="fa-solid fa-train"></i> Travel</span>';
      }

      html += `
        <div class="portrait-agenda-card" data-sch-idx="${idx}" style="border-left-color:${borderLeftColor};">
          <div class="portrait-agenda-card-top">
            <div class="portrait-agenda-card-title">
              ${escapeHtml(s.title)}
              ${s.group_id ? '<span class="badge-batch-group"><i class="fa-solid fa-layer-group"></i> Batch</span>' : ''}
              ${s.attachments && s.attachments !== '[]' ? '<span style="color:var(--accent-blue); font-size:0.75rem;"><i class="fa-solid fa-paperclip"></i></span>' : ''}
            </div>
            <div class="portrait-agenda-card-time">
              <i class="fa-regular fa-clock"></i> ${formatTimeRange(s.from_time, s.to_time)}
            </div>
          </div>

          <div class="portrait-agenda-card-meta">
            ${travelBadgeHtml}
            <span class="chip-mode-badge ${s.delivery_mode}">${s.delivery_mode.toUpperCase()}</span>
            ${s.location ? `<span><i class="fa-solid fa-location-dot"></i> ${escapeHtml(s.location)}</span>` : ''}
          </div>

          ${s.tags && s.tags.length > 0 ? `
            <div class="chip-tags-row" style="margin-top:2px;">
              ${s.tags.map(t => `<span class="chip-tag-pill">${escapeHtml(t.name)}</span>`).join('')}
            </div>
          ` : ''}

          ${s.notes ? `
            <div class="portrait-agenda-card-notes">
              <i class="fa-regular fa-note-sticky"></i> ${escapeHtml(s.notes)}
            </div>
          ` : ''}
        </div>
      `;
    });
    html += `</div>`;
  } else if (!noteContent && !hasFinance) {
    html += `
      <div class="portrait-agenda-empty">
        <i class="fa-regular fa-calendar-check" style="font-size:1.8rem; color:var(--text-muted); opacity:0.6;"></i>
        <div style="font-weight:600; color:var(--text-main); font-size:0.92rem;">No schedules for this day</div>
        <button type="button" class="portrait-agenda-add-btn" id="portraitAgendaEmptyAddBtn" style="margin-top:6px;">
          <i class="fa-solid fa-plus"></i> Add Schedule
        </button>
      </div>
    `;
  }

  container.innerHTML = html;

  const addBtn = container.querySelector('#portraitAgendaAddBtn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      selectedDates.clear();
      selectedDates.add(dateStr);
      openScheduleModal();
    });
  }

  const emptyAddBtn = container.querySelector('#portraitAgendaEmptyAddBtn');
  if (emptyAddBtn) {
    emptyAddBtn.addEventListener('click', () => {
      selectedDates.clear();
      selectedDates.add(dateStr);
      openScheduleModal();
    });
  }

  const editNoteBtn = container.querySelector('.edit-note-btn');
  if (editNoteBtn) {
    editNoteBtn.addEventListener('click', () => {
      openDailyNoteModal(dateStr);
    });
  }

  const viewFinBtn = container.querySelector('.view-fin-btn');
  if (viewFinBtn) {
    viewFinBtn.addEventListener('click', () => {
      openDailyFinanceModal(dateStr);
    });
  }

  container.querySelectorAll('.portrait-agenda-card').forEach(card => {
    const idx = parseInt(card.dataset.schIdx, 10);
    const sch = daySchedules[idx];
    if (sch) {
      card.addEventListener('click', () => {
        openScheduleDetailsModal(sch);
      });
    }
  });
}

function getSchedulesMap(startDate, endDate) {
  if (!db) return {};
  const query = `
    SELECT 
      s.id, s.group_id, s.schedule_date, s.from_time, s.to_time, s.delivery_mode, s.location, s.title, s.notes, s.attachments, s.travel_info, s.reminder_min, s.status,
      GROUP_CONCAT(t.id || '::' || t.name || '::' || t.category_id || '::' || COALESCE(t.color,''), ';;') as tag_data
    FROM schedules s
    LEFT JOIN schedule_tags st ON s.id = st.schedule_id
    LEFT JOIN tags t ON st.tag_id = t.id
    WHERE s.schedule_date >= ? AND s.schedule_date <= ?
    GROUP BY s.id
    ORDER BY s.schedule_date ASC, s.from_time ASC
  `;
  const stmt = db.prepare(query);
  stmt.bind([startDate, endDate]);

  const map = {};
  while (stmt.step()) {
    const row = stmt.getAsObject();
    const tags = [];
    if (row.tag_data) {
      row.tag_data.split(';;').forEach(item => {
        const [id, name, catId, color] = item.split('::');
        if (id) tags.push({ id, name, catId, color });
      });
    }
    row.tags = tags;
    if (!map[row.schedule_date]) map[row.schedule_date] = [];
    map[row.schedule_date].push(row);
  }
  stmt.free();
  return map;
}

function formatTimeRange(start, end) {
  if (!start && !end) return 'All Day';
  if (start && !end) return start;
  return `${start} - ${end}`;
}

function formatDateYMD(d) {
  const yr = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${yr}-${m}-${day}`;
}

function deriveScheduleStatus(schDate, schToTime) {
  if (!schDate) return 'planned';
  const todayStr = formatDateYMD(new Date());
  if (schDate < todayStr) return 'completed';
  if (schDate === todayStr) {
    const nowTime = new Date().toTimeString().slice(0, 5);
    if (schToTime && schToTime <= nowTime) return 'completed';
  }
  return 'planned';
}


// Indian standard date format: DD-MM-YYYY (e.g. 05-10-2026)
function formatDateIndian(dateInput) {
  if (!dateInput) return '';
  if (typeof dateInput === 'string') {
    // If format is YYYY-MM-DD
    const parts = dateInput.split('-');
    if (parts.length === 3 && parts[0].length === 4) {
      return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
    const d = new Date(dateInput);
    if (!isNaN(d.getTime())) {
      const day = String(d.getDate()).padStart(2, '0');
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const yr = d.getFullYear();
      return `${day}-${month}-${yr}`;
    }
    return dateInput;
  } else if (dateInput instanceof Date && !isNaN(dateInput.getTime())) {
    const day = String(dateInput.getDate()).padStart(2, '0');
    const month = String(dateInput.getMonth() + 1).padStart(2, '0');
    const yr = dateInput.getFullYear();
    return `${day}-${month}-${yr}`;
  }
  return '';
}

function addDaysToDate(dateStr, numDays) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + numDays);
  return formatDateYMD(dt);
}

// Convert DD-MM-YYYY to YYYY-MM-DD (or returns original if already YYYY-MM-DD)
function parseIndianDateToYMD(str) {
  if (!str) return '';
  const trimmed = str.trim();
  const ddmmyyyy = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (ddmmyyyy) {
    const d = ddmmyyyy[1].padStart(2, '0');
    const m = ddmmyyyy[2].padStart(2, '0');
    const y = ddmmyyyy[3];
    return `${y}-${m}-${d}`;
  }
  const yyyymmdd = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (yyyymmdd) {
    const y = yyyymmdd[1];
    const m = yyyymmdd[2].padStart(2, '0');
    const d = yyyymmdd[3].padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return trimmed;
}

/* ==========================================================================
   4. MULTI-DATE SELECTION LOGIC
   ========================================================================== */

function toggleDateSelection(dateStr) {
  if (selectedDates.has(dateStr)) {
    selectedDates.delete(dateStr);
  } else {
    selectedDates.add(dateStr);
  }
  updateSelectionBar();
  document.querySelectorAll(`.day-cell[data-date="${dateStr}"]`).forEach(c => {
    c.classList.toggle('selected', selectedDates.has(dateStr));
  });
}

function updateSelectionBar() {
  const bar = document.getElementById('selectionActionBar');
  const countText = document.getElementById('selectedCountText');
  const count = selectedDates.size;

  if (count > 0) {
    bar.classList.remove('hidden');
    countText.textContent = `${count} date${count > 1 ? 's' : ''} selected`;
  } else {
    bar.classList.add('hidden');
  }
}

function clearDateSelection() {
  selectedDates.clear();
  document.querySelectorAll('.day-cell.selected').forEach(c => c.classList.remove('selected'));
  updateSelectionBar();
}

/* ==========================================================================
   4B. DAY VIEW RENDERING (24 HOURS HOURLY SCHEDULE)
   ========================================================================== */

function renderDayView() {
  const timeline = document.getElementById('dayTimeline');
  if (!timeline) return;
  timeline.innerHTML = '';

  const dayName = DAY_NAMES[currentDate.getDay()];
  const dateYmd = formatDateYMD(currentDate);
  const indianDate = formatDateIndian(currentDate);

  // Update Day View Header UI
  const dayNameEl = document.getElementById('dayViewDayName');
  const fullDateEl = document.getElementById('dayViewFullDate');
  const pickerInput = document.getElementById('dayViewDatePicker');
  const dayNoteBtn = document.getElementById('dayViewNoteBtn');

  if (dayNameEl) dayNameEl.textContent = dayName;
  if (fullDateEl) fullDateEl.textContent = indianDate;
  if (pickerInput) pickerInput.value = dateYmd;

  const noteContent = getDailyNoteForDate(dateYmd);
  if (dayNoteBtn) {
    if (noteContent) {
      dayNoteBtn.classList.add('has-note');
      dayNoteBtn.style.background = 'var(--badge-amber-bg)';
      dayNoteBtn.style.color = 'var(--badge-amber-text)';
      dayNoteBtn.style.borderColor = 'var(--badge-amber-border)';
      dayNoteBtn.innerHTML = '<i class="fa-solid fa-book-bookmark"></i> Daily Note ✓';
    } else {
      dayNoteBtn.classList.remove('has-note');
      dayNoteBtn.style.background = '';
      dayNoteBtn.style.color = 'var(--badge-amber-text)';
      dayNoteBtn.style.borderColor = 'var(--badge-amber-border)';
      dayNoteBtn.innerHTML = '<i class="fa-solid fa-book-bookmark"></i> Daily Note';
    }
  }

  if (noteContent) {
    const noteBanner = document.createElement('div');
    noteBanner.className = 'daily-note-banner';
    noteBanner.innerHTML = `
      <div class="daily-note-banner-header">
        <span class="daily-note-banner-title"><i class="fa-solid fa-note-sticky"></i> Personal Diary / Day Note</span>
        <button type="button" class="btn-xs btn-secondary edit-note-btn"><i class="fa-solid fa-pen-to-square"></i> Edit Note</button>
      </div>
      <div class="daily-note-banner-content">${escapeHtml(noteContent)}</div>
    `;
    const editBtn = noteBanner.querySelector('.edit-note-btn');
    if (editBtn) {
      editBtn.addEventListener('click', () => openDailyNoteModal(dateYmd));
    }
    timeline.appendChild(noteBanner);
  }

  // Check financial transactions for this day
  const txns = getDailyTransactionsForDate(dateYmd);
  const dayFinanceBtn = document.getElementById('dayViewFinanceBtn');
  if (dayFinanceBtn) {
    if (txns.length > 0) {
      dayFinanceBtn.classList.add('has-finance');
      dayFinanceBtn.style.background = 'var(--badge-green-bg)';
      dayFinanceBtn.style.color = 'var(--badge-green-text)';
      dayFinanceBtn.style.borderColor = 'var(--badge-green-border)';
      dayFinanceBtn.innerHTML = '<i class="fa-solid fa-coins"></i> Finance ✓';
    } else {
      dayFinanceBtn.classList.remove('has-finance');
      dayFinanceBtn.style.background = '';
      dayFinanceBtn.style.color = 'var(--badge-green-text)';
      dayFinanceBtn.style.borderColor = 'var(--badge-green-border)';
      dayFinanceBtn.innerHTML = '<i class="fa-solid fa-coins"></i> Daily Finance';
    }
  }

  if (txns.length > 0) {
    let receipts = 0, payments = 0;
    txns.forEach(t => {
      if (t.type === 'receipt') receipts += toPaise(t.amount);
      else if (t.type === 'payment') payments += toPaise(t.amount);
    });
    const net = receipts - payments;

    const finBanner = document.createElement('div');
    finBanner.className = 'daily-finance-banner';
    finBanner.innerHTML = `
      <div class="daily-finance-banner-header">
        <span class="daily-finance-banner-title"><i class="fa-solid fa-coins"></i> Daily Finance (Receipts & Payments)</span>
        <button type="button" class="btn-xs btn-secondary edit-fin-btn"><i class="fa-solid fa-pen-to-square"></i> Manage Finance</button>
      </div>
      <div style="font-size:0.9rem; display:flex; gap:16px; flex-wrap:wrap;">
        <span>Receipts: <strong style="color:var(--receipt-color);">${formatINR(receipts)}</strong></span>
        <span>Payments: <strong style="color:var(--payment-color);">${formatINR(payments)}</strong></span>
        <span>Net Flow: <strong style="color:${net >= 0 ? 'var(--net-positive)' : 'var(--net-negative)'};">${formatINR(net)}</strong></span>
      </div>
    `;
    const editFinBtn = finBanner.querySelector('.edit-fin-btn');
    if (editFinBtn) {
      editFinBtn.addEventListener('click', () => openDailyFinanceModal(dateYmd));
    }
    timeline.appendChild(finBanner);
  }

  // Retrieve all schedules for this single day
  const schedulesMap = getSchedulesMap(dateYmd, dateYmd);
  const daySchedules = schedulesMap[dateYmd] || [];

  // Determine current hour if viewing today
  const todayYmd = formatDateYMD(new Date());
  const isToday = (dateYmd === todayYmd);
  const currentHourNow = new Date().getHours();

  // Helper: Convert "HH:MM" to total minutes
  function timeToMinutes(tStr) {
    if (!tStr) return 0;
    const parts = tStr.split(':').map(Number);
    return (parts[0] || 0) * 60 + (parts[1] || 0);
  }

  // Generate 24 Hourly Rows (00:00 to 23:00)
  for (let hour = 0; hour < 24; hour++) {
    const hourStartMin = hour * 60;
    const hourEndMin = (hour + 1) * 60; // Up to end of hour
    const hourStartStr = String(hour).padStart(2, '0') + ':00';
    const hourEndStr = String(hour + 1).padStart(2, '0') + ':00';

    // 12-hour AM/PM label
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    const hour12Str = `${hour12}:00 ${ampm}`;

    const row = document.createElement('div');
    row.className = 'day-hour-row';
    if (isToday && hour === currentHourNow) {
      row.classList.add('current-hour');
    }

    // Time Column
    const timeCol = document.createElement('div');
    timeCol.className = 'hour-time-col';
    timeCol.innerHTML = `
      <span class="hour-primary-time">${hourStartStr}</span>
      <span class="hour-sub-time">${hour12Str}</span>
    `;
    row.appendChild(timeCol);

    // Events Column
    const eventsCol = document.createElement('div');
    eventsCol.className = 'hour-events-col';

    // Find all schedules overlapping this 1-hour interval [hourStartMin, hourEndMin)
    const matchingSchedules = daySchedules.filter(s => {
      // If neither from_time nor to_time is set, consider it all-day
      if (!s.from_time && !s.to_time) return true;

      const sStartMin = s.from_time ? timeToMinutes(s.from_time) : 0;
      let sEndMin = s.to_time ? timeToMinutes(s.to_time) : 24 * 60;

      // If to_time is earlier than or equal to from_time, it is an overnight schedule on this date
      // that continues until midnight (24:00 = 1440 mins) on this starting date!
      if (sEndMin <= sStartMin && s.to_time) {
        sEndMin = 24 * 60; // 1440 mins (midnight)
      }

      // Check overlap: interval [sStartMin, sEndMin] overlaps [hourStartMin, hourEndMin]
      return (sStartMin < hourEndMin && sEndMin > hourStartMin);
    });

    if (matchingSchedules.length > 0) {
      matchingSchedules.forEach(s => {
        const sStartMin = s.from_time ? timeToMinutes(s.from_time) : 0;
        const isStartHour = (!s.from_time && hour === 0) || (sStartMin >= hourStartMin && sStartMin < hourEndMin);

        const isTravelArr = s.title && (s.title.toLowerCase().startsWith('travel arrival:') || s.title.toLowerCase().startsWith('return travel arrival:'));
        const isTravelDep = s.title && (s.title.toLowerCase().startsWith('travel:') || s.title.toLowerCase().startsWith('return travel:') || s.title.toLowerCase() === 'travel');

        // Display clean title for travel
        let displayTitle = s.title;
        if (isTravelArr) {
          displayTitle = s.title.toLowerCase().startsWith('return') ? 'Return Travel Arrival' : 'Travel Arrival';
        } else if (isTravelDep) {
          displayTitle = s.title.toLowerCase().startsWith('return') ? 'Return Travel' : 'Travel';
        }

        if (!isStartHour) {
          // Render compact continuation pill instead of repeating the large card every hour
          const contCard = document.createElement('div');
          contCard.className = 'day-event-continuation';
          const accentColor = isTravelArr ? '#10b981' : (isTravelDep ? '#f59e0b' : (s.delivery_mode === 'online' ? '#0ea5e9' : '#3b82f6'));
          contCard.style.cssText = `display:flex; align-items:center; gap:6px; padding:3px 8px; border-radius:4px; background:rgba(255,255,255,0.03); border-left:3px solid ${accentColor}; font-size:0.75rem; color:var(--text-muted); cursor:pointer; margin-bottom:3px;`;
          contCard.innerHTML = `<i class="fa-solid fa-arrow-down" style="font-size:0.65rem; color:${accentColor};"></i> <span>${escapeHtml(displayTitle)} <small style="opacity:0.75;">(until ${s.to_time || 'end'})</small></span>`;
          contCard.title = `${s.title} (${formatTimeRange(s.from_time, s.to_time)}) - Click for details`;
          contCard.addEventListener('click', (e) => {
            e.stopPropagation();
            openScheduleDetailsModal(s);
          });
          eventsCol.appendChild(contCard);
          return;
        }

        const card = document.createElement('div');
        card.className = 'day-event-card';

        let badgeText = 'Event';
        let badgeClass = 'type-badge-program';
        if (isTravelArr) {
          card.classList.add('event-travel-arr');
          badgeText = '🏁 Travel Arrival';
          badgeClass = 'type-badge-travel-arr';
        } else if (isTravelDep) {
          card.classList.add('event-travel-dep');
          badgeText = '🚆 Travel Departure';
          badgeClass = 'type-badge-travel-dep';
        } else {
          if (s.delivery_mode === 'online') {
            card.classList.add('event-online');
            badgeText = '🌐 Online';
            badgeClass = 'type-badge-online';
          } else if (s.delivery_mode === 'hybrid') {
            card.classList.add('event-hybrid');
            badgeText = '🔄 Hybrid';
            badgeClass = 'type-badge-hybrid';
          } else {
            card.classList.add('event-offline');
            badgeText = '🏢 Offline';
            badgeClass = 'type-badge-offline';
          }
        }

        const tagPillsHtml = (s.tags || []).map(t => 
          `<span class="chip-tag-pill">${escapeHtml(t.name)}</span>`
        ).join('');

        card.innerHTML = `
          <div class="day-event-main">
            <div class="day-event-title-row">
              <span class="day-event-title">${escapeHtml(displayTitle)}</span>
              <span class="day-event-type-badge ${badgeClass}">${badgeText}</span>
              ${s.group_id ? '<span style="font-size:0.75rem; color:#a5b4fc;" title="Batch / Group Schedule">👥</span>' : ''}
              ${s.attachments && s.attachments !== '[]' ? '<span style="font-size:0.75rem; color:#94a3b8;" title="Has Attachments">📎</span>' : ''}
            </div>
            <div class="day-event-details-row">
              <span class="day-event-time"><i class="fa-regular fa-clock"></i> ${formatTimeRange(s.from_time, s.to_time)}</span>
              ${s.location ? `<span class="day-event-location"><i class="fa-solid fa-location-dot"></i> ${escapeHtml(s.location)}</span>` : ''}
              ${tagPillsHtml ? `<div class="day-event-tag-pills">${tagPillsHtml}</div>` : ''}
            </div>
          </div>
          <button type="button" class="day-event-inspect-btn" title="View details">
            <i class="fa-solid fa-eye"></i> Details
          </button>
        `;

        // Read-only click: opens full details popup modal
        card.addEventListener('click', (e) => {
          e.stopPropagation();
          openScheduleDetailsModal(s);
        });

        eventsCol.appendChild(card);
      });
    } else {
      // Empty hourly slot (subtle indicator)
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'hour-empty-placeholder';
      emptyDiv.innerHTML = `<i class="fa-regular fa-circle"></i> Available / No Schedule`;
      eventsCol.appendChild(emptyDiv);
    }

    row.appendChild(eventsCol);
    timeline.appendChild(row);
  }
}

let agendaWindowStart = 0;
let agendaWindowEnd = 60;

function renderAgendaView(resetPagination = true, scrollDirection = 'center') {
  const list = document.getElementById('agendaList');
  if (!list) return;

  const searchText = (document.getElementById('agendaSearchInput')?.value || '').toLowerCase().trim();
  const modeVal = document.getElementById('modeFilter')?.value || 'all';

  let query = `
    SELECT 
      s.id, s.group_id, s.schedule_date, s.from_time, s.to_time, s.delivery_mode, s.location, s.title, s.notes, s.attachments, s.travel_info, s.status,
      GROUP_CONCAT(t.id || '::' || t.name || '::' || t.category_id || '::' || COALESCE(t.color,''), ';;') as tag_data
    FROM schedules s
    LEFT JOIN schedule_tags st ON s.id = st.schedule_id
    LEFT JOIN tags t ON st.tag_id = t.id
    WHERE 1=1
  `;
  const params = [];

  if (modeVal !== 'all') {
    query += ` AND s.delivery_mode = ? `;
    params.push(modeVal);
  }

  query += ` GROUP BY s.id ORDER BY s.schedule_date ASC, s.from_time ASC`;

  const stmt = db.prepare(query);
  stmt.bind(params);

  const results = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    const tags = [];
    if (row.tag_data) {
      row.tag_data.split(';;').forEach(item => {
        const [id, name, catId, color] = item.split('::');
        if (id) tags.push({ id, name, catId, color });
      });
    }
    row.tags = tags;

    if (selectedAgendaTagIds.size > 0) {
      const hasMatchingTag = tags.some(t => selectedAgendaTagIds.has(t.id));
      if (!hasMatchingTag) continue;
    }

    if (searchText) {
      const matchTitle = (row.title || '').toLowerCase().includes(searchText);
      const matchNotes = (row.notes || '').toLowerCase().includes(searchText);
      const matchTags = tags.some(t => t.name.toLowerCase().includes(searchText));
      const matchLoc = (row.location || '').toLowerCase().includes(searchText);
      if (!matchTitle && !matchNotes && !matchTags && !matchLoc) continue;
    }

    results.push(row);
  }
  stmt.free();

  list.innerHTML = '';

  if (results.length === 0) {
    list.innerHTML = '<div style="text-align:center; padding:40px; color:#64748b;">No schedules match your search filters.</div>';
    return;
  }

  const targetYmd = formatDateYMD(currentDate);
  const todayYmd = formatDateYMD(new Date());

  // Default to centering around Today / target date on reset
  if (resetPagination) {
    let targetIdx = results.findIndex(s => s.schedule_date >= targetYmd);
    if (targetIdx === -1) {
      targetIdx = results.length;
    }
    // Show 15 recent past schedules before today, and 45 upcoming schedules
    agendaWindowStart = Math.max(0, targetIdx - 15);
    agendaWindowEnd = Math.min(results.length, targetIdx + 45);

    // If window is small and more exist, expand appropriately
    if (agendaWindowEnd - agendaWindowStart < 60) {
      if (agendaWindowStart === 0) {
        agendaWindowEnd = Math.min(results.length, 60);
      } else if (agendaWindowEnd === results.length) {
        agendaWindowStart = Math.max(0, results.length - 60);
      }
    }
  }

  // Bound checks
  agendaWindowStart = Math.max(0, Math.min(agendaWindowStart, results.length - 1));
  agendaWindowEnd = Math.max(agendaWindowStart + 1, Math.min(agendaWindowEnd, results.length));

  // 1. "Load Earlier Schedules" button at the TOP if past items exist
  if (agendaWindowStart > 0) {
    const loadEarlierContainer = document.createElement('div');
    loadEarlierContainer.className = 'agenda-load-container';
    const loadEarlierBtn = document.createElement('button');
    loadEarlierBtn.className = 'btn-secondary agenda-load-btn';
    loadEarlierBtn.innerHTML = `<i class="fa-solid fa-angles-up"></i> Load Earlier Schedules (${agendaWindowStart} past)`;
    loadEarlierBtn.addEventListener('click', () => {
      agendaWindowStart = Math.max(0, agendaWindowStart - 40);
      renderAgendaView(false, 'top');
    });
    loadEarlierContainer.appendChild(loadEarlierBtn);
    list.appendChild(loadEarlierContainer);
  }

  // Check if today has an event
  const hasTodayEvent = results.some(s => s.schedule_date === todayYmd);
  let todayMarkerInserted = false;
  let targetCardEl = null;

  const visibleResults = results.slice(agendaWindowStart, agendaWindowEnd);

  // Helper to create the Today marker card if no schedules for today
  const createTodayMarker = () => {
    const todayMarker = document.createElement('div');
    todayMarker.className = 'agenda-card today-agenda-card today-marker-card';
    todayMarker.dataset.date = todayYmd;
    const tObj = new Date();
    todayMarker.innerHTML = `
      <div class="agenda-card-date">
        <span class="agenda-day-str">${formatDateIndian(tObj)} <span class="today-badge">TODAY</span></span>
        <span class="agenda-day-name">${DAY_NAMES[tObj.getDay()]}</span>
      </div>
      <div class="agenda-card-details" style="display:flex; align-items:center; gap:8px; color:var(--text-muted); font-size:0.86rem; padding:8px 0;">
        <i class="fa-solid fa-calendar-check" style="color:#10b981; font-size:1.15rem;"></i>
        <span>No scheduled events for Today. Tap '+' to schedule, or scroll for upcoming programmes.</span>
      </div>
    `;
    todayMarker.addEventListener('click', () => {
      selectedDates.clear();
      selectedDates.add(todayYmd);
      openScheduleModal();
    });
    return todayMarker;
  };

  visibleResults.forEach(s => {
    // Check if todayMarker should be inserted before this card
    if (!hasTodayEvent && !todayMarkerInserted && s.schedule_date > todayYmd) {
      const marker = createTodayMarker();
      list.appendChild(marker);
      todayMarkerInserted = true;
      if (!targetCardEl && targetYmd === todayYmd) {
        targetCardEl = marker;
      }
    }

    const card = document.createElement('div');
    card.className = 'agenda-card';
    card.dataset.date = s.schedule_date;

    const dObj = new Date(s.schedule_date + 'T00:00:00');
    const dStrIndian = formatDateIndian(s.schedule_date);
    const dayOfWeek = DAY_NAMES[dObj.getDay()];
    const isToday = (s.schedule_date === todayYmd);

    if (isToday) {
      card.classList.add('today-agenda-card');
    }

    // Determine target card to scroll into view
    if (s.schedule_date === targetYmd) {
      if (!targetCardEl || targetCardEl.dataset.date !== targetYmd) {
        targetCardEl = card;
      }
    } else if (!targetCardEl && s.schedule_date > targetYmd) {
      targetCardEl = card;
    }

    card.innerHTML = `
      <div class="agenda-card-date">
        <span class="agenda-day-str">${dStrIndian} ${isToday ? '<span class="today-badge">TODAY</span>' : ''}</span>
        <span class="agenda-day-name">${dayOfWeek}</span>
      </div>
      <div class="agenda-card-details">
        <div class="agenda-card-title">${escapeHtml(s.title)} ${s.group_id ? '<span class="badge-batch-group"><i class="fa-solid fa-layer-group"></i> Batch Group</span>' : ''}</div>
        <div class="agenda-card-meta">
          <span><i class="fa-regular fa-clock"></i> ${formatTimeRange(s.from_time, s.to_time)}</span>
          <span class="chip-mode-badge ${s.delivery_mode}">${s.delivery_mode.toUpperCase()}</span>
          ${s.location ? `<span><i class="fa-solid fa-location-dot"></i> ${escapeHtml(s.location)}</span>` : ''}
          ${s.notes ? `<span><i class="fa-regular fa-note-sticky"></i> ${escapeHtml(s.notes)}</span>` : ''}
          ${s.attachments && s.attachments !== '[]' ? `<span style="color:var(--accent-blue);"><i class="fa-solid fa-paperclip"></i> Attached</span>` : ''}
        </div>
        <div class="chip-tags-row">
          ${s.tags.map(t => `<span class="chip-tag-pill">${escapeHtml(t.name)}</span>`).join('')}
        </div>
      </div>
    `;

    card.addEventListener('click', () => {
      openScheduleModal(s);
    });

    list.appendChild(card);
  });

  // If todayMarker still hasn't been inserted and all visible events are in the past:
  if (!hasTodayEvent && !todayMarkerInserted && agendaWindowEnd >= results.length) {
    const marker = createTodayMarker();
    list.appendChild(marker);
    todayMarkerInserted = true;
    if (!targetCardEl) targetCardEl = marker;
  }

  // 2. "Load More Upcoming Schedules" button at the BOTTOM if future items exist
  if (agendaWindowEnd < results.length) {
    const remaining = results.length - agendaWindowEnd;
    const loadMoreContainer = document.createElement('div');
    loadMoreContainer.className = 'agenda-load-container';
    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.className = 'btn-secondary agenda-load-btn';
    loadMoreBtn.innerHTML = `<i class="fa-solid fa-angles-down"></i> Load More Upcoming Schedules (${remaining} more)`;
    loadMoreBtn.addEventListener('click', () => {
      agendaWindowEnd = Math.min(results.length, agendaWindowEnd + 40);
      renderAgendaView(false, 'bottom');
    });
    loadMoreContainer.appendChild(loadMoreBtn);
    list.appendChild(loadMoreContainer);
  }

  // Auto-scroll logic:
  // Center on Today (or target date) when resetPagination is true
  if (resetPagination) {
    if (!targetCardEl) {
      targetCardEl = list.querySelector('.today-agenda-card') || list.querySelector('.agenda-card');
    }
    if (targetCardEl) {
      setTimeout(() => {
        targetCardEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 100);
    }
  }
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// Money: amounts are summed as integer paise so totals never drift (binary floats make 0.1 + 0.2 != 0.3).
// Rounding rule: half away from zero to the nearest paisa, applied once when a value enters a calculation.
function toPaise(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[₹,\s]/g, ''));
  if (!Number.isFinite(n)) return 0;
  // Decimal-exponent shift avoids 1.005 * 100 = 100.4999… rounding down.
  let p = Math.round(Number(Math.abs(n) + 'e2'));
  if (!Number.isFinite(p)) p = Math.round(Math.abs(n) * 100);
  return n < 0 ? -p : p;
}

// Ledger balances read as "₹x Dr" (debit balance) or "₹x Cr" (credit balance) rather than a signed number.
function formatDrCr(paise) {
  const p = Math.round(Number(paise) || 0);
  if (p === 0) return formatINR(0);
  return formatINR(Math.abs(p)) + (p > 0 ? ' Dr' : ' Cr');
}

// Display rupees from paise with Indian digit grouping (₹1,23,456.78).
function formatINR(paise, fractionDigits = 2) {
  const p = Math.round(Number(paise) || 0);
  const text = (Math.abs(p) / 100).toLocaleString('en-IN', { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
  return (p < 0 ? '-₹' : '₹') + text;
}

function sanitizeColor(val, fallback = '#3b82f6') {
  if (!val || typeof val !== 'string') return fallback;
  const trimmed = val.trim();
  // Safe hex (#rgb, #rrggbb, #rrggbbaa)
  if (/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed)) {
    return trimmed;
  }
  // Safe rgb/rgba/hsl/hsla functions
  if (/^(rgb|hsl)a?\(\s*[\d.%\s,]+\)$/i.test(trimmed)) {
    return trimmed;
  }
  // Safe named css colors
  if (/^[a-zA-Z]{3,20}$/.test(trimmed)) {
    return trimmed;
  }
  return fallback;
}

/* ==========================================================================
   6. SCHEDULE MODAL (ADD / EDIT / GROUP / TRAVEL TRANSIT / ATTACHMENTS)
   ========================================================================== */

let activeModalSelectedTagIds = new Set();
let activeEditingGroupId = null;
let onwardTicketAttachment = null;
let returnTicketAttachment = null;

function openScheduleModal(existingSchedule = null) {
  const modal = document.getElementById('scheduleModal');
  const modalTitle = document.getElementById('modalTitle');
  const deleteBtn = document.getElementById('deleteScheduleBtn');
  const deleteGroupBtn = document.getElementById('deleteGroupBtn');
  const groupBadgeContainer = document.getElementById('groupBadgeContainer');
  const chipsContainer = document.getElementById('selectedDatesChips');

  activeModalSelectedTagIds.clear();
  currentModalAttachments = [];
  activeEditingGroupId = null;
  onwardTicketAttachment = null;
  returnTicketAttachment = null;

  // Reset travel fields
  document.getElementById('addOnwardTravel').checked = false;
  document.getElementById('addReturnTravel').checked = false;
  document.getElementById('onwardTravelFields').classList.add('hidden');
  document.getElementById('returnTravelFields').classList.add('hidden');
  document.getElementById('travelTransitBody').classList.add('hidden');
  document.getElementById('onwardAmount').value = 0;
  document.getElementById('returnAmount').value = 0;
  document.getElementById('onwardPnrNo').value = '';
  document.getElementById('returnPnrNo').value = '';
  document.getElementById('onwardReimbursable').checked = false;
  document.getElementById('onwardReimbursable').disabled = true;
  document.getElementById('onwardReimbursableWrapper').classList.add('disabled-opt');
  document.getElementById('returnReimbursable').checked = false;
  document.getElementById('returnReimbursable').disabled = true;
  document.getElementById('returnReimbursableWrapper').classList.add('disabled-opt');
  renderTravelTicketPreview('onward');
  renderTravelTicketPreview('return');

  let datesToApply = [];
  if (existingSchedule) {
    document.getElementById('editScheduleId').value = existingSchedule.id;
    document.getElementById('schedTitle').value = existingSchedule.title || '';
    document.getElementById('schedFromTime').value = existingSchedule.from_time || '09:30';
    document.getElementById('schedToTime').value = existingSchedule.to_time || '13:30';
    document.getElementById('schedNotes').value = existingSchedule.notes || '';

    // Load attachments
    try {
      currentModalAttachments = JSON.parse(existingSchedule.attachments || '[]');
    } catch (e) {
      currentModalAttachments = [];
    }

    // Check group
    if (existingSchedule.group_id) {
      activeEditingGroupId = existingSchedule.group_id;
      // Get all dates in this group (excluding travel entries)
      const res = db.exec("SELECT schedule_date FROM schedules WHERE group_id = ? AND title NOT LIKE 'Travel:%' AND title NOT LIKE 'Return Travel:%' AND title NOT LIKE 'Travel Arrival:%' AND title NOT LIKE 'Return Travel Arrival:%' ORDER BY schedule_date ASC", [activeEditingGroupId]);
      if (res.length > 0) {
        datesToApply = res[0].values.map(v => v[0]);
      } else {
        datesToApply = [existingSchedule.schedule_date];
      }
      groupBadgeContainer.classList.remove('hidden');
      document.getElementById('groupInfoText').textContent = `Batch Group (${datesToApply.length} Days linked - All edits apply to full batch)`;
      const chk = document.getElementById('applyAsGroupCheckbox');
      chk.checked = true;
      chk.disabled = true; // Locked: Batch schedules cannot be edited individually
      deleteGroupBtn.classList.remove('hidden');
    } else {
      datesToApply = [existingSchedule.schedule_date];
      groupBadgeContainer.classList.add('hidden');
      const chk = document.getElementById('applyAsGroupCheckbox');
      chk.disabled = false;
      deleteGroupBtn.classList.add('hidden');
    }

    modalTitle.innerHTML = '<i class="fa-solid fa-pen-to-square"></i> Edit Schedule';
    deleteBtn.classList.remove('hidden');

    if (existingSchedule.tags) {
      existingSchedule.tags.forEach(t => activeModalSelectedTagIds.add(t.id));
    }

  } else {
    // New Schedule
    document.getElementById('editScheduleId').value = '';
    document.getElementById('schedTitle').value = '';
    document.getElementById('schedFromTime').value = '09:30';
    document.getElementById('schedToTime').value = '13:30';
    document.getElementById('schedNotes').value = '';

    datesToApply = selectedDates.size > 0 ? Array.from(selectedDates).sort() : [formatDateYMD(new Date())];
    
    // If multiple dates selected, enable group option
    if (datesToApply.length > 1) {
      groupBadgeContainer.classList.remove('hidden');
      document.getElementById('groupInfoText').textContent = `Creating Batch Collection (${datesToApply.length} Days)`;
      document.getElementById('applyAsGroupCheckbox').checked = true;
    } else {
      groupBadgeContainer.classList.add('hidden');
    }

    modalTitle.innerHTML = `<i class="fa-solid fa-calendar-plus"></i> Add Schedule (${datesToApply.length} Date${datesToApply.length > 1 ? 's' : ''})`;
    deleteBtn.classList.add('hidden');
    deleteGroupBtn.classList.add('hidden');
  }

  // Pre-calculate travel dates based on first day and last day
  const firstDayStr = datesToApply[0];
  const lastDayStr = datesToApply[datesToApply.length - 1];

  // Default onward travel: previous day departure, same day or event day morning arrival
  const defOnwardFromDate = addDaysToDate(firstDayStr, -1);
  const defOnwardToDate = firstDayStr;
  document.getElementById('onwardTravelDate').value = defOnwardFromDate;
  document.getElementById('onwardArrivalDate').value = defOnwardToDate;

  // Default return travel: last day evening departure, next day morning arrival
  const defReturnFromDate = lastDayStr;
  const defReturnToDate = addDaysToDate(lastDayStr, 1);
  document.getElementById('returnTravelDate').value = defReturnFromDate;
  document.getElementById('returnArrivalDate').value = defReturnToDate;

  // Populate travel fields if existing schedule has travel_info or notes with travel data
  if (existingSchedule) {
    let tInfo = null;
    if (existingSchedule.travel_info) {
      try {
        tInfo = JSON.parse(existingSchedule.travel_info);
      } catch (e) {
        tInfo = null;
      }
    }

    // Fallback: extract travel info from notes if travel_info was not saved
    if (!tInfo && existingSchedule.notes) {
      const rawNotes = existingSchedule.notes;
      const pnrMatches = [...rawNotes.matchAll(/PNR:\s*([A-Za-z0-9]+)/gi)];
      const amtMatches = [...rawNotes.matchAll(/Amount:\s*₹?([\d.]+)/gi)];
      const reimbMatches = [...rawNotes.matchAll(/(Reimbursable|Non-reimbursable)/gi)];

      if (pnrMatches.length > 0 || amtMatches.length > 0 || rawNotes.includes('Departure:')) {
        tInfo = {
          onward: {
            enabled: true,
            pnr: pnrMatches[0] ? pnrMatches[0][1] : '',
            amount: amtMatches[0] ? parseFloat(amtMatches[0][1]) : 0,
            reimbursable: reimbMatches[0] ? reimbMatches[0][1].toLowerCase() === 'reimbursable' : false
          }
        };
        if (pnrMatches.length > 1 || amtMatches.length > 1) {
          tInfo.return = {
            enabled: true,
            pnr: pnrMatches[1] ? pnrMatches[1][1] : '',
            amount: amtMatches[1] ? parseFloat(amtMatches[1][1]) : 0,
            reimbursable: reimbMatches[1] ? reimbMatches[1][1].toLowerCase() === 'reimbursable' : false
          };
        }
      }
    }

    if (tInfo) {
      if (tInfo.onward && tInfo.onward.enabled) {
        document.getElementById('addOnwardTravel').checked = true;
        document.getElementById('onwardTravelFields').classList.remove('hidden');
        document.getElementById('travelTransitBody').classList.remove('hidden');
        if (tInfo.onward.mode) document.getElementById('onwardTravelMode').value = tInfo.onward.mode;
        if (tInfo.onward.fromDate) document.getElementById('onwardTravelDate').value = tInfo.onward.fromDate;
        if (tInfo.onward.toDate) document.getElementById('onwardArrivalDate').value = tInfo.onward.toDate;
        if (tInfo.onward.depTime) document.getElementById('onwardDepTime').value = tInfo.onward.depTime;
        if (tInfo.onward.arrTime) document.getElementById('onwardArrTime').value = tInfo.onward.arrTime;
        if (tInfo.onward.fromPlace) document.getElementById('onwardFromPlace').value = tInfo.onward.fromPlace;
        if (tInfo.onward.toPlace) document.getElementById('onwardToPlace').value = tInfo.onward.toPlace;
        if (tInfo.onward.details) document.getElementById('onwardTravelDetails').value = tInfo.onward.details;
        if (tInfo.onward.pnr) document.getElementById('onwardPnrNo').value = tInfo.onward.pnr;
        if (tInfo.onward.amount !== undefined) document.getElementById('onwardAmount').value = tInfo.onward.amount;
        updateTravelReimbursableState('onward');
        if (tInfo.onward.reimbursable) document.getElementById('onwardReimbursable').checked = true;
        if (tInfo.onward.attachment) {
          onwardTicketAttachment = tInfo.onward.attachment;
          renderTravelTicketPreview('onward');
        }
      }

      if (tInfo.return && tInfo.return.enabled) {
        document.getElementById('addReturnTravel').checked = true;
        document.getElementById('returnTravelFields').classList.remove('hidden');
        document.getElementById('travelTransitBody').classList.remove('hidden');
        if (tInfo.return.mode) document.getElementById('returnTravelMode').value = tInfo.return.mode;
        if (tInfo.return.fromDate) document.getElementById('returnTravelDate').value = tInfo.return.fromDate;
        if (tInfo.return.toDate) document.getElementById('returnArrivalDate').value = tInfo.return.toDate;
        if (tInfo.return.depTime) document.getElementById('returnDepTime').value = tInfo.return.depTime;
        if (tInfo.return.arrTime) document.getElementById('returnArrTime').value = tInfo.return.arrTime;
        if (tInfo.return.fromPlace) document.getElementById('returnFromPlace').value = tInfo.return.fromPlace;
        if (tInfo.return.toPlace) document.getElementById('returnToPlace').value = tInfo.return.toPlace;
        if (tInfo.return.details) document.getElementById('returnTravelDetails').value = tInfo.return.details;
        if (tInfo.return.pnr) document.getElementById('returnPnrNo').value = tInfo.return.pnr;
        if (tInfo.return.amount !== undefined) document.getElementById('returnAmount').value = tInfo.return.amount;
        updateTravelReimbursableState('return');
        if (tInfo.return.reimbursable) document.getElementById('returnReimbursable').checked = true;
        if (tInfo.return.attachment) {
          returnTicketAttachment = tInfo.return.attachment;
          renderTravelTicketPreview('return');
        }
      }
    }
  }

  updateTravelDateHint('onwardTravelDate', 'onwardTravelDateHint');
  updateTravelDateHint('onwardArrivalDate', 'onwardArrivalDateHint');
  updateTravelDateHint('returnTravelDate', 'returnTravelDateHint');
  updateTravelDateHint('returnArrivalDate', 'returnArrivalDateHint');

  // Render Date Chips in Indian format DD-MM-YYYY
  chipsContainer.innerHTML = '';
  datesToApply.forEach(d => {
    const chip = document.createElement('span');
    chip.className = 'date-chip';
    chip.textContent = formatDateIndian(d);
    chip.title = d; // Store ISO format in tooltip
    chipsContainer.appendChild(chip);
  });

  // Render Category Tag Picker with inline quick adder
  renderTagPickerInModal();

  // Render Dynamic Custom Fields
  renderCustomFieldsInModal();

  // Render Attachments Preview
  renderAttachmentsPreview();

  modal.classList.remove('hidden');
}

function closeScheduleModal() {
  document.getElementById('scheduleModal').classList.add('hidden');
}

function renderTagPickerInModal() {
  const container = document.getElementById('categoryTagsPicker');
  container.innerHTML = '';

  tagMasterCategories.forEach(cat => {
    const group = document.createElement('div');
    group.className = 'picker-category-group';

    // Header with category name & inline "+" quick add tag button
    const headerRow = document.createElement('div');
    headerRow.className = 'picker-category-name-row';

    const catName = document.createElement('span');
    catName.className = 'picker-category-name';
    catName.textContent = cat.name;
    catName.style.color = sanitizeColor(cat.color, '#94a3b8');

    const addTagBtn = document.createElement('button');
    addTagBtn.type = 'button';
    addTagBtn.className = 'btn-inline-add-tag';
    addTagBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Add Tag';
    addTagBtn.title = `Add new tag directly to ${cat.name}`;
    addTagBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleQuickAddTagInline(cat.id, cat.name);
    });

    headerRow.appendChild(catName);
    headerRow.appendChild(addTagBtn);
    group.appendChild(headerRow);

    const tagsRow = document.createElement('div');
    tagsRow.className = 'picker-tags-row';

    const catTags = tagMasterTags.filter(t => t.category_id === cat.id);
    catTags.forEach(t => {
      const tagBtn = document.createElement('div');
      tagBtn.className = 'tag-selectable';
      tagBtn.textContent = t.name;
      tagBtn.style.setProperty('--tag-color', sanitizeColor(t.color, '#3b82f6'));

      if (activeModalSelectedTagIds.has(t.id)) {
        tagBtn.classList.add('selected');
      }

      tagBtn.addEventListener('click', () => {
        if (activeModalSelectedTagIds.has(t.id)) {
          activeModalSelectedTagIds.delete(t.id);
          tagBtn.classList.remove('selected');
        } else {
          activeModalSelectedTagIds.add(t.id);
          tagBtn.classList.add('selected');
        }
        renderCustomFieldsInModal();
      });

      tagsRow.appendChild(tagBtn);
    });

    group.appendChild(tagsRow);
    container.appendChild(group);
  });
}

async function handleQuickAddTagInline(catId, catName) {
  const name = prompt(`Add new tag into [${catName}]:\n(e.g. Coimbatore, Indigo, Advanced Excel)`);
  if (!name || !name.trim()) return;

  const color = prompt('Tag color hex code (or leave default):', '#3b82f6') || '#3b82f6';
  const id = 'tag_' + Date.now();

  try {
    if (db) {
      db.run('INSERT INTO tags (id, category_id, name, color, description) VALUES (?, ?, ?, ?, ?)', [id, catId, name.trim(), color, '']);
      await saveDbToIndexedDB();
    }

    loadMasterDataFromDb();
    
    // Automatically select the newly created tag in modal
    activeModalSelectedTagIds.add(id);
    renderTagPickerInModal();
    renderCustomFieldsInModal();
  } catch (err) {
    alert('Error adding tag: ' + err.message);
  }
}

function renderCustomFieldsInModal() {
  const container = document.getElementById('tagCustomFieldsContainer');
  const grid = document.getElementById('dynamicFieldsInputs');
  grid.innerHTML = '';

  const activeTags = tagMasterTags.filter(t => activeModalSelectedTagIds.has(t.id));
  const activeCatIds = new Set(activeTags.map(t => t.category_id));

  const relevantFields = tagMasterFields.filter(f => {
    if (f.tag_id && activeModalSelectedTagIds.has(f.tag_id)) return true;
    if (f.category_id && activeCatIds.has(f.category_id)) return true;
    return false;
  });

  if (relevantFields.length === 0) {
    container.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');

  relevantFields.forEach(fld => {
    const fieldGroup = document.createElement('div');
    fieldGroup.className = 'form-group';

    const label = document.createElement('label');
    label.textContent = fld.field_label;

    const input = document.createElement('input');
    input.type = fld.field_type === 'number' ? 'number' : 'text';
    input.dataset.fieldKey = fld.field_key;
    input.placeholder = `Enter ${fld.field_label}...`;
    input.className = 'custom-field-input';

    fieldGroup.appendChild(label);
    fieldGroup.appendChild(input);
    grid.appendChild(fieldGroup);
  });
}

/* ==========================================================================
   7. ATTACHMENT UPLOAD & BASE64 STORAGE
   ========================================================================== */

function handleAttachmentUpload(e) {
  const files = Array.from(e.target.files);
  if (!files || files.length === 0) return;

  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = () => {
      currentModalAttachments.push({
        id: 'att_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        name: file.name,
        type: file.type,
        size: file.size,
        data: reader.result // Base64 string
      });
      renderAttachmentsPreview();
    };
    reader.readAsDataURL(file);
  });
  e.target.value = ''; // Reset input
}

function renderAttachmentsPreview() {
  const container = document.getElementById('attachmentsPreviewList');
  container.innerHTML = '';

  if (currentModalAttachments.length === 0) {
    container.innerHTML = '<span style="color:#64748b; font-size:0.75rem;">No files attached yet.</span>';
    return;
  }

  currentModalAttachments.forEach((att, idx) => {
    const card = document.createElement('div');
    card.className = 'attachment-card';

    if (att.type.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = att.data;
      img.className = 'attachment-thumbnail';
      img.title = 'Click to open full image';
      img.addEventListener('click', () => {
        openAttachmentViewer(att);
      });
      card.appendChild(img);
    } else {
      const icon = document.createElement('i');
      icon.className = 'fa-solid fa-file-pdf attachment-file-icon';
      icon.style.cursor = 'pointer';
      icon.addEventListener('click', () => {
        openAttachmentViewer(att);
      });
      card.appendChild(icon);
    }

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'attachment-delete-btn';
    delBtn.innerHTML = '×';
    delBtn.title = 'Remove attachment';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      currentModalAttachments.splice(idx, 1);
      renderAttachmentsPreview();
    });
    card.appendChild(delBtn);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'attachment-card-name';
    nameSpan.textContent = att.name;
    card.appendChild(nameSpan);

    container.appendChild(card);
  });
}

function parseCMap(cmapString) {
  const cmap = {};
  const bfrangeBlocks = cmapString.matchAll(/beginbfrange([\s\S]*?)endbfrange/g);
  for (const block of bfrangeBlocks) {
    const lines = block[1].split('\n');
    for (const line of lines) {
      const m = line.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/);
      if (m) {
        const start = parseInt(m[1], 16);
        const end = parseInt(m[2], 16);
        let target = parseInt(m[3], 16);
        for (let c = start; c <= end; c++) {
          cmap[c] = String.fromCharCode(target);
          target++;
        }
      }
    }
  }
  const bfcharBlocks = cmapString.matchAll(/beginbfchar([\s\S]*?)endbfchar/g);
  for (const block of bfcharBlocks) {
    const lines = block[1].split('\n');
    for (const line of lines) {
      const m = line.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/);
      if (m) {
        const src = parseInt(m[1], 16);
        const dst = parseInt(m[2], 16);
        cmap[src] = String.fromCharCode(dst);
      }
    }
  }
  return cmap;
}

async function extractTextFromPdf(arrayBuffer) {
  if (typeof pdfjsLib === 'undefined') {
    console.warn('pdfjsLib is not loaded');
    return [];
  }

  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.js';
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer, isEvalSupported: false });
    const pdf = await loadingTask.promise;
    const allTokens = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageTokens = textContent.items.map(item => item.str).filter(s => s && s.trim().length > 0);
      allTokens.push(...pageTokens);
    }
    return allTokens;
  } catch (err) {
    console.warn('pdfjsLib extraction error:', err);
    return [];
  }
}

function extractPdfTokens(uint8Array) {
  let cmap = {};
  const streamHeader = [115, 116, 114, 101, 97, 109]; // 'stream'
  const endstreamHeader = [101, 110, 100, 115, 116, 114, 101, 97, 109]; // 'endstream'

  function indexOf(arr, pattern, start) {
    for (let i = start; i <= arr.length - pattern.length; i++) {
      let found = true;
      for (let j = 0; j < pattern.length; j++) {
        if (arr[i + j] !== pattern[j]) { found = false; break; }
      }
      if (found) return i;
    }
    return -1;
  }

  let idx = 0;
  const streams = [];
  while (true) {
    const streamStart = indexOf(uint8Array, streamHeader, idx);
    if (streamStart === -1) break;
    let startData = streamStart + 6;
    if (uint8Array[startData] === 13) startData++;
    if (uint8Array[startData] === 10) startData++;
    const endStream = indexOf(uint8Array, endstreamHeader, startData);
    if (endStream === -1) break;

    let endData = endStream;
    while (endData > startData && (uint8Array[endData - 1] === 10 || uint8Array[endData - 1] === 13 || uint8Array[endData - 1] === 32)) {
      endData--;
    }

    const streamBuf = uint8Array.subarray(startData, endData);
    try {
      if (typeof pako !== 'undefined' && pako.inflate) {
        const inflated = pako.inflate(streamBuf);
        if (inflated) {
          streams.push(inflated);
          const s = new TextDecoder('utf-8').decode(inflated);
          if (s.includes('begincmap')) {
            cmap = Object.assign(cmap, parseCMap(s));
          }
        }
      }
    } catch (e) {}
    idx = endStream + 9;
  }

  function decodeBytes(bytes) {
    if (Object.keys(cmap).length === 0) {
      return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
    }
    let str = '';
    for (let i = 0; i < bytes.length; i += 2) {
      if (i + 1 < bytes.length) {
        const code = (bytes[i] << 8) | bytes[i + 1];
        str += cmap[code] || ' ';
      }
    }
    return str;
  }

  const tokens = [];
  for (const inflated of streams) {
    let hasBT = false;
    for (let i = 0; i < inflated.length - 1; i++) {
      if (inflated[i] === 66 && inflated[i + 1] === 84) { hasBT = true; break; } // 'BT'
    }
    if (!hasBT) continue;

    let i = 0;
    while (i < inflated.length) {
      if (inflated[i] === 0x28) { // '('
        let j = i + 1;
        const byteArr = [];
        while (j < inflated.length) {
          if (inflated[j] === 0x5c) { // '\'
            j++;
            if (inflated[j] === 0x6e) byteArr.push(0x0a);
            else if (inflated[j] === 0x72) byteArr.push(0x0d);
            else if (inflated[j] === 0x74) byteArr.push(0x09);
            else byteArr.push(inflated[j]);
            j++;
          } else if (inflated[j] === 0x29) { // ')'
            break;
          } else {
            byteArr.push(inflated[j]);
            j++;
          }
        }
        if (byteArr.length > 0) {
          const dec = decodeBytes(byteArr).trim();
          if (dec) tokens.push(dec);
        }
        i = j + 1;
      } else {
        i++;
      }
    }
  }
  return tokens;
}

function parseIrctcData(tokens) {
  const fullText = Array.isArray(tokens) ? tokens.join(' ') : tokens;

  // 1. PNR: 10 digits
  let pnr = '';
  const pnrMatch = fullText.match(/\b(\d{10})\b/);
  if (pnrMatch) pnr = pnrMatch[1];

  // 2. Train No & Name: e.g. "16102/QLN MS EXPRESS"
  let train = '';
  const trainMatch = fullText.match(/\b(\d{5}\s*\/\s*[A-Za-z0-9\s\-]+?)(?=\s+(?:Booked|Boarding|From|To|SECOND|FIRST|THIRD|AC|SL|2A|3A|1A|CC|EC|GENERAL|Quota|\d{2}-)|$)/i) ||
                     fullText.match(/\b(\d{5}\s*\/\s*[^\s]+(?:\s+[^\s]+){1,3})/i);
  if (trainMatch) {
    train = trainMatch[1].trim();
  }

  // 3. Station Names: Booked from / Boarding At / To
  let fromStation = '';
  let toStation = '';

  const nonStationWords = [
    'GENERAL', 'TATKAL', 'PREMIUM', 'LOWER BERTH', 'SENIOR CITIZEN', 'LADIES', 'DUTY PASS', 'FOREIGN TOURIST',
    'INDIAN RAILWAYS', 'IRCTC', 'STATE', 'GST', 'TAX', 'CGST', 'SGST', 'IGST',
    'ELECTRONIC RESERVATION', 'RESERVATION SLIP', 'CONSUMER HELPLINE', 'CERTIFICATE', 'USER', 'PASSENGER',
    'FARE', 'DISTANCE', 'WAITLIST', 'CONFIRMED', 'TOTAL', 'INSURANCE', 'CONVENIENCE', 'CHARGES'
  ];
  const nonStationCodes = new Set([
    'GN', 'TQ', 'PT', 'LD', 'HO', 'DP', 'SS', 'HP', 'DF', 'FT', 'SL', 'CC', 'EC', 'EA', 'EV', 'FC', '2S', '3E',
    'ERS', 'NCH', 'IT', 'GST', 'PG', 'KM', 'PRS', 'UTS', 'SMS', 'VRM', 'GGM', 'IRCTC', 'CRIS', 'SBI', 'UPI', 'PNR'
  ]);

  function cleanStationName(raw) {
    if (!raw) return '';
    // If the regex matched across newlines or multiline tokens, take the last line containing the station name
    const lines = raw.split(/[\r\n]+/);
    const lastLine = lines[lines.length - 1] || '';
    return lastLine
      .replace(/^(?:(?:Booked\s*from|Boarding\s*At|From\s*Station|From|To\s*Station|To)\s*[:\-]?\s*)+/gi, '')
      .trim();
  }

  // Extract station matches with strictly 2-5 uppercase letters in parenthesis
  const rawMatches = Array.from(fullText.matchAll(/([A-Za-z\s\.'\-]{2,35}\s*\(([A-Z]{2,5})\))/g));
  const validStations = [];

  for (const m of rawMatches) {
    const rawMatch = m[1].trim();
    const code = m[2].trim();
    const cleaned = cleanStationName(rawMatch);
    const textBefore = cleaned.split('(')[0].trim().toUpperCase();

    if (nonStationCodes.has(code)) continue;
    if (nonStationWords.some(w => textBefore.includes(w) || textBefore === w)) continue;
    if (cleaned.length < 3) continue;

    validStations.push(cleaned);
  }

  // 3a. Explicit keyword matching for From & To with punctuation (: or -)
  const explicitFrom = fullText.match(/(?:Booked\s*from|Boarding\s*At|From\s*Station|\bFrom)\s*[:\-]\s*([A-Za-z\s\.'\-]{2,35}\s*\([A-Z]{2,5}\))/i);
  const explicitTo = fullText.match(/(?:To\s*Station|\bTo)\s*[:\-]\s*([A-Za-z\s\.'\-]{2,35}\s*\([A-Z]{2,5}\))/i);

  if (explicitFrom && explicitTo) {
    fromStation = cleanStationName(explicitFrom[1]);
    toStation = cleanStationName(explicitTo[1]);
  }

  // 3b. If explicit matching is missing or both resolved to the same station, extract from validStations
  if (!fromStation || !toStation || fromStation === toStation) {
    if (validStations.length >= 2) {
      fromStation = validStations[0];
      // In IRCTC tickets: table shows [Booked From, Boarding At, To]
      // Destination is the first station with a different station code/name from origin:
      const fromCode = (fromStation.match(/\(([A-Z]{2,5})\)/) || [])[1];
      let destStation = null;
      for (let i = 1; i < validStations.length; i++) {
        const curCode = (validStations[i].match(/\(([A-Z]{2,5})\)/) || [])[1];
        if (curCode && fromCode && curCode !== fromCode) {
          destStation = validStations[i];
          break;
        } else if (!fromCode && validStations[i] !== fromStation) {
          destStation = validStations[i];
          break;
        }
      }
      toStation = destStation || validStations[validStations.length - 1];
    } else if (validStations.length === 1) {
      if (!fromStation) fromStation = validStations[0];
    }
  }

  // 4. Departure Date & Time
  let depTime = '', depDate = '', arrTime = '', arrDate = '';

  const depMatch = fullText.match(/Departure\*?\s*:?\s*(\d{2}:\d{2})\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i) ||
                   fullText.match(/Departure\*?\s*:?\s*(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\d{2}:\d{2})/i) ||
                   fullText.match(/Start Date\*?\s*(\d{1,2}-[A-Za-z]{3}-\d{4})/i);

  if (depMatch) {
    if (depMatch[1] && depMatch[1].includes(':')) {
      depTime = depMatch[1];
      depDate = parseIndianDateToYmd(depMatch[2]);
    } else if (depMatch[2] && depMatch[2].includes(':')) {
      depTime = depMatch[2];
      depDate = parseIndianDateToYmd(depMatch[1]);
    } else if (depMatch[1]) {
      depDate = parseIndianDateToYmd(depMatch[1]);
    }
  }

  // 5. Arrival Date & Time
  const arrMatch = fullText.match(/Arrival\*?\s*:?\s*(\d{2}:\d{2})\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i) ||
                   fullText.match(/Arrival\*?\s*:?\s*(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\d{2}:\d{2})/i);

  if (arrMatch) {
    if (arrMatch[1] && arrMatch[1].includes(':')) {
      arrTime = arrMatch[1];
      arrDate = parseIndianDateToYmd(arrMatch[2]);
    } else {
      arrTime = arrMatch[2];
      arrDate = parseIndianDateToYmd(arrMatch[1]);
    }
  }

  // 6. Total Fare / Amount
  let totalFare = 0;
  const fareMatch = fullText.match(/Total Fare[^\d]*([\d,]+\.\d{2})/i) ||
                    fullText.match(/Ticket Fare[^\d]*([\d,]+\.\d{2})/i);
  if (fareMatch) {
    totalFare = parseFloat(fareMatch[1].replace(/,/g, '')) || 0;
  }

  function parseIndianDateToYmd(dStr) {
    if (!dStr) return '';
    const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
    const parts = dStr.split('-');
    if (parts.length === 3) {
      const dd = parts[0].padStart(2, '0');
      const mm = months[parts[1].toLowerCase()] || '01';
      const yyyy = parts[2];
      return `${yyyy}-${mm}-${dd}`;
    }
    return '';
  }

  return { pnr, train, fromStation, toStation, depDate, depTime, arrDate, arrTime, totalFare };
}

function handleTravelTicketUpload(type, file) {
  if (!file) return;

  // 1. Process as Base64 attachment
  const reader = new FileReader();
  reader.onload = () => {
    const attObj = {
      id: `ticket_${type}_` + Date.now(),
      name: file.name,
      type: file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'),
      size: file.size,
      data: reader.result // Base64
    };
    if (type === 'onward') {
      onwardTicketAttachment = attObj;
    } else {
      returnTicketAttachment = attObj;
    }
    renderTravelTicketPreview(type);
  };
  reader.readAsDataURL(file);

  // 2. If PDF, parse text and auto-prefill travel details
  if (file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf') {
    const bufReader = new FileReader();
    bufReader.onload = async () => {
      try {
        const arrayBuffer = bufReader.result;
        let tokens = await extractTextFromPdf(arrayBuffer);

        if (!tokens || tokens.length === 0) {
          const uint8Array = new Uint8Array(arrayBuffer);
          tokens = extractPdfTokens(uint8Array);
        }

        if (tokens && tokens.length > 0) {
          const ticketData = parseIrctcData(tokens);
          console.log(`Auto-extracted ticket data for ${type}:`, ticketData);

          if (ticketData.pnr || ticketData.train || ticketData.depDate || ticketData.fromStation) {
            const chkBox = document.getElementById(type === 'onward' ? 'addOnwardTravel' : 'addReturnTravel');
            if (chkBox) {
              chkBox.checked = true;
              const fieldsDiv = document.getElementById(type === 'onward' ? 'onwardTravelFields' : 'returnTravelFields');
              if (fieldsDiv) fieldsDiv.classList.remove('hidden');
              const travelBody = document.getElementById('travelTransitBody');
              if (travelBody) travelBody.classList.remove('hidden');
            }

            applyTicketDataToForm(type, ticketData);
            showToast(`Auto-filled ${type} travel details from PDF ticket!`, 'success', 4000);
          }
        }
      } catch (err) {
        console.warn('PDF ticket parsing failed:', err);
      }
    };
    bufReader.readAsArrayBuffer(file);
  }
}

function applyTicketDataToForm(type, data) {
  const isO = (type === 'onward');
  const modeSel = document.getElementById(isO ? 'onwardTravelMode' : 'returnTravelMode');
  const fromPlace = document.getElementById(isO ? 'onwardFromPlace' : 'returnFromPlace');
  const toPlace = document.getElementById(isO ? 'onwardToPlace' : 'returnToPlace');
  const details = document.getElementById(isO ? 'onwardTravelDetails' : 'returnTravelDetails');
  const pnr = document.getElementById(isO ? 'onwardPnrNo' : 'returnPnrNo');
  const depDate = document.getElementById(isO ? 'onwardTravelDate' : 'returnTravelDate');
  const depTime = document.getElementById(isO ? 'onwardDepTime' : 'returnDepTime');
  const arrDate = document.getElementById(isO ? 'onwardArrivalDate' : 'returnArrivalDate');
  const arrTime = document.getElementById(isO ? 'onwardArrTime' : 'returnArrTime');
  const amt = document.getElementById(isO ? 'onwardAmount' : 'returnAmount');
  const reimb = document.getElementById(isO ? 'onwardReimbursable' : 'returnReimbursable');

  if (modeSel) modeSel.value = 'Train';
  if (data.fromStation && fromPlace) fromPlace.value = data.fromStation;
  if (data.toStation && toPlace) toPlace.value = data.toStation;
  if (data.train && details) details.value = data.train;
  if (data.pnr && pnr) pnr.value = data.pnr;
  if (data.depDate && depDate) {
    depDate.value = data.depDate;
    updateTravelDateHint(isO ? 'onwardTravelDate' : 'returnTravelDate', isO ? 'onwardTravelDateHint' : 'returnTravelDateHint');
  }
  if (data.depTime && depTime) depTime.value = data.depTime;
  if (data.arrDate && arrDate) {
    arrDate.value = data.arrDate;
    updateTravelDateHint(isO ? 'onwardArrivalDate' : 'returnArrivalDate', isO ? 'onwardArrivalDateHint' : 'returnArrivalDateHint');
  }
  if (data.arrTime && arrTime) arrTime.value = data.arrTime;
  if (data.totalFare > 0 && amt) {
    amt.value = data.totalFare.toFixed(2);
    if (reimb) {
      reimb.disabled = false;
      reimb.checked = true;
      const reimbWrap = document.getElementById(isO ? 'onwardReimbursableWrapper' : 'returnReimbursableWrapper');
      if (reimbWrap) reimbWrap.classList.remove('disabled-opt');
    }
  }

  // Pre-fill Programme Title if title input is blank
  const titleInput = document.getElementById('schedTitle');
  if (titleInput && (!titleInput.value.trim() || titleInput.value.trim().toLowerCase() === 'travel')) {
    const fromStr = data.fromStation ? data.fromStation.split('(')[0].trim() : 'Departure';
    const toStr = data.toStation ? data.toStation.split('(')[0].trim() : 'Destination';
    titleInput.value = `${fromStr} to ${toStr} Travel (${data.train || 'Train'})`;
  }

  updateTravelReimbursableState(type);
}

function renderTravelTicketPreview(type) {
  const container = document.getElementById(type === 'onward' ? 'onwardTicketPreview' : 'returnTicketPreview');
  container.innerHTML = '';
  const att = type === 'onward' ? onwardTicketAttachment : returnTicketAttachment;
  if (!att) return;

  const pill = document.createElement('div');
  pill.className = 'travel-ticket-pill';

  if (att.type.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = att.data;
    img.title = 'Click to preview';
    img.addEventListener('click', () => {
      openAttachmentViewer(att);
    });
    pill.appendChild(img);
  } else {
    const pdfIcon = document.createElement('i');
    pdfIcon.className = 'fa-solid fa-file-pdf';
    pdfIcon.style.cursor = 'pointer';
    pdfIcon.addEventListener('click', () => {
      openAttachmentViewer(att);
    });
    pill.appendChild(pdfIcon);
  }

  const nameSpan = document.createElement('span');
  nameSpan.textContent = att.name.length > 15 ? att.name.substring(0, 12) + '...' : att.name;
  pill.appendChild(nameSpan);

  const removeBtn = document.createElement('span');
  removeBtn.className = 'remove-ticket-btn';
  removeBtn.innerHTML = '×';
  removeBtn.title = 'Remove ticket image';
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (type === 'onward') onwardTicketAttachment = null;
    else returnTicketAttachment = null;
    renderTravelTicketPreview(type);
  });
  pill.appendChild(removeBtn);

  container.appendChild(pill);
}

function updateTravelReimbursableState(type) {
  const amtInput = document.getElementById(type === 'onward' ? 'onwardAmount' : 'returnAmount');
  const chkInput = document.getElementById(type === 'onward' ? 'onwardReimbursable' : 'returnReimbursable');
  const wrapper = document.getElementById(type === 'onward' ? 'onwardReimbursableWrapper' : 'returnReimbursableWrapper');

  const amt = parseFloat(amtInput.value) || 0;
  if (amt > 0) {
    chkInput.disabled = false;
    wrapper.classList.remove('disabled-opt');
  } else {
    chkInput.checked = false;
    chkInput.disabled = true;
    wrapper.classList.add('disabled-opt');
  }
}

function updateTravelDateHint(inputId, hintId) {
  const input = document.getElementById(inputId);
  const hint = document.getElementById(hintId);
  if (!input || !hint) return;
  if (input.value) {
    hint.textContent = `📅 ${formatDateIndian(input.value)} (DD-MM-YYYY)`;
  } else {
    hint.textContent = '';
  }
}

/* ==========================================================================
   8. CLASH CHECK & SAVE SCHEDULE / BATCH GROUP / TRAVEL
   ========================================================================== */

function checkScheduleClash(dateStr, fromTime, toTime, excludeId = null, excludeGroupId = null) {
  let query = `
    SELECT id, title, from_time, to_time 
    FROM schedules 
    WHERE schedule_date = ? 
      AND id != ?
      AND title NOT LIKE 'Travel:%'
      AND title NOT LIKE 'Return Travel:%'
      AND title NOT LIKE 'Travel Arrival:%'
      AND title NOT LIKE 'Return Travel Arrival:%'
  `;
  const params = [dateStr, excludeId || ''];

  if (excludeGroupId) {
    query += ` AND (group_id IS NULL OR group_id != ?)`;
    params.push(excludeGroupId);
  }

  const stmt = db.prepare(query);
  stmt.bind(params);
  
  const clashes = [];
  while (stmt.step()) {
    const s = stmt.getAsObject();
    if (fromTime < s.to_time && s.from_time < toTime) {
      clashes.push(`${s.title} (${s.from_time} - ${s.to_time})`);
    }
  }
  stmt.free();
  return clashes;
}

async function handleScheduleFormSubmit(e) {
  e.preventDefault();

  const editId = document.getElementById('editScheduleId').value;
  const title = document.getElementById('schedTitle').value.trim();
  const fromTime = document.getElementById('schedFromTime').value;
  const toTime = document.getElementById('schedToTime').value;

  const todayStr = formatDateYMD(new Date());
  const nowTime = new Date().toTimeString().slice(0, 5);
  const deriveScheduleStatus = (schDate, schToTime) => {
    if (schDate < todayStr) return 'completed';
    if (schDate === todayStr && schToTime && schToTime <= nowTime) return 'completed';
    return 'planned';
  };
  const notes = document.getElementById('schedNotes').value.trim();
  const applyAsGroup = document.getElementById('applyAsGroupCheckbox').checked;

  // Auto-derive delivery mode & location directly from selected tags
  let deliveryMode = 'offline';
  if (activeModalSelectedTagIds.has('tag_mode_online')) {
    deliveryMode = 'online';
  } else if (activeModalSelectedTagIds.has('tag_mode_hybrid')) {
    deliveryMode = 'hybrid';
  }

  // Derive location string from Venue/Place tags
  const placeTags = tagMasterTags.filter(t => t.category_id === 'cat_place' && activeModalSelectedTagIds.has(t.id));
  const location = placeTags.map(t => t.name).join(', ');

  // Allow overnight travel/schedules spanning past midnight
  if (fromTime >= toTime) {
    const isTravelEntry = title.toLowerCase().startsWith('travel:') || document.getElementById('addOnwardTravel').checked || document.getElementById('addReturnTravel').checked;
    if (!isTravelEntry) {
      const confirmOvernight = confirm('⚠️ "From Time" is later than or equal to "To Time". Is this an overnight session spanning past midnight into the next day?\n\nClick OK to save as overnight, or Cancel to change.');
      if (!confirmOvernight) return;
    }
  }

  // Get targeted dates
  let dates = [];
  if (editId) {
    if (activeEditingGroupId && applyAsGroup) {
      // Edit entire group (excluding travel entries)
      const res = db.exec("SELECT schedule_date FROM schedules WHERE group_id = ? AND title NOT LIKE 'Travel:%' AND title NOT LIKE 'Return Travel:%' AND title NOT LIKE 'Travel Arrival:%' AND title NOT LIKE 'Return Travel Arrival:%' ORDER BY schedule_date ASC", [activeEditingGroupId]);
      dates = res.length > 0 ? res[0].values.map(v => v[0]) : [document.querySelector('#selectedDatesChips .date-chip').dataset.isoDate || document.querySelector('#selectedDatesChips .date-chip').title || document.querySelector('#selectedDatesChips .date-chip').textContent];
    } else {
      // Edit single schedule
      const chipEl = document.querySelector('#selectedDatesChips .date-chip');
      dates = [chipEl.dataset.isoDate || chipEl.title || chipEl.textContent];
    }
  } else {
    dates = selectedDates.size > 0 ? Array.from(selectedDates).sort() : [formatDateYMD(new Date())];
  }

  // Clash check (only for standard daytime schedules where fromTime < toTime)
  if (fromTime < toTime) {
    for (const d of dates) {
      const clashes = checkScheduleClash(d, fromTime, toTime, editId, activeEditingGroupId);
      if (clashes.length > 0) {
        const proceed = confirm(`⚠️ Time Clash Alert on ${formatDateIndian(d)}!\n\nThis overlaps with an existing schedule:\n- ${clashes.join('\n- ')}\n\nDo you want to proceed anyway?`);
        if (!proceed) return;
      }
    }
  }

  // Custom tag fields JSON
  const customValues = {};
  document.querySelectorAll('.custom-field-input').forEach(inp => {
    if (inp.value.trim()) customValues[inp.dataset.fieldKey] = inp.value.trim();
  });
  const customValuesJson = JSON.stringify(customValues);
  const nowIso = new Date().toISOString();

  // Structured Travel Object to persist in schedules table
  const onwardChecked = document.getElementById('addOnwardTravel').checked;
  const returnChecked = document.getElementById('addReturnTravel').checked;

  const oDate = document.getElementById('onwardTravelDate').value;
  const oArrDate = document.getElementById('onwardArrivalDate').value || oDate;
  const oMode = document.getElementById('onwardTravelMode').value;
  const oFrom = document.getElementById('onwardFromPlace').value.trim();
  const oTo = document.getElementById('onwardToPlace').value.trim();
  const oDepTime = document.getElementById('onwardDepTime').value || '20:40';
  const oArrTime = document.getElementById('onwardArrTime').value || '07:30';
  const oDetails = document.getElementById('onwardTravelDetails').value.trim();
  const oPnr = document.getElementById('onwardPnrNo').value.trim();
  const oAmt = parseFloat(document.getElementById('onwardAmount').value) || 0;
  const oReimb = oAmt > 0 && document.getElementById('onwardReimbursable').checked;

  const rDate = document.getElementById('returnTravelDate').value;
  const rArrDate = document.getElementById('returnArrivalDate').value || rDate;
  const rMode = document.getElementById('returnTravelMode').value;
  const rFrom = document.getElementById('returnFromPlace').value.trim();
  const rTo = document.getElementById('returnToPlace').value.trim();
  const rDepTime = document.getElementById('returnDepTime').value || '20:10';
  const rArrTime = document.getElementById('returnArrTime').value || '06:45';
  const rDetails = document.getElementById('returnTravelDetails').value.trim();
  const rPnr = document.getElementById('returnPnrNo').value.trim();
  const rAmt = parseFloat(document.getElementById('returnAmount').value) || 0;
  const rReimb = rAmt > 0 && document.getElementById('returnReimbursable').checked;

  // 1. Process & Decouple General Attachments (save Base64 to IndexedDB + Upload to Server, strip Base64 for SQLite)
  const cleanedAttachments = [];
  try {
    for (const att of currentModalAttachments) {
      const filename = att.filename || (att.id + '_' + (att.name ? att.name.replace(/[^a-zA-Z0-9_\-\.]/g, '_') : 'file.dat'));
      if (att.data && att.data.startsWith('data:')) {
        await saveAttachmentToIndexedDB(att.id, att.data);
        uploadAttachmentFileToServer(att.id, filename, att.data);
      }
      cleanedAttachments.push({
        id: att.id,
        name: att.name,
        type: att.type,
        size: att.size,
        filename: filename
      });
    }
  } catch (attErr) {
    console.error('Failed to save schedule attachment:', attErr);
    showToast(attErr.name === 'QuotaExceededError'
      ? '❌ Storage quota exceeded! Attachment cannot be saved. Please clear old attachments or export a backup.'
      : '❌ Failed to save attachment to local storage: ' + attErr.message, 'error', 6000);
    return;
  }
  const attachmentsJson = JSON.stringify(cleanedAttachments);

  // 2. Process & Decouple Onward Ticket Attachment
  let cleanedOnwardAtt = null;
  if (onwardChecked && onwardTicketAttachment) {
    const att = onwardTicketAttachment;
    const filename = att.filename || (att.id + '_' + (att.name ? att.name.replace(/[^a-zA-Z0-9_\-\.]/g, '_') : 'file.dat'));
    try {
      if (att.data && att.data.startsWith('data:')) {
        await saveAttachmentToIndexedDB(att.id, att.data);
        uploadAttachmentFileToServer(att.id, filename, att.data);
      }
    } catch (attErr) {
      console.error('Failed to save onward ticket attachment:', attErr);
      showToast('❌ Failed to save onward ticket attachment: ' + attErr.message, 'error', 6000);
      return;
    }
    cleanedOnwardAtt = {
      id: att.id,
      name: att.name,
      type: att.type,
      size: att.size,
      filename: filename
    };
  }

  // 3. Process & Decouple Return Ticket Attachment
  let cleanedReturnAtt = null;
  if (returnChecked && returnTicketAttachment) {
    const att = returnTicketAttachment;
    const filename = att.filename || (att.id + '_' + (att.name ? att.name.replace(/[^a-zA-Z0-9_\-\.]/g, '_') : 'file.dat'));
    try {
      if (att.data && att.data.startsWith('data:')) {
        await saveAttachmentToIndexedDB(att.id, att.data);
        uploadAttachmentFileToServer(att.id, filename, att.data);
      }
    } catch (attErr) {
      console.error('Failed to save return ticket attachment:', attErr);
      showToast('❌ Failed to save return ticket attachment: ' + attErr.message, 'error', 6000);
      return;
    }
    cleanedReturnAtt = {
      id: att.id,
      name: att.name,
      type: att.type,
      size: att.size,
      filename: filename
    };
  }

  const travelInfoObj = {
    onward: onwardChecked ? {
      enabled: true,
      mode: oMode,
      fromDate: oDate,
      depTime: oDepTime,
      toDate: oArrDate,
      arrTime: oArrTime,
      fromPlace: oFrom,
      toPlace: oTo,
      details: oDetails,
      pnr: oPnr,
      amount: oAmt,
      reimbursable: oReimb,
      attachment: cleanedOnwardAtt
    } : null,
    return: returnChecked ? {
      enabled: true,
      mode: rMode,
      fromDate: rDate,
      depTime: rDepTime,
      toDate: rArrDate,
      arrTime: rArrTime,
      fromPlace: rFrom,
      toPlace: rTo,
      details: rDetails,
      pnr: rPnr,
      amount: rAmt,
      reimbursable: rReimb,
      attachment: cleanedReturnAtt
    } : null
  };
  const travelInfoJson = (onwardChecked || returnChecked) ? JSON.stringify(travelInfoObj) : null;

  // Group ID assignment: Every schedule (single or batch) gets a groupId to bind travel entries
  let groupId = activeEditingGroupId;
  if (!groupId) {
    if (editId) {
      const gRes = db.exec("SELECT group_id FROM schedules WHERE id = ?", [editId]);
      if (gRes.length > 0 && gRes[0].values[0][0]) {
        groupId = gRes[0].values[0][0];
      } else {
        groupId = `grp_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
      }
    } else {
      groupId = `grp_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
    }
  }

  const tagList = Array.from(activeModalSelectedTagIds).map(tid => ({
    tag_id: tid,
    field_values: customValuesJson,
    notes: ''
  }));

  const schedulesToSave = [];

  if (editId && (!activeEditingGroupId || !applyAsGroup)) {
    // Single edit: query existing created_at and date
    const existingRes = db.exec("SELECT created_at, schedule_date FROM schedules WHERE id = ?", [editId]);
    const existingCreatedAt = (existingRes.length > 0 && existingRes[0].values[0][0]) || nowIso;
    const scheduleDate = (existingRes.length > 0 && existingRes[0].values[0][1]) || dates[0] || formatDateYMD(new Date());

    schedulesToSave.push({
      id: editId,
      group_id: groupId,
      schedule_date: scheduleDate,
      from_time: fromTime,
      to_time: toTime,
      delivery_mode: deliveryMode,
      location: location,
      title: title,
      notes: notes,
      attachments: attachmentsJson,
      travel_info: travelInfoJson,
      reminder_min: -1,
      status: deriveScheduleStatus(scheduleDate, toTime),
      created_at: existingCreatedAt,
      updated_at: nowIso,
      tags: tagList.map(t => ({ id: `st_${editId}_${t.tag_id}`, schedule_id: editId, tag_id: t.tag_id, field_values: t.field_values, notes: t.notes }))
    });

  } else if (editId && activeEditingGroupId && applyAsGroup) {
    // Bulk update all programme schedules in this group (excluding travel and arrival legs)
    const res = db.exec("SELECT id, schedule_date, created_at FROM schedules WHERE group_id = ? AND title NOT LIKE 'Travel:%' AND title NOT LIKE 'Return Travel:%' AND title NOT LIKE 'Travel Arrival:%' AND title NOT LIKE 'Return Travel Arrival:%'", [activeEditingGroupId]);
    if (res.length > 0) {
      res[0].values.forEach(valArr => {
        const schId = valArr[0];
        const schDate = valArr[1];
        const schCreated = valArr[2] || nowIso;
        schedulesToSave.push({
          id: schId,
          group_id: activeEditingGroupId,
          schedule_date: schDate,
          from_time: fromTime,
          to_time: toTime,
          delivery_mode: deliveryMode,
          location: location,
          title: title,
          notes: notes,
          attachments: attachmentsJson,
          travel_info: travelInfoJson,
          reminder_min: -1,
          status: deriveScheduleStatus(schDate, toTime),
          created_at: schCreated,
          updated_at: nowIso,
          tags: tagList.map(t => ({ id: `st_${schId}_${t.tag_id}`, schedule_id: schId, tag_id: t.tag_id, field_values: t.field_values, notes: t.notes }))
        });
      });
    }

  } else {
    // Create new entries for all dates
    for (const dStr of dates) {
      const newId = `sch_${dStr}_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
      schedulesToSave.push({
        id: newId,
        group_id: groupId,
        schedule_date: dStr,
        from_time: fromTime,
        to_time: toTime,
        delivery_mode: deliveryMode,
        location: location,
        title: title,
        notes: notes,
        attachments: attachmentsJson,
        travel_info: travelInfoJson,
        reminder_min: -1,
        status: deriveScheduleStatus(dStr, toTime),
        created_at: nowIso,
        updated_at: nowIso,
        tags: tagList.map(t => ({ id: `st_${newId}_${t.tag_id}`, schedule_id: newId, tag_id: t.tag_id, field_values: t.field_values, notes: t.notes }))
      });
    }
  }

  // SCHEDULE ONWARD TRAVEL (IF CHECKED)
  if (onwardChecked && oDate) {
    const isOvernight = (oArrDate && oArrDate !== oDate);
    let oTitle = `Travel: ${oFrom || 'Home'} to ${oTo || 'Venue'} (${oMode})`;
    if (oDetails) oTitle += ` - ${oDetails}`;
    if (oPnr) oTitle += ` | PNR: ${oPnr}`;
    if (isOvernight) oTitle += ` [Overnight: Dep ${formatDateIndian(oDate)} -> Arr ${formatDateIndian(oArrDate)}]`;
    
    const oNotes = [
      `Onward travel for program: ${title}`,
      `Departure: ${formatDateIndian(oDate)} at ${oDepTime} | Arrival: ${formatDateIndian(oArrDate)} at ${oArrTime}`,
      oPnr ? `PNR: ${oPnr}` : '',
      oAmt > 0 ? `Amount: ${formatINR(toPaise(oAmt))} (${oReimb ? 'Reimbursable' : 'Non-reimbursable'})` : 'Sponsored by Organizer (₹0.00)'
    ].filter(Boolean).join(' | ');

    const oAttachments = cleanedOnwardAtt ? JSON.stringify([cleanedOnwardAtt]) : '[]';
    const oId = `sch_${oDate}_travel_onward_${Date.now()}`;
    const oDepToTime = isOvernight ? '23:59' : oArrTime;

    schedulesToSave.push({
      id: oId,
      group_id: groupId,
      schedule_date: oDate,
      from_time: oDepTime,
      to_time: oDepToTime,
      delivery_mode: 'offline',
      location: `${oFrom} -> ${oTo}`,
      title: oTitle,
      notes: oNotes,
      attachments: oAttachments,
      travel_info: travelInfoJson,
      reminder_min: -1,
      status: deriveScheduleStatus(oDate, oDepTime),
      created_at: nowIso,
      updated_at: nowIso,
      tags: []
    });

    if (isOvernight) {
      const oArrId = `sch_${oArrDate}_travel_onward_arr_${Date.now()}`;
      let oArrTitle = `Travel Arrival: ${oTo || 'Venue'} from ${oFrom || 'Home'} (${oMode})`;
      if (oDetails) oArrTitle += ` - ${oDetails}`;
      if (oPnr) oArrTitle += ` | PNR: ${oPnr}`;
      const oArrNotes = `Arrival day: In-transit train arrival at ${oTo} at ${oArrTime} | Dep: ${formatDateIndian(oDate)} at ${oDepTime}`;
      
      schedulesToSave.push({
        id: oArrId,
        group_id: groupId,
        schedule_date: oArrDate,
        from_time: '00:00',
        to_time: oArrTime,
        delivery_mode: 'offline',
        location: `${oFrom} -> ${oTo}`,
        title: oArrTitle,
        notes: oArrNotes,
        attachments: oAttachments,
        travel_info: travelInfoJson,
        reminder_min: -1,
        status: deriveScheduleStatus(oArrDate, oArrTime),
        created_at: nowIso,
        updated_at: nowIso,
        tags: []
      });
    }
  }

  // SCHEDULE RETURN TRAVEL (IF CHECKED)
  if (returnChecked && rDate) {
    const isOvernight = (rArrDate && rArrDate !== rDate);
    let rTitle = `Return Travel: ${rFrom || 'Venue'} to ${rTo || 'Home'} (${rMode})`;
    if (rDetails) rTitle += ` - ${rDetails}`;
    if (rPnr) rTitle += ` | PNR: ${rPnr}`;
    if (isOvernight) rTitle += ` [Overnight: Dep ${formatDateIndian(rDate)} -> Arr ${formatDateIndian(rArrDate)}]`;

    const rNotes = [
      `Return travel from program: ${title}`,
      `Departure: ${formatDateIndian(rDate)} at ${rDepTime} | Arrival: ${formatDateIndian(rArrDate)} at ${rArrTime}`,
      rPnr ? `PNR: ${rPnr}` : '',
      rAmt > 0 ? `Amount: ${formatINR(toPaise(rAmt))} (${rReimb ? 'Reimbursable' : 'Non-reimbursable'})` : 'Sponsored by Organizer (₹0.00)'
    ].filter(Boolean).join(' | ');

    const rAttachments = cleanedReturnAtt ? JSON.stringify([cleanedReturnAtt]) : '[]';
    const rId = `sch_${rDate}_travel_return_${Date.now()}`;
    const rDepToTime = isOvernight ? '23:59' : rArrTime;

    schedulesToSave.push({
      id: rId,
      group_id: groupId,
      schedule_date: rDate,
      from_time: rDepTime,
      to_time: rDepToTime,
      delivery_mode: 'offline',
      location: `${rFrom} -> ${rTo}`,
      title: rTitle,
      notes: rNotes,
      attachments: rAttachments,
      travel_info: travelInfoJson,
      reminder_min: -1,
      status: deriveScheduleStatus(rDate, rDepToTime),
      created_at: nowIso,
      updated_at: nowIso,
      tags: []
    });

    if (isOvernight) {
      const rArrId = `sch_${rArrDate}_travel_return_arr_${Date.now()}`;
      let rArrTitle = `Return Travel Arrival: ${rTo || 'Home'} from ${rFrom || 'Venue'} (${rMode})`;
      if (rDetails) rArrTitle += ` - ${rDetails}`;
      if (rPnr) rArrTitle += ` | PNR: ${rPnr}`;
      const rArrNotes = `Arrival day: In-transit train return arrival at ${rTo} at ${rArrTime} | Dep: ${formatDateIndian(rDate)} at ${rDepTime}`;

      schedulesToSave.push({
        id: rArrId,
        group_id: groupId,
        schedule_date: rArrDate,
        from_time: '00:00',
        to_time: rArrTime,
        delivery_mode: 'offline',
        location: `${rFrom} -> ${rTo}`,
        title: rArrTitle,
        notes: rArrNotes,
        attachments: rAttachments,
        travel_info: travelInfoJson,
        reminder_min: -1,
        status: deriveScheduleStatus(rArrDate, rArrTime),
        created_at: nowIso,
        updated_at: nowIso,
        tags: []
      });
    }
  }

  // Direct Local SQLite Persistence: Atomically save schedules & tags to local database
  try {
    db.run("BEGIN TRANSACTION;");

    // 1. If editId or groupId, clean existing travel legs for this group or schedule first
    if (groupId) {
      db.run("DELETE FROM schedules WHERE group_id = ? AND (title LIKE 'Travel:%' OR title LIKE 'Return Travel:%' OR title LIKE 'Travel Arrival:%' OR title LIKE 'Return Travel Arrival:%')", [groupId]);
    } else if (editId) {
      db.run("DELETE FROM schedules WHERE id LIKE ? AND (title LIKE 'Travel:%' OR title LIKE 'Return Travel:%' OR title LIKE 'Travel Arrival:%' OR title LIKE 'Return Travel Arrival:%')", [`%${editId}%`]);
    }

    // 2. Insert or replace all schedules and tags
    for (const sch of schedulesToSave) {
      db.run(`
        INSERT OR REPLACE INTO schedules (id, group_id, schedule_date, from_time, to_time, delivery_mode, location, title, notes, attachments, travel_info, reminder_min, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [sch.id, sch.group_id, sch.schedule_date, sch.from_time, sch.to_time, sch.delivery_mode, sch.location, sch.title, sch.notes, sch.attachments, sch.travel_info, (sch.reminder_min !== undefined ? sch.reminder_min : 15), sch.status, sch.created_at, sch.updated_at]);

      // Tags
      db.run('DELETE FROM schedule_tags WHERE schedule_id = ?', [sch.id]);
      if (sch.tags && sch.tags.length > 0) {
        const stStmt = db.prepare('INSERT INTO schedule_tags (id, schedule_id, tag_id, field_values, notes) VALUES (?, ?, ?, ?, ?)');
        sch.tags.forEach(t => {
          stStmt.run([t.id, t.schedule_id, t.tag_id, t.field_values, t.notes || '']);
        });
        stStmt.free();
      }
    }

    db.run("COMMIT;");

    await saveDbToIndexedDB();
    populateTitlesDatalist();
    closeScheduleModal();
    clearDateSelection();
    renderCurrentView();
    showToast('✓ Saved directly to local database!', 'success', 3000);
  } catch(err) {
    try { db.run("ROLLBACK;"); } catch(r) {}
    console.error('Error saving schedule locally:', err);
    showToast('❌ Error saving schedule: ' + err.message, 'error', 5000);
  }
}

function addHoursToTime(hhmm, hrsToAdd) {
  try {
    const [h, m] = hhmm.split(':').map(Number);
    const newH = (h + hrsToAdd) % 24;
    return `${String(newH).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  } catch (e) {
    return '23:59';
  }
}

async function handleDeleteSchedule() {
  const editId = document.getElementById('editScheduleId').value;
  if (!editId) return;

  if (activeEditingGroupId) {
    await handleDeleteBatchGroup();
    return;
  }

  if (confirm('Delete this schedule?')) {
    await deleteSingleScheduleById(editId);
    closeScheduleModal();
  }
}

async function handleDeleteBatchGroup() {
  if (!activeEditingGroupId) return;

  if (confirm('⚠️ Are you sure you want to delete this ENTIRE batch collection of schedules? All dates in this group will be deleted.')) {
    await deleteBatchGroupById(activeEditingGroupId);
    closeScheduleModal();
  }
}

async function deleteSingleScheduleById(schId) {
  if (!schId || !db) return;
  try {
    db.run("DELETE FROM schedules WHERE id = ?", [schId]);
    db.run("DELETE FROM schedule_tags WHERE schedule_id = ?", [schId]);
    // Also remove associated travel legs if any
    db.run("DELETE FROM schedules WHERE id LIKE ? AND (title LIKE 'Travel:%' OR title LIKE 'Return Travel:%' OR title LIKE 'Travel Arrival:%' OR title LIKE 'Return Travel Arrival:%')", [`%${schId}%`]);
    await saveDbToIndexedDB();
    populateTitlesDatalist();
    renderCurrentView();
    showToast('✓ Schedule deleted from local database.', 'info', 3000);
  } catch(err) {
    console.error('Error deleting schedule:', err);
    showToast('❌ Error deleting schedule: ' + err.message, 'error', 4000);
  }
}

async function deleteBatchGroupById(grpId) {
  if (!grpId || !db) return;
  try {
    const res = db.exec("SELECT id FROM schedules WHERE group_id = ?", [grpId]);
    if (res.length > 0) {
      res[0].values.forEach(v => {
        const id = v[0];
        db.run("DELETE FROM schedule_tags WHERE schedule_id = ?", [id]);
      });
    }
    db.run("DELETE FROM schedules WHERE group_id = ?", [grpId]);
    await saveDbToIndexedDB();
    populateTitlesDatalist();
    renderCurrentView();
    showToast('✓ Entire batch group deleted from local database.', 'info', 3000);
  } catch(err) {
    console.error('Error deleting batch group:', err);
    showToast('❌ Error deleting batch group: ' + err.message, 'error', 4000);
  }
}

/* ==========================================================================
   9. TAG MASTER MODAL
   ========================================================================== */

let activeMasterCatId = null;

function openTagMasterModal() {
  loadMasterDataFromDb();
  if (tagMasterCategories.length > 0) {
    activeMasterCatId = tagMasterCategories[0].id;
  }
  renderTagMasterUI();
  document.getElementById('tagMasterModal').classList.remove('hidden');
}

function closeTagMasterModal() {
  document.getElementById('tagMasterModal').classList.add('hidden');
}

function renderTagMasterUI() {
  const catListUl = document.getElementById('categoryListUl');
  catListUl.innerHTML = '';

  tagMasterCategories.forEach(cat => {
    const li = document.createElement('li');
    li.className = 'category-item-li';
    if (cat.id === activeMasterCatId) li.classList.add('active');

    li.innerHTML = `<i class="fa-solid fa-circle" style="color:${sanitizeColor(cat.color, '#3b82f6')}; font-size:0.6rem;"></i> ${escapeHtml(cat.name)}`;
    li.addEventListener('click', () => {
      activeMasterCatId = cat.id;
      renderTagMasterUI();
    });
    catListUl.appendChild(li);
  });

  const activeCat = tagMasterCategories.find(c => c.id === activeMasterCatId);
  if (!activeCat) return;

  document.getElementById('activeCategoryHeading').textContent = `Tags in ${activeCat.name}`;

  const tagsContainer = document.getElementById('tagsListContainer');
  tagsContainer.innerHTML = '';
  const catTags = tagMasterTags.filter(t => t.category_id === activeMasterCatId);

  catTags.forEach(t => {
    const tagChip = document.createElement('div');
    tagChip.className = 'tag-selectable';
    tagChip.style.display = 'inline-flex';
    tagChip.style.alignItems = 'center';
    tagChip.style.gap = '6px';
    tagChip.innerHTML = `
      <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${sanitizeColor(t.color, '#3b82f6')};"></span>
      ${escapeHtml(t.name)}
      <i class="fa-solid fa-xmark" style="font-size:0.75rem; margin-left:4px; opacity:0.7;" title="Delete tag"></i>
    `;
    tagChip.querySelector('.fa-xmark').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`Delete tag "${t.name}"?`)) {
        if (db) {
          db.run('DELETE FROM tags WHERE id = ?', [t.id]);
          db.run('DELETE FROM schedule_tags WHERE tag_id = ?', [t.id]);
          await saveDbToIndexedDB();
        }
        loadMasterDataFromDb();
        renderTagMasterUI();
      }
    });
    tagsContainer.appendChild(tagChip);
  });

  const fieldsContainer = document.getElementById('categoryFieldsContainer');
  fieldsContainer.innerHTML = '';
  const catFields = tagMasterFields.filter(f => f.category_id === activeMasterCatId);

  catFields.forEach(f => {
    const fldBadge = document.createElement('div');
    fldBadge.className = 'tag-selectable';
    fldBadge.style.borderColor = '#38bdf8';
    fldBadge.textContent = `${f.field_label || f.name} (${f.field_type || f.type})`;
    fieldsContainer.appendChild(fldBadge);
  });
}

async function handleAddCategory() {
  const name = prompt('Enter new Category Name:');
  if (!name || !name.trim()) return;

  const color = '#' + Math.floor(Math.random()*16777215).toString(16);
  const id = 'cat_' + Date.now();
  const sortOrder = tagMasterCategories.length + 1;

  if (db) {
    db.run('INSERT INTO tag_categories (id, name, color, icon, sort_order) VALUES (?, ?, ?, ?, ?)',
           [id, name.trim(), color, 'folder', sortOrder]);
    await saveDbToIndexedDB();
  }

  loadMasterDataFromDb();
  activeMasterCatId = id;
  renderTagMasterUI();
}

async function handleAddTag() {
  if (!activeMasterCatId) return;
  const name = prompt('Enter Tag Name:');
  if (!name || !name.trim()) return;

  const color = prompt('Tag color hex:', '#3b82f6') || '#3b82f6';
  const id = 'tag_' + Date.now();

  try {
    if (db) {
      db.run('INSERT INTO tags (id, category_id, name, color, description) VALUES (?, ?, ?, ?, ?)',
             [id, activeMasterCatId, name.trim(), color, '']);
      await saveDbToIndexedDB();
    }

    loadMasterDataFromDb();
    renderTagMasterUI();
  } catch (err) {
    alert('Error adding tag: ' + err.message);
  }
}

async function handleAddField() {
  if (!activeMasterCatId) return;
  const label = prompt('Field Label:');
  if (!label || !label.trim()) return;

  const key = label.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const id = 'fld_' + Date.now();

  if (db) {
    db.run('INSERT INTO tag_field_definitions (id, tag_id, category_id, field_key, field_label, field_type) VALUES (?, null, ?, ?, ?, ?)',
           [id, activeMasterCatId, key, label.trim(), 'text']);
    await saveDbToIndexedDB();
  }

  loadMasterDataFromDb();
  renderTagMasterUI();
}

/* ==========================================================================
   10. COMMON DATABASE SYNC PROVIDERS (SERVER & GOOGLE DRIVE)
   ========================================================================== */

function initSyncProvider() {
  updateBadge('Local SQLite Active', false);
  updateServerUIStatus(true);
}

function toggleSyncSectionsUI() {}

function triggerAutoSync() {}

function updateServerUIStatus(isConnected) {
  const syncStatusText = document.getElementById('syncStatusText');
  const syncDriveIcon = document.getElementById('syncDriveIcon');
  if (syncStatusText) syncStatusText.textContent = 'Backup & Restore';
  if (syncDriveIcon) {
    syncDriveIcon.className = 'fa-solid fa-database';
    syncDriveIcon.style.color = '#38bdf8';
  }
}

function extractLocalDbPayload() {
  const payload = {
    daily_transactions: [],
    daily_notes: [],
    schedules: [],
    schedule_tags: []
  };

  if (!db) return payload;

  try {
    const tRes = db.exec("SELECT * FROM daily_transactions");
    if (tRes && tRes.length > 0) payload.daily_transactions = rowsToObjects(tRes[0]);
  } catch (e) {}

  try {
    const nRes = db.exec("SELECT * FROM daily_notes");
    if (nRes && nRes.length > 0) payload.daily_notes = rowsToObjects(nRes[0]);
  } catch (e) {}

  try {
    const sRes = db.exec("SELECT * FROM schedules");
    if (sRes && sRes.length > 0) payload.schedules = rowsToObjects(sRes[0]);
  } catch (e) {}

  try {
    const stRes = db.exec("SELECT * FROM schedule_tags");
    if (stRes && stRes.length > 0) payload.schedule_tags = rowsToObjects(stRes[0]);
  } catch (e) {}

  return payload;
}

function insertRowsDynamic(tableName, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  try {
    const sample = rows[0];
    const keys = Object.keys(sample).filter(k => k !== 'tag_data');
    if (keys.length === 0) return;

    keys.forEach(k => {
      try { db.run(`ALTER TABLE ${tableName} ADD COLUMN ${k};`); } catch(e) {}
    });

    const placeholders = keys.map(() => '?').join(', ');
    const sql = `INSERT OR REPLACE INTO ${tableName} (${keys.join(', ')}) VALUES (${placeholders})`;
    const stmt = db.prepare(sql);

    rows.forEach(r => {
      const values = keys.map(k => r[k] !== undefined ? r[k] : null);
      stmt.run(values);
    });
    stmt.free();
  } catch (err) {
    console.warn(`Error inserting rows into ${tableName}:`, err);
  }
}

function repopulateLocalDbFromJson(data) {
  if (!db || !data) return;
  
  db.run("DELETE FROM schedule_tags;");
  db.run("DELETE FROM schedules;");
  db.run("DELETE FROM tag_field_definitions;");
  db.run("DELETE FROM tags;");
  db.run("DELETE FROM tag_categories;");
  db.run("DELETE FROM daily_notes;");
  db.run("DELETE FROM daily_transactions;");

  ensureSchemaUpToDate();

  if (Array.isArray(data.tag_categories)) insertRowsDynamic('tag_categories', data.tag_categories);
  if (Array.isArray(data.tags)) insertRowsDynamic('tags', data.tags);
  if (Array.isArray(data.tag_field_definitions)) insertRowsDynamic('tag_field_definitions', data.tag_field_definitions);
  if (Array.isArray(data.schedules)) insertRowsDynamic('schedules', data.schedules);
  if (Array.isArray(data.schedule_tags)) insertRowsDynamic('schedule_tags', data.schedule_tags);
  if (Array.isArray(data.daily_notes)) insertRowsDynamic('daily_notes', data.daily_notes);
  if (Array.isArray(data.daily_transactions)) insertRowsDynamic('daily_transactions', data.daily_transactions);
}

function getLocalClientDataForSync() {
  const clientData = {
    daily_transactions: [],
    daily_notes: [],
    schedules: [],
    schedule_tags: []
  };

  if (!db) return clientData;

  try {
    const resTx = db.exec("SELECT * FROM daily_transactions");
    if (resTx && resTx.length > 0) clientData.daily_transactions = rowsToObjects(resTx[0]);

    const resNt = db.exec("SELECT * FROM daily_notes");
    if (resNt && resNt.length > 0) clientData.daily_notes = rowsToObjects(resNt[0]);

    const resSch = db.exec("SELECT * FROM schedules");
    if (resSch && resSch.length > 0) clientData.schedules = rowsToObjects(resSch[0]);

    const resSt = db.exec("SELECT * FROM schedule_tags");
    if (resSt && resSt.length > 0) clientData.schedule_tags = rowsToObjects(resSt[0]);
  } catch (e) {
    console.warn("Error collecting local client data for sync:", e);
  }

  return clientData;
}

async function syncWithServerOnLaunch(isUserTriggered = false) {
  if (isUserTriggered) {
    showToast('Local database active (IndexedDB)', 'info', 2500);
  }
}

function formatFullDateTime(ts) {
  if (!ts) return 'Not recorded';
  const d = new Date(Number(ts));
  if (isNaN(d.getTime())) return 'Invalid date';
  
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(d.getDate()).padStart(2, '0');
  const monthStr = months[d.getMonth()];
  const year = d.getFullYear();
  
  let hours = d.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12;
  const hoursStr = String(hours).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  const secs = String(d.getSeconds()).padStart(2, '0');

  return `${day}-${monthStr}-${year}, ${hoursStr}:${mins}:${secs} ${ampm}`;
}

async function openServerSyncModal() {
  const modal = document.getElementById('serverSyncModal');
  if (!modal) return;
  modal.classList.remove('hidden');

  const banner = document.getElementById('syncRecommendationBanner');
  const sCountsEl = document.getElementById('serverDbCounts');
  const sTimeEl = document.getElementById('serverDbTime');

  if (banner) {
    banner.innerHTML = '💾 <strong>Local Single-Device Database Active</strong><br>All schedules, notes, and transactions are stored locally on this device in private IndexedDB storage.';
    banner.style.background = 'rgba(16, 185, 129, 0.15)';
    banner.style.borderColor = '#10b981';
    banner.style.color = '#6ee7b7';
  }

  let localSchCount = 0;
  let localTxCount = 0;
  let localNtCount = 0;
  let localTagCount = 0;
  if (db) {
    try {
      const r0 = db.exec("SELECT COUNT(*) FROM schedules");
      if (r0.length > 0) localSchCount = r0[0].values[0][0];
      const r1 = db.exec("SELECT COUNT(*) FROM daily_transactions");
      if (r1.length > 0) localTxCount = r1[0].values[0][0];
      const r2 = db.exec("SELECT COUNT(*) FROM daily_notes");
      if (r2.length > 0) localNtCount = r2[0].values[0][0];
      const r3 = db.exec("SELECT COUNT(*) FROM tags");
      if (r3.length > 0) localTagCount = r3[0].values[0][0];
    } catch (e) {}
  }

  if (sCountsEl) {
    sCountsEl.textContent = `${localSchCount} schedules, ${localTxCount} txns, ${localNtCount} notes, ${localTagCount} tags`;
  }
  const lastMod = localStorage.getItem('srg_db_last_modified');
  if (sTimeEl) {
    sTimeEl.textContent = lastMod ? formatFullDateTime(parseInt(lastMod, 10)) : 'Just now';
  }

  await renderLocalSnapshotsList();
  await updateStorageStatsUI();

  const delAllBtn = document.getElementById('deleteAllBackupsBtn');
  if (delAllBtn) {
    delAllBtn.onclick = async () => {
      if (confirm('⚠️ Are you sure you want to clean up all old local snapshots?')) {
        await deleteAllLocalDbSnapshots();
        showToast('All local snapshots cleaned up!', 'info', 3000);
        await renderLocalSnapshotsList();
      }
    };
  }
}

async function renderLocalSnapshotsList() {
  const backupsContainer = document.getElementById('serverBackupsList');
  if (!backupsContainer) return;
  const snapshots = await listLocalDbSnapshots();
  if (snapshots.length === 0) {
    backupsContainer.innerHTML = '<div style="color:var(--text-muted); font-size:0.8rem; text-align:center; padding:10px;">No snapshots saved yet. Snapshots are auto-created during backup/restore.</div>';
    return;
  }
  backupsContainer.innerHTML = '';
  snapshots.forEach(s => {
    const div = document.createElement('div');
    div.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:var(--bg-primary); padding:8px 10px; border-radius:6px; font-size:0.8rem; border:1px solid var(--border-color);';
    const dtStr = formatFullDateTime(s.timestamp);
    const szStr = (s.size / 1024).toFixed(1) + ' KB';
    div.innerHTML = `
      <div>
        <div style="font-weight:600; color:var(--text-main); font-size:0.78rem;">${escapeHtml(s.label || s.name)}</div>
        <div style="font-size:0.72rem; color:var(--text-muted);">${dtStr} • ${szStr}</div>
      </div>
      <button class="btn-secondary btn-sm restore-snapshot-btn" data-id="${s.id}" style="padding:3px 8px; font-size:0.75rem;"><i class="fa-solid fa-rotate-left"></i> Restore</button>
    `;
    backupsContainer.appendChild(div);
  });

  backupsContainer.querySelectorAll('.restore-snapshot-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const snapId = Number(btn.dataset.id);
      if (confirm('Restore this local database snapshot? Your current unsaved state will be backed up.')) {
        await restoreLocalDbSnapshot(snapId);
      }
    });
  });
}

function closeServerSyncModal() {
  const modal = document.getElementById('serverSyncModal');
  if (modal) modal.classList.add('hidden');
}

async function purgeLocalDatabase() {
  if (!confirm("⚠️ Are you sure you want to PURGE the local database on this device?\n\nThis will wipe all locally stored schedules, notes, and transactions.")) {
    return;
  }

  try {
    // 1. Delete IndexedDB
    indexedDB.deleteDatabase('SRGCalendarDB');
    
    // 2. Clear localStorage sync keys
    localStorage.removeItem('srg_db_last_modified');

    // 3. Reset in-memory SQLite database
    db = new SQL.Database();
    ensureSchemaUpToDate();
    await saveDbToIndexedDB();

    loadMasterDataFromDb();
    populateTitlesDatalist();
    renderCurrentView();

    showToast('Local database reset to fresh clean state!', 'info', 4000);
    closeServerSyncModal();
  } catch (err) {
    showToast('Error purging local database: ' + err.message, 'error', 5000);
  }
}






/* ==========================================================================
   11. BACKUP & EXPORT
   ========================================================================== */

async function exportSqliteFile() {
  if (!db) return;
  const shouldEncrypt = confirm('🔒 Encrypt this database backup with your Security PIN (AES-256)?\n\nClick "OK" to encrypt (recommended for cloud storage or USB).\nClick "Cancel" for standard unencrypted SQLite .db file.');
  let binaryArray = db.export();
  let ext = 'db';
  if (shouldEncrypt) {
    let backup;
    try {
      backup = await requestBackupEncryptionKey();
    } catch (e) {
      showToast('❌ ' + e.message, 'error', 4500);
      return;
    }
    if (!backup) return;
    binaryArray = await encryptWithKeyAndSalt(binaryArray, backup.key, backup.salt, PBKDF2_ITERATIONS);
    ext = 'enc.db';
  }
  const blob = new Blob([binaryArray], { type: 'application/x-sqlite3' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `SRG_Calendar_${formatDateYMD(new Date())}.${ext}`;
  a.click();
  showToast(shouldEncrypt ? '🔒 Encrypted database backup downloaded!' : 'Database backup downloaded as .db file!', 'success', 3500);
}

function importSqliteFile(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async () => {
    let u8 = new Uint8Array(reader.result);
    try {
      let backupKey = null;
      let backupSalt = null;
      let backupPin = null;

      if (isEncryptedDbBytes(u8)) {
        const parsedHeader = parseEncryptedDbHeader(u8);
        if (parsedHeader && parsedHeader.version === 3) {
          throw new Error('This database file is locked with a device data key, not a PIN, so it cannot be imported. Use a backup made with Download DB or Full Backup.');
        }
        backupSalt = parsedHeader ? parsedHeader.salt : u8.slice(CRYPTO_MAGIC.length, CRYPTO_MAGIC.length + 16);
        const backupIterations = parsedHeader ? parsedHeader.iterations : PBKDF2_ITERATIONS;
        const pin = await requestPinPromptModal({
          title: 'Encrypted Database Import',
          message: 'This database backup file is encrypted with AES-256. Enter the Security PIN used to create it:',
          placeholder: 'Enter Backup PIN',
          confirmText: 'Decrypt & Import',
          iconClass: 'fa-solid fa-file-shield'
        });
        if (!pin) {
          showToast('Import cancelled: PIN required for encrypted backup.', 'warning');
          return;
        }
        backupKey = await deriveKeyFromPin(pin, backupSalt, backupIterations, false);
        u8 = await decryptDatabaseBytes(u8, backupKey, false);
        backupPin = pin;
      }

      if (!isValidSqliteBinary(u8)) {
        throw new Error('Selected file is not a valid SQLite database.');
      }

      // Safety snapshot of current database before restoring
      try {
        await saveLocalDbSnapshot('Pre-Restore SQLite Safety Backup');
      } catch(e) {}

      db = new SQL.Database(u8);
      ensureSchemaUpToDate();

      if (currentEncryptionKey && isPinConfigured()) {
        // Device already has active PIN: re-encrypt restored database with device's active key
        await saveDbToIndexedDB();
      } else if (backupPin) {
        // Fresh device setup: adopt the backup PIN, wrapping a new data key with it
        const { env, rawDek, dekKey, dekId } = await createDekEnvelope(backupPin);
        const recoveryKey = generateRecoveryKey();
        try {
          await saveKeyEnvelope(env);
          await saveRecoveryVault(rawDek, recoveryKey);
        } finally {
          rawDek.fill(0);
        }
        activateDek(dekKey, dekId);
        lsSet('srg_app_pin_configured', 'true');
        await saveDbToIndexedDB();
        isAppUnlocked = true;
        resetAutoLockTimer();
        const overlay = document.getElementById('appLockOverlay');
        if (overlay) overlay.classList.add('hidden');
        setTimeout(() => openRecoveryKitModal(recoveryKey, true), 600);
      } else {
        await saveDbToIndexedDB();
      }

      loadMasterDataFromDb();
      populateTitlesDatalist();
      renderCurrentView();
      await updateStorageStatsUI();
      showToast('✓ SQLite database restored successfully (secured with active PIN)!', 'success', 4000);
    } catch (err) {
      showToast('Error parsing SQLite backup file: ' + err.message, 'error', 5000);
    }
  };
  reader.readAsArrayBuffer(file);
}

/* ==========================================================================
   12. EVENT LISTENERS SETUP
   ========================================================================== */

function setupUIEventListeners() {
  // Ensure side drawer starts closed
  closeSideMenu();

  // Side Menu Navigation Drawer Controls
  const sideMenuToggleBtn = document.getElementById('sideMenuToggleBtn');
  if (sideMenuToggleBtn) {
    sideMenuToggleBtn.addEventListener('click', toggleSideMenu);
  }
  const closeSideMenuBtn = document.getElementById('closeSideMenuBtn');
  if (closeSideMenuBtn) {
    closeSideMenuBtn.addEventListener('click', closeSideMenu);
  }
  const sideMenuBackdrop = document.getElementById('sideMenuBackdrop');
  if (sideMenuBackdrop) {
    sideMenuBackdrop.addEventListener('click', closeSideMenu);
  }

  // In-App Install & Update Buttons
  const headerInstallUpdateBtn = document.getElementById('headerInstallUpdateBtn');
  if (headerInstallUpdateBtn) {
    headerInstallUpdateBtn.addEventListener('click', handleInstallOrUpdateClick);
  }
  const drawerInstallUpdateBtn = document.getElementById('drawerInstallUpdateBtn');
  if (drawerInstallUpdateBtn) {
    drawerInstallUpdateBtn.addEventListener('click', () => {
      closeSideMenu();
      handleInstallOrUpdateClick();
    });
  }

  // Drawer View Switchers
  document.querySelectorAll('[data-drawer-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.getAttribute('data-drawer-view');
      switchToView(view);
      closeSideMenu();
    });
  });

  // Drawer Quick Daily Tools
  const drawerNoteBtn = document.getElementById('drawerNoteBtn');
  if (drawerNoteBtn) {
    drawerNoteBtn.addEventListener('click', () => {
      closeSideMenu();
      openDailyNoteModal(formatDateYMD(currentDate));
    });
  }
  const drawerFinanceBtn = document.getElementById('drawerFinanceBtn');
  if (drawerFinanceBtn) {
    drawerFinanceBtn.addEventListener('click', () => {
      closeSideMenu();
      openDailyFinanceModal(formatDateYMD(currentDate));
    });
  }

  // Drawer Reports & Data
  const drawerReportsBtn = document.getElementById('drawerReportsBtn');
  if (drawerReportsBtn) {
    drawerReportsBtn.addEventListener('click', () => {
      closeSideMenu();
      openReportsModal();
    });
  }
  const drawerPrintBtn = document.getElementById('drawerPrintBtn');
  if (drawerPrintBtn) {
    drawerPrintBtn.addEventListener('click', () => {
      closeSideMenu();
      openPrintMonthModal();
    });
  }
  const drawerBackupBtn = document.getElementById('drawerBackupBtn');
  if (drawerBackupBtn) {
    drawerBackupBtn.addEventListener('click', () => {
      closeSideMenu();
      openServerSyncModal();
    });
  }
  const drawerAccountsBtn = document.getElementById('drawerAccountsBtn');
  if (drawerAccountsBtn) {
    drawerAccountsBtn.addEventListener('click', () => {
      closeSideMenu();
      openChartOfAccountsModal();
    });
  }
  const drawerTagsBtn = document.getElementById('drawerTagsBtn');
  if (drawerTagsBtn) {
    drawerTagsBtn.addEventListener('click', () => {
      closeSideMenu();
      openTagMasterModal();
    });
  }

  // Drawer Settings & Security
  const drawerThemeBtn = document.getElementById('drawerThemeBtn');
  if (drawerThemeBtn) {
    drawerThemeBtn.addEventListener('click', () => {
      toggleAppTheme();
    });
  }
  const drawerChangePinBtn = document.getElementById('drawerChangePinBtn');
  if (drawerChangePinBtn) {
    drawerChangePinBtn.addEventListener('click', () => {
      closeSideMenu();
      openChangePinModal();
    });
  }
  const drawerRecoveryKeyBtn = document.getElementById('drawerRecoveryKeyBtn');
  if (drawerRecoveryKeyBtn) {
    drawerRecoveryKeyBtn.addEventListener('click', async () => {
      closeSideMenu();
      if (!isPinConfigured()) {
        showToast('Please set up a Security PIN first to enable encryption and recovery.', 'warning', 4000);
        return;
      }
      const enteredPin = await requestPinPromptModal({
        title: 'Emergency Recovery Key',
        message: 'To view or generate a fresh Emergency Recovery Key, enter your Security PIN:',
        placeholder: 'Enter Security PIN',
        confirmText: 'Verify PIN',
        iconClass: 'fa-solid fa-life-ring'
      });
      if (!enteredPin || !enteredPin.trim()) return;
      const env = await loadKeyEnvelope();
      if (env) {
        // The new vault wraps the same data key; the previous recovery key stops working once replaced.
        let rawDek;
        try {
          rawDek = await unwrapDekWithPin(env, enteredPin);
        } catch (e) {
          showToast('❌ Incorrect Security PIN. Access denied.', 'error', 3500);
          return;
        }
        try {
          const freshKey = generateRecoveryKey();
          await saveRecoveryVault(rawDek, freshKey);
          openRecoveryKitModal(freshKey);
        } catch (vaultErr) {
          console.error('Failed to save recovery vault:', vaultErr);
          showToast('❌ Failed to save recovery vault: ' + vaultErr.message, 'error', 4500);
        } finally {
          rawDek.fill(0);
        }
        return;
      }
      const salt = getStoredCryptoSalt();
      if (!salt) {
        showToast('Security configuration missing. Please reload.', 'error');
        return;
      }
      const valid = await verifyPinWithAuthToken(enteredPin.trim());
      if (!valid) {
        showToast('❌ Incorrect Security PIN. Access denied.', 'error', 3500);
        return;
      }
      const bytesToInspect = cachedEncryptedDbBytes || await loadDbFromIndexedDB();
      const parsed = bytesToInspect && isEncryptedDbBytes(bytesToInspect) ? parseEncryptedDbHeader(bytesToInspect) : null;
      if (!parsed) {
        showToast('Could not read the database encryption header. Please reload and try again.', 'error', 4500);
        return;
      }
      // The vault must wrap the key that actually encrypts the database, derived from the file's own header.
      const rawBits = await deriveRawKeyBitsFromPin(enteredPin.trim(), parsed.salt, parsed.iterations);
      try {
        const testKey = await importRuntimeAesGcmKey(new Uint8Array(rawBits));
        const testBytes = await decryptDatabaseBytes(bytesToInspect, testKey, false);
        if (!isValidSqliteBinary(testBytes)) throw new Error('mismatch');
      } catch (mismatchErr) {
        rawBits.fill(0);
        showToast('Your PIN and the database key are out of sync. Use "Change Security PIN" (you may re-enter the same PIN as the new one) to re-secure your data, then create the recovery key.', 'warning', 9000);
        return;
      }
      try {
        const freshKey = generateRecoveryKey();
        await saveRecoveryVault(rawBits, freshKey);
        rawBits.fill(0);
        openRecoveryKitModal(freshKey);
      } catch (vaultErr) {
        console.error('Failed to save recovery vault:', vaultErr);
        showToast('❌ Failed to save recovery vault: ' + vaultErr.message, 'error', 4500);
      }
    });
  }
  const drawerBiometricBtn = document.getElementById('drawerBiometricBtn');
  if (drawerBiometricBtn) {
    drawerBiometricBtn.addEventListener('click', async () => {
      closeSideMenu();
      await toggleBiometricSetting();
    });
  }
  const drawerLockBtn = document.getElementById('drawerLockBtn');
  if (drawerLockBtn) {
    drawerLockBtn.addEventListener('click', () => {
      closeSideMenu();
      lockAppSecurity();
    });
  }
  const purgeAppCaches = () => {
    if (confirm('This will purge browser caches and reload the latest version of Calendar App. Continue?')) {
      if ('caches' in window) {
        caches.keys().then(names => {
          Promise.all(names.map(name => caches.delete(name))).then(() => {
            location.reload(true);
          });
        });
      } else {
        location.reload(true);
      }
    }
  };

  const drawerResetCacheBtn = document.getElementById('drawerResetCacheBtn');
  if (drawerResetCacheBtn) {
    drawerResetCacheBtn.addEventListener('click', () => {
      closeSideMenu();
      purgeAppCaches();
    });
  }
  const drawerDiagnosticsBtn = document.getElementById('drawerDiagnosticsBtn');
  if (drawerDiagnosticsBtn) {
    drawerDiagnosticsBtn.addEventListener('click', () => {
      closeSideMenu();
      openDiagnosticsModal(false);
    });
  }
  const diagRunCheckBtn = document.getElementById('diagRunCheckBtn');
  if (diagRunCheckBtn) diagRunCheckBtn.addEventListener('click', () => openDiagnosticsModal(true));
  const diagCopyBtn = document.getElementById('diagCopyBtn');
  if (diagCopyBtn) diagCopyBtn.addEventListener('click', copyDiagnosticsReport);
  const closeDiagnosticsBtn = document.getElementById('closeDiagnosticsModalBtn');
  if (closeDiagnosticsBtn) closeDiagnosticsBtn.addEventListener('click', () => document.getElementById('diagnosticsModal').classList.add('hidden'));
  const drawerAboutBtn = document.getElementById('drawerAboutBtn');
  if (drawerAboutBtn) {
    drawerAboutBtn.addEventListener('click', () => {
      closeSideMenu();
      openAboutModal();
    });
  }

  document.getElementById('prevBtn').addEventListener('click', () => {
    if (currentView === 'day') {
      currentDate.setDate(currentDate.getDate() - 1);
    } else {
      currentDate.setMonth(currentDate.getMonth() - 1);
    }
    renderCurrentView();
  });

  document.getElementById('nextBtn').addEventListener('click', () => {
    if (currentView === 'day') {
      currentDate.setDate(currentDate.getDate() + 1);
    } else {
      currentDate.setMonth(currentDate.getMonth() + 1);
    }
    renderCurrentView();
  });

  document.getElementById('todayBtn').addEventListener('click', () => {
    currentDate = new Date();
    renderCurrentView();
  });

  // Day View specific jump controls
  const dayPickerInput = document.getElementById('dayViewDatePicker');
  if (dayPickerInput) {
    dayPickerInput.addEventListener('change', (e) => {
      const selectedVal = e.target.value;
      if (selectedVal) {
        const [y, m, d] = selectedVal.split('-').map(Number);
        currentDate = new Date(y, m - 1, d);
        renderCurrentView();
      }
    });
  }

  const dayTodayBtn = document.getElementById('dayViewTodayBtn');
  if (dayTodayBtn) {
    dayTodayBtn.addEventListener('click', () => {
      currentDate = new Date();
      renderCurrentView();
    });
  }

  // Print Monthly Calendar Controls
  const printCalendarBtn = document.getElementById('printCalendarBtn');
  if (printCalendarBtn) {
    printCalendarBtn.addEventListener('click', openPrintMonthModal);
  }
  const closePrintMonthModalBtn = document.getElementById('closePrintMonthModalBtn');
  if (closePrintMonthModalBtn) {
    closePrintMonthModalBtn.addEventListener('click', closePrintMonthModal);
  }
  const printGridBtn = document.getElementById('printGridBtn');
  if (printGridBtn) {
    printGridBtn.addEventListener('click', () => {
      closePrintMonthModal();
      printMonthCalendar('grid');
    });
  }
  const printTableBtn = document.getElementById('printTableBtn');
  if (printTableBtn) {
    printTableBtn.addEventListener('click', () => {
      closePrintMonthModal();
      printMonthCalendar('table');
    });
  }

  // Theme Switcher, Reset Cache & Security Lock buttons
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      toggleAppTheme();
    });
  }

  const resetCacheBtn = document.getElementById('resetCacheBtn');
  if (resetCacheBtn) {
    resetCacheBtn.addEventListener('click', purgeAppCaches);
  }

  const lockAppBtn = document.getElementById('lockAppBtn');
  if (lockAppBtn) {
    lockAppBtn.addEventListener('click', lockAppSecurity);
  }

  // About Modal Event Listeners
  const openAboutBtn = document.getElementById('openAboutBtn');
  if (openAboutBtn) {
    openAboutBtn.addEventListener('click', openAboutModal);
  }

  const closeAboutModalBtn = document.getElementById('closeAboutModalBtn');
  if (closeAboutModalBtn) {
    closeAboutModalBtn.addEventListener('click', closeAboutModal);
  }

  const closeAboutModalOkBtn = document.getElementById('closeAboutModalOkBtn');
  if (closeAboutModalOkBtn) {
    closeAboutModalOkBtn.addEventListener('click', closeAboutModal);
  }

  const aboutModal = document.getElementById('aboutModal');
  if (aboutModal) {
    aboutModal.addEventListener('click', (e) => {
      if (e.target === aboutModal) {
        closeAboutModal();
      }
    });
  }

  // Change PIN Modal Event Listeners
  const openChangePinBtn = document.getElementById('openChangePinBtn');
  if (openChangePinBtn) {
    openChangePinBtn.addEventListener('click', openChangePinModal);
  }

  const openChangePinFromSyncBtn = document.getElementById('openChangePinFromSyncBtn');
  if (openChangePinFromSyncBtn) {
    openChangePinFromSyncBtn.addEventListener('click', () => {
      closeServerSyncModal();
      openChangePinModal();
    });
  }

  const closeChangePinModalBtn = document.getElementById('closeChangePinModalBtn');
  if (closeChangePinModalBtn) {
    closeChangePinModalBtn.addEventListener('click', closeChangePinModal);
  }

  const cancelChangePinBtn = document.getElementById('cancelChangePinBtn');
  if (cancelChangePinBtn) {
    cancelChangePinBtn.addEventListener('click', closeChangePinModal);
  }

  const changePinForm = document.getElementById('changePinForm');
  if (changePinForm) {
    changePinForm.addEventListener('submit', handleChangePinSubmit);
  }

  const changePinModal = document.getElementById('changePinModal');
  if (changePinModal) {
    changePinModal.addEventListener('click', (e) => {
      if (e.target === changePinModal) {
        closeChangePinModal();
      }
    });
  }

  // App Lock & Biometrics
  const setupPinForm = document.getElementById('appSetupPinForm');
  if (setupPinForm) {
    setupPinForm.addEventListener('submit', handleSetupPinSubmit);
  }

  const unlockForm = document.getElementById('appUnlockForm');
  if (unlockForm) {
    unlockForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const enteredKey = document.getElementById('appLockKeyInput').value;
      unlockAppWithKey(enteredKey);
    });
  }

  const biometricUnlockBtn = document.getElementById('biometricUnlockBtn');
  if (biometricUnlockBtn) {
    biometricUnlockBtn.addEventListener('click', () => {
      unlockAppWithBiometric(false);
    });
  }

  const biometricHeroBox = document.getElementById('biometricHeroBox');
  if (biometricHeroBox) {
    biometricHeroBox.addEventListener('click', () => {
      unlockAppWithBiometric(false);
    });
    biometricHeroBox.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        unlockAppWithBiometric(false);
      }
    });
  }

  const appLockUnlockContainer = document.getElementById('appLockUnlockContainer');
  if (appLockUnlockContainer) {
    appLockUnlockContainer.addEventListener('click', (e) => {
      if (e.target.closest('#appUnlockForm') || e.target.closest('#forgotPinBtn') || e.target.closest('#enableBiometricBtn')) {
        return;
      }
      if (localStorage.getItem('srg_biometric_enabled') === 'true') {
        unlockAppWithBiometric(false);
      }
    });
  }

  const enableBiometricBtn = document.getElementById('enableBiometricBtn');
  if (enableBiometricBtn) {
    enableBiometricBtn.addEventListener('click', () => {
      registerBiometricCredential();
    });
  }

  // Forgot PIN / Password Recovery Controls
  const forgotPinBtn = document.getElementById('forgotPinBtn');
  if (forgotPinBtn) {
    forgotPinBtn.addEventListener('click', openForgotPinModal);
  }

  const cancelForgotPinBtn = document.getElementById('cancelForgotPinBtn');
  if (cancelForgotPinBtn) {
    cancelForgotPinBtn.addEventListener('click', closeForgotPinModal);
  }

  const forgotPinResetForm = document.getElementById('forgotPinResetForm');
  if (forgotPinResetForm) {
    forgotPinResetForm.addEventListener('submit', handleForgotPinResetSubmit);
  }

  const forgotPinModal = document.getElementById('forgotPinModal');
  if (forgotPinModal) {
    forgotPinModal.addEventListener('click', (e) => {
      if (e.target === forgotPinModal) closeForgotPinModal();
    });
  }

  // Emergency Recovery Kit Modal Controls
  const closeRecoveryKitBtn = document.getElementById('closeRecoveryKitBtn');
  if (closeRecoveryKitBtn) {
    closeRecoveryKitBtn.addEventListener('click', closeRecoveryKitModal);
  }

  const copyRecoveryKeyBtn = document.getElementById('copyRecoveryKeyBtn');
  if (copyRecoveryKeyBtn) {
    copyRecoveryKeyBtn.addEventListener('click', copyRecoveryKeyToClipboard);
  }

  const downloadRecoveryKeyBtn = document.getElementById('downloadRecoveryKeyBtn');
  if (downloadRecoveryKeyBtn) {
    downloadRecoveryKeyBtn.addEventListener('click', downloadRecoveryKeyFile);
  }

  const emailRecoveryKeyBtn = document.getElementById('emailRecoveryKeyBtn');
  if (emailRecoveryKeyBtn) {
    emailRecoveryKeyBtn.addEventListener('click', emailRecoveryKey);
  }

  const recoveryKitModal = document.getElementById('recoveryKitModal');
  if (recoveryKitModal) {
    recoveryKitModal.addEventListener('click', (e) => {
      if (e.target === recoveryKitModal) closeRecoveryKitModal();
    });
  }

  // Secure PIN Prompt Modal Controls
  const securePinPromptForm = document.getElementById('securePinPromptForm');
  if (securePinPromptForm) {
    securePinPromptForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = (document.getElementById('securePinPromptInput')?.value || '').trim();
      closeSecurePinPromptModal(val || null);
    });
  }

  const cancelSecurePinPromptBtn = document.getElementById('cancelSecurePinPromptBtn');
  if (cancelSecurePinPromptBtn) {
    cancelSecurePinPromptBtn.addEventListener('click', () => {
      closeSecurePinPromptModal(null);
    });
  }

  const securePinPromptToggleVisibility = document.getElementById('securePinPromptToggleVisibility');
  if (securePinPromptToggleVisibility) {
    securePinPromptToggleVisibility.addEventListener('click', () => {
      const inputEl = document.getElementById('securePinPromptInput');
      if (!inputEl) return;
      const isPassword = inputEl.type === 'password';
      inputEl.type = isPassword ? 'text' : 'password';
      securePinPromptToggleVisibility.innerHTML = isPassword
        ? '<i class="fa-solid fa-eye-slash"></i>'
        : '<i class="fa-solid fa-eye"></i>';
    });
  }

  const securePinPromptModal = document.getElementById('securePinPromptModal');
  if (securePinPromptModal) {
    securePinPromptModal.addEventListener('click', (e) => {
      if (e.target === securePinPromptModal) closeSecurePinPromptModal(null);
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('securePinPromptModal');
      if (modal && !modal.classList.contains('hidden')) {
        closeSecurePinPromptModal(null);
      }
    }
  });

  // Header Note & Finance Buttons
  const headerNoteBtn = document.getElementById('headerNoteBtn');
  if (headerNoteBtn) {
    headerNoteBtn.addEventListener('click', () => {
      openDailyNoteModal(formatDateYMD(currentDate));
    });
  }

  const headerFinanceBtn = document.getElementById('headerFinanceBtn');
  if (headerFinanceBtn) {
    headerFinanceBtn.addEventListener('click', () => {
      openDailyFinanceModal(formatDateYMD(currentDate));
    });
  }

  // Day View Note & Finance Buttons
  const dayViewNoteBtn = document.getElementById('dayViewNoteBtn');
  if (dayViewNoteBtn) {
    dayViewNoteBtn.addEventListener('click', () => {
      openDailyNoteModal(formatDateYMD(currentDate));
    });
  }

  const dayViewFinanceBtn = document.getElementById('dayViewFinanceBtn');
  if (dayViewFinanceBtn) {
    dayViewFinanceBtn.addEventListener('click', () => {
      openDailyFinanceModal(formatDateYMD(currentDate));
    });
  }

  // Daily Note Modal Controls
  const closeDailyNoteModalBtn = document.getElementById('closeDailyNoteModalBtn');
  if (closeDailyNoteModalBtn) {
    closeDailyNoteModalBtn.addEventListener('click', closeDailyNoteModal);
  }
  const cancelDailyNoteBtn = document.getElementById('cancelDailyNoteBtn');
  if (cancelDailyNoteBtn) {
    cancelDailyNoteBtn.addEventListener('click', closeDailyNoteModal);
  }
  const saveDailyNoteBtn = document.getElementById('saveDailyNoteBtn');
  if (saveDailyNoteBtn) {
    saveDailyNoteBtn.addEventListener('click', async () => {
      const dateStr = document.getElementById('dailyNoteDateInput').value;
      const content = document.getElementById('dailyNoteTextInput').value;
      await saveDailyNote(dateStr, content);
      closeDailyNoteModal();
    });
  }
  const deleteDailyNoteBtn = document.getElementById('deleteDailyNoteBtn');
  if (deleteDailyNoteBtn) {
    deleteDailyNoteBtn.addEventListener('click', async () => {
      const dateStr = document.getElementById('dailyNoteDateInput').value;
      if (confirm('Are you sure you want to delete this daily note?')) {
        await deleteDailyNote(dateStr);
        closeDailyNoteModal();
      }
    });
  }

  // Attachment Viewer Modal Controls
  const closeAttachmentViewerBtn = document.getElementById('closeAttachmentViewerBtn');
  if (closeAttachmentViewerBtn) {
    closeAttachmentViewerBtn.addEventListener('click', closeAttachmentViewer);
  }

  // Daily Finance Modal Controls
  const closeDailyFinanceModalBtn = document.getElementById('closeDailyFinanceModalBtn');
  if (closeDailyFinanceModalBtn) {
    closeDailyFinanceModalBtn.addEventListener('click', closeDailyFinanceModal);
  }
  const resetFinanceFormBtn = document.getElementById('resetFinanceFormBtn');
  if (resetFinanceFormBtn) {
    resetFinanceFormBtn.addEventListener('click', resetFinanceForm);
  }
  const financeForm = document.getElementById('financeTxnForm');
  if (financeForm) {
    financeForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const txnData = {
        id: document.getElementById('financeTxnId').value,
        txn_date: document.getElementById('financeTxnDate').value,
        type: document.getElementById('financeType').value,
        amount: document.getElementById('financeAmount').value,
        debit_account: document.getElementById('financeDebitAccount').value,
        credit_account: document.getElementById('financeCreditAccount').value,
        description: document.getElementById('financeDescription').value
      };
      if (await saveDailyTransaction(txnData)) resetFinanceForm();
    });
  }

  // Chart of accounts: voucher hint, inline quick-add, manager modal
  const financeTypeSel = document.getElementById('financeType');
  if (financeTypeSel) financeTypeSel.addEventListener('change', updateFinanceTypeHint);
  ['financeDebitAccount', 'financeCreditAccount'].forEach(id => {
    const sel = document.getElementById(id);
    if (sel) sel.addEventListener('change', () => {
      if (sel.value === NEW_ACCOUNT_OPTION) openFinanceNewAccountPanel(id);
    });
  });
  const financeNewAccountSaveBtn = document.getElementById('financeNewAccountSaveBtn');
  if (financeNewAccountSaveBtn) financeNewAccountSaveBtn.addEventListener('click', submitFinanceNewAccount);
  const financeNewAccountCancelBtn = document.getElementById('financeNewAccountCancelBtn');
  if (financeNewAccountCancelBtn) financeNewAccountCancelBtn.addEventListener('click', () => closeFinanceNewAccountPanel(true));
  const financeNewAccountName = document.getElementById('financeNewAccountName');
  if (financeNewAccountName) financeNewAccountName.addEventListener('keydown', e => {
    // Enter here must add the account, not submit the transaction form.
    if (e.key === 'Enter') { e.preventDefault(); submitFinanceNewAccount(); }
  });
  const financeManageAccountsBtn = document.getElementById('financeManageAccountsBtn');
  if (financeManageAccountsBtn) financeManageAccountsBtn.addEventListener('click', openChartOfAccountsModal);
  const closeCoaBtn = document.getElementById('closeChartOfAccountsModalBtn');
  if (closeCoaBtn) closeCoaBtn.addEventListener('click', closeChartOfAccountsModal);
  const coaAddForm = document.getElementById('coaAddForm');
  if (coaAddForm) coaAddForm.addEventListener('submit', submitChartOfAccountsAdd);
  const coaSearchInput = document.getElementById('coaSearchInput');
  if (coaSearchInput) coaSearchInput.addEventListener('input', renderChartOfAccounts);
  document.addEventListener('keydown', (e) => {
    const coaModal = document.getElementById('chartOfAccountsModal');
    if (e.key === 'Escape' && coaModal && !coaModal.classList.contains('hidden')) closeChartOfAccountsModal();
  });

  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchToView(btn.dataset.view);
    });
  });

  document.getElementById('clearSelectionBtn').addEventListener('click', clearDateSelection);
  document.getElementById('applyBulkTagsBtn').addEventListener('click', () => {
    openScheduleModal();
  });

  document.getElementById('agendaSearchInput').addEventListener('input', renderAgendaView);
  document.getElementById('modeFilter').addEventListener('change', renderAgendaView);
  const tagFilterBtn = document.getElementById('agendaTagFilterBtn');
  const tagFilterDropdown = document.getElementById('agendaTagFilterDropdown');
  const tagClearBtn = document.getElementById('agendaTagClearBtn');
  const tagDoneBtn = document.getElementById('agendaTagDoneBtn');

  if (tagFilterBtn && tagFilterDropdown) {
    tagFilterBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      tagFilterDropdown.classList.toggle('hidden');
    });

    if (tagClearBtn) {
      tagClearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedAgendaTagIds.clear();
        updateAgendaTagFilterLabel();
        renderAgendaTagFilterDropdown();
        renderAgendaActiveTagsBar();
        renderAgendaView();
      });
    }

    if (tagDoneBtn) {
      tagDoneBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        tagFilterDropdown.classList.add('hidden');
      });
    }

    document.addEventListener('click', (e) => {
      const wrapper = document.getElementById('tagFilterDropdownWrapper');
      if (wrapper && !wrapper.contains(e.target)) {
        tagFilterDropdown.classList.add('hidden');
      }
    });
  }
  const agendaTodayBtn = document.getElementById('agendaTodayBtn');
  if (agendaTodayBtn) {
    agendaTodayBtn.addEventListener('click', () => {
      currentDate = new Date();
      renderAgendaView(true);
    });
  }

  // Modal events
  document.getElementById('closeScheduleModalBtn').addEventListener('click', closeScheduleModal);
  document.getElementById('cancelScheduleBtn').addEventListener('click', closeScheduleModal);
  document.getElementById('scheduleForm').addEventListener('submit', handleScheduleFormSubmit);
  document.getElementById('deleteScheduleBtn').addEventListener('click', handleDeleteSchedule);
  document.getElementById('deleteGroupBtn').addEventListener('click', handleDeleteBatchGroup);

  // Travel transit section toggle
  document.getElementById('toggleTravelTransitHeader').addEventListener('click', () => {
    const body = document.getElementById('travelTransitBody');
    body.classList.toggle('hidden');
    const icon = document.querySelector('#toggleTravelSectionBtn i');
    icon.classList.toggle('fa-chevron-down', body.classList.contains('hidden'));
    icon.classList.toggle('fa-chevron-up', !body.classList.contains('hidden'));
  });

  // Onward / Return travel check boxes toggle
  document.getElementById('addOnwardTravel').addEventListener('change', (e) => {
    document.getElementById('onwardTravelFields').classList.toggle('hidden', !e.target.checked);
  });
  document.getElementById('addReturnTravel').addEventListener('change', (e) => {
    document.getElementById('returnTravelFields').classList.toggle('hidden', !e.target.checked);
  });

  // Attachment input for general documents
  document.getElementById('ticketFileInput').addEventListener('change', handleAttachmentUpload);

  // Dedicated Travel Ticket Attachments
  document.getElementById('onwardTicketFileInput').addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      handleTravelTicketUpload('onward', e.target.files[0]);
    }
  });
  document.getElementById('returnTicketFileInput').addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      handleTravelTicketUpload('return', e.target.files[0]);
    }
  });

  // Ticket Amount Change -> Toggle Reimbursable Checkbox
  document.getElementById('onwardAmount').addEventListener('input', () => updateTravelReimbursableState('onward'));
  document.getElementById('returnAmount').addEventListener('input', () => updateTravelReimbursableState('return'));

  // Travel Date input changes -> update Indian date format hints
  ['input', 'change'].forEach(evt => {
    document.getElementById('onwardTravelDate').addEventListener(evt, () => updateTravelDateHint('onwardTravelDate', 'onwardTravelDateHint'));
    document.getElementById('onwardArrivalDate').addEventListener(evt, () => updateTravelDateHint('onwardArrivalDate', 'onwardArrivalDateHint'));
    document.getElementById('returnTravelDate').addEventListener(evt, () => updateTravelDateHint('returnTravelDate', 'returnTravelDateHint'));
    document.getElementById('returnArrivalDate').addEventListener(evt, () => updateTravelDateHint('returnArrivalDate', 'returnArrivalDateHint'));
  });

  // Tag master events
  document.getElementById('openTagMasterBtn').addEventListener('click', openTagMasterModal);
  document.getElementById('closeTagMasterBtn').addEventListener('click', closeTagMasterModal);
  document.getElementById('addCategoryBtn').addEventListener('click', handleAddCategory);
  document.getElementById('addTagBtn').addEventListener('click', handleAddTag);
  document.getElementById('addFieldBtn').addEventListener('click', handleAddField);

  // Settings & Backup Modal events
  const openSettingsBtn = document.getElementById('openSettingsBtn');
  if (openSettingsBtn) {
    openSettingsBtn.addEventListener('click', openServerSyncModal);
  }

  // Backup & Restore Header Button
  const syncDriveBtn = document.getElementById('syncDriveBtn');
  if (syncDriveBtn) {
    syncDriveBtn.addEventListener('click', openServerSyncModal);
  }

  const closeServerSyncModalBtn = document.getElementById('closeServerSyncModalBtn');
  if (closeServerSyncModalBtn) {
    closeServerSyncModalBtn.addEventListener('click', closeServerSyncModal);
  }

  // 1-Click Complete Backup (Database + Attachments)
  const downloadFullBackupBtn = document.getElementById('downloadFullBackupBtn');
  if (downloadFullBackupBtn) {
    downloadFullBackupBtn.addEventListener('click', exportFullBackupZip);
  }
  const uploadFullBackupBtn = document.getElementById('uploadFullBackupBtn');
  const restoreFullBackupInput = document.getElementById('restoreFullBackupInput');
  if (uploadFullBackupBtn && restoreFullBackupInput) {
    uploadFullBackupBtn.addEventListener('click', () => restoreFullBackupInput.click());
    restoreFullBackupInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        await importFullBackupZip(file);
      } finally {
        restoreFullBackupInput.value = '';
      }
    });
  }

  // Storage Management & Orphan Cleanup
  const purgeOrphansBtn = document.getElementById('purgeOrphansBtn');
  if (purgeOrphansBtn) {
    purgeOrphansBtn.addEventListener('click', purgeOrphanAttachments);
  }

  // Advanced: Individual SQLite Database (.db) Backup & Restore
  const downloadBackupBtn = document.getElementById('downloadBackupBtn');
  if (downloadBackupBtn) {
    downloadBackupBtn.addEventListener('click', exportSqliteFile);
  }

  const purgeLocalDbBtn = document.getElementById('purgeLocalDbBtn');
  if (purgeLocalDbBtn) {
    purgeLocalDbBtn.addEventListener('click', purgeLocalDatabase);
  }

  const uploadRestoreBtn = document.getElementById('uploadRestoreBtn');
  const restoreFileInput = document.getElementById('restoreFileInput');
  if (uploadRestoreBtn && restoreFileInput) {
    uploadRestoreBtn.addEventListener('click', () => restoreFileInput.click());
    restoreFileInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      if (!confirm(`⚠️ Are you sure you want to restore "${file.name}"?\n\nA safety snapshot of your current local database will be saved before restoring.`)) {
        restoreFileInput.value = '';
        return;
      }

      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const u8 = new Uint8Array(reader.result);
          if (!isValidSqliteBinary(u8)) {
            throw new Error('Selected file is not a valid SQLite database.');
          }

          await saveLocalDbSnapshot('Pre-restore Safety Backup');

          db = new SQL.Database(u8);
          ensureSchemaUpToDate();
          await saveDbToIndexedDB();

          loadMasterDataFromDb();
          populateTitlesDatalist();
          renderCurrentView();
          closeServerSyncModal();
          showToast(`✓ Database successfully restored from ${file.name}!`, 'success', 5000);
        } catch (err) {
          console.error('Error restoring database:', err);
          showToast('❌ Error restoring database: ' + err.message, 'error', 5000);
        } finally {
          restoreFileInput.value = '';
        }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  // Advanced: Individual Attachments ZIP Backup & Restore
  const downloadZipBtn = document.getElementById('downloadAttachmentsZipBtn');
  if (downloadZipBtn) {
    downloadZipBtn.addEventListener('click', exportAttachmentsZipFile);
  }
  const uploadZipBtn = document.getElementById('uploadAttachmentsZipBtn');
  const restoreZipInput = document.getElementById('restoreAttachmentsZipInput');
  if (uploadZipBtn && restoreZipInput) {
    uploadZipBtn.addEventListener('click', () => restoreZipInput.click());
    restoreZipInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        await importAttachmentsZipFile(file);
      } finally {
        restoreZipInput.value = '';
      }
    });
  }

  const exportDbBtn = document.getElementById('exportDbBtn');
  if (exportDbBtn) {
    exportDbBtn.addEventListener('click', exportSqliteFile);
  }
  const importDbInput = document.getElementById('importDbInput');
  if (importDbInput) {
    importDbInput.addEventListener('change', importSqliteFile);
  }

  // Schedule Details Modal Events
  document.getElementById('closeScheduleDetailsBtn').addEventListener('click', closeScheduleDetailsModal);
  document.getElementById('detailsCloseBtn').addEventListener('click', closeScheduleDetailsModal);
  document.getElementById('detailsEditBtn').addEventListener('click', () => {
    const sch = activeViewingSchedule;
    closeScheduleDetailsModal();
    if (sch) {
      const isTravel = sch.title && (sch.title.toLowerCase().startsWith('travel:') || sch.title.toLowerCase().startsWith('return travel:') || sch.title.toLowerCase().startsWith('travel arrival:') || sch.title.toLowerCase().startsWith('return travel arrival:') || sch.title.toLowerCase() === 'travel');
      if (isTravel && sch.group_id) {
        const res = db.exec("SELECT * FROM schedules WHERE group_id = ? AND title NOT LIKE 'Travel:%' AND title NOT LIKE 'Return Travel:%' AND title NOT LIKE 'Travel Arrival:%' AND title NOT LIKE 'Return Travel Arrival:%' LIMIT 1", [sch.group_id]);
        if (res.length > 0) {
          const parentSch = rowsToObjects(res[0])[0];
          openScheduleModal(parentSch);
          return;
        }
      }
      openScheduleModal(sch);
    }
  });
  const detailsDelBtn = document.getElementById('detailsDeleteBtn');
  if (detailsDelBtn) {
    detailsDelBtn.addEventListener('click', async () => {
      const sch = activeViewingSchedule;
      if (!sch) return;

      closeScheduleDetailsModal();

      if (sch.group_id) {
        if (confirm(`⚠️ "${sch.title}" is connected to a Schedule/Batch Group. Delete the schedule and ALL attached travel plans?`)) {
          await deleteBatchGroupById(sch.group_id);
        }
      } else {
        if (confirm(`Delete schedule "${sch.title}"?`)) {
          await deleteSingleScheduleById(sch.id);
        }
      }
    });
  }

  // Reports & Statements Modal Controls
  const openReportsBtn = document.getElementById('openReportsModalBtn');
  if (openReportsBtn) {
    openReportsBtn.addEventListener('click', openReportsModal);
  }
  const closeReportsBtn = document.getElementById('closeReportsModalBtn');
  if (closeReportsBtn) {
    closeReportsBtn.addEventListener('click', closeReportsModal);
  }
  const generateReportBtn = document.getElementById('generateReportBtn');
  if (generateReportBtn) {
    generateReportBtn.addEventListener('click', generateActiveReport);
  }
  const printReportBtn = document.getElementById('printReportBtn');
  if (printReportBtn) {
    printReportBtn.addEventListener('click', printCurrentReport);
  }
  document.querySelectorAll('.report-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchReportTab(btn.dataset.report);
    });
  });
  ['change', 'input'].forEach(evt => {
    const fromD = document.getElementById('reportFromDate');
    const toD = document.getElementById('reportToDate');
    const acctS = document.getElementById('reportAccountSelect');
    const tagS = document.getElementById('reportTagSelect');
    if (fromD) fromD.addEventListener(evt, generateActiveReport);
    if (toD) toD.addEventListener(evt, generateActiveReport);
    if (acctS) acctS.addEventListener(evt, generateActiveReport);
    if (tagS) tagS.addEventListener(evt, generateActiveReport);
  });
}

let activeViewingSchedule = null;

function openScheduleDetailsModal(s) {
  if (!s) return;
  activeViewingSchedule = s;

  const isTravelArr = s.title && (s.title.toLowerCase().startsWith('travel arrival:') || s.title.toLowerCase().startsWith('return travel arrival:'));
  const isTravelDep = s.title && (s.title.toLowerCase().startsWith('travel:') || s.title.toLowerCase().startsWith('return travel:') || s.title.toLowerCase() === 'travel');
  const isTravel = isTravelArr || isTravelDep;

  const headingEl = document.getElementById('detailsModalHeading');
  const editBtn = document.getElementById('detailsEditBtn');
  if (editBtn) {
    editBtn.innerHTML = isTravel ? '<i class="fa-solid fa-pen-to-square"></i> Edit Main Schedule' : '<i class="fa-solid fa-pen-to-square"></i> Edit';
  }

  headingEl.innerHTML = isTravel ? '<i class="fa-solid fa-train"></i> Travel Plan Details' : '<i class="fa-solid fa-calendar-day"></i> Schedule Details';

  const body = document.getElementById('scheduleDetailsBody');
  body.innerHTML = '';

  if (isTravel) {
    const infoBanner = document.createElement('div');
    infoBanner.className = 'travel-alert-banner';
    infoBanner.style.cssText = 'padding: 10px; border-radius: 6px; font-size: 0.85rem; margin-bottom: 12px; display: flex; align-items: center; gap: 8px;';
    infoBanner.innerHTML = `<i class="fa-solid fa-circle-info" style="font-size: 1rem; color: #f59e0b;"></i> <span><strong>Attached Travel Plan:</strong> Travel plans are linked to your main program schedule. To edit travel details or remove this travel plan, edit the main program schedule.</span>`;
    body.appendChild(infoBanner);
  }

  // Title
  const titleItem = document.createElement('div');
  titleItem.className = 'schedule-detail-item';
  titleItem.innerHTML = `
    <span class="schedule-detail-label">Title</span>
    <span class="schedule-detail-value" style="font-weight: 600; font-size: 1.05rem; color: var(--text-main);">${escapeHtml(s.title)}</span>
  `;
  body.appendChild(titleItem);

  // Date & Time
  const dateTimeItem = document.createElement('div');
  dateTimeItem.className = 'schedule-detail-item';
  dateTimeItem.innerHTML = `
    <span class="schedule-detail-label">Date & Time</span>
    <span class="schedule-detail-value"><i class="fa-solid fa-calendar-days"></i> ${formatDateIndian(s.schedule_date)} | <i class="fa-solid fa-clock"></i> ${formatTimeRange(s.from_time, s.to_time)}</span>
  `;
  body.appendChild(dateTimeItem);

  // Mode & Status
  const statusItem = document.createElement('div');
  statusItem.className = 'schedule-detail-item';
  statusItem.innerHTML = `
    <span class="schedule-detail-label">Mode & Status</span>
    <div class="schedule-detail-badges">
      <span class="chip-mode-badge ${s.delivery_mode}" style="font-size:0.75rem; padding: 2px 8px;">
        ${s.delivery_mode === 'online' ? '🌐 Online' : (s.delivery_mode === 'hybrid' ? '🔄 Hybrid' : '🏢 Offline')}
      </span>
      <span class="report-status-badge ${deriveScheduleStatus(s.schedule_date, s.to_time)}">
        ${deriveScheduleStatus(s.schedule_date, s.to_time) === 'completed' ? '✓ Completed' : '📅 Scheduled'}
      </span>
      ${s.group_id ? '<span class="badge-batch-group" style="font-size: 0.75rem; padding: 2px 8px; border-radius: 3px; font-weight: 600;"><i class="fa-solid fa-layer-group"></i> Batch Group</span>' : ''}
    </div>
  `;
  body.appendChild(statusItem);

  // Location / Route
  if (s.location) {
    const locItem = document.createElement('div');
    locItem.className = 'schedule-detail-item';
    locItem.innerHTML = `
      <span class="schedule-detail-label">Location / Route</span>
      <span class="schedule-detail-value"><i class="fa-solid fa-location-dot"></i> ${escapeHtml(s.location)}</span>
    `;
    body.appendChild(locItem);
  }

  // Tags
  if (s.tags && s.tags.length > 0) {
    const tagsItem = document.createElement('div');
    tagsItem.className = 'schedule-detail-item';
    const tagBadges = s.tags.map(t => {
      const safeColor = sanitizeColor(t.color, '#3b82f6');
      const bg = safeColor.startsWith('#') && safeColor.length === 7 ? safeColor + '40' : 'rgba(59,130,246,0.25)';
      return `<span class="chip-tag-pill" style="background:${bg}; font-size:0.75rem; padding:3px 8px; border-radius:4px;">${escapeHtml(t.name)}</span>`;
    }).join(' ');
    tagsItem.innerHTML = `
      <span class="schedule-detail-label">Tags</span>
      <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:4px;">${tagBadges}</div>
    `;
    body.appendChild(tagsItem);
  }

  // Notes
  if (s.notes) {
    const notesItem = document.createElement('div');
    notesItem.className = 'schedule-detail-item';
    notesItem.innerHTML = `
      <span class="schedule-detail-label">Notes & Travel Info</span>
      <div class="schedule-detail-value" style="background: var(--bg-primary); padding: 10px; border-radius: 6px; font-size: 0.85rem; border: 1px solid var(--border-color); white-space: pre-wrap;">${escapeHtml(s.notes)}</div>
    `;
    body.appendChild(notesItem);
  }

  // Attachments
  try {
    const atts = JSON.parse(s.attachments || '[]');
    if (atts.length > 0) {
      const attItem = document.createElement('div');
      attItem.className = 'schedule-detail-item';
      attItem.innerHTML = `<span class="schedule-detail-label">Attachments (${atts.length})</span>`;
      const attContainer = document.createElement('div');
      attContainer.style.display = 'flex';
      attContainer.style.flexWrap = 'wrap';
      attContainer.style.gap = '8px';
      attContainer.style.marginTop = '6px';

      atts.forEach(att => {
        const attPill = document.createElement('div');
        attPill.className = 'travel-ticket-pill';
        attPill.style.cursor = 'pointer';
        const iconClass = (att.type && att.type.includes('pdf')) ? 'fa-file-pdf' : ((att.type && att.type.startsWith('image/')) ? 'fa-file-image' : 'fa-paperclip');
        attPill.innerHTML = `<i class="fa-solid ${iconClass}"></i> <span>${escapeHtml(att.name || 'Attachment')}</span>`;
        attPill.addEventListener('click', (e) => {
          e.stopPropagation();
          openAttachmentViewer(att);
        });
        attContainer.appendChild(attPill);
      });
      attItem.appendChild(attContainer);
      body.appendChild(attItem);
    }
  } catch (e) {}

  document.getElementById('scheduleDetailsModal').classList.remove('hidden');
}

function closeScheduleDetailsModal() {
  document.getElementById('scheduleDetailsModal').classList.add('hidden');
  activeViewingSchedule = null;
}

/* ==========================================================================
   REPORTS & FINANCIAL STATEMENTS ENGINE
   ========================================================================== */

let activeReportType = 'free_days';

function openReportsModal() {
  const modal = document.getElementById('reportsModal');
  if (!modal) return;
  modal.classList.remove('hidden');

  const fromInput = document.getElementById('reportFromDate');
  const toInput = document.getElementById('reportToDate');

  const now = currentDate || new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  if (fromInput && !fromInput.value) {
    fromInput.value = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  }
  if (toInput && !toInput.value) {
    toInput.value = `${year}-${String(month + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
  }

  populateReportFilterOptions();
  generateActiveReport();
}

function closeReportsModal() {
  const modal = document.getElementById('reportsModal');
  if (modal) modal.classList.add('hidden');
}

function populateReportFilterOptions() {
  if (!db) return;

  // 1. Populate Account Dropdown for Ledger Report (from the chart of accounts, grouped by type)
  const acctSelect = document.getElementById('reportAccountSelect');
  if (acctSelect) {
    fillAccountSelect(acctSelect, { placeholder: 'Select account…' });
  }

  // 2. Populate Tag Select for Reports 4 & 5
  const tagSelect = document.getElementById('reportTagSelect');
  if (tagSelect) {
    tagSelect.innerHTML = '<option value="all">All Tags</option>';
    tagMasterTags.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      tagSelect.appendChild(opt);
    });
  }
}

// Point-in-time statements: only the "As on" (To) date applies.
const AS_ON_REPORTS = new Set(['trial_balance', 'balance_sheet']);

function switchReportTab(reportType) {
  activeReportType = reportType;
  document.querySelectorAll('.report-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.report === reportType);
  });

  const acctGroup = document.getElementById('reportAccountGroup');
  const tagGroup = document.getElementById('reportTagGroup');

  if (acctGroup) acctGroup.classList.toggle('hidden', reportType !== 'ledger');
  const asOn = AS_ON_REPORTS.has(reportType);
  const fromWrap = document.getElementById('reportFromWrap');
  const toLabel = document.getElementById('reportToLabel');
  if (fromWrap) fromWrap.classList.toggle('hidden', asOn);
  if (toLabel) toLabel.textContent = asOn ? 'As on:' : 'To:';
  if (tagGroup) tagGroup.classList.toggle('hidden', reportType !== 'schedules' && reportType !== 'ticket_cost' && reportType !== 'ticket_claim');

  generateActiveReport();
}

function generateActiveReport() {
  const container = document.getElementById('reportOutputContainer');
  if (!container) return;

  const fromDate = document.getElementById('reportFromDate').value;
  const toDate = document.getElementById('reportToDate').value;

  if (AS_ON_REPORTS.has(activeReportType)) {
    if (!toDate) {
      container.innerHTML = '<div style="color:#fb7185; text-align:center; padding:30px;">Please select the As on date.</div>';
      return;
    }
    if (activeReportType === 'trial_balance') renderTrialBalanceReport(container, toDate);
    else renderBalanceSheetReport(container, toDate);
    return;
  }

  if (!fromDate || !toDate) {
    container.innerHTML = '<div style="color:#fb7185; text-align:center; padding:30px;">Please select both From Date and To Date.</div>';
    return;
  }
  if (fromDate > toDate) {
    container.innerHTML = '<div style="color:#fb7185; text-align:center; padding:30px;">From Date cannot be later than To Date.</div>';
    return;
  }

  if (activeReportType === 'free_days') {
    renderFreeDaysReport(container, fromDate, toDate);
  } else if (activeReportType === 'journal') {
    renderJournalReport(container, fromDate, toDate);
  } else if (activeReportType === 'ledger') {
    renderLedgerReport(container, fromDate, toDate);
  } else if (activeReportType === 'income_statement') {
    renderIncomeStatementReport(container, fromDate, toDate);
  } else if (activeReportType === 'schedules') {
    renderSchedulesReport(container, fromDate, toDate);
  } else if (activeReportType === 'ticket_cost') {
    renderTicketCostReport(container, fromDate, toDate);
  } else if (activeReportType === 'ticket_claim') {
    renderTicketClaimReport(container, fromDate, toDate);
  } else if (activeReportType === 'monthly_calendar') {
    renderMonthlyCalendarReport(container, fromDate, toDate);
  }
}

function renderFreeDaysReport(container, fromDate, toDate) {
  const d1 = new Date(fromDate + 'T00:00:00');
  const d2 = new Date(toDate + 'T00:00:00');

  const schedulesMap = getSchedulesMap(fromDate, toDate);
  const freeDays = [];

  for (let d = new Date(d1); d <= d2; d.setDate(d.getDate() + 1)) {
    const dateYmd = formatDateYMD(d);
    const daySchedules = schedulesMap[dateYmd] || [];

    const nonTravel = daySchedules.filter(s => {
      const titleLower = (s.title || '').toLowerCase();
      return !titleLower.startsWith('travel') && !titleLower.startsWith('return travel');
    });

    const travelSchedules = daySchedules.filter(s => {
      const titleLower = (s.title || '').toLowerCase();
      return titleLower.startsWith('travel') || titleLower.startsWith('return travel');
    });

    if (nonTravel.length === 0) {
      let placeStr = '';
      if (travelSchedules.length > 0) {
        placeStr = travelSchedules.map(t => t.location || t.title).join(', ');
      }
      freeDays.push({
        dateYmd: dateYmd,
        dateObj: new Date(d),
        hasTravelOnly: travelSchedules.length > 0,
        travelPlace: placeStr
      });
    }
  }

  if (freeDays.length === 0) {
    container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-muted);">No free days found between ${formatDateIndian(fromDate)} and ${formatDateIndian(toDate)}.</div>`;
    return;
  }

  let html = `
    <div style="margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
      <h4 style="margin:0; font-size:1rem; color:var(--text-main);"><i class="fa-solid fa-umbrella-beach" style="color:var(--accent-blue);"></i> Free Days List (${formatDateIndian(fromDate)} to ${formatDateIndian(toDate)})</h4>
      <span style="font-size:0.85rem; color:var(--receipt-color); font-weight:600;">Total Free Days: ${freeDays.length}</span>
    </div>
    <table style="width:100%; border-collapse:collapse; font-size:0.88rem; text-align:left;">
      <thead>
        <tr style="background:var(--bg-tertiary); border-bottom:2px solid var(--border-color);">
          <th style="padding:10px;">Date & Day</th>
          <th style="padding:10px;">Status / Remarks</th>
          <th style="padding:10px;">Location / In-Transit Place</th>
        </tr>
      </thead>
      <tbody>
  `;

  freeDays.forEach(f => {
    const dStrInd = formatDateIndian(f.dateYmd);
    const dayOfWeek = DAY_NAMES_SHORT[f.dateObj.getDay()];

    let statusBadge = `<span style="color:var(--receipt-color); background:var(--badge-green-bg); border:1px solid var(--badge-green-border); padding:3px 8px; border-radius:4px; font-weight:600;">🟢 100% Free Day</span>`;
    if (f.hasTravelOnly) {
      statusBadge = `<span style="color:var(--accent-blue); background:var(--badge-blue-bg); border:1px solid var(--badge-blue-border); padding:3px 8px; border-radius:4px; font-weight:600;">🚆 Travel / In-Transit Only</span>`;
    }

    html += `
      <tr style="border-bottom:1px solid var(--border-color);">
        <td style="padding:10px; font-weight:600;">${dStrInd} (${dayOfWeek})</td>
        <td style="padding:10px;">${statusBadge}</td>
        <td style="padding:10px;">${f.travelPlace ? `📍 ${escapeHtml(f.travelPlace)}` : '-'}</td>
      </tr>
    `;
  });

  html += `</tbody></table>`;
  container.innerHTML = html;
}

function renderJournalReport(container, fromDate, toDate) {
  let txns = [];
  try {
    const res = db.exec("SELECT * FROM daily_transactions WHERE txn_date >= ? AND txn_date <= ? ORDER BY txn_date ASC, created_at ASC", [fromDate, toDate]);
    if (res.length > 0) txns = rowsToObjects(res[0]);
  } catch(e){}

  if (txns.length === 0) {
    container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-muted);">No financial transactions found between ${formatDateIndian(fromDate)} and ${formatDateIndian(toDate)}.</div>`;
    return;
  }

  let totalReceipts = 0;
  let totalPayments = 0;
  txns.forEach(t => {
    if (t.type === 'receipt') totalReceipts += toPaise(t.amount);
    else if (t.type === 'payment') totalPayments += toPaise(t.amount);
  });
  const netFlow = totalReceipts - totalPayments;

  let html = `
    <div style="margin-bottom:14px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
      <h4 style="margin:0; font-size:1rem; color:var(--text-main);"><i class="fa-solid fa-book" style="color:var(--receipt-color);"></i> Journal Statement (${formatDateIndian(fromDate)} to ${formatDateIndian(toDate)})</h4>
      <div style="font-size:0.85rem; display:flex; gap:12px;">
        <span>Receipts: <strong style="color:var(--receipt-color);">${formatINR(totalReceipts)}</strong></span>
        <span>Payments: <strong style="color:var(--payment-color);">${formatINR(totalPayments)}</strong></span>
        <span>Net Flow: <strong style="color:${netFlow >= 0 ? 'var(--net-positive)' : 'var(--payment-color)'};">${formatINR(netFlow)}</strong></span>
      </div>
    </div>
    <table style="width:100%; border-collapse:collapse; font-size:0.86rem; text-align:left;">
      <thead>
        <tr style="background:var(--bg-tertiary); border-bottom:2px solid var(--border-color);">
          <th style="padding:8px 10px;">Date</th>
          <th style="padding:8px 10px;">Type</th>
          <th style="padding:8px 10px;">Debit Account (Dr)</th>
          <th style="padding:8px 10px;">Credit Account (Cr)</th>
          <th style="padding:8px 10px; text-align:right;">Amount (₹)</th>
          <th style="padding:8px 10px;">Narration / Description</th>
        </tr>
      </thead>
      <tbody>
  `;

  txns.forEach(t => {
    const vt = voucherTypeInfo(t.type);
    html += `
      <tr style="border-bottom:1px solid var(--border-color);">
        <td style="padding:8px 10px; font-weight:600;">${formatDateIndian(t.txn_date)}</td>
        <td style="padding:8px 10px;"><span style="color:${vt.color}; font-weight:600;">${vt.icon} ${vt.label}</span></td>
        <td style="padding:8px 10px;">${escapeHtml(t.debit_account || '-')}</td>
        <td style="padding:8px 10px;">${escapeHtml(t.credit_account || '-')}</td>
        <td style="padding:8px 10px; text-align:right; font-weight:700; color:${vt.color};">${formatINR(toPaise(t.amount))}</td>
        <td style="padding:8px 10px; color:var(--text-muted);">${escapeHtml(t.description || '-')}</td>
      </tr>
    `;
  });

  html += `</tbody></table>`;
  container.innerHTML = html;
}

function renderLedgerReport(container, fromDate, toDate) {
  const acctSelect = document.getElementById('reportAccountSelect');
  const targetAccount = acctSelect ? acctSelect.value : '';

  if (!targetAccount) {
    container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-muted);">Please select a particular account from the dropdown.</div>`;
    return;
  }

  let txns = [];
  try {
    const res = db.exec("SELECT * FROM daily_transactions WHERE (TRIM(debit_account) = ? COLLATE NOCASE OR TRIM(credit_account) = ? COLLATE NOCASE) AND txn_date >= ? AND txn_date <= ? ORDER BY txn_date ASC, created_at ASC", [targetAccount, targetAccount, fromDate, toDate]);
    if (res.length > 0) txns = rowsToObjects(res[0]);
  } catch(e){}

  // Continuous books: the period opens with everything posted to this account before the From date.
  let openingBalance = 0;
  try {
    const ob = db.exec(`
      SELECT
        COALESCE(SUM(CASE WHEN TRIM(debit_account) = ? COLLATE NOCASE THEN CAST(ROUND(amount * 100) AS INTEGER) ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN TRIM(credit_account) = ? COLLATE NOCASE THEN CAST(ROUND(amount * 100) AS INTEGER) ELSE 0 END), 0)
      FROM daily_transactions WHERE txn_date < ?
    `, [targetAccount, targetAccount, fromDate]);
    if (ob.length > 0) openingBalance = ob[0].values[0][0] - ob[0].values[0][1];
  } catch(e){}

  if (txns.length === 0 && openingBalance === 0) {
    container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-muted);">No ledger entries found for account "${escapeHtml(targetAccount)}" between ${formatDateIndian(fromDate)} and ${formatDateIndian(toDate)}.</div>`;
    return;
  }

  let totalDebit = 0;
  let totalCredit = 0;
  let runningBalance = openingBalance;

  let html = `
    <div style="margin-bottom:14px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
      <h4 style="margin:0; font-size:1rem; color:var(--text-main);"><i class="fa-solid fa-scale-balanced" style="color:var(--badge-amber-text);"></i> Ledger Account: <strong style="color:var(--accent-blue);">${escapeHtml(targetAccount)}</strong> <small style="font-weight:600; color:var(--text-muted);">(${escapeHtml(ACCOUNT_TYPES[(findAccount(targetAccount) || {}).account_type] || 'Not in chart')})</small></h4>
      <span style="font-size:0.85rem; color:var(--text-muted);">${formatDateIndian(fromDate)} to ${formatDateIndian(toDate)}</span>
    </div>
    <table style="width:100%; border-collapse:collapse; font-size:0.86rem; text-align:left;">
      <thead>
        <tr style="background:var(--bg-tertiary); border-bottom:2px solid var(--border-color);">
          <th style="padding:8px 10px;">Date</th>
          <th style="padding:8px 10px;">Particulars / Contra Account</th>
          <th style="padding:8px 10px; text-align:right;">Debit (Dr ₹)</th>
          <th style="padding:8px 10px; text-align:right;">Credit (Cr ₹)</th>
          <th style="padding:8px 10px; text-align:right;">Balance (₹)</th>
          <th style="padding:8px 10px;">Narration</th>
        </tr>
      </thead>
      <tbody>
        <tr style="border-bottom:1px solid var(--border-color); font-style:italic;">
          <td style="padding:8px 10px; font-weight:600;">${formatDateIndian(fromDate)}</td>
          <td style="padding:8px 10px; font-weight:600; color:var(--text-main);">Opening balance b/f</td>
          <td style="padding:8px 10px; text-align:right;">-</td>
          <td style="padding:8px 10px; text-align:right;">-</td>
          <td style="padding:8px 10px; text-align:right; font-weight:700;">${formatDrCr(openingBalance)}</td>
          <td style="padding:8px 10px; color:var(--text-muted);">Balance of all entries before this date</td>
        </tr>
  `;

  txns.forEach(t => {
    let drAmt = 0;
    let crAmt = 0;
    let contraAcct = '';

    if (normalizeAccountName(t.debit_account).toLowerCase() === targetAccount.toLowerCase()) {
      drAmt = toPaise(t.amount);
      contraAcct = 'To ' + (t.credit_account || 'Cash/Bank');
      runningBalance += drAmt;
      totalDebit += drAmt;
    } else {
      crAmt = toPaise(t.amount);
      contraAcct = 'By ' + (t.debit_account || 'Cash/Bank');
      runningBalance -= crAmt;
      totalCredit += crAmt;
    }

    html += `
      <tr style="border-bottom:1px solid var(--border-color);">
        <td style="padding:8px 10px; font-weight:600;">${formatDateIndian(t.txn_date)}</td>
        <td style="padding:8px 10px; font-weight:600; color:var(--text-main);">${escapeHtml(contraAcct)}</td>
        <td style="padding:8px 10px; text-align:right; color:var(--receipt-color);">${drAmt > 0 ? formatINR(drAmt) : '-'}</td>
        <td style="padding:8px 10px; text-align:right; color:var(--payment-color);">${crAmt > 0 ? formatINR(crAmt) : '-'}</td>
        <td style="padding:8px 10px; text-align:right; font-weight:700; color:${runningBalance >= 0 ? 'var(--net-positive)' : 'var(--payment-color)'};">${formatDrCr(runningBalance)}</td>
        <td style="padding:8px 10px; color:var(--text-muted);">${escapeHtml(t.description || '-')}</td>
      </tr>
    `;
  });

  html += `
      <tr style="background:var(--bg-tertiary); font-weight:700; border-top:2px solid var(--border-color);">
        <td colspan="2" style="padding:10px;">TOTALS & CLOSING BALANCE</td>
        <td style="padding:10px; text-align:right; color:var(--receipt-color);">Dr ${formatINR(totalDebit)}</td>
        <td style="padding:10px; text-align:right; color:var(--payment-color);">Cr ${formatINR(totalCredit)}</td>
        <td style="padding:10px; text-align:right; color:var(--net-positive);">${formatDrCr(runningBalance)}</td>
        <td style="padding:10px;"></td>
      </tr>
    </tbody></table>
  `;

  container.innerHTML = html;
}

/* ==========================================================================
   FINANCIAL STATEMENTS: TRIAL BALANCE, INCOME STATEMENT, BALANCE SHEET
   The books are one continuous ledger (no financial-year closing entries). Revenue and
   expenditure are never "closed" by posting; the Balance Sheet nets them up to its date and
   shows the result as a computed accumulated surplus under Equity.
   ========================================================================== */

// Net balances per account, in paise. dr/cr are gross postings; net = dr - cr (positive = debit balance).
// from is optional (inclusive); to is inclusive. Dates are ISO YYYY-MM-DD, so string comparison is chronological.
function computeAccountBalances({ from = null, to }) {
  const chart = new Map(getChartOfAccounts().map(a => [a.name.toLowerCase(), a]));
  const balances = new Map();
  const touch = (rawName) => {
    const name = normalizeAccountName(rawName);
    if (!name) return null;
    const key = name.toLowerCase();
    if (!balances.has(key)) {
      const acct = chart.get(key);
      const type = acct && ACCOUNT_TYPES[acct.account_type] ? acct.account_type : 'unclassified';
      balances.set(key, { name: acct ? acct.name : name, type, dr: 0, cr: 0, net: 0 });
    }
    return balances.get(key);
  };

  let sql = "SELECT debit_account, credit_account, amount FROM daily_transactions WHERE txn_date <= ?";
  const params = [to];
  if (from) { sql += " AND txn_date >= ?"; params.push(from); }
  try {
    const res = db.exec(sql, params);
    const rows = res.length > 0 ? res[0].values : [];
    rows.forEach(([debit, credit, amount]) => {
      const p = toPaise(amount);
      const d = touch(debit);
      const c = touch(credit);
      if (d) { d.dr += p; d.net += p; }
      if (c) { c.cr += p; c.net -= p; }
    });
  } catch (e) {
    console.warn('Error computing account balances:', e);
  }
  return Array.from(balances.values()).sort((a, b) => a.name.localeCompare(b.name, 'en-IN', { sensitivity: 'base' }));
}

// Natural side of each type: debit-natured accounts show (Dr - Cr), credit-natured show (Cr - Dr).
const DEBIT_NATURED_TYPES = new Set(['asset', 'expenditure']);

function naturalBalance(acct) {
  return DEBIT_NATURED_TYPES.has(acct.type) ? acct.net : -acct.net;
}

const STMT_TD = 'padding:7px 10px;';
const STMT_TD_R = 'padding:7px 10px; text-align:right; white-space:nowrap;';

function stmtHeader(icon, color, title, subtitle) {
  return `
    <div style="margin-bottom:14px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
      <h4 style="margin:0; font-size:1rem; color:var(--text-main);"><i class="fa-solid ${icon}" style="color:${color};"></i> ${title}</h4>
      <span style="font-size:0.85rem; color:var(--text-muted);">${subtitle}</span>
    </div>`;
}

function stmtUnclassifiedWarning(accounts) {
  const list = accounts.filter(a => a.type === 'unclassified' && a.net !== 0);
  if (list.length === 0) return '';
  return `
    <div style="margin-bottom:12px; padding:10px 12px; border-radius:var(--radius-md); border:1px solid var(--badge-amber-text); color:var(--badge-amber-text); font-size:0.84rem; line-height:1.45;">
      <i class="fa-solid fa-triangle-exclamation"></i> ${list.length} account${list.length === 1 ? ' has' : 's have'} no type yet:
      <strong>${list.map(a => escapeHtml(a.name)).join(', ')}</strong>. Set a type in <em>Chart of Accounts</em> so ${list.length === 1 ? 'it lands' : 'they land'} in the right statement.
    </div>`;
}

function stmtFootnote(text) {
  return `<p style="margin:12px 0 0; font-size:0.76rem; color:var(--text-muted); line-height:1.45;">${text}</p>`;
}

function stmtSection(title, rows, totalLabel, total) {
  let html = `
    <tr style="background:var(--bg-tertiary);"><td colspan="2" style="${STMT_TD} font-weight:700; text-transform:uppercase; font-size:0.76rem; letter-spacing:0.04em; color:var(--text-muted);">${title}</td></tr>`;
  if (rows.length === 0) {
    html += `<tr><td style="${STMT_TD} color:var(--text-muted); font-style:italic;">None</td><td style="${STMT_TD_R}">${formatINR(0)}</td></tr>`;
  }
  rows.forEach(r => {
    html += `
    <tr style="border-bottom:1px solid var(--border-color);">
      <td style="${STMT_TD}${r.style || ''}">${r.label}</td>
      <td style="${STMT_TD_R}${r.style || ''}">${formatINR(r.amount)}</td>
    </tr>`;
  });
  html += `
    <tr style="font-weight:700; border-top:2px solid var(--border-color);">
      <td style="${STMT_TD}">${totalLabel}</td>
      <td style="${STMT_TD_R}">${formatINR(total)}</td>
    </tr>`;
  return html;
}

function renderTrialBalanceReport(container, asOnDate) {
  const accounts = computeAccountBalances({ to: asOnDate }).filter(a => a.net !== 0);
  if (accounts.length === 0) {
    container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-muted);">No account balances as on ${formatDateIndian(asOnDate)}.</div>`;
    return;
  }

  let totalDr = 0;
  let totalCr = 0;
  let html = stmtHeader('fa-list-ol', 'var(--accent-blue)', 'Trial Balance', `As on ${formatDateIndian(asOnDate)}`) +
    stmtUnclassifiedWarning(accounts) + `
    <table style="width:100%; border-collapse:collapse; font-size:0.86rem; text-align:left;">
      <thead>
        <tr style="background:var(--bg-tertiary); border-bottom:2px solid var(--border-color);">
          <th style="${STMT_TD}">Account</th>
          <th style="${STMT_TD}">Type</th>
          <th style="${STMT_TD_R}">Debit (Dr ₹)</th>
          <th style="${STMT_TD_R}">Credit (Cr ₹)</th>
        </tr>
      </thead>
      <tbody>`;

  ACCOUNT_TYPE_ORDER.forEach(type => {
    accounts.filter(a => a.type === type).forEach(a => {
      const dr = a.net > 0 ? a.net : 0;
      const cr = a.net < 0 ? -a.net : 0;
      totalDr += dr;
      totalCr += cr;
      html += `
        <tr style="border-bottom:1px solid var(--border-color);">
          <td style="${STMT_TD} font-weight:600;">${escapeHtml(a.name)}</td>
          <td style="${STMT_TD} color:${type === 'unclassified' ? 'var(--badge-amber-text)' : 'var(--text-muted)'};">${ACCOUNT_TYPES[type]}</td>
          <td style="${STMT_TD_R} color:var(--receipt-color);">${dr ? formatINR(dr) : '-'}</td>
          <td style="${STMT_TD_R} color:var(--payment-color);">${cr ? formatINR(cr) : '-'}</td>
        </tr>`;
    });
  });

  const diff = totalDr - totalCr;
  html += `
        <tr style="background:var(--bg-tertiary); font-weight:700; border-top:2px solid var(--border-color);">
          <td colspan="2" style="${STMT_TD}">TOTAL</td>
          <td style="${STMT_TD_R}">${formatINR(totalDr)}</td>
          <td style="${STMT_TD_R}">${formatINR(totalCr)}</td>
        </tr>
      </tbody>
    </table>
    <div style="margin-top:10px; font-size:0.86rem; font-weight:600; color:${diff === 0 ? 'var(--receipt-color)' : 'var(--payment-color)'};">
      ${diff === 0 ? '<i class="fa-solid fa-circle-check"></i> Debits equal credits — the books agree.' : `<i class="fa-solid fa-circle-xmark"></i> Out of balance by ${formatINR(Math.abs(diff))}. Check for entries with a missing debit or credit account.`}
    </div>` +
    stmtFootnote('Balances are cumulative from the first entry up to the date shown — there is no financial-year closing.');
  container.innerHTML = html;
}

function renderIncomeStatementReport(container, fromDate, toDate) {
  const accounts = computeAccountBalances({ from: fromDate, to: toDate });
  const revenue = accounts.filter(a => a.type === 'revenue' && a.net !== 0);
  const expenditure = accounts.filter(a => a.type === 'expenditure' && a.net !== 0);
  const unclassified = accounts.filter(a => a.type === 'unclassified');

  if (revenue.length === 0 && expenditure.length === 0) {
    container.innerHTML = stmtUnclassifiedWarning(unclassified) +
      `<div style="text-align:center; padding:40px; color:var(--text-muted);">No revenue or expenditure between ${formatDateIndian(fromDate)} and ${formatDateIndian(toDate)}.</div>`;
    return;
  }

  const totalRevenue = revenue.reduce((s, a) => s + naturalBalance(a), 0);
  const totalExpenditure = expenditure.reduce((s, a) => s + naturalBalance(a), 0);
  const surplus = totalRevenue - totalExpenditure;

  let html = stmtHeader('fa-chart-line', 'var(--receipt-color)', 'Income Statement', `${formatDateIndian(fromDate)} to ${formatDateIndian(toDate)}`) +
    stmtUnclassifiedWarning(unclassified) + `
    <table style="width:100%; max-width:640px; border-collapse:collapse; font-size:0.88rem; text-align:left;">
      <thead>
        <tr style="border-bottom:2px solid var(--border-color);">
          <th style="${STMT_TD}">Particulars</th>
          <th style="${STMT_TD_R}">Amount (₹)</th>
        </tr>
      </thead>
      <tbody>` +
    stmtSection('Revenue', revenue.map(a => ({ label: escapeHtml(a.name), amount: naturalBalance(a) })), 'Total Revenue (A)', totalRevenue) +
    stmtSection('Expenditure', expenditure.map(a => ({ label: escapeHtml(a.name), amount: naturalBalance(a) })), 'Total Expenditure (B)', totalExpenditure) + `
        <tr style="background:var(--bg-tertiary); font-weight:800; font-size:0.95rem; border-top:2px solid var(--border-color);">
          <td style="${STMT_TD}">${surplus >= 0 ? 'Surplus' : 'Deficit'} for the period (A − B)</td>
          <td style="${STMT_TD_R} color:${surplus >= 0 ? 'var(--receipt-color)' : 'var(--payment-color)'};">${formatINR(Math.abs(surplus))}</td>
        </tr>
      </tbody>
    </table>` +
    stmtFootnote('Only entries dated within the period are included. The cumulative surplus is carried to Equity in the Balance Sheet.');
  container.innerHTML = html;
}

function renderBalanceSheetReport(container, asOnDate) {
  const accounts = computeAccountBalances({ to: asOnDate });
  if (accounts.every(a => a.net === 0)) {
    container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-muted);">No balances as on ${formatDateIndian(asOnDate)}.</div>`;
    return;
  }

  const pick = type => accounts.filter(a => a.type === type && a.net !== 0);
  const assets = pick('asset');
  const liabilities = pick('liability');
  const equity = pick('equity');
  // Virtual closing: all revenue less all expenditure up to the date becomes accumulated surplus. Nothing is posted.
  const accumulatedSurplus = pick('revenue').reduce((s, a) => s + naturalBalance(a), 0) -
    pick('expenditure').reduce((s, a) => s + naturalBalance(a), 0);
  // Untyped accounts still carry money; show them on the side their balance falls so the statement stays complete.
  const unclassified = pick('unclassified');
  const unclassifiedDr = unclassified.filter(a => a.net > 0);
  const unclassifiedCr = unclassified.filter(a => a.net < 0);
  const flag = ' color:var(--badge-amber-text);';

  const equityRows = equity.map(a => ({ label: escapeHtml(a.name), amount: naturalBalance(a) }));
  equityRows.push({ label: `Accumulated ${accumulatedSurplus >= 0 ? 'surplus' : 'deficit'} (revenue less expenditure to date)`, amount: accumulatedSurplus, style: ' font-style:italic;' });
  const totalEquity = equityRows.reduce((s, r) => s + r.amount, 0);

  const liabilityRows = liabilities.map(a => ({ label: escapeHtml(a.name), amount: naturalBalance(a) }))
    .concat(unclassifiedCr.map(a => ({ label: `${escapeHtml(a.name)} (unclassified)`, amount: -a.net, style: flag })));
  const totalLiabilities = liabilityRows.reduce((s, r) => s + r.amount, 0);

  const assetRows = assets.map(a => ({ label: escapeHtml(a.name), amount: naturalBalance(a) }))
    .concat(unclassifiedDr.map(a => ({ label: `${escapeHtml(a.name)} (unclassified)`, amount: a.net, style: flag })));
  const totalAssets = assetRows.reduce((s, r) => s + r.amount, 0);

  const totalEquityAndLiabilities = totalEquity + totalLiabilities;
  const diff = totalAssets - totalEquityAndLiabilities;

  let html = stmtHeader('fa-landmark', 'var(--badge-amber-text)', 'Balance Sheet', `As on ${formatDateIndian(asOnDate)}`) +
    stmtUnclassifiedWarning(accounts) + `
    <table style="width:100%; max-width:640px; border-collapse:collapse; font-size:0.88rem; text-align:left;">
      <thead>
        <tr style="border-bottom:2px solid var(--border-color);">
          <th style="${STMT_TD}">Particulars</th>
          <th style="${STMT_TD_R}">Amount (₹)</th>
        </tr>
      </thead>
      <tbody>` +
    stmtSection('Equity / Capital', equityRows, 'Total Equity (A)', totalEquity) +
    stmtSection('Liabilities', liabilityRows, 'Total Liabilities (B)', totalLiabilities) + `
        <tr style="background:var(--bg-tertiary); font-weight:800; border-top:2px solid var(--border-color);">
          <td style="${STMT_TD}">TOTAL EQUITY &amp; LIABILITIES (A + B)</td>
          <td style="${STMT_TD_R}">${formatINR(totalEquityAndLiabilities)}</td>
        </tr>
        <tr><td colspan="2" style="height:10px;"></td></tr>` +
    stmtSection('Assets', assetRows, 'TOTAL ASSETS', totalAssets) + `
      </tbody>
    </table>
    <div style="margin-top:10px; font-size:0.86rem; font-weight:600; color:${diff === 0 ? 'var(--receipt-color)' : 'var(--payment-color)'};">
      ${diff === 0 ? '<i class="fa-solid fa-circle-check"></i> Assets equal Equity + Liabilities.' : `<i class="fa-solid fa-circle-xmark"></i> Difference of ${formatINR(Math.abs(diff))}. Check for entries with a missing debit or credit account.`}
    </div>` +
    stmtFootnote('Continuous books: revenue and expenditure are not closed by entries — their net to this date appears as the accumulated surplus/deficit under Equity. Record opening balances as a Journal (e.g. Dr Bank, Cr Capital). A simple personal statement, not in Schedule III format.');
  container.innerHTML = html;
}

function renderSchedulesReport(container, fromDate, toDate) {
  const tagSelect = document.getElementById('reportTagSelect');
  const targetTagId = tagSelect ? tagSelect.value : 'all';

  let schedulesMap = getSchedulesMap(fromDate, toDate);
  let allSchs = [];

  Object.keys(schedulesMap).forEach(d => {
    schedulesMap[d].forEach(s => allSchs.push(s));
  });

  if (targetTagId !== 'all') {
    allSchs = allSchs.filter(s => (s.tags || []).some(t => t.id === targetTagId));
  }

  if (allSchs.length === 0) {
    container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-muted);">No schedules found for the selected date range and tag filter.</div>`;
    return;
  }

  let html = `
    <div style="margin-bottom:14px; display:flex; justify-content:space-between; align-items:center;">
      <h4 style="margin:0; font-size:1rem; color:var(--text-main);"><i class="fa-solid fa-calendar-check" style="color:var(--accent-blue);"></i> Schedule & Travel Report (${formatDateIndian(fromDate)} to ${formatDateIndian(toDate)})</h4>
      <span style="font-size:0.85rem; color:var(--receipt-color); font-weight:600;">Total Schedules: ${allSchs.length}</span>
    </div>
    <div style="display:flex; flex-direction:column; gap:10px;">
  `;

  allSchs.forEach(s => {
    const isTravel = s.title && (s.title.toLowerCase().includes('travel'));
    html += `
      <div style="background:var(--bg-secondary); border:1px solid var(--border-color); border-left:4px solid ${isTravel ? '#8b5cf6' : '#3b82f6'}; padding:12px; border-radius:6px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
          <strong style="font-size:0.95rem; color:var(--text-main);">${escapeHtml(s.title)}</strong>
          <span style="font-size:0.8rem; color:var(--text-muted); font-weight:600;">📅 ${formatDateIndian(s.schedule_date)} (${formatTimeRange(s.from_time, s.to_time)})</span>
        </div>
        <div style="font-size:0.82rem; color:var(--text-muted); margin-bottom:6px;">
          ${s.location ? `<span>📍 Location: ${escapeHtml(s.location)}</span> • ` : ''}
          <span>Mode: <strong>${(s.delivery_mode || 'offline').toUpperCase()}</strong></span>
          ${s.is_completed ? ' • <span style="color:var(--receipt-color); font-weight:600;">✓ Completed</span>' : ' • <span style="color:var(--badge-amber-text);">Planned</span>'}
        </div>
        ${s.notes ? `<div style="font-size:0.82rem; color:var(--text-main); background:var(--bg-tertiary); padding:6px; border-radius:4px; margin-top:4px;">📝 ${escapeHtml(s.notes)}</div>` : ''}
      </div>
    `;
  });

  html += `</div>`;
  container.innerHTML = html;
}

function renderTicketCostReport(container, fromDate, toDate) {
  const tagSelect = document.getElementById('reportTagSelect');
  const targetTagId = tagSelect ? tagSelect.value : 'all';

  let ticketEntries = [];
  const processedKeys = new Set();

  if (!db) {
    container.innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-muted);">Database not available.</div>';
    return;
  }

  try {
    const res = db.exec("SELECT * FROM schedules WHERE travel_info IS NOT NULL AND travel_info != '' ORDER BY schedule_date ASC");
    if (res && res.length > 0) {
      const rows = rowsToObjects(res[0]);
      rows.forEach(s => {
        if (targetTagId !== 'all') {
          const stRes = db.exec("SELECT tag_id FROM schedule_tags WHERE schedule_id = ?", [s.id]);
          let hasTag = false;
          if (stRes && stRes.length > 0) {
            hasTag = stRes[0].values.some(v => v[0] === targetTagId);
          }
          if (!hasTag) return;
        }

        try {
          const tInfo = JSON.parse(s.travel_info);
          if (!tInfo) return;

          // 1. ONWARD TICKET
          if (tInfo.onward && tInfo.onward.enabled) {
            const o = tInfo.onward;
            const amt = toPaise(o.amount);
            const depDate = o.fromDate || s.schedule_date;
            const arrDate = o.toDate || depDate;

            if (depDate >= fromDate && depDate <= toDate) {
              const pnr = (o.pnr || '').trim();
              const uniqueKey = (s.group_id ? s.group_id : s.id) + '_onward_' + (pnr || (o.fromPlace + '_' + o.toPlace + '_' + depDate));

              if (!processedKeys.has(uniqueKey)) {
                processedKeys.add(uniqueKey);
                ticketEntries.push({
                  type: 'onward',
                  fromDate: depDate,
                  fromTime: o.depTime || '09:00',
                  toDate: arrDate,
                  toTime: o.arrTime || '18:00',
                  fromPlace: o.fromPlace || 'Origin',
                  toPlace: o.toPlace || 'Destination',
                  mode: o.mode || 'Travel',
                  details: o.details || '',
                  pnr: pnr,
                  amount: amt,
                  isReimbursable: Boolean(o.reimbursable)
                });
              }
            }
          }

          // 2. RETURN TICKET
          if (tInfo.return && tInfo.return.enabled) {
            const r = tInfo.return;
            const amt = toPaise(r.amount);
            const depDate = r.fromDate || s.schedule_date;
            const arrDate = r.toDate || depDate;

            if (depDate >= fromDate && depDate <= toDate) {
              const pnr = (r.pnr || '').trim();
              const uniqueKey = (s.group_id ? s.group_id : s.id) + '_return_' + (pnr || (r.fromPlace + '_' + r.toPlace + '_' + depDate));

              if (!processedKeys.has(uniqueKey)) {
                processedKeys.add(uniqueKey);
                ticketEntries.push({
                  type: 'return',
                  fromDate: depDate,
                  fromTime: r.depTime || '09:00',
                  toDate: arrDate,
                  toTime: r.arrTime || '18:00',
                  fromPlace: r.fromPlace || 'Venue',
                  toPlace: r.toPlace || 'Home',
                  mode: r.mode || 'Travel',
                  details: r.details || '',
                  pnr: pnr,
                  amount: amt,
                  isReimbursable: Boolean(r.reimbursable)
                });
              }
            }
          }

        } catch (e) {
          console.warn('Error parsing travel_info:', e);
        }
      });
    }
  } catch (err) {
    console.error('Error reading ticket cost report schedules:', err);
  }

  ticketEntries.sort((a, b) => {
    if (a.fromDate !== b.fromDate) return a.fromDate.localeCompare(b.fromDate);
    return a.fromTime.localeCompare(b.fromTime);
  });

  if (ticketEntries.length === 0) {
    container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-muted);">No travel ticket expenditures recorded between ${formatDateIndian(fromDate)} and ${formatDateIndian(toDate)}.</div>`;
    return;
  }

  let totalReimbursable = 0;
  let totalSelf = 0;
  ticketEntries.forEach(e => {
    if (e.isReimbursable) totalReimbursable += e.amount;
    else totalSelf += e.amount;
  });
  const grandTotal = totalReimbursable + totalSelf;

  let html = `
    <div style="margin-bottom:14px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
      <h4 style="margin:0; font-size:1rem; color:var(--text-main);"><i class="fa-solid fa-ticket" style="color:#8b5cf6;"></i> Ticket Cost & Travel Expenses (${formatDateIndian(fromDate)} to ${formatDateIndian(toDate)})</h4>
      <div style="font-size:0.85rem; display:flex; gap:12px;">
        <span>Reimbursable: <strong style="color:var(--receipt-color);">${formatINR(totalReimbursable)}</strong></span>
        <span>Self-Paid: <strong style="color:var(--badge-amber-text);">${formatINR(totalSelf)}</strong></span>
        <span>Grand Total: <strong style="color:var(--net-positive);">${formatINR(grandTotal)}</strong></span>
      </div>
    </div>
    <div style="overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; font-size:0.86rem; text-align:left; min-width:700px;">
        <thead>
          <tr style="background:var(--bg-tertiary); border-bottom:2px solid var(--border-color);">
            <th style="padding:8px 10px;">From Date & Time</th>
            <th style="padding:8px 10px;">To Date & Time</th>
            <th style="padding:8px 10px;">Journey / Route</th>
            <th style="padding:8px 10px;">Mode & Details</th>
            <th style="padding:8px 10px;">PNR No.</th>
            <th style="padding:8px 10px; text-align:right;">Ticket Cost (₹)</th>
            <th style="padding:8px 10px; text-align:center;">Reimbursable Status</th>
          </tr>
        </thead>
        <tbody>
  `;

  ticketEntries.forEach(e => {
    const fromDtStr = `${formatDateIndian(e.fromDate)} ${e.fromTime}`;
    const toDtStr = `${formatDateIndian(e.toDate)} ${e.toTime}`;
    const routeStr = `${escapeHtml(e.fromPlace)} ➔ ${escapeHtml(e.toPlace)} (${e.type === 'onward' ? 'Onward' : 'Return'})`;
    const modeStr = `${escapeHtml(e.mode)}${e.details ? ' - ' + escapeHtml(e.details) : ''}`;
    const pnrBadge = e.pnr ? `<code style="background:var(--bg-tertiary); padding:2px 6px; border-radius:4px; font-weight:600;">${escapeHtml(e.pnr)}</code>` : '<span style="color:var(--text-muted);">-</span>';

    html += `
      <tr style="border-bottom:1px solid var(--border-color);">
        <td style="padding:8px 10px; font-weight:600; white-space:nowrap;">${fromDtStr}</td>
        <td style="padding:8px 10px; white-space:nowrap; color:var(--text-muted);">${toDtStr}</td>
        <td style="padding:8px 10px; font-weight:600; color:var(--text-main);">${routeStr}</td>
        <td style="padding:8px 10px; color:var(--text-muted);">${modeStr}</td>
        <td style="padding:8px 10px;">${pnrBadge}</td>
        <td style="padding:8px 10px; text-align:right; font-weight:700; color:var(--net-positive);">${formatINR(e.amount)}</td>
        <td style="padding:8px 10px; text-align:center;">
          ${e.isReimbursable ? '<span style="color:var(--receipt-color); background:var(--badge-green-bg); border:1px solid var(--badge-green-border); padding:2px 8px; border-radius:4px; font-weight:600;">🟢 Reimbursable</span>' : '<span style="color:var(--text-muted); background:var(--bg-tertiary); padding:2px 8px; border-radius:4px;">⚪ Self-Paid</span>'}
        </td>
      </tr>
    `;
  });

  html += `
        </tbody>
        <tfoot style="background:var(--bg-tertiary); font-weight:700; border-top:2px solid var(--border-color);">
          <tr>
            <td colspan="5" style="padding:10px; text-align:right;">TOTAL EXPENDITURE SUMMARY</td>
            <td style="padding:10px; text-align:right; color:var(--net-positive); font-size:0.95rem;">${formatINR(grandTotal)}</td>
            <td style="padding:10px; text-align:center; font-size:0.8rem;">
              <span style="color:var(--receipt-color); font-weight:600;">Reimbursable: ${formatINR(totalReimbursable)}</span><br>
              <span style="color:var(--badge-amber-text); font-weight:600;">Self-Paid: ${formatINR(totalSelf)}</span>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  `;

  container.innerHTML = html;
}

/* ==========================================================================
   PDF & ATTACHMENT TO PNG IMAGE CONVERSION PIPELINE FOR PRINTING
   ========================================================================== */

async function convertAttachmentToImageDataUrl(att) {
  if (!att) return null;
  let rawData = att.data;
  const fileName = (att.name || att.filename || '').toLowerCase();
  const fileType = (att.type || '').toLowerCase();

  if (!rawData) {
    if (att.id) {
      try {
        rawData = await loadAttachmentFromIndexedDB(att.id);
      } catch(e){}
    }
    if (!rawData && att.filename) {
      try {
        rawData = await loadAttachmentFromIndexedDB(att.filename);
      } catch(e){}
    }
  }

  if (!rawData) return null;

  if (typeof rawData === 'string') {
    if (rawData.startsWith('data:image/') || rawData.startsWith('http://') || rawData.startsWith('https://')) {
      return rawData;
    } else if (rawData.startsWith('data:application/pdf') || fileName.endsWith('.pdf') || fileType.includes('pdf')) {
      return await renderPdfDataUrlToImage(rawData);
    }
  }

  return null;
}

async function renderPdfDataUrlToImage(dataUrl) {
  if (typeof pdfjsLib === 'undefined') return null;
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.js';
    
    let base64Str = dataUrl;
    if (dataUrl.includes(',')) base64Str = dataUrl.split(',')[1];

    const binaryStr = atob(base64Str);
    const len = binaryStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    return await renderPdfArrayBufferToImage(bytes.buffer);
  } catch (err) {
    console.warn('PDF data URL render error:', err);
    return null;
  }
}

// Renders up to maxPages pages of a PDF into container as canvases scaled to its width. Returns false on failure.
async function renderPdfIntoContainer(bytes, container, maxPages = 10) {
  if (typeof pdfjsLib === 'undefined' || !bytes) return false;
  pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
  if (!pdf.numPages) return false;
  const width = Math.max(280, (container.clientWidth || 600) - 8);
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const pages = [];
  for (let n = 1; n <= Math.min(pdf.numPages, maxPages); n++) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (width / base.width) * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.cssText = 'width:100%; height:auto; display:block; margin:0 auto 10px; background:#fff; border-radius:var(--radius-sm); box-shadow:var(--shadow-md);';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `PDF page ${n} of ${pdf.numPages}`);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    pages.push(canvas);
  }
  container.innerHTML = '';
  pages.forEach(c => container.appendChild(c));
  if (pdf.numPages > maxPages) {
    const note = document.createElement('div');
    note.style.cssText = 'font-size:0.8rem; color:var(--text-muted); padding:6px;';
    note.textContent = `Showing ${maxPages} of ${pdf.numPages} pages — use Download for the full document.`;
    container.appendChild(note);
  }
  return true;
}

async function renderPdfArrayBufferToImage(arrayBuffer) {
  if (typeof pdfjsLib === 'undefined' || !arrayBuffer) return null;
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.js';
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer, isEvalSupported: false });
    const pdf = await loadingTask.promise;
    if (pdf.numPages === 0) return null;

    const page = await pdf.getPage(1); // Render page 1 of ticket PDF
    const viewport = page.getViewport({ scale: 1.8 }); // Crisp high-res scale

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.height = viewport.height;
    canvas.width = viewport.width;

    const renderContext = {
      canvasContext: context,
      viewport: viewport
    };

    await page.render(renderContext).promise;
    return canvas.toDataURL('image/png');
  } catch (err) {
    console.warn('PDF ArrayBuffer render error:', err);
    return null;
  }
}

let activeClaimSelectedKeys = new Set();

async function renderTicketClaimReport(container, fromDate, toDate) {
  const tagSelect = document.getElementById('reportTagSelect');
  const targetTagId = tagSelect ? tagSelect.value : 'all';

  if (!db) {
    container.innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-muted);">Database not available.</div>';
    return;
  }

  let ticketEntries = [];
  const processedKeys = new Set();

  try {
    const res = db.exec("SELECT * FROM schedules WHERE travel_info IS NOT NULL AND travel_info != '' ORDER BY schedule_date ASC");
    if (res && res.length > 0) {
      const rows = rowsToObjects(res[0]);
      rows.forEach(s => {
        if (targetTagId !== 'all') {
          const stRes = db.exec("SELECT tag_id FROM schedule_tags WHERE schedule_id = ?", [s.id]);
          let hasTag = false;
          if (stRes && stRes.length > 0) {
            hasTag = stRes[0].values.some(v => v[0] === targetTagId);
          }
          if (!hasTag) return;
        }

        try {
          const tInfo = JSON.parse(s.travel_info);
          if (!tInfo) return;

          // 1. ONWARD TICKET
          if (tInfo.onward && tInfo.onward.enabled) {
            const o = tInfo.onward;
            const amt = toPaise(o.amount);
            const depDate = o.fromDate || s.schedule_date;
            const arrDate = o.toDate || depDate;

            if (depDate >= fromDate && depDate <= toDate) {
              const pnr = (o.pnr || '').trim();
              const uniqueKey = (s.group_id ? s.group_id : s.id) + '_onward_' + (pnr || (o.fromPlace + '_' + o.toPlace + '_' + depDate));

              if (!processedKeys.has(uniqueKey)) {
                processedKeys.add(uniqueKey);
                ticketEntries.push({
                  key: uniqueKey,
                  type: 'onward',
                  fromDate: depDate,
                  fromTime: o.depTime || '09:00',
                  toDate: arrDate,
                  toTime: o.arrTime || '18:00',
                  fromPlace: o.fromPlace || 'Origin',
                  toPlace: o.toPlace || 'Destination',
                  mode: o.mode || 'Travel',
                  details: o.details || '',
                  pnr: pnr,
                  amount: amt,
                  isReimbursable: Boolean(o.reimbursable),
                  attachment: o.attachment || null,
                  scheduleTitle: s.title
                });
              }
            }
          }

          // 2. RETURN TICKET
          if (tInfo.return && tInfo.return.enabled) {
            const r = tInfo.return;
            const amt = toPaise(r.amount);
            const depDate = r.fromDate || s.schedule_date;
            const arrDate = r.toDate || depDate;

            if (depDate >= fromDate && depDate <= toDate) {
              const pnr = (r.pnr || '').trim();
              const uniqueKey = (s.group_id ? s.group_id : s.id) + '_return_' + (pnr || (r.fromPlace + '_' + r.toPlace + '_' + depDate));

              if (!processedKeys.has(uniqueKey)) {
                processedKeys.add(uniqueKey);
                ticketEntries.push({
                  key: uniqueKey,
                  type: 'return',
                  fromDate: depDate,
                  fromTime: r.depTime || '09:00',
                  toDate: arrDate,
                  toTime: r.arrTime || '18:00',
                  fromPlace: r.fromPlace || 'Venue',
                  toPlace: r.toPlace || 'Home',
                  mode: r.mode || 'Travel',
                  details: r.details || '',
                  pnr: pnr,
                  amount: amt,
                  isReimbursable: Boolean(r.reimbursable),
                  attachment: r.attachment || null,
                  scheduleTitle: s.title
                });
              }
            }
          }

        } catch (e) {
          console.warn('Error parsing travel_info for ticket claim:', e);
        }
      });
    }
  } catch (err) {
    console.error('Error querying schedules for ticket claim report:', err);
  }

  ticketEntries.sort((a, b) => {
    if (a.fromDate !== b.fromDate) return a.fromDate.localeCompare(b.fromDate);
    return a.fromTime.localeCompare(b.fromTime);
  });

  if (ticketEntries.length === 0) {
    container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-muted);">No travel tickets found between ${formatDateIndian(fromDate)} and ${formatDateIndian(toDate)} matching your filters.</div>`;
    return;
  }

  // Pre-select reimbursable tickets if activeClaimSelectedKeys is empty or on first load
  if (activeClaimSelectedKeys.size === 0) {
    ticketEntries.forEach(e => {
      if (e.isReimbursable && e.amount > 0) {
        activeClaimSelectedKeys.add(e.key);
      }
    });
    if (activeClaimSelectedKeys.size === 0) {
      ticketEntries.forEach(e => {
        if (e.amount > 0) activeClaimSelectedKeys.add(e.key);
      });
    }
  }

  // Load & convert Base64/PDF attachment data to PNG Data URLs for all tickets in parallel
  for (const item of ticketEntries) {
    if (item.attachment) {
      try {
        item.renderedImageDataUrl = await convertAttachmentToImageDataUrl(item.attachment);
      } catch(e) {
        console.warn('Error converting attachment to image:', e);
      }
    }
  }

  function renderClaimContent() {
    const selectedTickets = ticketEntries.filter(e => activeClaimSelectedKeys.has(e.key));
    let claimTotal = 0;
    selectedTickets.forEach(e => claimTotal += e.amount);

    let html = `
      <!-- TICKET SELECTION TOOLBAR (HIDDEN IN PRINT) -->
      <div class="no-print" style="background:var(--bg-tertiary); padding:12px; border-radius:var(--radius-md); border:1px solid var(--border-color); margin-bottom:18px;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:10px;">
          <h4 style="margin:0; font-size:0.92rem; color:var(--text-main);"><i class="fa-solid fa-list-check" style="color:var(--accent-blue);"></i> Select Tickets for Claim Statement (${selectedTickets.length} / ${ticketEntries.length} Selected)</h4>
          <div style="display:flex; gap:8px;">
            <button type="button" class="btn-secondary btn-xs" id="claimSelectReimbBtn"><i class="fa-solid fa-circle-check" style="color:var(--receipt-color);"></i> Select Reimbursable Only</button>
            <button type="button" class="btn-secondary btn-xs" id="claimSelectAllBtn">Select All</button>
            <button type="button" class="btn-secondary btn-xs" id="claimDeselectAllBtn">Deselect All</button>
          </div>
        </div>

        <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap:8px; max-height:180px; overflow-y:auto; padding:4px;">
    `;

    ticketEntries.forEach(e => {
      const isChecked = activeClaimSelectedKeys.has(e.key);
      const hasAttachment = Boolean(e.attachment && (e.renderedImageDataUrl || e.attachment.data || e.attachment.filename));
      html += `
        <label style="display:flex; align-items:flex-start; gap:8px; background:var(--bg-primary); padding:8px 10px; border-radius:6px; border:1px solid ${isChecked ? 'var(--accent-blue)' : 'var(--border-color)'}; cursor:pointer; font-size:0.8rem;">
          <input type="checkbox" class="claim-ticket-chk" data-key="${e.key}" ${isChecked ? 'checked' : ''} style="margin-top:2px;">
          <div style="flex:1;">
            <div style="font-weight:600; color:var(--text-main);">${formatDateIndian(e.fromDate)} &bull; ${escapeHtml(e.fromPlace)} ➔ ${escapeHtml(e.toPlace)}</div>
            <div style="color:var(--text-muted); font-size:0.75rem;">
              ${escapeHtml(e.mode)} ${e.pnr ? '| PNR:' + escapeHtml(e.pnr) : ''}
              ${hasAttachment ? '<span style="color:var(--accent-blue); margin-left:4px;"><i class="fa-solid fa-paperclip"></i> Ticket Proof Attached</span>' : ''}
            </div>
          </div>
          <div style="text-align:right;">
            <strong style="color:var(--net-positive);">${formatINR(e.amount)}</strong>
            <div style="font-size:0.7rem; color:${e.isReimbursable ? 'var(--receipt-color)' : 'var(--text-muted)'};">${e.isReimbursable ? '🟢 Reimbursable' : '⚪ Self'}</div>
          </div>
        </label>
      `;
    });

    html += `
        </div>
      </div>

      <!-- FORMAL PRINTABLE STATEMENT OF CLAIM -->
      <div id="printableClaimStatement" style="background:#ffffff; color:#0f172a; padding:24px; border-radius:8px; border:1px solid #cbd5e1; font-family:system-ui,-apple-system,sans-serif;">
        
        <!-- Header -->
        <div style="text-align:center; border-bottom:2px solid #0f172a; padding-bottom:12px; margin-bottom:16px;">
          <h2 style="margin:0 0 4px 0; font-size:1.3rem; color:#0f172a; letter-spacing:0.5px; text-transform:uppercase;">Statement of Claim for Travel Reimbursement</h2>
          <div style="font-size:0.85rem; color:#475569; font-weight:600;">SRG Calendar Pro &bull; Official Expenditure Reimbursement Voucher</div>
          <div style="font-size:0.8rem; color:#64748b; margin-top:4px;">
            Claim Period: <strong>${formatDateIndian(fromDate)}</strong> to <strong>${formatDateIndian(toDate)}</strong> &nbsp;|&nbsp; Date of Submission: <strong>${formatDateIndian(formatDateYMD(new Date()))}</strong>
          </div>
        </div>

        <!-- Summary Bar -->
        <div style="display:flex; justify-content:space-between; align-items:center; background:#f8fafc; padding:10px 14px; border-radius:6px; border:1px solid #e2e8f0; margin-bottom:16px; font-size:0.88rem;">
          <div>Total Selected Tickets: <strong>${selectedTickets.length}</strong></div>
          <div>Total Reimbursement Claimed: <strong style="font-size:1.1rem; color:#2563eb;">${formatINR(claimTotal)}</strong></div>
        </div>
    `;

    if (selectedTickets.length === 0) {
      html += `
        <div style="text-align:center; padding:40px; color:#64748b;">No tickets selected for claim. Please check one or more tickets above.</div>
      `;
    } else {
      html += `
        <table style="width:100%; border-collapse:collapse; font-size:0.85rem; margin-bottom:20px; text-align:left;">
          <thead>
            <tr style="background:#f1f5f9; border-bottom:2px solid #94a3b8; color:#0f172a;">
              <th style="padding:8px; width:35px; text-align:center;">#</th>
              <th style="padding:8px;">Journey Date & Time</th>
              <th style="padding:8px;">Sector / Route</th>
              <th style="padding:8px;">Mode & Details</th>
              <th style="padding:8px;">PNR / Reference</th>
              <th style="padding:8px; text-align:center;">Evidence</th>
              <th style="padding:8px; text-align:right;">Claim Amount (₹)</th>
            </tr>
          </thead>
          <tbody>
      `;

      let slNo = 1;
      let annexureCount = 0;
      selectedTickets.forEach(e => {
        const hasAtt = Boolean(e.attachment && (e.renderedImageDataUrl || e.attachment.data || e.attachment.filename));
        let annexureLabel = '-';
        if (hasAtt) {
          annexureCount++;
          annexureLabel = `Annexure ${String.fromCharCode(64 + annexureCount)}`;
          e.annexureLabel = annexureLabel;
        } else {
          e.annexureLabel = null;
        }

        html += `
          <tr style="border-bottom:1px solid #e2e8f0;">
            <td style="padding:8px; text-align:center; font-weight:600;">${slNo++}</td>
            <td style="padding:8px; font-weight:600; white-space:nowrap;">${formatDateIndian(e.fromDate)} <span style="font-size:0.78rem; color:#64748b;">${e.fromTime}</span></td>
            <td style="padding:8px; font-weight:600;">${escapeHtml(e.fromPlace)} ➔ ${escapeHtml(e.toPlace)} <span style="font-size:0.75rem; color:#475569;">(${e.type === 'onward' ? 'Onward' : 'Return'})</span></td>
            <td style="padding:8px; color:#334155;">${escapeHtml(e.mode)}${e.details ? ' (' + escapeHtml(e.details) + ')' : ''}</td>
            <td style="padding:8px;"><code style="background:#f1f5f9; padding:2px 6px; border-radius:3px; font-size:0.8rem; color:#0f172a; font-weight:600;">${escapeHtml(e.pnr || '-')}</code></td>
            <td style="padding:8px; text-align:center; font-size:0.78rem; font-weight:600; color:${hasAtt ? '#0284c7' : '#94a3b8'};">${hasAtt ? '📎 ' + annexureLabel : 'No Attachment'}</td>
            <td style="padding:8px; text-align:right; font-weight:700; color:#0f172a;">${formatINR(e.amount)}</td>
          </tr>
        `;
      });

      html += `
          </tbody>
          <tfoot style="background:#f8fafc; font-weight:700; border-top:2px solid #0f172a;">
            <tr>
              <td colspan="6" style="padding:10px; text-align:right; text-transform:uppercase;">Total Amount Claimed:</td>
              <td style="padding:10px; text-align:right; color:#2563eb; font-size:1.05rem;">${formatINR(claimTotal)}</td>
            </tr>
          </tfoot>
        </table>

        <!-- Declaration & Signatures -->
        <div style="margin-top:24px; padding:12px; background:#f8fafc; border-radius:6px; border:1px solid #e2e8f0; font-size:0.8rem; color:#334155; line-height:1.4;">
          <strong>Declaration:</strong> I hereby certify that the travel expenses claimed above were actually incurred by me for official business travel in connection with the programs listed, and no previous claim has been preferred for the same.
        </div>

        <div style="display:flex; justify-content:space-between; margin-top:50px; padding-top:10px; font-size:0.85rem; color:#0f172a;">
          <div style="text-align:center; width:200px;">
            <div style="border-bottom:1px solid #0f172a; margin-bottom:6px; height:30px;"></div>
            <strong>Signature of Claimant</strong><br>
            <span style="font-size:0.75rem; color:#64748b;">Date: ${formatDateIndian(formatDateYMD(new Date()))}</span>
          </div>
          <div style="text-align:center; width:200px;">
            <div style="border-bottom:1px solid #0f172a; margin-bottom:6px; height:30px;"></div>
            <strong>Verified & Approved By</strong><br>
            <span style="font-size:0.75rem; color:#64748b;">Finance / Controlling Authority</span>
          </div>
        </div>
      `;

      // Render Attached Ticket Vouchers / Evidence Annexure (1 ticket per page)
      const attachedTickets = selectedTickets.filter(e => e.attachment && (e.renderedImageDataUrl || e.attachment.data || e.attachment.filename));
      if (attachedTickets.length > 0) {
        html += `
          <div style="page-break-before:always; margin-top:30px; border-top:2px dashed #94a3b8; padding-top:20px;">
            <h3 style="margin:0 0 16px 0; font-size:1.1rem; color:#0f172a; text-transform:uppercase;"><i class="fa-solid fa-paperclip"></i> Annexure: Attached Ticket Proofs & Vouchers</h3>
        `;

        attachedTickets.forEach(e => {
          const att = e.attachment;
          const imgUrl = e.renderedImageDataUrl || (att ? att.data : null);

          html += `
            <div class="page-break" style="page-break-before:always; padding-top:16px; margin-bottom:30px; page-break-inside:avoid;">
              <div style="border:1px solid #cbd5e1; border-radius:8px; padding:16px; background:#ffffff; text-align:center;">
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #cbd5e1; padding-bottom:8px; margin-bottom:12px; text-align:left;">
                  <h4 style="margin:0; font-size:0.95rem; color:#0f172a;">
                    <strong>${e.annexureLabel || 'Annexure'}</strong>: Ticket Proof for PNR <code style="background:#e2e8f0; padding:2px 6px; border-radius:4px;">${escapeHtml(e.pnr || 'N/A')}</code>
                  </h4>
                  <span style="font-size:0.8rem; color:#475569; font-weight:600;">${formatDateIndian(e.fromDate)} &bull; ${escapeHtml(e.fromPlace)} ➔ ${escapeHtml(e.toPlace)}</span>
                </div>
                
                <div style="font-size:0.82rem; color:#334155; margin-bottom:12px; text-align:left;">
                  Mode/Train: <strong>${escapeHtml(e.mode)} ${e.details ? '(' + escapeHtml(e.details) + ')' : ''}</strong> | Ticket Cost: <strong style="color:#2563eb;">${formatINR(e.amount)}</strong> | File: <em>${escapeHtml(att.name || att.filename || 'Ticket Document')}</em>
                </div>
          `;

          if (imgUrl) {
            html += `
              <div style="text-align:center; margin-top:8px;">
                <img src="${imgUrl}" style="max-width:100%; max-height:850px; border:1px solid #cbd5e1; border-radius:4px; box-shadow:0 2px 10px rgba(0,0,0,0.1);" alt="Ticket Proof Image">
              </div>
            `;
          } else {
            html += `
              <div style="color:#64748b; font-size:0.85rem; font-style:italic; padding:20px; background:#f8fafc; border-radius:4px;">
                Ticket voucher recorded electronically for PNR ${escapeHtml(e.pnr || 'N/A')}.
              </div>
            `;
          }

          html += `</div></div>`;
        });

        html += `</div>`;
      }
    }

    html += `</div>`;
    container.innerHTML = html;

    const chks = container.querySelectorAll('.claim-ticket-chk');
    chks.forEach(chk => {
      chk.addEventListener('change', (e) => {
        const k = e.target.dataset.key;
        if (e.target.checked) activeClaimSelectedKeys.add(k);
        else activeClaimSelectedKeys.delete(k);
        renderClaimContent();
      });
    });

    const selectReimbBtn = container.querySelector('#claimSelectReimbBtn');
    if (selectReimbBtn) {
      selectReimbBtn.addEventListener('click', () => {
        activeClaimSelectedKeys.clear();
        ticketEntries.forEach(e => {
          if (e.isReimbursable && e.amount > 0) activeClaimSelectedKeys.add(e.key);
        });
        renderClaimContent();
      });
    }

    const selectAllBtn = container.querySelector('#claimSelectAllBtn');
    if (selectAllBtn) {
      selectAllBtn.addEventListener('click', () => {
        activeClaimSelectedKeys.clear();
        ticketEntries.forEach(e => activeClaimSelectedKeys.add(e.key));
        renderClaimContent();
      });
    }

    const deselectAllBtn = container.querySelector('#claimDeselectAllBtn');
    if (deselectAllBtn) {
      deselectAllBtn.addEventListener('click', () => {
        activeClaimSelectedKeys.clear();
        renderClaimContent();
      });
    }
  }

  renderClaimContent();
}

function printCurrentReport() {
  const content = document.getElementById('reportOutputContainer').innerHTML;
  const win = window.open('', '_blank', 'width=950,height=750');
  win.document.write(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Calendar App - Official Report Statement</title>
        <style>
          body { font-family: system-ui, -apple-system, sans-serif; padding: 25px; color: #0f172a; background: #fff; }
          table { width: 100%; border-collapse: collapse; margin-top: 15px; }
          th, td { padding: 8px 10px; border: 1px solid #cbd5e1; text-align: left; font-size: 13px; }
          th { background: #f1f5f9; font-weight: bold; }
          h4 { margin-top: 0; color: #0f172a; }
          .today-badge { display: none; }
          .no-print { display: none !important; }
          .page-break { page-break-before: always; }
          img { max-width: 100% !important; height: auto !important; page-break-inside: avoid; }
        </style>
      </head>
      <body>
        ${content}
      </body>
    </html>
  `);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 400);
}

/* ==========================================================================
   PRINT / PDF EXPORT ENGINE (WALL CALENDAR GRID & DIARY TABLE)
   ========================================================================== */

function openPrintMonthModal() {
  const modal = document.getElementById('printMonthModal');
  const title = document.getElementById('printMonthTitle');
  if (title) {
    title.textContent = currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
  if (modal) modal.classList.remove('hidden');
}

function closePrintMonthModal() {
  const modal = document.getElementById('printMonthModal');
  if (modal) modal.classList.add('hidden');
}

function printMonthCalendar(layout = 'grid') {
  if (!db) return;
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const monthName = currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const firstDayOfMonth = new Date(year, month, 1);
  const lastDayOfMonth = new Date(year, month + 1, 0);
  const startDateStr = formatDateYMD(firstDayOfMonth);
  const endDateStr = formatDateYMD(lastDayOfMonth);
  const totalDays = lastDayOfMonth.getDate();

  const schedulesMap = getSchedulesMap(startDateStr, endDateStr);

  const win = window.open('', '_blank', 'width=1150,height=800');
  if (!win) {
    alert('Please allow popups to open the printable calendar.');
    return;
  }

  let htmlContent = '';

  if (layout === 'grid') {
    // 7-Column Wall Calendar Grid (Landscape)
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    let gridRowsHtml = '';

    const firstDayWeekday = firstDayOfMonth.getDay(); // 0 is Sunday
    let currentDayNum = 1;
    let finished = false;

    while (!finished) {
      gridRowsHtml += '<tr>';
      for (let w = 0; w < 7; w++) {
        if (currentDayNum === 1 && w < firstDayWeekday) {
          // Leading empty cell
          gridRowsHtml += '<td class="empty-cell"></td>';
        } else if (currentDayNum > totalDays) {
          // Trailing empty cell
          gridRowsHtml += '<td class="empty-cell"></td>';
          finished = true;
        } else {
          const dStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(currentDayNum).padStart(2, '0')}`;
          const evList = schedulesMap[dStr] || [];
          
          let evItemsHtml = '';
          evList.forEach(ev => {
            const isTravel = ev.title.toLowerCase().startsWith('travel:') || ev.title.toLowerCase().startsWith('return travel:');
            const icon = isTravel ? '🚆 ' : '• ';
            const timeStr = ev.from_time ? `<span class="ev-time">${escapeHtml(ev.from_time)}</span>` : '';
            evItemsHtml += `
              <div class="ev-item ${isTravel ? 'ev-travel' : ''}">
                ${timeStr} <strong>${icon}${escapeHtml(ev.title)}</strong>
                ${ev.location ? `<div class="ev-loc">${escapeHtml(ev.location)}</div>` : ''}
              </div>
            `;
          });

          gridRowsHtml += `
            <td class="cal-day-cell">
              <div class="day-number">${currentDayNum}</div>
              <div class="day-events-wrap">${evItemsHtml}</div>
            </td>
          `;
          currentDayNum++;
          if (currentDayNum > totalDays && w === 6) {
            finished = true;
          }
        }
      }
      gridRowsHtml += '</tr>';
    }

    htmlContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>${monthName} - Monthly Wall Calendar Grid</title>
          <style>
            @page { size: landscape; margin: 8mm; }
            * { box-sizing: border-box; }
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; margin: 0; padding: 12px; color: #0f172a; background: #fff; }
            .cal-header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 10px; border-bottom: 2px solid #0284c7; padding-bottom: 6px; }
            .cal-title { font-size: 24px; font-weight: 800; color: #0369a1; margin: 0; }
            .cal-meta { font-size: 11px; color: #64748b; }
            table.cal-grid { width: 100%; border-collapse: collapse; table-layout: fixed; }
            th { background: #f8fafc; color: #334155; font-size: 12px; font-weight: 700; text-transform: uppercase; padding: 8px 4px; border: 1px solid #cbd5e1; text-align: center; }
            th.weekend { background: #f1f5f9; color: #475569; }
            td { border: 1px solid #cbd5e1; vertical-align: top; height: 110px; padding: 4px; }
            td.empty-cell { background: #f8fafc; }
            td.cal-day-cell { background: #ffffff; }
            .day-number { font-size: 13px; font-weight: 700; color: #1e293b; margin-bottom: 4px; }
            .day-events-wrap { display: flex; flex-direction: column; gap: 3px; max-height: 90px; overflow: hidden; }
            .ev-item { font-size: 9.5px; line-height: 1.25; padding: 2px 4px; border-radius: 3px; background: #f1f5f9; border-left: 3px solid #2563eb; color: #0f172a; }
            .ev-item.ev-travel { background: #fef3c7; border-left-color: #d97706; color: #78350f; }
            .ev-time { font-weight: 600; color: #475569; margin-right: 2px; }
            .ev-loc { font-size: 8.5px; color: #64748b; margin-top: 1px; }
            @media print {
              body { padding: 0; }
              td { height: 105px !important; }
              .day-events-wrap { max-height: none !important; }
            }
          </style>
        </head>
        <body>
          <div class="cal-header">
            <div>
              <h1 class="cal-title">${monthName}</h1>
              <div class="cal-meta">Calendar App &bull; Monthly Wall Calendar Sheet</div>
            </div>
            <div class="cal-meta" style="text-align: right;">
              Printed on ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
            </div>
          </div>
          <table class="cal-grid">
            <thead>
              <tr>
                ${weekdays.map((wd, i) => `<th class="${(i === 0 || i === 6) ? 'weekend' : ''}">${wd}</th>`).join('')}
              </tr>
            </thead>
            <tbody>
              ${gridRowsHtml}
            </tbody>
          </table>
        </body>
      </html>
    `;
  } else {
    // 30-Day Detailed Diary Table (Portrait)
    let rowsHtml = '';
    for (let d = 1; d <= totalDays; d++) {
      const dDate = new Date(year, month, d);
      const dStr = formatDateYMD(dDate);
      const weekdayStr = dDate.toLocaleDateString('en-US', { weekday: 'short' });
      const evList = schedulesMap[dStr] || [];

      if (evList.length === 0) {
        rowsHtml += `
          <tr class="empty-day-row">
            <td class="date-col"><strong>${String(d).padStart(2, '0')} ${monthName.split(' ')[0].substr(0, 3)}</strong><br><small>${weekdayStr}</small></td>
            <td colspan="5" class="no-events-text">— No scheduled programs —</td>
          </tr>
        `;
      } else {
        evList.forEach((ev, idx) => {
          const isTravel = ev.title.toLowerCase().startsWith('travel:') || ev.title.toLowerCase().startsWith('return travel:');
          let travelDetails = '—';
          if (ev.travel_info) {
            try {
              const ti = JSON.parse(ev.travel_info);
              if (ti.onward && ti.onward.enabled) {
                travelDetails = `Onward: ${ti.onward.mode} (${ti.onward.fromPlace} -> ${ti.onward.toPlace}) ${ti.onward.pnr ? 'PNR: ' + ti.onward.pnr : ''}`;
              } else if (ti.return && ti.return.enabled) {
                travelDetails = `Return: ${ti.return.mode} (${ti.return.fromPlace} -> ${ti.return.toPlace}) ${ti.return.pnr ? 'PNR: ' + ti.return.pnr : ''}`;
              }
            } catch(e) {}
          } else if (isTravel) {
            travelDetails = ev.notes || 'Travel in transit';
          }

          rowsHtml += `
            <tr class="${isTravel ? 'travel-row' : ''}">
              ${idx === 0 ? `<td class="date-col" rowspan="${evList.length}"><strong>${String(d).padStart(2, '0')} ${monthName.split(' ')[0].substr(0, 3)}</strong><br><small>${weekdayStr}</small></td>` : ''}
              <td class="title-col">
                <strong>${escapeHtml(ev.title)}</strong>
                ${ev.notes ? `<div class="sub-notes">${escapeHtml(ev.notes)}</div>` : ''}
              </td>
              <td class="time-col">${escapeHtml(formatTimeRange(ev.from_time, ev.to_time))}</td>
              <td class="loc-col">${escapeHtml(ev.location || ev.delivery_mode || '—')}</td>
              <td class="travel-col">${escapeHtml(travelDetails)}</td>
              <td class="status-col"><span class="badge ${ev.status}">${escapeHtml(ev.status || 'Confirmed')}</span></td>
            </tr>
          `;
        });
      }
    }

    htmlContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>${monthName} - 30-Day Schedule Diary</title>
          <style>
            @page { size: portrait; margin: 10mm; }
            * { box-sizing: border-box; }
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; margin: 0; padding: 14px; color: #0f172a; background: #fff; font-size: 11px; }
            .diary-header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 12px; border-bottom: 2px solid #0284c7; padding-bottom: 8px; }
            .diary-title { font-size: 20px; font-weight: 800; color: #0369a1; margin: 0; }
            .diary-meta { font-size: 11px; color: #64748b; }
            table.diary-table { width: 100%; border-collapse: collapse; margin-top: 6px; }
            th { background: #f1f5f9; color: #1e293b; padding: 7px 6px; border: 1px solid #cbd5e1; font-weight: 700; text-align: left; font-size: 10.5px; }
            td { border: 1px solid #cbd5e1; padding: 5px 6px; vertical-align: top; }
            .date-col { width: 11%; text-align: center; background: #f8fafc; font-weight: 600; }
            .title-col { width: 34%; }
            .time-col { width: 14%; white-space: nowrap; }
            .loc-col { width: 14%; }
            .travel-col { width: 18%; font-size: 10px; color: #475569; }
            .status-col { width: 9%; text-align: center; }
            .sub-notes { font-size: 9.5px; color: #64748b; margin-top: 2px; }
            .no-events-text { color: #94a3b8; font-style: italic; text-align: center; padding: 4px; }
            .travel-row { background: #fffdf5; }
            .badge { display: inline-block; padding: 2px 5px; border-radius: 3px; font-size: 9px; font-weight: 600; text-transform: uppercase; background: #e2e8f0; color: #334155; }
            .badge.completed { background: #dcfce7; color: #166534; }
            .badge.planned { background: #e0f2fe; color: #0369a1; }
            .badge.cancelled { background: #fee2e2; color: #991b1b; }
            @media print {
              body { padding: 0; }
              tr { page-break-inside: avoid; }
            }
          </style>
        </head>
        <body>
          <div class="diary-header">
            <div>
              <h1 class="diary-title">${monthName} &bull; Detailed Schedule Diary</h1>
              <div class="diary-meta">Calendar App &bull; Official Daily Program Register</div>
            </div>
            <div class="diary-meta" style="text-align: right;">
              Generated on ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
            </div>
          </div>
          <table class="diary-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Program / Schedule</th>
                <th>Timing</th>
                <th>Location / Mode</th>
                <th>Travel & Transit</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </body>
      </html>
    `;
  }

  win.document.open();
  win.document.write(htmlContent);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 400);
}

function renderMonthlyCalendarReport(container, fromDate, toDate) {
  const d1 = new Date(fromDate + 'T00:00:00');
  const d2 = new Date(toDate + 'T00:00:00');
  const schedulesMap = getSchedulesMap(fromDate, toDate);

  let totalDays = 0;
  let activeDays = 0;
  let totalSchedules = 0;
  let totalTravelLegs = 0;

  const cur = new Date(d1);
  while (cur <= d2) {
    totalDays++;
    const ds = formatDateYMD(cur);
    const evs = schedulesMap[ds] || [];
    if (evs.length > 0) {
      activeDays++;
      evs.forEach(ev => {
        if (ev.title.toLowerCase().startsWith('travel:') || ev.title.toLowerCase().startsWith('return travel:')) {
          totalTravelLegs++;
        } else {
          totalSchedules++;
        }
      });
    }
    cur.setDate(cur.getDate() + 1);
  }

  let html = `
    <div style="background: var(--bg-card); padding: 18px; border-radius: var(--radius-md); border: 1px solid var(--border-color); margin-bottom: 20px;">
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 14px;">
        <div>
          <h3 style="margin: 0 0 4px; font-size: 1.15rem; color: var(--text-main);">
            <i class="fa-solid fa-calendar-days text-sky"></i> Monthly Calendar Sheet & Diary
          </h3>
          <div style="font-size: 0.82rem; color: var(--text-muted);">
            Period: <strong>${formatDateIndian(fromDate)}</strong> to <strong>${formatDateIndian(toDate)}</strong>
          </div>
        </div>
        <div style="display: flex; gap: 8px;">
          <button type="button" class="btn-primary" id="reportPrintGridBtn" style="font-size: 0.84rem; padding: 7px 12px;">
            <i class="fa-solid fa-print"></i> Print Landscape Grid
          </button>
          <button type="button" class="btn-secondary" id="reportPrintTableBtn" style="font-size: 0.84rem; padding: 7px 12px;">
            <i class="fa-solid fa-table-list"></i> Print Portrait Table
          </button>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px;">
        <div style="background: var(--bg-primary); padding: 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-color); text-align: center;">
          <div style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase;">Total Days</div>
          <div style="font-size: 1.25rem; font-weight: 700; color: var(--text-main);">${totalDays}</div>
        </div>
        <div style="background: var(--bg-primary); padding: 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-color); text-align: center;">
          <div style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase;">Program Days</div>
          <div style="font-size: 1.25rem; font-weight: 700; color: #38bdf8;">${activeDays}</div>
        </div>
        <div style="background: var(--bg-primary); padding: 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-color); text-align: center;">
          <div style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase;">Programs</div>
          <div style="font-size: 1.25rem; font-weight: 700; color: #4ade80;">${totalSchedules}</div>
        </div>
        <div style="background: var(--bg-primary); padding: 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-color); text-align: center;">
          <div style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase;">Travel Legs</div>
          <div style="font-size: 1.25rem; font-weight: 700; color: #f59e0b;">${totalTravelLegs}</div>
        </div>
      </div>
    </div>

    <table class="report-table" style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
      <thead>
        <tr style="background: var(--bg-card); border-bottom: 2px solid var(--border-color);">
          <th style="padding: 9px 10px; text-align: left; width: 14%;">Date & Day</th>
          <th style="padding: 9px 10px; text-align: left;">Program / Schedule</th>
          <th style="padding: 9px 10px; text-align: left; width: 15%;">Timing</th>
          <th style="padding: 9px 10px; text-align: left; width: 16%;">Location / Mode</th>
          <th style="padding: 9px 10px; text-align: left; width: 12%;">Status</th>
        </tr>
      </thead>
      <tbody>
  `;

  const renderCur = new Date(d1);
  while (renderCur <= d2) {
    const ds = formatDateYMD(renderCur);
    const dayName = renderCur.toLocaleDateString('en-US', { weekday: 'short' });
    const evs = schedulesMap[ds] || [];

    if (evs.length === 0) {
      html += `
        <tr style="border-bottom: 1px solid var(--border-color); opacity: 0.65;">
          <td style="padding: 7px 10px; font-weight: 600;">${formatDateIndian(ds)} <small style="color:var(--text-muted);">(${dayName})</small></td>
          <td colspan="4" style="padding: 7px 10px; font-style: italic; color: var(--text-muted);">— No scheduled programs —</td>
        </tr>
      `;
    } else {
      evs.forEach((ev, idx) => {
        const isTravel = ev.title.toLowerCase().startsWith('travel:') || ev.title.toLowerCase().startsWith('return travel:');
        html += `
          <tr style="border-bottom: 1px solid var(--border-color); ${isTravel ? 'background: rgba(245, 158, 11, 0.05);' : ''}">
            ${idx === 0 ? `<td rowspan="${evs.length}" style="padding: 7px 10px; font-weight: 600; vertical-align: top; border-right: 1px solid var(--border-color);">${formatDateIndian(ds)}<br><small style="color:var(--text-muted);">(${dayName})</small></td>` : ''}
            <td style="padding: 7px 10px; font-weight: 600; color: ${isTravel ? '#f59e0b' : 'var(--text-main)'};">
              ${isTravel ? '<i class="fa-solid fa-train"></i> ' : ''}${escapeHtml(ev.title)}
              ${ev.notes ? `<div style="font-size: 0.78rem; font-weight: 400; color: var(--text-muted); margin-top: 2px;">${escapeHtml(ev.notes)}</div>` : ''}
            </td>
            <td style="padding: 7px 10px; white-space: nowrap;">${escapeHtml(formatTimeRange(ev.from_time, ev.to_time))}</td>
            <td style="padding: 7px 10px;">${escapeHtml(ev.location || ev.delivery_mode || '—')}</td>
            <td style="padding: 7px 10px;">
              <span class="report-status-badge ${ev.status}">${escapeHtml(ev.status || 'Confirmed')}</span>
            </td>
          </tr>
        `;
      });
    }

    renderCur.setDate(renderCur.getDate() + 1);
  }

  html += `
      </tbody>
    </table>
  `;

  container.innerHTML = html;

  const btnGrid = document.getElementById('reportPrintGridBtn');
  if (btnGrid) btnGrid.addEventListener('click', () => printMonthCalendar('grid'));
  const btnTable = document.getElementById('reportPrintTableBtn');
  if (btnTable) btnTable.addEventListener('click', () => printMonthCalendar('table'));
}
