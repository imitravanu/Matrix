# Independent Review — DUR-003 (Effect Reconciliation and Exact Undo)

**Review date:** 2026-11-05
**Reviewer:** Independent fresh-context review agent
**Repository:** `/home/mitravanu/matrix`
**Governing documents:** `AGENTS.md`, `docs/next-phase/REVIEW_METHOD.md`,
`docs/next-phase/AUDIT.md`, `docs/next-phase/AGENT_TASKS.md`,
`docs/next-phase/STATUS.md`, and `docs/next-phase/submissions/DUR-003.md`.
**Verdict:** **CHANGES REQUIRED**

No runtime code, host settings, or Git history were modified by this review. The only
repository file added is this report under `docs/next-phase/reports/`. The existing
`docs/next-phase/submissions/DUR-003.md` and `docs/next-phase/STATUS.md` entries remain
**SUBMITTED** pending repair and re-review; this review does not record an acceptance.

---

## 1. Candidate identity

- **Base Git HEAD:** `ff55a2c2aaeb863e881a5a8d0e112eb78ded0204`
- **Four-file owned candidate SHA-256:** `bf09eb9e751ad9819245356e4ad7520d79700da9d200a6597fd77afeac0b7775`
- **Six-file repair SHA-256 (includes `lib/pinned-write.mjs` and `test/pinned-write.test.mjs`):**
  `09be91e971ea4813d13ff34bc34d19f75331852ca2cd780e7add9ea95bc67e11`
- **Tracked patch digest (`git diff | sha256sum`):**
  `55a7efd0354c5ca56d271ec5a491c9d8651248d9032a778e7e0a6964913a24c3`

Both fingerprints match the values recorded in the submission exactly. Individual
SHA-256 values for the reviewed files:

| File                            | SHA-256                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `lib/goal-operations.mjs`       | `fdc2e72ce6716d1475ed280d995f09fbd7089158f6fe609716bde7bcc87095dc` |
| `lib/goal-recovery.mjs`         | `aa7afb439ec8e2afe8b36db33885ee07bb565b844ceb7647864032a83ad86a64` |
| `test/goal-operations.test.mjs` | `25c02164a47e4771cd7b5f35ee3efec6910095bee1fc7f13d4d2461cf430b14e` |
| `test/goal-recovery.test.mjs`   | `a6ac5810805ca101898c1bad2393d8b2ee7c21f448abc5dfdad39317efda11d9` |
| `lib/pinned-write.mjs`          | `d91ce27bb337b4570ea47ec198cb724ab221ab02c871703e517e825ae95c9f33` |
| `test/pinned-write.test.mjs`    | `0f56631b8e26f1ff16912bc666fe0500f365072333814afbe50bbdc124aaefcf` |

The unrelated dirty and untracked files in the working tree were preserved unchanged.

## 2. Scope and method

This review covers the DUR-003 boundary only: operation intents and recovery images,
read-only reconciliation, exact undo, dispatch binding, and the commit-time guards in
`applyEditOperation` and `applyExactUndo`. Controller/executor and production writer
integration remain DUR-005/DUR-004 and are **NOT EVALUATED** here.

The author's 854-test Node 22/24 evidence was inspected rather than re-run, as permitted.
The reviewer independently constructed fixtures under `/tmp/opencode/dur003-review/`
using temporary workspaces, the real store/lock modules, and no mock of the code under
review. All findings below were reproduced on both Node 24.21.0 (`/usr/bin/node`) and
Node 22.23.1. The author's focused suite also passes 46/46 on both runtimes; passing
tests do not cover the failures below.

## 3. Passing positive controls

The following claims were independently exercised and passed:

- Store-blob apply writes exact bytes and mode; a receipt-lost dispatch reconciles, is
  not executed twice, and reconstructs exact undo.
- Zero-byte creation and deletion restore the exact original state, including absence.
- Lease expiry during blob read and during temporary-file sync is refused, with staged
  temporary files removed and recovery blobs retained.
- Workspace root replacement during blob read, and parent replacement during temporary
  file sync, are refused with cleanup.
- External target drift and committed cancellation during blob read and temporary-file
  sync are refused with cleanup.
- Exact dispatch binding rejects changed target path, changed after-image/blob, and
  changed authority fields before any mutation.
- A real expired lease is refused even when the caller supplies an earlier `options.now`;
  a real second process is refused with and without a caller-supplied `options.owner`.
- Exact undo after normal edits and undispatched-intent provenance controls behave as
  specified when no later dispatched operation is hidden by an undispatched gap.

## 4. Blocking findings

### DUR-003-B1 — Reconciliation drops later dispatched effects after an undispatched intent

**Severity:** High
**Location:** `lib/goal-recovery.mjs:466-477` (the `dispatchedOps` loop and its `break`
at line 471).

**Trigger (deterministic, no race injection):**

1. Attempt 1 appends an edit intent `V0\n -> V1\n` for `target.txt` and is interrupted
   before dispatch.
2. Attempt 2 prepares a new edit `V0\n -> V2\n`, appends its intent and dispatch, applies
   it (`applyEditOperation` succeeds; disk becomes `V2\n`), and appends a **succeeded**
   receipt.
3. `reconcileGoalOperations(store, goalId)` is called.

**Observed:**

```text
disk "V2\n"
file { state: 'divergent', substate: 'matches-neither', sha256: <V2 hash>, ... }
applied 0 pending 2
ops [ { status: 'pending' }, { status: 'pending', receipt: true } ]
undo count 0
```

The second operation is genuinely dispatched, has a succeeded receipt, and its after
image exactly matches disk, yet it is classified pending and contributes no checkpoint.
The `break` at the first undispatched operation stops the chain before the later
dispatched operation is considered; the fallback `matchesUndispatchedAfter` check does
not recognize the later operation's after-image either.

**Consequence:** An earlier abandoned intent from an old attempt permanently hides every
later same-path dispatched effect. Exact undo is lost (`undo.count === 0`), and the
effect is reported as unreconcilable despite complete evidence on disk. This violates
CR-04 (recognize after image and reconstruct undo), CR-06 (current image reconciles
against ordered operation history), and the DUR-003 acceptance condition that every
exposed effect has a conservative defined outcome at every interruption point.

**Required behavior:** An undispatched intent must not terminate the reconciliation chain
for later dispatched operations. Continue scanning dispatched operations after a gap, or
reconcile per attempt and link attempts, while treating the undispatched gap as unknown.
A later operation with a committed dispatch and matching after image must still be
classified and must remain available for exact undo.

Reproduction: `node /tmp/opencode/dur003-review/stale-undispatched-with-receipt.mjs`.

### DUR-003-B2 — Cancellation committed during the final validation read is not rechecked

**Severity:** High
**Location:** `lib/goal-operations.mjs:641-660`. The `latest` snapshot is taken at line
642, `verifyBeforeImage()` (which performs the final target read at line 585) runs at line
649, and `assertOperationAuthority` runs at lines 655-660 using the stale `latest` goal and
lease. The mutation follows at line 664 (unlink) or line 668 (rename).

**Trigger:** Dispatch an edit, then inject `fs.readSync` so that during the final target
validation read the test commits `store.transition(..., "cancelled")` before returning
the target bytes. The delete variant does the same with a deletion intent.

**Observed (edit):**

```text
targetReads 4 cancelled true outcome { ok: true, sha256: ..., mode: 416, absent: false }
goal state after cancelled sequence 5
disk after "AFTER CANCELLATION\n" mode 640
temps []
```

The deletion variant returns `{ ok: true, sha256: null, mode: null, absent: true }` and
removes the target after the goal is already `cancelled`.

**Consequence:** A committed cancellation that lands after the `latest` snapshot but
during the final target read does not prevent the write or deletion. This violates CR-16
(no new action after the dispatch cutoff) and the submission's claim that committed
cancellation is handled through the commit boundary. The same stale-snapshot problem
applies to any fence advance that occurs during that read, not only cancellation.

**Required behavior:** Re-inspect the goal after the final target read and before the
rename/unlink, or make the final validation and mutation observe one atomic goal fence.
If the generation/sequence advanced, the goal became cancelled, or the lease/authority
changed, refuse, remove staged bytes, and leave the target untouched.

Reproductions: `node /tmp/opencode/dur003-review/cancel-final-read.mjs` and
`node /tmp/opencode/dur003-review/cancel-final-delete.mjs`.

### DUR-003-B3 — Residual read-to-commit window for target drift and undo drift

**Severity:** Medium
**Locations:**

- Edit/delete: `lib/goal-operations.mjs:585` (final validation read) and lines 664/668
  (unlink/rename).
- Undo: `lib/goal-recovery.mjs:880` (commit-time target read) and line 899 (unlink) or
  line 905 (`writePinnedAtomic`).

**Trigger:** Replace the target immediately after the final validation read returns its
bytes, but before the caller's rename/unlink (or, for undo, after its commit-time read).
No store or lock state is changed; only the target object is replaced.

**Observed:**

- Edit: external `"EXTERNAL\n"` mode `0600` was replaced by the operation's `"PLANNED\n"`
  mode `0640`; `applyEditOperation` returned `{ ok: true }`.
- Deletion: an external `"EXTERNAL DELETE TARGET\n"` file renamed into place during the
  validation read was unlinked by the delete operation.
- Undo: external `"EXTERNAL DURING UNDO\n"` renamed into place during undo's commit read
  was overwritten with `"ORIGINAL\n"`; undo returned `{ ok: true, restored: ['undo.txt'] }`.

**Consequence:** The claimed "validation immediately before rename/deletion" is not
atomic. An external replacement in the final read-to-commit window is silently
overwritten or deleted, contrary to CR-09/CR-14 and the DUR-003 requirement that changed
files remain untouched. The window is narrow but deterministic under injection and is
part of the same drift/cancellation family already under repair.

**Required behavior:** Make validation and replacement atomic, or detect the swap after
the fact and restore the displaced object. For example, exchange the staged file with the
target and verify the displaced bytes/mode before accepting the result (rolling back on
mismatch); for deletion, move the target to a quarantine name, verify it, then unlink.
Undo must use the same commit rule. If full atomicity is not achievable, the boundary
must state the residual race explicitly rather than claiming immediate pre-commit
validation.

Reproduction: `node /tmp/opencode/dur003-review/drift-final-read.mjs`.

## 5. Secondary observation (not counted as a blocker)

A failed receipt combined with disk bytes matching the after image is classified
`applied` and offered for undo, overwriting those bytes. Under the DUR-001 observable-
state model, matching after bytes prove state rather than authorship, so this is not
counted as a DUR-003 blocker. It is recorded because the classification is based on bytes
alone even when the operation is recorded as failed.

## 6. Verification evidence

- Independent reproductions were run on Node 24.21.0 and Node 22.23.1; outputs above are
  from Node 24 and were also reproduced on Node 22.
- Focused suite (`node --test test/goal-operations.test.mjs test/goal-recovery.test.mjs
test/pinned-write.test.mjs`): **46/46 pass, 0 fail, 0 skip** on both runtimes; logs at
  `/tmp/opencode/dur003-review/focused-24.log` and `focused-22.log`.
- Existing full-check logs `/tmp/matrix-dur003-commit-check24.log` and
  `/tmp/matrix-dur003-commit-check22.log` show **854/854 pass, 0 fail, 0 skip** on each
  runtime, with the recorded coverage floors met.
- No live provider calls, credentials, or host changes were used.

## 7. Verdict

**CHANGES REQUIRED** for DUR-003.

Candidate identity is verified and the repaired boundary passes the positive controls
above, but B1 (a deterministic reconciliation gap), B2 (a committed cancellation during
the final validation read), and B3 (a residual read-to-commit drift window) prevent
acceptance. B1 and B2 each independently violate the DUR-003 acceptance condition. The
submission should remain **SUBMITTED** and be resubmitted with regressions for these
cases and a fresh candidate fingerprint.

## 8. Not evaluated

- DUR-004 executor behavior and DUR-005 controller/production-writer integration.
- Live provider streaming, real model calls, and controller approval flows.
- Physical OS power loss, filesystem torn-page recovery, and non-Linux platforms.
- Performance or resource behavior outside the reviewed DUR-003 fixtures.
