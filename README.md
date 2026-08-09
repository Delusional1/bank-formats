# bank-formats

Read and write the file formats banks and accounting software actually use — **OFX, QBO, QFX, QIF, IIF and CSV** — from one small library.

- **Zero dependencies.** One file, no transitive supply chain.
- **Node and browser.** The same UMD build runs in both; no bundler required.
- **Typed.** Ships `index.d.ts`.
- **Tested.** 100 tests covering parsing, emitting, round-trips, and every claim in this README.

```bash
npm install bank-formats
```

## Why this exists

Getting a bank export into accounting software is a solved problem that keeps being unsolved. The formats are old, sparsely documented, and unforgiving — QuickBooks will reject a `.qbo` file over a single wrong header field and tell you nothing useful about which one. Most existing JavaScript options are abandoned, parse-only, or wrap a paid SDK.

This library is the conversion core extracted from a production bank-statement converter, published because the format handling is the boring part and everyone rewriting it is a waste.

## Quick start

```js
const bank = require('bank-formats');

// One call, any supported pair
const { output, result } = bank.convert({
  from: 'csv',
  to: 'qbo',
  input: csvText,
  parseOpts: { dateOrder: 'DMY' },
  emitOpts: { org: 'Chase', fid: '10898', bankId: '021000021', acctId: '1234567' }
});

console.log(result.transactions.length, 'transactions');
fs.writeFileSync('statement.qbo', output);
```

Or work with the transactions directly:

```js
const { transactions, meta } = bank.ofxToTransactions(ofxText);

const recent = transactions.filter(t => t.date >= '20260101' && t.amount < 0);

fs.writeFileSync('debits.csv', bank.transactionsToCsv(recent, { dateFormat: 'YMD' }));
```

In a browser, without a build step:

```html
<script src="https://unpkg.com/bank-formats/src/engine.js"></script>
<script>
  const { transactions } = StatementEngine.qifToTransactions(text);
</script>
```

## The transaction shape

Everything normalises to one structure, so a converter is always parse → filter/edit → emit:

```js
{
  date: '20260131',        // always YYYYMMDD — no ambiguity, ever
  amount: -42.5,           // signed: debits negative, credits positive
  description: 'ACME LTD',
  memo: '',
  checknum: '',
  type: 'DEBIT',
  fitid: '20260131-1'      // generated when the source format has none
}
```

Two decisions worth knowing about, because they cause most of the bugs in this space:

**Dates are strings, not `Date` objects.** `YYYYMMDD` is what OFX/QBO/QFX use natively. Converting to `Date` and back introduces timezone shifts that silently move transactions across month boundaries — which then breaks reconciliation against a statement.

**Amounts are signed.** Formats disagree wildly: some use one signed column, some separate debit and credit columns, some make debits positive. `csvToTransactions` handles all three via `amountMode` and `invert`, and everything downstream sees one convention.

**Number formats disagree too, and getting it wrong is quiet.** `1.234,56` is European for 1234.56 — strip everything but digits and dots and you get 1.23456, a thousandfold error that still looks like a number. `parseAmount` decides by position: whichever of `.` or `,` appears **last** is the decimal separator, and a lone separator with a three-digit tail is grouping. So `1,234` is 1234, `1,23` is 1.23, and Indian `1,00,000.00` works without assuming groups come in threes.

## Supported conversions

Parse from **CSV, OFX, QBO, QFX, QIF, IIF**. Emit to **QBO, QFX, OFX, CSV, QIF, IIF**.

| | → QBO | → QFX | → OFX | → CSV | → QIF | → IIF |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **CSV →** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **OFX / QBO / QFX →** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **QIF →** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **IIF →** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

OFX, QBO and QFX share a container format, so one parser reads all three — and one emitter
writes all three. They differ only by Intuit's extension tags:

| Flavour | `<INTU.BID>` | Who reads it |
|---|:---:|---|
| `.ofx` | no | Xero, Sage, Wave, FreeAgent, MYOB, NetSuite |
| `.qbo` | yes | QuickBooks Web Connect (Desktop & Online) |
| `.qfx` | yes | Quicken Web Connect |

Emitting `<INTU.BID>` in a plain `.ofx` makes some non-Intuit importers baulk, so
`transactionsToOfx` deliberately leaves it out.

## CSV input

Bank CSV exports are all different. `csvToTransactions` guesses the delimiter and the column mapping from the headers, and you override whatever it gets wrong:

```js
const res = bank.csvToTransactions(text, {
  dateOrder: 'DMY',              // 01/02/2026 → 1 February, not 2 January
  amountMode: 'split',           // separate Debit and Credit columns
  map: { date: 0, description: 2, debit: 3, credit: 4 }
});

res.errors.forEach(e => console.warn(`row ${e.row}: ${e.reason}`));
```

`guessMapping(headers)` is exported separately if you want to show a user what was detected and let them correct it before parsing.

Rows that can't be parsed land in `errors` rather than throwing, so one malformed line doesn't cost you the file.

## Writing .qbo for QuickBooks

QuickBooks Web Connect is the fussiest target here, and its failures are opaque. The fields that matter:

```js
bank.transactionsToQbo(transactions, {
  org:      'Chase',        // institution name
  fid:      '10898',        // institution id
  intuBid:  '10898',        // Intuit's bank id — defaults to fid
  bankId:   '021000021',    // routing number
  acctId:   '1234567',      // account number
  acctType: 'CHECKING',     // CHECKING | SAVINGS | CREDITLINE | MONEYMRKT
  curdef:   'USD'
});
```

If QuickBooks rejects an otherwise valid file, **`intuBid` is almost always the culprit** — it must match Intuit's id for that institution, which is not always the same as `fid`. Getting a plausible-looking `.qbo` that QuickBooks silently refuses is the single most common failure in this whole area, and it is nearly always this field.

## Format quirks that will bite you

These are not exotic edge cases — each one is a real failure that produces a file
which *looks* correct. They are documented here because they are documented almost
nowhere else, and every one of them is handled by this library.

**A `.txt` export has no declared separator.** Tab, semicolon, pipe or comma, and
you cannot tell by looking because a tab and a run of spaces are identical on
screen. `sniffDelimiter()` scores *consistency* rather than frequency — the right
separator splits every line into the same number of fields. Counting characters
picks the comma out of `SMITH, JOHN` every time and is wrong every time.

**Continental European exports need three things, not one.** The separator is a
semicolon (because the comma is the decimal point), the decimal point is a comma,
*and* the header row is in the local language. Clear two of the three and the file
still parses as empty. `guessMapping()` knows German, French, Spanish, Italian,
Dutch and Portuguese column names alongside the English ones.

**An ISO date is unambiguous, so a declared order must not veto it.** `2024-02-01`
cannot be anything but the 1st of February — a four-digit leading year is not a
month or a day. Rejecting it because the caller said `MDY` turns a perfectly
readable file into "no transactions found". Genuinely ambiguous dates like
`02/01/2024` still obey the order you pass.

**IIF is double-entry, so summing it gives you zero.** Every `TRNS` line has one or
more matching `SPL` lines carrying the *opposite* sign. Add up the amount column of
a raw `.iif` and the two sides cancel — a total of `0.00` means the file is
balanced, not empty. `iifToTransactions()` returns one row per transaction.

**Excel's calendar contains 29 February 1900, a day that never existed.** It was a
Lotus 1-2-3 bug that Excel kept for compatibility. The usual serial-to-date
shortcut (epoch 1899-12-30) is therefore a day early for every date before March
1900. Rarely reached in practice, and wrong when it is.

**QuickBooks rejects a `.qbo` on `INTU.BID` before it reads a single transaction.**
See the section above — and note the id is not printed anywhere on a bank
statement, so it cannot be derived from one. Ask the user.

## API

| Function | Purpose |
|---|---|
| `convert({from, to, input, parseOpts, emitOpts})` | One-call conversion; throws on an unknown format |
| `csvToTransactions(text, opts)` | CSV → transactions, with mapping detection |
| `ofxToTransactions(text)` | OFX/QBO/QFX → transactions plus account `meta` |
| `qifToTransactions(text)` / `iifToTransactions(text)` | Quicken / QuickBooks Desktop → transactions |
| `transactionsToQbo(txns, acct)` | → QuickBooks Web Connect |
| `transactionsToQfx(txns, acct)` | → Quicken Web Connect; imports as a feed, not a manual file |
| `transactionsToOfx(txns, acct)` | → plain OFX for Xero/Sage/Wave/FreeAgent/MYOB |
| `transactionsToCsv(txns, opts)` | → CSV, with column and date-format control |
| `transactionsToQif(txns)` / `transactionsToIif(txns)` | → Quicken / QuickBooks Desktop |
| `parseAmount(raw)` | `1,234.56`, `1.234,56`, `1 234,56`, `1,00,000.00`, `(37.50)`, `$1,234.56` → number |
| `parseDate(raw, order)` | Any common form → `YYYYMMDD` |
| `guessMapping(headers)` | Header row → column indices, English + six European languages |
| `sniffDelimiter(text)` | Detect `,` `	` `;` or `\|` by column-count consistency |
| `parsers.txt` | Delimited text with the separator sniffed rather than assumed |
| `parsers` / `emitters` | The dispatch tables, for building your own UI |

## What this does not do

**PDF.** Reading a bank statement PDF is a genuinely hard problem — layout varies per bank, and an extraction that looks right can be quietly wrong. That is not a file-format problem and it does not belong in a file-format library.

If you need it, [GetStatementConvert](https://getstatementconvert.com) does exactly that, and verifies the result by checking that the extracted transactions sum to the statement's own opening and closing balances before returning a file. This library is its output layer, which is why it is well tested. The [free browser-based converters](https://getstatementconvert.com/#converters) there run on this same code.

**OCR, categorisation, and bank APIs** are also out of scope.

## Contributing

Bug reports with a **fixture file that reproduces the problem** are the most useful thing you can send — redact the amounts and account numbers, keep the structure. Bank format quirks are impossible to fix in the abstract.

```bash
npm test
```

## License

MIT
