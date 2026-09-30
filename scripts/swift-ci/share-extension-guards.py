#!/usr/bin/env python3
"""Task 1671 — static guards for the iOS Share Extension sources.

Pure text checks (no Swift toolchain needed), so they also run on Linux, and
`--self-test` proves each one can go RED by mutating a throwaway copy.

Guards (run over BOTH trees: ios/BeebeebShare/ and targets/share-extension/):

  sync        The two trees hold the same set of *.swift files, byte-identical.
              Reports files only in ios/BeebeebShare/, files only in
              targets/share-extension/ (the source of truth: a file there that
              the copy lacks is not built), and drifted files.

  wiring      ShareUploader.swift decides every upload step's success through
              ShareUploadRequestPolicy.isSuccessResponse (init returns 201,
              chunk/complete return 200 — the 1671 "Upload failed (HTTP 201)"
              bug was a hardcoded `== 200`). Counted on CODE ONLY: comments and
              string literals are stripped first, so a comment or log string
              mentioning the function does not count as a call. Also fails on
              any hardcoded status test: `statusCode == 200`, `200 == statusCode`,
              `statusCode > 199`, `switch statusCode { case 200 ...`,
              `case 200`, `200...299 ~= statusCode`, `(200..<300).contains(...)`.

  recents     The Share Extension must never persist a folder NAME
              (privacy ruling, task 1671 round 2): ShareViewController.swift has
              no JSONEncoder / Codable / `struct RecentFolder`, and the on-disk
              type in ShareRecentFolders.swift (StoredEntry) has no `name` field.

Truth line: `SHARE GUARDS: PASS ...` / `SHARE GUARDS: FAIL`. Exit 0 only on PASS.
`--self-test` prints `share-guards self-test: N mutations, N went red, 0 stayed green`.
"""
import os
import re
import shutil
import sys
import tempfile

REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
IOS = os.path.join("ios", "BeebeebShare")
TGT = os.path.join("targets", "share-extension")
MIN_SYNC_FILES = 5
MIN_SUCCESS_CALLS = 3


def strip_swift(src):
    """Blank out comments and string literals, keeping newlines (so line
    numbers survive). Handles //, nested /* */, "..." with escapes and
    interpolation, and multi-line \"\"\" \"\"\"."""
    out = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        two = src[i:i + 2]
        if two == "//":
            while i < n and src[i] != "\n":
                i += 1
        elif two == "/*":
            depth = 1
            i += 2
            while i < n and depth:
                if src[i:i + 2] == "/*":
                    depth += 1
                    i += 2
                elif src[i:i + 2] == "*/":
                    depth -= 1
                    i += 2
                else:
                    if src[i] == "\n":
                        out.append("\n")
                    i += 1
            out.append(" ")
        elif src[i:i + 3] == '"""':
            i += 3
            while i < n and src[i:i + 3] != '"""':
                if src[i] == "\\":
                    i += 1
                if i < n and src[i] == "\n":
                    out.append("\n")
                i += 1
            i += 3
            out.append('""')
        elif c == '"':
            i += 1
            depth = 0  # interpolation paren depth
            while i < n:
                ch = src[i]
                if ch == "\\":
                    if src[i + 1:i + 2] == "(":
                        depth += 1
                        i += 2
                        continue
                    i += 2
                    continue
                if depth:
                    if ch == "(":
                        depth += 1
                    elif ch == ")":
                        depth -= 1
                    i += 1
                    continue
                if ch == '"' or ch == "\n":
                    break
                i += 1
            i += 1
            out.append('""')
        else:
            out.append(c)
            i += 1
    return "".join(out)


HARDCODED = [
    (r"\bstatusCode\s*(==|!=|>=|<=|>|<)\s*-?\d+", "statusCode <op> <number>"),
    (r"-?\d+\s*(==|!=|>=|<=|>|<)\s*[\w.?!]*statusCode\b", "<number> <op> statusCode"),
    (r"\bswitch\b[^{\n]*\bstatusCode\b", "switch on statusCode"),
    (r"\bcase\s+-?\d", "numeric case label"),
    (r"\bstatusCode\s*~=|~=\s*[\w.?!]*statusCode\b", "range ~= statusCode"),
    (r"\.contains\(\s*[\w.?!]*statusCode\b", "range.contains(statusCode)"),
    (r"\b\d{3}\s*(\.\.\.|\.\.<)\s*\d{3}", "numeric HTTP range literal"),
]


def read(root, *parts):
    with open(os.path.join(root, *parts), encoding="utf-8") as f:
        return f.read()


def swift_files(root, d):
    p = os.path.join(root, d)
    return sorted(f for f in os.listdir(p) if f.endswith(".swift")) if os.path.isdir(p) else []


def guard_sync(root, log):
    ios, tgt = swift_files(root, IOS), swift_files(root, TGT)
    ok = True
    only_ios = [f for f in ios if f not in tgt]
    only_tgt = [f for f in tgt if f not in ios]
    drifted = []
    for f in ios:
        if f in tgt:
            a = open(os.path.join(root, IOS, f), "rb").read()
            b = open(os.path.join(root, TGT, f), "rb").read()  # follows symlinks
            if a != b:
                drifted.append(f)
    for f in only_ios:
        log(f"ONLY IN ios/BeebeebShare/: {f} (no targets/share-extension/ original; expo prebuild would delete it)")
    for f in only_tgt:
        log(f"ONLY IN targets/share-extension/: {f} (not copied to ios/BeebeebShare/; check the plugin's SOURCE_FILES and run expo prebuild)")
    for f in drifted:
        log(f"DRIFT: {IOS}/{f} differs from {TGT}/{f}")
    compared = len([f for f in ios if f in tgt])
    log(f"sync: {compared} files compared, {len(drifted)} drifted, {len(only_ios)} only in ios/, {len(only_tgt)} only in targets/")
    if only_ios or only_tgt or drifted:
        ok = False
    if compared < MIN_SYNC_FILES:
        log(f"sync compared only {compared} files (< {MIN_SYNC_FILES}); refusing a vacuous pass")
        ok = False
    return ok


def guard_wiring(root, log):
    ok = True
    for d in (IOS, TGT):
        path = os.path.join(d, "ShareUploader.swift")
        code = strip_swift(read(root, path))
        calls = len(re.findall(r"\bShareUploadRequestPolicy\s*\.\s*isSuccessResponse\s*\(", code))
        hits = []
        for lineno, line in enumerate(code.split("\n"), 1):
            for rx, what in HARDCODED:
                if re.search(rx, line):
                    hits.append((lineno, what, line.strip()))
        for lineno, what, line in hits:
            log(f"HARDCODED STATUS TEST ({what}) at {path}:{lineno}: {line}  -- use ShareUploadRequestPolicy.isSuccessResponse")
        if calls < MIN_SUCCESS_CALLS:
            log(f"{path}: {calls} isSuccessResponse call expression(s) outside comments/strings; expected >= {MIN_SUCCESS_CALLS} (init, chunk, complete)")
            ok = False
        if hits:
            ok = False
        log(f"wiring [{d}]: {calls} isSuccessResponse call(s), {len(hits)} hardcoded status test(s)")
    return ok


def guard_recents(root, log):
    ok = True
    for d in (IOS, TGT):
        vc_path = os.path.join(d, "ShareViewController.swift")
        vc = strip_swift(read(root, vc_path))
        for rx, what in [(r"\bJSONEncoder\b", "JSONEncoder"), (r"\bCodable\b|\bEncodable\b", "Codable/Encodable"),
                         (r"\bstruct\s+RecentFolder\b", "struct RecentFolder")]:
            for m in re.finditer(rx, vc):
                line = vc.count("\n", 0, m.start()) + 1
                log(f"RECENTS PERSISTENCE: {vc_path}:{line} uses {what}; the view controller must persist recents only through ShareRecentFolders (ids only, never a name)")
                ok = False
        rf_path = os.path.join(d, "ShareRecentFolders.swift")
        if not os.path.exists(os.path.join(root, rf_path)):
            log(f"missing {rf_path}")
            ok = False
            continue
        rf = strip_swift(read(root, rf_path))
        m = re.search(r"struct\s+StoredEntry\b[^{]*\{(.*?)\n    \}", rf, re.S)
        if not m:
            log(f"{rf_path}: cannot find `struct StoredEntry` (the on-disk type); refusing a vacuous pass")
            ok = False
        elif re.search(r"\bname", m.group(1), re.I):
            log(f"RECENTS PERSISTENCE: {rf_path}: StoredEntry has a name-like field; the store must be ids only")
            ok = False
    log(f"recents-persistence: 2 trees checked, {'ok' if ok else 'VIOLATION'}")
    return ok


def run_guards(root, out):
    lines = []

    def log(msg):
        lines.append(msg)
        out(msg)

    results = [guard_sync(root, log), guard_wiring(root, log), guard_recents(root, log)]
    passed = all(results)
    out("SHARE GUARDS: PASS (sync, wiring, recents-persistence)" if passed else "SHARE GUARDS: FAIL")
    return passed, lines


# ----------------------------------------------------------------------------
# self-test: every mutation must turn the guard RED, with the RIGHT message.

def make_root():
    tmp = tempfile.mkdtemp(prefix="share-guards-")
    for d in (IOS, TGT):
        os.makedirs(os.path.join(tmp, d))
        for f in swift_files(REPO, d):
            shutil.copyfile(os.path.join(REPO, d, f), os.path.join(tmp, d, f))  # follows symlinks
    return tmp


def edit(root, rel, fn):
    p = os.path.join(root, rel)
    s = open(p, encoding="utf-8").read()
    t = fn(s)
    assert t != s, f"mutation did not change {rel}"
    open(p, "w", encoding="utf-8").write(t)


def both(root, name, fn):
    for d in (IOS, TGT):
        edit(root, os.path.join(d, name), fn)


def append_line(line):
    return lambda s: s + "\n" + line + "\n"


CALL = "ShareUploadRequestPolicy.isSuccessResponse(statusCode: statusCode)"


def replace_last_call(s):
    i = s.rindex(CALL)
    return s[:i] + "true /* " + CALL + " */" + s[i + len(CALL):]


def self_test():
    # (label, mutate(root), substring the RED output must contain)
    UP = "ShareUploader.swift"
    VC = "ShareViewController.swift"
    RF = "ShareRecentFolders.swift"
    cases = [
        ("wiring: 3rd call replaced by a COMMENT mentioning it (was counted before)",
         lambda r: both(r, UP, replace_last_call), "expected >= 3"),
        ("wiring: call only inside a string literal",
         lambda r: both(r, UP, lambda s: s.replace(CALL, 'true || String("' + CALL + '").isEmpty', 1)), "expected >= 3"),
        ("wiring: statusCode == 200",
         lambda r: both(r, UP, append_line("let a = statusCode == 200")), "statusCode <op> <number>"),
        ("wiring: 200 == statusCode",
         lambda r: both(r, UP, append_line("let a = 200 == statusCode")), "<number> <op> statusCode"),
        ("wiring: statusCode > 199",
         lambda r: both(r, UP, append_line("let a = statusCode > 199")), "statusCode <op> <number>"),
        ("wiring: switch statusCode { case 200",
         lambda r: both(r, UP, append_line("func f(_ statusCode: Int) { switch statusCode {\ncase 200: break\ndefault: break } }")), "switch on statusCode"),
        ("wiring: case 200 label alone",
         lambda r: both(r, UP, append_line("func f(_ x: Int) { switch x {\ncase 201: break\ndefault: break } }")), "numeric case label"),
        ("wiring: 200...299 ~= statusCode",
         lambda r: both(r, UP, append_line("let a = 200...299 ~= statusCode")), "range ~= statusCode"),
        ("wiring: (200..<300).contains(statusCode)",
         lambda r: both(r, UP, append_line("let a = (200..<300).contains(statusCode)")), "range.contains(statusCode)"),
        ("wiring: hardcode in only the ios/ copy",
         lambda r: edit(r, os.path.join(IOS, UP), append_line("let a = statusCode == 200")), "HARDCODED STATUS TEST"),
        ("sync: file only in targets/share-extension/",
         lambda r: open(os.path.join(r, TGT, "Extra.swift"), "w").write("import Foundation\n"), "ONLY IN targets/share-extension/: Extra.swift"),
        ("sync: file only in ios/BeebeebShare/",
         lambda r: open(os.path.join(r, IOS, "Orphan.swift"), "w").write("import Foundation\n"), "ONLY IN ios/BeebeebShare/: Orphan.swift"),
        ("sync: byte drift in the ios/ copy",
         lambda r: edit(r, os.path.join(IOS, VC), append_line("// drift")), "DRIFT:"),
        ("recents: JSONEncoder in the view controller",
         lambda r: both(r, VC, append_line("let e = JSONEncoder()")), "uses JSONEncoder"),
        ("recents: struct RecentFolder: Codable back in the view controller",
         lambda r: both(r, VC, append_line("struct RecentFolder: Codable { let id: String; let name: String }")), "struct RecentFolder"),
        ("recents: StoredEntry grows a name field",
         lambda r: both(r, RF, lambda s: s.replace("        let id: String\n    }", "        let id: String\n        let name: String\n    }", 1)), "StoredEntry has a name-like field"),
    ]
    green_controls = [
        ("control: a COMMENT mentioning statusCode == 200 is not a violation",
         lambda r: both(r, UP, append_line("// never write statusCode == 200 here; case 200 is banned too")), ),
        ("control: a string mentioning statusCode > 199 is not a violation",
         lambda r: both(r, UP, append_line('let s = "statusCode > 199 \\(statusCode)"')), ),
    ]

    base = make_root()
    try:
        passed, lines = run_guards(base, lambda m: None)
        if not passed:
            print("self-test precondition failed: the unmutated tree is not green:")
            print("\n".join(lines))
            return 1
    finally:
        shutil.rmtree(base, ignore_errors=True)

    red = 0
    bad = []
    for label, mutate, needle in cases:
        root = make_root()
        try:
            mutate(root)
            passed, lines = run_guards(root, lambda m: None)
            text = "\n".join(lines)
            if passed:
                bad.append(f"STAYED GREEN: {label}")
            elif needle not in text:
                bad.append(f"RED FOR THE WRONG REASON: {label} (wanted {needle!r})\n{text}")
            else:
                red += 1
                print(f"  red as required: {label}")
        finally:
            shutil.rmtree(root, ignore_errors=True)
    controls_ok = 0
    for label, mutate in green_controls:
        root = make_root()
        try:
            mutate(root)
            passed, lines = run_guards(root, lambda m: None)
            if passed:
                controls_ok += 1
                print(f"  green as required: {label}")
            else:
                bad.append(f"FALSE POSITIVE: {label}\n" + "\n".join(lines))
        finally:
            shutil.rmtree(root, ignore_errors=True)
    for b in bad:
        print(b)
    print(f"share-guards self-test: {len(cases)} mutations, {red} went red, {len(cases) - red} stayed green; "
          f"{len(green_controls)} controls, {controls_ok} stayed green")
    return 0 if (not bad and red == len(cases) and controls_ok == len(green_controls)) else 1


def main():
    if "--self-test" in sys.argv:
        return self_test()
    passed, _ = run_guards(REPO, print)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
