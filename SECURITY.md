# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private
[**Report a vulnerability**](https://github.com/SRathinaGiri/CalendarApp/security/advisories/new) form instead.
Include the browser/OS, steps to reproduce, and the impact you observed. You should receive an acknowledgement within 7 days.

Only the latest release (shown in the app's *About* dialog) receives fixes.

## Threat model — what the app protects against

- **Data at rest in the browser profile.** The SQLite database, snapshots and attachments in IndexedDB are encrypted with AES-256-GCM under a random 256-bit data key (since v1.4.0). That data key is stored only in wrapped (encrypted) form: by a key derived from your PIN/passphrase (PBKDF2-HMAC-SHA256, 600,000 iterations, its own random 16-byte salt), by the fingerprint token (WebAuthn), and by the recovery vault. With no fingerprint unlock, or with fingerprint in hardware **PRF** mode, someone who copies the browser profile cannot read your data without the PIN, the authenticator or the recovery key.
- **Network exposure.** The app makes no network requests for your data. All code, fonts and icons are bundled; the Content Security Policy in `index.html` allows only same-origin resources.
- **Exported backups**, when you enable *Encrypt Backup with PIN*: encrypted with a key derived from your PIN and the backup's own salt (never with the device's data key), so they restore on any device with the PIN alone. Unencrypted backups are protected only by SHA-256 integrity hashes (corruption detection, not secrecy).

## What it does **not** protect against

- **A compromised device or browser** (malware, malicious extensions, someone using your unlocked session). Extensions with access to the page can read decrypted data while the app is unlocked.
- **An old copy of the browser profile after a PIN change.** Changing the PIN only re-wraps the data key; the data key itself stays the same. Anyone who copied your profile *before* the change can still open that copy with the old PIN (or an old recovery key). If you suspect a copy was taken, export a backup, reset the app's site data, and restore — this creates a new data key.
- **A copied profile when fingerprint unlock runs in "UV" mode.** On devices without the WebAuthn PRF extension (many phones), the fingerprint token is wrapped with a key derived from the credential ID stored in the browser profile. The fingerprint check gates the app's own unlock, but someone with a full copy of the profile can unwrap that token without it. Diagnostics shows the mode (`prf` or `uv`). If this matters to you, leave fingerprint unlock off on such devices.
- **Weak PINs.** PBKDF2 slows guessing but a short or common PIN can still be brute-forced offline from a copied profile. Use a passphrase of 10+ characters.
- **Losing both the PIN and the recovery key.** There is no server and no back door — the data cannot be recovered.
- **The "Email to Myself" recovery option.** This puts the recovery key in your email provider's systems. Prefer *Download* or *Copy* and store the key offline.
- **Browser storage eviction.** Browsers may clear site data (low disk, "clear browsing data", private windows). Keep regular full backups.
- **Host integrity.** If you use a hosted copy (e.g. GitHub Pages), you trust that host to serve unmodified code. For maximum assurance, run a local copy you have reviewed.

## Scope

This is a personal, single-device tool provided under the MIT licence **without warranty**. It has not undergone an independent security audit.
