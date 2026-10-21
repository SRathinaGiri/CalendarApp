# Changelog

All notable changes to this project are documented here. Versions follow the in-app version (`APP_VERSION` in `app.js`, `CACHE_NAME` in `sw.js`).

## v1.3.13 — 2026-10-21

### Clean Orphan Files removes unreadable old ticket copies
- Older versions saved each ticket a second time under a longer alias name. Copies left under a lost key were kept forever, because their names still contained the ticket's name, and every backup reported them as "could not be opened".
- Clean Orphan Files now also removes an alias copy, but only when the ticket's real file (`att_<id>`) exists **and opens** with the current key, **and** the alias itself does not open. Readable aliases, plain aliases, and aliases whose real file is missing or unreadable are always kept. The confirmation lists these separately.

## v1.3.12 — 2026-10-21

### Critical fix: app stuck at start-up when browser storage is full
- **Cause:** every app on `srathinagiri.github.io` shares one 5 MB `localStorage`. Another app (a game's saved replay) had filled it. The calendar's start-up write of its version number then threw `QuotaExceededError`, which stopped the whole script: no unlock, no menu actions, no updates.
- **Fix:** all 21 `localStorage` writes now go through `lsSet()`, which logs a failure, shows a one-time warning and carries on. Everything essential is in IndexedDB; `localStorage` only holds small caches and preferences.
- Verified: with `localStorage` filled to the last byte, the app starts, unlocks with the PIN and renders.

### Fix: PDF tickets showed a sad-face icon
- The viewer put PDFs in an `<iframe>` with a `data:` URL. The app's Content Security Policy blocks that, and Android Chrome has no in-frame PDF viewer anyway. PDFs are now rendered with the bundled PDF.js as page images (up to 10 pages, sized to the screen). If a PDF can't be rendered, the viewer points to **Download** instead.

## v1.3.11 — 2026-10-21

### Diagnostics
- New **Diagnostics** screen (side menu → Settings & Security). It shows the app version, offline cache, whether the database opens with the key in memory, and every error or warning from the session, captured from start-up (`diagnostics.js`). Phones have no visible console, so this replaces it.
- **Check attachments** lists each stored file (encrypted or not, and whether it opens) and how each ticket reference resolves (exact name, partial name, or not found). It is read-only, and each step has a timeout, so a hang shows up as a named step instead of a frozen screen.
- **Copy report** for sharing. File names are shortened so ticket numbers aren't exposed in full.

## v1.3.10 — 2026-10-21

### Fixes
- The attachment viewer no longer spins forever on a ticket it can't decrypt. Its fallback search used to return the still-encrypted bytes. The viewer now shows a clear message pointing to *Change Security PIN* (re-secure).

## v1.3.9 — 2026-10-21

### Critical fix: PIN rejected while fingerprint still works
- **Cause:** every PIN unlock re-encrypted the database with a fresh salt, but the fingerprint token kept the old key. Over time the fingerprint path (including a silent fallback to older snapshots) saved data under a key the PIN could no longer derive, and attachments ended up under a mix of keys.
- **Repair:** *Change Security PIN* now re-secures everything. It reads the database, snapshots and attachments under every key it can find (the in-memory key plus all PIN + salt combinations), re-encrypts them under one PIN-derived key, and resets the stale fingerprint link. Items no key can open are left untouched and reported, instead of aborting. You may enter the same PIN as the new PIN.
- **Prevention:**
  - PIN unlock no longer re-salts when the file is already consistent. When it must, it resets the fingerprint link instead of leaving it stale.
  - Forgot-PIN reset also resets the fingerprint link.
  - A fingerprint unlock that can only open an older snapshot now pauses saving, so stale data can never overwrite the main database.

### Backup fixes
- Unencrypted full backup no longer crashes with `atob … not correctly encoded` on attachments stored as raw bytes.
- An attachment that can't be read is skipped and listed, instead of failing the whole backup.
- Encrypted backups (full and DB-only) now ask for your PIN and use a key derived from it plus the backup's own salt, so they always restore with the PIN alone. The encrypted full backup also uses your PIN to open attachments stored under older keys.
- Emergency Recovery Key no longer fails with `exportKey … key is not extractable`. It checks that the PIN really opens the database and says so if it doesn't.

## v1.3.8 — 2026-10-21

### Financial statements (continuous books)
- New account type **Equity / Capital**. Record opening balances once as a Journal (e.g. Dr Bank, Cr Capital).
- The books never close: there is no financial year and no closing entries. Every balance is cumulative from the first entry.
- **Trial Balance** (as on a date): every account's Dr/Cr balance by type, with a check that debits equal credits.
- **Income Statement** (From–To): revenue less expenditure for the period, showing the surplus or deficit.
- **Balance Sheet** (as on a date): Equity / Capital, Liabilities and Assets. All revenue less expenditure up to that date appears as a computed *Accumulated surplus/deficit* under Equity (a virtual closing; nothing is posted), so the statement always balances.
- Accounts with no type still appear, flagged, on the side their balance falls, and a warning asks you to classify them.
- The **Account Ledger** now opens each period with an *Opening balance b/f* (everything before the From date), so period ledgers continue correctly.
- For the Trial Balance and Balance Sheet, the date filter shows a single **As on** date.

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
