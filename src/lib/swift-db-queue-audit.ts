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
 * What "inside a dbQueue closure" means (round 2): the EXECUTION CONTEXT of a
 * position is the innermost enclosing closure that changes it — a
 * `dbQueue.sync/async { }` (on dbQueue) or a HOP (`Task { }`, `Task.detached { }`,
 * `<other>.async/.sync/.asyncAfter { }`, `group.addTask { }`, `addOperation { }`),
 * which is NOT on dbQueue even when it is lexically nested inside a dbQueue
 * closure. A call to a REQUIRES function counts whatever its receiver is
 * (`foo()`, `self.foo()`, `self?.foo()`, `self!.foo()`, `engine.foo()`), and a
 * direct `db` read inside a hop is itself a violation.
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
  /** round 2: how many REQUIRES-function call sites were examined (any receiver) */
  callSitesChecked: number;
  /** round 2: how many of those sat on dbQueue directly / in another REQUIRES function */
  callSitesOnDbQueue: number;
  /** round 2: closures classified as on-dbQueue / as off-queue hops */
  dbQueueClosures: number;
  hopClosures: number;
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

  // ---- execution-context closures: dbQueue.sync/async (ON the queue) and hops (OFF it)
  type Ctx = { open: number; close: number; kind: 'dbQueue' | 'hop'; what: string };
  const ctxs: Ctx[] = [];
  const hopStmtStart = (pos: number) => {
    let k = pos - 1;
    while (k >= 0 && !';{}'.includes(code[k]) && pos - k < 400) k -= 1;
    return k + 1;
  };
  for (let open = code.indexOf('{'); open >= 0; open = code.indexOf('{', open + 1)) {
    const pre = code.slice(hopStmtStart(open), open).trim();
    let what: string | null = null;
    let kind: Ctx['kind'] = 'hop';
    const task = /(?:^|[^\w.])(Task\s*(?:<[^{}>]*>)?\s*(?:\.\s*detached\s*)?)(?:\([^{}]*\)\s*)?$/.exec(pre);
    const add = /\.\s*(addTask|addTaskUnlessCancelled|addOperation)\s*(?:\([^{}]*\)\s*)?$/.exec(pre);
    // `.sync { }` / `.sync(flags: ...) { }` (trailing closure) and `.sync(execute: { })` (labelled,
    // the paren is still open when the closure starts).
    const q = /^([\s\S]*?)\.\s*(async|asyncAfter|sync|asyncAndWait)\s*(?:\([^{}]*\)\s*|\([^(){}]*)?$/.exec(pre);
    if (task) what = task[1].replace(/\s+/g, '');
    else if (add) what = add[1];
    else if (q) {
      const receiver = q[1].trim();
      if (/(?:^|[^\w])dbQueue$/.test(receiver) && q[2] !== 'asyncAfter') kind = 'dbQueue';
      what = `${receiver.split(/\s+/).pop()}.${q[2]}`;
    }
    if (what === null) continue;
    ctxs.push({ open, close: matchBrace(code, open), kind, what });
  }
  const guardedRanges: Array<[number, number, 'sync' | 'async']> = ctxs
    .filter((c) => c.kind === 'dbQueue')
    .map((c) => [c.open, c.close, (/\.sync$/.test(c.what) ? 'sync' : 'async') as 'sync' | 'async']);
  /** innermost context-changing closure enclosing `pos` (undefined: plain function/method context) */
  const ctxAt = (pos: number) =>
    ctxs.filter((c) => c.open < pos && pos < c.close).sort((x, y) => y.open - x.open)[0];
  /** on dbQueue: the innermost context-changing closure is a dbQueue one (a hop in between => off) */
  const isGuarded = (pos: number) => ctxAt(pos)?.kind === 'dbQueue';
  const hopAt = (pos: number, lowerBound: number) => {
    const c = ctxAt(pos);
    return c && c.kind === 'hop' && c.open > lowerBound ? c : undefined;
  };

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
  for (const pos of refs) {
    const hop = hopAt(pos, -1);
    if (hop) violations.push(`db touched at line ${lineOf(pos)} inside a ${hop.what} hop (not on dbQueue)`);
  }
  for (const k of requires) {
    if (k.startsWith('<top-level>')) violations.push(`db touched outside any function, off dbQueue: ${k}`);
    if (k.startsWith('init@')) violations.push(`db touched directly in init(), off dbQueue: ${k}`);
  }

  // ---- call sites of REQUIRES functions must be on dbQueue (or in another REQUIRES fn)
  // Any receiver counts: `f(`, `self.f(`, `self?.f(`, `self!.f(`, `engine.f(`. A call inside a hop
  // closure (Task, other queue, ...) is off dbQueue even when that hop sits inside a dbQueue
  // closure or inside a REQUIRES function.
  let callSitesChecked = 0;
  let callSitesOnDbQueue = 0;
  const reqNames = new Set(requires.filter((k) => !k.startsWith('<') && !k.startsWith('init@')).map((k) => k.split('@')[0]));
  for (const name of [...reqNames].sort()) {
    const callRe = new RegExp(`(?<![\\w])${name}\\s*\\(`, 'g');
    for (let m = callRe.exec(code); m; m = callRe.exec(code)) {
      if (/func\s+$/.test(code.slice(Math.max(0, m.index - 6), m.index))) continue; // the declaration
      callSitesChecked += 1;
      const enclosing = innermost(m.index, funcs);
      const hop = hopAt(m.index, enclosing ? enclosing.bodyOpen : -1);
      if (hop) {
        violations.push(`${name}() called at line ${lineOf(m.index)} inside a ${hop.what} hop (off dbQueue)`);
        continue;
      }
      if (isGuarded(m.index) || (enclosing && reqNames.has(enclosing.name))) {
        callSitesOnDbQueue += 1;
        continue;
      }
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
    callSitesChecked,
    callSitesOnDbQueue,
    dbQueueClosures: ctxs.filter((c) => c.kind === 'dbQueue').length,
    hopClosures: ctxs.filter((c) => c.kind === 'hop').length,
  };
}
