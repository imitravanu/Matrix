# ADV-001 implementation decision and acceptance record

Completion review on 2026-10-29 uncovered defects in non-Git result validation and the final terminal
handoff. Both have been fixed and covered by regressions. Node 22.23.4 and Node 24.21.0 each pass the
570-test engineering gate. See ADV_001_REVIEW.md for the original evidence and follow-up validation.
Existing uncommitted work is preserved.

The accepted design integrates into a retained private result workspace. The original workspace is
never an integration destination. Git publication creates a new branch; non-Git publication retains
the result directory. This replaces the earlier live-workspace integration workflow.

## Completion checklist

- Independent bounded agents, isolated leases, independent approvals, explicit conflict selection.
- Exact final approval binds edits, result directory, Git base, and publication ref.
- Combined verification runs in the result workspace with fresh test trust.
- Durable intent precedes result writes; recovery reconstructs undo for present approved postimages.
- Divergent files, changed directory identities, or invalid intents refuse recovery without writes.
- Git publication preserves the original HEAD, index, and working files; occupied refs are refused.
- Interrupted publication retries deterministically with a fresh review and no duplicate commit.
- Denial/cancellation clean child leases; retained recovery/results survive cleanup intentionally.
- Final Node 22/24 engineering, smoke, evaluation, sandbox, and package gates pass.

The final gate results and task status are recorded in ENGINEERING_PLAN.md. The approved scope is the
Linux Local Forge parallel CLI, with two through eight tasks and at most two active agents. The
ordinary single-run Swarm remains a projection. No live remote-model or cross-platform claim is made.

## Why the design changed

Ordinary rename cannot combine content validation and replacement atomically. The previous coordinator
could overwrite an original-file edit between its last check and rename. More checks did not remove
that gap. The supported parallel workflow now writes only into its private result snapshot; a real
subprocess regression verifies concurrent edits in the original survive.

The coordinator's internal atomic writer still requires exclusive ownership of its destination while
applying edits. It is not a content compare-and-swap primitive. Do not redirect it back to a live shared
workspace. A same-user process deliberately editing a private result concurrently is outside that
ownership contract. Recovery refuses observed divergence rather than guessing or overwriting it.

## Recovery and publication

`matrix recover <intent>` reconstructs a session without changing project files. Existing parallel
sessions reconcile automatically on load. Recovery arming is separate from explicit undo; every undo
still validates its target. A matching postimage does not assert test success or write provenance.
Legacy intents without a pinned workspace identity remain read-only inspection artifacts.

Git commits contain the approved changes on the pinned base. They are assembled with sanitized Git
plumbing and a private index; filter, signing, and hook commands are not used. Publishing never checks
out the branch. The ref is created only if absent, or recognized as an identical deterministic retry.
See [Git update-ref semantics](https://git-scm.com/docs/git-update-ref).

Published Git commits retain normal Git file-mode semantics (executable or ordinary file); retained
workspace recovery uses the original snapshot modes. Unexpected corruption, unavailable storage, and
unsupported filesystem durability fail visibly. Artifacts are preserved for inspection; no automatic
rollback or test-success claim is made on uncertain state.
