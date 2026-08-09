/* Verifies every example and claim in README.md against the real fixtures, so the
   documentation cannot drift away from the code. Run: node test/test-readme.js */
const fs = require('fs');
const path = require('path');
const bank = require('../index.js');
const F = path.join(__dirname, 'fixtures') + path.sep;
let ok = 0, bad = 0;
const t = (n, c, x) => c ? (ok++, console.log('  PASS  ' + n)) : (bad++, console.log('  FAIL  ' + n + ' -> ' + x));

// Example 1 — convert() csv -> qbo
const csvText = fs.readFileSync(F + 'sample-bank.csv', 'utf8');
const { output, result } = bank.convert({
  from: 'csv', to: 'qbo', input: csvText,
  parseOpts: { dateOrder: 'MDY' },
  emitOpts: { org: 'Chase', fid: '10898', bankId: '021000021', acctId: '1234567' }
});
t('convert() returns transactions', result.transactions.length > 0, result.transactions.length);
t('convert() emits OFX header', /OFXHEADER/.test(output));
t('emitOpts org lands in output', output.includes('Chase'));
t('intuBid defaults to fid', output.includes('10898'));

// Example 2 — ofxToTransactions + filter + transactionsToCsv
const ofxText = fs.readFileSync(F + 'sample.ofx', 'utf8');
const { transactions, meta } = bank.ofxToTransactions(ofxText);
t('ofxToTransactions returns transactions', transactions.length > 0, transactions.length);
t('ofxToTransactions returns meta', !!meta && typeof meta === 'object');
const recent = transactions.filter(x => x.date >= '19000101' && x.amount < 0);
t('date string compare filters', recent.length > 0, recent.length);
const csvOut = bank.transactionsToCsv(recent, { dateFormat: 'YMD' });
t('transactionsToCsv emits a header row', /Date/i.test(csvOut.split('\n')[0]), csvOut.split('\n')[0]);

// Example 3 — documented transaction shape
const s = transactions[0];
t('date is YYYYMMDD string', typeof s.date === 'string' && /^\d{8}$/.test(s.date), s.date);
t('amount is a number', typeof s.amount === 'number', typeof s.amount);
t('has description', 'description' in s);
t('has fitid', 'fitid' in s && !!s.fitid, s.fitid);

// Example 4 — csvToTransactions with explicit map + errors array
const r = bank.csvToTransactions(csvText, { dateOrder: 'MDY' });
t('errors is an array', Array.isArray(r.errors));
t('guessMapping is exported', typeof bank.guessMapping === 'function');

// Example 5 — parseAmount / parseDate as documented
t('parseAmount (1,234.56) -> -1234.56', bank.parseAmount('(1,234.56)') === -1234.56, bank.parseAmount('(1,234.56)'));
t('parseAmount $1,234.56 -> 1234.56', bank.parseAmount('$1,234.56') === 1234.56, bank.parseAmount('$1,234.56'));
// The API table claims "1.234,56" support. It did not have it — a false claim
// shipped to npm because this suite checked the other two examples on that line
// and not this one. Every documented format is now covered.
t('parseAmount 1.234,56 -> 1234.56 (European)', bank.parseAmount('1.234,56') === 1234.56, bank.parseAmount('1.234,56'));
t('parseAmount 1 234,56 -> 1234.56 (French)', bank.parseAmount('1 234,56') === 1234.56, bank.parseAmount('1 234,56'));
t('parseAmount 1,00,000.00 -> 100000 (Indian)', bank.parseAmount('1,00,000.00') === 100000, bank.parseAmount('1,00,000.00'));
t('parseAmount 5,000,000 -> 5000000 (no minor unit)', bank.parseAmount('5,000,000') === 5000000, bank.parseAmount('5,000,000'));
t('parseDate DMY', bank.parseDate('01/02/2026', 'DMY') === '20260201', bank.parseDate('01/02/2026', 'DMY'));
t('parseDate MDY', bank.parseDate('01/02/2026', 'MDY') === '20260102', bank.parseDate('01/02/2026', 'MDY'));

// Every conversion cell in the README's support table
const inputs = { csv: csvText, ofx: ofxText,
  qbo: fs.readFileSync(F + 'sample.qbo','utf8'),
  qfx: fs.readFileSync(F + 'sample.qfx','utf8'),
  qif: fs.readFileSync(F + 'sample.qif','utf8'),
  iif: fs.readFileSync(F + 'sample.iif','utf8') };
let cells = 0;
for (const from of Object.keys(inputs)) {
  for (const to of ['qbo','qfx','ofx','csv','qif','iif']) {
    try {
      const o = bank.convert({ from, to, input: inputs[from], parseOpts:{dateOrder:'MDY'} });
      if (o.output && o.output.length > 10) cells++;
      else { bad++; console.log('  FAIL  table cell ' + from + '->' + to + ' (empty)'); }
    } catch (e) { bad++; console.log('  FAIL  table cell ' + from + '->' + to + ' -> ' + e.message); }
  }
}
t('all 36 documented conversions produce output', cells === 36, cells + '/36');

// The README's flavour table: only .ofx omits INTU.BID.
const acct = { org:'Chase', fid:'10898', intuBid:'10898', bankId:'021000021', acctId:'1234567' };
const tx = bank.csvToTransactions(csvText, { dateOrder:'MDY' }).transactions;
t('README: .ofx omits INTU.BID', bank.transactionsToOfx(tx, acct).indexOf('INTU.BID') === -1);
t('README: .qbo carries INTU.BID', bank.transactionsToQbo(tx, acct).indexOf('<INTU.BID>') !== -1);
t('README: .qfx carries INTU.BID', bank.transactionsToQfx(tx, acct).indexOf('<INTU.BID>') !== -1);
t('README: transactionsToOfx/Qfx are exported',
  typeof bank.transactionsToOfx === 'function' && typeof bank.transactionsToQfx === 'function');

// VERSION documented in package
t('VERSION exported', typeof bank.VERSION === 'string', bank.VERSION);
// It was 0.1.0 through three releases: the old assertion only checked the TYPE,
// so a stale constant passed forever. Published artefacts said the wrong version.
t('VERSION matches package.json',
  bank.VERSION === require('../package.json').version,
  bank.VERSION + ' vs ' + require('../package.json').version);
console.log('\n' + ok + ' passed, ' + bad + ' failed');
process.exit(bad ? 1 : 0);
