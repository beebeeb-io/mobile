/**
 * LD-0002 round 2 — static audit of the SQLite connections the MAIN APP opens.
 *
 * iOS kills an app that holds a lock on a file in an app-group container when it
 * suspends it (`RUNNINGBOARD 0xdead10cc`, TestFlight 258). The File Provider cache
 * database is that file. Every main-app connection to it must therefore go through
 * `FileProviderCacheDB` (the background execution gate, `BackupExecutionGate`):
 *
 *   1. ENTER   `FileProviderCacheDB.shared.enter()` (or a `SQLiteResetScope`'s
 *              `begin()`) before the open; nil means "not now" and nothing opens.
 *   2. ATTACH  `section.attach(db)` right after the open, so an expiry can
 *              interrupt the connection.
 *   3. FINISH  `section.finish(closing: db)` (or the scope-aware `finish(db)`), so
 *              the connection is withdrawn BEFORE it is closed and the quiesce
 *              wait ends only once the handle is gone.
 *
 * This reads the Swift text (it cannot be compiled on the Linux CI containers), like
 * `swift-db-queue-audit.ts`. It is deliberately conservative: a `sqlite3_open*` call in
 * a file this audit does not know is treated as an app-group connection, so a NEW
 * file that opens a database must either be gated or be added to
 * `DOCUMENTS_CONTAINER_FILES` with the reason (its database lives outside the
 * app group and is gated by its own audit).
 */
import { stripSwift } from './swift-db-queue-audit';

/**
 * Files whose connections are NOT to an app-group database. Their databases live in
 * `Documents/` and sit behind the same gate through their own audits
 * (`backup-execution-gate-wiring.test.ts`, `swift-db-queue-audit.ts`).
 */
export const DOCUMENTS_CONTAINER_FILES: Readonly<Record<string, string>> = {
  'BackupManifestHandle.swift': 'Documents/SQLite/beebeeb-backup.db',
  'BackupManifestStore.swift': 'Documents/SQLite/beebeeb-backup.db (rebuild staging + reader)',
  'ThumbnailQueueDB.swift': 'Documents/thumbnail_queue.sqlite',
};

export interface OpenSite {
  file: string;
  line: number;
  /** The enclosing `func name` or `AsyncFunction("name")`. */
  where: string;
  appGroup: boolean;
  gated: boolean;
}

export interface AppGroupSqliteAudit {
  sites: OpenSite[];
  appGroupSites: OpenSite[];
  documentsSites: OpenSite[];
  violations: string[];
}

interface Frame {
  name: string | null;
  start: number;
  end: number;
}

const OPEN_RE = /\b(?:ex)?sqlite3_open(?:_v2)?\(/g;

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

/** Every `{ ... }` of the (comment- and string-free) source with the name of the function it belongs to, if any. */
function frames(code: string, source: string): Frame[] {
  const out: Frame[] = [];
  const stack: Array<{ start: number; header: string; rawHeader: string }> = [];
  let boundary = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '{') {
      stack.push({ start: i, header: code.slice(boundary, i), rawHeader: source.slice(boundary, i) });
      boundary = i + 1;
    } else if (ch === '}') {
      const open = stack.pop();
      if (open) {
        const header = open.header.slice(-600);
        const fn = header.match(/\bfunc\s+(\w+)/g);
        // string literals are blanked in `code`; the module name is read from the same span of the source
        const asyncFn = open.rawHeader.trimEnd().match(/AsyncFunction\("(\w+)"\)$/);
        let name: string | null = null;
        if (asyncFn) name = `AsyncFunction(${asyncFn[1]})`;
        else if (fn && /\)\s*(?:async\s*)?(?:throws\s*)?(?:->[^{]*)?$/.test(header.trimEnd())) {
          name = fn[fn.length - 1].replace(/^func\s+/, '');
        }
        out.push({ name, start: open.start, end: i });
      }
      boundary = i + 1;
    } else if (ch === ';') {
      boundary = i + 1;
    }
  }
  return out;
}

function enclosing(frameList: Frame[], index: number): Frame | null {
  let best: Frame | null = null;
  for (const frame of frameList) {
    if (frame.name === null || frame.start > index || frame.end < index) continue;
    if (!best || frame.end - frame.start < best.end - best.start) best = frame;
  }
  return best;
}

export function auditAppGroupSqlite(files: ReadonlyArray<{ name: string; source: string }>): AppGroupSqliteAudit {
  const sites: OpenSite[] = [];
  const violations: string[] = [];
  for (const { name, source } of files) {
    const code = stripSwift(source);
    const frameList = frames(code, source);
    for (const match of code.matchAll(OPEN_RE)) {
      const index = match.index ?? 0;
      const line = lineOf(code, index);
      const frame = enclosing(frameList, index);
      const where = frame?.name ?? '(top level)';
      const appGroup = !(name in DOCUMENTS_CONTAINER_FILES);
      let gated = false;
      if (appGroup) {
        if (!frame) {
          violations.push(`${name}:${line}: an app-group sqlite3_open outside any function`);
        } else {
          const body = code.slice(frame.start, frame.end);
          const at = index - frame.start;
          const before = body.slice(0, at);
          const after = body.slice(at);
          const entered = /\.(?:enter|begin)\(\)/.test(before);
          const attached = /\.attach\(/.test(after);
          const finished = /\bfinish\(\s*(?:closing:\s*)?db\s*\)/.test(body);
          // A connection closed by hand skips the withdraw that must come first.
          const closedByHand = /\bsqlite3_close(?:_v2)?\(\s*db\s*\)/.test(body);
          gated = entered && attached && finished && !closedByHand;
          if (!entered) violations.push(`${name}:${line}: ${where} opens a connection without asking the gate first (no .enter()/.begin() before the open)`);
          if (!attached) violations.push(`${name}:${line}: ${where} never attaches the connection (section.attach(db)) so an expiry cannot interrupt it`);
          if (!finished) violations.push(`${name}:${line}: ${where} never finishes the section (section.finish(closing: db)) so the quiesce cannot wait for it`);
          if (closedByHand) violations.push(`${name}:${line}: ${where} closes the connection with a bare sqlite3_close(db), before the section withdraws it`);
        }
      }
      sites.push({ file: name, line, where, appGroup, gated });
    }
  }
  return {
    sites,
    appGroupSites: sites.filter((s) => s.appGroup),
    documentsSites: sites.filter((s) => !s.appGroup),
    violations,
  };
}
