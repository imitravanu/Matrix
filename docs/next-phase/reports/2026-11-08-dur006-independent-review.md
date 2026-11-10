# Independent Review: DUR-006 — CLI and terminal continuation

- **Date:** 2026-11-08
- **Task:** `DUR-006` — CLI and user-visible continuation
- **Repository:** `/home/mitravanu/matrix`
- **Base Git commit (`HEAD`):** `ff55a2c2aaeb863e881a5a8d0e112eb78ded0204`
- **DUR-006 14-file candidate SHA-256:** `41033efb9219d7ef57749dc16d11d4476a2f7e7dc5354dda8e35b837d4446fb1`
- **Accepted DUR-005 23-file runtime SHA-256:** `17c6992a5a507b301d3297f69ce598cdf0046ef0078081d8f4b5e15a032aea02`
- **Verdict:** **`CHANGES REQUIRED`**

---

## 1. Executive summary

Both fingerprints match the submission exactly, so the recorded Node 22/24
engineering evidence is reusable without re-running the full suite. Independent
subprocess and PTY counterexamples confirm the safety-critical behavior of the
four prioritized cases:

1. **Kill at a real terminal approval prompt** — no bytes are written before
   approval; `SIGKILL` at the prompt leaves no durable edit intent or dispatch;
   a fresh process denies the edit without fresh authority, requires a new
   provider proposal, preserves the cumulative budget, and applies the edit only
   after a fresh `--yes`. The killed provider dispatch is settled with an
   `uncertain` recovery receipt (`reconciled: true`).
2. **Stale human decision** — a saved decision is bound to the goal, criterion
   revision, workspace manifest and tracked-source fingerprint. Changing the
   tracked source (content, file mode, or deletion) makes `inspect` report the
   criterion unaccepted and forces a fresh interactive decision; restoring the
   exact bytes re-validates the decision. The stale decision cannot complete the
   goal from a fresh process.
3. **Stale or mismatched control lease** — pause/cancel against a dead owner,
   against a forged lease naming a live unrelated pid (with both a real and a
   wrong start time), and against a wrong lease id/generation/action on the live
   control socket are all refused. No unrelated process is signalled, and the
   goal journal, lease identity and state are preserved. Correct control on the
   live socket still works.
4. **Read-only and continuation commands** — `list`/`inspect` change no state
   file, workspace byte or control channel, and `list` does not create an absent
   `MATRIX_HOME`. Incomplete runs report a reason, reason code and a next
   command that works. Ordinary session `--resume` restores a saved transcript
   and exits cleanly.

One user-visible acceptance gap remains, plus one exit-code/guidance
inconsistency:

1. **Finding 1 (`P2`, blocker): workspace-mismatch recovery guidance is
   circular and misleading.** `matrix goal inspect <id>` from a directory other
   than the recorded workspace reports
   `reason: "The recorded workspace identity has changed."` and
   `nextCommand: "matrix goal inspect <id> --cwd '<current wrong directory>'"`.
   The view never names the recorded workspace, `list` in that directory is
   empty, and `resume` refuses with `current workspace does not match the
recorded goal` and no recovery instruction. A user who moved or replaced a
   directory cannot learn the recorded path from the CLI; the only recovery is to
   read `MATRIX_HOME/goals/<id>/checkpoint.json` by hand. This violates the
   DUR-006 acceptance condition "every stop state explains why and how to
   proceed".
2. **Finding 2 (`P3`, non-blocking): refused control requests use exit `1` and
   carry no next step.** `pause`/`cancel` against a dead-owner lease return
   `{result:"refused", reason:"the goal has no verified live owner"}` with exit
   `1`, although the submission documents exit `2` for refused requests. The
   message names no recovery command (`matrix goal resume` reclaims and the
   recorded-directory `inspect` does show it).

Recommendation: fix Finding 1 (name the recorded workspace and use it in the
continuation command or reason), and align the control-refusal exit code and
message in the same pass. The rest of the candidate behaves as claimed in the
scenarios reviewed.

---

## 2. Candidate identity

### 2.1 Repository state

| Check                       | Command                  | Observed                                                                                  | Matches submission |
| --------------------------- | ------------------------ | ----------------------------------------------------------------------------------------- | ------------------ |
| Base commit                 | `git rev-parse HEAD`     | `ff55a2c2aaeb863e881a5a8d0e112eb78ded0204`                                                | Yes                |
| Patch hygiene               | `git diff --check`       | exit `0`, no output                                                                       | Yes                |
| 14-file candidate aggregate | sorted paths + NUL       | `41033efb9219d7ef57749dc16d11d4476a2f7e7dc5354dda8e35b837d4446fb1`                        | Yes                |
| 23-file DUR-005 runtime     | sorted paths + NUL       | `17c6992a5a507b301d3297f69ce598cdf0046ef0078081d8f4b5e15a032aea02`                        | Yes                |
| Working-tree inventory      | `git status --porcelain` | 26 modified + 49 untracked, unchanged by the harnesses (this report is the only addition) | Yes                |

Because both fingerprints match, no file changed relative to the recorded
evidence and the submitted `npm run check` results (1,027 tests on Node
`v22.23.1` and Node `v24.21.0`) are reused as recorded. The review wrote only
this report; implementation files, `docs/next-phase/STATUS.md`, host settings
and Git history were left untouched.

### 2.2 Current per-file SHA-256 (14-file list)

| File                             | SHA-256                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| `MATRIX.md`                      | `f1d8b51555a395c5f58d02a13c03624bd9e1ad3b1f2c5fe62a2170202ea5f72d` |
| `README.md`                      | `85a2b9c99b1872e0825b1aff8d508180122245c2e233e676bc7fb118258be778` |
| `bin/matrix.mjs`                 | `580bdbf2d6bd2c39be6cdbad21e447caf2b6d4329648679fdfd8aec600f2965b` |
| `lib/cli.mjs`                    | `e86dbe171ee9d835d2a5b134001100e87d8cfa97966226cadc5f580d414825dc` |
| `lib/goal-cli.mjs`               | `fea29921d08d7b4e00783600c5ed5ca2e6ba1d1145f4bc55f668863ae7101e51` |
| `lib/goal-control.mjs`           | `3581817edf7fdffccba393da5f4723ecf94be71037173fe37faf7d883e8566e4` |
| `lib/goal-engine.mjs`            | `4015aea01c371be8949930e690917be35620ff1e8341c3683067fccc45345c28` |
| `lib/goal-human-review.mjs`      | `af71a783232f1e3003f66204fafcb8049efa47fa1ae9ac7be032663ba9cab484` |
| `src/goal-app.mjs`               | `5b2aad035107d2681010a3d23a0441be02cca59ebbffc16ce3829acba330e97d` |
| `src/goal-screen.mjs`            | `43ef317cd7561c49f6538bcd7523fdb413a50384574be5617e913ed45f30a8a8` |
| `src/screens/goal.mjs`           | `aa0a6d296bf2be1c6634f0819499fb46ca9289b9bd356ad9ef58a6ada351f318` |
| `test/goal-app.test.mjs`         | `9bbd9646b1aaa0e3c8b5964dd107f706111f0da2147a4e8c8b5f77454191524a` |
| `test/goal-cli-runtime.test.mjs` | `23357f23273051da9ec5175e25c1a9d2747a4e92b97c2b539c3d508b329278ee` |
| `test/goal-cli.test.mjs`         | `abd11c0bcee8d6dd4ad2c4a915a287acef4144887187f27d73d71422b70bdb9b` |

---

## 3. Method and fixtures

The review read `AGENTS.md`, `docs/next-phase/REVIEW_METHOD.md`,
`docs/next-phase/submissions/DUR-006.md`, `docs/next-phase/DURABLE_PHASE.md`,
the DUR-006 assignment in `docs/next-phase/AGENT_TASKS.md`, and the changed
goal-CLI modules.

Independent scripts (outside the repository, under `/tmp/dur006-review/`) drove
the real `bin/matrix.mjs` in child processes against:

- a private temporary `MATRIX_HOME` per case (`0700`, `providers.json` `0600`);
- a temporary workspace per case, with a loopback SSE provider in its own child
  process and a fake bearer value (`q7zk3x9pw2mf4t`, exported only through
  `REVIEW_FAKE_KEY`);
- real PTYs from `script -qec` for the approval prompt, human-review prompts and
  `matrix --resume`;
- real `/proc/<pid>/stat` identities and real `SIGKILL` for owner death;
- a real unrelated `sleep` process as a sentinel for signalling checks.

The forged lease cases rewrite only the private temporary checkpoint (lease
owner pid/start time) using the repository's canonical JSON encoder so the store
accepts the record; store validation is still exercised by the runtime. No
repository code was modified to obtain any result.

---

## 4. Reused versus new evidence

| Evidence                                                      | Source                              | Status                                                                                                                         |
| ------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `npm run check`, 1,027 tests on Node 22.23.1 and 24.21.0      | submission, fingerprints match      | **Reused** (not re-run)                                                                                                        |
| `npm run eval` 16/16, `npm run smoke` 32 frames, `pack:check` | submission, fingerprints match      | **Reused** (not re-run)                                                                                                        |
| DUR-005 23-file runtime behavior                              | accepted DUR-005 submission/reports | **Reused**; fingerprint re-derived at `17c699…`                                                                                |
| Three DUR-006 suites on Node 22.23.1                          | this review                         | **New**: `node --test test/goal-cli.test.mjs test/goal-cli-runtime.test.mjs test/goal-app.test.mjs` → **30/30 pass**, exit `0` |
| Four independent counterexample harnesses                     | this review                         | **New**: checks 1–4 below                                                                                                      |

---

## 5. Check 1 — kill at a real terminal approval prompt

Fixture: temporary home/workspace, artifact criterion on `src/a.mjs`,
loopback provider proposing an edit. Interactive `goal start` (no `--yes`) ran
inside a real PTY.

| #   | Observation                                                                                                                                                              | Result |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 1   | At the rendered `Apply this exact edit? [y/N]` prompt the file still contained the original bytes.                                                                       | PASS   |
| 2   | The prompt displayed the proposed before/after and mode.                                                                                                                 | PASS   |
| 3   | The journal at the prompt held only `state, attempt, intent:provider, dispatch:provider`; no edit intent or dispatch.                                                    | PASS   |
| 4   | `SIGKILL` of the recorded owner at the prompt left the edit unapplied and the goal `running` with its lease.                                                             | PASS   |
| 5   | Remaining budget at the prompt (`rounds 7, tools 24, requests 31, activeMs 570000`) was unchanged after the kill.                                                        | PASS   |
| 6   | Fresh headless `goal resume` without `--yes`: exit `1`, `reasonCode: tool-denied`, no bytes, `needs-attention`, `reconciled: true`, one new provider proposal requested. | PASS   |
| 7   | Fresh `goal resume --yes`: exit `0`, `completed`, edit applied, generation `1 → 3`, `reconciled` recovery receipt status `uncertain`.                                    | PASS   |
| 8   | Cumulative ledger after both invocations: `requests 3, rounds 3, tools 1`; remaining rounds `7 → 5` (never reset).                                                       | PASS   |

The interrupted approval left no persisted authority: the fresh process had to
obtain a new decision, and the killed run's only unsettled dispatch (the
provider round) was settled as `uncertain`, not as success.

---

## 6. Check 2 — a saved human decision against changed source

Fixture: artifact criterion on `notes.md`, two human criteria, and a goal edit
of `src/a.mjs` (which is not itself a criterion, so the tracked-source
fingerprint includes it while the artifact gate stays satisfied).

| #   | Observation                                                                                                                                            | Result |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 1   | The saved decision binds `goalId`, `criterionId`, `revision`, workspace `manifest` and a 64-hex `sourceFingerprint`.                                   | PASS   |
| 2   | After the owner is killed at the second human prompt, `inspect` shows criterion 1 accepted, criterion 2 not accepted.                                  | PASS   |
| 3   | Changing `src/a.mjs` (the tracked source) flips criterion 1 to `accepted: false` while the artifact criterion stays accepted.                          | PASS   |
| 4   | Fresh interactive `resume` prompts again for criterion 1; denying both decisions exits `1` and leaves the goal `needs-attention`.                      | PASS   |
| 5   | Fresh headless resume cannot complete on the stale decision.                                                                                           | PASS   |
| 6   | Alternate mechanisms in the same family: `chmod 0755` invalidates the decision; deletion invalidates it; `inspect` does not crash on the deleted path. | PASS   |
| 7   | Restoring the exact bytes (and mode) re-validates the saved decision; saved decision plus one fresh decision completes after restart (exit `0`).       | PASS   |

---

## 7. Check 3 — stale and mismatched leases

| #   | Observation                                                                                                                                                                              | Result |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | After the recorded owner is `SIGKILL`ed, `pause` and `cancel` are refused; goal state, lease identity and journal bytes are unchanged.                                                   | PASS   |
| 2   | An unrelated `sleep` sentinel stayed alive through every refusal and through the whole run.                                                                                              | PASS   |
| 3   | Live control socket: wrong `leaseId`, wrong `generation` and an unknown action each return `{"accepted":false}`; the live attempt and goal state are unchanged.                          | PASS   |
| 4   | The same socket accepts a correct `pause`; the goal reaches `paused` at a safe boundary and no edit is applied.                                                                          | PASS   |
| 5   | Forged lease naming a live unrelated pid (both its real start time and a mismatched start time) is refused for `pause` and `cancel`; the sentinel survives and the journal is unchanged. | PASS   |
| 6   | The goal then recovers and completes (`reconciled: true`), applying exactly the approved edit.                                                                                           | PASS   |

The socket name is derived from `[goalId, pid, startTime, bootId]` and the
server re-reads the durable lease for every frame, so a request that carries a
stale lease id or generation is rejected without touching the runtime.

---

## 8. Check 4 — read-only commands, reasons, session resume

| #   | Observation                                                                                                                                                                                                          | Result   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | `goal list` and `goal inspect` (text and `--json`) leave every state file, mode, size, mtime and workspace byte unchanged.                                                                                           | PASS     |
| 2   | No control socket appears after `list`/`inspect`, and the `goal-control` directory listing is identical.                                                                                                             | PASS     |
| 3   | `goal list` with a nonexistent `MATRIX_HOME` returns `{"goals":[]}` and does not create the directory.                                                                                                               | PASS     |
| 4   | `goal inspect <id>` from a different directory still exits `0` and is read-only.                                                                                                                                     | PASS     |
| 5   | Incomplete run: exit `1` with a non-empty reason, `reasonCode: tool-denied`, and `nextCommand: matrix goal resume <id>`; running that exact command is a valid invocation (not a usage error) that acts on the goal. | PASS     |
| 6   | Refused resume of a completed goal: exit `2`, reason names the state and `inspect`/`start a new goal`.                                                                                                               | PASS     |
| 7   | Unknown goal: exit `2`, `unknown goal <id>`.                                                                                                                                                                         | PASS     |
| 8   | Refusals do not modify goal state.                                                                                                                                                                                   | PASS     |
| 9   | Ordinary session `--resume` in a PTY restores a saved transcript marker and exits `0` on Ctrl+C.                                                                                                                     | PASS     |
| 10  | Workspace-mismatch refusal and foreign-directory `inspect` give a reason but no usable continuation (Finding 1).                                                                                                     | **FAIL** |
| 11  | A fresh-directory `inspect` next command points at the _current_ directory, not the recorded workspace (Finding 1).                                                                                                  | **FAIL** |

---

## 9. Findings

### Finding 1 — Workspace mismatch gives circular, misleading recovery guidance (`P2`, blocker)

**Location**

- [`lib/goal-cli.mjs:172-174`](../../../lib/goal-cli.mjs#L172-L174): when the
  current workspace is not the goal's, the reason is replaced with
  `The recorded workspace identity has changed.` even when only the caller's
  directory differs and the recorded workspace is intact.
- [`lib/goal-cli.mjs:181-188`](../../../lib/goal-cli.mjs#L181-L188): the
  continuation command is built from the _current_ workspace, so it suggests
  re-running `inspect` with `--cwd <current wrong directory>`.
- [`lib/goal-cli.mjs:257`](../../../lib/goal-cli.mjs#L257): `resume` refuses with
  `current workspace does not match the recorded goal` and no instruction.
- The projected view has no field for the recorded workspace path, although
  `status.goal.workspace.path` is available.

**Reproduction** (self-contained; the stub provider points at a closed loopback
port only to produce an honest failed operation — no network egress, no key):

```sh
cd /home/mitravanu/matrix
BASE=$(mktemp -d); H=$BASE/home; W=$BASE/work; O=$BASE/other
mkdir -p "$H" "$W" "$O"; chmod 700 "$H"
echo 'export const a = 1;' > "$W/a.mjs"
printf '{"schemaVersion":1,"criteria":[{"kind":"artifact","path":"a.mjs","sha256":"%s"}]}' \
  "$(printf 'export const a = 2;\n' | sha256sum | cut -d' ' -f1)" > "$W/criteria.json"
printf '{"schemaVersion":1,"providers":[{"id":"stub","name":"Stub","transport":"chat-completions","baseUrl":"http://127.0.0.1:9/v1","auth":{"type":"bearer","env":"STUB_KEY"},"request":{"tokenLimitField":"max_tokens","includeUsage":false},"models":[],"defaultModel":null}]}' > "$H/providers.json"
chmod 600 "$H/providers.json"
MATRIX_HOME=$H STUB_KEY=fake node bin/matrix.mjs goal start "Set a to 2" \
  --criteria criteria.json --provider stub --model stub-model -C "$W"   # exit 1, needs-attention
ID=$(MATRIX_HOME=$H node bin/matrix.mjs goal list --json -C "$W" \
  | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).goals[0].id))')
MATRIX_HOME=$H node bin/matrix.mjs goal inspect "$ID" --json -C "$O"
MATRIX_HOME=$H STUB_KEY=fake node bin/matrix.mjs goal resume "$ID" --yes --json -C "$O"
MATRIX_HOME=$H node bin/matrix.mjs goal list --json -C "$O"
```

**Expected:** a stopped goal inspected outside its recorded workspace explains
that the current directory is not the goal's workspace, names the recorded
workspace (or a `--cwd <recorded workspace>` continuation), and the refusal
offers that recovery. "How to proceed" is then actionable.

**Actual** (observed):

```text
goal inspect <id> -C "$O":
  reason: "The recorded workspace identity has changed."
  nextCommand: "matrix goal inspect <id> --cwd '<.../other>'"     # repeats inspect in the wrong directory

goal resume <id> --yes -C "$O":
  exit 2, reason: "current workspace does not match the recorded goal"   # no path, no command

goal list -C "$O":
  {"schemaVersion":1,"goals":[],"omitted":0}

goal inspect <id> -C "$W":
  reason: "The attempt stopped before satisfying every criterion. Inspect the last operation before resuming."
  nextCommand: "matrix goal resume <id> --cwd '<.../work>'"       # only correct in the recorded directory
```

**Consequence:** after a directory move or replacement, a user in the wrong
directory has no CLI path to the recorded workspace; the suggested command loops
back to the same view, and the reason inaccurately asserts that the recorded
identity changed when only the caller's directory differs. This defeats the
DUR-006 acceptance condition "every stop state explains why and how to
proceed".

**Required behavior:** disclose the recorded workspace (bounded/redacted as
paths already are) or make the continuation command use it, and make the refusal
reason state that the caller must run from the recorded workspace. A regression
should assert both the reason and a non-circular continuation command when
`cwd` differs from the recorded workspace.

---

### Finding 2 — Stale-owner control refusals use exit `1` and name no recovery (`P3`, non-blocking)

**Location:** [`lib/goal-control.mjs:121`](../../../lib/goal-control.mjs#L121)
throws a plain `Error("the goal has no verified live owner")`;
[`lib/goal-cli.mjs:556`](../../../lib/goal-cli.mjs#L556) maps any non-`start`
plain error to exit `1`. The submission documents exit `2` for "refused
requests".

**Reproduction:** start a goal whose provider hangs, `SIGKILL` the recorded
owner, then:

```sh
MATRIX_HOME=$H node bin/matrix.mjs goal pause  <id> --json   # exit 1
MATRIX_HOME=$H node bin/matrix.mjs goal cancel <id> --json   # exit 1
```

Observed for both:

```json
{
  "schemaVersion": 1,
  "goalId": "goal_…",
  "result": "refused",
  "reason": "the goal has no verified live owner"
}
```

**Expected:** exit `2` for a refused control request (consistent with
`resume` refusals and the documented contract) and a next step, e.g.
`matrix goal resume <id>` (which reclaims) or `matrix goal inspect <id>`.

**Consequence:** automation that distinguishes "refused" from "incomplete work"
misclassifies the control failure, and an interactive user is told what went
wrong but not how to recover. State is not at risk: the goal is preserved and
`inspect` from the recorded directory does provide the correct continuation.

**Required behavior:** return the documented refusal code for undeliverable
control requests and name the reclaim/resume command in the message.

---

## 10. Disposition

| #   | Finding                                                  | Severity | Disposition |
| --- | -------------------------------------------------------- | -------- | ----------- |
| 1   | Workspace-mismatch recovery guidance circular/misleading | P2       | **OPEN**    |
| 2   | Stale-owner control refusal exit code and guidance       | P3       | **OPEN**    |

Everything else reviewed behaves as submitted: interruption at a real approval
prompt, fresh authority, cumulative budgets, stale human decisions, alternate
staleness mechanisms, dead/mismatched/forged leases, read-only inspection,
incomplete-run continuation, and ordinary session `--resume`.

---

## 11. Scope limits

- **Reused, not repeated:** the full `npm run check` (1,027 tests) on Node 22 and
  Node 24, `npm run eval`, `npm run smoke` and `npm run pack:check`. Only the
  three DUR-006 test files were re-run here, on Node `v22.23.1` (`30/30`), and the
  four independent harnesses above.
- **Not evaluated:** the contained test-runner path (`--allow-tests` with
  Bubblewrap/pidfd helper) was not exercised; check 1 interrupted an **edit**
  approval, not a test-plan approval. UI rendering, reduced-motion and
  screen-reader paths, `goal start` refusal classes beyond those in check 4
  (missing key, malformed criteria), live providers, cost, non-Linux platforms
  and physical power loss were not independently exercised.
- **Fixture note:** the forged-lease cases construct private temporary state with
  the repository canonical JSON encoder; they do not modify runtime code and the
  store's validation is still under test.
- **Cleanup:** all fixtures used temporary `MATRIX_HOME` and workspace
  directories with fake credentials; the unrelated sentinel process was
  terminated and the temporary directories removed. The review left no runtime
  edits, no host-setting change and no Git history change; the only repository
  addition is this report.

---

## Appendix A — Key commands

```sh
cd /home/mitravanu/matrix
git rev-parse HEAD                     # ff55a2c2aaeb863e881a5a8d0e112eb78ded0204
git diff --check                       # exit 0

# 14-file DUR-006 candidate (sorted relative paths are listed in the submission)
{
  for f in MATRIX.md README.md bin/matrix.mjs lib/cli.mjs lib/goal-cli.mjs \
    lib/goal-control.mjs lib/goal-engine.mjs lib/goal-human-review.mjs \
    src/goal-app.mjs src/goal-screen.mjs src/screens/goal.mjs \
    test/goal-app.test.mjs test/goal-cli-runtime.test.mjs test/goal-cli.test.mjs; do
    printf '%s\0' "$f"; cat "$f"
  done
} | sha256sum                          # 41033efb9219…

# 23-file accepted DUR-005 runtime (list in docs/next-phase/submissions/DUR-005.md)
{
  for f in docs/next-phase/fixtures/dur005-driver.mjs lib/controller.mjs \
    lib/doctor.mjs lib/goal-containment.mjs lib/goal-context.mjs \
    lib/goal-contracts.mjs lib/goal-executor.mjs lib/goal-guardian.mjs \
    lib/goal-lease-probe.mjs lib/goal-lock.mjs lib/goal-operations.mjs \
    lib/goal-policy.mjs lib/goal-recovery.mjs lib/goal-store.mjs \
    lib/integration-publication.mjs lib/local-agent.mjs lib/model-agent.mjs \
    lib/parallel-run.mjs lib/workspace.mjs scripts/build-pidfd-helper.mjs \
    scripts/check-coverage.mjs scripts/matrix-pidfd-helper.c \
    test/goal-runtime.test.mjs; do
    printf '%s\0' "$f"; cat "$f"
  done
} | sha256sum                          # 17c6992a5a50…

# Targeted DUR-006 suites on Node 22
/tmp/opencode/review-kit/dist/node-v22.23.1-linux-x64/bin/node --test \
  test/goal-cli.test.mjs test/goal-cli-runtime.test.mjs test/goal-app.test.mjs
```

## Appendix B — Independent harness results

```text
CHECK1: 21 passed, 0 failed  (approval prompt, SIGKILL, fresh denial, reconciliation, budget)
CHECK2: 22 passed, 0 failed  (decision binding, content/mode/deletion staleness, fresh decision)
CHECK3: 28 passed, 0 failed  (dead owner, wrong lease/generation/action, forged live pid, sentinel)
CHECK4: 29 passed, 2 failed  (Finding 1; all read-only, incomplete-run and session-resume checks pass)
```

Exact failure lines:

```text
FAIL foreign-directory next command names the recorded workspace :: matrix goal inspect goal_5db76c5a5f5b4fe08251ddbdc6f268a0
FAIL workspace refusal names a next command or action :: {"schemaVersion":1,"goalId":"goal_5db76c5a5f5b4fe08251ddbdc6f268a0","result":"refused","reason":"current workspace does not match the recorded goal"}
```

## Appendix C — Verdict

**`CHANGES REQUIRED`** — for Finding 1 (`P2`). The four prioritized behaviors
pass except for workspace-mismatch recovery guidance, which is a required part of
"every stop state explains why and how to proceed". Finding 2 (`P3`) should be
fixed in the same pass. After the projection/refusal fix, re-run the four
harnesses plus the DUR-006 suites on Node 22 and 24.
