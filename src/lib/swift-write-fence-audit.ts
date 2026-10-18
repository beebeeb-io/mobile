/**
 * Task 1667 round 8 — static audit of the camera-roll manifest's WRITE FENCE in
 * `NativeBackupEngine.swift` (Codex P1 "Fence late photo scans before resetting
 * the manifest", mobile#182 at 556ef334).
 *
 * The rule (ManifestWriteFence.swift): every write to the manifest runs in a
 * `dbQueue` critical section that first checks the producer's write ticket
 * (`admitsWrite(ticket, ...)` / `admitsChunkCallback(...)`, or one of the
 * `FencedManifestWrites` functions, which check it themselves). The sign-out
 * reset advances the fence in its own critical section, so a write that comes
 * after it from a producer that started before it is dropped.
 *
 * The Swift compiler cannot see that rule, so this reads the source:
 *   1. WRITER functions: engine functions whose body holds an INSERT / UPDATE /
 *      DELETE statement or calls a `BackupManifestStore` write, and (to a fixed
 *      point) every function that calls a writer outside a dbQueue closure.
 *   2. WRITING critical sections: every `dbQueue.sync` / `dbQueue.async`
 *      closure that calls a writer, a store write or a fenced write.
 *   3. Each one must be FENCED (ticket check before its first write), be the
 *      RESET itself (the handle's reset / recovery / open, which advance the
 *      fence), or be listed in `EXEMPT` with the reason it cannot let a
 *      producer from before a reset write after it. Anything else is a
 *      violation.
 *
 * Comments and string literals are blanked (`stripSwift`) before any matching,
 * except the statement scan in step 1, which reads the literals on purpose.
 */

import { stripSwift } from './swift-db-queue-audit';

/** `BackupManifestStore` functions that write. */
export const STORE_WRITES = [
  'insertScannedAssets', 'insertScannedAssetsCounting', 'updateSelectionScope', 'markUploaded', 'claim', 'applyServerMap',
  'applyPendingMarks', 'expirePendingMarks', 'adoptUnowned', 'recordServerMarked', 'insertPendingMarks',
  'resetInPlace', 'migrate',
];

/** The handle's reset / recovery / open: these ADVANCE the fence (or open the file). */
export const RESET_CALLS = ['resetForSignOut', 'finishAfterFailedReset', 'openIfClosed', 'openManifestIfClosed', 'openDatabase'];

/**
 * Writing critical sections that run without a ticket, keyed by enclosing
 * function (or `function:writer` for one section of a function that also has
 * fenced ones), each with the reason no producer from before a sign-out reset can
 * use it to put data back into the emptied manifest.
 */
export const EXEMPT: Record<string, string> = {
  // Round 11: start()/stop() run their bodies (startLocked/stopLocked) inside
  // one BackupEngineLifecycle transition.
  startLocked:
    'purgeMismatchedStagedAssets: removes staged state encrypted for another account (UPDATE to pending + file delete); it can only take data out, never add a row or an association',
  bindAccount:
    'purgeMismatchedStagedAssets (as in startLocked) plus the fence bind itself, the explicit sign-in that opens the new generation',
  handleBackgroundTask:
    'purgeMismatchedStagedAssets (as in startLocked); the task\'s scan and batch take their own ticket (`writeTicket`) and are fenced',
  stopLocked:
    'recoverStuckUploads: UPDATE of rows already in the manifest (uploading/staging older than 5 min back to pending); cannot add a row or an association. At sign-out it is enqueued before the reset\'s block (FIFO), so the reset removes whatever it touched',
  resetRetryExhaustedUploadsForManualRun:
    'UPDATE of retry counters on rows already in the manifest; no await between triggerManualBackup\'s start() and it; cannot add a row or an association',
  refreshProgress:
    'migratePhotoKitMissingAssetRows: account-agnostic status migration (UPDATE) of rows already in the manifest; cannot add a row or an association',
  clearAccountAndPurgeStaged: 'purgeAllStagedAssets: the sign-out purge itself (removes every staged upload)',
  expireKeptPendingMarks: 'DELETE of kept marks older than 30 days, any account: only removes data',
  'urlSession:markFailed':
    'the uploadTaskMap completion branch: uploadTaskMap has no insert site in the engine (asserted by the test), so this branch never runs; chunk PUT callbacks take the fenced branch above it',
};

export interface WriteSection {
  fn: string;
  line: number;
  writes: string[];
  status: 'fenced' | 'reset' | 'exempt' | 'violation';
}

export interface WriteFenceAudit {
  writerFns: string[];
  sections: WriteSection[];
  violations: string[];
  /** EXEMPT keys that matched no section (a stale exemption is a violation too). */
  unusedExemptions: string[];
}

function matchBrace(s: string, open: number): number {
  let d = 0;
  for (let k = open; k < s.length; k += 1) {
    if (s[k] === '{') d += 1;
    else if (s[k] === '}') {
      d -= 1;
      if (d === 0) return k;
    }
  }
  throw new Error('unbalanced braces in Swift source');
}

interface Range {
  name: string;
  open: number;
  close: number;
}

export function auditWriteFence(source: string): WriteFenceAudit {
  const code = stripSwift(source);
  const lineOf = (pos: number) => code.slice(0, pos).split('\n').length;

  // ---- functions (name + body range)
  const fns: Range[] = [];
  const fnRe = /\bfunc\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g;
  for (let m = fnRe.exec(code); m; m = fnRe.exec(code)) {
    // The body is the first `{` after the signature's closing parenthesis.
    let depth = 0;
    let k = m.index + m[0].length - 1;
    for (; k < code.length; k += 1) {
      if (code[k] === '(') depth += 1;
      else if (code[k] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const open = code.indexOf('{', k);
    const semi = code.indexOf('\n', k);
    if (open < 0) continue;
    // A protocol requirement / declaration without a body: skip.
    if (code.slice(k, open).includes('\n  func ')) continue;
    void semi;
    fns.push({ name: m[1], open, close: matchBrace(code, open) });
  }
  const innermostFn = (pos: number) =>
    fns.filter((f) => f.open < pos && pos < f.close).sort((a, b) => b.open - a.open)[0];

  // ---- dbQueue closures
  const closures: Range[] = [];
  const qRe = /\bdbQueue\.(sync|async)\s*(?:\(\s*execute:\s*)?\{/g;
  for (let m = qRe.exec(code); m; m = qRe.exec(code)) {
    const open = m.index + m[0].length - 1;
    closures.push({ name: m[1], open, close: matchBrace(code, open) });
  }
  const inClosure = (pos: number) => closures.some((c) => c.open < pos && pos < c.close);

  // ---- 1. writer functions
  const sqlWrite = /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/;
  const storeWriteRe = new RegExp(`BackupManifestStore\\.(${STORE_WRITES.join('|')})\\(`);
  const writers = new Set<string>();
  for (const f of fns) {
    const rawBody = source.slice(f.open, f.close);
    const body = code.slice(f.open, f.close);
    if (sqlWrite.test(rawBody) || storeWriteRe.test(body)) writers.add(f.name);
  }
  // Fixed point: a function that calls a writer OUTSIDE a dbQueue closure writes too.
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of fns) {
      if (writers.has(f.name)) continue;
      const body = code.slice(f.open, f.close);
      for (const w of writers) {
        const re = new RegExp(`(?<![\\w])${w}\\(`, 'g');
        for (let m = re.exec(body); m; m = re.exec(body)) {
          const pos = f.open + m.index;
          if (/func\s+$/.test(code.slice(Math.max(0, pos - 6), pos))) continue;
          if (!inClosure(pos)) {
            writers.add(f.name);
            changed = true;
            break;
          }
        }
        if (writers.has(f.name)) break;
      }
    }
  }
  // The fence checks themselves are not writers.
  writers.delete('admitsWrite');
  writers.delete('admitsChunkCallback');

  // ---- 2 + 3. writing critical sections
  const writerCallRe = new RegExp(
    `(?<![\\w])(?:self\\??\\.)?(${[...writers].join('|')})\\(|BackupManifestStore\\.(${STORE_WRITES.join('|')})\\(|FencedManifestWrites\\.(\\w+)\\(`,
    'g',
  );
  const resetRe = new RegExp(`(?<![\\w])(?:self\\??\\.)?(?:manifestHandle\\.)?(${RESET_CALLS.join('|')})\\(`);
  const sections: WriteSection[] = [];
  const violations: string[] = [];
  const usedExempt = new Set<string>();
  for (const c of closures) {
    const body = code.slice(c.open, c.close);
    const writes: string[] = [];
    let firstWrite = -1;
    let allFencedFns = true;
    for (let m = writerCallRe.exec(body); m; m = writerCallRe.exec(body)) {
      const name = m[1] ?? (m[2] ? `BackupManifestStore.${m[2]}` : `FencedManifestWrites.${m[3]}`);
      writes.push(name);
      if (firstWrite < 0) firstWrite = m.index;
      if (!m[3]) allFencedFns = false;
      else {
        // A fenced write must be handed the handle's fence and a ticket.
        const call = body.slice(m.index, body.indexOf(')', body.indexOf('ticket:', m.index)) + 1);
        if (!/fence: (?:self\.)?manifestHandle\.writeFence/.test(call) || /ticket: nil\b/.test(call) || !/ticket: \w+/.test(call)) {
          violations.push(`FencedManifestWrites.${m[3]} at line ${lineOf(c.open + m.index)} is not handed manifestHandle.writeFence and a ticket`);
        }
      }
    }
    writerCallRe.lastIndex = 0;
    // A statement written inline in the closure is a write too.
    const rawBody = source.slice(c.open, c.close);
    const inline = sqlWrite.exec(rawBody);
    if (inline) {
      writes.push('<inline SQL>');
      allFencedFns = false;
      const at = rawBody.indexOf(inline[0]);
      if (firstWrite < 0 || at < firstWrite) firstWrite = at;
    }
    const isReset = resetRe.test(body);
    if (writes.length === 0 && !isReset) continue;
    const fn = innermostFn(c.open)?.name ?? '<top-level>';
    const line = lineOf(c.open);
    let status: WriteSection['status'];
    const checkAt = Math.min(
      ...['admitsWrite(', 'admitsChunkCallback('].map((n) => body.indexOf(n)).filter((i) => i >= 0),
    );
    if (writes.length > 0 && Number.isFinite(checkAt) && checkAt < firstWrite) status = 'fenced';
    else if (writes.length > 0 && allFencedFns) status = 'fenced';
    else if (isReset && writes.every((w) => w.startsWith('BackupManifestStore.') === false)) status = 'reset';
    else if (EXEMPT[`${fn}:${[...new Set(writes)].join(',')}`]) {
      status = 'exempt';
      usedExempt.add(`${fn}:${[...new Set(writes)].join(',')}`);
    } else if (EXEMPT[fn]) {
      status = 'exempt';
      usedExempt.add(fn);
    } else {
      status = 'violation';
      violations.push(`unfenced manifest write in ${fn} at line ${line}: ${writes.join(', ')}`);
    }
    sections.push({ fn, line, writes, status });
  }
  const unusedExemptions = Object.keys(EXEMPT).filter((k) => !usedExempt.has(k));
  for (const k of unusedExemptions) violations.push(`stale exemption: ${k} has no unfenced write section`);

  return { writerFns: [...writers].sort(), sections, violations, unusedExemptions };
}
