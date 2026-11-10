# Independent Re-Review: DUR-005 November 8 Repair

- **Date:** 2026-11-08
- **Task:** `DUR-005` — Approval Scope, Process Containment, and Audit Boundaries
- **Repository:** `/home/mitravanu/matrix`
- **Base Git commit (`HEAD`):** `ff55a2c2aaeb863e881a5a8d0e112eb78ded0204`
- **Tracked working-tree patch SHA-256 (`git diff | sha256sum`):** `3dfb09ebb9f221b3506d4aed4a2388efbd12c161f4407dbf0a7640ba78a94c3e`
- **23-file candidate aggregate SHA-256:** `4b15217e3c93037c3590c35bb6b019deb87e8bb67592665f4ab0c1755552cc72`
- **Verdict:** **`CHANGES REQUIRED`**

---

## 1. Executive summary

The November 8 repair substantially addresses the November 7 findings. Independent
counterexamples confirm that:

- the interrupted-dispatch recovery receipt now settles the prior attempt's
  reservation and prevents a goal from completing with an unobserved dispatch;
- every ordinary writer tested (`runLocalAgent`, `runModelAgent`,
  `publishIntegrationIntent`) now threads the selected Matrix home and refuses a
  workspace owned by a durable goal;
- closed-gate and journal-only dispatches, and expired unreclaimed leases, now
  block ordinary writers and recover conservatively;
- a legacy process-group record can no longer certify a detached `setsid()`
  child as stopped;
- workspace rename/replacement recovery and forged cross-workspace attestations
  behave as required;
- edit grants now bind the attempt, generation, plan/before image, resolved
  mode and workspace, and pause/grant state is reset between attempts.

However, one same-invariant writer-exclusion gap remains, and the coverage-gate
remediation is incomplete:

1. **Finding 3 residual (`P2`, corrupt/partial state):** `findBlockingDurableGoal`
   returns `null` immediately when `home/goals` is absent
   (`lib/goal-lease-probe.mjs:501-502`), before it scans the independent
   `home/ownership` registry (`:524`). An unreconciled ownership record for this
   workspace therefore blocks ordinary writers when `home/goals` exists (even
   empty), but is silently ignored when `home/goals` is missing. A live detached
   child recorded in that ownership file survives while
   `withWorkspaceWriteLock` admits the writer. This is the same
   ordinary-writer-exclusion requirement as Finding 3, so Finding 3 is
   **not fully closed**.
2. **Finding 7 residual (`P3`, gate hygiene):** the two digest-table typos are
   corrected, and floors for the six core modules now pass, but five
   durable-goal modules explicitly named in the November 7 finding still have no
   `COVERAGE_THRESHOLDS` entry (`lib/goal-recovery.mjs`,
   `lib/goal-operations.mjs`, `lib/goal-budget.mjs`, `lib/goal-context.mjs`,
   `lib/goal-lock.mjs`). Their current coverage is healthy, so this is a gate
   completeness issue rather than a runtime defect.

Engineering gates remain green on the exact candidate: focused durable-runtime
tests pass `135/135` on Node `v24.21.0`, and the full coverage run passes
`996/996` with every enforced floor met. The submission's Node `v22.23.1`
`996/996` evidence is reusable because the 23-file aggregate and tracked patch
digest match exactly.

**Recommendation:** `CHANGES REQUIRED` for the Finding 3 corrupt-state fail-open.
The fix is small: scan the ownership registry before, or independently of, the
`home/goals` existence check, and add a regression for the ownership-only state.
Finding 7's remaining five floors can be completed in the same pass.

---

## 2. Candidate identity and fingerprint verification

### 2.1 Repository state

| Check                    | Command                    | Observed value                                                     | Matches the November 8 submission? |
| ------------------------ | -------------------------- | ------------------------------------------------------------------ | ---------------------------------- |
| Base commit              | `git rev-parse HEAD`       | `ff55a2c2aaeb863e881a5a8d0e112eb78ded0204`                         | Yes                                |
| Patch hygiene            | `git diff --check`         | Exit `0`, no output                                                | Yes                                |
| Tracked patch digest     | `git diff \| sha256sum`    | `3dfb09ebb9f221b3506d4aed4a2388efbd12c161f4407dbf0a7640ba78a94c3e` | Yes                                |
| 23-file aggregate digest | Sorted paths + NUL + bytes | `4b15217e3c93037c3590c35bb6b019deb87e8bb67592665f4ab0c1755552cc72` | Yes                                |

The working tree remains dirty/untracked exactly as the repair candidate
describes. No runtime code, host setting or Git history was modified during this
review.

### 2.2 Current 23-file per-file hashes

These are the current values, not the historical November 7 table:

| File                                         | SHA-256                                                            |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `docs/next-phase/fixtures/dur005-driver.mjs` | `14565da8647b20812a7b13dbd5cfdff7439efbaad34cbb9e227f355786e70796` |
| `lib/controller.mjs`                         | `b2836e9fc4a0463609db83d44f0b4bc55c76e9666d99ddf74f7f308b90993ade` |
| `lib/doctor.mjs`                             | `0ca92cf1dcbb7813d26e72800125150776c73bdfcfddb74dcf3e37bb7c3ecd5c` |
| `lib/goal-containment.mjs`                   | `29908757200a68098ec332539aaf519025fc072d1afa21a9c657332b2bc49089` |
| `lib/goal-context.mjs`                       | `d80f5bdee740b6c1a71b19edbf76c9c5a938ade79e6a47ebd6ca51374dec6d6b` |
| `lib/goal-contracts.mjs`                     | `ac78d7b06d59a728b910b9bca41ca3d63be7c5063813479e90642127a288e282` |
| `lib/goal-executor.mjs`                      | `afa0d90bc7c08cdc25963098373b186354c58a62b8346f176f8522a7fe74e9d7` |
| `lib/goal-guardian.mjs`                      | `91a04353a9035f5bdf17ff8d1d9edb23c320c628517efa2adf103187487ee9f1` |
| `lib/goal-lease-probe.mjs`                   | `2cb08b9c25d8dbf7df3d616299c4a9d1ddde0c83e4c004a3d831b1aeb2a3147e` |
| `lib/goal-lock.mjs`                          | `d87eb7f851bbc0eed4feacf21cb1332a7ce1d80e43d4a7e452ecc97cd78e39cf` |
| `lib/goal-operations.mjs`                    | `bc686426e88593e17a0a038e9e21d0b9e9e6aa2dc568e68f0e23ae182456f128` |
| `lib/goal-policy.mjs`                        | `b56f138fdffd1daec56438884c1ff59cd00e4f37359f6ac70404b3edc9dccd18` |
| `lib/goal-recovery.mjs`                      | `648558c83e434966bae91a95160864b7b5fd80c03f50173e8ec6e6445f83337d` |
| `lib/goal-store.mjs`                         | `2bd63d548e9995cdd47a53d3f7523061379bd244c2f594f4c8b05cf3f24205f9` |
| `lib/integration-publication.mjs`            | `c4dfa50fbae746d2b63347108cb9ed3287ebde92f89465cfe25d706ee6323743` |
| `lib/local-agent.mjs`                        | `8de74f151ed3ed942574828dac3bd9044bf950d2be52e09433efddab37ee8211` |
| `lib/model-agent.mjs`                        | `c3196726fc7dd87b7a3bf19ecf2210180fdcc88f27afd2b1817e1ff098d995c2` |
| `lib/parallel-run.mjs`                       | `050366ef00760c8f9e9a23903a8ea75c38872ca8bee0dcd481d9108d8d305893` |
| `lib/workspace.mjs`                          | `9e2f51670247f41d719ab7fc980fe5d33064442f0b178765918e7857bfe4a35b` |
| `scripts/build-pidfd-helper.mjs`             | `042ada69ce553443989c58e8b5d8f66902fe797b9c7415c9971dc8816d5fc3cc` |
| `scripts/check-coverage.mjs`                 | `afe281e6f88de1e49a31c58a89e319a06168c182a0738498757b5870abdf3ef2` |
| `scripts/matrix-pidfd-helper.c`              | `d94dbece62ceae6a2e70e5e9ff509a8b0d69f437d646564545b3cd295d5a5e74` |
| `test/goal-runtime.test.mjs`                 | `e856a0fb1bfc4a2a5a707104944d3376ab011920795bc9d2fddc28ee00d1448a` |

### 2.3 Historical November 7 table

The per-file table at `docs/next-phase/submissions/DUR-005.md:95-112` is the
**November 7 candidate** table. The repair corrected the two malformed values:

- `lib/local-agent.mjs` is now a 64-character value matching the pre-repair file
  (`7e4a46a2a4240fbfc2453ede40a7c725aa82571c6dfc0ef0729b2c1012bad3df`), not
  the current `8de74f15...` repair file.
- `scripts/matrix-pidfd-helper.c` is now the correct 64-character value
  (`d94dbece62ceae6a2e70e5e9ff509a8b0d69f437d646564545b3cd295d5a5e74`), which
  also matches the current file.

The table is therefore typo-corrected but **historical**: eight of its fourteen
entries no longer identify the current candidate. The authoritative identity for
the November 8 repair is the 23-file aggregate above. This is a documentation
follow-on, not a runtime finding.

---

## 3. Method and independent fixtures

The review used only repository modules through absolute imports, temporary
`MATRIX_HOME` directories, temporary workspaces, fake credentials, and real Linux
subprocesses. No runtime code was edited, no host setting was changed, and no Git
history was touched; the only repository addition is this report. The independent
scripts were run from a temporary review directory
(`/tmp/opencode/dur005-rereview/`, removed after the review); each created its
own temporary home/workspace, and the detached children and leftover fixtures
were removed after use.

The review read:

- `/home/mitravanu/matrix/AGENTS.md`
- `docs/next-phase/REVIEW_METHOD.md`
- `docs/next-phase/reports/2026-11-07-dur005-acceptance-review.md`
- the November 8 repair section of `docs/next-phase/submissions/DUR-005.md`
- the repaired implementations in `lib/goal-executor.mjs`,
  `lib/goal-store.mjs`, `lib/goal-policy.mjs`, `lib/goal-containment.mjs`,
  `lib/goal-lease-probe.mjs`, `lib/workspace.mjs`, `lib/local-agent.mjs`,
  `lib/model-agent.mjs`, `lib/integration-publication.mjs` and
  `scripts/check-coverage.mjs`.

---

## 4. Verification results

### 4.1 Engineering gates

| Check                                          | Command                                                                                                                   | Result                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Focused durable-runtime suite, Node `v24.21.0` | `node --test test/goal-runtime.test.mjs test/goal-executor.test.mjs test/goal-store.test.mjs test/goal-recovery.test.mjs` | `135/135` pass, `0` fail                                      |
| Full coverage gate, Node `v24.21.0`            | `npm run coverage`                                                                                                        | exit `0`; `996/996` tests; every enforced floor passed        |
| Coverage summary                               | from `npm run coverage`                                                                                                   | `93.24%` lines / `83.30%` branches / `94.86%` functions       |
| Submission `npm run check`, Node `v24.21.0`    | submission evidence; candidate fingerprints match                                                                         | exit `0` (syntax, ESLint, tsc, Prettier, coverage); `996/996` |
| Submission `npm run check`, Node `v22.23.1`    | submission evidence; candidate fingerprints match                                                                         | exit `0`; `996/996`; every floor passed                       |
| Patch hygiene                                  | `git diff --check`                                                                                                        | clean                                                         |

Enforced floors and observed values on the exact candidate:

| Module                     | Floor (line/branch/functions) | Observed              |
| -------------------------- | ----------------------------- | --------------------- |
| `lib/goal-contracts.mjs`   | `90/75/100`                   | `100.00/97.39/100.00` |
| `lib/goal-policy.mjs`      | `65/55/80`                    | `83.47/65.65/94.32`   |
| `lib/goal-containment.mjs` | `80/55/80`                    | `83.22/58.00/81.82`   |
| `lib/goal-guardian.mjs`    | `70/25/60`                    | `85.95/33.33/87.50`   |
| `lib/goal-lease-probe.mjs` | `85/65/90`                    | `94.01/79.31/96.43`   |
| `lib/goal-executor.mjs`    | `85/75/90`                    | `88.64/79.43/93.48`   |
| `lib/goal-store.mjs`       | `85/70/90`                    | `99.78/97.72/100.00`  |

### 4.2 Independent counterexamples

| Script     | Finding / mechanism                                                        | Observed                                                                                                                                                                          | Result         |
| ---------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `ce1.mjs`  | F1 original: real `SIGKILL` after edit effect, before receipt; resume      | recovered goal `completed`; recovery receipt sequence `9`, status `uncertain`; reserved tools `0`; no success evidence claimed                                                    | PASS           |
| `ce1b.mjs` | F1 alternate: interrupted `provider` dispatch                              | `completed`; `receiptSequence: 6`, status `uncertain`; reserved rounds/requests `0`; used rounds/requests `1`                                                                     | PASS           |
| `ce2.mjs`  | F2: local agent, model agent, integration publication with `{ home }`      | all three refused with the durable-goal unverified-execution blocker; target files unchanged; no undo entry                                                                       | PASS           |
| `ce3.mjs`  | F3 original: closed gate, journal-only dispatch, expired unreclaimed lease | closed gate blocked writer; recovery `gate-not-released`, reserved `0`; journal-only `unresolved-dispatch` then safe-stop `teardown-unverified`; expired lease `active-lease`     | PASS           |
| `ce4.mjs`  | F4: legacy process-group record with live detached child                   | escaped child still alive; fresh verification `containment-unverified`; cached `reconciliation-mismatch`; lease probe `surviving-execution-unverified`                            | PASS           |
| `ce5.mjs`  | F5: rename old-first/new-first, replacement, forged attestation            | both rename orders and replacement recover via `gate-not-released`; forged cross-workspace attestation `ownership-workspace-mismatch`; original goal rejects replacement identity | PASS           |
| `ce6.mjs`  | F6: mode drift, content drift, pause/grant replay                          | mode drift (`0o644` → `0o755`, `mode:null`) denied; content drift denied; pause does not latch; no writes                                                                         | PASS           |
| `ce7.mjs`  | F2/F3 alternate: same-process live lease, second goal                      | ordinary writer refused by `active-lease`; second goal refused by `another goal owns the workspace`; after cancellation the second goal starts                                    | PASS           |
| `ce8.mjs`  | F3 residual: ownership record without `home/goals`                         | writer admitted while recorded detached child alive; same record blocks when an empty `home/goals` exists                                                                         | **REPRODUCED** |

### 4.3 Finding details

#### Finding 1 — Unobserved dispatch and budget settlement

- **Original trigger:** `SIGKILL` after an `edit` effect (or a `test`/`provider`
  dispatch) and before the receipt; a successor attempt completes with
  `receiptSequence: null` and leaked `counters.reserved`.
- **Repair path:** `lib/goal-executor.mjs:1877-1891` settles every unobserved
  dispatch after teardown/recovery; `lib/goal-store.mjs:750-788` writes a
  durable `recovery-receipt` with `status: "uncertain"` and settles the
  reservation without success evidence.
- **Independent result:** `ce1.mjs` shows the prior edit dispatch receiving a
  recovery receipt at sequence `9`, status `uncertain`, reserved tools `0`;
  `ce1b.mjs` shows the same for a `provider` dispatch. Completion no longer
  hides an unobserved dispatch. In the `ce1` fixture the remaining
  `activeMs: 29999` is the provider round's unspent maximum-time reservation
  (`PROVIDER_RESERVATION.activeMs` minus the 1 ms observed), not a stuck
  interrupted edit; the edit's tool slot and its 15000 ms reservation were
  released.
- **Disposition:** **FIXED**.

#### Finding 2 — Ordinary writers must use the selected home

- **Original trigger:** `runLocalAgent`, `runModelAgent` and
  `publishIntegrationIntent` did not pass `{ home }`, so they probed the default
  `~/.matrix` and could overwrite a workspace leased in the selected home.
- **Repair path:** `lib/local-agent.mjs:533,747`,
  `lib/model-agent.mjs:1623,1746`, and
  `lib/integration-publication.mjs:104` pass `{ home: backupHome }` / `{ home }`.
- **Independent result:** `ce2.mjs` observes all three paths refusing with the
  durable-goal blocker (`reason: surviving-execution-unverified`); target bytes
  are unchanged. `ce7.mjs`
  additionally shows that a same-process ordinary writer is refused while a
  live checkpoint lease exists, and that a second goal in the same process is
  refused by the store's workspace reservation.
- **Disposition:** **FIXED**.

#### Finding 3 — Pre-`onPin`/journal-only writer exclusion

- **Original triggers:** (a) an abort/pause/timeout/`SIGKILL` in the pre-`onPin`
  window left a `teardown-unverified` journal dispatch with no ownership record,
  blocking recovery forever while ordinary writers remained admitted; (b) a
  journal-only `teardown-unverified` dispatch was invisible to the probe; (c) a
  crashed `running` goal with an expired lease and unreceipted edit was ignored
  by the probe.
- **Repair path:** the runtime now stages a closed-gate ownership record before
  launch (`lib/goal-policy.mjs:851-873`), so a stopped pre-`onPin` dispatch has a
  durable record that can be settled with `gate-not-released`; the probe is
  journal-aware (`lib/goal-lease-probe.mjs:538-580`); any live or
  expired-but-unreclaimed lease blocks (`active-lease`).
- **Independent result:** `ce3.mjs` shows the staged closed-gate record blocking
  the ordinary writer and recovering with `gate-not-released` and reserved `0`;
  the pre-repair journal-only dispatch (no ownership record) blocks with
  `unresolved-dispatch` and safe-stops with `teardown-unverified`; the expired
  lease blocks with `active-lease`.
- **Residual:** `ce8.mjs` reproduces a same-requirement fail-open in a
  corrupt/partial home: with `home/goals` absent and an unreconciled
  `home/ownership/<operation>.json` for the workspace, the early return at
  `lib/goal-lease-probe.mjs:501-502` skips the ownership scan at `:524`, and
  `withWorkspaceWriteLock` admits the writer while a recorded detached child is
  still alive. Creating an empty `home/goals` makes the same record block with
  `surviving-execution-unverified`, so the behavior is inconsistent and not
  fail-closed.
- **Disposition:** **STILL OPEN (partial; P2 residual)**. The three reported
  reproductions are fixed, but the same ordinary-writer-exclusion invariant is
  still bypassable in the corrupt-state case. This is not an unrelated new
  requirement; it is the remaining mechanism for the same claim.

#### Finding 4 — Containment binding in `verifyTeardown`

- **Original trigger:** a non-contained process-group record whose leader exited
  after spawning a detached `setsid()` child was certified `{ verified: true }`.
- **Repair path:** `lib/goal-policy.mjs:1413-1428` rejects a non-contained
  record with `containment-unverified`; `:1496-1529` requires the reconciled
  record to bind the same containment/namespace and helper digest.
- **Independent result:** `ce4.mjs` keeps the detached child alive, then gets
  `freshVerified: false` (`containment-unverified`) and `cachedVerified: false`
  (`reconciliation-mismatch`); the lease probe also blocks with
  `surviving-execution-unverified`.
- **Disposition:** **FIXED**.

#### Finding 5 — Rename and replacement recovery

- **Original trigger:** `verifyTeardown` required both path and `(dev, ino)`
  equality, permanently bricking a goal after a workspace rename or
  replacement.
- **Repair path:** `lib/goal-policy.mjs:1474-1494` accepts a recorded workspace
  when either the path matches or the device/inode match, while still rejecting
  an identity that matches neither; the operation workspace binding is checked
  separately.
- **Independent result:** `ce5.mjs` completes both rename orders and the
  replacement case via `gate-not-released`; a forged cross-workspace
  attestation returns `ownership-workspace-mismatch`; the original goal rejects
  the replacement identity.
- **Disposition:** **FIXED**.

#### Finding 6 — Approval binding and per-attempt reset

- **Original trigger:** edit grants omitted `planHash`/before image, resolved
  mode, generation, attempt/operation and workspace; a `0o644` → `0o755` change
  with `mode:null` consumed a stale grant; pause latched across `resume()`.
- **Repair path:** `lib/goal-policy.mjs:301-315` validates the full binding;
  `:525-600` registers and authorizes exact edit/test grants including
  `planHash`, `attemptId` and `generation`; `:2008` resets
  `controlState.request` in the `finally` of `resume()`.
- **Independent result:** `ce6.mjs` denies both the mode-drift and content-drift
  attempts (`needs-attention`, `tool-denied`, original bytes unchanged); pause
  leaves `pendingAfterPause: 0`, the next attempt is denied, and pause does not
  latch.
- **Disposition:** **FIXED**.

#### Finding 7 — Digest typos and coverage floors

- **Original trigger:** two malformed SHA-256 values in the November 7 table,
  and no `COVERAGE_THRESHOLDS` entries for the durable-goal runtime modules.
- **Repair result:**
  - The two table values are now valid 64-character hashes and match the
    pre-repair files. The table is historical (see §2.3).
  - `scripts/check-coverage.mjs:6-13` enforces floors for
    `goal-contracts`, `goal-policy`, `goal-containment`, `goal-guardian`,
    `goal-lease-probe`, `goal-executor` and `goal-store`; all pass.
  - Five modules explicitly named in the November 7 finding still have no
    floor: `lib/goal-recovery.mjs` (`83.32/83.25/100.00`),
    `lib/goal-operations.mjs` (`96.56/82.39/100.00`),
    `lib/goal-budget.mjs` (`91.79/85.71/93.33`),
    `lib/goal-context.mjs` (`95.39/83.05/100.00`) and
    `lib/goal-lock.mjs` (`96.12/76.47/100.00`).
- **Disposition:** **STILL OPEN (partial; P3)**. The typo half is fixed and the
  core floors are enforced; the gate is not yet complete for all named modules.

---

## 5. Disposition table

| #   | November 7 finding                            | Original severity | Disposition              | Remaining work                                                                                                                       |
| --- | --------------------------------------------- | ----------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Unobserved dispatch / budget leak             | P1                | **FIXED**                | None                                                                                                                                 |
| 2   | Ordinary writers bypass home-scoped exclusion | P1                | **FIXED**                | None                                                                                                                                 |
| 3   | Pre-`onPin` / journal-only writer exclusion   | P1                | **STILL OPEN (partial)** | P2 corrupt-state fail-open: scan ownership when `home/goals` is absent; add regression                                               |
| 4   | Non-contained teardown certified              | P1                | **FIXED**                | None                                                                                                                                 |
| 5   | Rename/replacement bricks teardown            | P2                | **FIXED**                | None                                                                                                                                 |
| 6   | Stale edit grants / latched pause             | P2                | **FIXED**                | None                                                                                                                                 |
| 7   | Digest typos / coverage gate omissions        | P3                | **STILL OPEN (partial)** | Add floors for `goal-recovery`, `goal-operations`, `goal-budget`, `goal-context`, `goal-lock`; label or refresh the historical table |

No finding was left `NOT EVALUATED`.

---

## 6. Remaining blocker: Finding 3 residual (`P2`)

### Location

- `lib/goal-lease-probe.mjs:501-502`:
  `const goalsDir = join(home, "goals"); if (!existsSync(goalsDir)) return null;`
- `lib/goal-lease-probe.mjs:524`: the ownership scan
  (`findUnresolvedOwnership`) is reached only after that early return.

### Reproduction

The independent `ce8` probe (a temporary review fixture, now removed):

1. Creates a temporary private `MATRIX_HOME` with a workspace.
2. Spawns a real detached child (`node -e 'setInterval(...)'`) and records its
   exact `pid`, `/proc/<pid>/stat` start time and boot id in a valid
   `home/ownership/operation_....json` record bound to the workspace. The record
   is intentionally unreconciled and has no containment/namespace (the legacy
   process-group shape that Finding 4 also covers).
3. Leaves `home/goals` absent.
4. Calls `withWorkspaceWriteLock(workspace, ..., { home })`.

Observed:

```text
REPRODUCED ce8: missing goals/ admitted a writer while detached pid 2112381 was alive;
the same record blocks when goals/ exists
```

The script writes `bypass-1` inside the workspace while the child is alive. It
then creates an empty `home/goals` directory and repeats the same write; the
same ownership record now throws with
`blocker.reason === "surviving-execution-unverified"`.

This is not a speculative state: `home/goals` and `home/ownership` are created by
the same runtime, and a partial restore, manual cleanup, or filesystem corruption
can leave one without the other. The probe's own policy with `home/goals`
present is to block on an unreconciled ownership record; the early return makes
that policy depend on an unrelated directory's existence.

### Required behavior

An ordinary writer must not be admitted while an unreconciled ownership record
matches the workspace, regardless of whether `home/goals` exists. If the goal
store is absent and the ownership record cannot be reconciled through the normal
goal path, the writer should fail closed with a clear corrupt-state or
surviving-execution refusal rather than silently proceeding.

### Acceptance proof

- Move the ownership scan before the `home/goals` existence check, or run it
  independently and merge the result.
- Add a regression that creates a private home with an unreconciled ownership
  record and no `goals/` directory, and asserts that
  `withWorkspaceWriteLock` refuses (preferably with
  `surviving-execution-unverified` or an explicit corrupt-state error).
- Re-run `ce8.mjs` and the focused suite; the writer must be refused in both the
  missing-goals and empty-goals cases.

---

## 7. Non-blocking follow-ons

1. **Finding 7 coverage completeness (`P3`):** add the five missing
   `COVERAGE_THRESHOLDS` entries. Suggested floors with current headroom:
   `goal-recovery` `80/75/95`, `goal-operations` `90/75/95`,
   `goal-budget` `85/75/90`, `goal-context` `90/75/95`, `goal-lock` `90/70/95`.
   The exact values are the implementer's choice; they must pass on both Node 22
   and Node 24.
2. **Historical table (`P3` documentation):** the November 7 per-file table is
   typo-corrected but no longer identifies the November 8 files. Either label it
   explicitly as the November 7 candidate or add the current 23-file per-file
   table to the repair section.
3. **Cleanup:** the review left no runtime changes. Temporary fixtures and
   detached children created during the review were removed/terminated; see §9.

---

## 8. Verdict

**`CHANGES REQUIRED`.**

The November 8 repair fixes the original Finding 1, 2, 4, 5 and 6 reproductions
and the three reported Finding 3 triggers. It does not fully close Finding 3:
the same ordinary-writer-exclusion invariant still fails open in the
ownership-only corrupt state described in §6. Finding 7 is also partial, though
its remaining gap is a P3 gate-completeness issue.

The remaining Finding 3 fix is small and localized; after it, the candidate
should be re-reviewed against `ce8.mjs`, the focused suite, and the full coverage
gate. The Finding 7 floors can be completed in the same pass.

---

## 9. Scope limits and cleanup

- **Not evaluated:** physical power loss, non-Linux platforms, live providers,
  real paid engine runs, DUR-006 CLI/UI continuation, and migration of arbitrary
  pre-repair states that never persisted a closed-gate record. The submission's
  own limitation ("a pre-repair interrupted launch with missing ownership
  evidence remains blocked") is consistent with the safe-stop behavior observed
  in `ce3.mjs`.
- **Node 22:** the full `996/996` Node `v22.23.1` run was not repeated; it is
  reused from the submission because the 23-file aggregate and tracked patch
  digest match exactly. The independent focused/coverage runs were on Node
  `v24.21.0`.
- **Cleanup:** all independent scripts used temporary homes/workspaces under
  `/tmp`; detached children were terminated and their process groups checked.
  The review did not modify repository runtime code, host settings, or Git
  history.

---

## Appendix A — Key commands

```sh
cd /home/mitravanu/matrix
git rev-parse HEAD
git diff --check
git diff | sha256sum

# 23-file aggregate (sorted paths, NUL separators, raw bytes)
{
  for f in \
    docs/next-phase/fixtures/dur005-driver.mjs \
    lib/controller.mjs \
    lib/doctor.mjs \
    lib/goal-containment.mjs \
    lib/goal-context.mjs \
    lib/goal-contracts.mjs \
    lib/goal-executor.mjs \
    lib/goal-guardian.mjs \
    lib/goal-lease-probe.mjs \
    lib/goal-lock.mjs \
    lib/goal-operations.mjs \
    lib/goal-policy.mjs \
    lib/goal-recovery.mjs \
    lib/goal-store.mjs \
    lib/integration-publication.mjs \
    lib/local-agent.mjs \
    lib/model-agent.mjs \
    lib/parallel-run.mjs \
    lib/workspace.mjs \
    scripts/build-pidfd-helper.mjs \
    scripts/check-coverage.mjs \
    scripts/matrix-pidfd-helper.c \
    test/goal-runtime.test.mjs; do
    printf '%s\0' "$f"
    cat "$f"
  done
} | sha256sum

# Focused durable-runtime suite
node --test \
  test/goal-runtime.test.mjs \
  test/goal-executor.test.mjs \
  test/goal-store.test.mjs \
  test/goal-recovery.test.mjs

# Full coverage gate
npm run coverage

# Independent probes were run from a temporary review directory (removed after
# the review). The exact outputs are recorded in Appendix B.
```

## Appendix B — Counterexample outputs

```text
CE1 PASS
CE1B PASS
CE2 PASS
CE3 PASS
CE4 PASS
CE5 PASS
CE6 PASS
PASS ce7: same-process live lease refuses ordinary writers and a second goal
REPRODUCED ce8: missing goals/ admitted a writer while detached pid 2112381 was alive;
the same record blocks when goals/ exists
```
