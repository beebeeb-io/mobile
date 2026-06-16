/**
 * Local, on-device document summarization (task 0802).
 *
 * Given OCR text extracted on-device (Apple Vision, see
 * `modules/beebeeb-crypto recognizeDocumentText`), this produces a short
 * human-readable summary of *what the document is* plus a few key fields, so a
 * scanned document is recognizable and findable later.
 *
 * Strictly local: pure string heuristics, ZERO network, no model download, no
 * cloud. Deterministic and unit-tested. The heuristics are intentionally
 * conservative — when nothing matches we fall back to a generic "Document"
 * type and the first meaningful line as the title, never a fabricated claim.
 *
 * Multi-language aware (EU-first): keyword tables include common English,
 * Dutch, German, and French terms so receipts/invoices from across Europe are
 * classified, not just English ones.
 */

export type DocType =
  | 'receipt'
  | 'invoice'
  | 'id'
  | 'bank_statement'
  | 'boarding_pass'
  | 'prescription'
  | 'contract'
  | 'letter'
  | 'form'
  | 'document';

export interface DocKeyField {
  label: string;
  value: string;
}

export interface DocSummary {
  docType: DocType;
  /** Human-facing label, e.g. "Receipt". */
  docTypeLabel: string;
  /** Best-guess title (first meaningful line), may be empty. */
  title: string;
  /** One-line summary, e.g. "Receipt · €42.50 · 14 Jun 2026". */
  summary: string;
  /** A few extracted fields (date, total, IBAN…), best-effort. */
  keyFields: DocKeyField[];
  /** Number of whitespace-separated words recognized. */
  wordCount: number;
}

const DOC_TYPE_LABELS: Record<DocType, string> = {
  receipt: 'Receipt',
  invoice: 'Invoice',
  id: 'ID document',
  bank_statement: 'Bank statement',
  boarding_pass: 'Boarding pass',
  prescription: 'Prescription',
  contract: 'Contract',
  letter: 'Letter',
  form: 'Form',
  document: 'Document',
};

// Keyword tables per type. Each hit adds to that type's score; the highest
// score wins (ties broken by the order below via a stable scan).
const TYPE_KEYWORDS: Array<{ type: DocType; terms: string[] }> = [
  {
    type: 'boarding_pass',
    terms: ['boarding pass', 'boarding', 'gate', 'seat', 'flight', 'departure', 'arrival', 'pnr', 'group', 'zone', 'instapkaart'],
  },
  {
    type: 'id',
    terms: ['passport', 'paspoort', 'reisepass', 'identity card', 'id card', 'identiteitskaart', 'personalausweis', "carte d'identite", 'driver license', 'driving licence', 'rijbewijs', 'führerschein', 'date of birth', 'geboortedatum', 'nationality', 'nationaliteit'],
  },
  {
    type: 'bank_statement',
    terms: ['account statement', 'bank statement', 'rekeningafschrift', 'kontoauszug', 'opening balance', 'closing balance', 'beginsaldo', 'eindsaldo', 'iban', 'bic', 'sort code', 'account number', 'rekeningnummer'],
  },
  {
    type: 'prescription',
    terms: ['prescription', 'recept', 'rezept', 'ordonnance', 'dosage', 'dosering', 'tablet', 'capsule', 'pharmacy', 'apotheek', 'apotheke', 'mg ', 'ml ', 'twice daily', 'once daily'],
  },
  {
    type: 'invoice',
    terms: ['invoice', 'factuur', 'rechnung', 'facture', 'invoice no', 'invoice number', 'factuurnummer', 'bill to', 'due date', 'vervaldatum', 'amount due', 'te betalen', 'payment terms', 'betalingstermijn'],
  },
  {
    type: 'receipt',
    terms: ['receipt', 'kassabon', 'bon', 'kassenbon', 'ticket de caisse', 'subtotal', 'subtotaal', 'change', 'wisselgeld', 'cash', 'contant', 'card', 'pin', 'thank you for your', 'bedankt voor', 'qty', 'aantal', 'vat', 'btw', 'mwst', 'tva'],
  },
  {
    type: 'contract',
    terms: ['agreement', 'overeenkomst', 'vertrag', 'contrat', 'terms and conditions', 'algemene voorwaarden', 'hereby', 'the parties', 'partijen', 'signature', 'handtekening', 'undersigned', 'ondergetekende'],
  },
  {
    type: 'form',
    terms: ['application form', 'formulier', 'please complete', 'please fill', 'vul in', 'tick the box', 'checkbox', 'declaration', 'verklaring'],
  },
  {
    type: 'letter',
    terms: ['dear ', 'geachte', 'beste ', 'sehr geehrte', 'cher ', 'sincerely', 'kind regards', 'met vriendelijke groet', 'mit freundlichen', 'yours faithfully', 'yours sincerely'],
  },
];

// Currency symbols/codes we recognize for "total" extraction.
const AMOUNT_RE =
  /(?:€|\$|£|EUR|USD|GBP|CHF)\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?|\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s?(?:€|\$|£|EUR|USD|GBP|CHF)/gi;

// Common date formats: ISO, dd/mm/yyyy, dd-mm-yyyy, "14 Jun 2026", "Jun 14, 2026".
const DATE_RES: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/,
  /\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}\b/i,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i,
];

const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,8}\b/;

const TOTAL_HINTS = ['total', 'totaal', 'amount due', 'te betalen', 'gesamt', 'montant', 'balance', 'grand total'];

function normalizeAmount(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Pick the most relevant monetary amount: prefer a line that mentions a total. */
function extractTotal(lines: string[]): string | null {
  let fallback: string | null = null;
  for (const line of lines) {
    const matches = line.match(AMOUNT_RE);
    if (!matches || matches.length === 0) continue;
    const amount = normalizeAmount(matches[matches.length - 1]!);
    const lower = line.toLowerCase();
    if (TOTAL_HINTS.some((hint) => lower.includes(hint))) {
      return amount;
    }
    if (!fallback) fallback = amount;
  }
  return fallback;
}

function extractDate(text: string): string | null {
  for (const re of DATE_RES) {
    const match = text.match(re);
    if (match) return match[0];
  }
  return null;
}

function extractIban(text: string): string | null {
  const match = text.match(IBAN_RE);
  return match ? match[0].replace(/\s+/g, ' ').trim() : null;
}

function firstMeaningfulLine(lines: string[]): string {
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip lines that are basically just punctuation/numbers or too short.
    if (trimmed.length < 3) continue;
    const letters = trimmed.replace(/[^a-zA-ZÀ-ɏ]/g, '');
    if (letters.length < 2) continue;
    return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
  }
  return '';
}

function classify(text: string): DocType {
  const lower = ` ${text.toLowerCase()} `;
  const scores = new Map<DocType, number>();
  for (const { type, terms } of TYPE_KEYWORDS) {
    let score = 0;
    for (const term of terms) {
      // Count occurrences (capped) so a strongly-themed doc scores higher.
      let idx = lower.indexOf(term);
      let hits = 0;
      while (idx !== -1 && hits < 3) {
        hits += 1;
        idx = lower.indexOf(term, idx + term.length);
      }
      score += hits;
    }
    if (score > 0) scores.set(type, score);
  }

  // MRZ lines (passports/IDs) are a strong signal: two+ lines packed with `<`.
  const mrzLines = text.split(/\r?\n/).filter((l) => (l.match(/</g) ?? []).length >= 4).length;
  if (mrzLines >= 1) scores.set('id', (scores.get('id') ?? 0) + 3);

  let best: DocType = 'document';
  let bestScore = 0;
  // TYPE_KEYWORDS order is the tie-break priority.
  for (const { type } of TYPE_KEYWORDS) {
    const score = scores.get(type) ?? 0;
    if (score > bestScore) {
      best = type;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Summarize OCR text into a document type + key fields + a one-line summary.
 * Pure and deterministic; safe to call with empty/garbage input.
 */
export function summarizeDocument(rawText: string): DocSummary {
  const text = (rawText ?? '').trim();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const wordCount = text.length === 0 ? 0 : text.split(/\s+/).filter(Boolean).length;

  if (text.length === 0) {
    return {
      docType: 'document',
      docTypeLabel: DOC_TYPE_LABELS.document,
      title: '',
      summary: 'Scanned document',
      keyFields: [],
      wordCount: 0,
    };
  }

  const docType = classify(text);
  const title = firstMeaningfulLine(lines);

  const keyFields: DocKeyField[] = [];
  const date = extractDate(text);
  if (date) keyFields.push({ label: 'Date', value: date });

  // Totals only make sense for money documents.
  if (docType === 'receipt' || docType === 'invoice' || docType === 'bank_statement') {
    const total = extractTotal(lines);
    if (total) keyFields.push({ label: 'Total', value: total });
  }

  if (docType === 'bank_statement' || docType === 'invoice') {
    const iban = extractIban(text);
    if (iban) keyFields.push({ label: 'IBAN', value: iban });
  }

  // Build the one-line summary: type + up to two of the most useful fields.
  const summaryParts: string[] = [DOC_TYPE_LABELS[docType]];
  for (const field of keyFields.slice(0, 2)) {
    summaryParts.push(field.value);
  }
  if (summaryParts.length === 1 && title) {
    summaryParts.push(title);
  }

  return {
    docType,
    docTypeLabel: DOC_TYPE_LABELS[docType],
    title,
    summary: summaryParts.join(' · '),
    keyFields,
    wordCount,
  };
}

/**
 * Clean hook for the encrypted search index (task 0778): produces the set of
 * searchable terms a scanned document should be findable by. A follow-up wires
 * this into `toSearchIndexEntry` (FilesScreen) so scanned docs surface in
 * vault search by their content — kept here so the data + tokenization live
 * with the OCR/summary logic, not the (separately-owned) Files screen.
 *
 * Returns a de-duplicated, lower-cased token list (length-capped) drawn from
 * the OCR text plus the detected type/title — never the full document body, to
 * keep the encrypted index small.
 */
export function buildScanSearchTerms(ocrText: string, summary: DocSummary, limit = 40): string[] {
  const seen = new Set<string>();
  const push = (token: string) => {
    const t = token.toLowerCase();
    if (t.length >= 3 && t.length <= 32 && !seen.has(t)) seen.add(t);
  };

  push(summary.docType);
  for (const word of summary.docTypeLabel.split(/\s+/)) push(word);
  for (const word of (summary.title ?? '').split(/\s+/)) push(word.replace(/[^a-zA-Z0-9À-ɏ]/g, ''));
  for (const field of summary.keyFields) push(field.value.replace(/\s+/g, ''));

  for (const word of (ocrText ?? '').split(/\s+/)) {
    if (seen.size >= limit) break;
    push(word.replace(/[^a-zA-Z0-9À-ɏ]/g, ''));
  }

  return Array.from(seen).slice(0, limit);
}
