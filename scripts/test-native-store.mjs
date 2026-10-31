// Simulates the Android app's storage: IndexedDB (in memory) + the phone's filesystem (in memory).
// Run: npm run test:native-store
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { indexedDB as fakeIdb, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';

const require = createRequire(import.meta.url);
globalThis.IDBKeyRange = IDBKeyRange;
const { createNativeStore, codec } = require('../native-store.js');

/* ---------- fake Capacitor Filesystem ---------- */
function makeFs() {
  const files = new Map(); // "DIR:path" -> string
  const k = (directory, path) => `${directory}:${path}`;
  return {
    files,
    async writeFile({ path, data, directory }) { files.set(k(directory, path), data); },
    async readFile({ path, directory }) {
      if (!files.has(k(directory, path))) throw new Error('File does not exist');
      return { data: files.get(k(directory, path)) };
    },
    async deleteFile({ path, directory }) {
      if (!files.delete(k(directory, path))) throw new Error('File does not exist');
    },
    async rename({ from, to, directory }) {
      const v = files.get(k(directory, from));
      if (v === undefined) throw new Error('missing');
      files.delete(k(directory, from)); files.set(k(directory, to), v);
    },
    async readdir({ path, directory }) {
      const prefix = k(directory, path) + '/';
      const names = new Set();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0]);
      }
      if (!names.size) throw new Error('Directory does not exist');
      return { files: [...names].map((name) => ({ name })) };
    },
  };
}

/* ---------- helpers mirroring app.js ---------- */
const ORIG = { ...Object.fromEntries(['put', 'add', 'delete', 'clear'].map((m) => [m, IDBObjectStore.prototype[m]])) };
const restoreProto = () => Object.assign(IDBObjectStore.prototype, ORIG);

function openAppDb() {
  return new Promise((resolve, reject) => {
    const req = fakeIdb.open('SRGCalendarDB', 2);
    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains('files')) idb.createObjectStore('files');
      if (!idb.objectStoreNames.contains('snapshots')) idb.createObjectStore('snapshots', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
async function appWrite(fn, stores = ['files']) {
  const idb = await openAppDb();
  const tx = idb.transaction(stores, 'readwrite');
  fn(tx);
  await done(tx);
  idb.close();
}
async function appGet(key, store = 'files') {
  const idb = await openAppDb();
  const v = await new Promise((res) => { const r = idb.transaction(store).objectStore(store).get(key); r.onsuccess = () => res(r.result); });
  idb.close();
  return v;
}
function wipeIdb() {
  return new Promise((res, rej) => { const r = fakeIdb.deleteDatabase('SRGCalendarDB'); r.onsuccess = res; r.onerror = rej; r.onblocked = () => rej(new Error('blocked')); });
}
let clock = Date.parse('2026-10-31T10:00:00Z');
function launch(FS) {
  restoreProto();
  const quiet = { error() {}, warn() {}, log() {} };
  const store = createNativeStore({ FS, indexedDB: fakeIdb, IDBObjectStore, win: { APP_VERSION: 'v1.5.0' }, now: () => clock, log: quiet });
  return store;
}

const dbBytes = new Uint8Array(4096).map((_, i) => (i * 31) % 256);
const envelope = { v: 3, dekId: 'abc', salt: new Uint8Array([1, 2, 3, 4]), wrapped: new Uint8Array(48).fill(9), iter: 600000, $t: 'clash' };
let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('✓', name); };

/* ---------- tests ---------- */
await t('codec round-trips typed arrays, buffers, nested objects, $t keys, odd numbers', async () => {
  const v = { a: dbBytes.subarray(10, 20), b: new Uint16Array([1, 65535]).buffer, c: [new Date(5), NaN, -Infinity, undefined], d: envelope, e: new Map([[1, 'x']]) };
  const back = codec.decode(JSON.parse(JSON.stringify(codec.encode(v))));
  assert.deepEqual([...back.a], [...dbBytes.subarray(10, 20)]);
  assert.equal(back.a.byteOffset, 0);
  assert.deepEqual([...new Uint16Array(back.b)], [1, 65535]);
  assert.equal(back.c[0].getTime(), 5); assert.ok(Number.isNaN(back.c[1])); assert.equal(back.c[2], -Infinity); assert.equal(back.c[3], undefined);
  assert.deepEqual(back.d.salt, envelope.salt); assert.equal(back.d.$t, 'clash');
  assert.equal(back.e.get(1), 'x');
  assert.throws(() => codec.encode({ k: new (class CryptoKeyLike {})() }), codec.Unserializable);
  assert.ok(codec.keyToName('x'.repeat(500)).startsWith('h_'));
  assert.equal(codec.keyToName('att_1'), codec.keyToName('att_1'));
});

const FS = makeFs();

await t('every committed write is mirrored to private storage', async () => {
  const s = launch(FS); await s.start();
  await appWrite((tx) => {
    tx.objectStore('files').put(dbBytes, 'active_sqlite');
    tx.objectStore('files').put(envelope, 'srg_key_envelope');
    tx.objectStore('files').put('ENC:attachment-data', 'att_42');
    tx.objectStore('snapshots').put({ id: 111, label: 'snap', data: dbBytes });
  }, ['files', 'snapshots']);
  await s.whenIdle();
  const m = await s._internals.readMirrorStore('files');
  assert.equal(m.length, 3);
  assert.deepEqual([...m.find((e) => e.key === 'active_sqlite').value], [...dbBytes]);
  const snaps = await s._internals.readMirrorStore('snapshots');
  assert.equal(snaps[0].value.id, 111);
});

await t('aborted transactions are NOT mirrored', async () => {
  const s = launch(FS); await s.start();
  const idb = await openAppDb();
  const tx = idb.transaction('files', 'readwrite');
  tx.objectStore('files').put(new Uint8Array([7]), 'active_sqlite');
  tx.abort();
  await new Promise((r) => { tx.onabort = r; });
  idb.close();
  await s.whenIdle();
  const m = await s._internals.readMirrorStore('files');
  assert.deepEqual([...m.find((e) => e.key === 'active_sqlite').value], [...dbBytes]);
});

await t('delete and unserializable values remove the mirror copy (never stale)', async () => {
  const s = launch(FS); await s.start();
  await appWrite((tx) => { tx.objectStore('files').put('tmp', 'att_tmp'); });
  await s.whenIdle();
  await appWrite((tx) => { tx.objectStore('files').delete('att_tmp'); });
  await appWrite((tx) => { tx.objectStore('files').put(new (class NotCloneableHere {})(), 'att_42'); });
  await s.whenIdle();
  const keys = (await s._internals.readMirrorStore('files')).map((e) => e.key).sort();
  assert.deepEqual(keys, ['active_sqlite', 'srg_key_envelope']);
  await appWrite((tx) => { tx.objectStore('files').put('ENC:attachment-data', 'att_42'); });
  await s.whenIdle();
});

await t('backup bundle is written to Documents and never for an empty database', async () => {
  const s = launch(FS); await s.start();
  await s.writeBackup(); await s.whenIdle();
  assert.ok(FS.files.has('DOCUMENTS:SRGCalendar/SRGCalendar-latest.srgbak'));
  assert.ok(FS.files.has('DOCUMENTS:SRGCalendar/SRGCalendar-2026-10-31.srgbak'));
  const parsed = s.parseBundle(FS.files.get('DOCUMENTS:SRGCalendar/SRGCalendar-latest.srgbak'));
  assert.equal(parsed.files.length, 3);
  assert.equal(parsed.appVersion, 'v1.5.0');
});

await t('BROWSER STORAGE WIPED → data restored from private copy before the app starts', async () => {
  await wipeIdb();
  const s = launch(FS); await s.start();
  assert.equal(s.state.restoredFrom, 'mirror');
  assert.deepEqual([...(await appGet('active_sqlite'))], [...dbBytes]);
  assert.deepEqual(await appGet('srg_key_envelope'), envelope);
  assert.equal((await appGet(111, 'snapshots')).label, 'snap');
});

await t('"Clear data" (private copy gone too) → restored from Documents backup', async () => {
  for (const key of [...FS.files.keys()]) if (key.startsWith('DATA:')) FS.files.delete(key);
  await wipeIdb();
  const s = launch(FS); await s.start(); await s.whenIdle();
  assert.equal(s.state.restoredFrom, 'backup');
  assert.deepEqual([...(await appGet('active_sqlite'))], [...dbBytes]);
  assert.equal((await s._internals.readMirrorStore('files')).length, 3, 'mirror rebuilt');
});

await t('new install with nothing anywhere starts empty and writes no backup', async () => {
  const empty = makeFs();
  await wipeIdb();
  const s = launch(empty); await s.start(); await s.writeBackup(); await s.whenIdle();
  assert.equal(s.state.restoredFrom, null);
  assert.ok(![...empty.files.keys()].some((k) => k.startsWith('DOCUMENTS:')));
});

await t('restore from a .srgbak file replaces data and the mirror follows', async () => {
  await wipeIdb();
  const s = launch(FS); await s.start(); await s.whenIdle();
  const other = JSON.stringify({ format: 'srg-calendar-native-backup', version: 1, createdAt: '2026-10-21T10:00:00Z',
    stores: { files: [{ k: 'active_sqlite', v: codec.encode(new Uint8Array([5, 5, 5])) }] } });
  await s.restoreBundleText(other); await s.whenIdle();
  assert.deepEqual([...(await appGet('active_sqlite'))], [5, 5, 5]);
  assert.equal(await appGet('att_42'), undefined);
  const m = await s._internals.readMirrorStore('files');
  assert.deepEqual(m.map((e) => e.key), ['active_sqlite']);
  assert.throws(() => s.parseBundle('{"format":"nope"}'), /not a Calendar App/);
});

await t('only the last 14 daily backups are kept', async () => {
  const s = launch(FS); await s.start();
  for (let d = 0; d < 20; d++) { clock += 86400000; await s.writeBackup(); }
  await s.whenIdle();
  const dated = [...FS.files.keys()].filter((k) => /SRGCalendar-\d{4}-\d{2}-\d{2}\.srgbak$/.test(k));
  assert.equal(dated.length, 14);
});

console.log(`\n${passed} tests passed`);
process.exit(0);
