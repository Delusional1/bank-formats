/*!
 * StatementEngine — client-side financial file converter core.
 *
 * Normalizes every supported input format to one transaction model, then
 * emits any supported output format. Runs in the browser (no upload, no
 * server) and in Node (for tests).
 *
 * Normalized transaction:
 *   { date: 'YYYYMMDD', amount: Number (signed; debit<0, credit>0),
 *     description: String, memo: String, checknum: String,
 *     type: 'DEBIT'|'CREDIT'|..., fitid: String }
 *
 * Stage 1 ships CSV -> QBO fully. Other parsers/emitters are registered as
 * stubs so adding a pair (ofx, qif, iif, xlsx) is a drop-in.
 */
(function (global) {
  'use strict';

  var VERSION = '0.1.0';

  // ---------------------------------------------------------------- utils ---

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  // On a bank account the amount is money moving in or out, so a negative is a
  // debit. On a CARD the balance is money owed and the internal sign is inverted
  // (a purchase raises the balance, so it is positive) — meaning the same rule
  // would label every purchase CREDIT. It has to flip with the account type.
  function typeFor(amount, isCard) {
    var neg = Number(amount) < 0;
    return isCard ? (neg ? 'CREDIT' : 'DEBIT') : (neg ? 'DEBIT' : 'CREDIT');
  }
  // Which of the two split columns a transaction belongs in. Keyed off `type`
  // rather than the sign, because on a card the sign is inverted (a purchase is
  // positive so the transactions reconcile against a debt balance) and reading
  // the sign directly puts every purchase in the Credit column. `type` is set
  // card-aware upstream, so it is the semantic truth; the sign is the fallback
  // for transactions that carry no type.
  function isDebitSide(t) {
    var ty = String((t && t.type) || '').toUpperCase();
    if (ty === 'DEBIT') return true;
    if (ty === 'CREDIT') return false;
    return Number(t && t.amount) < 0;
  }

  function looksLikeCard(t) {
    t = String(t || '').toUpperCase();
    return t === 'CREDITLINE' || t === 'CREDITCARD' || t === 'CARD';
  }

  // Escape the few chars that trip up QuickBooks' OFX/SGML import.
  function ofxEscape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Parse a money string into a signed Number.
  //   "$1,234.56" -> 1234.56 ; "(45.00)" -> -45.00 ; "-12.3" -> -12.3
  /*
   * Amount parsing across number conventions, which is where silent corruption
   * lives. "1.234,56" is European for 1234.56; stripping everything but digits
   * and dots turns it into 1.23456 — a thousand times wrong, and wrong quietly.
   *
   * The rule: whichever of . or , appears LAST is the decimal separator, and
   * everything else is grouping. When only one kind appears it is ambiguous —
   * "1,234" is 1234 and "1,23" is 1.23 — so the group length decides: three
   * digits means grouping, one or two means a decimal. Spaces and NBSP are
   * always grouping (French), and Indian "1,00,000.00" falls out for free
   * because grouping is simply discarded rather than assumed to be in threes.
   */
  function parseAmount(raw) {
    if (raw == null) return NaN;
    var s = String(raw).trim();
    if (s === '') return NaN;
    var neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); } // (123) accounting negative
    if (/-/.test(s)) neg = true;                                  // leading or trailing minus
    // Keep only digits and the two separator characters; spaces/NBSP are grouping.
    s = s.replace(/[^0-9.,]/g, '');
    if (s === '' || s === '.' || s === ',') return NaN;

    var lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
    var dec = -1;
    if (lastDot >= 0 && lastComma >= 0) {
      dec = Math.max(lastDot, lastComma);            // both present: the later one wins
    } else if (lastDot >= 0 || lastComma >= 0) {
      var only = lastDot >= 0 ? lastDot : lastComma;
      var ch = s.charAt(only);
      var groupLen = s.length - only - 1;
      var occurrences = s.split(ch).length - 1;
      // Several of the same separator can only be grouping (1,234,567).
      dec = (occurrences === 1 && groupLen !== 3) ? only : -1;
    }

    var intPart, fracPart = '';
    if (dec >= 0) { intPart = s.slice(0, dec); fracPart = s.slice(dec + 1); }
    else { intPart = s; }
    intPart = intPart.replace(/[.,]/g, '');
    fracPart = fracPart.replace(/[.,]/g, '');
    if (intPart === '' && fracPart === '') return NaN;

    var n = parseFloat((intPart || '0') + (fracPart ? '.' + fracPart : ''));
    if (isNaN(n)) return NaN;
    return neg ? -Math.abs(n) : n;
  }

  // Parse a date cell to 'YYYYMMDD' using an explicit order hint.
  //   order: 'MDY' | 'DMY' | 'YMD'   (delimiter auto-detected: / - . )
  function parseDate(raw, order) {
    if (raw == null) return null;
    var s = String(raw).trim();
    if (s === '') return null;
    // Already ISO-ish YYYYMMDD or YYYY-MM-DD.
    //
    // Accepted whatever `order` says, not only under YMD. A four-digit leading
    // year is unambiguous — it cannot be a month or a day — so there is nothing
    // for the caller's preference to disambiguate. Requiring YMD here meant an
    // ISO-dated CSV returned null on every row under the default MDY, and since
    // callers that read a file they did not write have no way to know the order
    // in advance, the whole file came back as "no transactions found" on dates
    // that were never ambiguous in the first place.
    var iso = s.match(/^(\d{4})[-\/.]?(\d{1,2})[-\/.]?(\d{1,2})/);
    if (iso && +iso[2] >= 1 && +iso[2] <= 12 && +iso[3] >= 1 && +iso[3] <= 31) {
      return iso[1] + pad2(+iso[2]) + pad2(+iso[3]);
    }

    var parts = s.split(/[-\/.]/).map(function (p) { return p.trim(); });
    if (parts.length < 3) {
      // fall back to Date parsing (e.g. "Jul 1, 2026")
      var d = new Date(s);
      if (!isNaN(d.getTime())) {
        return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
      }
      return null;
    }
    var y, m, day;
    if (order === 'YMD') { y = +parts[0]; m = +parts[1]; day = +parts[2]; }
    else if (order === 'DMY') { day = +parts[0]; m = +parts[1]; y = +parts[2]; }
    else { m = +parts[0]; day = +parts[1]; y = +parts[2]; } // MDY default
    if (y < 100) y += (y < 70 ? 2000 : 1900); // 2-digit year
    if (!y || !m || !day || m > 12 || day > 31) return null;
    return y + pad2(m) + pad2(day);
  }

  // Small, stable string hash (FNV-1a) -> unsigned hex. Used for FITIDs so the
  // same statement produces the same ids on re-import (QuickBooks dedupes on FITID).
  function hash(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  function makeFitId(t, i) {
    var cents = Math.round((t.amount || 0) * 100);
    return t.date + cents + hash((t.description || '') + '|' + i);
  }

  // ------------------------------------------------------------ CSV parser ---

  // RFC-4180-ish CSV -> { headers:[], rows:[[]] }. Handles quotes, escaped
  // quotes (""), and commas/newlines inside quotes. Strips a UTF-8 BOM.
  function parseCsv(text, delimiter) {
    var delim = delimiter || ',';
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var rows = [], field = '', row = [], inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === delim) {
        row.push(field); field = '';
      } else if (c === '\n') {
        row.push(field); rows.push(row); field = ''; row = [];
      } else if (c === '\r') {
        // swallow; handle \r\n and lone \r
        if (text[i + 1] === '\n') { /* wait for \n */ }
        else { row.push(field); rows.push(row); field = ''; row = []; }
      } else {
        field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    // drop trailing empty row
    rows = rows.filter(function (r) { return !(r.length === 1 && r[0] === ''); });
    var headers = rows.length ? rows[0].map(function (h) { return h.trim(); }) : [];
    return { headers: headers, rows: rows.slice(1) };
  }

  // Guess column indexes from header names.
  function guessMapping(headers) {
    var lc = headers.map(function (h) { return h.toLowerCase(); });
    function find(res) {
      for (var i = 0; i < lc.length; i++)
        for (var j = 0; j < res.length; j++)
          if (res[j].test(lc[i])) return i;
      return -1;
    }
    // Non-English headers matter more than they look. A continental European
    // export already needs the semicolon separator detected and a comma decimal
    // point parsed — both of which work — and then fails anyway at the header
    // row, mapping nothing and reporting an empty file. These are the column
    // names on real German, French, Spanish, Italian, Dutch and Portuguese
    // exports; the English patterns are unchanged and still matched first.
    return {
      date: find([/date/, /posted/, /trans.*date/,
        /datum/, /fecha/, /data/, /buchung/, /valuta/]),
      description: find([/description/, /details/, /narrative/, /payee/, /memo/, /name/,
        /beschreibung/, /verwendungszweck/, /buchungstext/, /empf/,
        /descrip/, /libell/, /descrizione/, /omschrijving/, /concepto/, /causale/]),
      amount: find([/^amount$/, /amount/, /value/,
        /betrag/, /importe/, /montant/, /importo/, /bedrag/, /umsatz/, /valor/]),
      debit: find([/debit/, /withdrawal/, /paid out/, /^out$/,
        /soll/, /d[ée]bito?/, /uscite/, /af$/]),
      credit: find([/credit/, /deposit/, /paid in/, /^in$/,
        /haben/, /cr[ée]dito?/, /entrate/, /bij$/]),
      checknum: find([/check/, /cheque/, /ref/, /beleg/, /scheck/])
    };
  }

  // Map parsed CSV -> normalized transactions.
  // opts: { map:{date,description,amount,debit,credit,checknum}, dateOrder,
  //         amountMode:'single'|'split', invert:Boolean }
  /*
   * Work out what actually separates the columns.
   *
   * "CSV" is a polite fiction. A .txt export from a bank or a legacy ledger is
   * usually tab-separated; continental European exports are semicolon-separated
   * because the comma is their decimal point; some systems still emit pipes.
   * All of them parse as a SINGLE column under a hardcoded comma, which fails
   * silently — you get one column of untouched text and a mapping that finds no
   * date, rather than an error anyone can act on.
   *
   * The test is consistency, not frequency: the right delimiter is the one that
   * splits the sample lines into the same number of fields every time, and into
   * more than one. Frequency alone picks the comma out of "Smith, John" every
   * time.
   *
   * Comma wins ties, so a genuine CSV keeps parsing exactly as it did before
   * this function existed.
   */
  var DELIMS = [',', '\t', ';', '|'];
  function sniffDelimiter(text, fallback) {
    var s = String(text || '');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    var lines = s.split(/\r\n|\n|\r/).filter(function (l) { return l.trim() !== ''; }).slice(0, 20);
    if (!lines.length) return fallback || ',';

    var best = null;
    DELIMS.forEach(function (d) {
      // Count fields per line for this candidate, ignoring delimiters inside quotes.
      var counts = lines.map(function (line) {
        var n = 1, q = false;
        for (var i = 0; i < line.length; i++) {
          var c = line[i];
          if (c === '"') q = !q;
          else if (c === d && !q) n++;
        }
        return n;
      });
      var first = counts[0];
      if (first < 2) return;                       // one column is not a delimiter
      var consistent = counts.filter(function (n) { return n === first; }).length;
      var score = consistent / counts.length;
      if (score < 0.7) return;                     // ragged: probably not the separator
      // Prefer the more consistent candidate; on a tie prefer more columns; the
      // comma is checked first so it wins an exact tie by arriving first.
      if (!best || score > best.score + 1e-9 ||
          (Math.abs(score - best.score) < 1e-9 && first > best.cols)) {
        best = { delim: d, score: score, cols: first };
      }
    });
    return best ? best.delim : (fallback || ',');
  }

  function csvToTransactions(text, opts) {
    opts = opts || {};
    // No delimiter given means "work it out" rather than "assume comma".
    var parsed = parseCsv(text, opts.delimiter || sniffDelimiter(text));
    var map = opts.map || guessMapping(parsed.headers);
    var order = opts.dateOrder || 'MDY';
    var mode = opts.amountMode || (map.debit >= 0 || map.credit >= 0 ? 'split' : 'single');
    var invert = !!opts.invert;
    var txns = [], errors = [];

    parsed.rows.forEach(function (cols, idx) {
      var get = function (i) { return i >= 0 && i < cols.length ? cols[i] : ''; };
      var date = parseDate(get(map.date), order);
      var amount;
      if (mode === 'split') {
        var deb = parseAmount(get(map.debit));
        var cred = parseAmount(get(map.credit));
        deb = isNaN(deb) ? 0 : Math.abs(deb);
        cred = isNaN(cred) ? 0 : Math.abs(cred);
        amount = cred - deb;
      } else {
        amount = parseAmount(get(map.amount));
      }
      if (invert) amount = -amount;
      var desc = (get(map.description) || '').trim();
      if (!date || isNaN(amount)) {
        errors.push({ row: idx + 2, reason: !date ? 'unparseable date' : 'unparseable amount', raw: cols });
        return;
      }
      var t = {
        date: date,
        amount: amount,
        description: desc || 'Transaction',
        memo: '',
        checknum: (get(map.checknum) || '').trim(),
        type: amount < 0 ? 'DEBIT' : 'CREDIT'
      };
      t.fitid = makeFitId(t, idx);
      txns.push(t);
    });
    return { transactions: txns, errors: errors, headers: parsed.headers, mapping: map };
  }

  // ------------------------------------------------------------ QBO emitter ---

  // transactions -> QBO (OFX 1.0.2 SGML, Web Connect) string that QuickBooks imports.
  // acct: { bankId, acctId, acctType:'CHECKING'|'SAVINGS'|'CREDITLINE',
  //         org, fid, intuBid, curdef:'USD', balance? }
  // The OFX family shares one body. The flavours differ only by Intuit's
  // extension tags, so they share one emitter:
  //   'ofx' — plain OFX 1.0.2. What Xero, Sage, Wave, FreeAgent, MYOB accept.
  //   'qbo' — OFX + <INTU.BID>. QuickBooks Web Connect; QB rejects it without one.
  //   'qfx' — OFX + <INTU.BID> (+ optional <INTU.USERID>). Quicken Web Connect,
  //           which imports like a native bank feed rather than a manual file.
  function emitOfxFamily(txns, acct, flavor) {
    acct = acct || {};
    var org = acct.org || 'Bank';
    var fid = acct.fid || '0000';
    var bid = acct.intuBid || fid;
    var bankId = acct.bankId || '000000000';
    var acctId = acct.acctId || '000000000';
    var acctType = (acct.acctType || 'CHECKING').toUpperCase();
    var cur = acct.curdef || 'USD';
    var now = new Date();
    var stamp = now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate()) +
                pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds());

    var dates = txns.map(function (t) { return t.date; }).sort();
    var dtstart = (dates[0] || stamp.slice(0, 8)) + '120000';
    var dtend = (dates[dates.length - 1] || stamp.slice(0, 8)) + '120000';

    var L = [];
    // ---- OFX header (SGML, not XML) ----
    L.push('OFXHEADER:100');
    L.push('DATA:OFXSGML');
    L.push('VERSION:102');
    L.push('SECURITY:NONE');
    L.push('ENCODING:USASCII');
    L.push('CHARSET:1252');
    L.push('COMPRESSION:NONE');
    L.push('OLDFILEUID:NONE');
    L.push('NEWFILEUID:NONE');
    L.push('');
    // ---- body ----
    L.push('<OFX>');
    L.push('<SIGNONMSGSRSV1><SONRS>');
    L.push('<STATUS><CODE>0<SEVERITY>INFO</STATUS>');
    L.push('<DTSERVER>' + stamp);
    L.push('<LANGUAGE>ENG');
    L.push('<FI><ORG>' + ofxEscape(org) + '<FID>' + ofxEscape(fid) + '</FI>');
    // Intuit-only. Emitting it in a plain .ofx makes some non-Intuit importers baulk.
    if (flavor !== 'ofx') L.push('<INTU.BID>' + ofxEscape(bid));
    if (flavor === 'qfx' && acct.intuUserId) L.push('<INTU.USERID>' + ofxEscape(acct.intuUserId));
    L.push('</SONRS></SIGNONMSGSRSV1>');

    var isCard = acctType === 'CREDITLINE' || acctType === 'CREDITCARD';
    var MSG = isCard ? 'CREDITCARDMSGSRSV1' : 'BANKMSGSRSV1';
    var TRNRS = isCard ? 'CCSTMTTRNRS' : 'STMTTRNRS';
    var STMTRS = isCard ? 'CCSTMTRS' : 'STMTRS';
    var ACCTFROM = isCard ? 'CCACCTFROM' : 'BANKACCTFROM';

    L.push('<' + MSG + '><' + TRNRS + '>');
    L.push('<TRNUID>1');
    L.push('<STATUS><CODE>0<SEVERITY>INFO</STATUS>');
    L.push('<' + STMTRS + '>');
    L.push('<CURDEF>' + cur);
    L.push('<' + ACCTFROM + '>');
    if (!isCard) L.push('<BANKID>' + ofxEscape(bankId));
    L.push('<ACCTID>' + ofxEscape(acctId));
    if (!isCard) L.push('<ACCTTYPE>' + acctType);
    L.push('</' + ACCTFROM + '>');
    L.push('<BANKTRANLIST>');
    L.push('<DTSTART>' + dtstart);
    L.push('<DTEND>' + dtend);

    txns.forEach(function (t) {
      // OFX card files state a purchase as a NEGATIVE TRNAMT — the opposite of the
      // internal sign, which is chosen so the transactions reconcile against a
      // balance that represents debt. Without this flip, QuickBooks imports every
      // purchase on a card statement as money received.
      var amt = isCard ? -Number(t.amount) : Number(t.amount);
      L.push('<STMTTRN>');
      L.push('<TRNTYPE>' + (t.type || typeFor(t.amount, isCard)));
      L.push('<DTPOSTED>' + t.date + '120000');
      L.push('<TRNAMT>' + amt.toFixed(2));
      L.push('<FITID>' + ofxEscape(t.fitid));
      if (t.checknum) L.push('<CHECKNUM>' + ofxEscape(t.checknum));
      L.push('<NAME>' + ofxEscape((t.description || '').slice(0, 32)));
      if (t.memo) L.push('<MEMO>' + ofxEscape(t.memo.slice(0, 255)));
      L.push('</STMTTRN>');
    });

    L.push('</BANKTRANLIST>');
    if (acct.balance != null && acct.balance !== '') {
      L.push('<LEDGERBAL><BALAMT>' + Number(acct.balance).toFixed(2) +
             '<DTASOF>' + dtend + '</LEDGERBAL>');
    }
    L.push('</' + STMTRS + '>');
    L.push('</' + TRNRS + '></' + MSG + '>');
    L.push('</OFX>');
    return L.join('\n');
  }

  // QuickBooks Web Connect. `intuBid` must match Intuit's id for the institution —
  // it is the usual reason an otherwise valid file is silently rejected.
  function transactionsToQbo(txns, acct) { return emitOfxFamily(txns, acct, 'qbo'); }

  // Plain OFX — the format the cloud ledgers (Xero, Sage, Wave, FreeAgent, MYOB,
  // NetSuite) import. Deliberately carries no Intuit tags.
  function transactionsToOfx(txns, acct) { return emitOfxFamily(txns, acct, 'ofx'); }

  // Quicken Web Connect. Same container as QBO; Quicken reads it as a bank feed
  // instead of a manual import, which QIF cannot do.
  function transactionsToQfx(txns, acct) { return emitOfxFamily(txns, acct, 'qfx'); }

  // ------------------------------------------------------------ OFX parser ---

  // Undo the OFX/SGML entity escaping we (and banks) apply to NAME/MEMO.
  function ofxUnescape(s) {
    return String(s == null ? '' : s)
      .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); })
      .trim();
  }

  // Pull a leaf value for <TAG>. Works for both OFX 1.x SGML (unclosed leaves —
  // value runs to the next '<' or line end) and OFX 2.x XML (<TAG>value</TAG>),
  // because we capture up to the next '<', newline, or end.
  function ofxLeaf(block, tag) {
    var m = block.match(new RegExp('<' + tag + '>\\s*([^<\\r\\n]*)', 'i'));
    return m ? ofxUnescape(m[1]) : '';
  }

  // OFX date (YYYYMMDD[HHMMSS[.XXX]][TZ]) -> 'YYYYMMDD'.
  function ofxDate(raw) {
    var m = String(raw).match(/(\d{4})(\d{2})(\d{2})/);
    return m ? m[1] + m[2] + m[3] : null;
  }

  // Parse OFX / QBO / QFX (all the OFX family) -> normalized transactions.
  // Preserves the original FITID (QuickBooks dedupes on it) and returns the
  // source account metadata so an ofx->qbo re-emit keeps the account identity.
  function ofxToTransactions(text, opts) {
    opts = opts || {};
    var meta = {
      curdef: ofxLeaf(text, 'CURDEF') || 'USD',
      bankId: ofxLeaf(text, 'BANKID'),
      acctId: ofxLeaf(text, 'ACCTID'),
      acctType: ofxLeaf(text, 'ACCTTYPE') || 'CHECKING',
      org: ofxLeaf(text, 'ORG'),
      fid: ofxLeaf(text, 'FID'),
      intuBid: ofxLeaf(text, 'INTU.BID')
    };

    // Grab each <STMTTRN>..</STMTTRN> aggregate (closed in SGML and XML).
    var blocks = [], m, re = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
    while ((m = re.exec(text))) blocks.push(m[1]);
    // Fallback for files that omit the closing aggregate tag.
    if (!blocks.length && /<STMTTRN>/i.test(text)) {
      blocks = text.split(/<STMTTRN>/i).slice(1).map(function (chunk) {
        return chunk.split(/<\/BANKTRANLIST>|<STMTTRN>/i)[0];
      });
    }

    var txns = [], errors = [];
    blocks.forEach(function (b, idx) {
      var date = ofxDate(ofxLeaf(b, 'DTPOSTED') || ofxLeaf(b, 'DTUSER'));
      var amount = parseFloat(ofxLeaf(b, 'TRNAMT'));
      if (!date || isNaN(amount)) {
        errors.push({ index: idx, reason: !date ? 'missing DTPOSTED' : 'missing TRNAMT' });
        return;
      }
      var name = ofxLeaf(b, 'NAME') || ofxLeaf(b, 'PAYEE');
      var t = {
        date: date,
        amount: amount,
        description: name || 'Transaction',
        memo: ofxLeaf(b, 'MEMO'),
        checknum: ofxLeaf(b, 'CHECKNUM'),
        type: (ofxLeaf(b, 'TRNTYPE') || (amount < 0 ? 'DEBIT' : 'CREDIT')).toUpperCase()
      };
      t.fitid = ofxLeaf(b, 'FITID') || makeFitId(t, idx);
      txns.push(t);
    });
    return { transactions: txns, errors: errors, meta: meta };
  }

  // ------------------------------------------------------------ CSV emitter ---

  var CSV_LABELS = { date: 'Date', description: 'Description', amount: 'Amount', currency: 'Currency',
    type: 'Type', checknum: 'Check #', memo: 'Memo', fitid: 'FITID' };

  function csvCell(v, delim) {
    v = v == null ? '' : String(v);
    return /[\r\n"]/.test(v) || v.indexOf(delim) !== -1 ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function fmtDateOut(ymd, fmt) {
    if (!ymd || ymd.length < 8) return ymd || '';
    var y = ymd.slice(0, 4), mo = ymd.slice(4, 6), d = ymd.slice(6, 8);
    if (fmt === 'MDY') return mo + '/' + d + '/' + y;
    if (fmt === 'DMY') return d + '/' + mo + '/' + y;
    if (fmt === 'RAW') return ymd;
    return y + '-' + mo + '-' + d; // YMD / ISO default
  }

  // transactions -> CSV string.
  // opts: { columns:[...], dateFormat:'YMD'|'MDY'|'DMY'|'RAW', amountMode:'single'|'split',
  //         delimiter:',' }  — default columns round-trip back through the CSV parser.
  function transactionsToCsv(txns, opts) {
    opts = opts || {};
    var delim = opts.delimiter || ',';
    var cols = opts.columns || ['date', 'description', 'amount', 'type', 'checknum', 'memo'];
    var fmt = opts.dateFormat || 'YMD';
    var split = opts.amountMode === 'split';

    var headers = [];
    cols.forEach(function (c) {
      if (c === 'amount' && split) headers.push('Debit', 'Credit');
      else headers.push(CSV_LABELS[c] || c);
    });
    var lines = [headers.map(function (h) { return csvCell(h, delim); }).join(delim)];

    (txns || []).forEach(function (t) {
      var row = [];
      cols.forEach(function (c) {
        if (c === 'date') row.push(fmtDateOut(t.date, fmt));
        else if (c === 'amount') {
          if (split) {
            var deb = isDebitSide(t);
            var mag = Math.abs(Number(t.amount)).toFixed(2);
            row.push(deb ? mag : '');
            row.push(deb ? '' : mag);
          } else row.push(Number(t.amount).toFixed(2));
        } else row.push(t[c] != null ? t[c] : '');
      });
      lines.push(row.map(function (v) { return csvCell(v, delim); }).join(delim));
    });
    return lines.join('\r\n');
  }

  // ------------------------------------------------------------ QIF (Quicken) ---

  function oneLine(s) { return String(s == null ? '' : s).replace(/[\t\r\n]+/g, ' ').trim(); }

  // Parse QIF -> transactions. Each record's fields end at a '^' line; single-letter
  // codes: D date, T/U amount, P payee, M memo, N number. Header '!Type:...' ignored.
  function qifToTransactions(text, opts) {
    opts = opts || {};
    var order = opts.dateOrder || 'MDY';
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var lines = text.split(/\r\n|\r|\n/), txns = [], errors = [], cur = null, idx = 0;
    function flush() {
      if (!cur) return;
      var t = cur; cur = null;
      if (!t.date || isNaN(t.amount)) { errors.push({ index: idx, reason: !t.date ? 'missing date' : 'missing amount' }); return; }
      t.description = t.description || 'Transaction';
      t.type = t.amount < 0 ? 'DEBIT' : 'CREDIT';
      t.fitid = makeFitId(t, idx++);
      txns.push(t);
    }
    lines.forEach(function (line) {
      if (!line.length) return;
      var code = line.charAt(0);
      if (code === '!') return;
      if (code === '^') { flush(); return; }
      if (!cur) cur = { date: null, amount: NaN, description: '', memo: '', checknum: '', type: '' };
      var val = line.slice(1).trim();
      if (code === 'D') cur.date = parseDate(val.replace(/'/g, '/').replace(/\s+/g, ''), order);
      else if (code === 'T' || code === 'U') { if (isNaN(cur.amount)) cur.amount = parseAmount(val); }
      else if (code === 'P') cur.description = val;
      else if (code === 'M') cur.memo = val;
      else if (code === 'N') cur.checknum = val;
    });
    flush();
    return { transactions: txns, errors: errors, meta: {} };
  }

  // transactions -> QIF. opts: { acctType:'Bank'|'CCard'|'Cash'|... }
  function transactionsToQif(txns, opts) {
    opts = opts || {};
    var out = ['!Type:' + (opts.acctType || 'Bank')];
    (txns || []).forEach(function (t) {
      out.push('D' + fmtDateOut(t.date, 'MDY'));
      out.push('T' + Number(t.amount).toFixed(2));
      if (t.checknum) out.push('N' + oneLine(t.checknum));
      out.push('P' + oneLine(t.description || ''));
      if (t.memo) out.push('M' + oneLine(t.memo));
      out.push('^');
    });
    return out.join('\n');
  }

  // ------------------------------------------------------------ IIF (QuickBooks) ---

  // Parse IIF (tab-delimited TRNS/SPL/ENDTRNS). Reads the account-side TRNS rows using
  // the !TRNS header row to locate columns; SPL (category) rows are ignored.
  function iifToTransactions(text, opts) {
    opts = opts || {};
    var order = opts.dateOrder || 'MDY';
    var lines = text.split(/\r\n|\r|\n/), col = null, txns = [], errors = [], idx = 0;
    lines.forEach(function (line) {
      if (!line.length) return;
      var cells = line.split('\t'), tag = cells[0];
      if (tag === '!TRNS') { col = {}; for (var i = 1; i < cells.length; i++) col[cells[i].trim().toUpperCase()] = i; return; }
      if (tag !== 'TRNS' || !col) return;
      var get = function (name) { var i = col[name]; return i != null && i < cells.length ? cells[i] : ''; };
      var date = parseDate((get('DATE') || '').trim(), order), amount = parseAmount(get('AMOUNT'));
      if (!date || isNaN(amount)) { errors.push({ index: idx, reason: !date ? 'missing DATE' : 'missing AMOUNT' }); return; }
      var t = {
        date: date, amount: amount,
        description: (get('NAME') || '').trim() || 'Transaction',
        memo: (get('MEMO') || '').trim(), checknum: (get('DOCNUM') || '').trim(),
        type: amount < 0 ? 'DEBIT' : 'CREDIT'
      };
      t.fitid = makeFitId(t, idx++);
      txns.push(t);
    });
    return { transactions: txns, errors: errors, meta: {} };
  }

  // transactions -> IIF. Double-entry: TRNS (bank account) + SPL (offset category, negated).
  // opts: { acctName (bank account), category (offset account) }
  function transactionsToIif(txns, opts) {
    opts = opts || {};
    var acct = opts.acctName || 'Bank', cat = opts.category || 'Uncategorized', L = [];
    L.push('!TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO');
    L.push('!SPL\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO');
    L.push('!ENDTRNS');
    (txns || []).forEach(function (t) {
      var ty = t.amount < 0 ? 'CHECK' : 'DEPOSIT', d = fmtDateOut(t.date, 'MDY');
      var name = oneLine(t.description || ''), memo = oneLine(t.memo || ''), num = oneLine(t.checknum || '');
      var amt = Number(t.amount).toFixed(2), namt = (-Number(t.amount)).toFixed(2);
      L.push(['TRNS', ty, d, acct, name, amt, num, memo].join('\t'));
      L.push(['SPL', ty, d, cat, name, namt, num, memo].join('\t'));
      L.push('ENDTRNS');
    });
    return L.join('\n');
  }

  // ---------------------------------------------------------------- registry ---

  // `txt` is not a format, it is an absence of one — a delimited text export
  // whose separator nobody wrote down. Same parser, with the delimiter sniffed
  // instead of assumed.
  var PARSERS = { csv: csvToTransactions, txt: csvToTransactions,
    ofx: ofxToTransactions, qbo: ofxToTransactions,
    qfx: ofxToTransactions, qif: qifToTransactions, iif: iifToTransactions };
  var EMITTERS = { qbo: transactionsToQbo, csv: transactionsToCsv,
    qif: transactionsToQif, iif: transactionsToIif,
    ofx: transactionsToOfx, qfx: transactionsToQfx };

  // High-level dispatch used by pages: convert({from,to,input,parseOpts,emitOpts})
  function convert(cfg) {
    var parse = PARSERS[cfg.from];
    var emit = EMITTERS[cfg.to];
    if (!parse) throw new Error('No parser for "' + cfg.from + '"');
    if (!emit) throw new Error('No emitter for "' + cfg.to + '"');
    var res = parse(cfg.input, cfg.parseOpts);
    return { output: emit(res.transactions, cfg.emitOpts), result: res };
  }

  var Engine = {
    VERSION: VERSION,
    isDebitSide: isDebitSide,
    parseCsv: parseCsv,
    sniffDelimiter: sniffDelimiter,
    guessMapping: guessMapping,
    csvToTransactions: csvToTransactions,
    transactionsToQbo: transactionsToQbo,
    transactionsToOfx: transactionsToOfx,
    transactionsToQfx: transactionsToQfx,
    ofxToTransactions: ofxToTransactions,
    transactionsToCsv: transactionsToCsv,
    qifToTransactions: qifToTransactions,
    transactionsToQif: transactionsToQif,
    iifToTransactions: iifToTransactions,
    transactionsToIif: transactionsToIif,
    parseAmount: parseAmount,
    parseDate: parseDate,
    convert: convert,
    parsers: PARSERS,
    emitters: EMITTERS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  else global.StatementEngine = Engine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
