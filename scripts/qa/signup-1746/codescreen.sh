#!/usr/bin/env bash
# usage: codescreen.sh EMAIL TAG
source ~/code/bb-worktrees/s1746/flows/lib2.sh
cat > $FL/cs-$2.yaml <<Y
appId: io.beebeeb.app
---
- tapOn:
    id: "signup-use-different-email"
    optional: true
- tapOn:
    id: "onboarding-back"
    optional: true
- tapOn:
    id: "create-account-button"
    optional: true
- extendedWaitUntil:
    visible:
      id: "signup-email-input"
    timeout: 20000
- tapOn:
    id: "signup-email-input"
- inputText: "$1"
- tapOn:
    id: "signup-email-continue"
- extendedWaitUntil:
    visible:
      id: "signup-code-0"
    timeout: 20000
- takeScreenshot: "$E/c-$2-code-screen"
Y
mae test $FL/cs-$2.yaml | /usr/bin/grep -E "FAILED|Error" | head -2
hier $FL/hier-code-$2.json
