# Third-Party Notices

Calendar App bundles the following third-party components locally so that it runs fully offline and makes no requests to external servers. Each component remains under its own licence.

| Component | Version | Files | Licence |
|---|---|---|---|
| [sql.js](https://github.com/sql-js/sql.js) (SQLite compiled to WebAssembly) | 1.8.x | `sql-wasm.js`, `sql-wasm.wasm` | MIT (sql.js); SQLite itself is public domain |
| [PDF.js](https://github.com/mozilla/pdf.js) | 3.11.174 | `pdf.min.js`, `pdf.worker.min.js` | Apache License 2.0 — © Mozilla Foundation |
| [JSZip](https://github.com/Stuk/jszip) | 3.10.1 | `jszip.min.js` | Dual MIT / GPLv3 — used here under **MIT** — © Stuart Knightley |
| [pako](https://github.com/nodeca/pako) | 2.1.0 | `pako.min.js` | MIT AND Zlib |
| [Font Awesome Free](https://fontawesome.com) | 6.5.1 | `vendor/fontawesome/` | Icons: CC BY 4.0 · Fonts: SIL OFL 1.1 · Code: MIT — © Fonticons, Inc. Full text: [`vendor/fontawesome/LICENSE.txt`](vendor/fontawesome/LICENSE.txt) |
| [Plus Jakarta Sans](https://github.com/tokotype/PlusJakartaSans) (variable, Latin subset via Fontsource) | 5.0.20 | `vendor/fonts/plus-jakarta-sans-latin-wght.woff2` | SIL OFL 1.1 — © The Plus Jakarta Sans Project Authors. Full text: [`vendor/fonts/OFL-PlusJakartaSans.txt`](vendor/fonts/OFL-PlusJakartaSans.txt) |

The licence headers inside each minified file are retained unmodified.

## Updating a bundled library

1. Download the release from the project's official distribution (npm package or GitHub release).
2. Replace the file(s) above, keep the licence header intact, and update the version in this table.
3. Add any new file to `CORE_ASSETS` in `sw.js` and bump `CACHE_NAME` so installed copies pick up the change.
