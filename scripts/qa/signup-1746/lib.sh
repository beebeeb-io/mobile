#!/usr/bin/env bash
UDID=$(cat ~/code/bb-worktrees/s1746/sim-udid.txt)
L=/Users/guuslangelaar/Development/Beebeeb/beebeeb.io/scripts/coord/with-lock.sh
E=/Users/guuslangelaar/Development/Beebeeb/beebeeb.io/.claude/tasks/verification-evidence/1746
mae() { env -u NODE_OPTIONS $L maestro -- maestro --udid $UDID "$@" 2>&1 | /usr/bin/grep -v "WARNING"; }
openurl_tap() { xcrun simctl openurl $UDID "$1"; sleep 2; cat > /tmp/tapopen.yaml <<Y
appId: io.beebeeb.app
---
- tapOn:
    text: "Open"
    optional: true
- waitForAnimationToEnd
Y
 mae test /tmp/tapopen.yaml | tail -2; sleep 3; }
hier() { env -u NODE_OPTIONS $L maestro -- maestro --udid $UDID hierarchy 2>/dev/null > "$1"; }
