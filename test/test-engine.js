/* Node test: CSV -> QBO round trip + validity checks. Run: node test/test-engine.js */
var fs = require('fs');
var path = require('path');
var Engine = require('../index.js');

var csv = fs.readFileSync(path.join(__dirname, 'fixtures/sample-bank.csv'), 'utf8');
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

console.log('StatementEngine v' + Engine.VERSION + ' — CSV -> QBO test\n');

var res = Engine.csvToTransactions(csv, { dateOrder: 'MDY' });
var txns = res.transactions;

// --- parsing checks ---
ok('parsed 7 transactions', txns.length === 7, txns.length);
ok('no parse errors', res.errors.length === 0, JSON.stringify(res.errors));
ok('auto-mapped Date/Description/Amount',
   res.mapping.date === 0 && res.mapping.description === 1 && res.mapping.amount === 2,
   JSON.stringify(res.mapping));
ok('thousands separator parsed (1,500.00 -> 1500)', txns[0].amount === 1500, txns[0].amount);
ok('negative debit parsed', txns[1].amount === -84.21, txns[1].amount);
ok('parentheses = negative ((37.50) -> -37.5)', txns[5].amount === -37.5, txns[5].amount);
ok('date MDY -> YYYYMMDD', txns[0].date === '20260701', txns[0].date);
ok('check number captured', txns[4].checknum === '1042', txns[4].checknum);
ok('type derived (debit<0)', txns[1].type === 'DEBIT' && txns[0].type === 'CREDIT');
ok('FITIDs unique', new Set(txns.map(function (t) { return t.fitid; })).size === 7);

// --- QBO emit checks ---
var qbo = Engine.transactionsToQbo(txns, {
  org: 'ACME Bank', fid: '1234', bankId: '021000021',
  acctId: '1234567890', acctType: 'CHECKING', curdef: 'USD'
});

ok('QBO has OFXSGML header', /OFXHEADER:100[\s\S]*DATA:OFXSGML/.test(qbo));
ok('QBO has <OFX> root', qbo.indexOf('<OFX>') !== -1);
ok('QBO has BANKTRANLIST', qbo.indexOf('<BANKTRANLIST>') !== -1);
ok('QBO emits 7 STMTTRN', (qbo.match(/<STMTTRN>/g) || []).length === 7);
ok('& escaped in NAME (AT&T -> AT&amp;T)', qbo.indexOf('AT&amp;T') !== -1);
ok('amounts have 2 decimals', qbo.indexOf('<TRNAMT>-84.21') !== -1);
ok('DTPOSTED formatted', qbo.indexOf('<DTPOSTED>20260701120000') !== -1);
ok('account fields present', qbo.indexOf('<BANKID>021000021') !== -1 && qbo.indexOf('<ACCTID>1234567890') !== -1);
ok('balanced OFX tags', (qbo.match(/<OFX>/g) || []).length === 1 && (qbo.match(/<\/OFX>/g) || []).length === 1);

// --- split debit/credit mode ---
var splitCsv = 'Date,Details,Debit,Credit\n07/01/2026,Coffee,4.50,\n07/02/2026,Refund,,10.00\n';
var s = Engine.csvToTransactions(splitCsv, { dateOrder: 'MDY' });
ok('split mode auto-detected', s.transactions.length === 2 &&
   s.transactions[0].amount === -4.5 && s.transactions[1].amount === 10,
   JSON.stringify(s.transactions.map(function (t){return t.amount;})));

// --- OFX/QBO parser: re-read the .qbo we just emitted ---
var back = Engine.ofxToTransactions(qbo);
ok('OFX parser read 7 transactions', back.transactions.length === 7, back.transactions.length);
ok('OFX preserved original FITID', back.transactions[0].fitid === txns[0].fitid,
   back.transactions[0].fitid + ' vs ' + txns[0].fitid);
ok('OFX preserved amounts + sign', back.transactions[1].amount === -84.21 && back.transactions[0].amount === 1500,
   JSON.stringify([back.transactions[0].amount, back.transactions[1].amount]));
ok('OFX unescaped & (AT&amp;T -> AT&T)', back.transactions[3].description.indexOf('AT&T') !== -1,
   back.transactions[3].description);
ok('OFX pulled account meta', back.meta.bankId === '021000021' && back.meta.acctId === '1234567890' && back.meta.acctType === 'CHECKING',
   JSON.stringify(back.meta));
ok('OFX kept check number', back.transactions[4].checknum === '1042', back.transactions[4].checknum);

// --- OFX 2.x XML variant (closed leaf tags) ---
var xml = '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>' +
  '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260710120000</DTPOSTED>' +
  '<TRNAMT>-25.00</TRNAMT><FITID>XY1</FITID><NAME>Coffee Shop</NAME></STMTTRN>' +
  '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>';
var xr = Engine.ofxToTransactions(xml);
ok('OFX 2.x XML parsed', xr.transactions.length === 1 && xr.transactions[0].amount === -25 &&
   xr.transactions[0].date === '20260710' && xr.transactions[0].description === 'Coffee Shop',
   JSON.stringify(xr.transactions));

// --- CSV emitter ---
var csvOut = Engine.transactionsToCsv(txns, { columns: ['date','description','amount','checknum'] });
var outLines = csvOut.split('\r\n');
ok('CSV emitter header', outLines[0] === 'Date,Description,Amount,Check #', outLines[0]);
ok('CSV emitter row count (7 + header)', outLines.length === 8, outLines.length);
ok('CSV emitter quotes commas ("1500.00" has none, desc none here)', outLines[1] === '2026-07-01,OPENING DEPOSIT,1500.00,', outLines[1]);
ok('CSV emitter signed amount', csvOut.indexOf('-84.21') !== -1);
var csvSplit = Engine.transactionsToCsv(txns, { columns: ['date','amount'], amountMode: 'split' });
ok('CSV split header Debit/Credit', csvSplit.split('\r\n')[0] === 'Date,Debit,Credit', csvSplit.split('\r\n')[0]);

// --- FULL ROUND TRIP: CSV -> QBO -> parse -> CSV, data intact ---
var rt = Engine.transactionsToCsv(Engine.ofxToTransactions(qbo).transactions,
  { columns: ['date','description','amount','checknum'] });
var rtLines = rt.split('\r\n');
ok('round-trip preserves 7 rows', rtLines.length === 8, rtLines.length);
ok('round-trip preserves opening deposit', rtLines[1].indexOf('1500.00') !== -1, rtLines[1]);
ok('round-trip preserves AT&T (name truncated to 32 in QBO)', rt.indexOf('AT&T') !== -1);
ok('round-trip preserves check #1042', rt.indexOf(',1042') !== -1 || rt.indexOf('1042') !== -1);

// --- QIF emitter + parser round trip ---
var qif = Engine.transactionsToQif(txns, { acctType: 'Bank' });
ok('QIF has !Type:Bank header', qif.split('\n')[0] === '!Type:Bank', qif.split('\n')[0]);
ok('QIF date is MM/DD/YYYY', qif.indexOf('D07/01/2026') !== -1);
ok('QIF signed amount', qif.indexOf('T-84.21') !== -1 && qif.indexOf('T1500.00') !== -1);
ok('QIF payee + record terminator', qif.indexOf('POPENING DEPOSIT') !== -1 && qif.indexOf('\n^') !== -1);
ok('QIF check number', qif.indexOf('N1042') !== -1);
var qifBack = Engine.qifToTransactions(qif);
ok('QIF parser reads 7 transactions', qifBack.transactions.length === 7, qifBack.transactions.length);
ok('QIF round-trip amounts intact', qifBack.transactions[1].amount === -84.21 && qifBack.transactions[0].amount === 1500);
ok('QIF round-trip date intact', qifBack.transactions[0].date === '20260701', qifBack.transactions[0].date);
ok('QIF parses "MM/DD\'YY" style dates', Engine.qifToTransactions("!Type:Bank\nD07/04'26\nT9.99\nPTest\n^\n").transactions[0].date === '20260704');

// --- IIF emitter + parser round trip ---
var iif = Engine.transactionsToIif(txns, { acctName: 'Checking', category: 'Uncategorized' });
ok('IIF has !TRNS header', iif.indexOf('!TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO') !== -1);
ok('IIF emits TRNS + SPL + ENDTRNS per txn', (iif.match(/^TRNS\t/gm) || []).length === 7 &&
   (iif.match(/^SPL\t/gm) || []).length === 7 && (iif.match(/^ENDTRNS$/gm) || []).length === 7);
ok('IIF TRNS amount + SPL negated', iif.indexOf('\tChecking\tWHOLEFDS #123 GROCERIES\t-84.21\t') !== -1 &&
   iif.indexOf('\tUncategorized\tWHOLEFDS #123 GROCERIES\t84.21\t') !== -1);
ok('IIF debit=CHECK, credit=DEPOSIT', /^TRNS\tDEPOSIT\t07\/01\/2026\tChecking/m.test(iif) && /^TRNS\tCHECK\t07\/03/m.test(iif));
ok('IIF & kept literal in tab format (AT&T)', iif.indexOf('AT&T *BILL PAYMENT') !== -1);
var iifBack = Engine.iifToTransactions(iif);
ok('IIF parser reads 7 transactions (TRNS only)', iifBack.transactions.length === 7, iifBack.transactions.length);
ok('IIF round-trip amounts intact', iifBack.transactions[1].amount === -84.21 && iifBack.transactions[0].amount === 1500);
ok('IIF round-trip check number', iifBack.transactions[4].checknum === '1042', iifBack.transactions[4].checknum);

// --- cross-format via convert() dispatcher ---
ok('convert csv->qif works', /^!Type:Bank/.test(Engine.convert({ from: 'csv', to: 'qif', input: csv, parseOpts: { dateOrder: 'MDY' } }).output));
ok('convert csv->iif works', Engine.convert({ from: 'csv', to: 'iif', input: csv, parseOpts: { dateOrder: 'MDY' } }).output.indexOf('!TRNS\t') !== -1);
ok('convert qif->qbo works', Engine.convert({ from: 'qif', to: 'qbo', input: qif }).output.indexOf('<STMTTRN>') !== -1);

// --- OFX family: same container, distinguished only by the Intuit tags ---
var acct = { org: 'Chase', fid: '10898', intuBid: '10898', bankId: '021000021', acctId: '1234567' };
var ofxOut = Engine.transactionsToOfx(txns, acct);
var qboOut = Engine.transactionsToQbo(txns, acct);
var qfxOut = Engine.transactionsToQfx(txns, acct);

ok('OFX emits an OFX header', /^OFXHEADER:100/.test(ofxOut));
ok('OFX omits INTU.BID (non-Intuit importers reject it)', ofxOut.indexOf('INTU.BID') === -1);
ok('QBO keeps INTU.BID', qboOut.indexOf('<INTU.BID>10898') !== -1);
ok('QFX keeps INTU.BID', qfxOut.indexOf('<INTU.BID>10898') !== -1);
ok('QFX omits INTU.USERID unless asked', qfxOut.indexOf('INTU.USERID') === -1);
ok('QFX emits INTU.USERID when supplied',
  Engine.transactionsToQfx(txns, Object.assign({ intuUserId: 'u99' }, acct)).indexOf('<INTU.USERID>u99') !== -1);
// The only difference between the three should be those tags.
ok('OFX body matches QBO minus the Intuit line',
  ofxOut.split('\n').filter(function (l) { return l.indexOf('INTU.') === -1; }).join('\n') ===
  qboOut.split('\n').filter(function (l) { return l.indexOf('INTU.') === -1; }).join('\n'));

// Round-trip: every flavour must parse back to the same transactions.
['ofx', 'qbo', 'qfx'].forEach(function (f) {
  var emitted = f === 'ofx' ? ofxOut : (f === 'qbo' ? qboOut : qfxOut);
  var back = Engine.ofxToTransactions(emitted);
  ok(f.toUpperCase() + ' round-trips transaction count', back.transactions.length === txns.length, back.transactions.length);
  ok(f.toUpperCase() + ' round-trips amounts to the cent',
    back.transactions.every(function (t, i) { return t.amount === txns[i].amount; }));
  ok(f.toUpperCase() + ' round-trips dates', back.transactions.every(function (t, i) { return t.date === txns[i].date; }));
});

ok('convert csv->ofx works', /OFXHEADER/.test(Engine.convert({ from: 'csv', to: 'ofx', input: csv, parseOpts: { dateOrder: 'MDY' } }).output));
ok('convert csv->qfx works', /OFXHEADER/.test(Engine.convert({ from: 'csv', to: 'qfx', input: csv, parseOpts: { dateOrder: 'MDY' } }).output));
ok('convert qbo->ofx strips Intuit tags',
  Engine.convert({ from: 'qbo', to: 'ofx', input: qboOut }).output.indexOf('INTU.') === -1);
ok('emitters registry exposes ofx + qfx',
  typeof Engine.emitters.ofx === 'function' && typeof Engine.emitters.qfx === 'function');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
