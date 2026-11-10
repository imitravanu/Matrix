# Independent acceptance review — DUR-003 quarantine recovery repair

**Review date:** 2026-11-06
**Reviewer:** Independent fresh-context re-review agent
**Repository:** `/home/mitravanu/matrix`
**Governing documents:** `AGENTS.md`, `docs/next-phase/REVIEW_METHOD.md`,
`docs/next-phase/AUDIT.md`, `docs/next-phase/AGENT_TASKS.md` (DUR-003),
`docs/next-phase/DURABLE_PHASE.md`, `docs/next-phase/STATUS.md`,
`docs/next-phase/submissions/DUR-003.md`, and the earlier
[independent review](2026-11-05-dur003-independent-review.md).
**Verdict:** **ACCEPTED** for the implemented DUR-003 recovery boundary.

No runtime code, test, host setting or Git history was modified by this review. The
only repository changes are this report and the acceptance bookkeeping in
`submissions/DUR-003.md` and `STATUS.md`.

## 1. Candidate identity

All three expected identities were recomputed from the checkout and match exactly.

| Identity                          | Expected                                                           | Recomputed |
| --------------------------------- | ------------------------------------------------------------------ | ---------- |
| Six-file SHA-256                  | `b243209f0299f450f432fe93556bade953d5c0875c9a27af930f7d752df88f43` | match      |
| Four owned files                  | `c2a4651d870177a7d46c86c1508b69877fada35268ce405a9ba8f56460637eee` | match      |
| Tracked patch digest (`git diff`) | `0a23993ef6cf2b962244311df306572920fe1bbeca12471992023173bd98238d` | match      |

Base Git HEAD is `ff55a2c2aaeb863e881a5a8d0e112eb78ded0204`. Per-file SHA-256 values
for the current candidate:

| File                            | SHA-256                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `lib/goal-operations.mjs`       | `675f0a3641191792cd465d891fc067cad467337fb7232f960cb48c5d975f97a2` |
| `lib/goal-recovery.mjs`         | `d7bdd923ebbba61a0c9cf114931d663c392b27ffaeeac6d84dc402c794bb2e21` |
| `lib/pinned-write.mjs`          | `64b016aa412ac546f7ee5ebc8a803e1792704d78e02ada89fbecb7fe1bfe5098` |
| `test/goal-operations.test.mjs` | `a971194de1fd489934ed9e6e7f74ce5cbfd2f0170ca62c26474a5a32979e7487` |
| `test/goal-recovery.test.mjs`   | `cb33b082917a9785145b98f7bdb71d8007caab4885c86f930a784d89d11c8548` |
| `test/pinned-write.test.mjs`    | `2493242f7057ef73b005b7a4bae5536be8b9b5180b085bd208629d3b58a820a7` |

The six-file aggregate was recomputed after all review work and was unchanged.
The acceptance bookkeeping edits `STATUS.md` only and therefore changes the tracked
patch digest after the reviewed code candidate; the reviewed runtime code is still
identified by `b243209f0299…` and `0a23993ef6cf…`. After the bookkeeping edit the
tracked patch digest is `c2bad65c19196ae1c2d6ad521f6b9885739277f9098e4952732dc19d37b18d95`
(docs-only difference), while the six-file and four-file runtime identities remain
unchanged.

## 2. Scope and method

The review covers the DUR-003 library boundary: operation intents and recovery
images, read-only reconciliation, exact undo, dispatch/authority binding, and the
quarantine/verify/no-clobber commit protocol with retention. Controller/executor
integration, the production writer, CLI/UI and orchestration remain DUR-004/DUR-005/DUR-006
and are **NOT EVALUATED**.

Method: read the runtime code and the new tests (assertions, not names), reused the
recorded full-gate evidence where it postdates the last runtime edit, re-ran the
focused suite on both runtimes, re-ran the earlier reviewer's five reproduction
scripts, and constructed independent fixtures under `/tmp/dur003-rereview/`
(temporary workspaces, real store/lock/ops/recovery modules, real SIGKILL
subprocesses, fake keys — no credentials). The workspace and unrelated dirty files
were preserved.

Recorded gates reused (mtimes checked: last runtime edits 01:57–02:03, logs 02:05–02:06):

| Command                        | Result                                                 |
| ------------------------------ | ------------------------------------------------------ |
| `npm run check` (Node 24.21.0) | 906/906 pass, 0 fail, 0 skip; coverage floors met      |
| `npm run check` (Node 22.23.1) | 906/906 pass, 0 fail, 0 skip; coverage floors met      |
| `npm run eval`                 | 16/16 contract pass, 0 safety violations, Overall PASS |
| `npm run smoke`                | 32 frame checks across 4 geometries                    |
| `npm run pack:check`           | 95-file dry run, no tarball                            |
| `git diff --check`             | clean                                                  |

Fresh commands run by this review:

```sh
node --test test/goal-operations.test.mjs test/goal-recovery.test.mjs test/pinned-write.test.mjs
# Node 24.21.0: 98 pass, 0 fail, 0 skip
# Node 22.23.1: 98 pass, 0 fail, 0 skip
node /tmp/opencode/dur003-review/stale-undispatched-with-receipt.mjs   # applied 1, pending 1, undo 1
node /tmp/opencode/dur003-review/cancel-final-read.mjs                 # stale fence, target untouched
node /tmp/opencode/dur003-review/cancel-final-delete.mjs               # stale fence, target present
node /tmp/opencode/dur003-review/drift-final-read.mjs                  # changed during commit, external preserved
node /tmp/opencode/dur003-review/positive.mjs                          # exact undo / creation / deletion controls
node /tmp/dur003-rereview/{crash-phases,metadata,cleanup-rollback,ordering,gates,adversarial2,undo-variants,refusal-hygiene,after-image-ambiguity}.mjs
# all independent scripts report all checks passed on Node 24.21.0 and Node 22.23.1
```

The independent scripts cover 14 real-SIGKILL scenarios (write/delete/create/undo ×
capture-before-verify, verified-before-publish, published-before-cleanup, plus
creation staged/published and undo of creation/deletion), real subprocess probes for
retained paths, injected cleanup and publication failures, real store reopening, and
adversarial metadata.

## 3. Focus-area observations

1. **Transaction metadata is durable before capture and identifies the transaction.**
   `ordering.mjs` reads the manifest inside `beforeCapture`, `verifyDisplaced` and
   `beforePublish`: exactly one `.matrix-transaction-<32 hex>.json` exists with
   `schemaVersion`, `goalId`, `operationId`, `path`, `action`, `target`, `staged`,
   `displaced` and `phase`. At `beforeCapture` the phase is `pending`, the staging file
   exists, the quarantine name does not, and the target is still present. The phase is
   `pending` during displaced verification and `verified` at publication. A clean
   commit removes the manifest and both artifacts. Phase writes use the same
   atomic+fsync path.

2. **SIGKILL after capture, verification or publication is conservative for all four
   operation shapes.** In every scenario the target/quarantine bytes and modes are
   exact (including CRLF and no-final-newline), the path reconciles `uncertain`
   (`unresolved-commit`), `appliedOperations` is empty, continuation and undo are
   refused, retained paths exist, every unresolved commit is bound to goal, operation,
   path and action, and repeated inspection plus a reopened store produce identical
   evidence. A crash after a published write keeps the published target **and** the
   quarantined original; a crash after a published deletion keeps the quarantined
   original; creation crashes keep the staging bytes; undo crashes keep both the staged
   and displaced objects. A fresh process can read every retained path after the pinned
   descriptor closed.

3. **Unverified external bytes are not classified as completed effects.**
   A legacy `.matrix-commit-*.displaced` without a manifest yields `phase: "unknown"`,
   blocks resume and undo, and is never read or unlinked. The same holds when the
   legacy bytes equal the intended after image, and when a published-phase manifest
   coexists with an externally replaced target. In every case the artifact bytes are
   unchanged after inspection.

4. **Read-only inspection surfaces artifacts and gates unsafe work.** With a valid
   held workspace lock and live lease, a repeat `applyEditOperation` is refused with
   `unresolved commit artifacts require reconciliation before effects`, and
   `reconstructExactUndo` / `applyExactUndo` refuse. Inspection does not change the
   workspace inventory (names, sizes, modes, hashes) across three reconciles and two
   store reopenings. Corrupt, oversized, wrong-identity, wrong-target, wrong-phase,
   unsafe-path, symlink and FIFO manifests are refused conservatively without reading
   outside the workspace or blocking on a special file. Artifacts belonging to another
   goal are not claimed as this goal's manifest; when their displaced stem matches a
   local target they are surfaced as `unknown` evidence (conservative over-block).

5. **Cleanup failures are public and recovery remains possible.** Write, delete,
   create and undo all return `{ ok: true, cleanupPending: true, retained: [...] }`
   with canonical absolute paths (no `/proc`) that a fresh process can read after the
   pinned descriptor is closed. The retained set contains the marker plus the
   quarantine or staging artifact. `buildOperationReceipt(..., { effect })` reports
   `uncertainty.kind === "unknown-effect"` with a cleanup-pending detail. A reopened
   store surfaces the retained commit and blocks work and undo; after the operator
   removes the retained artifacts, reconciliation classifies the observable state and
   exact undo is available again. Marker-only cleanup failure is reported as a retained
   marker with no stranded displaced object. Clean refusals (stale fence during the
   final read, target replacement before capture) restore exact bytes and modes and
   leave no `.matrix-*` residue, so legitimate retries are not permanently blocked.

6. **Rollback preserves both objects and inspection never prunes evidence.** When a
   newer target appears before publication, `link(2)` refuses with EEXIST and the error
   carries `committed: false` and two retained paths; the newer target and the verified
   quarantined original both survive with their exact modes. The same dual preservation
   holds when displaced verification fails after another external replacement appears.
   When the path is free, verification refusal and injected non-conflict publication
   failure restore the original exactly and leave no artifacts. Inspection of
   interrupted commits does not alter, truncate or unlink any artifact.

The earlier review's three blockers remain repaired under the same independent
reproductions: B1 now reports `applied 1 / pending 1` with one undo entry, and B2/B3
refuse with the target bytes and mode untouched.

## 4. Findings

No P0, P1 or P2 findings. The following P3 items are follow-ons and do not weaken the
DUR-003 boundary.

- **P3-1 — Pre-manifest staging leftovers are invisible.** The staging file is created
  before the manifest. A crash in that window leaves an orphan
  `.matrix-integration-*.tmp`; `inspectGoalCommitArtifacts` only inventories
  `.matrix-commit-*.displaced` and `.matrix-transaction-*.json`, so the orphan is never
  surfaced or pruned. It contains only planned new bytes and the target is untouched,
  so this is a bounded resource leak, not an effect or evidence loss. Reproduction:
  `/tmp/dur003-rereview/gates.mjs` (staging-leftover case). Suggested follow-on: scan
  and report aged `.matrix-integration-*.tmp` files, or create the manifest before
  staging and record the planned name, without weakening the durable-before-capture
  ordering.
- **P3-2 — Operator runbook wording lags the implementation.** `submissions/DUR-003.md`
  section 5 says a crash after quarantine before publication reconciles as
  `missing/missing-expected`; on this candidate it reconciles as
  `uncertain/unresolved-commit` because the manifest is present. It also says exact
  undo "remains available when the target was published"; on this candidate
  `reconstructExactUndo` refuses until the operator clears the retained artifacts.
  The top section is correct; only the residual paragraph is stale. The operator
  procedure observed in this review is recorded in section 5 below.
- **P3-3 — Cross-goal over-block.** Artifact filenames are not goal-namespaced. An
  unresolved displaced artifact from another goal in the same directory is reported as
  `phase: "unknown"` for a target with the same basename stem and blocks that path until
  an operator removes it. This is conservative, not unsafe; a goal-scoped artifact
  namespace or a resolver would improve operability.
- **P3-4 — Corrupt/oversized metadata refusals are unstructured.** A malformed,
  oversized, wrong-identity or unsafe manifest makes reconciliation throw the raw
  parse/size/identity error. Work and undo are blocked and no artifact is touched, but
  the error does not list the retained paths. A structured `unresolved artifact`
  refusal would be more actionable.
- **P3-5 — Partial multi-entry undo errors drop earlier retention metadata.**
  `applyExactUndo` accumulates `retained` across entries but a later entry's thrown
  error does not include the earlier entries' retained paths. The earlier marker and
  quarantine remain on disk and the next reconciliation surfaces them, so this is a
  reporting completeness gap, not evidence loss.
- **P3-6 — Observable-state ambiguity (inherited, previously dispositioned).** If a
  refused commit restores external bytes that happen to equal the intended after image,
  reconciliation classifies the path `applied` and offers exact undo, because bytes
  prove observable state rather than authorship. This is indistinguishable from CR-04
  crash recovery and was explicitly recorded as a secondary observation, not a blocker,
  in the earlier review. Reproduction:
  `/tmp/dur003-rereview/after-image-ambiguity.mjs`.

## 5. Operator-recovery requirement

Unresolved transaction artifacts are never restored, pruned or resolved automatically.
The documented operator procedure for the implemented boundary is:

1. Read `reconcileGoalOperations(store, goalId).unresolvedCommits` (or
   `inspectGoalCommitArtifacts`) and preserve every `retained` path; it is the only
   recovery evidence and may contain the sole copy of displaced bytes if the store blob
   is unavailable.
2. Compare the manifest `phase`, `action`, `path`, `staged`, `displaced` and the
   retained object bytes/modes with the journal intent/dispatch/receipt and the current
   target.
3. If the target is absent and the quarantine holds the verified before image (crash at
   capture/verification), restore that object to the target, then remove the staging and
   manifest. Reconcile: the path returns to `pending`/`matches-before` and work resumes.
4. If the target exists with the after image and the quarantine holds the verified before
   image (crash after publication), record the evidence, remove the quarantine and
   manifest, then reconcile: the path is `applied` and exact undo from the store blob is
   available.
5. If the target holds unverified external bytes, do not overwrite them; leave the path
   divergent and take separate recovery action.
6. Never remove the quarantine before the store blob or another verified copy of the
   before image is confirmed.

There is no in-product resolve/prune command in this candidate; that belongs to the
executor/controller and CLI integration (DUR-004/DUR-005/DUR-006) and is **NOT
EVALUATED** here. The current behavior is a safe stop, not silent continuation.

## 6. Not evaluated

- DUR-004 executor behavior and DUR-005 controller/production-writer integration; no
  controller, approval, budget or real executor path was exercised.
- CLI/UI resume/undo surfaces (DUR-006) and any operator command for resolving artifacts.
- Physical OS power loss, filesystem torn-page recovery, and non-Linux platforms.
- Live provider streaming, real model calls and evaluation baselines.
- Same-user adversarial replacement of a quarantine or manifest between verification and
  publication (the protocol does not claim protection against a hostile writer inside
  the workspace directory).
- `applyExactUndo` goal authority/cancellation semantics beyond the held workspace lock
  (undo is a user recovery action; lease/generation wiring belongs to DUR-005).
- Multi-file orchestration beyond the existing recorded partial-work regressions.

## 7. Verdict

**ACCEPTED** for DUR-003's implemented recovery boundary on candidate
`b243209f0299f450f432fe93556bade953d5c0875c9a27af930f7d752df88f43`
(four owned files `c2a4651d870177a7d46c86c1508b69877fada35268ce405a9ba8f56460637eee`,
tracked patch `0a23993ef6cf2b962244311df306572920fe1bbeca12471992023173bd98238d`)
at base `ff55a2c`.

The candidate satisfies the DUR-003 acceptance condition — every exposed effect has a
conservative, inspectable outcome at every interruption point tested on Linux/Node 22
and 24 — with the operator-recovery requirement in section 5 and the P3 follow-ons
above. The earlier B1/B2/B3 blockers are repaired and persist under the same
independent reproductions. No P0/P1 finding is outstanding and no mandatory matrix
criterion in scope failed.
