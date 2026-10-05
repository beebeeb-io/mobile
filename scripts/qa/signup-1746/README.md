# Native signup QA driver (task 1746)

The Maestro driver the simulator rung of task 1746 was run with. It is a REFERENCE, not a CI job:
it needs `BB_WORKSPACE`, `BB_QA_UDID` (a simulator you created for the run, deleted afterwards) and
`BB_QA_EVIDENCE` in the environment, a local API with Mailpit on :8025, and a `signout.yaml` of your own
in the work directory. All generated flows, hierarchy dumps and the phrase/answer files live in a
`mktemp -d` directory removed on exit; nothing that can contain a recovery phrase is written into the
repo, and none may ever be committed.

| File | What |
|---|---|
| `lib.sh` | `mae` (Maestro under the machine-wide `maestro` lock, `--udid` always), `hier` |
| `lib2.sh` | the phases: A (email, code from Mailpit, terms), B (password), read the phrase from the hierarchy, C (positions), D (answers), the account-stage `verify_email` step, sign out |
| `mkphaseA.sh` | writes phase A and the Mailpit code script (types the 8 digits one at a time: a one-shot `inputText` into the digit boxes dropped a digit) |
| `full.sh` | A to D for one new address |
| `codescreen.sh` | renders the code screen for an address and dumps the hierarchy (rung c: identical copy for a new and an existing address) |
| `check-hier.py` | scans an iOS hierarchy dump for purchase vocabulary (the iOS hierarchy has no `clickable`, so this reads ALL text and labels) |
| `mutate.py` | the 17 deliberate mutations of the new logic; each must turn exactly its own test red |

The phrase words are read from `maestro hierarchy` (`signup-phrase-word-N`), never from a log.
