# Maestro driver fault (task 1360) — the full runbook

Moved verbatim out of `CLAUDE.md` on 2026-09-12 (way-of-working split: CLAUDE.md keeps the rule,
this file keeps the reasoning). Nothing below was edited; only de-indented.

**The rule (also in CLAUDE.md):** a `tapOn` that reports COMPLETED against an UNCHANGED screenshot
is the out-of-date shared Maestro CLI (2.5.1, decision 1361), not a product bug. Diagnose from the
failure screenshot first; retry the ACTION with a same-render `while:` condition, never the
assertion; make non-idempotent handlers idempotent at the source.

**ROOT CAUSE FOUND (task 1360, 2026-09-03): a tap reports COMPLETED and the app never changes
state because the installed Maestro CLI is FOUR MONTHS OUT OF DATE.** Maestro resolves the
element, taps it, reports COMPLETED, and the next assertion fails against a screen identical to
the one before the tap. It is NOT "element not found" and NOT "element covered", NOT a product
bug, and NOT device state — **it is the driver.** The Mac's shared install is
**Maestro 2.5.1** (`~/.maestro`, installed 1 May); upstream is **2.10.0** (2026-08-31), five
minors and about four months ahead. Same simulator (`bb-qa-1310`), same flow
(`file-preview-test.yaml`), no retries either side: **2.5.1 failed 9 of 15 runs; an isolated
2.10.0 binary passed 15 of 15.** Runs were also ~30% faster on 2.10.0 (~23s apart vs. 28-38s). A
second simulator, `bb-qa-2`, was checked too and was *worse* under 2.5.1 (10 failures in 10
completed runs, 2 more that never reached a verdict) — ruling out "one simulator has bad state"
before the version test even ran.

**The shared install has NOT been upgraded.** `~/.maestro` (2.5.1) is used by other projects on
this machine, so this workspace does not upgrade it unilaterally — that decision is queued for
Guus. Until he decides, **the flows below carry a bounded retry as an interim mitigation** (see
below). If you're reading this after the upgrade landed, the retries are stale scaffolding for a
fault that no longer exists — remove them and go back to a plain `tapOn` + single assertion; check
`maestro --version` first to confirm you're actually past 2.5.1 before you rip them out.

**Two traps if you re-run this comparison yourself (both cost real time to find):**
1. `grep -i repeat` on a 2.10.0 run's log is USELESS for checking "did it retry" — it returns
   dozens of hits that are all `repeatable=` fields inside `CommandMetadata` log noise, none of
   them an actual retry command. Check `commands.json` for a real `repeatCommand` entry instead,
   or count `Tap on id: X` occurrences for the control you care about.
2. **2.10.0 changed the artifact layout**: it writes a `<flow-name>/` **directory** where 2.5.1
   wrote a single `commands-(<flow-name>.yaml).json` file. A script that greps for the old
   filename shape will silently find nothing and undercount — this produced a false "zero runs"
   read on the first attempt at this comparison.

**Diagnose before you touch anything.** Read the failure screenshot first. If it shows the
PRE-tap state — the exact same screen the flow was already on — you are looking at this fault,
not a regression. A genuine regression looks different: a partially-applied state, an error, or a
screen that changed but changed *wrong*. Every failure instance collected for task 1360 (12+
screenshots across `select-mode-enter`, `search-cancel`, the search kind-filter capsules, and
`preview-close`) showed a clean pre-tap freeze, never a different-looking broken screen. If yours
doesn't match that shape, stop — you may have a real bug, not this fault.

**The mechanism was confirmed at the JS level too, before the version was known to be the cause.**
A temporary `console.log` at the top of the handler (`handleClose` in PreviewScreen,
`enterSelectMode`/`handleSearchToggle`/the kind-filter `onPress` in FilesScreen) proved the JS
callback **never runs** on a failing tap — absent from the Metro log every single time, present
every time the tap actually worked. It also proved this is not a slow-JS-thread problem: on 5
deliberate 8-second post-failure holds (plus one accidental 2-minute hold when a harness script
crashed and left the app untouched) the handler log never showed up late either. The touch was
lost before it reached React Native's responder system — consistent with a driver-level fault, and
now explained by one: the old CLI. That instrumentation has been removed (its job is done); do not
re-add it to chase this specific fault — the version gap is the answer.

**Interim mitigation (remove once `~/.maestro` is upgraded past 2.5.1): retry the ACTION, never
the assertion.** `search-test.yaml` and `file-preview-test.yaml` wrap every affected tap in a
bounded `repeat...while` that re-taps up to 5 times while the expected post-tap state is still
absent, followed by the ORIGINAL, unmodified, single-shot assertion. This is a workaround, not a
fix — it absorbs the fault rather than removing it, and a retry loop would just as easily mask a
real intermittent product bug of the same shape, which is exactly what upgrading avoids. Prefer
the upgrade over extending this pattern to new controls if the upgrade decision lands first.
```yaml
- repeat:
    times: 5
    while:
      notVisible:
        id: "select-mode-cancel"
    commands:
      - tapOn:
          id: "select-mode-enter"
- assertVisible:
    id: "select-mode-cancel"
```
If the tap keeps failing to land, this fails for real — a genuine regression still goes red, it
just takes up to 5 attempts to prove it consistently isn't landing rather than one unlucky tap.
**Never retry the assertion itself** (no widening a timeout, no `extendedWaitUntil` bolted onto an
assertion that used to be immediate, no swallowing the failure) — that is a loosened test wearing
a disguise, and it is exactly how a real regression would get through unnoticed. Any retry is also
**loud by construction**: Maestro's own CLI output prints `Repeat while ... (up to N times)` plus
one line per attempted tap, so a flow that needed 2 or 3 attempts is visible in the run's own log
and artifacts, not silently absorbed.

**This pattern is only safe when the tapped action is idempotent — "set to state X", not
"toggle" — from the loop's point of view, which is a property of the WHILE CONDITION, not just
the underlying handler.** `enter select mode` and `select a search filter` are genuinely
one-way: tapping again after success is a harmless no-op because their `while` conditions
track state that can only move in one direction. `search-cancel` is different: its handler
(`handleSearchToggle`) is a literal toggle (`setSearchActive((prev) => !prev)`), which makes it
**actively dangerous** to wrap without care — a `while` condition that doesn't track the exact
moment the toggle flipped can let a retry fire a second tap that flips it straight back,
producing the exact same "COMPLETED, no state change" shape as this fault, except the cause
this time is the retry undoing a tap that worked. This is not a hypothetical: it shipped once in
this branch and was caught by review, not by running the flow — see the worked example right
below. Do not add this pattern to a toggle control without first picking a `while` condition
that is unambiguous about which of the toggle's two states is the *pre*-tap one, and proving it
live.

**The sharper form of that rule, and we shipped an instance of it before catching it: a
retry's exit condition must be driven by the same render as the action, never by an effect
that follows it.** An effect-driven condition creates a real window where the action has
already succeeded and the loop cannot tell — it isn't a theoretical risk, a code review caught
exactly this in the first `search-cancel` retry in `search-test.yaml`. `handleSearchToggle` is
a toggle (`setSearchActive((prev) => !prev)`), and the retry's original condition,
`notVisible: id: "tab-photos"`, tracks `tab-photos`'s visibility — which comes back through a
`navigation.setOptions` **effect** (the `tabBarStyle` `useEffect` in FilesScreen.tsx) that runs
one render AFTER the render that actually clears `searchActive`. In that gap, `searchActive` is
already `false` but `tab-photos` hasn't appeared yet — a retry firing here would re-tap
`search-cancel`, flip the toggle straight back, and reopen search, undoing a tap that already
worked. Fixed by switching to `while: visible: id: "search-bar"` — `search-bar` is gated
directly by `{searchActive && !selectMode && (...)}` in JSX, so it unmounts on the *exact same
render* as `searchActive` going false, no effect in between, no window. `tab-photos` stays as
the real assertion afterward; only the retry's own exit condition changed.

**When no same-render signal exists at all, fix the action instead of chasing the condition.**
`preview-close`'s `handleClose` just calls `navigation.goBack()`, and `goBack()` is not
idempotent either — a second tap that lands before the pop completes would advance the
navigator an extra step. But there is no JS-render signal to key a `while:` on here the way
`search-bar` worked for `search-cancel`: the preview modal's dismiss (`presentation: 'modal',
animation: 'slide_from_bottom'`) is a **native animation**, so `preview-close` itself can stay
mounted and hit-testable for the whole transition — checking `preview-close`'s own visibility
instead of `"Drive"` would not have closed the race, it would just check a different fact with
the same lag, since the delay is native/async, not React-render-order. The fix here is a
`closedRef` guard inside `handleClose` (PreviewScreen.tsx) so a second delivered call is a
harmless no-op — making the action itself idempotent, since no amount of clever polling from
outside the component can substitute for that when the delay is native, not a JS render tick.
As a side effect this also closes a latent real-user bug (a genuine fast double-tap on close had
the same double-pop risk, with nothing to do with Maestro at all).

**The general lesson: before wrapping a tap in this retry pattern, ask whether the state your
`while:` condition reads changes on the SAME render/commit as the action, or later** (through an
effect, or worse, a native transition). Same render → a `while:` condition can safely close the
race, the way it does for `select-mode-enter`, `search-cancel`, and the search filter capsules.
Later → a YAML condition cannot fix this at all, no matter how cleverly chosen, and the actual
fix is at the source: make the handler idempotent.

Picking the `while` condition is the one place this is easy to get subtly wrong — validate it
live before trusting it. The first attempt at wrapping the second `search-cancel` tap in
`search-test.yaml` used `notVisible: "Drive"`, which looked right by analogy to a neighboring
`extendedWaitUntil: visible: "Drive"` — but the folder title stays rendered in the header
throughout active search, so that condition was **already false before the tap**, and Maestro's
`repeat` correctly but unhelpfully **skips the whole body** when `while` starts false — the tap
never fired at all. Caught by actually running the flow, not by reading the YAML. Use whatever
element genuinely flips state across the tap (here, `search-bar`'s own visibility), and prove it
by running the flow, not by pattern-matching a neighboring block.

Controls covered so far: `select-mode-enter`, both `search-cancel` occurrences, and
`search-filter-photos`/`search-filter-videos` in `search-test.yaml`; `preview-close` in
`file-preview-test.yaml`. This fault is a bridge-level problem, not specific to these controls —
if you hit the same COMPLETED-but-frozen shape on a control not listed here, diagnose it the same
way (instrument the handler, confirm the log is absent not late, confirm the screenshot shows the
pre-tap state) before assuming it's covered by analogy, then add the same `repeat...while` shape.

**HYPOTHESIS, not a claim — check this when the upgrade lands, don't act on it before then.**
Every "gotcha" documented in this Maestro section was written against 2.5.1. Now that one of them
turned out to be version-level rather than a fact about the tool, a few of the others read the
same way, and are worth re-testing on 2.10.0 rather than assuming permanent: the **stale
accessibility-bridge attach after `launchApp`** (below — identical "visibly correct screen,
interaction fails" shape), the **orphaned driver poisoning new bootstraps machine-wide**, and
`scrollUntilVisible` **failing to find an element by `id:` that a fresh hierarchy dump shows is
genuinely present.** Nobody has re-tested any of these on 2.10.0. Do not remove any of these
workarounds on the strength of this paragraph alone — confirm each one still reproduces on the
new version first, the same way this task's own retries were validated live rather than assumed.
