// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { summarizeDocument, buildScanSearchTerms } from './doc-summary';

describe('summarizeDocument', () => {
  test('empty text → generic document, never fabricated', () => {
    const s = summarizeDocument('');
    expect(s.docType).toBe('document');
    expect(s.summary).toBe('Scanned document');
    expect(s.keyFields).toEqual([]);
    expect(s.wordCount).toBe(0);
  });

  test('classifies a receipt and extracts the total', () => {
    const text = [
      'ALBERT HEIJN',
      'Damrak 70 Amsterdam',
      'Melk 1.29',
      'Brood 2.10',
      'Subtotaal 3.39',
      'BTW 9% 0.30',
      'TOTAAL €3.69',
      'Bedankt voor uw bezoek',
    ].join('\n');
    const s = summarizeDocument(text);
    expect(s.docType).toBe('receipt');
    expect(s.keyFields.some((f) => f.label === 'Total' && f.value.includes('3.69'))).toBe(true);
    expect(s.summary.startsWith('Receipt')).toBe(true);
  });

  test('classifies an invoice with date and amount due', () => {
    const text = [
      'INVOICE',
      'Invoice No: 2026-0042',
      'Bill to: Acme BV',
      'Due date: 2026-07-01',
      'Amount due: €1,250.00',
    ].join('\n');
    const s = summarizeDocument(text);
    expect(s.docType).toBe('invoice');
    expect(s.keyFields.some((f) => f.label === 'Date')).toBe(true);
    expect(s.keyFields.some((f) => f.label === 'Total' && f.value.includes('1,250.00'))).toBe(true);
  });

  test('classifies a bank statement and extracts IBAN', () => {
    const text = [
      'Bank Statement',
      'Account number: 12345678',
      'IBAN NL91 ABNA 0417 1643 00',
      'Opening balance 100.00',
      'Closing balance €250.00',
    ].join('\n');
    const s = summarizeDocument(text);
    expect(s.docType).toBe('bank_statement');
    expect(s.keyFields.some((f) => f.label === 'IBAN' && f.value.includes('NL91'))).toBe(true);
  });

  test('detects an ID document via MRZ lines', () => {
    const text = [
      'PASPOORT / PASSPORT',
      'Nationality: Netherlands',
      'P<NLDDE<BRUIJN<<WILLEM<<<<<<<<<<<<<<<<<<<<<<',
      'XN12345670NLD8001019M2501012<<<<<<<<<<<<<<06',
    ].join('\n');
    const s = summarizeDocument(text);
    expect(s.docType).toBe('id');
  });

  test('classifies a boarding pass', () => {
    const text = ['BOARDING PASS', 'Flight KL1234', 'Gate D7', 'Seat 14A', 'Departure 18:40'].join('\n');
    const s = summarizeDocument(text);
    expect(s.docType).toBe('boarding_pass');
  });

  test('classifies a letter', () => {
    const text = ['Geachte heer De Vries,', 'Hierbij bevestigen wij...', 'Met vriendelijke groet,', 'Jan Jansen'].join('\n');
    const s = summarizeDocument(text);
    expect(s.docType).toBe('letter');
  });

  test('title falls back to the first meaningful line', () => {
    const text = ['***', '12', 'Quarterly Report 2026', 'lorem ipsum'].join('\n');
    const s = summarizeDocument(text);
    expect(s.title).toBe('Quarterly Report 2026');
  });

  test('long title is truncated with an ellipsis', () => {
    const longLine = 'A'.repeat(120);
    const s = summarizeDocument(longLine);
    expect(s.title.length).toBeLessThanOrEqual(60);
    expect(s.title.endsWith('…')).toBe(true);
  });

  test('is deterministic for the same input', () => {
    const text = 'INVOICE\nDue date: 2026-07-01\nAmount due: €99.00';
    expect(summarizeDocument(text)).toEqual(summarizeDocument(text));
  });
});

describe('buildScanSearchTerms', () => {
  test('produces de-duplicated lowercase tokens including type + content', () => {
    const text = 'INVOICE Acme BV Amsterdam total due';
    const summary = summarizeDocument(text);
    const terms = buildScanSearchTerms(text, summary, 40);
    expect(terms).toContain('invoice');
    expect(terms).toContain('amsterdam');
    // de-duplicated
    expect(new Set(terms).size).toBe(terms.length);
    // all lowercase, length-bounded
    for (const t of terms) {
      expect(t).toBe(t.toLowerCase());
      expect(t.length).toBeGreaterThanOrEqual(3);
      expect(t.length).toBeLessThanOrEqual(32);
    }
  });

  test('respects the token limit', () => {
    const text = Array.from({ length: 200 }, (_, i) => `word${i}aaaa`).join(' ');
    const summary = summarizeDocument(text);
    const terms = buildScanSearchTerms(text, summary, 10);
    expect(terms.length).toBeLessThanOrEqual(10);
  });
});
