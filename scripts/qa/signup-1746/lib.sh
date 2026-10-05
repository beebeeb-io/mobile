#!/usr/bin/env bash
# Required environment (no personal paths live in this repo):
#   BB_WORKSPACE  the beebeeb.io workspace root (for scripts/coord/with-lock.sh)
#   BB_QA_UDID    the UDID of the simulator YOU created for this run
#   BB_QA_EVIDENCE  where screenshots go (a directory outside this repo, or the task evidence dir)
# Everything that can contain the recovery phrase (hierarchy dumps, word and answer files,
# generated flows) goes to a mktemp directory that is removed when the shell exits.
: "${BB_WORKSPACE:?set BB_WORKSPACE to the beebeeb.io workspace root}"
: "${BB_QA_UDID:?set BB_QA_UDID to the simulator UDID}"
: "${BB_QA_EVIDENCE:?set BB_QA_EVIDENCE to the screenshot directory}"
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
UDID=$BB_QA_UDID
L=$BB_WORKSPACE/scripts/coord/with-lock.sh
E=$BB_QA_EVIDENCE
if [ -z "${FL:-}" ]; then
  FL=$(mktemp -d)
  export FL
  trap 'rm -rf "$FL"' EXIT
fi
mae() { env -u NODE_OPTIONS $L maestro -- maestro --udid $UDID "$@" 2>&1 | /usr/bin/grep -v "WARNING"; }
openurl_tap() { xcrun simctl openurl $UDID "$1"; sleep 2; cat > $FL/tapopen.yaml <<Y
appId: io.beebeeb.app
---
- tapOn:
    text: "Open"
    optional: true
- waitForAnimationToEnd
Y
 mae test $FL/tapopen.yaml | tail -2; sleep 3; }
hier() { env -u NODE_OPTIONS $L maestro -- maestro --udid $UDID hierarchy 2>/dev/null > "$1"; }
