/**
 * SRG Calendar Pro - Core Application Logic
 * Offline-first PWA with Client-Side SQLite (WASM) & Google Drive Cloud Sync
 */

// Global State
let SQL = null;
let db = null;
let currentDate = new Date(); // Viewing month
let selectedDates = new Set(); // Multi-date selection
let currentView = 'month'; // 'month' | 'agenda'
let tagMasterCategories = [];
let tagMasterTags = [];
let tagMasterFields = [];

// Current attachments for modal (array of { name, type, data: base64 })
let currentModalAttachments = [];

// Google Drive OAuth state
const DEFAULT_GOOGLE_CLIENT_ID = '693082654931-vcpqrjj1v35ej4phap9juu5reir5rnpf.apps.googleusercontent.com';
let gdriveToken = null;
let gdriveFileId = null;
let gdriveFolderId = null;
let gdriveClientId = localStorage.getItem('srg_gdrive_client_id') || DEFAULT_GOOGLE_CLIENT_ID;

// Tamil day of week mapping
const TAMIL_DAYS = ['ஞாயிறு', 'திங்கள்', 'செவ்வாய்', 'புதன்', 'வியாழன்', 'வெள்ளி', 'சனி'];

// Register Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(() => {
    console.log('SRG Calendar SW Registered');
  }).catch(err => console.log('SW registration error:', err));
}

// Initialization on DOM Loaded
document.addEventListener('DOMContentLoaded', async () => {
  setupUIEventListeners();
  await initSqliteDatabase();
  loadMasterDataFromDb();
  populateTitlesDatalist();
  renderCurrentView();
  initGoogleDriveAuth();
});

/* ==========================================================================
   1. SQLITE & WASM PERSISTENCE
   ========================================================================== */

async function initSqliteDatabase() {
  updateBadge('Initializing DB...');
  try {
    SQL = await initSqlJs({
      locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}`
    });

    const cachedDbBytes = await loadDbFromIndexedDB();
    if (cachedDbBytes) {
      db = new SQL.Database(cachedDbBytes);
      // Migration check
      ensureSchemaUpToDate();
    } else {
      await initDbFromSeedJson();
    }
    updateBadge('Local SQLite Active');
  } catch (err) {
    console.error('Failed to init SQLite:', err);
    updateBadge('DB Error');
    alert('Error initializing SQLite WASM database: ' + err.message);
  }
}

function ensureSchemaUpToDate() {
  try {
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

    // Auto-migrate: Backfill missing arrival travel entries for existing overnight travel records
    backfillMissingOvernightArrivalEntries();
    console.log('Database schema verified & columns updated.');
  } catch (e) {
    console.warn('Schema upgrade note:', e);
  }
}

function backfillMissingOvernightArrivalEntries() {
  try {
    // Find all overnight departure schedules
    const query = `
      SELECT id, title, schedule_date, from_time, to_time, location, notes, attachments, travel_info, status, created_at, updated_at
      FROM schedules
      WHERE (title LIKE 'Travel:%' OR title LIKE 'Return Travel:%')
        AND (notes LIKE '%[Overnight:%' OR title LIKE '%[Overnight:%' OR notes LIKE '%Arrival: %')
    `;
    const res = db.exec(query);
    if (!res || res.length === 0) return;

    let insertedCount = 0;
    const nowIso = new Date().toISOString();

    res[0].values.forEach(row => {
      const [id, title, schDate, fromTime, toTime, location, notes, attachments, travelInfoStr, status, createdAt, updatedAt] = row;
      
      // Extract arrival date & time from notes or title
      // Format in notes: "Departure: 01-11-2026 at 21:15 | Arrival: 02-11-2026 at 08:38"
      const arrMatch = (notes || '').match(/Arrival:\s*(\d{1,2}-\d{1,2}-\d{4})\s*at\s*(\d{2}:\d{2})/i) ||
                       (title || '').match(/Arr\s*(\d{1,2}-\d{1,2}-\d{4})/i);
      
      let arrYmd = null;
      let arrTime = '08:00';

      if (arrMatch) {
        const parts = arrMatch[1].split('-');
        if (parts.length === 3) {
          arrYmd = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
        }
        if (arrMatch[2]) arrTime = arrMatch[2];
      }

      // Check travel_info JSON if present
      if (!arrYmd && travelInfoStr) {
        try {
          const tObj = JSON.parse(travelInfoStr);
          const tData = tObj.return || tObj.onward;
          if (tData && tData.toDate && tData.toDate !== schDate) {
            arrYmd = tData.toDate;
            if (tData.arrTime) arrTime = tData.arrTime;
          }
        } catch(e){}
      }

      // If this is an overnight journey arriving on a different date:
      if (arrYmd && arrYmd !== schDate) {
        // Check if an arrival schedule already exists for this date
        const checkRes = db.exec("SELECT id FROM schedules WHERE schedule_date = ? AND (title LIKE 'Travel Arrival:%' OR title LIKE 'Return Travel Arrival:%' OR id LIKE ?)", [arrYmd, `%${id}%`]);
        if (!checkRes || checkRes.length === 0 || checkRes[0].values.length === 0) {
          const isReturn = title.toLowerCase().startsWith('return');
          const prefix = isReturn ? 'Return Travel Arrival:' : 'Travel Arrival:';
          
          // Generate clean arrival title
          const titleDetails = title.replace(/^(Return Travel|Travel):\s*/i, '').replace(/\s*\[Overnight:.*?\]/i, '');
          const arrTitle = `${prefix} ${titleDetails}`;
          const arrId = `sch_${arrYmd}_travel_${isReturn ? 'return' : 'onward'}_arr_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
          const arrNotes = `Arrival day: In-transit train arrival | Dep: ${formatDateIndian(schDate)} at ${fromTime} | Arr: ${formatDateIndian(arrYmd)} at ${arrTime}`;

          db.run(`
            INSERT INTO schedules (id, group_id, schedule_date, from_time, to_time, delivery_mode, location, title, notes, attachments, travel_info, status, created_at, updated_at)
            VALUES (?, null, ?, '00:00', ?, 'offline', ?, ?, ?, ?, ?, ?, ?, ?)
          `, [arrId, arrYmd, arrTime, location || '', arrTitle, arrNotes, attachments || '[]', travelInfoStr || null, status || 'confirmed', nowIso, nowIso]);

          insertedCount++;
        }
      }
    });

    if (insertedCount > 0) {
      console.log(`Successfully backfilled ${insertedCount} missing overnight arrival travel entries!`);
      saveDbToIndexedDB();
    }
  } catch (err) {
    console.warn('Overnight backfill notice:', err);
  }
}

async function initDbFromSeedJson() {
  console.log('Loading initial data from seed_data.json...');
  const res = await fetch('seed_data.json');
  const data = await res.json();

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
  `);

  const catStmt = db.prepare('INSERT INTO tag_categories (id, name, color, icon, sort_order) VALUES (?, ?, ?, ?, ?)');
  for (const c of data.tag_categories) {
    catStmt.run([c.id, c.name, c.color, c.icon, c.sort_order]);
  }
  catStmt.free();

  const tagStmt = db.prepare('INSERT INTO tags (id, category_id, name, color, description) VALUES (?, ?, ?, ?, ?)');
  for (const t of data.tags) {
    tagStmt.run([t.id, t.category_id, t.name, t.color, t.description]);
  }
  tagStmt.free();

  const fldStmt = db.prepare('INSERT INTO tag_field_definitions (id, tag_id, category_id, field_key, field_label, field_type) VALUES (?, ?, ?, ?, ?, ?)');
  for (const f of data.tag_field_definitions) {
    fldStmt.run([f.id, f.tag_id, f.category_id, f.field_key, f.field_label, f.field_type]);
  }
  fldStmt.free();

  const schStmt = db.prepare('INSERT INTO schedules (id, group_id, schedule_date, from_time, to_time, delivery_mode, location, title, notes, attachments, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const s of data.schedules) {
    schStmt.run([s.id, s.group_id || null, s.schedule_date, s.from_time, s.to_time, s.delivery_mode, s.location, s.title, s.notes, s.attachments || '[]', s.status, s.created_at, s.updated_at]);
  }
  schStmt.free();

  const stStmt = db.prepare('INSERT INTO schedule_tags (id, schedule_id, tag_id, field_values, notes) VALUES (?, ?, ?, ?, ?)');
  for (const st of data.schedule_tags) {
    stStmt.run([st.id, st.schedule_id, st.tag_id, st.field_values, st.notes]);
  }
  stStmt.free();

  await saveDbToIndexedDB();
}

function saveDbToIndexedDB() {
  return new Promise((resolve, reject) => {
    if (!db) return resolve();
    const binaryArray = db.export();
    const req = indexedDB.open('SRGCalendarDB', 1);
    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains('files')) {
        idb.createObjectStore('files');
      }
    };
    req.onsuccess = (e) => {
      const idb = e.target.result;
      const tx = idb.transaction('files', 'readwrite');
      const store = tx.objectStore('files');
      store.put(binaryArray, 'active_sqlite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

function loadDbFromIndexedDB() {
  return new Promise((resolve) => {
    const req = indexedDB.open('SRGCalendarDB', 1);
    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains('files')) {
        idb.createObjectStore('files');
      }
    };
    req.onsuccess = (e) => {
      const idb = e.target.result;
      const tx = idb.transaction('files', 'readonly');
      const store = tx.objectStore('files');
      const getReq = store.get('active_sqlite');
      getReq.onsuccess = () => resolve(getReq.result || null);
      getReq.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  });
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

function renderCurrentView() {
  updateNavHeader();
  if (currentView === 'month') {
    renderMonthView();
  } else if (currentView === 'day') {
    renderDayView();
  } else {
    renderAgendaView();
  }
  updateSelectionBar();
}

function switchToView(viewName) {
  currentView = viewName;
  document.querySelectorAll('.view-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === viewName);
  });
  document.getElementById('monthView').classList.toggle('active', viewName === 'month');
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
  const todayStr = formatDateYMD(new Date());

  for (let i = startingDay - 1; i >= 0; i--) {
    const dNum = prevMonthDays - i;
    const dObj = new Date(year, month - 1, dNum);
    const dStr = formatDateYMD(dObj);
    const cell = createDayCell(dStr, dNum, true, schedulesByDate[dStr] || [], dObj.getDay());
    grid.appendChild(cell);
  }

  for (let d = 1; d <= totalDays; d++) {
    const dObj = new Date(year, month, d);
    const dStr = formatDateYMD(dObj);
    const isToday = (dStr === todayStr);
    const cell = createDayCell(dStr, d, false, schedulesByDate[dStr] || [], dObj.getDay(), isToday);
    grid.appendChild(cell);
  }

  const totalRendered = startingDay + totalDays;
  const targetCells = totalRendered > 35 ? 42 : 35;
  const nextDays = targetCells - totalRendered;
  for (let d = 1; d <= nextDays; d++) {
    const dObj = new Date(year, month + 1, d);
    const dStr = formatDateYMD(dObj);
    const cell = createDayCell(dStr, d, true, schedulesByDate[dStr] || [], dObj.getDay());
    grid.appendChild(cell);
  }
}

function createDayCell(dateStr, dayNum, isOtherMonth, schedules, dayOfWeekIdx, isToday = false) {
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

  const tamilSpan = document.createElement('span');
  tamilSpan.className = 'day-tamil';
  tamilSpan.textContent = TAMIL_DAYS[dayOfWeekIdx];

  header.appendChild(numSpan);
  header.appendChild(tamilSpan);
  cell.appendChild(header);

  const list = document.createElement('div');
  list.className = 'day-schedules-list';

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
        titleDiv.style.color = '#34d399';
      } else if (s.title.toLowerCase().startsWith('travel arrival:')) {
        titleDiv.textContent = 'Travel Arrival';
        titleDiv.style.color = '#34d399';
      } else if (s.title.toLowerCase().startsWith('return travel:')) {
        titleDiv.textContent = 'Return Travel';
        titleDiv.style.color = '#fbbf24';
      } else {
        titleDiv.textContent = 'Travel';
        titleDiv.style.color = '#fbbf24';
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

  if (dayNameEl) dayNameEl.textContent = dayName;
  if (fullDateEl) fullDateEl.textContent = indianDate;
  if (tamilEl) tamilEl.textContent = tamilDay;
  if (pickerInput) pickerInput.value = dateYmd;

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
        const isTravelArr = s.title && (s.title.toLowerCase().startsWith('travel arrival:') || s.title.toLowerCase().startsWith('return travel arrival:'));
        const isTravelDep = s.title && (s.title.toLowerCase().startsWith('travel:') || s.title.toLowerCase().startsWith('return travel:') || s.title.toLowerCase() === 'travel');

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
          } else if (s.delivery_mode === 'hybrid') {
            card.classList.add('event-hybrid');
            badgeText = '🔄 Hybrid';
          } else {
            badgeText = '🏢 Offline';
          }
        }

        // Display clean title for travel
        let displayTitle = s.title;
        if (isTravelArr) {
          displayTitle = s.title.toLowerCase().startsWith('return') ? 'Return Travel Arrival' : 'Travel Arrival';
        } else if (isTravelDep) {
          displayTitle = s.title.toLowerCase().startsWith('return') ? 'Return Travel' : 'Travel';
        }

        const tagPillsHtml = (s.tags || []).map(t => 
          `<span class="chip-tag-pill" style="background:${t.color || 'rgba(255,255,255,0.1)'}">${t.name}</span>`
        ).join('');

        card.innerHTML = `
          <div class="day-event-main">
            <div class="day-event-title-row">
              <span class="day-event-title">${displayTitle}</span>
              <span class="day-event-type-badge ${badgeClass}">${badgeText}</span>
              ${s.group_id ? '<span style="font-size:0.75rem; color:#a5b4fc;" title="Batch / Group Schedule">👥</span>' : ''}
              ${s.attachments && s.attachments !== '[]' ? '<span style="font-size:0.75rem; color:#94a3b8;" title="Has Attachments">📎</span>' : ''}
            </div>
            <div class="day-event-details-row">
              <span class="day-event-time"><i class="fa-regular fa-clock"></i> ${formatTimeRange(s.from_time, s.to_time)}</span>
              ${s.location ? `<span class="day-event-location"><i class="fa-solid fa-location-dot"></i> ${s.location}</span>` : ''}
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

/* ==========================================================================
   5. AGENDA / SEARCH VIEW
   ========================================================================== */

function renderAgendaView() {
  const list = document.getElementById('agendaList');
  list.innerHTML = '';

  const searchText = document.getElementById('agendaSearchInput').value.toLowerCase().trim();
  const modeVal = document.getElementById('modeFilter').value;
  const catVal = document.getElementById('categoryFilter').value;

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

  query += ` GROUP BY s.id ORDER BY s.schedule_date DESC, s.from_time ASC LIMIT 300`;

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

  results.forEach(s => {
    const card = document.createElement('div');
    card.className = 'agenda-card';

    const dObj = new Date(s.schedule_date + 'T00:00:00');
    const dStrIndian = formatDateIndian(s.schedule_date);
    const dayTamil = TAMIL_DAYS[dObj.getDay()];

    card.innerHTML = `
      <div class="agenda-card-date">
        <span class="agenda-day-str">${dStrIndian}</span>
        <span class="agenda-day-name">${dayTamil} (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dObj.getDay()]})</span>
      </div>
      <div class="agenda-card-details">
        <div class="agenda-card-title">${escapeHtml(s.title)} ${s.group_id ? '<span style="color:#818cf8; font-size:0.8rem;"><i class="fa-solid fa-layer-group"></i> Batch Group</span>' : ''}</div>
        <div class="agenda-card-meta">
          <span><i class="fa-regular fa-clock"></i> ${formatTimeRange(s.from_time, s.to_time)}</span>
          <span class="chip-mode-badge ${s.delivery_mode}">${s.delivery_mode.toUpperCase()}</span>
          ${s.location ? `<span><i class="fa-solid fa-location-dot"></i> ${escapeHtml(s.location)}</span>` : ''}
          ${s.notes ? `<span><i class="fa-regular fa-note-sticky"></i> ${escapeHtml(s.notes)}</span>` : ''}
          ${s.attachments && s.attachments !== '[]' ? `<span style="color:#60a5fa;"><i class="fa-solid fa-paperclip"></i> Attached</span>` : ''}
        </div>
        <div class="chip-tags-row">
          ${s.tags.map(t => `<span class="chip-tag-pill" style="background:${t.color || '#3b82f6'}30; border:1px solid ${t.color || '#3b82f6'}">${escapeHtml(t.name)}</span>`).join('')}
        </div>
      </div>
    `;

    card.addEventListener('click', () => {
      openScheduleModal(s);
    });

    list.appendChild(card);
  });
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
      const res = db.exec("SELECT schedule_date FROM schedules WHERE group_id = ? AND title NOT LIKE 'Travel:%' AND title NOT LIKE 'Return Travel:%' ORDER BY schedule_date ASC", [activeEditingGroupId]);
      if (res.length > 0) {
        datesToApply = res[0].values.map(v => v[0]);
      } else {
        datesToApply = [existingSchedule.schedule_date];
      }
      groupBadgeContainer.classList.remove('hidden');
      document.getElementById('groupInfoText').textContent = `Batch Group (${datesToApply.length} Days linked)`;
      document.getElementById('applyAsGroupCheckbox').checked = true;
      deleteGroupBtn.classList.remove('hidden');
    } else {
      datesToApply = [existingSchedule.schedule_date];
      groupBadgeContainer.classList.add('hidden');
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
    db.run('INSERT INTO tags (id, category_id, name, color, description) VALUES (?, ?, ?, ?, ?)',
           [id, catId, name.trim(), color, '']);
    await saveDbToIndexedDB();
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
        const w = window.open('');
        w.document.write(`<img src="${att.data}" style="max-width:100%; height:auto;">`);
      });
      card.appendChild(img);
    } else {
      const icon = document.createElement('i');
      icon.className = 'fa-solid fa-file-pdf attachment-file-icon';
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
  const fullText = tokens.join('\n');

  let pnr = '';
  const pnrMatch = fullText.match(/\b(\d{10})\b/);
  if (pnrMatch) pnr = pnrMatch[1];

  let train = '';
  const trainMatch = fullText.match(/\b(\d{5}\s*\/[^\n\r]+)/);
  if (trainMatch) train = trainMatch[1].trim();

  let fromStation = '';
  let toStation = '';
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i].toLowerCase();
    if (tok === 'booked from') {
      if (tokens[i + 1] && tokens[i + 1].toLowerCase() === 'to' && tokens[i + 2]) {
        fromStation = tokens[i + 2];
        if (tokens[i + 3] === tokens[i + 2] && tokens[i + 4]) {
          toStation = tokens[i + 4];
        } else if (tokens[i + 3]) {
          toStation = tokens[i + 3];
        }
      }
    }
  }

  let depTime = '', depDate = '', arrTime = '', arrDate = '';
  const depMatch = fullText.match(/Departure\*?\s*(\d{2}:\d{2})\s+(\d{1,2}-[A-Za-z]{3}-[A-Za-z0-9]{4})/i);
  if (depMatch) {
    depTime = depMatch[1];
    depDate = parseIndianDateToYmd(depMatch[2]);
  }
  const arrMatch = fullText.match(/Arrival\*?\s*(\d{2}:\d{2})\s+(\d{1,2}-[A-Za-z]{3}-[A-Za-z0-9]{4})/i);
  if (arrMatch) {
    arrTime = arrMatch[1];
    arrDate = parseIndianDateToYmd(arrMatch[2]);
  }

  let totalFare = 0;
  const fareIdx = tokens.findIndex(t => t.toLowerCase().includes('total fare'));
  if (fareIdx !== -1 && tokens[fareIdx + 1]) {
    const rawAmt = tokens[fareIdx + 1].replace(/[^\d.]/g, '');
    totalFare = parseFloat(rawAmt) || 0;
  }

  function parseIndianDateToYmd(dStr) {
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
    bufReader.onload = () => {
      try {
        const uint8Array = new Uint8Array(bufReader.result);
        const tokens = extractPdfTokens(uint8Array);
        if (tokens.length > 0) {
          const ticketData = parseIrctcData(tokens);
          console.log(`Auto-extracted ticket data for ${type}:`, ticketData);

          if (ticketData.pnr || ticketData.train || ticketData.depDate) {
            applyTicketDataToForm(type, ticketData);
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
    updateTravelDateHint(isO ? 'onwardTravelDate' : 'returnTravelDate', isO ? 'onwardDateHint' : 'returnDateHint');
  }
  if (data.depTime && depTime) depTime.value = data.depTime;
  if (data.arrDate && arrDate) {
    arrDate.value = data.arrDate;
    updateTravelDateHint(isO ? 'onwardArrivalDate' : 'returnArrivalDate', isO ? 'onwardArrivalHint' : 'returnArrivalHint');
  }
  if (data.arrTime && arrTime) arrTime.value = data.arrTime;
  if (data.totalFare > 0 && amt) {
    amt.value = data.totalFare.toFixed(2);
    if (reimb) reimb.checked = true;
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
      const w = window.open('');
      w.document.write(`<img src="${att.data}" style="max-width:100%; height:auto;">`);
    });
    pill.appendChild(img);
  } else {
    pill.innerHTML += '<i class="fa-solid fa-file-pdf"></i>';
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

function checkScheduleClash(dateStr, fromTime, toTime, excludeId = null) {
  const stmt = db.prepare(`
    SELECT id, title, from_time, to_time 
    FROM schedules 
    WHERE schedule_date = ? AND id != ?
  `);
  stmt.bind([dateStr, excludeId || '']);
  
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
      const res = db.exec("SELECT schedule_date FROM schedules WHERE group_id = ? AND title NOT LIKE 'Travel:%' AND title NOT LIKE 'Return Travel:%' ORDER BY schedule_date ASC", [activeEditingGroupId]);
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
      const clashes = checkScheduleClash(d, fromTime, toTime, editId);
      if (clashes.length > 0) {
        const proceed = confirm(`⚠️ Time Clash Alert on ${formatDateIndian(d)}!\n\nThis overlaps with:\n- ${clashes.join('\n- ')}\n\nDo you want to proceed anyway?`);
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
  const attachmentsJson = JSON.stringify(currentModalAttachments);
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
      attachment: onwardTicketAttachment
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
      attachment: returnTicketAttachment
    } : null
  };
  const travelInfoJson = (onwardChecked || returnChecked) ? JSON.stringify(travelInfoObj) : null;

  // Group ID assignment
  let groupId = activeEditingGroupId;
  if (!groupId && dates.length > 1 && applyAsGroup) {
    groupId = `grp_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
  } else if (!applyAsGroup) {
    groupId = null;
  }

  if (editId && (!activeEditingGroupId || !applyAsGroup)) {
    // Single edit
    db.run(`
      UPDATE schedules 
      SET title = ?, delivery_mode = ?, status = ?, from_time = ?, to_time = ?, location = ?, notes = ?, attachments = ?, travel_info = ?, group_id = ?, updated_at = ?
      WHERE id = ?
    `, [title, deliveryMode, status, fromTime, toTime, location, notes, attachmentsJson, travelInfoJson, groupId, nowIso, editId]);

    db.run('DELETE FROM schedule_tags WHERE schedule_id = ?', [editId]);
    const stStmt = db.prepare('INSERT INTO schedule_tags (id, schedule_id, tag_id, field_values, notes) VALUES (?, ?, ?, ?, ?)');
    activeModalSelectedTagIds.forEach(tid => {
      stStmt.run([`st_${editId}_${tid}`, editId, tid, customValuesJson, '']);
    });
    stStmt.free();

  } else if (editId && activeEditingGroupId && applyAsGroup) {
    // Bulk update all schedules in this group
    db.run(`
      UPDATE schedules
      SET title = ?, delivery_mode = ?, status = ?, from_time = ?, to_time = ?, location = ?, notes = ?, attachments = ?, travel_info = ?, updated_at = ?
      WHERE group_id = ?
    `, [title, deliveryMode, status, fromTime, toTime, location, notes, attachmentsJson, travelInfoJson, nowIso, activeEditingGroupId]);

    // Update tags for all schedules in group
    const res = db.exec("SELECT id FROM schedules WHERE group_id = ?", [activeEditingGroupId]);
    if (res.length > 0) {
      res[0].values.forEach(valArr => {
        const schId = valArr[0];
        db.run('DELETE FROM schedule_tags WHERE schedule_id = ?', [schId]);
        const stStmt = db.prepare('INSERT INTO schedule_tags (id, schedule_id, tag_id, field_values, notes) VALUES (?, ?, ?, ?, ?)');
        activeModalSelectedTagIds.forEach(tid => {
          stStmt.run([`st_${schId}_${tid}`, schId, tid, customValuesJson, '']);
        });
        stStmt.free();
      });
    }

  } else {
    // Create new entries for all dates
    for (const dStr of dates) {
      const newId = `sch_${dStr}_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
      db.run(`
        INSERT INTO schedules (id, group_id, schedule_date, from_time, to_time, delivery_mode, location, title, notes, attachments, travel_info, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [newId, groupId, dStr, fromTime, toTime, deliveryMode, location, title, notes, attachmentsJson, travelInfoJson, status, nowIso, nowIso]);

      const stStmt = db.prepare('INSERT INTO schedule_tags (id, schedule_id, tag_id, field_values, notes) VALUES (?, ?, ?, ?, ?)');
      activeModalSelectedTagIds.forEach(tid => {
        stStmt.run([`st_${newId}_${tid}`, newId, tid, customValuesJson, '']);
      });
      stStmt.free();
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

    const oAttachments = onwardTicketAttachment ? JSON.stringify([onwardTicketAttachment]) : '[]';
    const oId = `sch_${oDate}_travel_onward_${Date.now()}`;
    
    // 1. Departure Day Travel Entry (from departure time until midnight if overnight, or until arrival time)
    const oDepToTime = isOvernight ? '23:59' : oArrTime;
    db.run(`
      INSERT INTO schedules (id, group_id, schedule_date, from_time, to_time, delivery_mode, location, title, notes, attachments, travel_info, status, created_at, updated_at)
      VALUES (?, null, ?, ?, ?, 'offline', ?, ?, ?, ?, ?, ?, ?, ?)
    `, [oId, oDate, oDepTime, oDepToTime, `${oFrom} -> ${oTo}`, oTitle, oNotes, oAttachments, travelInfoJson, status, nowIso, nowIso]);

    // 2. Arrival Day Travel Entry (if overnight / arrives next date)
    if (isOvernight) {
      const oArrId = `sch_${oArrDate}_travel_onward_arr_${Date.now()}`;
      let oArrTitle = `Travel Arrival: ${oTo || 'Venue'} from ${oFrom || 'Home'} (${oMode})`;
      if (oDetails) oArrTitle += ` - ${oDetails}`;
      if (oPnr) oArrTitle += ` | PNR: ${oPnr}`;
      const oArrNotes = `Arrival day: In-transit train arrival at ${oTo} at ${oArrTime} | Dep: ${formatDateIndian(oDate)} at ${oDepTime}`;
      
      db.run(`
        INSERT INTO schedules (id, group_id, schedule_date, from_time, to_time, delivery_mode, location, title, notes, attachments, travel_info, status, created_at, updated_at)
        VALUES (?, null, ?, '00:00', ?, 'offline', ?, ?, ?, ?, ?, ?, ?, ?)
      `, [oArrId, oArrDate, oArrTime, `${oFrom} -> ${oTo}`, oArrTitle, oArrNotes, oAttachments, travelInfoJson, status, nowIso, nowIso]);
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

    const rAttachments = returnTicketAttachment ? JSON.stringify([returnTicketAttachment]) : '[]';
    const rId = `sch_${rDate}_travel_return_${Date.now()}`;

    // 1. Departure Day Return Entry
    const rDepToTime = isOvernight ? '23:59' : rArrTime;
    db.run(`
      INSERT INTO schedules (id, group_id, schedule_date, from_time, to_time, delivery_mode, location, title, notes, attachments, travel_info, status, created_at, updated_at)
      VALUES (?, null, ?, ?, ?, 'offline', ?, ?, ?, ?, ?, ?, ?, ?)
    `, [rId, rDate, rDepTime, rDepToTime, `${rFrom} -> ${rTo}`, rTitle, rNotes, rAttachments, travelInfoJson, status, nowIso, nowIso]);

    // 2. Arrival Day Return Entry (if overnight / arrives next date)
    if (isOvernight) {
      const rArrId = `sch_${rArrDate}_travel_return_arr_${Date.now()}`;
      let rArrTitle = `Return Travel Arrival: ${rTo || 'Home'} from ${rFrom || 'Venue'} (${rMode})`;
      if (rDetails) rArrTitle += ` - ${rDetails}`;
      if (rPnr) rArrTitle += ` | PNR: ${rPnr}`;
      const rArrNotes = `Arrival day: In-transit train return arrival at ${rTo} at ${rArrTime} | Dep: ${formatDateIndian(rDate)} at ${rDepTime}`;

      db.run(`
        INSERT INTO schedules (id, group_id, schedule_date, from_time, to_time, delivery_mode, location, title, notes, attachments, travel_info, status, created_at, updated_at)
        VALUES (?, null, ?, '00:00', ?, 'offline', ?, ?, ?, ?, ?, ?, ?, ?)
      `, [rArrId, rArrDate, rArrTime, `${rFrom} -> ${rTo}`, rArrTitle, rArrNotes, rAttachments, travelInfoJson, status, nowIso, nowIso]);
    }
  }

  await saveDbToIndexedDB();
  populateTitlesDatalist();
  triggerAutoDriveSync();

  closeScheduleModal();
  clearDateSelection();
  renderCurrentView();
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

  if (confirm('Delete this schedule?')) {
    db.run('DELETE FROM schedules WHERE id = ?', [editId]);
    db.run('DELETE FROM schedule_tags WHERE schedule_id = ?', [editId]);
    await saveDbToIndexedDB();
    triggerAutoDriveSync();
    closeScheduleModal();
    renderCurrentView();
  }
}

async function handleDeleteBatchGroup() {
  if (!activeEditingGroupId) return;

  if (confirm('⚠️ Are you sure you want to delete this ENTIRE batch collection of schedules? All dates in this group will be deleted.')) {
    const res = db.exec("SELECT id FROM schedules WHERE group_id = ?", [activeEditingGroupId]);
    if (res.length > 0) {
      res[0].values.forEach(v => {
        const id = v[0];
        db.run('DELETE FROM schedule_tags WHERE schedule_id = ?', [id]);
      });
    }
    db.run('DELETE FROM schedules WHERE group_id = ?', [activeEditingGroupId]);
    await saveDbToIndexedDB();
    triggerAutoDriveSync();
    closeScheduleModal();
    renderCurrentView();
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
        db.run('DELETE FROM tags WHERE id = ?', [t.id]);
        db.run('DELETE FROM schedule_tags WHERE tag_id = ?', [t.id]);
        await saveDbToIndexedDB();
        triggerAutoDriveSync();
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
    fldBadge.textContent = `${f.field_label} (${f.field_type})`;
    fieldsContainer.appendChild(fldBadge);
  });
}

async function handleAddCategory() {
  const name = prompt('Enter new Category Name:');
  if (!name || !name.trim()) return;

  const color = '#' + Math.floor(Math.random()*16777215).toString(16);
  const id = 'cat_' + Date.now();
  db.run('INSERT INTO tag_categories (id, name, color, icon, sort_order) VALUES (?, ?, ?, ?, ?)',
         [id, name.trim(), color, 'folder', tagMasterCategories.length + 1]);
  
  await saveDbToIndexedDB();
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
    db.run('INSERT INTO tags (id, category_id, name, color, description) VALUES (?, ?, ?, ?, ?)',
           [id, activeMasterCatId, name.trim(), color, '']);
    await saveDbToIndexedDB();
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

  db.run('INSERT INTO tag_field_definitions (id, tag_id, category_id, field_key, field_label, field_type) VALUES (?, ?, ?, ?, ?, ?)',
         [id, null, activeMasterCatId, key, label.trim(), 'text']);

  await saveDbToIndexedDB();
  loadMasterDataFromDb();
  renderTagMasterUI();
}

/* ==========================================================================
   10. GOOGLE DRIVE SYNC & OAUTH (FOLDER: CalendarApp)
   ========================================================================== */

const DRIVE_FILE_NAME = 'SRG_Calendar.db';
const DRIVE_FOLDER_NAME = 'CalendarApp';

function initGoogleDriveAuth() {
  document.getElementById('gdriveClientIdInput').value = gdriveClientId;
}

function handleSaveClientId() {
  const val = document.getElementById('gdriveClientIdInput').value.trim();
  if (val) {
    localStorage.setItem('srg_gdrive_client_id', val);
    gdriveClientId = val;
    alert('Google Client ID saved! Now click "Connect Google Account".');
  }
}

function handleGoogleDriveSignIn() {
  if (!gdriveClientId) {
    const inputId = prompt('Please enter your Google Cloud OAuth Client ID:');
    if (!inputId) return;
    gdriveClientId = inputId.trim();
    localStorage.setItem('srg_gdrive_client_id', gdriveClientId);
  }

  const tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: gdriveClientId,
    scope: 'https://www.googleapis.com/auth/drive.file',
    callback: async (tokenResponse) => {
      if (tokenResponse && tokenResponse.access_token) {
        gdriveToken = tokenResponse.access_token;
        document.getElementById('gdriveStatusBadge').textContent = 'Connected';
        document.getElementById('gdriveStatusBadge').className = 'status-pill status-connected';
        document.getElementById('gdriveUploadNowBtn').disabled = false;
        document.getElementById('gdriveDownloadNowBtn').disabled = false;
        document.getElementById('syncStatusText').textContent = 'Drive Connected';
        updateBadge('Drive Synced', true);

        await checkOrCreateDriveFile();
      }
    }
  });

  tokenClient.requestAccessToken({ prompt: 'consent' });
}

async function checkOrCreateDriveFile() {
  try {
    const folderSearchUrl = `https://www.googleapis.com/drive/v3/files?q=name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const fRes = await fetch(folderSearchUrl, {
      headers: { Authorization: `Bearer ${gdriveToken}` }
    });
    const fData = await fRes.json();
    if (fData.files && fData.files.length > 0) {
      gdriveFolderId = fData.files[0].id;
      console.log('Found CalendarApp folder:', gdriveFolderId);
    } else {
      const createFolderRes = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${gdriveToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: DRIVE_FOLDER_NAME,
          mimeType: 'application/vnd.google-apps.folder'
        })
      });
      const newFolder = await createFolderRes.json();
      gdriveFolderId = newFolder.id;
      console.log('Created CalendarApp folder:', gdriveFolderId);
    }

    const fileSearchUrl = `https://www.googleapis.com/drive/v3/files?q=name='${DRIVE_FILE_NAME}' and trashed=false`;
    const res = await fetch(fileSearchUrl, {
      headers: { Authorization: `Bearer ${gdriveToken}` }
    });
    const data = await res.json();
    if (data.files && data.files.length > 0) {
      gdriveFileId = data.files[0].id;
      console.log('Found existing Google Drive calendar file:', gdriveFileId);
      
      if (gdriveFolderId) {
        fetch(`https://www.googleapis.com/drive/v3/files/${gdriveFileId}?addParents=${gdriveFolderId}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${gdriveToken}` }
        }).catch(err => console.log('Folder move notice:', err));
      }

      await uploadDbToDrive();
    } else {
      console.log('Uploading DB into CalendarApp folder...');
      await uploadDbToDrive();
    }
  } catch (err) {
    console.error('Drive file check error:', err);
  }
}

async function uploadDbToDrive() {
  if (!gdriveToken || !db) return;
  updateBadge('Uploading to Drive...', true);

  try {
    const binaryData = db.export();
    const metadata = {
      name: DRIVE_FILE_NAME,
      mimeType: 'application/x-sqlite3'
    };
    if (!gdriveFileId && gdriveFolderId) {
      metadata.parents = [gdriveFolderId];
    }

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([binaryData], { type: 'application/x-sqlite3' }));

    let url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    let method = 'POST';

    if (gdriveFileId) {
      url = `https://www.googleapis.com/upload/drive/v3/files/${gdriveFileId}?uploadType=multipart`;
      if (gdriveFolderId) {
        url += `&addParents=${gdriveFolderId}`;
      }
      method = 'PATCH';
    }

    const res = await fetch(url, {
      method: method,
      headers: { Authorization: `Bearer ${gdriveToken}` },
      body: form
    });

    const result = await res.json();
    if (result.id) {
      gdriveFileId = result.id;
      updateBadge('Drive Synced ✓', true);
      console.log('Uploaded DB to Google Drive (CalendarApp folder) successfully!');
    }
  } catch (err) {
    console.error('Failed to upload to Google Drive:', err);
    updateBadge('Drive Upload Failed', false);
  }
}

async function downloadDbFromDrive() {
  if (!gdriveToken || !gdriveFileId) return;
  updateBadge('Pulling from Drive...', true);

  try {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${gdriveFileId}?alt=media`, {
      headers: { Authorization: `Bearer ${gdriveToken}` }
    });
    const arrayBuffer = await res.arrayBuffer();
    const u8 = new Uint8Array(arrayBuffer);

    db = new SQL.Database(u8);
    await saveDbToIndexedDB();
    loadMasterDataFromDb();
    renderCurrentView();

    updateBadge('Drive Synced ✓', true);
    alert('Successfully updated local database from Google Drive single source of truth!');
  } catch (err) {
    console.error('Failed to download from Drive:', err);
    alert('Error pulling file from Google Drive: ' + err.message);
  }
}

function triggerAutoDriveSync() {
  if (gdriveToken && gdriveFileId) {
    uploadDbToDrive();
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
      triggerAutoDriveSync();
      alert('SQLite database imported successfully!');
    } catch (err) {
      alert('Error parsing SQLite file: ' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

/* ==========================================================================
   12. EVENT LISTENERS SETUP
   ========================================================================== */

function setupUIEventListeners() {
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

  // Settings & Google Drive modal events
  document.getElementById('openSettingsBtn').addEventListener('click', () => {
    document.getElementById('settingsModal').classList.remove('hidden');
  });
  document.getElementById('closeSettingsBtn').addEventListener('click', () => {
    document.getElementById('settingsModal').classList.add('hidden');
  });
  document.getElementById('syncDriveBtn').addEventListener('click', () => {
    document.getElementById('settingsModal').classList.remove('hidden');
  });

  document.getElementById('gdriveSignInBtn').addEventListener('click', handleGoogleDriveSignIn);
  document.getElementById('gdriveUploadNowBtn').addEventListener('click', uploadDbToDrive);
  document.getElementById('gdriveDownloadNowBtn').addEventListener('click', downloadDbFromDrive);
  document.getElementById('saveClientIdBtn').addEventListener('click', handleSaveClientId);

  document.getElementById('exportDbBtn').addEventListener('click', exportSqliteFile);
  document.getElementById('importDbInput').addEventListener('change', importSqliteFile);

  // Schedule Details Modal Events
  document.getElementById('closeScheduleDetailsBtn').addEventListener('click', closeScheduleDetailsModal);
  document.getElementById('detailsCloseBtn').addEventListener('click', closeScheduleDetailsModal);
  document.getElementById('detailsEditBtn').addEventListener('click', () => {
    const sch = activeViewingSchedule;
    closeScheduleDetailsModal();
    if (sch) openScheduleModal(sch);
  });
}

let activeViewingSchedule = null;

function openScheduleDetailsModal(s) {
  if (!s) return;
  activeViewingSchedule = s;

  const isTravel = s.title && (s.title.toLowerCase().startsWith('travel:') || s.title.toLowerCase().startsWith('return travel:') || s.title.toLowerCase() === 'travel');
  const headingEl = document.getElementById('detailsModalHeading');
  headingEl.innerHTML = isTravel ? '<i class="fa-solid fa-train"></i> Travel Details' : '<i class="fa-solid fa-calendar-day"></i> Schedule Details';

  const body = document.getElementById('scheduleDetailsBody');
  body.innerHTML = '';

  // Title
  const titleItem = document.createElement('div');
  titleItem.className = 'schedule-detail-item';
  titleItem.innerHTML = `
    <span class="schedule-detail-label">Title</span>
    <span class="schedule-detail-value" style="font-weight: 600; font-size: 1.05rem; color: #f8fafc;">${s.title}</span>
  `;
  body.appendChild(titleItem);

  // Date & Time
  const dateTimeItem = document.createElement('div');
  dateTimeItem.className = 'schedule-detail-item';
  dateTimeItem.innerHTML = `
    <span class="schedule-detail-label">Date & Time</span>
    <span class="schedule-detail-value">📅 ${formatDateIndian(s.schedule_date)} | ⏰ ${formatTimeRange(s.from_time, s.to_time)}</span>
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
      <span style="font-size: 0.75rem; padding: 2px 8px; border-radius: 3px; background: rgba(255,255,255,0.1); color: #cbd5e1; font-weight: 600;">
        Status: ${s.status ? s.status.toUpperCase() : 'CONFIRMED'}
      </span>
      ${s.group_id ? '<span style="font-size: 0.75rem; padding: 2px 8px; border-radius: 3px; background: rgba(99,102,241,0.25); color: #a5b4fc; font-weight: 600;">👥 Batch Group</span>' : ''}
    </div>
  `;
  body.appendChild(statusItem);

  // Location / Route
  if (s.location) {
    const locItem = document.createElement('div');
    locItem.className = 'schedule-detail-item';
    locItem.innerHTML = `
      <span class="schedule-detail-label">Location / Route</span>
      <span class="schedule-detail-value">📍 ${s.location}</span>
    `;
    body.appendChild(locItem);
  }

  // Tags
  if (s.tags && s.tags.length > 0) {
    const tagsItem = document.createElement('div');
    tagsItem.className = 'schedule-detail-item';
    const tagBadges = s.tags.map(t => {
      const bg = t.color ? t.color + '40' : 'rgba(255,255,255,0.1)';
      return `<span class="chip-tag-pill" style="background:${bg}; font-size:0.75rem; padding:3px 8px; border-radius:4px;">${t.name}</span>`;
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
      <div class="schedule-detail-value" style="background: var(--bg-primary); padding: 10px; border-radius: 6px; font-size: 0.85rem; border: 1px solid var(--border-color); white-space: pre-wrap;">${s.notes}</div>
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
        if (att.type && att.type.startsWith('image/')) {
          attPill.innerHTML = `<img src="${att.data}" class="ticket-thumb-img"> <span>${att.name}</span>`;
          attPill.addEventListener('click', () => {
            const w = window.open('');
            w.document.write(`<img src="${att.data}" style="max-width:100%; height:auto;">`);
          });
        } else {
          attPill.innerHTML = `<i class="fa-solid fa-file-pdf"></i> <span>${att.name}</span>`;
          attPill.addEventListener('click', () => {
            const w = window.open('');
            w.document.write(`<iframe src="${att.data}" style="width:100%; height:100vh; border:none;"></iframe>`);
          });
        }
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
