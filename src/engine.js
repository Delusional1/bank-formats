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

  // Escape the few chars that trip up QuickBooks' OFX/SGML import.
  function ofxEscape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Parse a money string into a signed Number.
  //   "$1,234.56" -> 1234.56 ; "(45.00)" -> -45.00 ; "-12.3" -> -12.3
  function parseAmount(raw) {
    if (raw == null) return NaN;
    var s = String(raw).trim();
    if (s === '') return NaN;
    var neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); } // (123) accounting negative
    s = s.replace(/[^0-9.\-]/g, ''); // strip $, commas, spaces, currency codes
    if (s === '' || s === '-' || s === '.') return NaN;
    var n = parseFloat(s);
    if (isNaN(n)) return NaN;
    return neg ? -Math.abs(n) : n;
  }

  // Parse a date cell to 'YYYYMMDD' using an explicit order hint.
  //   order: 'MDY' | 'DMY' | 'YMD'   (delimiter auto-detected: / - . )
  function parseDate(raw, order) {
    if (raw == null) return null;
    var s = String(raw).trim();
    if (s === '') return null;
    // Already ISO-ish YYYYMMDD or YYYY-MM-DD
    var iso = s.match(/^(\d{4})[-\/.]?(\d{1,2})[-\/.]?(\d{1,2})/);
    if (order === 'YMD' && iso) {
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
    return {
      date: find([/date/, /posted/, /trans.*date/]),
      description: find([/description/, /details/, /narrative/, /payee/, /memo/, /name/]),
      amount: find([/^amount$/, /amount/, /value/]),
      debit: find([/debit/, /withdrawal/, /paid out/, /^out$/]),
      credit: find([/credit/, /deposit/, /paid in/, /^in$/]),
      checknum: find([/check/, /cheque/, /ref/])
    };
  }

  // Map parsed CSV -> normalized transactions.
  // opts: { map:{date,description,amount,debit,credit,checknum}, dateOrder,
  //         amountMode:'single'|'split', invert:Boolean }
  function csvToTransactions(text, opts) {
    opts = opts || {};
    var parsed = parseCsv(text, opts.delimiter);
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
  function transactionsToQbo(txns, acct) {
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
    L.push('<INTU.BID>' + ofxEscape(bid));
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
      L.push('<STMTTRN>');
      L.push('<TRNTYPE>' + (t.type || (t.amount < 0 ? 'DEBIT' : 'CREDIT')));
      L.push('<DTPOSTED>' + t.date + '120000');
      L.push('<TRNAMT>' + t.amount.toFixed(2));
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

  var CSV_LABELS = { date: 'Date', description: 'Description', amount: 'Amount',
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
            row.push(t.amount < 0 ? Math.abs(t.amount).toFixed(2) : '');
            row.push(t.amount >= 0 ? t.amount.toFixed(2) : '');
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

  var PARSERS = { csv: csvToTransactions, ofx: ofxToTransactions, qbo: ofxToTransactions,
    qfx: ofxToTransactions, qif: qifToTransactions, iif: iifToTransactions };
  var EMITTERS = { qbo: transactionsToQbo, csv: transactionsToCsv,
    qif: transactionsToQif, iif: transactionsToIif };

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
    parseCsv: parseCsv,
    guessMapping: guessMapping,
    csvToTransactions: csvToTransactions,
    transactionsToQbo: transactionsToQbo,
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
