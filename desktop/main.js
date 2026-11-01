// Calendar App for Windows (Electron).
// The web app is served from inside the installer over a private app:// address, so its
// storage belongs to this program (in %APPDATA%\Calendar App), not to any browser.
// The preload gives the page the same Filesystem/Share interface as the Android app, so
// native-store.js keeps a private copy of every change and writes daily backups to
// Documents\SRGCalendar exactly as on the phone.
'use strict';

const { app, BrowserWindow, protocol, ipcMain, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pathToFileURL, fileURLToPath } = require('node:url');

const SCHEME = 'app';
const HOST = 'calendar';
const ORIGIN = `${SCHEME}://${HOST}`;
const WEB_ROOT = path.join(__dirname, 'app-www');

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

if (!app.requestSingleInstanceLock()) {
  // A second copy would write the same database at the same time.
  app.quit();
  process.exit(0);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
};

function inside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function serve(request) {
  const url = new URL(request.url);
  if (url.host !== HOST) return new Response('Not found', { status: 404 });
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(WEB_ROOT, rel));
  if (!inside(WEB_ROOT, file)) return new Response('Forbidden', { status: 403 });
  try {
    const body = await fsp.readFile(file);
    return new Response(body, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' } });
  } catch (e) {
    return new Response('Not found', { status: 404 });
  }
}

/* ---------------- Filesystem (same calls as @capacitor/filesystem) ---------------- */

function baseDir(directory) {
  switch (directory) {
    case 'DATA': return path.join(app.getPath('userData'), 'files');
    case 'DOCUMENTS': return app.getPath('documents');
    case 'CACHE': return path.join(app.getPath('temp'), 'srg-calendar-cache');
    default: throw new Error('Unsupported directory: ' + directory);
  }
}

function resolve(directory, p) {
  const base = baseDir(directory);
  const full = path.normalize(path.join(base, String(p || '')));
  if (!inside(base, full)) throw new Error('Path outside the allowed folder');
  return full;
}

const fsOps = {
  async writeFile({ path: p, data, directory, encoding }) {
    const full = resolve(directory, p);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, encoding === 'utf8' ? String(data) : Buffer.from(String(data), 'base64'));
    return { uri: pathToFileURL(full).href };
  },
  async readFile({ path: p, directory, encoding }) {
    const full = resolve(directory, p);
    let buf;
    try { buf = await fsp.readFile(full); } catch (e) { throw new Error('File does not exist'); }
    return { data: encoding === 'utf8' ? buf.toString('utf8') : buf.toString('base64') };
  },
  async deleteFile({ path: p, directory }) {
    try { await fsp.unlink(resolve(directory, p)); } catch (e) { throw new Error('File does not exist'); }
    return {};
  },
  async readdir({ path: p, directory }) {
    let entries;
    try { entries = await fsp.readdir(resolve(directory, p), { withFileTypes: true }); } catch (e) { throw new Error('Directory does not exist'); }
    return { files: entries.map((d) => ({ name: d.name, type: d.isDirectory() ? 'directory' : 'file' })) };
  },
  async rename({ from, to, directory, toDirectory }) {
    const dest = resolve(toDirectory || directory, to);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rename(resolve(directory, from), dest);
    return {};
  },
  async getUri({ path: p, directory }) {
    return { uri: pathToFileURL(resolve(directory, p)).href };
  },
  async requestPermissions() { return { publicStorage: 'granted' }; },
  async checkPermissions() { return { publicStorage: 'granted' }; },
};

// Windows has no share sheet: "Share" keeps the PDF in Documents\SRGCalendar\Reports and
// opens File Explorer with it selected, ready to drag into an e-mail or WhatsApp Desktop.
async function shareFiles({ files }) {
  const reports = path.join(app.getPath('documents'), 'SRGCalendar', 'Reports');
  await fsp.mkdir(reports, { recursive: true });
  let last = null;
  for (const uri of files || []) {
    const src = fileURLToPath(uri);
    if (!inside(baseDir('CACHE'), src) && !inside(app.getPath('documents'), src)) throw new Error('Cannot share this file');
    const dest = path.join(reports, path.basename(src));
    if (path.resolve(src) !== path.resolve(dest)) await fsp.copyFile(src, dest);
    last = dest;
  }
  if (last) shell.showItemInFolder(last);
  return { activityType: 'explorer' };
}

function fromOurPage(event) {
  // Node reports custom-scheme URLs as origin "null", so compare scheme and host.
  try {
    const u = new URL(event.senderFrame.url);
    return u.protocol === SCHEME + ':' && u.host === HOST;
  } catch (e) { return false; }
}

ipcMain.handle('srg:fs', async (event, op, args) => {
  if (!fromOurPage(event)) throw new Error('Not allowed');
  if (!Object.prototype.hasOwnProperty.call(fsOps, op)) throw new Error('Unknown operation ' + op);
  return fsOps[op](args || {});
});
ipcMain.handle('srg:share', async (event, args) => {
  if (!fromOurPage(event)) throw new Error('Not allowed');
  return shareFiles(args || {});
});

/* ---------------- window ---------------- */

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 860, minWidth: 380, minHeight: 560,
    backgroundColor: '#0f172a',
    title: 'Calendar App',
    icon: path.join(__dirname, 'app-www', 'icon-512.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Printing opens a blank window the app writes into; anything else goes to the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank' || url === '') {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#ffffff', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } } };
    }
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN + '/')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  // Exports are saved by the app itself; never show a browser download prompt.
  mainWindow.webContents.session.on('will-download', (e) => e.preventDefault());

  mainWindow.loadURL(`${ORIGIN}/index.html`);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  protocol.handle(SCHEME, serve);
  Menu.setApplicationMenu(null);
  createWindow();
});

app.on('window-all-closed', () => app.quit());
