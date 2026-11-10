# Independent Verification: DUR-005 Follow-Up Findings 3 and 7

- **Date:** 2026-11-08
- **Task:** `DUR-005` — remaining parts of Findings 3 and 7 in the November 8 follow-up repair
- **Repository:** `/home/mitravanu/matrix`
- **Base Git commit (`HEAD`):** `ff55a2c2aaeb863e881a5a8d0e112eb78ded0204`
- **23-file candidate aggregate SHA-256:** `17c6992a5a507b301d3297f69ce598cdf0046ef0078081d8f4b5e15a032aea02`
- **Tracked working-tree patch SHA-256 (`git diff | sha256sum`):** `f8598a668cd9a25bc4d5d13aa5baf65bf224fa901615b8a707e315b85f1d295a`
- **Verdict:** **`ACCEPT`**

---

## 1. Scope and reused evidence

This review independently checked only the remaining parts of Findings 3 and 7
from `docs/next-phase/reports/2026-11-08-dur005-repair-re-review.md` §6–7.

The candidate fingerprints match the follow-up submission exactly, so this
review reuses:

- the submitter's `997/997` `npm run check` results on Node `v22.23.1` and
  Node `v24.21.0`, including the coverage gate;
- the earlier independent verdicts for the five already-closed findings
  (Findings 1, 2, 4, 5 and 6).

No runtime code, host setting or Git history was modified. The only repository
addition is this report, which is untracked and outside the 23-file candidate
list.

## 2. Candidate identity

| Check                | Expected                                                           | Observed            |
| -------------------- | ------------------------------------------------------------------ | ------------------- |
| Base commit          | `ff55a2c2aaeb863e881a5a8d0e112eb78ded0204`                         | Same                |
| 23-file aggregate    | `17c6992a5a507b301d3297f69ce598cdf0046ef0078081d8f4b5e15a032aea02` | Same                |
| Tracked patch digest | `f8598a668cd9a25bc4d5d13aa5baf65bf224fa901615b8a707e315b85f1d295a` | Same                |
| Patch hygiene        | `git diff --check`                                                 | Exit `0`, no output |

The aggregate uses the sorted relative paths, NUL separators and raw file bytes
listed in the follow-up submission. Compared with the `4b15217e3c93` repair
candidate in re-review §2.2, 20 of 23 per-file hashes are unchanged. The only
three changed files are the ones required by this follow-up:
`lib/goal-lease-probe.mjs`, `scripts/check-coverage.mjs` and
`test/goal-runtime.test.mjs`.

## 3. Finding 3 — ownership-only writer exclusion

The previous early return on a missing `home/goals` is gone. The probe now
treats a missing goals directory as an empty list and always reaches
`findUnresolvedOwnership` before it can return `null`
(`lib/goal-lease-probe.mjs:501-538`).

Independent fixture: a private temporary `MATRIX_HOME`, workspace and unrelated
workspace; a real detached Node child (`spawn(..., { detached: true })`); and one
valid, unreconciled `home/ownership/operation_*.json` record written by
`createExecutionOwnership().recordDispatch` for that live child and workspace.
No reconciliation record was created.

| Runtime    | `home/goals` | Ordinary write result                     | Target bytes | Child alive | Unrelated workspace |
| ---------- | ------------ | ----------------------------------------- | ------------ | ----------- | ------------------- |
| `v24.21.0` | Missing      | Refused: `surviving-execution-unverified` | Not created  | Yes         | Write succeeded     |
| `v24.21.0` | Empty        | Refused: `surviving-execution-unverified` | Not created  | Yes         | Write succeeded     |
| `v22.23.1` | Missing      | Refused: `surviving-execution-unverified` | Not created  | Yes         | Write succeeded     |
| `v22.23.1` | Empty        | Refused: `surviving-execution-unverified` | Not created  | Yes         | Write succeeded     |

Each refusal was bound to the recorded operation ID
(`operation_ce86677844184ecfa6cdf61c9226e8cf` on Node 24,
`operation_b0630360f73b4ad9b6bb9c29aa718f80` on Node 22). The repository
regressions also pass `2/2` on both runtimes:

```text
✔ an ownership record blocks its workspace without blocking unrelated workspaces
✔ a live detached execution blocks its workspace with a missing or empty goals directory
```

The detached children were killed through their process groups and the
temporary homes/workspaces were removed.

## 4. Finding 7 — coverage floors and historical table label

The five previously missing floors are present in `COVERAGE_THRESHOLDS` and are
used by `runCoverage` through the default `evaluateCoverage(report)` call
(`scripts/check-coverage.mjs:6-18,220-241`):

| Module                    | Added floor (line/branch/functions) | Earlier observed on the same module bytes |
| ------------------------- | ----------------------------------- | ----------------------------------------- |
| `lib/goal-recovery.mjs`   | `80/75/95`                          | `83.32/83.25/100.00`                      |
| `lib/goal-operations.mjs` | `90/75/95`                          | `96.56/82.39/100.00`                      |
| `lib/goal-budget.mjs`     | `85/75/90`                          | `91.79/85.71/93.33`                       |
| `lib/goal-context.mjs`    | `90/75/95`                          | `95.39/83.05/100.00`                      |
| `lib/goal-lock.mjs`       | `90/70/95`                          | `96.12/76.47/100.00`                      |

The observed values are from the re-review's full coverage run. The module bytes
are unchanged: the four modules in the 23-file list match re-review §2.2, and
`lib/goal-budget.mjs` still matches its DUR-004 hash
(`c8f1759ad42f78feb70020f864ab9e1c5f45c3cc9b6157e1f7138ee0e50bfc92`).

A focused gate check confirmed each floor is live: metrics exactly at the floor
are accepted, while lowering any line, branch or function value by `0.01`
produces the corresponding per-module failure. The check passes on Node 24 and
Node 22.

The historical hash table is now explicitly labeled at
`docs/next-phase/submissions/DUR-005.md:96`:

```text
Per-file SHA-256 values for the historical November 7 candidate:
```

## 5. Recommendation

**`ACCEPT`.** The remaining parts of Findings 3 and 7 are closed on candidate
`17c6992a5a50`: an unreconciled live ownership record refuses ordinary writers
with both a missing and an empty `goals/` directory while leaving unrelated
workspaces writable, and all five coverage floors plus the November 7 table
label are in place. The reused `997/997` engineering results and the earlier
verdicts for Findings 1, 2, 4, 5 and 6 stand.
