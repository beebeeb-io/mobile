/**
 * Task 1669 — static audit of `NativeBackupEngine.swift`'s SQLite handle.
 *
 * `NativeBackupEngine.db` is a `private var` that is opened by
 * `openDatabase()` ENQUEUED on the private serial `dbQueue` from `init()`
 * (so `.shared` never blocks the launch thread on SQLite). That is only
 * correct while two invariants hold, and neither is checked by the Swift
 * compiler:
 *
 *   1. `openDatabase()` is enqueued from exactly one place: a direct
 *      `dbQueue.async { ... openDatabase() ... }` in `init()`. Enqueued from
 *      inside another queue's closure, the enqueue itself races with the
 *      first `dbQueue.sync { guard let db ... }` a caller issues right after
 *      `.shared` returns, and that caller silently no-ops on `db == nil`.
 *   2. Every read/write of `db` runs on `dbQueue`: either lexically inside a
 *      `dbQueue.sync/async { }` closure ("GUARDED"), or in a function whose
 *      every call site is (transitively) inside one ("REQUIRES").
 *
 * Swift cannot be compiled on the Linux dev/CI containers, so this reads the
 * source text. It is deliberately conservative: comments and string literals
 * are blanked first, and functions are found by brace matching. Helpers that
 * take the handle as a `db: OpaquePointer` PARAMETER shadow the property and
 * are excluded — their callers pass in a `db` that was itself read under one
 * of the two rules above.
 */

export interface DbQueueAudit {
  functionsParsed: number;
  /** functions whose body references the `db` property */
  touchingDb: string[];
  /** every db reference is inside a dbQueue closure in the function itself */
  guarded: string[];
  /** has an unguarded db reference; every caller must be on dbQueue */
  requires: string[];
  /** lines of every `openDatabase(` call (declaration excluded) */
  openDatabaseCallLines: number[];
  /** true iff the only openDatabase call is a direct dbQueue.async in init() */
  openDatabaseEnqueuedFromInit: boolean;
  violations: string[];
}

/** Blank comments and string literals (keeping newlines) so scanning sees code only. */
export function stripSwift(s: string): string {
  const out: string[] = [];
  const blank = (t: string) => t.replace(/[^\n]/g, ' ');
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (s.startsWith('//', i)) {
      let j = s.indexOf('\n', i);
      if (j < 0) j = n;
      out.push(' '.repeat(j - i));
      i = j;
    } else if (s.startsWith('/*', i)) {
      let j = s.indexOf('*/', i);
      j = j < 0 ? n : j + 2;
      out.push(blank(s.slice(i, j)));
      i = j;
    } else if (s.startsWith('"""', i)) {
      let j = s.indexOf('"""', i + 3);
      j = j < 0 ? n : j + 3;
      out.push(blank(s.slice(i, j)));
      i = j;
    } else if (s[i] === '"') {
      let j = i + 1;
      while (j < n && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      j += 1;
      out.push(blank(s.slice(i, j)));
      i = j;
    } else {
      out.push(s[i]);
      i += 1;
    }
  }
  return out.join('');
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

interface Fn {
  name: string;
  sigStart: number;
  bodyOpen: number;
  bodyClose: number;
}

export function auditDbQueue(source: string): DbQueueAudit {
  const code = stripSwift(source);
  const lineOf = (pos: number) => code.slice(0, pos).split('\n').length;

  // ---- functions (name, signature start, body braces)
  const funcs: Fn[] = [];
  const funcRe = /\bfunc\s+(\w+)\s*(<[^>]*>)?\s*\(/g;
  for (let m = funcRe.exec(code); m; m = funcRe.exec(code)) {
    let i = m.index + m[0].length - 1;
    let d = 0;
    for (;; i += 1) {
      if (code[i] === '(') d += 1;
      else if (code[i] === ')') {
        d -= 1;
        if (d === 0) break;
      }
    }
    let j = i;
    while (j < code.length && code[j] !== '{' && code[j] !== ';') j += 1;
    if (code[j] !== '{') continue;
    funcs.push({ name: m[1], sigStart: m.index, bodyOpen: j, bodyClose: matchBrace(code, j) });
  }

  // init() bodies (the class has one designated initializer, `private override init()`)
  const inits: Fn[] = [];
  const initRe = /\binit\s*\(\s*\)\s*\{/g;
  for (let m = initRe.exec(code); m; m = initRe.exec(code)) {
    const open = m.index + m[0].length - 1;
    inits.push({ name: 'init', sigStart: m.index, bodyOpen: open, bodyClose: matchBrace(code, open) });
  }

  // ---- dbQueue.sync/async closure ranges
  const guardedRanges: Array<[number, number, 'sync' | 'async']> = [];
  const gqRe = /\bdbQueue\s*\.\s*(sync|async)\b/g;
  for (let m = gqRe.exec(code); m; m = gqRe.exec(code)) {
    const open = code.indexOf('{', m.index + m[0].length);
    if (open < 0) continue;
    guardedRanges.push([open, matchBrace(code, open), m[1] as 'sync' | 'async']);
  }
  const isGuarded = (pos: number) => guardedRanges.some(([a, b]) => a < pos && pos < b);

  const declMatch = /private var db\s*:/.exec(code);
  if (!declMatch) throw new Error('`private var db` declaration not found — audit needs updating');
  const declDbPos = declMatch.index + 'private var '.length;

  // ---- references to the `db` property
  const shadowing = funcs.filter((f) => /\(\s*db\s*:\s*OpaquePointer/.test(code.slice(f.sigStart, f.bodyOpen)));
  const refs: number[] = [];
  const refRe = /(?<![\w.])(?:self\.)?db\b(?!\w)/g;
  for (let m = refRe.exec(code); m; m = refRe.exec(code)) {
    const pos = m.index + (m[0].startsWith('self.') ? 5 : 0);
    if (pos === declDbPos) continue;
    if (/^db\s*:\s*OpaquePointer/.test(code.slice(pos, pos + 30))) continue; // parameter declaration
    if (shadowing.some((f) => f.bodyOpen < pos && pos < f.bodyClose)) continue; // shadowed param
    refs.push(pos);
  }

  const innermost = (pos: number, list: Fn[]) =>
    list
      .filter((f) => f.bodyOpen < pos && pos < f.bodyClose)
      .sort((a, b) => b.bodyOpen - a.bodyOpen)[0];
  const label = (f: Fn | undefined, pos: number) => (f ? `${f.name}@${lineOf(f.sigStart)}` : `<top-level>@${lineOf(pos)}`);

  const perFn = new Map<string, boolean[]>();
  for (const pos of refs) {
    const key = label(innermost(pos, funcs) ?? innermost(pos, inits), pos);
    const arr = perFn.get(key) ?? [];
    arr.push(isGuarded(pos));
    perFn.set(key, arr);
  }

  const touchingDb = [...perFn.keys()].sort();
  const requires = touchingDb.filter((k) => perFn.get(k)!.some((g) => !g));
  const guarded = touchingDb.filter((k) => !requires.includes(k));

  const violations: string[] = [];
  for (const k of requires) {
    if (k.startsWith('<top-level>')) violations.push(`db touched outside any function, off dbQueue: ${k}`);
    if (k.startsWith('init@')) violations.push(`db touched directly in init(), off dbQueue: ${k}`);
  }

  // ---- call sites of REQUIRES functions must be on dbQueue (or in another REQUIRES fn)
  const reqNames = new Set(requires.filter((k) => !k.startsWith('<') && !k.startsWith('init@')).map((k) => k.split('@')[0]));
  for (const name of [...reqNames].sort()) {
    const callRe = new RegExp(`(?<![\\w.])(?:self\\.)?${name}\\s*\\(`, 'g');
    for (let m = callRe.exec(code); m; m = callRe.exec(code)) {
      if (/func\s+$/.test(code.slice(Math.max(0, m.index - 6), m.index))) continue; // the declaration
      if (isGuarded(m.index)) continue;
      const enclosing = innermost(m.index, funcs);
      if (enclosing && reqNames.has(enclosing.name)) continue;
      violations.push(`${name}() called at line ${lineOf(m.index)} off dbQueue (and not from a dbQueue-only function)`);
    }
  }

  // ---- openDatabase(): exactly one call site, a dbQueue.async directly inside init()
  const openLines: number[] = [];
  let fromInit = false;
  const openRe = /\bopenDatabase\s*\(/g;
  for (let m = openRe.exec(code); m; m = openRe.exec(code)) {
    if (/func\s+$/.test(code.slice(Math.max(0, m.index - 6), m.index))) continue;
    openLines.push(lineOf(m.index));
    const init = innermost(m.index, inits);
    // innermost dbQueue closure containing the call
    const closure = guardedRanges
      .filter(([a, b]) => a < m!.index && m!.index < b)
      .sort((x, y) => y[0] - x[0])[0];
    const directInInit = !!init && !!closure && closure[2] === 'async' && init.bodyOpen < closure[0] && closure[1] < init.bodyClose;
    // The `dbQueue.async` token must not itself sit inside another `{ ... }` opened in init()
    // (a hop through a second queue/closure makes the enqueue racy).
    let hopFree = false;
    if (directInInit && init && closure) {
      let depth = 0;
      for (let k = init.bodyOpen + 1; k < closure[0]; k += 1) {
        if (code[k] === '{') depth += 1;
        else if (code[k] === '}') depth -= 1;
      }
      hopFree = depth === 0;
    }
    if (directInInit && hopFree) fromInit = true;
    else violations.push(`openDatabase() call at line ${lineOf(m.index)} is not a direct dbQueue.async in init()`);
  }
  if (openLines.length !== 1) violations.push(`expected exactly 1 openDatabase() call site, found ${openLines.length}`);

  return {
    functionsParsed: funcs.length,
    touchingDb,
    guarded,
    requires,
    openDatabaseCallLines: openLines,
    openDatabaseEnqueuedFromInit: fromInit && openLines.length === 1,
    violations,
  };
}
