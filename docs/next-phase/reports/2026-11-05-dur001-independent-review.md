# Independent Review — DUR-001 (Goal Contracts, State Machine, and Linux Writer-Lock Spike)

**Review Date:** 2026-11-05\
**Review Target:** DUR-001 under `docs/next-phase/`\
**Reviewer:** Independent audit agent (fresh review context).\
**Repository:** `/home/mitravanu/matrix`\
**Governing Documents:** `AGENTS.md`, `docs/next-phase/REVIEW_METHOD.md`, `docs/next-phase/ARCHITECTURE.md`, `docs/next-phase/AUDIT.md`, `docs/next-phase/STATUS.md`, and `docs/next-phase/decisions/DUR-001.md`.

No runtime code, host settings, or Git history were modified. The only repository file added by this review is this report document under `docs/next-phase/reports/`.

---

## 1. Candidate Identity & Reproducible Fingerprints

- **Git HEAD:** `ff55a2c2aaeb863e881a5a8d0e112eb78ded0204` (`Enforce Bubblewrap test runner isolation and proposal-bound edit verification (PRV-105/PRV-106)`)
- **Branch:** `matrix/engineering-hardening`
- **Dirty Tracked Files in Working Tree:**
  - `MATRIX.md` (SHA-256: `9782d78b3fc40fa0ae1d4452c7634d4cfbf0be1b6d7c3bc262e5577feb5bb617`)
  - `NEXT_PHASE.md` (SHA-256: `b2b505648591bc68354c9d2b94e9575856bf3dbea6ea26d13e2fa03c9698c78e`)
  - `README.md` (SHA-256: `d3697d540b27a2522992148bfd081e55f686404324b376f0ff78aedd038af70c`)
  - `docs/next-phase/DURABLE_PHASE.md` (SHA-256: `11fd7f2d90a57533bd5e36ac5e0ae1f5640f4f67e4b5c270d966697ac449fa0b`)
  - `docs/next-phase/STATUS.md` (SHA-256: `c00dec517df5856b1b683eda61d0578bc1be9df36791c2fcf2a3dd7b0948d803`)
  - `eval/README.md` (SHA-256: `8d5c3cd4555df9dca38cd0e8870750d71a271fcd3ece8d8fcbc8f4a377d3e816`)
  - `eval/provider-eval.mjs` (SHA-256: `8c7826aa96a974a27c1a62844e9e77631d690e72a5c8200df21d8f994e960dde`)
  - `jsconfig.json` (SHA-256: `724654a88ce88255af99905b1aae88b11be576c88738802ee38a3e2f5385653a`)
  - `scripts/check-coverage.mjs` (SHA-256: `a2336b52afc81c162f9b798c893b10b473f1fc13613c7e37142c6246d7b6ee18`)
  - `test/provider-eval.test.mjs` (SHA-256: `1660c607527d18ee6063bd2515317bf9a7b49998e3282187da3bf178e893a3ab`)
- **Git Patch Hash (`git diff | sha256sum`):** `20a377373e1139b29c10d0d27d0eb3e70cf5af7e52f647b6534de1c9d478f1a9`
- **DUR-001 Untracked Candidate Artifacts:**
  - `lib/goal-contracts.mjs` (1,170 lines):\
    SHA-256: `40c1a9fd7176809887c2f1813fcae1158e65878a4180fbc4e5f6768711568106`
  - `test/goal-contracts.test.mjs` (1,222 lines):\
    SHA-256: `2a367c17711339354ac84460011604b0003a891b59eb28934076c8c2ccba73fe`
  - `test/goal-lock-spike.test.mjs` (2,151 lines):\
    SHA-256: `f21ccf126146403c8e9295bbdf5001327ea8a29aa425eac7f303f07c83d9c02b`
  - `docs/next-phase/decisions/DUR-001.md` (838 lines):\
    SHA-256: `d7258e59eb70cdec1297f28ba0ac4e3732f4b3e60ad6e76300ce284c9b9a3ff7`
- **4-File DUR-001 Candidate Aggregate Digest:**\
  `sha256(concat(sorted(path, NUL, bytes)))` = `12d2ddd9f93349e67086fc6c5dfd119780ee41d3c0d9d44837ce492fda745aa7`

---

## 2. Verification Commands & Execution Results

All gates were verified on both supported production runtimes:

- Node.js 24: `/usr/bin/node` (v24.21.0)
- Node.js 22: `/tmp/opencode/review-kit/dist/node-v22.23.1-linux-x64/bin/node` (v22.23.1)

### 2.1 Author Test Suites

| Command                                     | Node 24.21.0 Result              | Node 22.23.1 Result              | Assessment                                                                          |
| :------------------------------------------ | :------------------------------- | :------------------------------- | :---------------------------------------------------------------------------------- |
| `node --test test/goal-contracts.test.mjs`  | 17 pass, 0 fail, 0 skip (224 ms) | 17 pass, 0 fail, 0 skip (175 ms) | Pure schemas, metadata, lifecycle, chains, leases, budgets pass cleanly             |
| `node --test test/goal-lock-spike.test.mjs` | 15 pass, 0 fail, 0 skip (4.50 s) | 15 pass, 0 fail, 0 skip (3.40 s) | Linux flock contention, detached child races, reaper, recovery, fences pass cleanly |

### 2.2 Integrated Repository Gates

| Gate Command                        | Runtime      | Result                                                                                                                                                                                                                     |
| :---------------------------------- | :----------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                     | Node 24.21.0 | **PASS**: 180 modules syntax checked; ESLint 0 errors; checkJs exit 0; Prettier clean; 789/789 tests pass; `lib/goal-contracts.mjs` coverage: 100.00% lines, 96.91% branches, 100.00% functions (against 90/75/100 floors) |
| `PATH=<node22>:$PATH npm run check` | Node 22.23.1 | **PASS**: 180 modules syntax checked; ESLint 0 errors; checkJs exit 0; Prettier clean; 789/789 tests pass; `lib/goal-contracts.mjs` coverage: 100.00% lines, 96.91% branches, 100.00% functions (against 90/75/100 floors) |
| `npm run eval`                      | Node 24.21.0 | **PASS**: 16/16 contract pass, 9 task success, 0 safety violations, baseline PASS                                                                                                                                          |
| `npm run smoke`                     | Node 24.21.0 | **PASS**: 32 frame checks across 4 geometries clean                                                                                                                                                                        |
| `npm run pack:check`                | Node 24.21.0 | **PASS**: 91 files dry-run packed (324,406 bytes), private package boundary verified                                                                                                                                       |
| `git diff --check`                  | N/A          | **PASS**: 0 whitespace errors                                                                                                                                                                                              |

---

## 3. Independent Counterexample Findings

Per `docs/next-phase/REVIEW_METHOD.md`, passing author tests were not treated as independent evidence. An independent test harness was executed across both runtimes to verify adversarial boundaries, tampered structures, and edge cases across the six required areas.

### 3.1 Check 1: Journal Ordering, Checksums, Binding, and Stale Identities

- **Tampering & Link Breakage:**
  - Direct mutation of a sealed record's sequence, payload, or `prevChecksum` was detected fail-closed by `validateJournalRecord` (lines 478–524) with `invalid goal contract: journal checksum mismatch` or `invalid journal link`.
  - Canonical JSON strictly enforces key sorting, depth limits (32), array limits (4,096), safe integers, and rejects prototype pollution (`__proto__`, `prototype`, `constructor`) and credential keys (`token`, `secret`, `password`, `api_key`, `credential`, `bearer`) via `FORBIDDEN_PERSISTED_KEYS` (lines 159–161).
- **Sequence & Generation Gaps:**
  - Appends jumping sequence (e.g., 2 -> 4) were rejected by `assertJournalAppend` (lines 554–573) (`journal sequence gap`).
  - Appends jumping generation (e.g., 1 -> 3) were rejected (`journal generation gap`).
  - Appends regressing generation (e.g., 2 -> 1) were rejected (`journal generation regression`).
- **Stale Attempt Reuse:**
  - Attempt ID reuse across non-adjacent generations (e.g., attempt A in gen 1, attempt B in gen 2, attempt A in gen 3) was tested in `validateJournalChain` (lines 574–651). Line 594 enforces `!attemptIds.has(record.attemptId)`, rejecting with `journal attempt reuse`.
- **Cross-Attempt / Cross-Generation Dispatch:**
  - An intent prepared under Attempt A in Generation 1 was attempted to be dispatched under Attempt B in Generation 2. Because `validateJournalChain` (lines 617–620) verifies canonical JSON equality against `entry.intent`, it threw `dispatch does not match its intent`.

### 3.2 Check 2: Lifecycle, Budgets, and Completion Evidence

- **Bypassing Completion Evidence:**
  - Calling `transitionGoal(running, "completed", fence)` (lines 1045–1067) was rejected at line 1054 with `completion requires criterion evidence`.
  - Terminal states (`completed`, `cancelled`) have empty transition arrays (`TRANSITIONS[completed] = []`), rejecting all subsequent transitions with `forbidden transition`.
- **Completion Evidence Binding:**
  - Calling `completeGoal` (lines 1111–1144) was tested against four adversary vectors:
    1. _Stale generation:_ Evidence carrying generation 0 against a generation 1 goal threw `stale or failed evidence`.
    2. _Failed verification:_ Evidence with `accepted: false` threw `stale or failed evidence`.
    3. _Manifest drift:_ Evidence with a modified workspace manifest hash threw `stale or failed evidence`.
    4. _Plan/Artifact mismatch:_ Test evidence with a mismatched `planHash` or artifact evidence with a mismatched `sha256` threw `evidence binding mismatch`.
- **Budget Escapes & Monotonic Accounting:**
  - A goal in `budget-exhausted` was attempted to transition directly to `ready` via `transitionGoal`. It was rejected at line 1056 with `budget amendment required`.
  - Calling `amendGoalBudget` (lines 1146–1169) without increasing any dimension threw `budget increase required`. Attempting to decrease any dimension threw `budget cannot decrease`.
  - `updateGoalBudget` (lines 1071–1097) strictly enforces monotonic `used` and `reserved` counters without refunds for unspent reservations. Reserving beyond ceiling threw `budget exhausted`; consuming unreserved amounts threw `unreserved consumption`.
- **Outcome Classification:**
  - Tested `goalStateFromOutcome` (lines 1099–1109): clean process exit (`status: "clean"`) mapped to `needs-attention` (preserving the invariant that a clean exit alone does not satisfy criteria); `aborted` mapped to `interrupted`; `budgetExhausted` mapped to `budget-exhausted`.

### 3.3 Check 3: Lease Expiry, Workspace Identity, Process Ownership, and Late Callbacks

- **Lease Expiry:**
  - Calling `assertLeaseHeld` (lines 969–999) or `assertOperationAuthority` (lines 1006–1033) at `now >= expiresAt` threw `lease expired`.
  - Calling `renewGoalLease` (lines 932–950) on an expired lease was rejected fail-closed (`lease expired`), preventing stale lease revival.
  - Lease duration is hard-capped at `LEASE_MAX_MS` (120,000 ms); requests above this threw `integer out of bounds` or `lease too long`.
- **Workspace & Process Identity:**
  - Tampering with the lease's recorded decimal `device` or `inode` string threw `lease workspace mismatch`.
  - Modifying the owner's `pid`, `startTime`, or `bootId` in `assertLeaseHeld` (lines 991–995) threw `lease owner mismatch`.
- **Late Callbacks:**
  - Invocations of `assertOperationFence` (lines 745–756) with an older generation or a different attempt ID threw `stale operation fence`.

### 3.4 Check 4: Crash Recovery, Detached Children, and Lock-Release Races

The prototype in `test/goal-lock-spike.test.mjs` was verified across both runtimes:

- **Detached Worker Vulnerability (Lines 521–626):**
  When a parent process holds a Linux `flock` and spawns a detached child without descriptor forwarding (the standard Node default), killing the parent immediately releases the kernel lock, allowing a second writer to enter while the orphaned child is still writing. Even with forwarding, closing fd 3 reproduces the lock loss.
- **Bubblewrap Reaper & Teardown Races (Lines 628–680):**
  Passing the lock descriptor to Bubblewrap's reaper via `--sync-fd` retains the lock after supervisor and command death. However, killing the reaper itself or racing during monitor exit can expose an incomplete teardown race.
- **Two-Record Publication Tear (Lines 1568–1650):**
  The original prototype published readiness using two separate renames (`run.json` then `recovery.json`). Killing the process between writes across a generation boundary resulted in torn state (`run.json` at generation 2, `recovery.json` at generation 1). A naive contender acquired the lock and executed.
- **Demonstrated Fixes (Lines 1654–1981):**
  1. A single generation-fenced atomic checkpoint (`checkpoint.json`) eliminated the intermediate torn state.
  2. Safe ordering (invalidating writer state first via `recovery.json = investigating@gen2`) prevented contender admission on torn evidence.
- **Edit Intent Reconciliation (Lines 1985–2150):**
  Recovery classifies observable live file bytes strictly against intent before/after hashes:
  - Exact before: classified as `not-applied`; contender admitted; bytes preserved.
  - Exact after: classified as `observed-applied`; provenance noted; file never re-written.
  - Unexpected: classified as `unexpected`; live bytes preserved with no overwrite or rollback; contender refused until explicit hash-bound resolution is provided.

### 3.5 Check 5: Generation Persistence & Participation of Every Writer

- **Documented Specification:**
  In `docs/next-phase/decisions/DUR-001.md` (lines 651–718), generation persistence is specified to occur prior to dispatch (advancing upon `ready -> running` or `* -> reconciling`). A comprehensive adoption matrix covers eight entry points:
  1. Interactive editing (`src/matrix.mjs` / `lib/controller.mjs`)
  2. Headless execution (`bin/matrix.mjs` `runHeadlessTask`)
  3. Undo restoration (`lib/pinned-write.mjs` `writePinnedAtomic`)
  4. Agent tool loops (`lib/local-agent.mjs`, `lib/model-agent.mjs`)
  5. Parallel execution (`lib/parallel-run.mjs`)
  6. Batch integration (`lib/integration.mjs`)
  7. Common-directory Git publication (`lib/integration-publication.mjs`)
  8. Read-only recovery inspection (`bin/matrix.mjs` `recover`)
- **Implementation Status:**
  The contract layer provides the pure primitives (`assertOperationAuthority`, `createGoalLease`), but **no production writer is wired to this policy yet**. Runtime processes do not persist generation counters, and existing interactive/headless writers do not check the lease. This separation is legitimate at this milestone.

### 3.6 Check 6: Repaired Defects and Non-Boolean Preconditions

- **Wrong-Hash & Cross-Generation Edit Receipts:**
  - _Previous Defect:_ `validateJournalChain` (lines 622–633) previously admitted receipt records solely by sequence presence without binding receipt file hashes or generation identities to the original intent.
  - _Verification of Repair:_ `validateJournalChain` (line 628) now calls `assertOperationReceipt(record.payload, entry.intent, ...)`. An edit receipt with `status: "succeeded"` and a mismatched after-image hash was confirmed rejected (`receipt does not bind the edit after image`). A receipt with a cross-generation attempt was confirmed rejected (`receipt does not match its intent`).
- **Non-Boolean Precondition Files:**
  - _Previous Defect:_ `validateOperationIntent` (line 713) evaluated `if (file.exists)` without checking `typeof file.exists === "boolean"`, admitting string `"false"` or number `1` as truthy.
  - _Verification of Repair:_ Line 713 strictly enforces `requireValue(typeof file.exists === "boolean", "invalid precondition exists")`. Tested all non-boolean values (`"true"`, `"false"`, `""`, `0`, `1`, `null`, `undefined`, `{}`, `[]`), all of which failed closed. Inconsistent hash pairings (`exists: true` with `sha256: null` and `exists: false` with a non-null hash) were also confirmed rejected.

---

## 4. Separation of Implementation, Prototype, Contract, and Open Work

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. IMPLEMENTED & VERIFIED RUNTIME BEHAVIOR (lib/goal-contracts.mjs)         │
│    - Pure schema validation for Goals, Journals, Intents, Receipts, Leases  │
│    - Bounded canonical JSON serialization & credential-key blocking        │
│    - Monotonic journal sequence, checksum relinking & chain walk            │
│    - State machine transitions & generation advancement                     │
│    - Monotonic budget reservation and consumption accounting                │
│    - Criterion evidence binding and completion gate                         │
│    - Pre-mutation authority verification gate                               │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. TESTED PROTOTYPES (test/goal-lock-spike.test.mjs)                        │
│    - Linux flock process exclusion and death release                        │
│    - Detached child lock escapes (omitted descriptor, closed fd)            │
│    - Bubblewrap reaper holding lock fd via --sync-fd                        │
│    - Fresh recovery: PID identity verification via procfs & pidfd kill      │
│    - Torn two-record defect reproduction & single atomic checkpoint fix     │
│    - Edit-intent recovery (before, after, unexpected byte preservation)     │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. DOCUMENTED CONTRACTS & SPECIFICATIONS (decisions/DUR-001.md)             │
│    - Storage caps (1 MiB checkpoint, 64 KiB record, 32 MiB journal, etc.)   │
│    - Proposed CLI grammar and exit code mappings                            │
│    - Adoption requirements for all 8 existing writer entry points           │
│    - Lock ordering: workspace lock before Git common-directory lock         │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. WORK LEGITIMATELY ASSIGNED TO LATER TASKS (Per AGENT_TASKS.md)           │
│    - DUR-002: Durable append-only journal, fsync/directory sync, checkpoints│
│    - DUR-003: Reconciliation of deletions, renames, modes, multi-edits     │
│    - DUR-004: Resumable executor adapter, context recovery, provider limits │
│    - DUR-005: Controller/writer integration & native Node pidfd/Doctor check│
│    - DUR-006: CLI implementation and Ink UI screen continuation             │
│    - QA-101:  Comprehensive adversarial durability matrix (CR-01 - CR-20)   │
├─────────────────────────────────────────────────────────────────────────────┤
│ 5. UNRESOLVED BLOCKED DECISIONS FOR DUR-001 ACCEPTANCE                      │
│    - Missing root replacement & symlink alias tests in lock spike           │
│    - Absence of an in-tree Node OS-ownership primitive (Python pidfd used)  │
│    - Production generation persistence and every-writer participation open  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Scope Limits and Remaining Blockers

### 5.1 Scope Limits

1. **Process Crash vs. Power Loss:** The locking and consistency spike tests process crashes via `SIGKILL` at deterministic barriers. It does not test physical power loss, kernel panics, or filesystem journal reordering.
2. **Linux Only:** Locking and containment mechanisms are verified strictly on Linux (`kernel.yama.ptrace_scope`, Bubblewrap 0.13.1, util-linux `flock`). No portability claims are made for other OSes.
3. **No Network / Live Provider Claims:** All credentials used are synthetic; remote provider quality and streaming recovery remain outside this contract review.

### 5.2 Remaining Acceptance Blockers for DUR-001

Per `docs/next-phase/AGENT_TASKS.md` (lines 50–56) and `docs/next-phase/STATUS.md` (lines 29–31), the following items prevent marking DUR-001 as `ACCEPTED`:

1. **Workspace Root Replacement Missing from Lock Spike:**
   - _Requirement:_ `AGENT_TASKS.md` (line 52) explicitly demands: _"Exercise supervisor death, worker death, inherited children, stale ownership and root replacement."_
   - _Observation:_ While `test/goal-contracts.test.mjs` tests device/inode mismatches in memory, `test/goal-lock-spike.test.mjs` contains zero tests exercising live workspace directory renaming, replacement, or symlink aliasing during contention. `docs/next-phase/decisions/DUR-001.md` (line 303) admits: _"Lock-file replacement/aliasing, workspace root replacement... remain unresolved."_
2. **Reliance on External Python Harness for `pidfd`:**
   - The spike demonstrates safe process signaling and verification using Python (`os.pidfd_open`, `signal.pidfd_send_signal`). A production design must define an in-tree Node.js native ownership implementation and a Doctor preflight check before dependent integration.
3. **Unresolved Writer Policy & Generation Persistence:**
   - As recorded in `STATUS.md` (lines 29–31) and `decisions/DUR-001.md` (lines 73–77), DUR-001 as a whole cannot be closed while production generation minting/persistence and every-writer lease participation remain open decisions.

---

## 6. Audit Recommendation

**Verdict: CHANGES REQUIRED**

### Rationale

1. **Pure Contracts (`lib/goal-contracts.mjs`):** The pure contract schemas, bounded serialization, lifecycle state machine, journal link integrity, and pre-mutation authority checks are verified, fully covered (100% lines, 96.91% branch, 100% functions), and pass all independent counterexamples on both Node 22.23.1 and Node 24.21.0. **This layer is mathematically sound and ready to serve as the interface contract for DUR-002 (Store).**
2. **Lock Spike & Ownership (`test/goal-lock-spike.test.mjs`):** The spike successfully proves that `flock` alone cannot guarantee exclusive access across detached child processes and demonstrates the necessity of single-checkpoint recovery and PID namespace verification. However, because **workspace root replacement** was omitted from the executable spike, and the process ownership primitive relies on Python, the acceptance criteria mandated by `AGENT_TASKS.md` (lines 50–56) are incomplete.
3. **Project Governance Alignment:** The implementer's submission in `docs/next-phase/decisions/DUR-001.md` (lines 836–838) and the dispatch board in `docs/next-phase/STATUS.md` (lines 29–31) explicitly classify DUR-001 as `SUBMITTED`, noting that production process ownership and generation persistence decisions remain open. Marking the task `ACCEPTED` at this stage would violate project governance.

### Required Actions Before Acceptance

1. Add an executable test case to `test/goal-lock-spike.test.mjs` verifying refusal when the workspace root directory is replaced or aliased via symlink during an active run.
2. Specify the concrete in-tree Node.js mechanism (e.g., native addon, helper binary, or bounded procfs/syscall wrapper) for `pidfd` process containment and define the Doctor capability check in `docs/next-phase/decisions/DUR-001.md`.
3. Formally approve the frozen schemas in `lib/goal-contracts.mjs` so that DUR-002 (Store persistence) can commence in parallel while the ownership harness details are finalized.

_Runtime code, host settings, and Git history have been left untouched. Task status remains SUBMITTED._
