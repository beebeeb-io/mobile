#!/usr/bin/env bash
# usage: mkphaseA.sh EMAIL EVID_DIR NAME  -> writes phaseA-NAME.yaml (+ code script)
EMAIL="$1"; EVID="$2"; NAME="$3"
cat > fetch-code-$NAME.js <<JS
var list = JSON.parse(http.get('http://localhost:8025/api/v1/messages?limit=20').body);
var id = null;
for (var i = 0; i < list.messages.length; i++) {
  var m = list.messages[i];
  for (var j = 0; j < m.To.length; j++) { if (m.To[j].Address.toLowerCase() == '$EMAIL') { id = m.ID; break; } }
  if (id) break;
}
var code = '';
if (id) {
  var msg = JSON.parse(http.get('http://localhost:8025/api/v1/message/' + id).body);
  var mt = /(\d{8})/.exec(msg.Text);
  if (mt) code = mt[1];
}
output.code = code;
JS
cat > phaseA-$NAME.yaml <<YAML
appId: io.beebeeb.app
---
- tapOn:
    id: "onboarding-back"
    optional: true
- tapOn:
    id: "welcome-create-account"
    optional: true
- extendedWaitUntil:
    visible:
      id: "signup-email-input"
    timeout: 20000
- takeScreenshot: "$EVID/$NAME-01-email"
- tapOn:
    id: "signup-email-input"
- inputText: "$EMAIL"
- hideKeyboard
- tapOn:
    id: "signup-email-continue"
- extendedWaitUntil:
    visible:
      id: "signup-code-0"
    timeout: 20000
- takeScreenshot: "$EVID/$NAME-02-code"
- runScript: fetch-code-$NAME.js
- tapOn:
    id: "signup-code-0"
- inputText: \${output.code.charAt(0)}
- inputText: \${output.code.charAt(1)}
- inputText: \${output.code.charAt(2)}
- inputText: \${output.code.charAt(3)}
- inputText: \${output.code.charAt(4)}
- inputText: \${output.code.charAt(5)}
- inputText: \${output.code.charAt(6)}
- inputText: \${output.code.charAt(7)}
- extendedWaitUntil:
    visible:
      id: "signup-terms-check"
    timeout: 20000
- takeScreenshot: "$EVID/$NAME-03-terms"
- tapOn:
    id: "signup-terms-check"
- tapOn:
    id: "signup-understood-check"
- tapOn:
    id: "signup-terms-continue"
- extendedWaitUntil:
    visible:
      id: "signup-password-input"
    timeout: 20000
YAML
