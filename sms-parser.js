/* SMS parser for Indian bank / UPI / card alerts.
 * Pure functions, no DOM and no storage: the same file runs in the app (window.SmsParser)
 * and in Node for tests (module.exports).
 *
 * parseBankSms(text, receivedYmd) -> {
 *   direction: 'payment' | 'receipt' | null,   // money out / money in
 *   amount: number | null,                     // rupees
 *   date: 'YYYY-MM-DD',                        // from the message, else receivedYmd
 *   dateFromText: boolean,
 *   acctLast4: string | '',                    // the user's own account/card
 *   party: string | '',                        // VPA, merchant or person
 *   ref: string | '',                          // UPI / IMPS / UTR reference
 *   readable: boolean                          // amount and direction both found
 * }
 * isOtpMessage(text) -> true for OTP / verification-code messages (never stored).
 * splitSharedText(text) -> one or more message texts (several SMS shared at once).
 */
(function (root) {
  'use strict';

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

  const AMT = '([0-9][0-9,]*(?:\\.[0-9]{1,2})?)';
  const CUR = '(?:rs\\.?|inr|₹)';

  function ymd(y, m, d) {
    if (y < 100) y += 2000;
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  function toNumber(s) {
    const n = parseFloat(String(s).replace(/,/g, ''));
    return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  }

  // OTP and verification-code messages. "Never share your OTP" inside a debit alert is not one.
  function isOtpMessage(text) {
    const t = String(text || '');
    return /\b(?:otp|one[\s-]?time\s*password)\s*(?:is|for|:|-)/i.test(t) ||
      /\bis\s+(?:the\s+|your\s+)?(?:otp|one[\s-]?time\s*password)\b/i.test(t) ||
      /\bverification\s+code\b/i.test(t);
  }

  function findDirection(t) {
    const debit = /\b(debited|spent|paid|sent|withdrawn|withdrawal|purchase|purchased|transferred\s+to|trf\s+to|deducted)\b/i.exec(t);
    const credit = /\b(credited|received|deposited|refund(?:ed)?|reversed|reversal|cashback)\b/i.exec(t);
    if (debit && credit) return debit.index <= credit.index ? 'payment' : 'receipt';
    if (debit) return 'payment';
    if (credit) return 'receipt';
    return null;
  }

  function findAmount(t) {
    // "debited by 250.0" / "credited by Rs500" (SBI writes the amount without a currency).
    const verb = new RegExp('\\b(?:debited|credited|spent|paid|sent|received|withdrawn)\\s+(?:by|for|with|of)?\\s*' + CUR + '?\\s*:?\\s*' + AMT, 'i').exec(t);
    if (verb) {
      const n = toNumber(verb[1]);
      if (n) return n;
    }
    const re = new RegExp(CUR + '\\s*:?\\s*' + AMT, 'gi');
    let m;
    while ((m = re.exec(t))) {
      const before = t.slice(Math.max(0, m.index - 24), m.index);
      if (/(bal|balance|limit|avl|available|outstanding|due|min\.?\s*amt)/i.test(before)) continue;
      const n = toNumber(m[1]);
      if (n) return n;
    }
    return null;
  }

  function findDate(t, receivedYmd) {
    const pats = [
      // 2026-11-26
      [/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/, m => ymd(+m[1], +m[2], +m[3])],
      // 26-11-26, 26/11/2026, 26.11.26 (Indian banks: day first)
      [/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})\b/, m => ymd(+m[3], +m[2], +m[1])],
      // 26-Nov-26, 26Nov26, 26 Nov 2026, 26-NOV-2026
      [/\b(\d{1,2})[-\s]?([a-z]{3,4})[-\s,]*(\d{4}|\d{2})\b/i, m => {
        const mo = MONTHS[m[2].toLowerCase()];
        return mo ? ymd(+m[3], mo, +m[1]) : null;
      }],
      // Nov 26, 2026
      [/\b([a-z]{3,4})\s+(\d{1,2}),?\s+(\d{4})\b/i, m => {
        const mo = MONTHS[m[1].toLowerCase()];
        return mo ? ymd(+m[3], mo, +m[2]) : null;
      }],
    ];
    for (const [re, fn] of pats) {
      const m = re.exec(t);
      if (!m) continue;
      const d = fn(m);
      if (!d) continue;
      // Reject dates in the future or more than ~13 months before the share (likely a misread).
      if (receivedYmd) {
        const r = new Date(receivedYmd + 'T00:00:00');
        const x = new Date(d + 'T00:00:00');
        const days = (r - x) / 86400000;
        if (days < -1 || days > 400) continue;
      }
      return d;
    }
    return null;
  }

  function findAcct(t) {
    const re = /\b(?:a\/c|ac|acct|account|card)\s*(?:no\.?|number)?\s*[:.]?\s*(?:ending(?:\s*with)?\s*|[x*#]+\s*)?(\d{3,6})\b/gi;
    const m = re.exec(t);
    return m ? m[1].slice(-4) : '';
  }

  function findRef(t) {
    const pats = [
      /UPI\/[A-Z0-9]+\/(\d{9,})/i,
      /\(\s*UPI\s*[:\s]?\s*(\d{9,})\s*\)/i,
      /\bUPI\s*[:\s]\s*(\d{9,})/i,
      /\b(?:upi\s*ref(?:erence)?(?:\s*no)?|imps\s*ref(?:\s*no)?|ref(?:erence)?\s*(?:no|number|id)?|refno|utr(?:\s*no)?|rrn|txn\s*(?:id|no)|transaction\s*(?:id|no))\s*[.:#-]?\s*(?:is\s*)?([A-Z0-9]{6,22})\b/i,
    ];
    for (const re of pats) {
      const m = re.exec(t);
      if (m && /\d/.test(m[1])) return m[1].toUpperCase();
    }
    return '';
  }

  const NOT_A_PARTY = /\b(bank|a\/c|acct|account|card|your|you|ur|wallet|upi|india)\b/i;

  function cleanParty(s) {
    return String(s || '').replace(/\s+/g, ' ').replace(/[\s.,;:-]+$/, '').trim();
  }

  function findParty(t, direction, raw) {
    // UPI handle, e.g. swiggy@icici, 98xxxx@ybl
    const vpa = /\b([a-z0-9][a-z0-9._-]{1,}@[a-z][a-z0-9]{1,})(?![a-z0-9]|\.[a-z])/i.exec(t);
    if (vpa) return vpa[1].toLowerCase();
    // Axis-style narration: UPI/P2M/433012345678/MERCHANT NAME
    // (read from the original text: the narration ends at its line break)
    const slash = /UPI\/[A-Z0-9]+\/\d+\/([^\/\n]{2,40})/i.exec(raw || t);
    if (slash) return cleanParty(slash[1]);
    // ICICI-style: "...debited for Rs 250.00 on 26-Nov-26; ABC STORES credited."
    if (direction === 'payment') {
      const semi = /;\s*([A-Za-z][A-Za-z0-9 &.'-]{1,40}?)\s+credited\b/i.exec(t);
      if (semi && !NOT_A_PARTY.test(semi[1])) return cleanParty(semi[1]);
    }
    const stop = '(?=\\s+(?:on|ref|refno|via|upi|avl|a\\/c|ac|for|is|has|not|if|thru|through|using|with|dated|at)\\b|\\s*[.;,(]|\\s+-|$)';
    const words = direction === 'receipt'
      ? ['from', 'by', 'received from']
      : ['trf to', 'transferred to', 'paid to', 'at', 'to', 'info[:\\s]', 'towards'];
    for (const w of words) {
      const re = new RegExp('\\b' + w + '\\s*([A-Za-z0-9][A-Za-z0-9 &.\'-]{1,40}?)' + stop, 'gi');
      let m;
      while ((m = re.exec(t))) {
        const cand = cleanParty(m[1]);
        if (cand.length < 2 || NOT_A_PARTY.test(cand) || /^\d+$/.test(cand) || /^(?:rs\.?|inr|₹)\s*\d|^(?:rs|inr)$/i.test(cand)) continue;
        if (/^\d{1,2}[-/]/.test(cand)) continue; // a date
        return cand;
      }
    }
    return '';
  }

  function parseBankSms(text, receivedYmd) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    const direction = findDirection(t);
    const amount = findAmount(t);
    const fromText = findDate(t, receivedYmd);
    return {
      direction,
      amount,
      date: fromText || receivedYmd || null,
      dateFromText: !!fromText,
      acctLast4: findAcct(t),
      party: findParty(t, direction, String(text || '')),
      ref: findRef(t),
      readable: !!(direction && amount),
    };
  }

  // Several SMS shared together arrive as one text separated by blank lines.
  // Split only when at least two parts look like money messages; otherwise keep the text whole.
  function splitSharedText(text) {
    const whole = String(text || '').trim();
    if (!whole) return [];
    const parts = whole.split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) return [whole];
    const money = parts.filter(p => findAmount(p.replace(/\s+/g, ' ')) && findDirection(p));
    return money.length >= 2 ? parts : [whole];
  }

  const api = { parseBankSms, isOtpMessage, splitSharedText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SmsParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
