# Cache invalidation repair: implementation constraints

The old probe observation reappears after A → B → A because discovery and probe
records are keyed only by `targetDigest`. Deleting files after replacement alone
does not close the bug: an A probe or discovery refresh started before replacement
can complete after deletion and restore the old record. A check of the current
digest alone also cannot distinguish A → B → A from an unchanged A.

A safe repair needs a persistent per-profile generation that changes on the
relevant configuration mutation and is never derived solely from profile bytes.
Observations must capture their generation before network work and include it in
the record. Readers must require the current generation as well as the target
digest. Late writers must serialize their final generation check and publication
against the configuration mutation, using the existing configuration lock; they
must not publish if the generation changed. The same rule must cover discovery
snapshots, failed-refresh status, probe results and concurrent probe updates.

The generation update must be crash-safe and fail closed: a crash or failed
mutation may discard cached observations, but must not resurrect stale ones.
Profile removal and re-addition must advance identity too. Existing records
without a generation must be treated as unavailable, not promoted silently.
Avoid invalidating an unrelated profile, and preserve the documented behavior
for a rename if the execution-affecting configuration did not change.

Required deterministic cases: successful A → B → A; A refresh/probe held in
flight while A → B → A completes; a record write racing replacement; crash or
failure around generation/config publication; concurrent independent profile
updates; remove/re-add; stale failure status; and proof that a freshly completed
B observation remains usable. Use isolated homes, fake credentials, and
controlled barriers. The review must inspect persisted bytes and failure paths.

Subsequent implementation adds per-profile generations and checks publication
under the configuration lock. A → B → A, late probe/discovery success and
failure, remove/re-add, corrupt markers and a fresh observation are covered by
targeted tests. The Node 24 full check passed 729 tests; the affected provider
suites passed 67 tests on Node 22. This is submitted for independent review;
crash injection and full two-runtime acceptance have not been established here.
