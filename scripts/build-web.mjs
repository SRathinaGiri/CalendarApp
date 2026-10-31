// Copies the PWA's runtime files into www/ for Capacitor. The PWA itself keeps running from the repo root.
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www');

const FILES = [
  'index.html', 'app.js', 'styles.css', 'manifest.json', 'sw.js',
  'icon-192.png', 'icon-512.png',
  'diagnostics.js', 'native-store.js', 'taxonomy_seed.js',
  'sql-wasm.js', 'sql-wasm.wasm', 'pako.min.js', 'jszip.min.js',
  'pdf.min.js', 'pdf.worker.min.js',
];
const DIRS = ['vendor'];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const f of FILES) {
  const src = join(root, f);
  if (!existsSync(src)) throw new Error(`Missing web asset: ${f}`);
  cpSync(src, join(out, f));
}
for (const d of DIRS) cpSync(join(root, d), join(out, d), { recursive: true });

console.log(`Copied ${FILES.length} files and ${DIRS.length} folder(s) to www/`);
