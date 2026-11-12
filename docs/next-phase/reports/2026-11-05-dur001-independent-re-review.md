# Independent Re-Review — DUR-001 (Goal Contracts, State Machine, and Linux Writer-Lock Spike)

**Review Date:** 2026-11-05\
**Review Target:** DUR-001 under `docs/next-phase/`\
**Reviewer:** Independent audit agent (fresh review context).\
**Repository:** `/home/mitravanu/matrix`\
**Governing Documents:** `AGENTS.md`, `docs/next-phase/REVIEW_METHOD.md`, `docs/next-phase/AGENT_TASKS.md`, `docs/next-phase/ARCHITECTURE.md`, `docs/next-phase/AUDIT.md`, `docs/next-phase/STATUS.md`, `docs/next-phase/decisions/DUR-001.md`, and `docs/next-phase/reports/2026-11-05-dur001-independent-review.md`.

No runtime code, host settings, or Git history were modified. The only repository file added by this review is this report document under `docs/next-phase/reports/`.

---

## 1. Candidate Identity & Reproducible Fingerprints

- **Base Git HEAD:** `ff55a2c2aaeb863e881a5a8d0e112eb78ded0204` (`Enforce Bubblewrap test runner isolation and proposal-bound edit verification (PRV-105/PRV-106)`)
- **Branch:** `matrix/engineering-hardening`
- **Git Patch Digest (`git diff | sha256sum`):** `382f11cf197b7babf27461197d7f91074b6a28c3f6b9baa13d5f7d99283b3e48`
- **Dirty Tracked Files in Working Tree:**
  - `MATRIX.md` (SHA-256: `9782d78b3fc40fa0ae1d4452c7634d4cfbf0be1b6d7c3bc262e5577feb5bb617`)
  - `NEXT_PHASE.md` (SHA-256: `b2b505648591bc68354c9d2b94e9575856bf3dbea6ea26d13e2fa03c9698c78e`)
  - `README.md` (SHA-256: `d3697d540b27a2522992148bfd081e55f686404324b376f0ff78aedd038af70c`)
  - `docs/next-phase/DURABLE_PHASE.md` (SHA-256: `11fd7f2d90a57533bd5e36ac5e0ae1f5640f4f67e4b5c270d966697ac449fa0b`)
  - `docs/next-phase/STATUS.md` (SHA-256: `c00dec517df5856b1b683eda61d0578bc1be9df36791c2fcf2a3dd7b0948d803`)
  - `eval/README.md` (SHA-256: `8d5c3cd4555df9dca38cd0e8870750d71a271fcd3ece8d8fcbc8f4a377d3e816`)
  - `eval/provider-eval.mjs` (SHA-256: `8c7826aa96a974a27c1a62844e9e77631d690e72a5c8200df21d8f994e960dde`)
  - `jsconfig.json` (SHA-256: `724654a88ce88255af99905b1aae88b11be576c88738802ee38a3e2f5385653a`)
  - `lib/model-agent.mjs` (SHA-256: `30eb59024d444abc22d27b145fca5a76634b6fc6516ff659ac53f521028766f7`)
  - `lib/workspace.mjs` (SHA-256: `10255e230553456e3d87adbd69f74926b3b512bb424e989d30dc05cf9d9ac128`)
  - `scripts/check-coverage.mjs` (SHA-256: `a2336b52afc81c162f9b798c893b10b473f1fc13613c7e37142c6246d7b6ee18`)
  - `test/provider-eval.test.mjs` (SHA-256: `1660c607527d18ee6063bd2515317bf9a7b49998e3282187da3bf178e893a3ab`)

### 1.1 Candidate Fingerprint Verification

The 5 candidate files for DUR-001 and their individual SHA-256 digests:

- `lib/goal-contracts.mjs` (41,638 bytes, 1,170 lines):\
  `40c1a9fd7176809887c2f1813fcae1158e65878a4180fbc4e5f6768711568106`
- `lib/model-agent.mjs` (86,498 bytes, 2,239 lines):\
  `30eb59024d444abc22d27b145fca5a76634b6fc6516ff659ac53f521028766f7`
- `lib/workspace.mjs` (5,045 bytes, 162 lines):\
  `10255e230553456e3d87adbd69f74926b3b512bb424e989d30dc05cf9d9ac128`
- `test/goal-contracts.test.mjs` (41,430 bytes, 1,222 lines):\
  `2a367c17711339354ac84460011604b0003a891b59eb28934076c8c2ccba73fe`
- `test/goal-lock-spike.test.mjs` (107,055 bytes, 2,921 lines):\
  `8e5eca4e60916d2f58821e8be7c2a13120d486ba4f2f827500c727d74ccbeeac`

**5-File Candidate Aggregate SHA-256:**\
`sha256(concat(sorted(path, NUL, bytes)))` =\
`71f7604be8181d45308d2602fc339bfff01a1134f668023de0416f55475c8528`

**Verification:** This aggregate digest matches **byte-for-byte** the candidate fingerprint recorded in the latest "Model-agent write lock lifetime repair" section of `docs/next-phase/decisions/DUR-001.md` (lines 1076–1079).

---

## 2. Verification Commands & Execution Results

All author tests and repository gates were executed across both supported production runtimes:

- **Node.js 24:** `/usr/bin/node` (v24.21.0)
- **Node.js 22:** `/tmp/opencode/review-kit/dist/node-v22.23.1-linux-x64/bin/node` (v22.23.1)

### 2.1 Author Test Suites

| Command                                     | Node 24.21.0 Result                  | Node 22.23.1 Result                  | Status |
| :------------------------------------------ | :----------------------------------- | :----------------------------------- | :----- |
| `node --test test/goal-contracts.test.mjs`  | **17 pass, 0 fail, 0 skip** (121 ms) | **17 pass, 0 fail, 0 skip** (129 ms) | PASS   |
| `node --test test/goal-lock-spike.test.mjs` | **20 pass, 0 fail, 0 skip** (5.24 s) | **20 pass, 0 fail, 0 skip** (3.67 s) | PASS   |

### 2.2 Formatting, Lint, and Typecheck

| Check    | Command                                                                                                                                                                                | Result                         |
| :------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------- |
| Prettier | `node_modules/.bin/prettier --config .prettierrc.json --check test/goal-lock-spike.test.mjs lib/goal-contracts.mjs test/goal-contracts.test.mjs lib/workspace.mjs lib/model-agent.mjs` | **0 errors, clean code style** |
| ESLint   | `node_modules/.bin/eslint test/goal-lock-spike.test.mjs lib/goal-contracts.mjs test/goal-contracts.test.mjs lib/workspace.mjs lib/model-agent.mjs`                                     | **0 errors, 0 warnings**       |
| checkJs  | `node_modules/.bin/tsc --project jsconfig.json --pretty false`                                                                                                                         | **Exit code 0, 0 type errors** |

### 2.3 Integrated Repository Gates

| Gate Command                        | Runtime      | Result                                                                                                                                                                                                                                                                                                                                                                                            |
| :---------------------------------- | :----------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run check`                     | Node 24.21.0 | **PASS**: 180 modules syntax checked; checkJs clean; ESLint clean; Prettier clean; 794/794 tests pass (0 fail, 0 skip); critical coverage floors met: `goal-contracts.mjs`: 100% lines, 96.91% branches, 100% functions (floor 90/75/100); `workspace.mjs`: 98.77% lines, 91.11% branches, 100% functions (floor 95/90/100); overall coverage: 94.41% lines / 84.41% branches / 94.81% functions. |
| `PATH=<node22>:$PATH npm run check` | Node 22.23.1 | **PASS**: 180 modules syntax checked; 794/794 tests pass (0 fail, 0 skip); all critical coverage floors met.                                                                                                                                                                                                                                                                                      |
| `npm run eval`                      | Node 24.21.0 | **PASS**: 16/16 contract pass, 9 task success, 0 safety violations, baseline PASS.                                                                                                                                                                                                                                                                                                                |
| `git diff --check`                  | N/A          | **PASS**: 0 whitespace errors.                                                                                                                                                                                                                                                                                                                                                                    |

---

## 3. Independent Counterexample Verifications

Per `docs/next-phase/REVIEW_METHOD.md`, independent counterexample harnesses were constructed and executed on both Node 24.21.0 and Node 22.23.1 using isolated temporary workspaces and synthetic credentials.

Harness scripts:

- `test_item1_contention.mjs` (Model-agent write lock lifetime, contention at rename, first use, error release, flock missing)
- `test_item2_replacement_aliasing.mjs` (Workspace root replacement, symlink aliasing, O_NOFOLLOW attack, pure contract verification)

### 3.1 Item 1: Model-Agent Write Lock Lifetime and Contention

#### 1. Contention at Atomic Rename

- **Hypothesis/Claim:** In `lib/model-agent.mjs`, `withWorkspaceWriteLock(project.root, ...)` holds `<canonicalWorkspace>.lock` across the entire write transaction (`revalidateBeforeWrite`, `backupFile`, and `writeFileAtomic`). A competing process attempting to acquire the lock at the exact moment of the atomic `renameSync` must be denied and must not interfere with the write. Once the write completes, the contender must be able to acquire the lock.
- **Counterexample Execution:**
  - Mock SSE provider stream issued `propose_edit` for `src/processor.py`.
  - Normal approval callback was invoked and returned `"y"`.
  - `fs.renameSync` was intercepted: at the exact invocation replacing `src/processor.py` with the temporary file, a separate process spawned `flock -n <canonicalWorkspace>.lock true`.
  - **Observed:**
    - Contender process exit code: **1** (excluded by kernel flock).
    - `propose_edit` completed with `ok: true`, summary `applied`.
    - Immediately following completion, a second contender executed `flock -n <canonicalWorkspace>.lock true` and exited **0** (lock acquired).
    - Target file `src/processor.py` verified to contain the applied edit (`verified-independent-fix`).
    - Both Node 24.21.0 and Node 22.23.1 PASSED.

#### 2. First Use with No Existing Lock File

- **Hypothesis/Claim:** On first write in a workspace where `<canonicalWorkspace>.lock` does not yet exist, `withWorkspaceWriteLock` creates the lock file with mode `0o600`, acquires the lock via an inherited descriptor to `flock -n 3`, excludes concurrent contenders, and releases the lock upon completion.
- **Counterexample Execution:**
  - Created a fresh temporary directory `workspace` with no `.lock` file existing.
  - Entered `withWorkspaceWriteLock(ws, () => { ... })`.
  - **Observed:**
    - Lock file was created with permissions `0o600`.
    - Contender spawned inside the callback exited **1** (excluded).
    - After callback returned, contender exited **0** (acquired).
    - Both Node 24.21.0 and Node 22.23.1 PASSED.

#### 3. Lock Release After Write Failure

- **Hypothesis/Claim:** If `mutate()` throws an error (e.g. disk failure, permission failure, or serialization error), the `finally` block in `withWorkspaceWriteLock` must close the file descriptor, releasing the kernel lock immediately without leaking the lock to subsequent writers.
- **Counterexample Execution:**
  - Injected an error inside `withWorkspaceWriteLock`.
  - Verified contender inside the callback was excluded (status 1).
  - Verified error was caught and propagated.
  - Contender immediately after error exited **0** (lock successfully released, zero lock leak).
  - Both Node 24.21.0 and Node 22.23.1 PASSED.

#### 4. Refusal When Flock Is Unavailable

- **Hypothesis/Claim:** If the system `flock` utility is unavailable or missing from PATH, `withWorkspaceWriteLock` must fail closed with an error matching `refusing to write: workspace lock is unavailable`, mutate zero workspace bytes, and leave no orphaned lock held.
- **Counterexample Execution:**
  - Child process executed `withWorkspaceWriteLock` with an empty PATH containing no `flock` binary.
  - **Observed:** Threw `refusing to write: workspace lock is unavailable`. Mutated boolean was `false`. Lock probe after exit was clean (status 0).
  - Both Node 24.21.0 and Node 22.23.1 PASSED.

---

### 3.2 Item 2: Workspace Root Replacement and Symlink Aliasing

#### 1. Symlink Aliasing

- **Hypothesis/Claim:** If a workspace directory `real-workspace` is aliased by a symlink `alias-workspace -> real-workspace`, both paths must resolve to the identical canonical lock path (`realpathSync + ".lock"`). A contender attempting to lock through the alias while the primary holds the lock must be denied and must write zero bytes.
- **Counterexample Execution:**
  - Setup: `real-workspace/initial-sentinel.txt` with symlink `alias-workspace -> real-workspace`.
  - Primary process acquired lock on `realpath(real-workspace) + ".lock"` and signaled readiness.
  - Contender attempted `flock -n realpath(alias-workspace) + ".lock"` and attempted writing `alias-workspace/contender-touched.txt`.
  - **Observed:**
    - Alias resolved lock matched canonical lock path exactly.
    - Contender exited non-zero (rejected by kernel flock).
    - `contender-touched.txt` was not created in `alias-workspace` or `real-workspace` (zero bytes written).
    - Upon primary release, contender executed with exit 0 and wrote file.
    - Both Node 24.21.0 and Node 22.23.1 PASSED.

#### 2. Symlink Attack on Lock File (`O_NOFOLLOW`)

- **Hypothesis/Claim:** If `<canonicalWorkspace>.lock` is replaced by an attacker with a symlink pointing to an arbitrary host file (e.g., `victim.txt`), `withWorkspaceWriteLock` must fail closed due to `O_NOFOLLOW` and must not open or mutate the victim file.
- **Counterexample Execution:**
  - Pre-created `<canonicalWorkspace>.lock` as a symlink pointing to `victim.txt`.
  - Called `withWorkspaceWriteLock`.
  - **Observed:** `openSync` threw `ELOOP: too many symbolic links encountered`. `victim.txt` remained untouched.
    Both Node 24.21.0 and Node 22.23.1 PASSED.

#### 3. Extended Workspace Root Replacement

- **Hypothesis/Claim:** When pre-mutation authority is bound to the directory device and inode (`dev`, `ino`), replacing the directory on disk (rename original to `workspace.old`, create fresh directory `workspace` at same path with distinct inode) while the primary writer holds the lock must cause the primary writer to refuse the write upon resumption. Both roots must retain their original bytes.
- **Counterexample Execution:**
  - Primary process acquired lock on `workspace.lock`, recorded initial `dev` and `ino`, and waited at a deterministic barrier `primary.paused` before mutation.
  - While paused: `workspace` was renamed to `workspace.old` (containing initial sentinel files `original-file-1.txt` and `original-file-2.txt`). A new `workspace` directory was created via `mkdirSync(workspace)` (containing `replacement-file.txt`). The filesystem assigned a distinct inode (`replacedStat.ino !== approvedAuthority.ino`).
  - Primary unpaused via `primary.mutate` barrier.
  - **Observed:**
    - Primary detected inode mismatch, logged refusal, and exited with code **3**.
    - **Both roots retained their exact original bytes:**
      - `workspace.old`: `approved-write.txt` absent; directory contained only `original-file-1.txt` and `original-file-2.txt` with original contents.
      - `workspace`: `approved-write.txt` absent; directory contained only `replacement-file.txt` with original contents.
    - Stale contender targeting `workspace` with old authority detected inode mismatch, exited code **3**, and wrote zero bytes.
    - Valid contender targeting `workspace` with updated authority matching the replacement inode succeeded (exit code **0**) and wrote `control-success.txt` in `workspace` while `workspace.old` remained completely untouched.
    - Both Node 24.21.0 and Node 22.23.1 PASSED.

#### 4. Pure Contract Validation of Root Identity

- **Hypothesis/Claim:** `validateGoalWorkspace` and `assertLeaseHeld` must strictly validate `device` and `inode` decimal strings and throw fail-closed upon any discrepancy.
- **Counterexample Execution:**
  - Tested `validateGoalWorkspace` with valid and tampered descriptors (`inode: "bad-inode"` threw `invalid root identity`).
  - Tested `assertLeaseHeld` against fence with modified `inode` (threw `lease workspace mismatch`).
  - Tested `assertLeaseHeld` against fence with modified `device` (threw `lease workspace mismatch`).
  - Both Node 24.21.0 and Node 22.23.1 PASSED.

---

## 4. Architectural Analysis: Decisions Resolved vs Later Implementation

Per Item 3 of the review instructions, the four governance and architecture areas are evaluated below:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           DUR-001 CONTRACT MILESTONE                            │
├──────────────────────────────────────┬──────────────────────────────────────────┤
│ DECISIONS RESOLVED IN DUR-001        │ IMPLEMENTATION ASSIGNED TO LATER TASKS   │
├──────────────────────────────────────┼──────────────────────────────────────────┤
│ 1. C PIDFD HELPER:                   │ DUR-005:                                 │
│    - Selected in-tree static C binary│ - Write bin/matrix-pidfd-helper.c        │
│      (bin/matrix-pidfd-helper).      │ - Compile/bundle static binary           │
│    - Replaced external Python harness│ - Implement JS wrapper in lib/process.mjs│
│    - Defined procfs bootId/start_time│ - Test live process signaling/waitid     │
│      verification, race-free pinning,│                                          │
│      signaling, and POLLIN teardown. │                                          │
├──────────────────────────────────────┼──────────────────────────────────────────┤
│ 2. DOCTOR CAPABILITY CHECKS:         │ DUR-005 & DUR-006:                       │
│    - Defined 4 required capabilities │ - Wire probes into lib/doctor.mjs        │
│      (Linux kernel >= 5.3 pidfd,     │ - Connect to bin/matrix.mjs doctor       │
│      procfs mounted, Bubblewrap bwrap│ - Display diagnostic UI in Ink screens   │
│      namespaces, non-blocking flock).│                                          │
│    - Defined fail-closed refusal:    │                                          │
│      exit 2, E_CAPABILITY_MISSING.   │                                          │
├──────────────────────────────────────┼──────────────────────────────────────────┤
│ 3. GENERATION PERSISTENCE:           │ DUR-002 & DUR-004:                       │
│    - Established invariant: Store    │ - DUR-002: Implement Store fsync and     │
│      persists generation increment   │   atomic checkpoint.json writes          │
│      before Executor dispatches.     │ - DUR-004: Implement Executor dispatch   │
│    - assertOperationFence enforces   │   gate checking on-disk persistence      │
│      rejection of stale callbacks.   │ - DUR-004: Discard stale callback results│
├──────────────────────────────────────┼──────────────────────────────────────────┤
│ 4. SHARED LOCK & WRITER POLICY:      │ DUR-005:                                 │
│    - Unified withWorkspaceWriteLock  │ - Wire remaining 7 writer entry points   │
│      holds canonical lock descriptor │   (local-agent, interactive, headless,   │
│      across atomic write and lease.  │   undo, parallel-run, integration, Git   │
│    - Model-agent write path hooked   │   publication) to unified gate           │
│      and verified in DUR-001.        │ - Implement fixed two-phase lock order   │
│    - Adoption matrix specified for   │   (workspace lock -> Git lock)           │
│      remaining 7 writers.            │                                          │
└──────────────────────────────────────┴──────────────────────────────────────────┘
```

### 4.1 Boundary Evaluation

1. **Does any unresolved decision block DUR-002 (Store)?**
   - **No.** DUR-002 requires frozen schemas for metadata, journals, leases, and single-checkpoint consistency. `lib/goal-contracts.mjs` provides pure, fully tested schemas with 100% line coverage and canonical serialization. The single-checkpoint consistency model is verified in the spike.
2. **Does any unresolved decision block DUR-003 (Reconciliation)?**
   - **No.** DUR-003 requires operation intent schemas (`OPERATION_INTENT_SCHEMA_VERSION`), before/after image binding, and exact hash comparison rules. These are completely specified and tested in `lib/goal-contracts.mjs`.
3. **Does any unresolved decision block DUR-004 (Executor) or DUR-005 (Integration)?**
   - **No.** The architectural selections for process ownership (static C pidfd helper), preflight capability checks (Doctor), generation persistence order (Store before dispatch), and writer locking (`withWorkspaceWriteLock`) are resolved and documented in `decisions/DUR-001.md`.

---

## 5. Scope Limits

1. **Linux-Only Scope:** The locking and process ownership primitives are evaluated exclusively on Linux (kernel `flock`, Bubblewrap `bwrap`, `pidfd_open`/`pidfd_send_signal`, and `procfs`). No claims are made for other platforms.
2. **Crash Simulation vs Physical Power Loss:** Recovery guarantees are verified against process termination (`SIGKILL`) at deterministic execution barriers; physical power loss and hardware storage controller reordering are outside the tested boundary.
3. **Synthetic Providers Only:** All model-agent and provider tests utilized loopback SSE mocks and synthetic credentials; no live external network requests were made.

---

## 6. Audit Recommendation & Governance

### Verdict: ACCEPT

### Rationale

1. **Model-Agent Lock Lifetime Repair Verified:**
   The defect identified in the prior review—where `assertWorkspaceWritable` exited before the atomic write, allowing a competing process to acquire the lock at rename—is **fully repaired and independently verified**. `withWorkspaceWriteLock` holds the open file description across revalidation, backup, and `writeFileAtomic`. An independent contender was proven excluded at the exact moment of atomic `renameSync` and acquired the lock immediately upon release on both Node 24.21.0 and Node 22.23.1.
2. **Root Replacement & Symlink Aliasing Verified:**
   Both missing executable tests from the prior audit are implemented and independently verified:
   - Symlink aliases map to the identical canonical lock, and alias contenders are excluded.
   - `O_NOFOLLOW` prevents symlink attacks on `<workspace>.lock`.
   - Replacing the workspace directory during contention causes the primary holder to refuse with exit code 3, leaving **both roots completely untouched with their exact original bytes**.
3. **Architectural Clarity & Governance Compliance:**
   The decisions governing process ownership (`bin/matrix-pidfd-helper`), Doctor preflight checks, generation persistence ordering, and every-writer participation are resolved in `decisions/DUR-001.md`. The separation between DUR-001 contract specifications and DUR-002–005 implementations is clear and adheres to `AGENT_TASKS.md`.
4. **Clean Verification on All Platforms:**
   The candidate passes `npm run check` (794/794 tests, 0 failures, 0 skips, all coverage floors met) on both Node 24.21.0 and Node 22.23.1, passes `npm run eval` (16/16 contract pass), and formatting/lint/typecheck are 100% clean.

### Governance Status

In accordance with `AGENTS.md` (lines 88–90) and the review instructions:

- DUR-001 remains **SUBMITTED** in `docs/next-phase/STATUS.md`.
- DUR-002 remains **DEFERRED / gated** pending formal acceptance recording by the chief/integrator.
- Runtime code in `lib/`, host settings, and Git history have been strictly preserved.
