# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private
[**Report a vulnerability**](https://github.com/SRathinaGiri/CalendarApp/security/advisories/new) form instead.
Include the browser/OS, steps to reproduce, and the impact you observed. You should receive an acknowledgement within 7 days.

Only the latest release (shown in the app's *About* dialog) receives fixes.

## Threat model — what the app protects against

- **Data at rest in the browser profile.** The SQLite database, snapshots and attachments in IndexedDB are encrypted with AES-256-GCM using a key derived from your PIN/passphrase (PBKDF2-HMAC-SHA256, 600,000 iterations, random 16-byte salt). Someone who copies the browser profile cannot read your data without the PIN or recovery key.
- **Network exposure.** The app makes no network requests for your data. All code, fonts and icons are bundled; the Content Security Policy in `index.html` allows only same-origin resources.
- **Exported backups**, when you enable *Encrypt Backup with PIN*. Unencrypted backups are protected only by SHA-256 integrity hashes (corruption detection, not secrecy).

## What it does **not** protect against

- **A compromised device or browser** (malware, malicious extensions, someone using your unlocked session). Extensions with access to the page can read decrypted data while the app is unlocked.
- **Weak PINs.** PBKDF2 slows guessing but a short or common PIN can still be brute-forced offline from a copied profile. Use a passphrase of 10+ characters.
- **Losing both the PIN and the recovery key.** There is no server and no back door — the data cannot be recovered.
- **The "Email to Myself" recovery option.** This puts the recovery key in your email provider's systems. Prefer *Download* or *Copy* and store the key offline.
- **Browser storage eviction.** Browsers may clear site data (low disk, "clear browsing data", private windows). Keep regular full backups.
- **Host integrity.** If you use a hosted copy (e.g. GitHub Pages), you trust that host to serve unmodified code. For maximum assurance, run a local copy you have reviewed.

## Scope

This is a personal, single-device tool provided under the MIT licence **without warranty**. It has not undergone an independent security audit.
