/* ==========================================================================
   native-store.js — durable storage layer for the Android (Capacitor) app.

   Browser storage can be wiped by the browser (low disk space, "clear site
   data", cleaner apps). In the Android app this layer keeps two extra copies
   of everything the calendar writes to IndexedDB:

     1. MIRROR  — app-private files (DATA/srg-mirror). Written after every
                  committed IndexedDB transaction. Only uninstall or
                  "Clear data" removes it. If IndexedDB comes up empty while
                  the mirror has data, the mirror is copied back before the
                  app starts.
     2. BACKUP  — Documents/SRGCalendar/*.srgbak, a single-file bundle that
                  survives uninstall and can be copied off the phone. Written
                  a few seconds after changes, kept for 14 days.

   Everything copied is already encrypted by the app (data key wrapped by the
   PIN / recovery key), so these files are as safe as the app's own storage.

   In a normal browser (the PWA) this file only asks for persistent storage
   and does nothing else.
   ========================================================================== */
(function (root) {
  'use strict';

  const DB_NAME = 'SRGCalendarDB';
  const DB_VERSION = 2;
  const MIRROR_DIR = 'srg-mirror';
  const BACKUP_DIR = 'SRGCalendar';
  const EXPORT_DIR = 'SRGCalendar/Exports';
  const BACKUP_FORMAT = 'srg-calendar-native-backup';
  const BACKUP_KEEP_DAYS = 14;
  const BACKUP_DEBOUNCE_MS = 8000;
  const BACKUP_STORES = ['files']; // snapshots are local history only; they would bloat every backup

  /* ---------------- value codec (IndexedDB values <-> JSON) ---------------- */

  function bytesToB64(u8) {
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  class Unserializable extends Error {}

  const VIEW_TYPES = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
    'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'DataView'];

  function encode(v) {
    if (v === undefined) return { $t: 'undef' };
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : { $t: 'num', v: String(v) };
    if (typeof v === 'bigint') return { $t: 'bigint', v: String(v) };
    if (typeof v !== 'object') throw new Unserializable(typeof v);
    if (v instanceof ArrayBuffer) return { $t: 'ab', b: bytesToB64(new Uint8Array(v)) };
    if (ArrayBuffer.isView(v)) {
      const name = VIEW_TYPES.includes(v.constructor && v.constructor.name) ? v.constructor.name : 'Uint8Array';
      return { $t: 'view', c: name, b: bytesToB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    }
    if (v instanceof Date) return { $t: 'date', v: v.getTime() };
    if (Array.isArray(v)) return v.map(encode);
    if (v instanceof Map) return { $t: 'map', e: Array.from(v, ([k, val]) => [encode(k), encode(val)]) };
    if (v instanceof Set) return { $t: 'set', e: Array.from(v, encode) };
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      // CryptoKey, Blob, File, ... cannot be copied byte-for-byte.
      throw new Unserializable(v.constructor ? v.constructor.name : 'object');
    }
    const o = {};
    for (const k of Object.keys(v)) o[k] = encode(v[k]);
    return Object.prototype.hasOwnProperty.call(v, '$t') ? { $t: 'obj', v: o } : o;
  }

  function decode(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(decode);
    switch (v.$t) {
      case 'undef': return undefined;
      case 'num': return Number(v.v);
      case 'bigint': return BigInt(v.v);
      case 'ab': return b64ToBytes(v.b).buffer;
      case 'view': {
        const bytes = b64ToBytes(v.b);
        if (v.c === 'DataView') return new DataView(bytes.buffer);
        const Ctor = (VIEW_TYPES.includes(v.c) && root[v.c]) || Uint8Array;
        return Ctor === Uint8Array ? bytes : new Ctor(bytes.buffer);
      }
      case 'date': return new Date(v.v);
      case 'map': return new Map(v.e.map(([k, val]) => [decode(k), decode(val)]));
      case 'set': return new Set(v.e.map(decode));
      case 'obj': return decodePlain(v.v);
      default: return decodePlain(v);
    }
  }

  function decodePlain(o) {
    const out = {};
    for (const k of Object.keys(o)) out[k] = decode(o[k]);
    return out;
  }

  // Deterministic, filesystem-safe name for an IndexedDB key.
  function fnv1a(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  function keyToName(key) {
    const json = JSON.stringify(encode(key));
    const b64 = bytesToB64(new TextEncoder().encode(json)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (b64.length <= 150) return 'k_' + b64;
    return 'h_' + fnv1a(json, 0x811c9dc5) + fnv1a(json, 0x050c5d1f) + fnv1a(json.split('').reverse().join(''), 0x811c9dc5);
  }

  const codec = { encode, decode, keyToName, bytesToB64, b64ToBytes, Unserializable };

  /* ---------------- the store ---------------- */

  function createNativeStore(env) {
    const { FS, indexedDB, IDBObjectStore, win, log = console } = env;
    const now = env.now || (() => Date.now());

    const state = {
      ready: false,
      restoredFrom: null,          // 'mirror' | 'backup' | null
      lastMirrorWriteAt: null,
      lastMirrorError: null,
      lastBackupAt: null,
      lastBackupFile: null,
      lastBackupError: null,
      skippedUnserializable: 0,
    };

    let suspendCapture = 0;
    let chain = Promise.resolve();
    function enqueue(fn) {
      chain = chain.then(fn).catch((e) => {
        state.lastMirrorError = String(e && e.message || e);
        log.error('[native-store]', e);
      });
      return chain;
    }

    /* ---------- filesystem helpers ---------- */

    const storeDir = (store) => `${MIRROR_DIR}/stores/${store}`;

    async function fsWriteText(path, text, directory = 'DATA') {
      await FS.writeFile({ path, data: text, directory, encoding: 'utf8', recursive: true });
    }
    async function fsReadText(path, directory = 'DATA') {
      const r = await FS.readFile({ path, directory, encoding: 'utf8' });
      return typeof r.data === 'string' ? r.data : await r.data.text();
    }
    async function fsDelete(path, directory = 'DATA') {
      try { await FS.deleteFile({ path, directory }); } catch (e) { /* already gone */ }
    }
    async function fsList(path, directory = 'DATA') {
      try {
        const r = await FS.readdir({ path, directory });
        return (r.files || []).map((f) => (typeof f === 'string' ? f : f.name));
      } catch (e) {
        return [];
      }
    }
    // Write to a temp file first so a crash mid-write never leaves a half-written entry.
    async function fsWriteAtomic(path, text, directory = 'DATA') {
      const tmp = path + '.tmp';
      await fsWriteText(tmp, text, directory);
      await fsDelete(path, directory);
      await FS.rename({ from: tmp, to: path, directory, toDirectory: directory });
    }

    /* ---------- mirror writes ---------- */

    async function writeEntry(store, encKey, encVal) {
      const name = keyToName(decode(encKey));
      await fsWriteAtomic(`${storeDir(store)}/${name}.json`, JSON.stringify({ k: encKey, v: encVal }));
    }

    async function deleteEntry(store, key) {
      const name = keyToName(key);
      await fsDelete(`${storeDir(store)}/${name}.json`);
    }

    async function clearStore(store) {
      for (const f of await fsList(storeDir(store))) await fsDelete(`${storeDir(store)}/${f}`);
    }

    async function readMirrorStore(store) {
      const out = [];
      const names = await fsList(storeDir(store));
      const finals = new Set(names.filter((n) => n.endsWith('.json')));
      for (const n of names) {
        // A leftover .tmp only counts if its final file never got written.
        if (n.endsWith('.json.tmp') && finals.has(n.slice(0, -4))) continue;
        if (!n.endsWith('.json') && !n.endsWith('.json.tmp')) continue;
        try {
          const rec = JSON.parse(await fsReadText(`${storeDir(store)}/${n}`));
          out.push({ key: decode(rec.k), value: decode(rec.v) });
        } catch (e) {
          log.warn('[native-store] unreadable mirror entry', n, e);
        }
      }
      return out;
    }

    async function applyOps(ops) {
      for (const op of ops) {
        if (op.type === 'put') {
          if (op.key === undefined) continue;
          if (op.encVal === undefined) { await deleteEntry(op.store, op.key); continue; } // unserializable: never keep a stale copy
          await writeEntry(op.store, encode(op.key), op.encVal);
        } else if (op.type === 'delete') {
          await deleteEntry(op.store, op.key);
        } else if (op.type === 'clear') {
          await clearStore(op.store);
        } else if (op.type === 'resync') {
          await resyncStore(op.store);
        }
      }
      state.lastMirrorWriteAt = now();
      state.lastMirrorError = null;
      scheduleBackup();
    }

    /* ---------- IndexedDB capture ---------- */

    const pending = new WeakMap();

    function record(objStore, op) {
      if (suspendCapture) return;
      let tx;
      try { tx = objStore.transaction; } catch (e) { return; }
      if (!tx || !tx.db || tx.db.name !== DB_NAME) return;
      let ops = pending.get(tx);
      if (!ops) {
        ops = [];
        pending.set(tx, ops);
        tx.addEventListener('complete', () => { pending.delete(tx); enqueue(() => applyOps(ops)); });
        tx.addEventListener('abort', () => pending.delete(tx));
      }
      op.store = objStore.name;
      ops.push(op);
    }

    function isKeyRange(q) {
      return typeof IDBKeyRange !== 'undefined' && q instanceof IDBKeyRange;
    }

    function install() {
      const P = IDBObjectStore.prototype;
      const orig = { put: P.put, add: P.add, delete: P.delete, clear: P.clear };

      const wrapWrite = (fn) => function (value, key) {
        const req = fn.apply(this, arguments);
        try {
          const op = { type: 'put', key: undefined, encVal: undefined };
          try { op.encVal = encode(value); } catch (e) { state.skippedUnserializable++; }
          // The request's result is the effective key, for in-line and out-of-line stores alike.
          req.addEventListener('success', () => { op.key = req.result; });
          record(this, op);
        } catch (e) { log.warn('[native-store] capture failed', e); }
        return req;
      };
      P.put = wrapWrite(orig.put);
      P.add = wrapWrite(orig.add);
      P.delete = function (query) {
        const req = orig.delete.apply(this, arguments);
        try { record(this, isKeyRange(query) ? { type: 'resync' } : { type: 'delete', key: query }); } catch (e) { /* ignore */ }
        return req;
      };
      P.clear = function () {
        const req = orig.clear.apply(this, arguments);
        try { record(this, { type: 'clear' }); } catch (e) { /* ignore */ }
        return req;
      };
    }

    /* ---------- IndexedDB helpers ---------- */

    function openDb() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const idb = e.target.result;
          if (!idb.objectStoreNames.contains('files')) idb.createObjectStore('files');
          if (!idb.objectStoreNames.contains('snapshots')) idb.createObjectStore('snapshots', { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    function reqP(req) {
      return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    function txDone(tx) {
      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
      });
    }

    async function hasLiveDb(idb) {
      const n = await reqP(idb.transaction('files', 'readonly').objectStore('files').count('active_sqlite'));
      return n > 0;
    }

    async function readIdbStore(idb, store) {
      const tx = idb.transaction(store, 'readonly');
      const os = tx.objectStore(store);
      const [keys, values] = await Promise.all([reqP(os.getAllKeys()), reqP(os.getAll())]);
      return keys.map((key, i) => ({ key, value: values[i] }));
    }

    async function writeIdbStore(idb, store, entries, { replace }) {
      suspendCapture++;
      try {
        const tx = idb.transaction(store, 'readwrite');
        const os = tx.objectStore(store);
        if (replace) os.clear();
        const inline = os.keyPath !== null;
        for (const { key, value } of entries) {
          if (inline) os.put(value); else os.put(value, key);
        }
        await txDone(tx);
      } finally {
        suspendCapture--;
      }
    }

    async function resyncStore(store) {
      const idb = await openDb();
      try {
        const entries = await readIdbStore(idb, store);
        const wanted = new Set();
        for (const { key, value } of entries) {
          let encVal;
          try { encVal = encode(value); } catch (e) { state.skippedUnserializable++; continue; }
          wanted.add(keyToName(key) + '.json');
          await writeEntry(store, encode(key), encVal);
        }
        for (const f of await fsList(storeDir(store))) {
          if (!wanted.has(f)) await fsDelete(`${storeDir(store)}/${f}`);
        }
      } finally {
        idb.close();
      }
    }

    /* ---------- external backup bundle ---------- */

    function today() {
      const d = new Date(now());
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function appVersion() {
      try { return typeof win.APP_VERSION !== 'undefined' ? win.APP_VERSION : (typeof APP_VERSION !== 'undefined' ? APP_VERSION : null); } catch (e) { return null; }
    }

    async function buildBundle() {
      const idb = await openDb();
      try {
        if (!(await hasLiveDb(idb))) return null; // never write an empty state as a backup
        const stores = {};
        for (const store of BACKUP_STORES) {
          stores[store] = [];
          for (const { key, value } of await readIdbStore(idb, store)) {
            try { stores[store].push({ k: encode(key), v: encode(value) }); } catch (e) { /* skip unserializable */ }
          }
        }
        return { format: BACKUP_FORMAT, version: 1, createdAt: new Date(now()).toISOString(), appVersion: appVersion(), stores };
      } finally {
        idb.close();
      }
    }

    let backupTimer = null;
    function scheduleBackup() {
      if (!state.ready) return;
      if (backupTimer) clearTimeout(backupTimer);
      backupTimer = setTimeout(() => { backupTimer = null; enqueue(writeBackup); }, BACKUP_DEBOUNCE_MS);
    }
    function flushBackup() {
      if (!backupTimer) return chain;
      clearTimeout(backupTimer);
      backupTimer = null;
      return enqueue(writeBackup);
    }

    async function writeBackup() {
      try {
        const bundle = await buildBundle();
        if (!bundle) return;
        const text = JSON.stringify(bundle);
        const dated = `${BACKUP_DIR}/SRGCalendar-${today()}.srgbak`;
        await fsWriteText(dated, text, 'DOCUMENTS');
        await fsWriteText(`${BACKUP_DIR}/SRGCalendar-latest.srgbak`, text, 'DOCUMENTS');
        state.lastBackupAt = now();
        state.lastBackupFile = dated;
        state.lastBackupError = null;
        await fsWriteText(`${MIRROR_DIR}/backup-status.json`, JSON.stringify({ at: state.lastBackupAt, file: dated }));
        await pruneBackups();
      } catch (e) {
        state.lastBackupError = String(e && e.message || e);
        log.warn('[native-store] backup to Documents failed', e);
      }
    }

    async function pruneBackups() {
      const dated = (await fsList(BACKUP_DIR, 'DOCUMENTS'))
        .filter((n) => /^SRGCalendar-\d{4}-\d{2}-\d{2}\.srgbak$/.test(n))
        .sort();
      for (const n of dated.slice(0, Math.max(0, dated.length - BACKUP_KEEP_DAYS))) {
        await fsDelete(`${BACKUP_DIR}/${n}`, 'DOCUMENTS');
      }
    }

    function parseBundle(text) {
      const b = JSON.parse(text);
      if (!b || b.format !== BACKUP_FORMAT || !b.stores || !Array.isArray(b.stores.files)) {
        throw new Error('This is not a Calendar App phone backup (.srgbak) file.');
      }
      const files = b.stores.files.map((e) => ({ key: decode(e.k), value: decode(e.v) }));
      if (!files.some((e) => e.key === 'active_sqlite')) throw new Error('This backup has no calendar database in it.');
      return { createdAt: b.createdAt, appVersion: b.appVersion, files };
    }

    // Replaces the app's stored data with a backup. Captured normally, so the mirror follows.
    async function restoreBundleText(text) {
      const parsed = parseBundle(text);
      await flushBackup(); // keep a backup of the state being replaced
      const idb = await openDb();
      try {
        const tx = idb.transaction('files', 'readwrite');
        const os = tx.objectStore('files');
        os.clear();
        for (const { key, value } of parsed.files) os.put(value, key);
        await txDone(tx);
      } finally {
        idb.close();
      }
      await chain;
      return parsed;
    }

    /* ---------- start-up ---------- */

    async function start() {
      install();
      try {
        const st = JSON.parse(await fsReadText(`${MIRROR_DIR}/backup-status.json`));
        state.lastBackupAt = st.at; state.lastBackupFile = st.file;
      } catch (e) { /* first run */ }

      const idb = await openDb();
      try {
        if (!(await hasLiveDb(idb))) {
          const mirrored = await readMirrorStore('files');
          if (mirrored.some((e) => e.key === 'active_sqlite')) {
            await writeIdbStore(idb, 'files', mirrored, { replace: true });
            await writeIdbStore(idb, 'snapshots', await readMirrorStore('snapshots'), { replace: true });
            state.restoredFrom = 'mirror';
          } else {
            try {
              const parsed = parseBundle(await fsReadText(`${BACKUP_DIR}/SRGCalendar-latest.srgbak`, 'DOCUMENTS'));
              await writeIdbStore(idb, 'files', parsed.files, { replace: true });
              state.restoredFrom = 'backup';
            } catch (e) { /* nothing to restore: genuinely new install */ }
          }
        }
      } finally {
        idb.close();
      }

      let meta = null;
      try { meta = JSON.parse(await fsReadText(`${MIRROR_DIR}/meta.json`)); } catch (e) { /* none yet */ }
      if (!meta || state.restoredFrom === 'backup') {
        // First run (or data came from outside the mirror): copy everything once.
        await resyncStore('files');
        await resyncStore('snapshots');
        await fsWriteText(`${MIRROR_DIR}/meta.json`, JSON.stringify({ fullSyncAt: now() }));
      }

      state.ready = true;
      if (!state.lastBackupAt || now() - state.lastBackupAt > 12 * 3600 * 1000 || state.restoredFrom) {
        enqueue(writeBackup);
      }
    }

    return {
      state, start, flushBackup, writeBackup: () => enqueue(writeBackup),
      restoreBundleText, parseBundle, whenIdle: () => chain,
      _internals: { readMirrorStore, resyncStore, openDb, readIdbStore },
    };
  }

  /* ---------------- browser wiring ---------------- */

  function wireUi(store, FS) {
    const win = root;
    const doc = win.document;

    const toast = (msg, type = 'info', ms = 5000) => {
      if (typeof win.showToast === 'function') win.showToast(msg, type, ms); else win.alert(msg);
    };

    function fmt(ts) {
      if (!ts) return 'not yet';
      const d = new Date(ts);
      return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    /* Downloads: the Android WebView ignores <a download>, so exports go to Documents/SRGCalendar/Exports. */
    const blobs = new Map();
    const origCreate = win.URL.createObjectURL.bind(win.URL);
    win.URL.createObjectURL = function (obj) {
      const url = origCreate(obj);
      if (obj instanceof win.Blob) { blobs.set(url, obj); setTimeout(() => blobs.delete(url), 120000); }
      return url;
    };

    async function saveDownload(href, filename) {
      const safe = String(filename || 'download').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
      try {
        let bytes;
        if (href.startsWith('data:')) {
          const comma = href.indexOf(',');
          const meta = href.slice(5, comma);
          const payload = href.slice(comma + 1);
          bytes = meta.endsWith(';base64') ? codec.b64ToBytes(payload) : new TextEncoder().encode(decodeURIComponent(payload));
        } else {
          const blob = blobs.get(href) || await (await win.fetch(href)).blob();
          bytes = new Uint8Array(await blob.arrayBuffer());
        }
        await FS.writeFile({ path: `${EXPORT_DIR}/${safe}`, data: codec.bytesToB64(bytes), directory: 'DOCUMENTS', recursive: true });
        toast(`Saved to Documents › SRGCalendar › Exports › ${safe}`, 'success', 6000);
      } catch (e) {
        toast('Could not save the file: ' + (e && e.message || e), 'error', 7000);
      }
    }

    const origClick = win.HTMLAnchorElement.prototype.click;
    win.HTMLAnchorElement.prototype.click = function () {
      const href = this.href || '';
      if (this.hasAttribute('download') && /^(blob:|data:)/.test(href)) { saveDownload(href, this.getAttribute('download')); return; }
      return origClick.apply(this, arguments);
    };
    doc.addEventListener('click', (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a[download]') : null;
      if (a && /^(blob:|data:)/.test(a.href || '')) { e.preventDefault(); saveDownload(a.href, a.getAttribute('download')); }
    }, true);

    /* Phone backup card inside "Database Backup & Restore". */
    function injectCard() {
      const modal = doc.getElementById('serverSyncModal');
      const anchor = doc.getElementById('syncRecommendationBanner');
      if (!modal || !anchor || doc.getElementById('srgPhoneBackupCard')) return;
      const card = doc.createElement('div');
      card.id = 'srgPhoneBackupCard';
      card.style.cssText = 'margin:12px 0;padding:14px;border-radius:12px;border:1px solid var(--border-color, #cbd5e1);background:var(--bg-secondary, transparent);';
      card.innerHTML = `
        <div style="font-weight:700;margin-bottom:6px;"><i class="fa-solid ${win.SRG_PLATFORM === 'windows' ? 'fa-desktop' : 'fa-mobile-screen'}"></i> Automatic ${win.SRG_PLATFORM === 'windows' ? '' : 'phone '}backup</div>
        <div style="font-size:0.9em;line-height:1.5;">
          Every change is copied to the app's private storage and, a few seconds later, to
          <b>Documents › SRGCalendar</b> (last ${BACKUP_KEEP_DAYS} days). Copy those files to Drive or another disk now and then.
        </div>
        <div id="srgPhoneBackupStatus" style="font-size:0.9em;margin:8px 0;"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="btn btn-secondary" id="srgPhoneBackupNow"><i class="fa-solid fa-floppy-disk"></i> Back up now</button>
          <button type="button" class="btn btn-secondary" id="srgPhoneRestoreBtn"><i class="fa-solid fa-clock-rotate-left"></i> Restore from .srgbak file</button>
        </div>
        <input type="file" id="srgPhoneRestoreInput" style="display:none">`;
      anchor.insertAdjacentElement('afterend', card);

      doc.getElementById('srgPhoneBackupNow').addEventListener('click', async () => {
        await store.writeBackup();
        refresh();
        if (store.state.lastBackupError) toast('Backup failed: ' + store.state.lastBackupError, 'error', 7000);
        else toast('Backed up to Documents › SRGCalendar', 'success', 4000);
      });
      const input = doc.getElementById('srgPhoneRestoreInput');
      doc.getElementById('srgPhoneRestoreBtn').addEventListener('click', () => input.click());
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        try {
          const text = await file.text();
          const info = store.parseBundle(text);
          const when = info.createdAt ? fmt(Date.parse(info.createdAt)) : 'unknown date';
          if (!win.confirm(`Restore the phone backup from ${when}?\n\nThe calendar on this phone will be replaced by it. The current state is backed up first. After restoring, unlock with the PIN you were using on that date.`)) return;
          await store.restoreBundleText(text);
          try {
            ['srg_key_envelope', 'srg_db_last_modified', 'srg_biometric_enabled', 'srg_bio_token_b64', 'srg_biometric_cred_id', 'srg_biometric_mode']
              .forEach((k) => win.localStorage.removeItem(k));
          } catch (e) { /* ignore */ }
          win.location.reload();
        } catch (e) {
          toast('Restore failed: ' + (e && e.message || e), 'error', 8000);
        }
      });
    }

    function refresh() {
      const el = doc.getElementById('srgPhoneBackupStatus');
      if (!el) return;
      const s = store.state;
      const parts = [`Last backup: <b>${fmt(s.lastBackupAt)}</b>`];
      if (s.lastBackupError) parts.push(`<span style="color:#e11d48;">Last attempt failed: ${s.lastBackupError.replace(/[<>&]/g, '')}</span>`);
      if (s.lastMirrorError) parts.push(`<span style="color:#e11d48;">Private copy error: ${s.lastMirrorError.replace(/[<>&]/g, '')}</span>`);
      el.innerHTML = parts.join('<br>');
    }

    async function onReady() {
      injectCard();
      try { await win.srgNativeReady; } catch (e) { /* reported in state */ }
      const modal = doc.getElementById('serverSyncModal');
      if (modal && win.MutationObserver) {
        new win.MutationObserver(() => { if (!modal.classList.contains('hidden')) { injectCard(); refresh(); } })
          .observe(modal, { attributes: true, attributeFilter: ['class'] });
      }
      if (store.state.restoredFrom) {
        // Wait for the PIN unlock: the lock screen would hide the message.
        const unlocked = () => { try { return typeof isAppUnlocked !== 'undefined' && isAppUnlocked === true; } catch (e) { return false; } };
        let tries = 0;
        const timer = setInterval(() => {
          if (!unlocked() && ++tries < 600) return;
          clearInterval(timer);
          toast(store.state.restoredFrom === 'mirror'
            ? 'Your data was missing from app storage and has been restored from the private copy.'
            : 'Your data was restored from the backup in Documents › SRGCalendar.', 'success', 9000);
        }, 1000);
      }
    }
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', onReady); else onReady();

    // Write the backup straight away when the app goes to the background.
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') store.flushBackup(); });
  }

  /* ---------------- entry point ---------------- */

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createNativeStore, codec };
    return;
  }

  // Both the PWA and the app: ask the browser not to evict our storage under disk pressure.
  try { if (root.navigator && root.navigator.storage && root.navigator.storage.persist) root.navigator.storage.persist(); } catch (e) { /* ignore */ }

  const Cap = root.Capacitor;
  const isNative = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
  root.SRG_NATIVE = isNative;
  const FS = isNative && Cap.Plugins ? Cap.Plugins.Filesystem : null;

  if (!isNative || !FS) {
    if (isNative) console.error('[native-store] Filesystem plugin missing: phone backup is OFF');
    root.srgNativeReady = Promise.resolve();
    return;
  }

  const store = createNativeStore({ FS, indexedDB: root.indexedDB, IDBObjectStore: root.IDBObjectStore, win: root });
  root.srgNativeStore = store;
  root.srgNativeReady = store.start().catch((e) => {
    store.state.lastMirrorError = String(e && e.message || e);
    console.error('[native-store] start-up failed', e);
  });
  // Android 10 and older need storage permission for Documents; newer versions ignore this.
  try { if (FS.requestPermissions) FS.requestPermissions().catch(() => {}); } catch (e) { /* ignore */ }
  wireUi(store, FS);
})(typeof window !== 'undefined' ? window : globalThis);
