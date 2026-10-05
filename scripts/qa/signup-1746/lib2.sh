#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# A throwaway password per run, never a literal in the repo.
PW=${BB_QA_PASSWORD:-"$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 18)-Aa1!"}
phaseA() { # EMAIL NAME
  cd $FL && $HERE/mkphaseA.sh "$1" $E "$2" && python3 - "$2" <<'PY'
import sys
n=sys.argv[1]; p=f'phaseA-{n}.yaml'; s=open(p).read()
s=s.replace('- tapOn:\n    id: "welcome-create-account"\n    optional: true','- tapOn:\n    id: "welcome-create-account"\n    optional: true\n- tapOn:\n    id: "create-account-button"\n    optional: true',1)
open(p,'w').write(s)
PY
  mae test phaseA-$2.yaml | /usr/bin/grep -E "FAILED|Error|not found" | head -3
}
phaseB() { # NAME
  cat > $FL/phaseB-$1.yaml <<Y
appId: io.beebeeb.app
---
- tapOn:
    id: "signup-password-input"
- inputText: "$PW"
- tapOn:
    id: "signup-password-confirm-input"
- inputText: "$PW"
- tapOn: "Set a password"
- takeScreenshot: "$E/$1-04-password"
- tapOn:
    id: "signup-password-continue"
- extendedWaitUntil:
    visible:
      id: "signup-phrase-saved-check"
    timeout: 30000
- takeScreenshot: "$E/$1-05-phrase"
Y
  mae test $FL/phaseB-$1.yaml | /usr/bin/grep -E "FAILED|Error|not found" | head -3
}
readwords() { # NAME
  hier $FL/hier-phrase-$1.json
  python3 - $1 <<'PY'
import json,os,re,sys
n=sys.argv[1]
raw=open(os.path.join(os.environ['FL'],f'hier-phrase-{n}.json')).read(); d=json.loads(raw[raw.index('{'):])
w={}
def walk(x):
    a=x.get('attributes',{}); m=re.match(r'signup-phrase-word-(\d+)',a.get('resource-id',''))
    if m: w[int(m.group(1))]=a.get('text') or a.get('accessibilityText')
    for c in x.get('children',[]): walk(c)
walk(d)
open(os.path.join(os.environ['FL'],f'words-{n}.txt'),'w').write(' '.join(w[k] for k in sorted(w)))
print(len(w),'words read')
PY
}
phaseC() { # NAME -> positions
  cat > $FL/phaseC.yaml <<Y
appId: io.beebeeb.app
---
- tapOn:
    id: "signup-phrase-saved-check"
- tapOn:
    id: "signup-phrase-saved"
- extendedWaitUntil:
    visible:
      text: "Confirm your phrase"
    timeout: 20000
Y
  mae test $FL/phaseC.yaml | /usr/bin/grep -E "FAILED|Error" | head -2
  hier $FL/hier-confirm-$1.json
  python3 - $1 <<'PY'
import json,os,re,sys
n=sys.argv[1]; base=os.environ['FL']+'/'
raw=open(base+f'hier-confirm-{n}.json').read(); d=json.loads(raw[raw.index('{'):])
pos=[]
def walk(x):
    m=re.match(r'signup-phrase-answer-(\d+)',x.get('attributes',{}).get('resource-id',''))
    if m: pos.append(int(m.group(1)))
    for c in x.get('children',[]): walk(c)
walk(d); words=open(base+f'words-{n}.txt').read().split()
open(base+f'answers-{n}.txt','w').write('\n'.join(f"{p} {words[p-1]}" for p in pos)+'\n'); print(pos)
PY
}
phaseD() { # NAME [nowait]
  { echo 'appId: io.beebeeb.app'; echo '---'
    while read p w; do printf -- '- tapOn:\n    id: "signup-phrase-answer-%s"\n- waitForAnimationToEnd\n- inputText: "%s"\n- waitForAnimationToEnd\n' $p $w; done < $FL/answers-$1.txt
    echo '- tapOn: "Confirm your phrase"'
  } > $FL/phaseD-$1.yaml
  mae test $FL/phaseD-$1.yaml | /usr/bin/grep -E "FAILED|Error" | head -2
}
confirmtap() {
  cat > $FL/confirmtap.yaml <<Y
appId: io.beebeeb.app
---
- tapOn:
    id: "signup-phrase-confirm"
Y
  mae test $FL/confirmtap.yaml | /usr/bin/grep -E "FAILED|Error" | head -2
}
verifyEmailStep() { # NAME
  cat > $FL/verify-$1.yaml <<Y
appId: io.beebeeb.app
---
- extendedWaitUntil:
    visible:
      id: "account-verify-code-input"
    timeout: 60000
- runScript: fetch-code-$1.js
- tapOn:
    id: "account-verify-code-input"
- inputText: \${output.code}
- tapOn: "Confirm your email"
- tapOn:
    id: "account-verify-confirm"
- extendedWaitUntil:
    notVisible:
      id: "account-verify-confirm"
    timeout: 30000
- takeScreenshot: "$E/$1-09-vault"
Y
  cd $FL && mae test verify-$1.yaml | /usr/bin/grep -E "FAILED|Error" | head -2
}
signout() {
  mae test $FL/signout.yaml | /usr/bin/grep -E "FAILED|Error" | head -2
}
reset_to_login() { # leave whatever signup screen we are on
  cat > $FL/resetlogin.yaml <<Y
appId: io.beebeeb.app
---
- tapOn:
    id: "signup-use-different-email"
    optional: true
- tapOn:
    id: "onboarding-back"
    optional: true
Y
  mae test $FL/resetlogin.yaml | tail -1
}
