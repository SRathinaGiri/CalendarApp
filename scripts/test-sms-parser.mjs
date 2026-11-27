// Tests for sms-parser.js against typical Indian bank / UPI / card alert formats.
// Sample texts are synthetic (made-up names, numbers and references) in each bank's usual layout.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseBankSms, isOtpMessage, splitSharedText } = require('../sms-parser.js');

const R = '2026-11-27'; // date the text was shared
let failed = 0;

function check(name, text, expect) {
  const got = parseBankSms(text, R);
  const bad = Object.entries(expect).filter(([k, v]) => got[k] !== v);
  if (bad.length) {
    failed++;
    console.error(`✗ ${name}\n   ${bad.map(([k, v]) => `${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got[k])}`).join('\n   ')}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

check('SBI UPI debit (no currency)',
  'Dear UPI user A/C X1234 debited by 250.0 on date 26Nov26 trf to RAMESH KUMAR Refno 433012345678. If not u? call 1800111109. -SBI',
  { direction: 'payment', amount: 250, date: '2026-11-26', acctLast4: '1234', party: 'RAMESH KUMAR', ref: '433012345678' });

check('SBI UPI credit',
  'Dear SBI UPI User, ur A/cX1234 credited by Rs500 on 25Nov26 by (Ref no 433098765432)',
  { direction: 'receipt', amount: 500, date: '2026-11-25', acctLast4: '1234', party: '', ref: '433098765432' });

check('HDFC UPI sent',
  'Sent Rs.1,250.00\nFrom HDFC Bank A/C *5678\nTo swiggy@icici\nOn 26/11/26\nRef 433011112222\nNot You?\nCall 18002586161/SMS BLOCK UPI to 7308080808',
  { direction: 'payment', amount: 1250, date: '2026-11-26', acctLast4: '5678', party: 'swiggy@icici', ref: '433011112222' });

check('HDFC credit alert',
  'Credit Alert!\nRs.15,000.00 credited to HDFC Bank A/c XX5678 on 24-11-26 from VPA abc.client@okaxis (UPI 433055556666)',
  { direction: 'receipt', amount: 15000, date: '2026-11-24', acctLast4: '5678', party: 'abc.client@okaxis', ref: '433055556666' });

check('ICICI debit with party before "credited"',
  'ICICI Bank Acct XX901 debited for Rs 340.00 on 26-Nov-26; SRI MURUGAN STORES credited. UPI:433077778888. Call 18002662 for dispute. SMS BLOCK 901 to 9215676766.',
  { direction: 'payment', amount: 340, date: '2026-11-26', acctLast4: '901', party: 'SRI MURUGAN STORES', ref: '433077778888' });

check('Axis debit with UPI narration',
  'INR 999.00 debited\nA/c no. XX3456\n26-11-26, 10:15:31\nUPI/P2M/433012121212/AMAZON PAY\nNot you? SMS BLOCKUPI Cust ID to 919951860002\nAxis Bank',
  { direction: 'payment', amount: 999, date: '2026-11-26', acctLast4: '3456', party: 'AMAZON PAY', ref: '433012121212' });

check('Kotak UPI sent',
  'Sent Rs.80.00 from Kotak Bank AC X7890 to teashop@ybl on 27-11-26.UPI Ref 433034343434. Not you, https://kotak.com/KBANKT/Fraud',
  { direction: 'payment', amount: 80, date: '2026-11-27', acctLast4: '7890', party: 'teashop@ybl', ref: '433034343434' });

check('Credit card spend (balance ignored)',
  'INR 2,499.00 spent using ICICI Bank Card XX4321 on 25-Nov-26 on AMAZON. Avl Limit: INR 1,45,000.00. If not you, call 1800 2662/SMS BLOCK 4321 to 9215676766',
  { direction: 'payment', amount: 2499, date: '2026-11-25', acctLast4: '4321' });

check('Debit with available balance after',
  'Rs 1,000.00 withdrawn at ATM from A/c XX1111 on 26/11/2026. Avl Bal Rs 23,456.78',
  { direction: 'payment', amount: 1000, date: '2026-11-26', acctLast4: '1111' });

check('Salary NEFT credit',
  'Your A/c XX2222 is credited with INR 85,000.00 on 01-11-2026 by NEFT from ACME FINTECH PVT LTD. UTR No SBIN426305123456. Avl Bal INR 1,02,345.00',
  { direction: 'receipt', amount: 85000, date: '2026-11-01', acctLast4: '2222', party: 'ACME FINTECH PVT LTD', ref: 'SBIN426305123456' });

check('Refund to card',
  'Refund of Rs 499.00 from FLIPKART has been credited to your card ending 4321 on 20-11-2026.',
  { direction: 'receipt', amount: 499, date: '2026-11-20', acctLast4: '4321', party: 'FLIPKART' });

check('No date in text falls back to share date',
  'Rs.60 paid to autodriver@paytm from A/c XX1234. UPI Ref 433066667777',
  { direction: 'payment', amount: 60, date: R, dateFromText: false, party: 'autodriver@paytm' });

check('Future date rejected, falls back',
  'Rs.100 debited from A/c XX1234 on 30-12-2026 towards EMI',
  { date: R, dateFromText: false });

check('Not a money message',
  'Your parcel has been delivered. Rate your experience at example.com',
  { readable: false });

// OTP / verification messages are rejected; a debit alert that warns "never share OTP" is not.
const otp = [
  '123456 is your OTP for transaction of Rs 2,000 at AMAZON. Valid for 10 mins. Do not share.',
  'OTP for login is 4567. -HDFC Bank',
  'Your verification code is 998877',
];
otp.forEach((t, i) => { if (!isOtpMessage(t)) { failed++; console.error(`✗ OTP ${i} not detected`); } else console.log(`✓ OTP ${i} rejected`); });
const notOtp = 'Rs 250 debited from A/c XX1234 on 26-11-26. Never share your OTP, PIN or CVV with anyone.';
if (isOtpMessage(notOtp)) { failed++; console.error('✗ debit alert with OTP warning wrongly rejected'); } else console.log('✓ debit alert with OTP warning kept');

// Several messages shared at once.
const multi = splitSharedText('Rs.60 paid to a@ybl from A/c XX1234\n\nRs.90 paid to b@ybl from A/c XX1234\n\nRs.500 credited to A/c XX1234 from c@okaxis');
if (multi.length !== 3) { failed++; console.error(`✗ split: expected 3, got ${multi.length}`); } else console.log('✓ split 3 shared messages');
const single = splitSharedText('Dear customer,\n\nRs.60 paid to a@ybl from A/c XX1234');
if (single.length !== 1) { failed++; console.error(`✗ split single: expected 1, got ${single.length}`); } else console.log('✓ one message with a blank line stays whole');

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nAll SMS parser checks passed');
