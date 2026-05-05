/**
 * Recovery Kit PDF generator — mobile (iOS + Android).
 *
 * Uses expo-print to render the HTML document to a PDF file, then
 * expo-sharing to open the native share sheet (Save to Files, AirDrop,
 * print directly, etc.).
 */

import * as Print from 'expo-print'
import * as Sharing from 'expo-sharing'

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a Recovery Kit PDF for the given phrase and email, then open the
 * native share sheet so the user can save or print it.
 *
 * @param phrase Space-separated recovery phrase (e.g. "word1 word2 ... word24")
 * @param email  The user's account email, shown on the kit for identification
 */
export async function generateRecoveryKitPDF(phrase: string, email: string): Promise<void> {
  const html = buildRecoveryKitHTML(phrase, email)
  const { uri } = await Print.printToFileAsync({ html })
  await Sharing.shareAsync(uri, {
    mimeType: 'application/pdf',
    dialogTitle: 'Save Recovery Kit',
    UTI: 'com.adobe.pdf',
  })
}

// ─── HTML builder ─────────────────────────────────────────────────────────────

function buildRecoveryKitHTML(phrase: string, email: string): string {
  const words = phrase.trim().split(/\s+/)
  const dateStr = new Date().toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  const COLS = 3
  const wordRows: string[] = []
  for (let i = 0; i < words.length; i += COLS) {
    const cells = Array.from({ length: COLS }, (_, j) => {
      const idx = i + j
      if (idx >= words.length) return '<td></td>'
      const num = String(idx + 1).padStart(2, '0')
      return `<td class="word-cell">
        <span class="word-num">${num}</span>
        <span class="word-text">${esc(words[idx] ?? '')}</span>
      </td>`
    })
    wordRows.push(`<tr>${cells.join('')}</tr>`)
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Beebeeb Recovery Kit</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  @page { size: A4 portrait; margin: 18mm 20mm 22mm 20mm; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.5;
    color: #1a1a1a;
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .accent-bar { height: 5px; background: #F5B800; border-radius: 3px; margin-bottom: 20px; }

  .logo { font-size: 19pt; font-weight: 800; letter-spacing: -0.03em; color: #0a0a0a; }
  .logo .dot { color: #F5B800; }
  .kit-title { font-size: 11pt; font-weight: 600; color: #555; letter-spacing: 0.06em; text-transform: uppercase; margin-top: 3px; margin-bottom: 22px; }

  .meta { display: flex; gap: 32px; margin-bottom: 24px; padding: 10px 14px; background: #fafaf8; border: 1px solid #e5e3db; border-radius: 6px; }
  .meta-item { display: flex; flex-direction: column; gap: 2px; }
  .meta-label { font-size: 7.5pt; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; color: #999; }
  .meta-value { font-size: 10.5pt; color: #1a1a1a; font-weight: 500; }

  .phrase-heading { font-size: 10pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #444; margin-bottom: 12px; }

  .phrase-table { width: 100%; border-collapse: separate; border-spacing: 6px 6px; margin-bottom: 8px; }
  .word-cell { background: #fafaf8; border: 1px solid #e5e3db; border-radius: 5px; padding: 8px 12px; width: 33.33%; vertical-align: middle; }
  .word-num { font-family: 'Courier New', Courier, monospace; font-size: 8pt; color: #bbb; margin-right: 8px; }
  .word-text { font-family: 'Courier New', Courier, monospace; font-size: 12pt; font-weight: 700; color: #1a1a1a; letter-spacing: 0.01em; }

  .warning { margin-top: 24px; padding: 14px 16px; background: #FFFBEB; border: 1.5px solid #F5B800; border-radius: 6px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .warning-title { font-size: 9pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #92400E; margin-bottom: 6px; }
  .warning-body { font-size: 9.5pt; color: #451A03; line-height: 1.6; }

  .footer { margin-top: 28px; padding-top: 12px; border-top: 1px solid #e5e3db; font-size: 8pt; color: #aaa; display: flex; justify-content: space-between; align-items: center; }
</style>
</head>
<body>
<div class="accent-bar"></div>
<div class="logo">beebeeb<span class="dot">.</span>io</div>
<div class="kit-title">Recovery Kit</div>
<div class="meta">
  <div class="meta-item">
    <span class="meta-label">Account</span>
    <span class="meta-value">${esc(email)}</span>
  </div>
  <div class="meta-item">
    <span class="meta-label">Generated</span>
    <span class="meta-value">${esc(dateStr)}</span>
  </div>
  <div class="meta-item">
    <span class="meta-label">Words</span>
    <span class="meta-value">${words.length}</span>
  </div>
</div>
<div class="phrase-heading">Recovery Phrase</div>
<table class="phrase-table">
  ${wordRows.join('\n  ')}
</table>
<div class="warning">
  <div class="warning-title">Keep this safe — we cannot recover it for you</div>
  <div class="warning-body">
    This phrase is the master key to your encrypted files. If you forget your password,
    this phrase is the only way to recover your account.<br/><br/>
    <strong>Store it offline</strong> — printed, in a safe, with your important documents.
    Never share it. Never photograph it. Never type it into any website other than beebeeb.io.
  </div>
</div>
<div class="footer">
  <span>beebeeb.io &middot; End-to-end encrypted &middot; EU servers &middot; Zero-knowledge</span>
  <span>Initlabs B.V. &middot; Netherlands</span>
</div>
</body>
</html>`
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
