#!/usr/bin/env python3
"""Print the Swift sources the BeebeebShare target compiles, one repo-relative
path per line, read from ios/Beebeeb.xcodeproj/project.pbxproj (the "Sources"
build phase of the PBXNativeTarget named BeebeebShare).

Task 1671: CI typechecks the Share Extension with `swiftc -typecheck`; this
script is what makes that list "exactly as the target compiles them" instead
of a hand-kept copy that could drift from the project file.

Fails (exit 1, message on stderr) rather than printing a partial or empty
list: an empty list would make the typecheck vacuously green.
"""
import os
import re
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
PBX = os.path.join(ROOT, "ios", "Beebeeb.xcodeproj", "project.pbxproj")
TARGET = sys.argv[1] if len(sys.argv) > 1 else "BeebeebShare"


def die(msg):
    print(f"share-target-sources: {msg}", file=sys.stderr)
    sys.exit(1)


text = open(PBX, encoding="utf-8").read()

target = re.search(
    r"\t\t(\w{24}) /\* %s \*/ = \{\n\t\t\tisa = PBXNativeTarget;(.*?)\n\t\t\};" % re.escape(TARGET),
    text,
    re.S,
)
if not target:
    die(f"PBXNativeTarget {TARGET} not found")
phase = re.search(r"(\w{24}) /\* Sources \*/,", target.group(2))
if not phase:
    die(f"{TARGET} has no Sources build phase")

phase_block = re.search(
    r"\t\t%s /\* Sources \*/ = \{.*?files = \(\n(.*?)\n\t\t\t\);" % phase.group(1), text, re.S
)
if not phase_block:
    die("Sources build phase body not found")
build_ids = re.findall(r"(\w{24}) /\* .*? in Sources \*/", phase_block.group(1))
if not build_ids:
    die("Sources build phase lists no files")

paths = []
for bid in build_ids:
    bf = re.search(r"\t\t%s /\* .*? \*/ = \{isa = PBXBuildFile; fileRef = (\w{24}) " % bid, text)
    if not bf:
        die(f"PBXBuildFile {bid} not found")
    fr = re.search(r"\t\t%s /\* .*? \*/ = \{isa = PBXFileReference;[^\n]*" % bf.group(1), text)
    if not fr:
        die(f"PBXFileReference {bf.group(1)} not found")
    p = re.search(r'\bpath = ("[^"]*"|[^;]+);', fr.group(0))
    if not p:
        die(f"no path in {fr.group(0)[:120]}")
    rel = os.path.normpath(os.path.join("ios", p.group(1).strip('"')))
    if not rel.endswith(".swift"):
        die(f"non-Swift source in Sources phase: {rel}")
    if not os.path.isfile(os.path.join(ROOT, rel)):
        die(f"listed source does not exist: {rel}")
    paths.append(rel)

for p in paths:
    print(p)
