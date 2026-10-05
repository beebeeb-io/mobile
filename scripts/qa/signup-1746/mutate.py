import subprocess,sys,shutil,re,os
os.chdir('/Users/guuslangelaar/code/bb-worktrees/mobile-1746')
M=[
 ("M1 parse: ignore COMPILED_PURCHASE_SURFACES","src/lib/onboarding/parse.ts","ctaAllowed: v.cta_allowed === true && COMPILED_PURCHASE_SURFACES.includes(surface),","ctaAllowed: v.cta_allowed === true,","src/lib/onboarding/parse.test.ts"),
 ("M2 parse: accept http URLs","src/lib/onboarding/parse.ts","/^https:\\/\\/","/^https?:\\/\\/","src/lib/onboarding/parse.test.ts"),
 ("M3 plan: create_account no longer last","src/lib/onboarding/plan.ts","    if (step.id === 'create_account') {\n      deferredCreate = step; // runs last, after every other required step\n      continue;\n    }\n","","src/lib/onboarding/plan.test.ts"),
 ("M4 plan: choose_plan becomes a known account step","src/lib/onboarding/plan.ts","export const ACCOUNT_STEP_IDS = ['verify_email', 'accept_terms'] as const;","export const ACCOUNT_STEP_IDS = ['verify_email', 'accept_terms', 'choose_plan'] as const;","src/lib/onboarding/plan.test.ts"),
 ("M5 summary: noPurchaseCopy passes everything","src/lib/onboarding/account-summary.ts","  if (!PURCHASE_WORDS.test(sentence)) return sentence;","  return sentence;","src/lib/onboarding/account-summary.test.ts"),
 ("M6 gate: allowed upload no longer ok","src/lib/onboarding/account-gate.ts","  if (upload?.allowed) return { kind: 'ok' };\n","","src/lib/onboarding/account-gate.test.ts"),
 ("M7 create-account: registrationFailed after commit point","src/lib/onboarding/create-account.ts","  } catch {\n    return { kind: 'created', vaultAdopted: false };\n  } finally {","  } catch {\n    await ceremony.registrationFailed();\n    return { kind: 'created', vaultAdopted: false };\n  } finally {","src/lib/onboarding/create-account.test.ts"),
 ("M8 decision: network failure drops last known state","src/lib/onboarding/account-decision.ts","  if (previous.document) {\n    return { gate: previous.gate,","  if (false as boolean) {\n    return { gate: previous.gate,","src/lib/onboarding/account-decision.test.ts"),
 ("M9 fallback: use_web always a link","src/lib/onboarding/fallback-action.ts","if (webLinksEnabled && fallback.url)","if (fallback.url)","src/lib/onboarding/fallback-action.test.ts"),
 ("M10 account-state: trial_ended refusal ignored","src/lib/account-state.ts","  if (code === TRIAL_ENDED_ERROR) {","  if (code === TRIAL_ENDED_ERROR && false) {","src/lib/account-state.test.ts"),
 ("M11 bridge: native text leaks into CeremonyError","modules/beebeeb-crypto/src/BeebeebOnboarding.ts","    super(`Onboarding step failed: ${code}`);","    super(String((arguments as any)[1] ?? code));","modules/beebeeb-crypto/src/BeebeebOnboarding.test.ts"),
 ("M12 resend: window ignores the document's seconds","src/lib/onboarding/resend.ts","sentAtMs + resendAfterSeconds * 1000","sentAtMs + 60 * 1000","src/lib/onboarding/resend.test.ts"),
 ("M13 status card gains a press handler","src/components/onboarding/AccountStatusCard.tsx","      testID=\"account-status-card\"\n      accessible={false}","      testID=\"account-status-card\"\n      onPress={() => {}}\n      accessible={false}","src/components/onboarding/no-purchase-ui.test.ts"),
 ("M14 wire: do not keep signup_ticket_invalid","src/lib/onboarding/wire.ts","  'signup_ticket_invalid',\n",  "","src/lib/onboarding/wire.test.ts"),
 ("M15 breach-step: evaluate with a fixed prefix","src/lib/onboarding/breach-step.ts","  return breach.evaluate(prefix, body, bc.failOpen);","  return breach.evaluate('00000', body, bc.failOpen);","src/lib/onboarding/breach-step.test.ts"),
 ("M16 copy: email-start hints at an existing account","src/lib/onboarding/copy.ts","      return 'We could not send the email. Check your connection and try again.';","      return 'This address already has an account.';","src/lib/onboarding/copy.test.ts"),
 ("M17 overlay: a working vault is covered","src/lib/onboarding/overlay-screen.ts","        return null; // 'account': a working vault, nothing to block","        return screen;","src/lib/onboarding/overlay-screen.test.ts"),
]
out=[]
for name,path,old,new,test in M:
    src=open(path).read()
    if old not in src:
        out.append((name,'PATCH-MISS',''));continue
    shutil.copy(path,path+'.orig')
    try:
        open(path,'w').write(src.replace(old,new,1))
        r=subprocess.run(['env','-u','NODE_OPTIONS','bun','test',test],capture_output=True,text=True)
        txt=r.stdout+r.stderr
        fails=re.findall(r'\(fail\) (.*?) \[',txt)
        m=re.search(r'\n\s*(\d+) fail',txt)
        out.append((name,'RED' if r.returncode!=0 else 'STILL-GREEN',f"{m.group(1) if m else '?'} fail; first: {fails[0] if fails else ''}"))
    finally:
        shutil.move(path+'.orig',path)
for o in out: print(' | '.join(o))
