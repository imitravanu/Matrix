# Independent review — matrix `ff55a2c` (PRV-106 scoring isolation)

Reviewer: independent fresh-context review. No repository code was modified,
committed, pushed, or rebased. Prior reports were treated as context, not evidence.

## 1. Exact candidate identity

- Repository: `/home/mitravanu/matrix`
- Branch: `matrix/engineering-hardening`
- HEAD: `ff55a2c2aaeb863e881a5a8d0e112eb78ded0204`
- Commit date: `2026-11-02 22:58:49 +0530`
- Subject: `Enforce Bubblewrap test runner isolation and proposal-bound edit verification (PRV-105/PRV-106)`
- Worktree: pre-existing `M docs/next-phase/STATUS.md` and untracked
  `docs/next-phase/reports/2026-11-02-prv106-audit.md`. Concurrent DUR-001 work
  (`docs/next-phase/decisions/DUR-001.md` and
  `test/goal-lock-spike.test.mjs`) appeared at 14:18 and was left untouched.
  This review added only its own report. `git diff HEAD --` over tracked
  `eval`, `lib`, and `test` paths is empty; the eight scoring-boundary files
  are byte-identical to HEAD.
- `git merge-base --is-ancestor 179255b115937c5888cc69cff5b6383b87712da4 HEAD`
  exits 0. The `IDENTITY.md` snapshot was taken from that earlier HEAD plus an
  uncommitted delta; the committed candidate contains the same eight file bytes,
  so the snapshot binds to `ff55a2c`.

### Eight-file fingerprint (working tree, re-verified at end)

```
d631b2eed08b2da323dd0462da8005c8a9f58e7d5c0df91b58d28ec0fbc41262  eval/README.md
8179136d661d30ebafa96008af9f4d6926bea2eb164b02aef5e493269b26ec0f  eval/provider-eval.mjs
d49482d6020d8e718b65f96df20dc6c66f1f260c14e8ab3fcd3b0424debb8c28  lib/contracts.mjs
40b518f7e036bf939cdb0e7848348298b97c13291dfa95e980dfd26123cd26e5  lib/controller.mjs
7dc2525706984d6f93e2480b02896df4f5ebad11c2064609d5c85c61ebfab83a  lib/model-agent.mjs
151b42971198b7d73ac9cb905fe3bd9356746913c8200aeb79b18b7507a74e50  lib/process.mjs
7431e91a095814bd25dbc45cce6dcce92fdcf6b06d7286d9c383dd6263eadecf  test/provider-eval.test.mjs
81812b3a392fef916216c0a6d3e1f503e3352e5c309974e126b4fa5089aea499  test/process.test.mjs
```

Aggregate: `6d83a01c3d264e96f78b48109619cd19b8b8fa8c5c0d87a5defb83031e18d70e`,
computed as `sha256(concat(sorted(path, NUL, bytes)))` over the eight files.
The eight per-file hashes are the binding evidence; they all match `IDENTITY.md`.
The aggregate is method-dependent. I did not reproduce the earlier `6c1eb2...`
value with this method.

Environment: primary runtime Node `v24.21.0` (`/usr/bin/node`), Linux
`7.0.12+kali-amd64`, `kernel.yama.ptrace_scope=0`, bubblewrap `0.13.1`, gcc
`16.2.0`. Node `v22.23.4` was also tested: the official
`node-v22.23.4-linux-x64.tar.xz` was downloaded from
`https://nodejs.org/dist/v22.23.4/`, its SHA-256
`1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce` matched the
published `SHASUMS256.txt`, and it was extracted under
`/tmp/opencode/node22/node-v22.23.4-linux-x64/`. Every run used fresh temporary
workspaces and an isolated `MATRIX_HOME`; provider traffic was loopback-only
with a fake bearer credential.

## 2. Verdict

- **Repaired proposal-binding / file-substitution family: PASS within the tested
  scope.** Post-approval replacement and workspace-test rewrite fail closed;
  positive and negative controls discriminate; Bubblewrap-unavailable fails
  closed; approval, audit, cancellation, and cleanup hold.
- **Same-uid ptrace against the scoring children: P1 residual under the tested
  threat model.** A source that passes the workspace gate but is behaviorally
  wrong under the import-free scoring VM reached `taskSuccess: true` with every
  check `pass` after a same-uid ptrace forgery of both scoring receipts. The
  candidate does not close this. `eval/README.md:153-156` explicitly documents
  that scoring is not sandboxed from hostile same-user host processes, so this is
  a documented boundary as well as a real acceptance ceiling. It should be
  dispositioned explicitly, not reported as "no findings."
- **Node 22 regression half: run.** The focused provider-eval/process suite
  passes `43/43` under Node `v22.23.4`; one full `npm run check` passed
  `757/757` (including a concurrent DUR-001 test; the candidate-only count is
  756), and a repeat had one unrelated `provider-catalog` flake. This holds
  when `npm` resolves under `/usr` so Bubblewrap can execute it. With the Node
  tarball's own `npm` on `PATH` (outside `/usr`), 7 provider-eval tests fail
  because `npm-cli.js` is not mounted into the sandbox; that is a separate P2
  external-runtime portability limitation, not a Node 22 language regression.

**Overall: CHANGES REQUIRED (P1) if same-uid host attackers are in scope; otherwise
PASS WITH DOCUMENTED RESIDUALS on the repaired file-substitution family: the
same-uid scoring boundary (P1 if in scope) and non-`/usr` Node/npm layouts (P2).**

## 3. P1 finding: ptrace forgery launders a behaviorally wrong source to full success

### Attack source

`conditional-slow` passes the workspace test by branching on
`typeof process !== "undefined"` and returns the wrong array under the
import-free scoring VM.

### Baseline (no forgery): scoring gate does its job

`RV_MODE=conditional-slow` without the forge:

```json
{
  "mode": "conditional-slow",
  "taskSuccess": false,
  "ok": false,
  "checks": {
    "target": { "status": "pass" },
    "edit": { "status": "fail" },
    "test": { "status": "pass" },
    "package": { "status": "pass" },
    "scope": { "status": "pass" },
    "verification": { "status": "fail" },
    "cleanup": { "status": "pass" }
  },
  "outcome": { "ok": true, "status": "success", "error": null },
  "verification": { "status": "verified", "ok": true, "passed": 1, "failed": 0 },
  "authoritative": {
    "ok": false,
    "status": "fail",
    "passed": 0,
    "failed": 1,
    "auditStatus": "complete"
  },
  "behavioral": {
    "ok": false,
    "status": "fail",
    "passed": 0,
    "failed": 1,
    "auditStatus": "complete"
  }
}
```

This is the key control: the workspace verification passes, both scoring gates
fail. The source is wrong for scoring, not merely a different byte sequence.

### With forgery: full success

`RV_MODE=conditional-slow node e2e-attacks.mjs`, then
`./forge <eval-pid> 2 300` attached to both scoring children:

```json
{
  "mode": "conditional-slow",
  "taskSuccess": true,
  "ok": true,
  "checks": {
    "target": { "status": "pass" },
    "edit": { "status": "pass" },
    "test": { "status": "pass" },
    "package": { "status": "pass" },
    "scope": { "status": "pass" },
    "verification": { "status": "pass" },
    "cleanup": { "status": "pass" }
  },
  "outcome": { "ok": true, "status": "success", "error": null },
  "verification": { "status": "verified", "ok": true, "passed": 1, "failed": 0 },
  "authoritative": {
    "ok": true,
    "status": "pass",
    "passed": 1,
    "failed": 0,
    "auditStatus": "complete"
  },
  "behavioral": {
    "ok": true,
    "status": "pass",
    "passed": 1,
    "failed": 0,
    "auditStatus": "complete"
  },
  "cleanup": { "rootRemoved": true, "controllerDisposed": true }
}
```

Forge output (verbatim, token truncated):

```
found scoring child pid=1865939
token in map 0x1f3822ec0000-0x1f3822f00000 anon
token pid=1865939 matrix-behavior-complete-90a54022...
forged output written pid=1865939 bytes=162
hijacked syscall to exit_group pid=1865939 status=0
found scoring child pid=1865949
token in map 0x162bc1a40000-0x162bc1a80000 anon
token pid=1865949 matrix-behavior-complete-95dbb69f...
forged output written pid=1865949 bytes=162
hijacked syscall to exit_group pid=1865949 status=0
forged 2/2
```

### Why `checks.edit` does not catch it

`eval/provider-eval.mjs:651-659` defines `checks.edit` as the conjunction of:

1. `appliedPaths` contains `src/bounds.js`,
2. `finalState.sourceBytes` equals the last approved/applied source, and
3. `authoritativeOk` (both scoring gates).

Here the final bytes **do** equal the approved source, and the forged scoring
gates supply (3). The binding predicate is satisfied legitimately; the only
independent behavioral check was forged. This is not a post-approval byte swap.
It is a composed "workspace-test evasion + scoring-receipt forgery" attack.

### Mechanism and boundary

`runAuthoritativeVerification` generates the per-run completion token
(`eval/provider-eval.mjs:284`), writes the inline test to the child's stdin, and
spawns a plain same-uid host child with `process.execPath` and
`--test-reporter=tap` (`:300-316`). The result-phase calls at `:600-604` are not
wrapped by `linux-bwrap`; the agent's own verify path at `:560-582` is. The
direct audit probe confirms `processBackend:"host"` for the scoring execution.
With `ptrace_scope=0`, a same-uid host process can read the token from the
child's memory, write a passing TAP block, and substitute `exit_group(0)`.

This contradicts the untracked audit's generalized ceiling:

> "Forgery alone cannot launder a wrong source end-to-end; the agent-side gate is
> the ceiling." (`docs/next-phase/reports/2026-11-02-prv106-audit.md:184-189`)

That statement is true only for a source that fails byte binding. It is false for
an approved, workspace-passing source that is behaviorally wrong under scoring.
The audit's C3c observation was a different cell (wrong bytes failing
`checks.edit`); the ceiling does not generalize.

`eval/README.md:153-156` says:

> "Scoring itself is not sandboxed from other hostile host processes running as
> the same user: the boundary isolates workspace test code, not pre-existing host
> malware."

So the candidate's own documented threat model excludes this attacker. Under
that exclusion, the finding is a documented residual. If the acceptance claim is
"`taskSuccess` certifies behavior under adversarial same-uid host processes," it
is a P1 acceptance failure. Both readings should be recorded; "no findings"
without qualification is not supportable.

Repair direction (not implemented): route the result-phase scoring children
through the same Bubblewrap snapshot runner as the agent verify path, or run
scoring under a separate uid / hardened `ptrace_scope`. Add a binding-only check
and report the approved/scored digests so the two properties are auditable
separately.

## 4. Repaired substitution family: evidence

Positive control: correct source, all checks pass, `taskSuccess: true`,
`authoritative`/`behavioral` `pass 1/0`, `auditStatus:"complete"`, cleanup
`rootRemoved:true`, `controllerDisposed:true`.

Negative control: wrong source, `taskSuccess:false`, `checks.edit:"fail"`,
`checks.verification:"fail"`, both scoring gates `fail 0/1`; cleanup pass.
Negative-alt also fails closed.

`swap-before-test` (replace `src/bounds.js` after approval, before the workspace
test): replacement bytes pass workspace verification and both scoring gates, but
`checks.edit:"fail"`, `taskSuccess:false`, `tempDirs:[]`, cleanup pass. Because
both scoring gates pass, this is a clean demonstration that the binding check,
not a scoring failure, caught the substitution.

`swap-after-apply`: authoritative/behavioral pass, verification fails,
`checks.edit:"fail"`, `taskSuccess:false`.

`sandbox-rewrite`: the workspace test successfully rewrote its private snapshot
`src/bounds.js` (`PRV106_REWRITE_OK 46`), but the live scored bytes stayed
unchanged; all checks pass, `taskSuccess:true`, `tempDirs:[]`. The workspace
test cannot alter the source that scoring reads.

Interpretation: the recorded post-approval substitution family is repaired. The
binding is to the last approved/applied proposal, and the scoring read is of the
live final bytes, not a workspace-test-controlled snapshot.

## 5. Bubblewrap fail-closed and sandbox boundary

Bubblewrap-unavailable test: under `unshare -Ur -m`, a fake `/usr/bin/bwrap`
exits 127. Preflight throws:

```
provider evaluation requires the Linux test sandbox: sandbox policy probe failed: exit 127 · fake bwrap: unavailable
```

`requestCount: 0`; no provider request was made. The normal bwrap probe passes
and normal runs work. This is genuine fail-closed behavior, not a fallback.

Workspace-test sandbox probe (from inside the test):

- host scoring PID not visible (`ESRCH`), `/proc/<pid>` absent,
  `kill(pid,0)` `ESRCH`, `pidfd_open` `ESRCH`, `/proc/<pid>/mem` `ENOENT`;
- host network `ECONNREFUSED`; `/home` write `ENOENT`; `/proc/1/root` write
  `EROFS`; `core_pattern` write `EACCES`;
- host marker absent; host victim alive.

A ptrace probe launched from the workspace test could not see the host scoring
children or recover a token. The sandbox is effective against model-controlled
workspace code. The P1 attack above is host-side same-uid interference, outside
that sandbox, which matches the README boundary.

## 6. Approval, audit, cancellation, cleanup

Approval denial (`deny-test` proposing `test/bounds.test.mjs`):
`approval:result decision:"n"`, `applied:0`,
`deniedPaths:["test/bounds.test.mjs"]`, `checks.scope:"fail"`,
`outcome:"denied"`, cleanup pass. The denied edit never applies.

Allowed-path approval: `decision:"y"`, the authorized `src/bounds.js` edit
applies and passes.

Audit direct probe: `execution:start` / `execution:end`,
`processBackend:"host"`, `trustDecision:"allow-flag"`,
`auditStatus:"complete"`. The audit contains no source text, completion token, or
fake credential value. The `processBackend:"host"` field is also the clearest
evidence that scoring children are not Bubblewrap-wrapped.

Cancellation at 1500 ms during a slow workspace test: elapsed 1537 ms,
`outcome.status:"aborted"`, `verification.status:"aborted"`,
`authoritative`/`behavioral` `status:"aborted"`, `auditStatus:"not-started"`,
`cleanup {rootRemoved:true, controllerDisposed:true}`, `tempDirs:[]`, no
relevant leftover processes.

Cleanup after a hostile sandbox run: `tempDirs:[]`, `hostMarkerOnHost:false`,
`hostVictimAlive:true`, detached `sleep 12345` gone. Earlier `tempDirs`
pollution was traced to a concurrent `npm run check`, not candidate cleanup;
isolated reruns were clean.

## 7. Engineering gates

### Node 24.21.0

- `npm run check`: exit 0; 756 tests, 756 pass, 0 fail, 0 skipped; coverage
  94.18% lines / 84.12% branches / 94.62% functions; all per-file floors pass;
  syntax checked 177 `.mjs` modules. This was the candidate-only tree before
  the concurrent DUR-001 test appeared.
- `node --test test/provider-eval.test.mjs test/process.test.mjs`: 43 pass,
  0 fail, 0 skipped, ~14.9 s.
- `npm run eval`: exit 0; 16 cases, 16 contract pass, 0 safety violations,
  baseline PASS.
- `npm run smoke`: exit 0; 32 frame checks across 4 geometries.
- `npm run pack:check`: exit 0; 90 files, 314448 bytes packed (dry-run), nothing
  published.
- `git diff --check`: exit 0.

### Node 22.23.4

The tarball's `bin/node` was symlinked alone into `/tmp/opencode/node22-bin`;
`npm` was left to resolve as `/usr/bin/npm`
(`/usr/share/nodejs/npm/bin/npm-cli.js`), whose `#!/usr/bin/env node` then used
the Node 22 binary. This keeps the npm CLI under `/usr` where Bubblewrap mounts
it.

- `PATH=/tmp/opencode/node22-bin:$PATH node --version` → `v22.23.4`.
- `PATH=/tmp/opencode/node22-bin:$PATH node --test test/provider-eval.test.mjs test/process.test.mjs`:
  43 tests, 43 pass, 0 fail, 0 skipped, ~14.2 s.
- The same focused command in a clean detached worktree at `ff55a2c`:
  43 tests, 43 pass, 0 fail, 0 skipped, ~14.1 s.
- `PATH=/tmp/opencode/node22-bin:$PATH npm run check`: one clean run exited 0
  with 757 tests, 757 pass, 0 fail, 0 skipped; coverage 94.21% lines / 83.94%
  branches / 94.64% functions; all per-file floors pass; syntax checked 178
  `.mjs` modules. The 757/178 counts include the concurrent DUR-001
  `test/goal-lock-spike.test.mjs`; the candidate-only counts measured under
  Node 24 were 756 tests and 177 modules.
- A repeat full check after the report edits produced 756/757 with one
  unrelated failure: `test/provider-catalog.test.mjs:561` ("a body read
  rejected by the deadline is recorded as a failed refresh") hit
  `Cannot read properties of null (reading 'outcome')` at `:593`. That test
  passed alone under Node 22 (`1/1`, 32.6 ms). All 43 provider-eval/process
  tests passed in both full runs. The catalog test is outside the eight
  candidate files; I did not attribute the flake to this candidate.
- Node 22 does not change the P1 ptrace result; that attack is a same-uid host
  process issue independent of the Node version.

The nested workspace verification inside Bubblewrap still executes
`/usr/bin/node` (v24.21.0), because the sandbox clears the environment and
fixes `PATH=/usr/bin:/bin`. The outer suite, the focused provider-eval tests,
and the host-spawned scoring children ran Node 22; the sandboxed workspace test
command itself did not.

### Node 22 external-npm portability (P2)

With the tarball's own `npm` first on `PATH`, the same focused command fails
7 of 43 tests, and the full check fails 7 of 757:

```text
PATH=/tmp/opencode/node22/node-v22.23.4-linux-x64/bin:$PATH \
  node --test test/provider-eval.test.mjs test/process.test.mjs
# tests 43
# pass 36
# fail 7
```

The nested workspace verification reports:

```text
bwrap: execvp /tmp/opencode/node22/node-v22.23.4-linux-x64/lib/node_modules/npm/bin/npm-cli.js: No such file or directory
```

`linuxBwrapArguments` mounts `/usr` read-only and, only when the plan's exact
executable is the running Node binary, mounts `realpath(process.execPath)`
(`lib/linux-bwrap.mjs:164-172`). Here the test plan's executable is
`npm-cli.js`, which lives outside `/usr` in the tarball/nvm layout, so it is
not mounted. The result is a real portability limitation for Node/npm installed
under `nvm`, `asdf`, a tarball prefix, or similar: provider-eval workspace
verification fails closed rather than running. I did not determine whether this
predates `ff55a2c`; `lib/linux-bwrap.mjs` is not one of the eight candidate
files. It is P2 only for that external-runtime case; the distro `/usr` layout
passes.

## 8. Scope limits

- Single host, single user, `ptrace_scope=0`; results for the ptrace attack do
  not automatically generalize to hardened hosts or separate-uid scoring.
- Loopback fake provider and fake credential only; no live-provider,
  availability, quality, pricing, or latency claim.
- I did not independently re-test the other audit's unverified cells (overfit
  behavioral vectors, invoker-name disclosure, large payload, provider-count
  lies). They remain context, not evidence here.
- The workspace-test sandbox probe covers model-controlled code; the P1 attack
  is a separate same-uid host process, explicitly outside that boundary.
- Node 22 counts are working-tree counts: 757 tests/178 modules include the
  concurrent DUR-001 test. The candidate-only focused suite is 43 tests. The
  full candidate-only count (756/177) was measured under Node 24 before that
  file appeared, not remeasured under Node 22.
- Node 22 coverage is not a fully Node-22 execution of the nested workspace
  test: Bubblewrap fixes `PATH=/usr/bin:/bin`, so the workspace test's `npm`
  runs `/usr/bin/node` v24.21.0. The outer suite and the host-spawned scoring
  children did run Node 22.
- The P2 external-npm result was reproduced with the official Node 22 tarball
  under `/tmp`; I did not test a real `nvm`/`asdf` install, though the path
  layout is the same class.
- Evidence retention: the original review kit under `/tmp/opencode/prv106-kit`
  was lost when `/tmp/opencode` was recreated on 2026-11-04 13:10. The Node 22
  binaries and check outputs were placed under the same `/tmp/opencode` root
  and were lost when it was recreated again at 14:54. The quotations and
  exact command results above are from the captured run output; the static
  candidate hashes and git state were re-verified after both losses. Original
  artifacts are not available for third-party replay.

## 9. Recommendation

1. Accept the proposal-binding/substitution repair for the recorded family: it
   passes the controls and the Bubblewrap/approval/audit/cancel/cleanup checks.
2. Do not accept "no findings" without qualification. Record the same-uid ptrace
   end-to-end counterexample as a P1 under the tested threat model, or formally
   accept the README's same-uid exclusion and correct the audit's generalized
   "cannot launder a wrong source end-to-end" claim.
3. If the evaluator is meant to certify behavior under local hostile processes,
   require result-phase scoring to run under Bubblewrap or a separate uid before
   acceptance. If not, make the boundary a first-class acceptance condition.
4. Add a binding-only check and expose approved/scored digests; `checks.edit`
   currently conflates binding with `authoritativeOk`, so `edit:fail` alone does
   not identify which predicate failed.
5. Record the Node 22 result as `43/43` focused and `757/757` full under the
   `/usr` npm layout. Treat the external-npm failure (7/43; 7/757) as a P2
   portability item and either mount the resolved npm CLI file beside the Node
   binary or document that provider evaluation requires a `/usr`-mounted
   Node/npm installation.
