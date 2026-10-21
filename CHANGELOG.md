# Changelog

All notable changes to this project are documented here. Versions follow the in-app version (`APP_VERSION` in `app.js`, `CACHE_NAME` in `sw.js`).

## v1.3.7 — 2026-10-21

### Chart of Accounts
- New **Chart of Accounts** (side menu → Daily Tools, or "Manage chart of accounts" in the finance form). Each account has a type: Asset, Liability, Revenue or Expenditure.
- On first load, every account name already used in your entries is added automatically as *Unclassified*, and names differing only in case or spacing ("cash ", "Cash") become one account. Stored entries are rewritten to the standard spelling.
- Rename an account, or merge a duplicate into another (e.g. "SBI" → "SBI Bank"). All existing entries are updated in one SQL transaction. A merge is refused if it would leave an entry that debits and credits the same account.
- Unused accounts can be deleted. Accounts that are in use can't be deleted.
- The finance form now picks debit/credit accounts from the chart (grouped by type) instead of free text, with an inline **+ Add new account…** option.

### Voucher types
- Added **Contra** (cash ↔ bank transfers) and **Journal** (non-cash adjustments) alongside Receipt and Payment, with a hint under the type explaining which side to debit/credit.
- Receipts/Payments/Net Flow totals now count only receipts and payments. Previously every non-receipt entry was counted as a payment.
- Saving is blocked, with a clear message, when the debit and credit accounts are the same, an account is missing, or the amount is zero.

### Ledger
- The ledger account dropdown comes from the chart (grouped by type), and the ledger header shows the account type.
- Ledger matching ignores case and stray spaces.
- Balances display as `₹x Dr` / `₹x Cr` instead of a signed number.

### Fixes
- Editing a transaction keeps its original creation time, so it no longer jumps to the end of the day's list.

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
