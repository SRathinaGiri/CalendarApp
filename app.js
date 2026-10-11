/**
 * SRG Calendar Pro - Core Application Logic
 * Offline-first PWA with Client-Side SQLite (WASM) & Google Drive Cloud Sync
 */

// Global State
let SQL = null;
let db = null;
let currentDate = new Date(); // Viewing month
let currentView = localStorage.getItem('srg_current_view') || 'calendar'; // 'calendar' | 'month' | 'day' | 'agenda'
let tagMasterCategories = [];
let tagMasterTags = [];
let tagMasterFields = [];
let selectedDates = new Set(); // Multi-date selection set

// App Theme, Security Lock, and Read-Only State
let currentTheme = localStorage.getItem('srg_theme') || 'dark';
let isReadOnly = false;
let isAppUnlocked = sessionStorage.getItem('srg_app_unlocked') === 'true';

// Current attachments for modal (array of { name, type, data: base64 })
let currentModalAttachments = [];

// Sync Provider Choice: 'local' (Pure Single-Device Offline PWA)
let syncProvider = 'local';
localStorage.setItem('srg_sync_provider', 'local');
let serverApiUrl = '';
let serverApiKey = '';

// Tamil day of week mapping
const TAMIL_DAYS = ['ஞாயிறு', 'திங்கள்', 'செவ்வாய்', 'புதன்', 'வியாழன்', 'வெள்ளி', 'சனி'];

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

  let iconHtml = '<i class="fa-solid fa-circle-info"></i>';
  if (type === 'success') iconHtml = '<i class="fa-solid fa-circle-check"></i>';
  if (type === 'error') iconHtml = '<i class="fa-solid fa-triangle-exclamation"></i>';
  if (type === 'warning') iconHtml = '<i class="fa-solid fa-triangle-exclamation"></i>';
  if (type === 'loading') iconHtml = '<i class="fa-solid fa-spinner fa-spin"></i>';

  toast.innerHTML = `${iconHtml}<span>${message}</span>`;
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
const APP_VERSION = 'v1.0.5';
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
  navigator.serviceWorker.register('sw.js').then((reg) => {
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

  // If already installed or no prompt, perform a manual update check
  if (swRegistration) {
    showToast('Checking for Calendar App updates...', 'info', 2500);
    try {
      await swRegistration.update();
      setTimeout(() => {
        if (!updateWaiting) {
          showToast(`Calendar App is up to date (${APP_VERSION})`, 'success', 3000);
        }
      }, 1200);
    } catch (err) {
      showToast(`Calendar App is running ${APP_VERSION}`, 'info', 3000);
    }
  } else {
    showToast(`Calendar App is running ${APP_VERSION}`, 'info', 3000);
  }
}

// Automatic cache invalidation on version update
if (localStorage.getItem('srg_installed_version') !== APP_VERSION) {
  localStorage.setItem('srg_installed_version', APP_VERSION);
  if ('caches' in window) {
    caches.keys().then(names => {
      names.forEach(name => {
        if (!name.includes('v1.0.5')) {
          caches.delete(name);
        }
      });
    });
  }
}

// Initialization on DOM Loaded
document.addEventListener('DOMContentLoaded', async () => {
  const vBadge = document.getElementById('appVersionBadge');
  if (vBadge) vBadge.textContent = APP_VERSION;
  initAppTheme();
  setupUIEventListeners();
  updateInstallButtonState();
  await initSqliteDatabase();
  await checkAppSecurityLock();
  loadMasterDataFromDb();
  populateTitlesDatalist();
  switchToView(currentView, currentDate);
});

/* ==========================================================================
   1. SQLITE & WASM PERSISTENCE (PURE LOCAL SINGLE-DEVICE)
   ========================================================================== */

async function initSqliteDatabase() {
  updateBadge('Initializing DB...');
  try {
    try {
      SQL = await initSqlJs({
        locateFile: file => file
      });
    } catch(e) {
      console.warn('Local sql-wasm.wasm load fallback to CDN:', e);
      SQL = await initSqlJs({
        locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}`
      });
    }

    const cachedDbBytes = await loadDbFromIndexedDB();
    if (cachedDbBytes) {
      db = new SQL.Database(cachedDbBytes);
      ensureSchemaUpToDate();
    } else {
      // First run: Try loading bundled SRG_Calendar.db if available
      let loadedFromBundle = false;
      try {
        const resp = await fetch('SRG_Calendar.db');
        if (resp.ok) {
          const buf = await resp.arrayBuffer();
          if (buf && buf.byteLength > 0) {
            db = new SQL.Database(new Uint8Array(buf));
            ensureSchemaUpToDate();
            await saveDbToIndexedDB(false);
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
    updateBadge('Local SQLite Active');
  } catch (err) {
    console.error('Failed to init SQLite:', err);
    updateBadge('DB Error');
    alert('Error initializing SQLite WASM database: ' + err.message);
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

  // Set default app PIN '1234' into metadata
  try {
    db.run("INSERT OR REPLACE INTO app_metadata (key, value) VALUES ('app_pin', '1234')");
  } catch(e) {}

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
    localStorage.setItem('srg_db_last_modified', Date.now().toString());
  }
  return new Promise(async (resolve, reject) => {
    if (!db) return resolve();
    try {
      const binaryArray = db.export();
      const idb = await openSRGDatabase();
      const tx = idb.transaction('files', 'readwrite');
      const store = tx.objectStore('files');
      store.put(binaryArray, 'active_sqlite');
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
      getReq.onsuccess = () => resolve(getReq.result || null);
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
    const idb = await openSRGDatabase();
    const binary = db.export();
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

    db = new SQL.Database(new Uint8Array(snap.data));
    ensureSchemaUpToDate();
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

function saveAttachmentToIndexedDB(attId, dataBase64) {
  return new Promise(async (resolve) => {
    if (!attId || !dataBase64) return resolve();
    try {
      const idb = await openSRGDatabase();
      const tx = idb.transaction('files', 'readwrite');
      const store = tx.objectStore('files');
      const canonicalKey = attId.startsWith('att_') ? attId : ('att_' + attId);
      store.put(dataBase64, canonicalKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch(e) {
      resolve();
    }
  });
}

function loadAttachmentFromIndexedDB(attId) {
  return new Promise(async (resolve) => {
    if (!attId) return resolve(null);
    try {
      const idb = await openSRGDatabase();
      const tx = idb.transaction('files', 'readonly');
      const store = tx.objectStore('files');

      const canonicalKey = attId.startsWith('att_') ? attId : ('att_' + attId);
      const rawKey = attId.startsWith('att_') ? attId.slice(4) : attId;

      const req1 = store.get(canonicalKey);
      req1.onsuccess = () => {
        if (req1.result) return resolve(req1.result);

        const req2 = store.get(rawKey);
        req2.onsuccess = () => {
          if (req2.result) return resolve(req2.result);
          resolve(null);
        };
        req2.onerror = () => resolve(null);
      };
      req1.onerror = () => resolve(null);
    } catch(e) {
      resolve(null);
    }
  });
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
      att.data = matchedData;
      if (att.id) await saveAttachmentToIndexedDB(att.id, matchedData);
      return matchedData;
    }
  } catch(e) {
    console.warn('Fallback attachment search error:', e);
  }

  return null;
}

/* Content Fingerprint Helper (Instant O(1) content-based deduplication) */
function getContentFingerprint(val) {
  if (!val) return '';
  if (typeof val === 'string') {
    return `str_${val.length}_${val.slice(0, 100)}_${val.slice(-100)}`;
  }
  if (val instanceof ArrayBuffer || val instanceof Uint8Array) {
    const u8 = val instanceof Uint8Array ? val : new Uint8Array(val);
    const len = u8.byteLength;
    const h = Array.from(u8.slice(0, 32)).join('');
    const t = Array.from(u8.slice(-32)).join('');
    return `bin_${len}_${h}_${t}`;
  }
  return String(val).length.toString();
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
            fp: getContentFingerprint(val)
          });
        }
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
  });

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

  const cleanableList = [...duplicateKeysToDelete, ...orphanKeysToDelete];

  return {
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
  const msg = `Storage Clean Up & Deduplication:\n\nFound:\n- ${stats.duplicateCount} redundant alias duplicate keys\n- ${stats.orphanCount} unreferenced orphan files\nTotal space to free: ~${cleanableMb} MB\n\nThis will safely remove redundant copies and keep only the ${stats.activeFilesCount} canonical files for your active schedules.\n\nProceed with cleanup?`;
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

  const loadingToast = showToast('Creating full backup bundle (database + attachments)...', 'info', 0);
  try {
    const zip = new JSZip();

    // 1. Export SQLite database binary
    const dbBinary = db.export();
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

    // 3. Export attachments with STRICT CONTENT DEDUPLICATION
    const activeAttsMap = getActiveScheduleAttachmentsMap();
    const manifestAttachments = [];
    const attFolder = zip.folder('attachments');
    const seenFingerprints = new Set();
    const seenZipNames = new Set();

    // Pass 1: Export active schedule attachments directly
    for (const [id, att] of activeAttsMap.entries()) {
      const data = await getAttachmentData(att);
      if (data) {
        const fp = getContentFingerprint(data);
        if (!seenFingerprints.has(fp)) {
          seenFingerprints.add(fp);

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

          let zipName = baseName;
          if (att.id && !zipName.startsWith(att.id)) {
            zipName = `${att.id}_${baseName}`;
          }

          seenZipNames.add(zipName);

          const commaIdx = typeof data === 'string' ? data.indexOf(',') : -1;
          const b64 = commaIdx > -1 ? data.slice(commaIdx + 1) : data;
          attFolder.file(zipName, b64, { base64: true });

          manifestAttachments.push({
            id: att.id,
            filename: zipName,
            name: att.name || baseName,
            path: `attachments/${zipName}`,
            mime: mime,
            size: typeof b64 === 'string' ? Math.round(b64.length * 0.75) : (data.byteLength || 0)
          });
        }
      }
    }

    // Pass 2: Check IndexedDB for any OTHER files with unique content not in schedules
    const idb = await openSRGDatabase();
    const tx = idb.transaction('files', 'readonly');
    const store = tx.objectStore('files');

    await new Promise((resolve, reject) => {
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const key = String(cursor.key);
          if (key.startsWith('att_')) {
            const val = cursor.value;
            if (val) {
              const fp = getContentFingerprint(val);
              // Deduplication check: SKIP if this exact file content has already been exported!
              if (!seenFingerprints.has(fp)) {
                seenFingerprints.add(fp);
                const rawId = key.slice(4);
                let ext = 'bin';
                let mime = 'application/octet-stream';
                let b64 = '';

                if (typeof val === 'string' && val.startsWith('data:')) {
                  const commaIdx = val.indexOf(',');
                  b64 = commaIdx > -1 ? val.slice(commaIdx + 1) : val;
                  const matchMime = val.match(/data:([^;]+);/);
                  if (matchMime) {
                    mime = matchMime[1];
                    if (mime.includes('jpeg')) ext = 'jpg';
                    else if (mime.includes('png')) ext = 'png';
                    else if (mime.includes('pdf')) ext = 'pdf';
                  }
                }

                let zipFileName = rawId.includes('.') ? rawId : `${rawId}.${ext}`;
                if (!seenZipNames.has(zipFileName)) {
                  seenZipNames.add(zipFileName);
                  if (b64) {
                    attFolder.file(zipFileName, b64, { base64: true });
                  } else if (val instanceof ArrayBuffer || val instanceof Uint8Array) {
                    attFolder.file(zipFileName, val);
                  }

                  manifestAttachments.push({
                    id: rawId,
                    filename: zipFileName,
                    path: `attachments/${zipFileName}`,
                    mime: mime,
                    size: b64 ? Math.round(b64.length * 0.75) : (val.byteLength || 0)
                  });
                }
              }
            }
          }
          cursor.continue();
        } else {
          resolve();
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });

    // 4. Manifest
    const nowIso = new Date().toISOString();
    const manifest = {
      app: 'SRG_Calendar',
      app_version: APP_VERSION,
      backup_id: 'SRG_BACKUP_' + Date.now(),
      created_at: nowIso,
      database: {
        filename: 'database.db',
        schedules_count: schCount,
        transactions_count: txCount,
        notes_count: noteCount,
        tags_count: tagCount
      },
      attachments_count: manifestAttachments.length,
      attachments: manifestAttachments
    };
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    // 5. Generate and download zip
    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const nowStr = formatDateYMD(new Date());
    const downloadFilename = `SRG_Calendar_FullBackup_${nowStr}.zip`;

    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    if (loadingToast) dismissToast(loadingToast);
    showToast(`✓ Exported clean full backup (${schCount} schedules, ${manifestAttachments.length} unique files) to ${downloadFilename}!`, 'success', 5000);
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

  const loadingToast = showToast(`Unpacking and restoring full backup "${file.name}"...`, 'info', 0);
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

    // Safety snapshot of existing data before restoring
    try {
      await saveLocalDbSnapshot('Pre-Full-Restore Auto Snapshot');
    } catch (e) {
      console.warn('Safety snapshot error:', e);
    }

    // 2. Restore SQLite database
    const dbBinary = await dbEntry.async('uint8array');
    const headerStr = String.fromCharCode(...dbBinary.slice(0, 16));
    if (!headerStr.startsWith('SQLite format 3')) {
      throw new Error('Database file in archive is not a valid SQLite database.');
    }

    db = new SQL.Database(dbBinary);
    ensureSchemaUpToDate();
    await saveDbToIndexedDB();
    loadMasterDataFromDb();
    populateTitlesDatalist();

    // 3. Parse manifest.json if present
    let manifestMap = new Map();
    const manifestEntry = zip.file('manifest.json');
    if (manifestEntry) {
      try {
        const manifestText = await manifestEntry.async('string');
        const manifest = JSON.parse(manifestText);
        if (Array.isArray(manifest.attachments)) {
          manifest.attachments.forEach(att => {
            if (att.filename && att.id) {
              manifestMap.set(att.filename.toLowerCase(), att.id);
            }
            if (att.name && att.id) {
              manifestMap.set(att.name.toLowerCase(), att.id);
            }
            if (att.path && att.id) {
              manifestMap.set(att.path.toLowerCase(), att.id);
            }
          });
        }
      } catch (e) {
        console.warn('Could not parse manifest.json:', e);
      }
    }

    // 4. Restore attachments
    let importedAttachmentsCount = 0;
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

      const ext = filename.split('.').pop().toLowerCase();
      let mime = 'application/octet-stream';
      if (['jpg', 'jpeg'].includes(ext)) mime = 'image/jpeg';
      else if (ext === 'png') mime = 'image/png';
      else if (ext === 'gif') mime = 'image/gif';
      else if (ext === 'webp') mime = 'image/webp';
      else if (ext === 'pdf') mime = 'application/pdf';

      const base64Content = await zipEntry.async('base64');
      if (base64Content.length > 40 * 1024 * 1024) continue;

      const dataUrl = `data:${mime};base64,${base64Content}`;

      let canonicalId = manifestMap.get(filename.toLowerCase()) ||
                        manifestMap.get(relPath.toLowerCase()) ||
                        extractCanonicalAttachmentId(filename) ||
                        filename;

      await saveAttachmentToIndexedDB(canonicalId, dataUrl);
      if (filename && filename !== canonicalId) {
        await saveAttachmentToIndexedDB(filename, dataUrl);
      }
      importedAttachmentsCount++;
    }

    renderCurrentView();
    await updateStorageStatsUI();
    closeServerSyncModal();

    if (loadingToast) dismissToast(loadingToast);
    showToast(`✓ Full backup restored successfully! Database loaded and ${importedAttachmentsCount} attachments restored.`, 'success', 5000);
  } catch (err) {
    if (loadingToast) dismissToast(loadingToast);
    console.error('Error importing full backup zip:', err);
    showToast('Failed to restore full backup: ' + err.message, 'error', 5000);
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
    for (const [id, att] of activeAttsMap.entries()) {
      const data = await getAttachmentData(att);
      if (data) {
        const fp = getContentFingerprint(data);
        if (!seenFingerprints.has(fp)) {
          seenFingerprints.add(fp);

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
          let zipName = baseName;
          if (att.id && !zipName.startsWith(att.id)) zipName = `${att.id}_${baseName}`;

          seenZipNames.add(zipName);

          const commaIdx = typeof data === 'string' ? data.indexOf(',') : -1;
          const b64 = commaIdx > -1 ? data.slice(commaIdx + 1) : data;
          zip.file(zipName, b64, { base64: true });
          fileCount++;

          manifestAttachments.push({
            id: att.id,
            filename: zipName,
            mime: mime,
            size: typeof b64 === 'string' ? Math.round(b64.length * 0.75) : (data.byteLength || 0)
          });
        }
      }
    }

    // Pass 2: Unique unreferenced files in IndexedDB
    const idb = await openSRGDatabase();
    const tx = idb.transaction('files', 'readonly');
    const store = tx.objectStore('files');

    await new Promise((resolve, reject) => {
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const key = String(cursor.key);
          if (key.startsWith('att_')) {
            const val = cursor.value;
            if (val) {
              const fp = getContentFingerprint(val);
              if (!seenFingerprints.has(fp)) {
                seenFingerprints.add(fp);
                const rawKey = key.slice(4);
                let ext = 'bin';
                let mime = 'application/octet-stream';
                let b64 = '';

                if (typeof val === 'string' && val.startsWith('data:')) {
                  const commaIdx = val.indexOf(',');
                  b64 = commaIdx > -1 ? val.slice(commaIdx + 1) : val;
                  const matchMime = val.match(/data:([^;]+);/);
                  if (matchMime) {
                    mime = matchMime[1];
                    if (mime.includes('jpeg')) ext = 'jpg';
                    else if (mime.includes('png')) ext = 'png';
                  }
                }

                let zipFileName = rawKey.includes('.') ? rawKey : `${rawKey}.${ext}`;
                if (!seenZipNames.has(zipFileName)) {
                  seenZipNames.add(zipFileName);
                  if (b64) {
                    zip.file(zipFileName, b64, { base64: true });
                    fileCount++;
                  } else if (val instanceof ArrayBuffer || val instanceof Uint8Array) {
                    zip.file(zipFileName, val);
                    fileCount++;
                  }

                  manifestAttachments.push({
                    id: rawKey,
                    filename: zipFileName,
                    mime: mime,
                    size: b64 ? Math.round(b64.length * 0.75) : (val.byteLength || 0)
                  });
                }
              }
            }
          }
          cursor.continue();
        } else {
          resolve();
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });

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

      await saveAttachmentToIndexedDB(canonicalId, dataUrl);
      importedCount++;
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
  if (!db) return;

  const catRows = db.exec('SELECT * FROM tag_categories ORDER BY sort_order ASC');
  tagMasterCategories = catRows.length > 0 ? rowsToObjects(catRows[0]) : [];

  const tagRows = db.exec('SELECT * FROM tags ORDER BY name ASC');
  tagMasterTags = tagRows.length > 0 ? rowsToObjects(tagRows[0]) : [];

  const fldRows = db.exec('SELECT * FROM tag_field_definitions');
  tagMasterFields = fldRows.length > 0 ? rowsToObjects(fldRows[0]) : [];

  const catSelect = document.getElementById('categoryFilter');
  catSelect.innerHTML = '<option value="all">All Tag Categories</option>';
  tagMasterCategories.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    catSelect.appendChild(opt);
  });
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
  localStorage.setItem('srg_current_view', viewName);
  if (targetDate) {
    currentDate = targetDate;
  } else {
    currentDate = new Date(); // Default to Today on view switch per user request!
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
    const tamilDay = TAMIL_DAYS[currentDate.getDay()];
    document.getElementById('currentPeriodTitle').textContent = `${dayOfWeek}, ${indianDate} (${tamilDay})`;
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
  localStorage.setItem('srg_theme', currentTheme);
  initAppTheme();
  showToast(`Switched to ${currentTheme.toUpperCase()} theme`, 'info');
}

function getStoredAppPin() {
  if (!db) return localStorage.getItem('srg_app_pin') || '1234';
  try {
    const res = db.exec("SELECT value FROM app_metadata WHERE key = 'app_pin' LIMIT 1");
    if (res.length > 0 && res[0].values.length > 0 && res[0].values[0][0]) {
      return String(res[0].values[0][0]);
    }
  } catch(e) {}
  return localStorage.getItem('srg_app_pin') || '1234';
}

async function checkAppSecurityLock() {
  const overlay = document.getElementById('appLockOverlay');
  if (!overlay) return;

  if (!isAppUnlocked) {
    overlay.classList.remove('hidden');
    const keyInp = document.getElementById('appLockKeyInput');
    if (keyInp) keyInp.focus();
  } else {
    overlay.classList.add('hidden');
  }
}

async function unlockAppWithKey(enteredKey) {
  const trimmedKey = (enteredKey || '').trim();
  const errEl = document.getElementById('appLockErrorMsg');

  if (!trimmedKey) {
    if (errEl) {
      errEl.textContent = 'Please enter your Security PIN / Access Key';
      errEl.classList.remove('hidden');
    }
    return;
  }

  const storedPin = getStoredAppPin();
  if (trimmedKey === storedPin) {
    isAppUnlocked = true;
    sessionStorage.setItem('srg_app_unlocked', 'true');
    localStorage.setItem('srg_app_pin', trimmedKey);
    const overlay = document.getElementById('appLockOverlay');
    if (overlay) overlay.classList.add('hidden');
    if (errEl) errEl.classList.add('hidden');
    showToast('✓ Calendar Authenticated & Unlocked', 'success');
  } else {
    if (errEl) {
      errEl.textContent = 'Incorrect Security PIN. Access Denied.';
      errEl.classList.remove('hidden');
    }
    showToast('❌ Authentication Failed: Invalid PIN', 'error', 3000);
  }
}

async function lockAppSecurity() {
  isAppUnlocked = false;
  sessionStorage.removeItem('srg_app_unlocked');

  const overlay = document.getElementById('appLockOverlay');
  if (overlay) overlay.classList.remove('hidden');
  const keyInp = document.getElementById('appLockKeyInput');
  if (keyInp) {
    keyInp.value = '';
    keyInp.focus();
  }
  showToast('Calendar Locked', 'info');
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
  if (modal) modal.classList.add('hidden');
}

/* ==========================================================================
   CHANGE SECURITY PIN HANDLERS
   ========================================================================== */
function openChangePinModal() {
  const modal = document.getElementById('changePinModal');
  if (!modal) return;
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

  const storedPin = getStoredAppPin();
  if (currentPin !== storedPin) {
    if (errEl) {
      errEl.textContent = 'Current PIN is incorrect.';
      errEl.classList.remove('hidden');
    }
    return;
  }
  if (!newPin || newPin.length < 4) {
    if (errEl) {
      errEl.textContent = 'New PIN must be at least 4 characters long.';
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
    if (db) {
      db.run("INSERT OR REPLACE INTO app_metadata (key, value) VALUES ('app_pin', ?)", [newPin]);
      await saveDbToIndexedDB();
    }
    localStorage.setItem('srg_app_pin', newPin);
    closeChangePinModal();
    showToast('✓ Security PIN changed successfully!', 'success');
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

function updateReadOnlyState(forceReadOnly = false) {
  isReadOnly = false;
  const banner = document.getElementById('offlineReadOnlyBanner');
  if (banner) banner.classList.add('hidden');
}

async function checkServerSyncOnStartup() {
  updateReadOnlyState(false);
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

  const dataUrl = await getAttachmentData(att);
  if (!dataUrl) {
    body.innerHTML = '<div style="padding:40px; color:#fb7185;"><i class="fa-solid fa-triangle-exclamation fa-2x"></i><br><br>Unable to load attachment file. File may not exist on server or device is offline.</div>';
    return;
  }

  if (downloadLink) {
    downloadLink.href = dataUrl;
    downloadLink.download = att.filename || att.name || 'attachment';
  }

  const mime = att.type || '';
  if (mime.startsWith('image/') || (dataUrl.startsWith('data:image/'))) {
    body.innerHTML = `<img src="${dataUrl}" style="max-width:100%; max-height:70vh; border-radius:var(--radius-md); box-shadow:var(--shadow-md);">`;
  } else if (mime.includes('pdf') || dataUrl.includes('pdf')) {
    body.innerHTML = `<iframe src="${dataUrl}" style="width:100%; height:70vh; border:none; border-radius:var(--radius-md);"></iframe>`;
  } else {
    body.innerHTML = `<div style="padding:40px;"><a href="${dataUrl}" download="${att.name}" class="btn-primary"><i class="fa-solid fa-download"></i> Download ${att.name}</a></div>`;
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
        if (r.type === 'receipt') map[r.txn_date].receipts += Number(r.amount || 0);
        else map[r.txn_date].payments += Number(r.amount || 0);
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
  const debit = (txn.debit_account || '').trim();
  const credit = (txn.credit_account || '').trim();
  const amount = parseFloat(txn.amount) || 0;
  const desc = (txn.description || '').trim();
  const now = new Date().toISOString();

  try {
    db.run(`
      INSERT OR REPLACE INTO daily_transactions 
      (id, txn_date, type, debit_account, credit_account, amount, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, dateStr, type, debit, credit, amount, desc, now, now]);

    await saveDbToIndexedDB();
    renderCurrentView();
    renderFinanceTransactionsList(dateStr);
    populateFinanceAccountsDatalists();
    showToast('✓ Financial transaction saved locally!', 'success', 3000);
  } catch(err) {
    console.error('Error saving transaction:', err);
    showToast('❌ Error saving transaction: ' + err.message, 'error', 4000);
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
      const amt = Number(t.amount || 0);
      if (t.type === 'receipt') totalReceipts += amt;
      else totalPayments += amt;

      const card = document.createElement('div');
      card.style.cssText = 'background:var(--bg-primary); border:1px solid var(--border-color); border-radius:var(--radius-md); padding:10px 12px; display:flex; justify-content:space-between; align-items:center; font-size:0.88rem;';
      card.innerHTML = `
        <div>
          <span style="font-weight:600; color:${t.type === 'receipt' ? 'var(--receipt-color)' : 'var(--payment-color)'};">
            ${t.type === 'receipt' ? '🟢 Receipt' : '🔴 Payment'} &mdash; ₹${amt.toFixed(2)}
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
          document.getElementById('financeDebitAccount').value = t.debit_account || '';
          document.getElementById('financeCreditAccount').value = t.credit_account || '';
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
  if (receiptsEl) receiptsEl.textContent = `₹${totalReceipts.toFixed(2)}`;
  if (paymentsEl) paymentsEl.textContent = `₹${totalPayments.toFixed(2)}`;
  if (netEl) {
    netEl.textContent = `₹${net.toFixed(2)}`;
    netEl.style.color = net >= 0 ? 'var(--net-positive)' : 'var(--payment-color)';
  }
}

function populateFinanceAccountsDatalists() {
  if (!db) return;
  const drList = document.getElementById('debitAccountsDatalist');
  const crList = document.getElementById('creditAccountsDatalist');
  if (!drList || !crList) return;

  try {
    const drRes = db.exec("SELECT DISTINCT debit_account FROM daily_transactions WHERE debit_account IS NOT NULL AND debit_account != ''");
    const crRes = db.exec("SELECT DISTINCT credit_account FROM daily_transactions WHERE credit_account IS NOT NULL AND credit_account != ''");

    drList.innerHTML = drRes.length > 0 ? drRes[0].values.map(v => `<option value="${escapeHtml(v[0])}">`).join('') : '';
    crList.innerHTML = crRes.length > 0 ? crRes[0].values.map(v => `<option value="${escapeHtml(v[0])}">`).join('') : '';
  } catch (e) {}
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
    const dayOfWeekStr = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dObj.getDay()];
    const tamilDayStr = TAMIL_DAYS[dObj.getDay()];

    const tr = document.createElement('tr');
    tr.className = 'portrait-day-row';
    tr.dataset.date = dateYmd;
    if (isToday) tr.classList.add('today-row');

    if (dateYmd === selectedYmd || (isToday && !targetRowEl)) {
      targetRowEl = tr;
    }

    // 1. Date Cell
    const tdDate = document.createElement('td');
    tdDate.innerHTML = `
      <div class="portrait-day-cell-date">${indianDateStr} ${isToday ? '<span class="today-badge">TODAY</span>' : ''}</div>
      <div class="portrait-day-cell-sub">${dayOfWeekStr} (${tamilDayStr})</div>
    `;

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
        if (t.type === 'receipt') rec += Number(t.amount || 0);
        else pay += Number(t.amount || 0);
      });
      const net = rec - pay;
      tdFin.innerHTML = `
        <div class="portrait-finance-badge">
          <span>💰 In: <strong class="fin-in">₹${rec.toFixed(0)}</strong> | Out: <strong class="fin-out">₹${pay.toFixed(0)}</strong></span>
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
  numSpan.title = 'Click to open Day View';
  numSpan.style.cursor = 'pointer';
  numSpan.addEventListener('click', (e) => {
    e.stopPropagation();
    const [y, m, d] = dateStr.split('-').map(Number);
    currentDate = new Date(y, m - 1, d);
    switchToView('day');
  });

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

  const tamilSpan = document.createElement('span');
  tamilSpan.className = 'day-tamil';
  tamilSpan.textContent = TAMIL_DAYS[dayOfWeekIdx];

  header.appendChild(numSpan);
  header.appendChild(noteBtn);
  header.appendChild(financeBtn);
  header.appendChild(tamilSpan);
  cell.appendChild(header);

  const list = document.createElement('div');
  list.className = 'day-schedules-list';

  if (hasNote) {
    const notePill = document.createElement('div');
    notePill.className = 'day-note-pill';
    notePill.title = noteContent;
    notePill.innerHTML = `<i class="fa-solid fa-note-sticky"></i> ${escapeHtml(noteContent)}`;
    notePill.addEventListener('click', (e) => {
      e.stopPropagation();
      openDailyNoteModal(dateStr);
    });
    list.appendChild(notePill);
  }

  if (hasFinance) {
    const finPill = document.createElement('div');
    finPill.className = 'day-finance-pill';
    finPill.title = `Receipts: ₹${txnSummary.receipts.toFixed(2)} | Payments: ₹${txnSummary.payments.toFixed(2)}`;
    finPill.innerHTML = `<i class="fa-solid fa-coins"></i> +₹${txnSummary.receipts} / -₹${txnSummary.payments}`;
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

    // Note: Tags are hidden from calendar day chips to avoid clutter.
    // They are fully viewable on hover tooltip and in the Schedule Details modal.

    // Clicking chip opens full details window (with option to edit)
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      openScheduleDetailsModal(s);
    });

    list.appendChild(chip);
  });

  cell.appendChild(list);

  cell.addEventListener('click', () => {
    toggleDateSelection(dateStr);
  });

  return cell;
}

function getSchedulesMap(startDate, endDate) {
  if (!db) return {};
  const query = `
    SELECT 
      s.id, s.group_id, s.schedule_date, s.from_time, s.to_time, s.delivery_mode, s.location, s.title, s.notes, s.attachments, s.travel_info, s.status,
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

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = dayNames[currentDate.getDay()];
  const dateYmd = formatDateYMD(currentDate);
  const indianDate = formatDateIndian(currentDate);
  const tamilDay = TAMIL_DAYS[currentDate.getDay()];

  // Update Day View Header UI
  const dayNameEl = document.getElementById('dayViewDayName');
  const fullDateEl = document.getElementById('dayViewFullDate');
  const tamilEl = document.getElementById('dayViewTamil');
  const pickerInput = document.getElementById('dayViewDatePicker');
  const dayNoteBtn = document.getElementById('dayViewNoteBtn');

  if (dayNameEl) dayNameEl.textContent = dayName;
  if (fullDateEl) fullDateEl.textContent = indianDate;
  if (tamilEl) tamilEl.textContent = tamilDay;
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
      if (t.type === 'receipt') receipts += Number(t.amount || 0);
      else payments += Number(t.amount || 0);
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
        <span>Receipts: <strong style="color:var(--receipt-color);">₹${receipts.toFixed(2)}</strong></span>
        <span>Payments: <strong style="color:var(--payment-color);">₹${payments.toFixed(2)}</strong></span>
        <span>Net Flow: <strong style="color:${net >= 0 ? 'var(--net-positive)' : 'var(--net-negative)'};">₹${net.toFixed(2)}</strong></span>
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

let agendaPageSize = 60;
let agendaRenderLimit = 60;

function renderAgendaView(resetPagination = true) {
  const list = document.getElementById('agendaList');
  if (!list) return;

  if (resetPagination) {
    agendaRenderLimit = agendaPageSize;
  }
  list.innerHTML = '';

  const searchText = (document.getElementById('agendaSearchInput')?.value || '').toLowerCase().trim();
  const modeVal = document.getElementById('modeFilter')?.value || 'all';
  const catVal = document.getElementById('categoryFilter')?.value || 'all';

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

    if (catVal !== 'all') {
      const hasCat = tags.some(t => t.catId === catVal);
      if (!hasCat) continue;
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

  if (results.length === 0) {
    list.innerHTML = '<div style="text-align:center; padding:40px; color:#64748b;">No schedules match your search filters.</div>';
    return;
  }

  const targetYmd = formatDateYMD(currentDate);
  const todayYmd = formatDateYMD(new Date());
  let targetCardEl = null;

  const visibleResults = results.slice(0, agendaRenderLimit);

  visibleResults.forEach(s => {
    const card = document.createElement('div');
    card.className = 'agenda-card';
    card.dataset.date = s.schedule_date;

    const dObj = new Date(s.schedule_date + 'T00:00:00');
    const dStrIndian = formatDateIndian(s.schedule_date);
    const dayTamil = TAMIL_DAYS[dObj.getDay()];
    const isToday = (s.schedule_date === todayYmd);

    if (isToday) {
      card.classList.add('today-agenda-card');
    }

    // Determine target card to scroll into view (matches targetYmd or first date >= targetYmd)
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
        <span class="agenda-day-name">${dayTamil} (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dObj.getDay()]})</span>
      </div>
      <div class="agenda-card-details">
        <div class="agenda-card-title">${escapeHtml(s.title)} ${s.group_id ? '<span style="color:#818cf8; font-size:0.8rem;"><i class="fa-solid fa-layer-group"></i> Batch Group</span>' : ''}</div>
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

  // Load more button if there are remaining results
  if (results.length > agendaRenderLimit) {
    const remaining = results.length - agendaRenderLimit;
    const loadMoreContainer = document.createElement('div');
    loadMoreContainer.style.cssText = 'text-align: center; padding: 16px 0;';
    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.className = 'btn-secondary';
    loadMoreBtn.style.cssText = 'padding: 10px 24px; font-weight: 600; font-size: 0.88rem;';
    loadMoreBtn.innerHTML = `<i class="fa-solid fa-angles-down"></i> Load More Schedules (${remaining} remaining)`;
    loadMoreBtn.addEventListener('click', () => {
      agendaRenderLimit += agendaPageSize;
      renderAgendaView(false);
    });
    loadMoreContainer.appendChild(loadMoreBtn);
    list.appendChild(loadMoreContainer);
  }

  // Auto-scroll to target card (today / target date)
  if (!targetCardEl && list.firstElementChild && list.firstElementChild.classList.contains('agenda-card')) {
    targetCardEl = list.firstElementChild;
  }

  if (targetCardEl && resetPagination) {
    setTimeout(() => {
      targetCardEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 100);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
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
    document.getElementById('schedStatus').value = existingSchedule.status || 'completed';
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
    document.getElementById('schedStatus').value = 'planned';
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
    catName.style.color = cat.color || '#94a3b8';

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
      tagBtn.style.setProperty('--tag-color', t.color || '#3b82f6');

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
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
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
  const status = document.getElementById('schedStatus').value;
  const fromTime = document.getElementById('schedFromTime').value;
  const toTime = document.getElementById('schedToTime').value;
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
  const attachmentsJson = JSON.stringify(cleanedAttachments);

  // 2. Process & Decouple Onward Ticket Attachment
  let cleanedOnwardAtt = null;
  if (onwardChecked && onwardTicketAttachment) {
    const att = onwardTicketAttachment;
    const filename = att.filename || (att.id + '_' + (att.name ? att.name.replace(/[^a-zA-Z0-9_\-\.]/g, '_') : 'file.dat'));
    if (att.data && att.data.startsWith('data:')) {
      await saveAttachmentToIndexedDB(att.id, att.data);
      uploadAttachmentFileToServer(att.id, filename, att.data);
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
    if (att.data && att.data.startsWith('data:')) {
      await saveAttachmentToIndexedDB(att.id, att.data);
      uploadAttachmentFileToServer(att.id, filename, att.data);
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
      status: status,
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
          status: status,
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
        status: status,
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
      oAmt > 0 ? `Amount: ₹${oAmt.toFixed(2)} (${oReimb ? 'Reimbursable' : 'Non-reimbursable'})` : 'Sponsored by Organizer (₹0.00)'
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
      status: status,
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
        status: status,
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
      rAmt > 0 ? `Amount: ₹${rAmt.toFixed(2)} (${rReimb ? 'Reimbursable' : 'Non-reimbursable'})` : 'Sponsored by Organizer (₹0.00)'
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
      status: status,
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
        status: status,
        created_at: nowIso,
        updated_at: nowIso,
        tags: []
      });
    }
  }

  // Direct Local SQLite Persistence: Atomically save schedules & tags to local database
  try {
    // 1. If editId or groupId, clean existing travel legs for this group or schedule first
    if (groupId) {
      db.run("DELETE FROM schedules WHERE group_id = ? AND (title LIKE 'Travel:%' OR title LIKE 'Return Travel:%' OR title LIKE 'Travel Arrival:%' OR title LIKE 'Return Travel Arrival:%')", [groupId]);
    } else if (editId) {
      db.run("DELETE FROM schedules WHERE id LIKE ? AND (title LIKE 'Travel:%' OR title LIKE 'Return Travel:%' OR title LIKE 'Travel Arrival:%' OR title LIKE 'Return Travel Arrival:%')", [`%${editId}%`]);
    }

    // 2. Insert or replace all schedules and tags
    for (const sch of schedulesToSave) {
      db.run(`
        INSERT OR REPLACE INTO schedules (id, group_id, schedule_date, from_time, to_time, delivery_mode, location, title, notes, attachments, travel_info, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [sch.id, sch.group_id, sch.schedule_date, sch.from_time, sch.to_time, sch.delivery_mode, sch.location, sch.title, sch.notes, sch.attachments, sch.travel_info, sch.status, sch.created_at, sch.updated_at]);

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

    await saveDbToIndexedDB();
    populateTitlesDatalist();
    closeScheduleModal();
    clearDateSelection();
    renderCurrentView();
    showToast('✓ Saved directly to local database!', 'success', 3000);
  } catch(err) {
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

    li.innerHTML = `<i class="fa-solid fa-circle" style="color:${cat.color || '#3b82f6'}; font-size:0.6rem;"></i> ${escapeHtml(cat.name)}`;
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
      <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${t.color || '#3b82f6'};"></span>
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

function exportSqliteFile() {
  if (!db) return;
  const binaryArray = db.export();
  const blob = new Blob([binaryArray], { type: 'application/x-sqlite3' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `SRG_Calendar_${formatDateYMD(new Date())}.db`;
  a.click();
  showToast('Database backup downloaded as .db file!', 'success', 3500);
}

function importSqliteFile(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async () => {
    const u8 = new Uint8Array(reader.result);
    try {
      db = new SQL.Database(u8);
      ensureSchemaUpToDate();
      await saveDbToIndexedDB();
      loadMasterDataFromDb();
      populateTitlesDatalist();
      renderCurrentView();
      triggerAutoSync();
      showToast('SQLite database restored successfully!', 'success', 4000);
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
  const drawerBackupBtn = document.getElementById('drawerBackupBtn');
  if (drawerBackupBtn) {
    drawerBackupBtn.addEventListener('click', () => {
      closeSideMenu();
      openServerSyncModal();
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
  const drawerLockBtn = document.getElementById('drawerLockBtn');
  if (drawerLockBtn) {
    drawerLockBtn.addEventListener('click', () => {
      closeSideMenu();
      lockAppSecurity();
    });
  }
  const drawerResetCacheBtn = document.getElementById('drawerResetCacheBtn');
  if (drawerResetCacheBtn) {
    drawerResetCacheBtn.addEventListener('click', () => {
      closeSideMenu();
      const resetBtn = document.getElementById('resetCacheBtn');
      if (resetBtn) resetBtn.click();
    });
  }
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
    resetCacheBtn.addEventListener('click', () => {
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
    });
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

  const unlockForm = document.getElementById('appUnlockForm');
  if (unlockForm) {
    unlockForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const enteredKey = document.getElementById('appLockKeyInput').value;
      unlockAppWithKey(enteredKey);
    });
  }

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
      await saveDailyTransaction(txnData);
      resetFinanceForm();
    });
  }

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
  document.getElementById('categoryFilter').addEventListener('change', renderAgendaView);
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
          // Check SQLite format 3 header
          const headerStr = String.fromCharCode(...u8.slice(0, 16));
          if (!headerStr.startsWith('SQLite format 3')) {
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
      <span style="font-size: 0.75rem; padding: 2px 8px; border-radius: 3px; background: var(--bg-tertiary); color: var(--text-main); border: 1px solid var(--border-color); font-weight: 600;">
        Status: ${s.status ? escapeHtml(s.status.toUpperCase()) : 'CONFIRMED'}
      </span>
      ${s.group_id ? '<span style="font-size: 0.75rem; padding: 2px 8px; border-radius: 3px; background: rgba(99,102,241,0.25); color: #818cf8; font-weight: 600;"><i class="fa-solid fa-layer-group"></i> Batch Group</span>' : ''}
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
      const bg = t.color ? t.color + '40' : 'rgba(255,255,255,0.1)';
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

  // 1. Populate Account Dropdown for Ledger Report
  const acctSelect = document.getElementById('reportAccountSelect');
  if (acctSelect) {
    acctSelect.innerHTML = '';
    const accts = new Set();
    try {
      const r1 = db.exec("SELECT DISTINCT debit_account FROM daily_transactions WHERE debit_account IS NOT NULL AND debit_account != ''");
      if (r1.length > 0) r1[0].values.forEach(v => accts.add(v[0]));
      const r2 = db.exec("SELECT DISTINCT credit_account FROM daily_transactions WHERE credit_account IS NOT NULL AND credit_account != ''");
      if (r2.length > 0) r2[0].values.forEach(v => accts.add(v[0]));
    } catch(e){}

    const sortedAccts = Array.from(accts).sort();
    if (sortedAccts.length === 0) {
      acctSelect.innerHTML = '<option value="">No Accounts Found</option>';
    } else {
      sortedAccts.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a;
        opt.textContent = a;
        acctSelect.appendChild(opt);
      });
    }
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

function switchReportTab(reportType) {
  activeReportType = reportType;
  document.querySelectorAll('.report-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.report === reportType);
  });

  const acctGroup = document.getElementById('reportAccountGroup');
  const tagGroup = document.getElementById('reportTagGroup');

  if (acctGroup) acctGroup.classList.toggle('hidden', reportType !== 'ledger');
  if (tagGroup) tagGroup.classList.toggle('hidden', reportType !== 'schedules' && reportType !== 'ticket_cost' && reportType !== 'ticket_claim');

  generateActiveReport();
}

function generateActiveReport() {
  const container = document.getElementById('reportOutputContainer');
  if (!container) return;

  const fromDate = document.getElementById('reportFromDate').value;
  const toDate = document.getElementById('reportToDate').value;

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
  } else if (activeReportType === 'schedules') {
    renderSchedulesReport(container, fromDate, toDate);
  } else if (activeReportType === 'ticket_cost') {
    renderTicketCostReport(container, fromDate, toDate);
  } else if (activeReportType === 'ticket_claim') {
    renderTicketClaimReport(container, fromDate, toDate);
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
          <th style="padding:10px;">Tamil Day</th>
          <th style="padding:10px;">Status / Remarks</th>
          <th style="padding:10px;">Location / In-Transit Place</th>
        </tr>
      </thead>
      <tbody>
  `;

  freeDays.forEach(f => {
    const dStrInd = formatDateIndian(f.dateYmd);
    const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][f.dateObj.getDay()];
    const tamilDay = TAMIL_DAYS[f.dateObj.getDay()];

    let statusBadge = `<span style="color:var(--receipt-color); background:var(--badge-green-bg); border:1px solid var(--badge-green-border); padding:3px 8px; border-radius:4px; font-weight:600;">🟢 100% Free Day</span>`;
    if (f.hasTravelOnly) {
      statusBadge = `<span style="color:var(--accent-blue); background:var(--badge-blue-bg); border:1px solid var(--badge-blue-border); padding:3px 8px; border-radius:4px; font-weight:600;">🚆 Travel / In-Transit Only</span>`;
    }

    html += `
      <tr style="border-bottom:1px solid var(--border-color);">
        <td style="padding:10px; font-weight:600;">${dStrInd} (${dayOfWeek})</td>
        <td style="padding:10px; color:var(--text-muted);">${tamilDay}</td>
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
    if (t.type === 'receipt') totalReceipts += Number(t.amount || 0);
    else totalPayments += Number(t.amount || 0);
  });
  const netFlow = totalReceipts - totalPayments;

  let html = `
    <div style="margin-bottom:14px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
      <h4 style="margin:0; font-size:1rem; color:var(--text-main);"><i class="fa-solid fa-book" style="color:var(--receipt-color);"></i> Journal Statement (${formatDateIndian(fromDate)} to ${formatDateIndian(toDate)})</h4>
      <div style="font-size:0.85rem; display:flex; gap:12px;">
        <span>Receipts: <strong style="color:var(--receipt-color);">₹${totalReceipts.toFixed(2)}</strong></span>
        <span>Payments: <strong style="color:var(--payment-color);">₹${totalPayments.toFixed(2)}</strong></span>
        <span>Net Flow: <strong style="color:${netFlow >= 0 ? 'var(--net-positive)' : 'var(--payment-color)'};">₹${netFlow.toFixed(2)}</strong></span>
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
    const isReceipt = t.type === 'receipt';
    html += `
      <tr style="border-bottom:1px solid var(--border-color);">
        <td style="padding:8px 10px; font-weight:600;">${formatDateIndian(t.txn_date)}</td>
        <td style="padding:8px 10px;"><span style="color:${isReceipt ? 'var(--receipt-color)' : 'var(--payment-color)'}; font-weight:600;">${isReceipt ? '🟢 Receipt' : '🔴 Payment'}</span></td>
        <td style="padding:8px 10px;">${escapeHtml(t.debit_account || '-')}</td>
        <td style="padding:8px 10px;">${escapeHtml(t.credit_account || '-')}</td>
        <td style="padding:8px 10px; text-align:right; font-weight:700; color:${isReceipt ? 'var(--receipt-color)' : 'var(--payment-color)'};">₹${Number(t.amount || 0).toFixed(2)}</td>
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
    const res = db.exec("SELECT * FROM daily_transactions WHERE (debit_account = ? OR credit_account = ?) AND txn_date >= ? AND txn_date <= ? ORDER BY txn_date ASC, created_at ASC", [targetAccount, targetAccount, fromDate, toDate]);
    if (res.length > 0) txns = rowsToObjects(res[0]);
  } catch(e){}

  if (txns.length === 0) {
    container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-muted);">No ledger entries found for account "${escapeHtml(targetAccount)}" between ${formatDateIndian(fromDate)} and ${formatDateIndian(toDate)}.</div>`;
    return;
  }

  let totalDebit = 0;
  let totalCredit = 0;
  let runningBalance = 0;

  let html = `
    <div style="margin-bottom:14px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
      <h4 style="margin:0; font-size:1rem; color:var(--text-main);"><i class="fa-solid fa-scale-balanced" style="color:var(--badge-amber-text);"></i> Ledger Account: <strong style="color:var(--accent-blue);">${escapeHtml(targetAccount)}</strong></h4>
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
  `;

  txns.forEach(t => {
    let drAmt = 0;
    let crAmt = 0;
    let contraAcct = '';

    if (t.debit_account === targetAccount) {
      drAmt = Number(t.amount || 0);
      contraAcct = 'To ' + (t.credit_account || 'Cash/Bank');
      runningBalance += drAmt;
      totalDebit += drAmt;
    } else {
      crAmt = Number(t.amount || 0);
      contraAcct = 'By ' + (t.debit_account || 'Cash/Bank');
      runningBalance -= crAmt;
      totalCredit += crAmt;
    }

    html += `
      <tr style="border-bottom:1px solid var(--border-color);">
        <td style="padding:8px 10px; font-weight:600;">${formatDateIndian(t.txn_date)}</td>
        <td style="padding:8px 10px; font-weight:600; color:var(--text-main);">${escapeHtml(contraAcct)}</td>
        <td style="padding:8px 10px; text-align:right; color:var(--receipt-color);">${drAmt > 0 ? '₹' + drAmt.toFixed(2) : '-'}</td>
        <td style="padding:8px 10px; text-align:right; color:var(--payment-color);">${crAmt > 0 ? '₹' + crAmt.toFixed(2) : '-'}</td>
        <td style="padding:8px 10px; text-align:right; font-weight:700; color:${runningBalance >= 0 ? 'var(--net-positive)' : 'var(--payment-color)'};">₹${runningBalance.toFixed(2)}</td>
        <td style="padding:8px 10px; color:var(--text-muted);">${escapeHtml(t.description || '-')}</td>
      </tr>
    `;
  });

  html += `
      <tr style="background:var(--bg-tertiary); font-weight:700; border-top:2px solid var(--border-color);">
        <td colspan="2" style="padding:10px;">TOTALS & CLOSING BALANCE</td>
        <td style="padding:10px; text-align:right; color:var(--receipt-color);">Dr ₹${totalDebit.toFixed(2)}</td>
        <td style="padding:10px; text-align:right; color:var(--payment-color);">Cr ₹${totalCredit.toFixed(2)}</td>
        <td style="padding:10px; text-align:right; color:var(--net-positive);">₹${runningBalance.toFixed(2)}</td>
        <td style="padding:10px;"></td>
      </tr>
    </tbody></table>
  `;

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
            const amt = Number(o.amount || 0);
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
            const amt = Number(r.amount || 0);
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
        <span>Reimbursable: <strong style="color:var(--receipt-color);">₹${totalReimbursable.toFixed(2)}</strong></span>
        <span>Self-Paid: <strong style="color:var(--badge-amber-text);">₹${totalSelf.toFixed(2)}</strong></span>
        <span>Grand Total: <strong style="color:var(--net-positive);">₹${grandTotal.toFixed(2)}</strong></span>
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
        <td style="padding:8px 10px; text-align:right; font-weight:700; color:var(--net-positive);">₹${e.amount.toFixed(2)}</td>
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
            <td style="padding:10px; text-align:right; color:var(--net-positive); font-size:0.95rem;">₹${grandTotal.toFixed(2)}</td>
            <td style="padding:10px; text-align:center; font-size:0.8rem;">
              <span style="color:var(--receipt-color); font-weight:600;">Reimbursable: ₹${totalReimbursable.toFixed(2)}</span><br>
              <span style="color:var(--badge-amber-text); font-weight:600;">Self-Paid: ₹${totalSelf.toFixed(2)}</span>
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
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    
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

async function renderPdfArrayBufferToImage(arrayBuffer) {
  if (typeof pdfjsLib === 'undefined' || !arrayBuffer) return null;
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
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
            const amt = Number(o.amount || 0);
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
            const amt = Number(r.amount || 0);
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
            <strong style="color:var(--net-positive);">₹${e.amount.toFixed(2)}</strong>
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
          <div>Total Reimbursement Claimed: <strong style="font-size:1.1rem; color:#2563eb;">₹${claimTotal.toFixed(2)}</strong></div>
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
            <td style="padding:8px; text-align:right; font-weight:700; color:#0f172a;">₹${e.amount.toFixed(2)}</td>
          </tr>
        `;
      });

      html += `
          </tbody>
          <tfoot style="background:#f8fafc; font-weight:700; border-top:2px solid #0f172a;">
            <tr>
              <td colspan="6" style="padding:10px; text-align:right; text-transform:uppercase;">Total Amount Claimed:</td>
              <td style="padding:10px; text-align:right; color:#2563eb; font-size:1.05rem;">₹${claimTotal.toFixed(2)}</td>
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
                  Mode/Train: <strong>${escapeHtml(e.mode)} ${e.details ? '(' + escapeHtml(e.details) + ')' : ''}</strong> | Ticket Cost: <strong style="color:#2563eb;">₹${e.amount.toFixed(2)}</strong> | File: <em>${escapeHtml(att.name || att.filename || 'Ticket Document')}</em>
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
