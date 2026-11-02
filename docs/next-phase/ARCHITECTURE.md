# Durable goals: design contract

> Deferred durable-execution phase. Implement PRV-101 through PRV-107 first.
> See [NEXT_PHASE.md](../../NEXT_PHASE.md) and [STATUS.md](STATUS.md) for current dispatch.

This is the target design for the next phase. Module names and API shapes below are
proposed, not existing public interfaces. DUR-001 must turn these into validated types,
transition tables and contract tests before dependent implementation starts.

## 1. Separate goal, attempt, operation and session

- A **goal** owns the user objective, acceptance criteria, workspace binding, budgets,
  operation ledger and current status. Its ID persists across restarts.
- An **attempt** is one executor lifetime. It has a new ID and generation after restart.
- An **operation** is one validated tool action with a stable ID assigned by trusted
  runtime code, not by the model. Provider tool-call IDs are correlation data only.
- A **session** is the UI/transcript projection. Losing or truncating it must not lose
  the goal ledger. Current `--resume` semantics remain distinct from goal continuation.

Store authoritative state outside the workspace under a private `MATRIX_HOME/goals/`
namespace. Do not treat bounded `runs/*.jsonl` display logs as the recovery journal.
Do not make a React component responsible for durable writes or action authorization.

## 2. Lifecycle and terminal meaning

| State             | Meaning                                                                         | Allowed next actions                                         |
| ----------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| ready             | Validated goal; no active attempt                                               | Explicit start/resume                                        |
| running           | One lease-owning executor is progressing                                        | Act, await decision, pause, cancel, reconcile, finish        |
| awaiting-approval | Exact pending edit/test decision                                                | Fresh decision in current generation; pause/cancel           |
| interrupted       | Prior executor ended without a durable terminal record                          | Inspect and explicitly resume into reconciliation            |
| reconciling       | Reconstruct effects and validate workspace/evidence                             | ready/running, needs-attention, or failed                    |
| paused            | User-requested cooperative stop at a safe boundary                              | Explicit resume or cancel                                    |
| budget-exhausted  | A persisted hard limit has been reached                                         | Inspect, cancel, or explicit budget amendment                |
| needs-attention   | Ambiguous effect, stale workspace, stalled progress or required human criterion | Explain evidence; accept a specific resolving decision       |
| completed         | Every required criterion has current accepted evidence                          | Read-only inspection; new work becomes a new goal            |
| cancelled         | User cancelled; no further actions may start                                    | Inspect retained recovery; new goal for further work         |
| failed            | Unrecoverable storage/protocol error for this attempt/goal                      | Inspect and explicit repair workflow; no automatic execution |

Goal status is not a new substitute for `lib/outcome.mjs`. A run may end cleanly with
an edit denied while its goal remains incomplete. A model saying "done", a zero process
exit, an absent test runner, or an accepted proposal does not fulfill acceptance criteria.
Define and test the mapping between goal lifecycle and existing run outcomes in DUR-001.

Pause waits for an in-flight effect to reach a known boundary, with a bounded timeout;
on timeout cancel the owned process and record uncertainty. Ctrl+C aborts an active
attempt using existing cancellation paths. A second interrupt must still allow exit.
SIGKILL cannot run cleanup handlers: the next process must detect incomplete state.
Do not launch a daemon or automatically restart after the CLI exits in this phase.

## 3. Minimum durable records

Schemas must reject unknown versions, invalid discriminants, unsafe paths, non-finite
numbers, duplicate operation IDs and inconsistent sequence/generation values.

**Goal record:** schema version, goal ID, creation time, objective, typed criteria,
canonical workspace path and root identity, base Git revision when available,
current approved workspace manifest reference, model/provider identifiers without
credentials, lifecycle, current generation, checkpoint sequence, and budget configuration.

**Journal record:** schema version, monotonically increasing sequence, goal ID,
attempt/generation, record kind, operation ID when applicable, bounded canonical payload,
checksum and link to prior committed record. Checksums detect accidental damage; they
do not authenticate against a malicious process with the same filesystem permissions.

**Operation intent:** kind, normalized arguments or private artifact references, plan
hash, required authority kind, workspace binding, read/write preconditions, before/after
image hashes for writes, budget reservation, and prepared/dispatched/observed state.

**Operation receipt:** status, evidence references, observed file hashes, process result
when known, actual usage when known, uncertainty fields, and durable completion sequence.

**Criterion evidence:** criterion ID and revision, evaluator identity/type, evidence class,
workspace generation and relevant file/manifest digest, command/plan identity, observed
result, freshness, and any required human decision. Model assertions are not trusted evidence.

Exact edit images needed for recovery belong in bounded private blobs with independent
hashes; never truncate them into plausible recovery data. Transcript redaction and exact
recovery images are separate concerns. Do not persist credentials, raw provider headers,
hidden reasoning, full command scripts in general logs, or arbitrary unbounded tool output.

## 4. Persistence protocol and capacity

Recommended first implementation: versioned journal plus atomic checkpoint and private
content-addressed blobs using built-in filesystem primitives. Avoid a database dependency
unless DUR-001 demonstrates a concrete correctness advantage and the chief accepts it.

Before an effect: validate authority/preconditions, reserve budget durably, write and sync
required blobs, append and sync intent, then dispatch. After the effect: inspect observable
state, append and sync receipt, then expose durable completion. Sync parent directories
when creating/renaming authoritative files. Atomic rename alone is not a durability claim.
Private file modes are 0600 and directories 0700 on Linux. Traverse without following
unexpected links; bounded regular-file reads must reject devices/FIFOs before blocking.

Suggested initial caps to freeze in DUR-001: 1 MiB checkpoint metadata, 64 KiB per journal
record, 32 MiB journal per goal, 64 MiB recovery blobs per goal, 128 operations per goal,
and 256 MiB aggregate goal-store budget. Existing tighter source/tool limits still apply.
These are starting engineering constraints, not benchmark measurements. Exhaustion stops
before the next effect; reserve capacity for terminal/error metadata. Never prune a live
goal, pending operation, or referenced recovery artifact to make room. No automatic journal
compaction in v1; explicit future compaction must prove equivalent recovery first.

Checkpoint publication: sync referenced journal/blobs first, write and sync a temp checkpoint,
atomically replace the checkpoint, sync its parent. Keep an independently verifiable previous
checkpoint until the new one is accepted. A truncated final journal record may be ignored only
when its uncommitted status is provable; missing committed data, invalid interior records,
checksum mismatches or sequence gaps require refusal. Never infer a new action from corrupt data.
Document process-crash guarantees separately from power-loss/filesystem guarantees.

## 5. Writer ownership is a pre-implementation gate

Only one writer may own a workspace and goal generation. A second CLI/process must refuse
before spawning tests, writing state or applying edits. An in-process boolean, PID file,
mtime timeout, or lock directory alone is insufficient evidence of safe stale-lock recovery.

DUR-001 must prototype a Linux OS-held lock. The preferred starting design is a private,
canonical workspace lock held through a `flock`-supervised executor, with a generation token
on every persisted mutation. Validate actual descriptor inheritance and process lifetime;
do not assume supervisor exit releases a lock while its worker is still alive. Detect the
capability with Doctor and fail closed if unavailable. Never unlink a lock file that could
still be locked; lock both workspace and goal in a fixed order where two locks are necessary.

The accepted design must cover existing CLI writers too: an ordinary interactive/headless
run or parallel publication must not bypass an active durable-goal lock. Internal API entry
points must validate a lease or acquire the same policy. Define ownership of the Git common
directory for publication separately from ownership of worktree file writes. The spike must
show two-process contention, parent death, worker death, stale-owner cleanup, PID reuse and
replacement-root refusal. If the supervisor design cannot satisfy these cases, submit a
specific replacement ADR and proof before DUR-002/DUR-005 implementation; do not quietly
ship weaker locking. This is a chief-review gate, not a request for new user permission.

## 6. Recovery by operation kind

| Operation at interruption                          | Required recovery behavior                                                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Read/search                                        | Re-read if necessary; invalidate facts whose source fingerprint changed                                          |
| Streaming provider request                         | Discard incomplete response; retain conservative usage reservation; start a fresh request only within budget     |
| Validated but undispatched model tool              | Reconcile prior effects, then request fresh planning; do not replay a stored provider command queue blindly      |
| Pending edit approval                              | Expire decision/token; reconstruct exact review and request a fresh decision                                     |
| Edit intent, no receipt, file matches before image | Mark not observed applied; fresh approval before any later application                                           |
| Edit intent, no receipt, file matches after image  | Record the after image as observed; recover undo; never write it again solely to obtain a receipt                |
| Edit intent, file matches neither image            | needs-attention; preserve files/backups; no auto-overwrite or rollback                                           |
| Interrupted creation                               | Distinguish missing file from matching after image; unexpected type/content requires refusal                     |
| Several edits partly applied                       | Reconcile each operation in order; keep successful edits and exact undo; do not claim group atomicity            |
| Test process without receipt                       | Result is interrupted/unverified; do not infer success from output fragments or launch a duplicate automatically |
| Provider/command effect with unknowable outcome    | Mark uncertain; do not promise exactly-once execution or billing                                                 |
| Final result emitted but completion record absent  | Re-evaluate durable criteria; don't trust an old UI card                                                         |

Matching after bytes proves observable state, not that Matrix caused every external change.
Record provenance honestly. For files edited repeatedly, keep the original pre-goal image
and final post-image for recovery while retaining operation-level reconciliation evidence.
Reuse the invariants in `integration-intent.mjs`, `isolated-manifest.mjs`, `pinned-write.mjs`
and the controller; do not copy an entire second implementation without a reason.

Before continuing, validate root identity, relevant paths, modes, content hashes and the
workspace revision. Git HEAD alone is not sufficient: uncommitted bytes and non-Git roots
matter. Workspace drift invalidates dependent evidence and needs an explicit reconciliation
decision; an ignored cache file is not automatically a source change. Freeze which paths
form the verification input set and explain exclusions rather than excluding all untracked files.

## 7. Authority, processes and cancellation

An approval is bound to exact plan/bytes, workspace identity, goal, operation, generation
and scope. The model cannot choose these fields or grant its own authority. Approval facts
may be recorded for audit; executable approval tokens must not survive restart. Resuming
a goal is not approval to rerun tests, publish Git refs, or repeat command effects. Existing
`--yes` remains edit-only; `--allow-tests` retains its exact-plan semantics for a fresh invocation.

No new side effect starts after cancellation wins the dispatch boundary. Operations already
dispatched are reconciled. Late callbacks from an old generation cannot alter the current
goal, approve a write or overwrite its result. Document this boundary and test both orderings.

Use the existing process cancellation/cleanup mechanisms. Do not kill arbitrary PIDs on
restart. Reclaim only processes with independently verified ownership (boot/process-start
identity plus a reviewed OS ownership mechanism); when ownership is uncertain, stop and
report it. A durable goal cannot resume dispatch while its previous owned test tree may still
be running. The locking/process spike must resolve this before enabling resumable tests.

## 8. Continuation, context and budgets

Default durable-goal round/tool ceilings initially match today's 8/24 limits. Allow explicit
bounded increases only through validated CLI configuration or a goal-budget amendment.
DUR-001 freezes upper limits and names. Never make "nonstop" mean unlimited retries or spending.
Track provider attempts, model rounds, tool dispatches and active elapsed time separately.

Reservations precede dispatch and survive crashes. Used/reserved totals are monotonic;
resume must not reset them. Uncertain provider charges remain unknown and reservations are
not refunded optimistically. Retry attempts count against their relevant limits. Persist
time at dispatch boundaries; reserve a maximum operation duration so crashes cannot repeatedly
avoid accounting. Approval waiting time is displayed separately from active execution time.
Cost telemetry retains provider/estimated/unavailable provenance. No strict monetary-budget
claim is allowed when upper bounds cannot be established; v1 need not expose a cost-cap flag.

Continue while authority, budget and progress permit. A trusted progress fingerprint should
include workspace state, current diagnostics/verification result, and pending task work.
Three equivalent failures with no changed evidence must stop as needs-attention, with an
explanation. This is an initial policy to validate, not a claim that all repeated tests are loops.
Changed code or new diagnostics can justify a bounded retry; new prose alone cannot.

On restart build provider context from the objective, trusted criteria, verified operation
summaries, remaining work and source-linked facts. Re-read stale facts. Do not invent an old
provider response or inject orphan tool replies. Do not persist hidden reasoning to make
resume work. Treat repository text, tool output, checkpoint summaries and retrieved notes
as data, never as approval-policy instructions. Context compaction must retain uncertainties,
denials and failures and must identify omitted evidence.

## 9. Acceptance criteria and interface

Use typed criteria: an exact authorized verification plan, an inspectable artifact predicate,
or a required human review. Model-proposed criteria are draft until the user accepts them.
Never let a model edit the criteria it is being judged against. Existing tests may be edited
as approved code changes, but assessor expectations and hidden checks remain outside the
agent workspace. Non-executable goals remain awaiting review when no trusted evaluator exists.

Proposed new command namespace (not yet implemented):

```text
matrix goal start "objective" --criteria <file> [--model <id>] [explicit limits]
matrix goal list
matrix goal inspect <id> [--json]
matrix goal resume <id> [fresh invocation approval flags]
matrix goal pause <id>
matrix goal cancel <id>
```

DUR-001 freezes grammar, criteria-file format, limits, result schema and exit-code mapping.
Read-only list/inspect never spawn or mutate. Pause/cancel must communicate through a verified
owner/control channel; no unverified PID signaling. Resuming an already running, completed or
cancelled goal refuses. Budget changes are explicit, versioned and shown before dispatch.
`--resume` for ordinary chat is unchanged. All new JSON output is bounded and redacted.

UI presents goal status, remaining criteria, last completed operation, current decision,
remaining budget, stop reason and the exact continuation action. It must distinguish
"session loaded", "goal reconciled" and "goal resumed". Persist correctness-critical state
before showing completion; render/observer exceptions must never erase it.
