# Changelog

All notable changes to this project are documented here. Versions follow the in-app version (`APP_VERSION` in `app.js`, `CACHE_NAME` in `sw.js`).

## v1.3.6 — 2026-10-16

### Privacy / offline
- Font Awesome icons and the Plus Jakarta Sans font are now bundled under `vendor/` instead of loading from cdnjs and Google Fonts — opening the app no longer contacts any third-party server.
- Removed the sql.js CDN fallback; the WASM engine loads only from the app's own folder.
- Content Security Policy tightened to same-origin only (CDN hosts removed).
- Service worker now caches only same-origin GET requests and pre-caches the bundled fonts/icons.

### Finance
- Receipts, payments, ledger balances and travel/claim totals are summed in integer paise, removing floating-point drift (e.g. ₹0.10 + ₹0.20 now totals exactly ₹0.30).
- All amounts display with Indian digit grouping (₹1,23,456.78). Negative values display as `-₹…`.
- Saved transaction amounts are normalised to whole paise.

### Project
- Added `THIRD_PARTY_NOTICES.md`, `SECURITY.md`, `CHANGELOG.md` and `.gitattributes`.

## v1.3.5 and earlier

See the [commit history](https://github.com/SRathinaGiri/CalendarApp/commits/main).
