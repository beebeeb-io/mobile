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
 * What "inside a dbQueue closure" means (round 2, widened in round 3): the EXECUTION CONTEXT
 * of a position is the innermost enclosing closure that changes it — a
 * `dbQueue.sync/async { }` (on dbQueue) or a HOP, which is NOT on dbQueue even when it is
 * lexically nested inside a dbQueue closure. Round 3 inverts the default: ANY closure passed to a
 * call (trailing or as an argument), or stored (`x = { }`), is a hop unless the call is on a small
 * allow-list of APIs known to run the closure synchronously on the caller's queue
 * (`SYNC_CALLEES`: `map`/`filter`/`forEach`/..., `withUnsafe*`, `withLock`, `autoreleasepool`),
 * or it is `dbQueue.sync/async`. So `URLSession.getAllTasks { }`, `dataTask { }`,
 * `Timer.scheduledTimer { }`, `NotificationCenter.addObserver(forName:) { }`,
 * `DispatchWorkItem { }`, `Task { }`, `group.addTask { }`, `<other>.async { }` ... all leave
 * dbQueue. Plain blocks (`if`, `guard`, `for`, `do`, `func`, `init`, computed properties, type
 * bodies) and immediately-invoked `= { ... }()` initialisers run inline and are transparent.
 * A bare function REFERENCE passed as an argument (`DispatchQueue.main.async(execute: fn)`,
 * `DispatchWorkItem(block: fn)`, `#selector(fn)`) is a call site executed wherever that API runs
 * it, and a reference that is stored (`let f = fn`) is treated as escaping. A call to a REQUIRES
 * function counts whatever its receiver is (`foo()`, `self.foo()`, `self?.foo()`,
 * `self!.foo()`, `engine.foo()`), and a direct `db` read inside a hop is itself a violation.
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
  /** round 3: line + callee label of every closure classified as an off-queue hop (for review / tests) */
  hopSites: Array<{ line: number; what: string }>;
}

/** Blank comments and string literals (keeping newlines) so scanning sees code only. */
export function stripSwift(s: string): string {
  const out: string[] = [];
  const blank = (t: string) => t.replace(/[^\n]/g, ' ');
  // A string literal keeps its first and last character (the quotes) so a statement that ends in a
  // string still ends in a non-space, non-operator character for the statement-boundary scan.
  const quoted = (t: string) => (t.length >= 2 ? t[0] + blank(t.slice(1, -1)) + t[t.length - 1] : blank(t));
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
      out.push(quoted(s.slice(i, j)));
      i = j;
    } else if (s[i] === '"') {
      let j = i + 1;
      while (j < n && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      j += 1;
      out.push(quoted(s.slice(i, j)));
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

/**
 * Calls that run a closure argument SYNCHRONOUSLY on the caller's queue (so the closure body is in
 * the same execution context as the call). Everything NOT listed here (and not `dbQueue.sync/async`)
 * is treated as leaving dbQueue. Add to this list only for an API that is documented as inline.
 */
export const SYNC_CALLEES = new Set([
  'map', 'flatMap', 'compactMap', 'filter', 'forEach', 'reduce', 'sorted', 'sort', 'contains',
  'allSatisfy', 'first', 'last', 'firstIndex', 'lastIndex', 'min', 'max', 'count', 'removeAll',
  'mapValues', 'compactMapValues', 'prefix', 'drop', 'split',
  'enumerateObjects', 'enumerateKeysAndObjects',
  'withLock', 'autoreleasepool', 'withExtendedLifetime', 'withoutActuallyEscaping', 'withCString',
]);

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

  // brace pairs, one pass (strings/comments are already blanked)
  const closeOf = new Map<number, number>();
  const openOf = new Map<number, number>();
  {
    const stack: number[] = [];
    for (let k = 0; k < code.length; k += 1) {
      if (code[k] === '{') stack.push(k);
      else if (code[k] === '}') {
        const o = stack.pop();
        if (o === undefined) throw new Error('unbalanced braces in Swift source');
        closeOf.set(o, k);
        openOf.set(k, o);
      }
    }
  }

  /**
   * Scan backward from `from` over the statement that ends there. Returns the innermost UNCLOSED
   * `(` / `[` the position sits inside (an argument list), or, when there is none, the statement's
   * start. Matched `()` / `[]` groups and whole `{ }` blocks are skipped; a `;`, an unmatched `{`, a
   * `}` (end of the previous block) or a newline that does not visibly continue the statement ends it.
   * Inside an unclosed argument list newlines do not end anything, so the search keeps going.
   */
  const scanBack = (from: number): { paren?: number; start: number } => {
    let nest = 0;
    let k = from - 1;
    for (; k >= 0; k -= 1) {
      const ch = code[k];
      if (ch === ')' || ch === ']') nest += 1;
      else if (ch === '(' || ch === '[') {
        if (nest === 0) return { paren: k, start: k + 1 };
        nest -= 1;
      } else if (ch === '}') {
        const o = openOf.get(k);
        if (nest <= 0 || o === undefined) break;
        k = o;
      } else if (ch === '{') break;
      else if (ch === ';' && nest <= 0) break;
      else if (ch === '\n' && nest <= 0) {
        let p = k - 1;
        while (p >= 0 && /\s/.test(code[p])) p -= 1;
        let q = k + 1;
        while (q < from && /\s/.test(code[q])) q += 1;
        // a line ending in `?` is an optional TYPE (`var x: T?`) unless it is `??` or a ternary ` ?`
        const tail = code.slice(Math.max(0, p - 2), p + 1);
        const continues =
          /[,.(\[+*/%&|=\\]$/.test(tail) ||
          /(?:\?\?|\s\?)$/.test(tail) ||
          /^(?:\.|&&|\|\||\?|:|\+)/.test(code.slice(q, q + 2));
        if (!continues) break;
      }
    }
    return { start: k + 1 };
  };
  const enclosingOpenParen = (from: number): number | undefined => scanBack(from).paren;
  const stmtStartOf = (from: number): number => scanBack(from).start;

  /** Strip trailing balanced `( ... )` groups, generics and `?`/`!` from a callee expression. */
  const stripArgs = (text: string): string => {
    let t = text.trim();
    for (;;) {
      if (t.endsWith(')')) {
        let d = 0;
        let k = t.length - 1;
        for (; k >= 0; k -= 1) {
          if (t[k] === ')') d += 1;
          else if (t[k] === '(') {
            d -= 1;
            if (d === 0) break;
          }
        }
        if (k < 0) return t;
        t = t.slice(0, k).trim();
      } else if (t.endsWith('>')) {
        const m = /<[^<>]*>$/.exec(t);
        if (!m) return t;
        t = t.slice(0, m.index).trim();
      } else if (/[?!]$/.test(t)) t = t.slice(0, -1).trim();
      else return t;
    }
  };
  type Callee = { chain: string; name: string; receiver: string };
  const calleeOf = (text: string): Callee | null => {
    let t = stripArgs(text);
    const eq = /(?:^|[^=!<>])=(?!=)/g;
    let cut = -1;
    for (let m = eq.exec(t); m; m = eq.exec(t)) cut = m.index + m[0].length;
    if (cut >= 0) t = t.slice(cut).trim();
    t = t.replace(/^(?:(?:try[?!]?|await|return|throw|case\s+[^:]*:|default:)\s+)+/, '').trim();
    const chain = t.replace(/\s+/g, '');
    const nm = /([A-Za-z_$][\w$]*)$/.exec(chain);
    if (!nm) return null;
    const receiver = chain.slice(0, chain.length - nm[1].length).replace(/[.?!]+$/, '');
    return { chain: chain.slice(-70), name: nm[1], receiver };
  };
  const isDbQueueReceiver = (receiver: string) => /(?:^|[^\w])dbQueue$/.test(receiver);
  /** How a closure (or function reference) handed to `callee` executes relative to the caller. */
  const executionOf = (callee: Callee | null): { kind: 'dbQueue' | 'hop' | 'sync'; what: string } => {
    if (!callee) return { kind: 'hop', what: 'closure' };
    const { name, receiver, chain } = callee;
    if (/^(?:async|asyncAfter|sync|asyncAndWait)$/.test(name)) {
      if (isDbQueueReceiver(receiver) && name !== 'asyncAfter') return { kind: 'dbQueue', what: `${receiver.split(/\s+/).pop()}.${name}` };
      return { kind: 'hop', what: `${receiver.split(/\s+/).pop()}.${name}` };
    }
    if (SYNC_CALLEES.has(name) || /^withUnsafe/.test(name)) return { kind: 'sync', what: name };
    return { kind: 'hop', what: chain };
  };

  const MODIFIERS = '(?:@[\\w.]+(?:\\([^)]*\\))?\\s+|(?:private|fileprivate|public|internal|open|final|static|class|override|mutating|nonmutating|convenience|required|lazy|weak|unowned|indirect|dynamic|nonisolated|prefix|postfix|infix|optional)(?:\\([^)]*\\))?\\s+)*';
  const declRe = new RegExp(`^${MODIFIERS}(?:func|init|deinit|subscript|class|struct|enum|extension|protocol|actor|typealias|associatedtype|get|set|willSet|didSet|_read|_modify)\\b`);
  const controlRe = /^(?:(?:\w+\s*:\s*)?(?:if|guard|for|while|repeat|do|switch)\b|else\b|defer\b|catch\b)/;
  const hasTopLevelEquals = (t: string) => /(?:^|[^=!<>])=(?!=)/.test(stripNested(t));
  const stripNested = (t: string) => {
    let out = '';
    let d = 0;
    for (const ch of t) {
      if (ch === '(' || ch === '[') d += 1;
      else if (ch === ')' || ch === ']') d -= 1;
      else if (d === 0) out += ch;
    }
    return out;
  };

  type Classified = { kind: 'block' | 'sync' | 'dbQueue' | 'hop'; what: string };
  const classifyBrace = (open: number): Classified => {
    const paren = enclosingOpenParen(open);
    if (paren !== undefined) {
      // The brace sits inside an argument list. Text since the current argument began:
      //   empty / `label:`  -> the closure IS the argument: `foo(label: { })`, `x.sync(execute: { })`
      //   anything else     -> a trailing closure of a call nested in the argument: `foo(xs.filter { })`
      let argStart = paren + 1;
      {
        let nest = 0;
        for (let k = paren + 1; k < open; k += 1) {
          const ch = code[k];
          if (ch === '(' || ch === '[') nest += 1;
          else if (ch === ')' || ch === ']') nest -= 1;
          else if (ch === '{') {
            const c = closeOf.get(k);
            if (c !== undefined && c < open) k = c;
          } else if (ch === ',' && nest === 0) argStart = k + 1;
        }
      }
      const arg = code.slice(argStart, open).replace(/^\s*[A-Za-z_$][\w$]*\s*:/, '').trim();
      if (arg === '') {
        if (code[paren] === '[') return { kind: 'hop', what: 'closure-in-array' };
        return executionOf(calleeOf(code.slice(stmtStartOf(paren), paren)));
      }
      return executionOf(calleeOf(arg));
    }
    const stmt = code
      .slice(stmtStartOf(open), open)
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/^(?:(?:case\b[^:]*|default)\s*:\s*)+/, '');
    if (controlRe.test(stmt) || declRe.test(stmt)) return { kind: 'block', what: stmt };
    const isDecl = new RegExp(`^${MODIFIERS}(?:var|let)\\b`).test(stmt);
    if (isDecl && !hasTopLevelEquals(stmt)) return { kind: 'block', what: stmt }; // computed property
    if (stmt === '' || /(?:^|[^=!<>])=$/.test(stmt) || /^return$/.test(stmt)) {
      // a closure VALUE: immediately invoked `{ ... }()` runs inline; anything else is stored and runs later, anywhere
      const close = closeOf.get(open)!;
      return /^\s*\(/.test(code.slice(close + 1, close + 40)) && stmt !== 'return'
        ? { kind: 'sync', what: 'iife' }
        : { kind: 'hop', what: 'stored-closure' };
    }
    return executionOf(calleeOf(stmt));
  };

  for (const open of [...closeOf.keys()].sort((a, b) => a - b)) {
    const c = classifyBrace(open);
    if (c.kind === 'block' || c.kind === 'sync') continue;
    ctxs.push({ open, close: closeOf.get(open)!, kind: c.kind, what: c.what });
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
  // One pass over every mention of a REQUIRES function name. `name(` is a call; `name` followed by
  // `:` is an argument label; anything else is a bare function REFERENCE:
  // `DispatchQueue.main.async(execute: fn)`, `DispatchWorkItem(block: fn)`, `#selector(fn)`, `let f = fn`.
  // A reference is a call site executed wherever the receiving API runs it: dbQueue.sync/async => on
  // dbQueue; an allow-listed synchronous API => the caller's own context; anything else (another queue,
  // Timer, DispatchWorkItem, Task, ...) => off dbQueue; a stored reference escapes, so it is treated
  // the same (it may run anywhere).
  if (reqNames.size > 0) {
    const mentionRe = new RegExp(`(?<![\\w])(${[...reqNames].sort().join('|')})\\b(\\s*[(:])?`, 'g');
    for (let m = mentionRe.exec(code); m; m = mentionRe.exec(code)) {
      const name = m[1];
      const after = m[2]?.trim();
      if (/func\s+$/.test(code.slice(Math.max(0, m.index - 6), m.index))) continue; // the declaration
      if (after === ':') continue; // argument label
      callSitesChecked += 1;
      const enclosing = innermost(m.index, funcs);
      const hop = hopAt(m.index, enclosing ? enclosing.bodyOpen : -1);
      if (after === '(') {
        if (hop) {
          violations.push(`${name}() called at line ${lineOf(m.index)} inside a ${hop.what} hop (off dbQueue)`);
          continue;
        }
        if (isGuarded(m.index) || (enclosing && reqNames.has(enclosing.name))) {
          callSitesOnDbQueue += 1;
          continue;
        }
        violations.push(`${name}() called at line ${lineOf(m.index)} off dbQueue (and not from a dbQueue-only function)`);
        continue;
      }
      if (hop) {
        violations.push(`${name} referenced at line ${lineOf(m.index)} inside a ${hop.what} hop (off dbQueue)`);
        continue;
      }
      const paren = enclosingOpenParen(m.index);
      if (paren === undefined || code[paren] === '[') {
        violations.push(`${name} referenced at line ${lineOf(m.index)} without being called (stored, may run off dbQueue)`);
        continue;
      }
      const ex = executionOf(calleeOf(code.slice(stmtStartOf(paren), paren)));
      if (ex.kind === 'dbQueue' || (ex.kind === 'sync' && (isGuarded(m.index) || (enclosing && reqNames.has(enclosing.name))))) {
        callSitesOnDbQueue += 1;
        continue;
      }
      violations.push(`${name} referenced at line ${lineOf(m.index)} as an argument to ${ex.what} (off dbQueue)`);
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
    hopSites: ctxs.filter((c) => c.kind === 'hop').map((c) => ({ line: lineOf(c.open), what: c.what })),
  };
}
