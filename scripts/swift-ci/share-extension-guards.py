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
              (privacy ruling, task 1671 round 2). Two checks, per tree:
              (a) ShareViewController.swift has no JSONEncoder / Codable /
              `struct RecentFolder`, and the on-disk type in
              ShareRecentFolders.swift (StoredEntry) has no `name` field;
              (b) PERSISTENCE WRITES, in EVERY *.swift file of BOTH trees
              (comments and string literals stripped first): any
              UserDefaults write (`.set(`, `.setValue(` other than URLRequest header sets, `.setObject(`,
              `.register(defaults`, `.setPersistentDomain(`), `@AppStorage`,
              `NSUbiquitousKeyValueStore`, `.write(to:` / `.write(toFile:` /
              `.write(contentsOf:`, `createFile(`, `copyItem(` / `moveItem(` /
              `replaceItemAt(`, `FileHandle(forWriting...)`, `OutputStream(`,
              `NSKeyedArchiver`, `JSONEncoder`, `PropertyListEncoder`,
              Keychain `SecItemAdd` / `SecItemUpdate`, `NSPersistentContainer`,
              `sqlite3_`. Every hit must equal (file, whitespace-normalised code
              line) of an entry in PERSIST_ALLOW, with exactly the listed
              count per tree; anything else fails with file:line, so a new write
              has to be reviewed and allow-listed here. An allow-list entry that
              is not found (or found a different number of times) also fails, so
              the scan can never pass vacuously. NOT checked: deletions
              (`removeObject`, `removeItem`, `SecItemDelete`: they cannot
              persist a name), reads, in-memory encoders that are not on the
              list above (e.g. JSONSerialization for an HTTP body), and whether
              an allow-listed call site is fed a name (that is the reviewer's
              job when the entry is added; the allow-listed sites take ids only).

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


# Persistence-write detection (guard "recents", check b). Regexes run on
# comment- and string-stripped code, one line at a time.
PERSIST_PATTERNS = [
    (r"\.set\(", "UserDefaults .set("),
    (r"\.setValue\((?![^\n]*forHTTPHeaderField)|\.setObject\(|\.setPersistentDomain\(|\.register\(\s*defaults", "UserDefaults setValue/setObject/register"),
    (r"@AppStorage\b|\bNSUbiquitousKeyValueStore\b", "AppStorage / iCloud key-value store"),
    (r"\.write\(\s*(to|toFile|contentsOf)\s*:", "file/Data .write(to:)"),
    (r"\.createFile\(|\.copyItem\(|\.moveItem\(|\.replaceItemAt\(", "FileManager create/copy/move"),
    (r"\bFileHandle\s*\(\s*forWriting|\bFileHandle\s*\(\s*forUpdating|\bOutputStream\s*\(", "FileHandle/OutputStream for writing"),
    (r"\bNSKeyedArchiver\b|\bJSONEncoder\b|\bPropertyListEncoder\b", "NSKeyedArchiver/JSONEncoder/PropertyListEncoder"),
    (r"\bSecItemAdd\b|\bSecItemUpdate\b", "Keychain SecItemAdd/SecItemUpdate"),
    (r"\bNSPersistentContainer\b|\bsqlite3_\w+", "CoreData / sqlite"),
]

# (file basename, normalised code line) -> expected count PER TREE. Each entry
# is a reviewed write that cannot carry a folder name. Add a line here only
# after checking what feeds it.
PERSIST_ALLOW = {
    # ids-only recents store (ShareRecentFolders.encode / scrubbedPayload)
    ("ShareViewController.swift", "defaults?.set(scrubbed, forKey: Self.recentFoldersKey)"): 1,
    ("ShareViewController.swift", "defaults?.set(encoded, forKey: Self.recentFoldersKey)"): 1,
    ("ShareRecentFolders.swift", "return try? JSONEncoder().encode(entries)"): 1,
    # Keychain string store (session token, api base url, key owner): no names
    ("BeebeebKeychainCore.swift", "let status = SecItemAdd(attrs as CFDictionary, nil)"): 1,
    # stages the shared item into the extension's temp dir under share-<UUID>
    ("ShareViewController.swift", "try FileManager.default.copyItem(at: url, to: stableURL)"): 1,
}


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


def guard_persistence(root, log):
    """Check (b) of `recents`: every persistence write is on PERSIST_ALLOW."""
    ok = True
    scanned = 0
    seen_total = 0
    for d in (IOS, TGT):
        found = {}
        for f in swift_files(root, d):
            scanned += 1
            path = os.path.join(d, f)
            code = strip_swift(read(root, path))
            for lineno, line in enumerate(code.split("\n"), 1):
                for rx, what in PERSIST_PATTERNS:
                    if re.search(rx, line):
                        norm = " ".join(line.split())
                        key = (f, norm)
                        seen_total += 1
                        if key in PERSIST_ALLOW:
                            found[key] = found.get(key, 0) + 1
                            if found[key] > PERSIST_ALLOW[key]:
                                log(f"PERSISTENCE WRITE ({what}) at {path}:{lineno}: {norm}  -- more occurrences than the allow-list permits ({PERSIST_ALLOW[key]}); review it and raise the count in PERSIST_ALLOW")
                                ok = False
                        else:
                            log(f"PERSISTENCE WRITE ({what}) at {path}:{lineno}: {norm}  -- not allow-listed; review that it cannot persist a folder name, then add it to PERSIST_ALLOW")
                            ok = False
                        break
        for key, want in sorted(PERSIST_ALLOW.items()):
            got = found.get(key, 0)
            if got < want:
                log(f"PERSISTENCE ALLOW-LIST STALE: {d}/{key[0]}: expected {want} x `{key[1]}`, found {got}; remove or update the PERSIST_ALLOW entry")
                ok = False
    log(f"persistence: {scanned} swift files scanned, {seen_total} write site(s) seen, {'ok' if ok else 'VIOLATION'}")
    return ok


def guard_recents(root, log):
    ok = guard_persistence(root, log)
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
    FF = "FolderFetcher.swift"
    KC = "BeebeebKeychainCore.swift"
    PW = "PERSISTENCE WRITE"
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
        ("persistence: defaults?.set(recentFolders.map { $0.name }, ...) in the view controller",
         lambda r: both(r, VC, append_line('defaults?.set(recentFolders.map { $0.name }, forKey: "beebeeb_share_recent_names")')), PW),
        ("persistence: UserDefaults cache of folder names in FolderFetcher.swift",
         lambda r: both(r, FF, append_line('UserDefaults(suiteName: "group.io.beebeeb")?.set(folders.map { $0.name }, forKey: "cache")')), PW + " (UserDefaults .set(" + ") at ios/BeebeebShare/" + FF),
        ("persistence: Data.write(to:) in ShareUploader.swift",
         lambda r: both(r, UP, append_line("try? namesData.write(to: cacheURL)")), PW + " (file/Data .write(to:))"),
        ("persistence: NSKeyedArchiver in FolderFetcher.swift",
         lambda r: both(r, FF, append_line("let d = NSKeyedArchiver.archivedData(withRootObject: names, requiringSecureCoding: true)")), "NSKeyedArchiver/JSONEncoder/PropertyListEncoder"),
        ("persistence: a second copy of an allow-listed line (count exceeded)",
         lambda r: both(r, VC, append_line("defaults?.set(encoded, forKey: Self.recentFoldersKey)")), "more occurrences than the allow-list permits"),
        ("persistence: same call on a different key is not the allow-listed line",
         lambda r: both(r, VC, lambda s: s.replace("defaults?.set(encoded, forKey: Self.recentFoldersKey)", "defaults?.set(encoded, forKey: Self.otherKey)", 1)), PW),
        ("persistence: allow-listed write removed (stale allow-list, scan is not vacuous)",
         lambda r: both(r, RF, lambda s: s.replace("return try? JSONEncoder().encode(entries)", "return nil", 1)), "PERSISTENCE ALLOW-LIST STALE"),
        ("persistence: allow-listed Keychain write removed from the ios/ copy only",
         lambda r: edit(r, os.path.join(IOS, KC), lambda s: s.replace("SecItemAdd(attrs as CFDictionary, nil)", "errSecSuccess", 1)), "PERSISTENCE ALLOW-LIST STALE"),
    ]
    green_controls = [
        ("control: a COMMENT mentioning statusCode == 200 is not a violation",
         lambda r: both(r, UP, append_line("// never write statusCode == 200 here; case 200 is banned too")), ),
        ("control: a string mentioning statusCode > 199 is not a violation",
         lambda r: both(r, UP, append_line('let s = "statusCode > 199 \\(statusCode)"')), ),
        ("control: a COMMENT and a string mentioning UserDefaults .set( and JSONEncoder are not writes",
         lambda r: both(r, VC, append_line('// defaults?.set(names, forKey: "x") and JSONEncoder are banned\nlet s = "try? d.write(to: u) NSKeyedArchiver"')), ),
        ("control: deletions (removeObject / removeItem / SecItemDelete) and URLRequest.setValue are not writes",
         lambda r: both(r, FF, append_line('defaults?.removeObject(forKey: "k")\ntry? FileManager.default.removeItem(at: u)\nSecItemDelete(q as CFDictionary)\nrequest.setValue(t, forHTTPHeaderField: "H")')), ),
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
