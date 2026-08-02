/**
 * bank-formats — TypeScript definitions.
 *
 * Amounts are signed numbers: debits are negative, credits positive.
 * Dates are always the string form `YYYYMMDD`, which is what OFX/QBO/QFX use
 * natively and what avoids every ambiguity CSV dates suffer from.
 */

/** A single transaction, normalised across every supported format. */
export interface Transaction {
  /** `YYYYMMDD`. */
  date: string;
  /** Signed: debits negative, credits positive. */
  amount: number;
  description: string;
  memo?: string;
  checknum?: string;
  type?: 'DEBIT' | 'CREDIT' | 'CHECK' | 'DEP' | 'XFER' | 'FEE' | 'INT' | 'OTHER' | string;
  /** Financial institution transaction id. Generated when a format has none. */
  fitid?: string;
}

/** Account details carried by OFX-family files, used when emitting them. */
export interface AccountMeta {
  /** Institution name, e.g. "Chase". */
  org?: string;
  /** Institution id. */
  fid?: string;
  /** Intuit bank id. Defaults to `fid` — QuickBooks rejects files where it is wrong. */
  intuBid?: string;
  /** Routing number. */
  bankId?: string;
  /** Account number. */
  acctId?: string;
  acctType?: 'CHECKING' | 'SAVINGS' | 'CREDITLINE' | 'MONEYMRKT' | string;
  /** ISO currency code. Defaults to `USD`. */
  curdef?: string;
}

/** Which CSV column index holds which field. `-1` means "not present". */
export interface ColumnMapping {
  date: number;
  description: number;
  amount: number;
  debit?: number;
  credit?: number;
  memo?: number;
  checknum?: number;
}

export interface ParseResult {
  transactions: Transaction[];
  /** Rows that could not be parsed. Empty on a clean parse. */
  errors: Array<{ row: number; reason: string }>;
  /** Account details, when the source format carries them (OFX/QBO/QFX). */
  meta?: AccountMeta;
  /** The column mapping actually used, for CSV input. */
  mapping?: ColumnMapping;
}

export interface CsvParseOptions {
  /** Auto-detected when omitted. */
  delimiter?: string;
  /** Override the guessed column mapping. */
  map?: Partial<ColumnMapping>;
  /** How to read ambiguous dates. Defaults to `'MDY'`. */
  dateOrder?: 'MDY' | 'DMY' | 'YMD';
  /** `'single'` = one signed column; `'split'` = separate debit/credit columns. */
  amountMode?: 'single' | 'split';
  /** Flip every sign — for exports that treat debits as positive. */
  invert?: boolean;
}

export interface CsvEmitOptions {
  delimiter?: string;
  /** Defaults to `['date','description','amount','type','checknum','memo']`. */
  columns?: Array<keyof Transaction>;
  dateFormat?: 'YMD' | 'MDY' | 'DMY';
  /** `'split'` writes separate Debit and Credit columns. */
  amountMode?: 'single' | 'split';
}

export type SourceFormat = 'csv' | 'ofx' | 'qbo' | 'qfx' | 'qif' | 'iif';
export type TargetFormat = 'qbo' | 'csv' | 'qif' | 'iif';

export interface ConvertConfig {
  from: SourceFormat;
  to: TargetFormat;
  input: string;
  parseOpts?: CsvParseOptions | Record<string, unknown>;
  emitOpts?: AccountMeta | CsvEmitOptions | Record<string, unknown>;
}

export interface ConvertResult {
  /** The converted file, as text. */
  output: string;
  result: ParseResult;
}

export declare const VERSION: string;

/** One-call conversion between any supported pair. Throws on an unknown format. */
export declare function convert(cfg: ConvertConfig): ConvertResult;

export declare function parseCsv(text: string, delimiter?: string): { headers: string[]; rows: string[][] };
export declare function guessMapping(headers: string[]): ColumnMapping;
export declare function csvToTransactions(text: string, opts?: CsvParseOptions): ParseResult;
export declare function transactionsToCsv(txns: Transaction[], opts?: CsvEmitOptions): string;

/** Parses OFX, QBO and QFX — they share a container format. */
export declare function ofxToTransactions(text: string, opts?: Record<string, unknown>): ParseResult;
/** Emits QuickBooks Web Connect (.qbo). Set `intuBid` if QuickBooks rejects the file. */
export declare function transactionsToQbo(txns: Transaction[], acct?: AccountMeta): string;

export declare function qifToTransactions(text: string, opts?: Record<string, unknown>): ParseResult;
export declare function transactionsToQif(txns: Transaction[], opts?: Record<string, unknown>): string;

export declare function iifToTransactions(text: string, opts?: Record<string, unknown>): ParseResult;
export declare function transactionsToIif(txns: Transaction[], opts?: Record<string, unknown>): string;

/** Reads `1,234.56`, `(1,234.56)`, `1.234,56`, `$1,234.56` and friends. */
export declare function parseAmount(raw: string): number | null;
/** Returns `YYYYMMDD`, or null when unparseable. */
export declare function parseDate(raw: string, order?: 'MDY' | 'DMY' | 'YMD'): string | null;

export declare const parsers: Record<SourceFormat, (text: string, opts?: unknown) => ParseResult>;
export declare const emitters: Record<TargetFormat, (txns: Transaction[], opts?: unknown) => string>;

declare const _default: {
  VERSION: typeof VERSION;
  convert: typeof convert;
  parseCsv: typeof parseCsv;
  guessMapping: typeof guessMapping;
  csvToTransactions: typeof csvToTransactions;
  transactionsToCsv: typeof transactionsToCsv;
  ofxToTransactions: typeof ofxToTransactions;
  transactionsToQbo: typeof transactionsToQbo;
  qifToTransactions: typeof qifToTransactions;
  transactionsToQif: typeof transactionsToQif;
  iifToTransactions: typeof iifToTransactions;
  transactionsToIif: typeof transactionsToIif;
  parseAmount: typeof parseAmount;
  parseDate: typeof parseDate;
  parsers: typeof parsers;
  emitters: typeof emitters;
};
export default _default;
