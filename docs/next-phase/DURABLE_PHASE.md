# Durable engineering tasks

> Released after PRV-107 acceptance. Start with DUR-001 and see the [status board](STATUS.md)
> for current dispatch and dependency gates.

Prepared 2026-10-29 against `e1b3c66` (`Harden remote reads and undo recovery`).
This is an implementation brief, not a claim that the capabilities below exist.
The human project owner has assigned this chat's chief engineer to plan and audit;
implementation agents own bounded assignments and submit evidence for review.

## Start here

1. Read [AGENTS.md](../../AGENTS.md) and the current runtime documentation.
2. Read this brief and [architecture](ARCHITECTURE.md).
3. Claim one assignment from [agent tasks](AGENT_TASKS.md).
4. Read the [audit and evaluation protocol](AUDIT.md).
5. Record ownership and evidence in [status](STATUS.md).

For these assignments this brief is the durability backlog after the provider phase. `ENGINEERING_PLAN.md` and
`ENGINEERING_REVIEW.md` describe earlier work; their DONE labels and old test counts
are not acceptance evidence for this phase. Current runtime behavior remains the
compatibility baseline. User instructions take precedence over repository guidance.

## Product outcome

A user can give Matrix a bounded coding goal, see what remains, interrupt or lose the
process, and explicitly resume from verified durable state. Matrix reconciles completed
edits instead of repeating them, requests fresh authority when needed, and never treats
an interrupted test or an exhausted budget as task completion.

The first milestone is a Linux implementation on Node 22 and 24. This is the user's
actual target environment. Support other operating systems only through later,
separately verified implementations; do not spend this phase on portability rewrites.

The acceptance demonstration is a real repository issue involving at least two source
files and a regression test, with a forced process interruption between an applied edit
and its completion record. A new process must reconcile the edit, preserve exact undo,
request any necessary new decisions, finish verification, and present a reviewable diff.
The deterministic demonstration uses a mocked provider; live capability evidence is a
separate evaluation class and must be labeled accordingly.

## What exists and what is missing

| Area              | Existing implementation                                                           | Work in this phase                                                                      |
| ----------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Agent loop        | Bounded Local Forge and remote loops; remote defaults of 8 rounds / 24 tool calls | Explicit resumable goal state, cumulative budgets, progress detection                   |
| Persistence       | Bounded sessions, run logs, backups, integration intents                          | Authoritative goal journal and operation reconciliation                                 |
| Approvals         | Separate edit, test and sandbox-command decisions                                 | Bind decisions to a goal generation and operation; never replay authority after restart |
| Undo              | Exact before/after checks, backup integrity, Linux parent pinning                 | Recover ordinary goal edits across a crash without losing pending entries               |
| Tests             | 574 tests last passed on Node 22 and 24                                           | New deterministic and real subprocess interruption cases                                |
| Evaluation        | 16 local/mocked contracts                                                         | Separate durability profile and real-task capability baseline                           |
| Parallel work     | Isolated fixed batches; CLI uses Local Forge                                      | Preserve behavior; no new parallel-model product features yet                           |
| Code intelligence | Heuristic scope parser                                                            | LSP follows this milestone; do not bundle it into the durability change                 |

The baseline test results are prior evidence at `e1b3c66`, not fresh results for future
patches. Existing CI publication and live-provider capability must never be inferred
from local checks.

## Scope boundaries

Ship an opt-in durable goal workflow. Preserve ordinary commands, existing session
resume, the six default remote tools, and existing approval meanings. Legacy sessions
remain sessions; they cannot be silently promoted to resumable execution checkpoints.

Include durable operations for the tools the workflow actually exposes. The first
durable workflow excludes optional sandboxed commands until their interruption and
process-lifecycle contract passes the same audit. Existing standalone sandbox commands
continue to work unchanged. Do not expose a tool and then omit its durable accounting.

Do not add unrestricted shell execution, background wakeups, silent auto-approval,
credential storage, automatic Git commits/pushes, self-modifying policies, an editor
rewrite, vector-database memory, automatic model routing, or remote-agent delegation.
Do not increase existing limits silently. The future isolated development workspace
requires a separate authority design; today's snapshot writes still get discarded.

## Ownership and execution waves

Roles describe assignments, not assumptions about model intelligence. An implementer
does not approve its own work. The chief engineer integrates and records audit verdicts;
the human owner controls product scope and any separately required external authority.

| Wave | Assignment                                                             | May work in parallel                                                                | Gate before next wave                                                         |
| ---- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 0    | DUR-001 contracts and locking spike; EVAL-101 capability protocol      | Yes, disjoint files                                                                 | Chief approves schemas, state transitions, lock proof and evaluation protocol |
| 1    | DUR-002 store; DUR-003 operation reconciliation                        | Yes, frozen DUR-001 interfaces; no shared-file edits                                | Store corruption/crash tests and reconciliation tests pass independently      |
| 2    | DUR-004 executor and budgets; DUR-005 authority/controller integration | DUR-005 design/tests can proceed; implementation of shared runtime wiring is serial | A restart works through real controller and tool paths                        |
| 3    | DUR-006 CLI/UI; QA-101 adversarial durability harness                  | Yes, after runtime interface freeze                                                 | Real CLI kill/restart cases and clear user-visible states                     |
| 4    | INT-101 integration; chief audit                                       | Serial integration and full gates                                                   | Exact candidate diff and evidence accepted                                    |

At most three implementers plus the chief/reviewer should be active in this project at
once. This is a coordination choice, not a runtime agent limit. A second agent cannot
edit the same file without an explicit ownership handoff. If isolated worktrees are
used, record the base revision and bring back a reviewed patch; never assume uncommitted
changes exist in another checkout. In a shared checkout, obey the file reservations.

The chief owns `AGENTS.md`, `NEXT_PHASE.md`, shared documentation, `package.json`,
`package-lock.json`, `jsconfig.json`, CI configuration and shared test helpers. The
specific owner of `lib/controller.mjs`, `lib/model-agent.mjs`, `bin/matrix.mjs`, and
`src/matrix.mjs` is recorded before edits. New dependencies require a written rationale
and chief review; that is a review checkpoint, not a blanket request to the user.

## Delivery gates

- G0: Accepted contract and an executable proof of the selected cross-process writer lock.
- G1: Bounded durable storage survives process interruption, corrupt records and disk errors.
- G2: Every exposed side effect reconciles conservatively; no stale authority is replayed.
- G3: Goal continuation preserves budgets, current evidence and recoverable edits.
- G4: Real CLI restart/cancel behavior and adversarial evidence pass independent review.
- G5: Node 22/24 engineering gates, existing evaluation, new durability profile, responsive
  smoke and package checks pass on the integrated candidate; hosted CI is separately recorded.

Missing evidence is `NOT EVALUATED`, not PASS. Known acceptance failures are `FAIL`,
not a request to redefine the criterion. A task moves to ACCEPTED only through a
chief review entry naming the exact revision or patch digest.

## Follow-on milestones, not current assignments

1. **Persistent isolated development workspace:** retain approved development outputs,
   manage owned processes, and review complete deltas; explicit dependency/network policy.
2. **LSP-001:** TypeScript/JavaScript and Python definitions, references, diagnostics and
   rename; language-server lifecycle, cancellation, document versions and stale-result tests.
   Language servers execute code and need a trusted launch/configuration policy.
3. **Coherent multi-file changes:** create/edit/rename/delete plans, conflict handling and
   recovery. Do not imply a filesystem-wide atomic transaction where only per-file atomicity exists.
4. **Independent verification:** task criteria, regression tests, final-diff review and
   verification tied to the exact tested bytes.
5. **Remote-model parallel execution:** dependency-aware assignments, isolated authority,
   integration review, cancellation and measured quality/cost benefit over a single agent.
6. **Grounded memory and integrations:** source-linked facts with invalidation, documentation
   retrieval, browser verification and issue/PR/CI workflows under explicit service authority.

Each follow-on needs its own bounded brief and audit gate. None is pre-approved as
complete by this document. Consult the LSP specification for semantic capabilities and
Tree-sitter for syntax parsing; neither is a replacement for the other:
[LSP](https://microsoft.github.io/language-server-protocol/),
[Tree-sitter](https://github.com/tree-sitter/tree-sitter).

## First dispatch

After PRV-107 acceptance and release of the durable phase, assign DUR-001 and EVAL-101 first. Their outputs let the chief approve concrete
contracts before agents edit the shared runtime. Use the copyable assignment template
in `docs/next-phase/AGENT_TASKS.md`. This planning delivery does not launch agents,
change runtime behavior, commit, push or authorize live-provider spending.
