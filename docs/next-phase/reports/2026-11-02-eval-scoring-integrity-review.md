# PRV-105 scoring integrity review: file binding, receipt forgery and detached-process interference — 2026-11-02

## Verdict

**CHANGES REQUIRED.** Two integrity findings against the committed candidate were
demonstrated end-to-end with real downstream execution:

1. **P1 — score-time re-read is not bound to the submitted bytes** (`swap` class of the
   file-substitution family). A wrong proposed `keepLast` reached `taskSuccess: true` /
   `ok: true` after a same-uid detached side-writer changed the workspace file after the
   approved edit. Score-side accept of the wrong source was also observed in every
   consumer, and no code location compares the scored bytes against the applied
   proposal bytes.
2. **P1 — scoring receipt/exit integrity fails against same-uid ptrace on this host**
   (the documented detached-process residual, now verified live rather than assumed). With `kernel.yama.ptrace_scope = 0`, an attached process disclosed the real receipt
   token from both live scoring children of a real evaluation run, injected a forged
   passing TAP block carrying those exact tokens, and substituted `exit_group(0)`. The
   committed scoring path recorded `authoritative ok true` and `behavioral ok true`
   for a **wrong** proposed source.

Positive and negative controls discriminated; all other tried mechanisms (bait-gated
in-source watcher, per-mechanism VM isolation from the earlier sweep) failed closed.

Independence statement: this review was produced in the same session as the repair.
Per `REVIEW_METHOD.md` §6 it is an implementer-side assigned review, not the
independent PRV-106 audit, and does not decide PRV-105 acceptance. PRV-105 remains
SUBMITTED. No runtime code, config, other tasks' files, credentials, or paid providers
were touched; the model loop ran against a loopback SSE server with a fake bearer key;
adversarial process inspection touched only processes created by the review harness.

## 1. Exact candidate identity and review scope

- Reviewed candidate: scoring-hardening commit `094642a` with docs-only `179255b`
  above it. Working tree clean at runtime code during all runs.
- Scoring-boundary delta fingerprint (sorted path + NUL + bytes over
  `eval/README.md`, `eval/provider-eval.mjs`, `lib/contracts.mjs`, `lib/process.mjs`,
  `test/provider-eval.test.mjs`, `test/process.test.mjs`):
  `4762ce894045f0ac2934f52143f354e477a6a51d5187abb7f28bea13b12ba1b6` (re-measured
  after every run; unchanged).
- Runtime: Node.js 24.21.0, Linux x86_64, `kernel.yama.ptrace_scope = 0`, no gdb
  (gcc used to build the review's own attach instrument), loopback-only provider
  transport.
- Scope: the four assigned questions — wrong-source scoring, candidate
  binding/serialization/stdin/receipt integrity, detached-process interference
  including same-uid ptrace. Out of scope: provider acceptance matrix (P0–P3),
  Node 22 gates, sandbox/worktree behavior.

## 2. Reproduction commands and retained fixtures

All fixtures are untracked review artifacts; the repository was never modified by
them.

- `/tmp/opencode/review-kit/e2e-attr.mjs` — provider-loop matrix. Modes:
  `positive` (control), `negative` (control), `swap` (file-substitution attack),
  `bait` (in-source spawn attempt). Run:
  `RV_MODE=<mode> node /tmp/opencode/review-kit/e2e-attr.mjs`; loot in
  `/tmp/opencode/review-kit/loot-<mode>/`.
- `/tmp/opencode/review-kit/ptrace-kit.c` / compiled `ptrace-kit` — same-uid attach
  tool with `scan`, `inject` and `forge` modes (`gcc -O2 -o ptrace-kit ptrace-kit.c`).
- `/tmp/opencode/review-kit/forge-replica.mjs` — sacrificial-replica receipt forgery
  (validates the primitive set on harness-owned processes only).
- `/tmp/opencode/review-kit/ptrace-driver.mjs` — live attack driver: spawns the
  runner, discovers the tap-form verification children spawned by **its own run only**
  (descendant check + eval-root cwd check), forges each, archives the runner report
  under `/tmp/opencode/review-kit/loot-live-forgery/`. Prior fixtures from the earlier
  sweep (`/tmp/opencode/e2e-variant.mjs`, `/tmp/opencode/vm-isolation.mjs`) remain
  referenced for the isolation evidence.

## 3. Expected versus observed

| Case                                                        | Expected                                                                         | Observed                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `positive` control (correct source, no interference)        | `taskSuccess true`                                                               | `taskSuccess true`, all checks pass                                                                                                                                                                                                                                    |
| `negative` control (wrong source, no interference)          | fail closed                                                                      | `taskSuccess false`, both gates `failed 1`, uncompleted assertion stamp                                                                                                                                                                                                |
| `swap` (wrong source + same-uid side-writer after apply)    | fail closed, scored bytes must be the approved bytes                             | **`taskSuccess true`, `ok true`, all checks pass** with proposal = wrong body                                                                                                                                                                                          |
| `bait` (in-source watcher spawned from the submitted bytes) | scoring VM inert; verdict fail                                                   | workspace-realm spawn DID execute (`bait-ran` marker from a test child); scoring VM inert (no marker, keepLast `[]` failed with `failed 1`); overall `taskSuccess false` but scoring gates accepted foreign bytes after the in-source watcher swapped the file mid-run |
| live scoring child ptrace (`ptrace-driver`)                 | receipt token unavailable to outside processes; forged output cannot earn a pass | token disclosed from child memory; forged block + `exit_group(0)` accepted. Both score gates report `ok true, passed 1` for the wrong body                                                                                                                             |

The `swap` run's evidence chain (loot `loot-swap/`):

- `proposals.json` — the only proposal is exactly the 47-byte wrong body
  (`proposalIsWrongBody: true`).
- `captured-on-disk-before-swap.txt` — the applied workspace bytes (same wrong body),
  captured at swap time by the side-writer.
- `swapped-at` — when and where the unauthorized rewrite landed.
- the runner's `report.json` — `taskSuccess true` with all checks pass afterward.

Code locations (tight, exact):

- `eval/provider-eval.mjs:538` — `finalState.source = readWorkspaceFile(workspace, ALLOWED_EDIT_PATH);`
  executed in `finally` **after the run**, then scored in lines 541–545. Any writer
  racing this read scores its own bytes.
- `eval/provider-eval.mjs:593` — `checks.edit` derives pass from
  `appliedPaths.includes(ALLOWED_EDIT_PATH) && authoritativeOk`, i.e. it never compares
  the scored bytes with the applied proposal bytes.
- `eval/provider-eval.mjs:222–231` — submitted bytes always evaluate in the
  null-prototype VM with import rejection; an in-source watcher cannot run at scoring,
  so the in-source vector is closed for scoring-time interference but NOT for
  spawning detached workspace children that survive the run (observed).
- `eval/provider-eval.mjs:320–348` (plan + `runTests`) and `lib/process.mjs` `runTests`
  — the scored child's stdout/stderr/exit status and the token-completed flag are the
  only hard facts; a same-uid ptrace attachment controls all of them (see Finding 2).

## 4. Findings, severity, locations, required repairs

### Finding 1 — no byte binding between the approved edit and the scored bytes (P1)

Observed: task-level success granted on a wrong proposed function via an unauthorized
rewrite of the workspace file (mode `swap`), and gate-level accept of foreign bytes in
mode `bait`. Repairs (implementer owns the choice; recorder notes only directions):

- Snapshot the approved proposal bytes (or a digest) at approval/apply time inside the
  evaluator's own event stream; at the `finally` read (line 538), fail closed unless
  the scored bytes equal, byte-for-byte, the last approved/apply-confirmed source.
- Record the applied digest in the report; any divergence yields an explicit
  `check` status (e.g. `bind: fail`) and blocks `taskSuccess` even when every other
  check passes.
- Consider also re-verifying the workspace test source/package sources against their
  seed digests at the same read (already byte-compared in lines 578–580 — the source
  read is the only unbound one).

### Finding 2 — same-uid ptrace breaks receipt/exit integrity of the scoring children (P1; previously only a documented residual, now live-verified)

Observed on this host, live, on children spawned by the committed flow itself:
`ptrace-kit forge` disclosed the exact 48-hex token from each scoring child's memory
and injected a forged passing block (ok 1 … # pass 1 … # fail 0 … token line) plus
`exit_group(0)`; the scoring parent then recorded `authoritative ok true, passed 1` and
`behavioral ok true, passed 1` in a negative-mode run with `proposalIsWrongBody: true`.
The sacrificial replica demonstrates the same primitive set accepted by a gate that
emulates the scoring composition (exit 0 + first-`#` summary counts + receipt line) on
a child that would honestly have failed.

Limitation record for this finding:

- Overall `taskSuccess` was not won by ptrace alone in the live runs: the
  workspace-agent verification gate (`outcome.result.verification`) remained `fail`
  in every ptrace-only run. The workspace gate's result plumbing (`lib/model-agent.mjs`
  2133–2154 and the session loop) needs a targeted follow-up if the full e2e claim is
  wanted; the gate-level forgery on the two scoring forms is the demonstrated part.
- Foreground: the finding class was already documented as a residual — this review's
  contribution is the live proof that the documented limit is exploitable as recorded
  (receipt token + counts + exit code) on the current host configuration.
- Repair directions (the implementer owns the choice; recorder notes directions only):
  - Make the scored child unattachable or worthless to attach: `prctl(PR_SET_DUMPABLE,
0)` on the test child (kills same-uid /proc memory and ptrace reach for that
    parent class), or run the scored child under a separate uid where sandboxing
    allows. Yama scope 1 would also limit attach to descendants, but that is a
    host-level control the evaluator cannot always assume.
  - Keep the receipt out of child-visible memory: the evaluator generates the token
    (line 282) and embeds it in the stdin script (line 303), so the child holds the
    plaintext; dispatch/second-factor mechanisms (the child asking the evaluator to
    confirm a nonce over a pipe the reader owns) would keep the proof in the
    evaluator's hands.
  - Even independent of ptrace, treat `exit_group` status and stdout as attacker
    writable by same-uid processes; the boundary would shift from "trust the child's
    facts" to "trust only facts the evaluator computed itself" — the far simpler
    direction is already followed by `authoritativeTestSource` (stdin generation);
    the same-class failure comes from the child's observable side channel.

### Non-findings (mechanisms that still fail closed)

- Scoring VM: submitted bytes are still inert-to-spawning in the VM (no `process`,
  no imports); `bait-ran` was produced only by the workspace realm.
- Fixed-path fixture decoys remain ignored (`mkdtemp authoritative-XXXX` keeps).
- In-VM per-mechanism hostility (accessor capture, toJSON substitution, intrinsic
  patch, freeze) fails closed as in the previous sweep — the new attempt matrix was
  re-run as part of `bait`/`negative` and the isolation helper remains in the kit.

## 5. Test results and remaining coverage gaps

- `node --test test/provider-eval.test.mjs test/process.test.mjs` → 40 pass / 0 fail /
  0 skipped (Node 24.21.0), run twice (start and end of the session).
- No repo code was modified in this review; the polarity of the suite result is as the
  last recorded full-gate run states them.
- Gaps (explicit):
  - Workspace-agent verification gate under ptrace: mechanism attempted, not
    achieved; needs targeted follow-up if the full-run claim requires it.
  - Node 22 parity of e2e loop not re-run (relying on the earlier recorded repair run).
  - Sandbox/worktree integration untouched per scope.

## 6. Summary of the assigned four questions

1. Can an incorrect submitted function produce `taskSuccess: true` / `ok: true`? —
   **Yes**: demonstrated via the file-substitution path (Finding 1), with the full run
   success state on record, and gate-level accept under the ptrace path (Finding 2).
2. Can submitted code replace the candidate binding, influence serialization, tamper
   with stdin-delivered scoring, or forge the completion receipt? — Candidate/snippet
   replacement, serialization and stdin tampering still fail closed (VM binding, no
   `process`; stdin reopens hit `ENXIO`); receipt forging IS achieved for the two
   scoring gates by same-uid ptrace on this host (Finding 2).
3. Can a detached process from the ordinary workspace test run interfere with scoring?
   — **Yes** (same-uid attach + prctl-free class): file-substitution and receipt
   forgery demonstrated; the `home` audit-dir race, fixed-path decoys and the scoring
   VM remain constrained by the design.
4. Is the ptrace residual concrete? — Now verified live rather than assumed.

PRV-105 stays SUBMITTED. This review is one assignee's evidence pass, not the
independent PRV-106 audit; dispatch and acceptance remain with the chief.
