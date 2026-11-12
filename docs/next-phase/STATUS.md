# Next-phase status and dispatch board

**2026-11-12 DUR-001 coverage-boundary repair: ACCEPTED; release remains
BLOCKED.** A second re-review of the 2026-11-12 repair reproduced two more false
completions from one failure family: the evidence identity did not cover the
complete filesystem input boundary the disposable snapshot exposes.
Execution-relevant permission bits were absent from the directory walk, so a
test that executed `helper.sh` still completed after the host removed the live
file's execute bit. And a plan whose working directory was a subdirectory could
read a sibling input such as `../input.json`, which neither the selection
directory nor the static import closure covered. Both are repaired in
`lib/goal-source-manifest.mjs` by deriving the identity from the snapshot
boundary itself: the whole workspace is the selection root, the snapshot's own
exclusion rules and entry/directory/depth/byte budgets are imported from
`lib/linux-snapshot.mjs` instead of being duplicated, the traversal is bounded
and never follows a link, and every entry records its existence, entry type,
permission bits, content digest and symbolic-link target. A working-directory
selection or a static import closure is no longer treated as a coverage proof.
The same identity is applied at dispatch, at the live-versus-snapshot
comparison, after the test, at acceptance and on resume. Both independent
reproductions now pass, together with permanent regressions for permission
bits, entry types, sibling inputs outside a subdirectory plan, an excluded host
directory, a closed directory and unchanged-input success controls, and every
previously repaired regression is preserved. `npm run check` passed
1,075/1,075 with 0 skipped on Node 22.23.1 and Node 24.21.0, the durability
harness passed 20/20 on both runtimes, the evaluation passed 16/16 with 0
safety violations on both, and pack verification passed with 110 files.

**Acceptance disposition, 2026-11-12.** The repair is **ACCEPTED** against
the exact candidate below, on the independent focused re-review
(`/tmp/matrix-dur001-independent-review.md`): the submitted manifest and
isolation tests passed 38/38 with 0 failed and 0 skipped, 3 independently
reconstructed probes passed with 0 failed, both on Node 24.21.0 with real
Bubblewrap, the candidate-record correction is closed, and the digest was
recomputed from the repository root and matches. The accepted candidate is HEAD
`b7966a076fab79724e56ba79afb62c1ebdda0ed3` on branch `matrix/int101-hosted-ci`
plus the submitted working-tree repair, with the integrated 45-file candidate
at
`f46b90b424625f804d0e959dcb43151cd30e92b15f0f3818a5bb0b02797f7c28`, the DUR-005
29-file candidate at
`e239d002633ca94134ed18e170d8912304c69c1b6208499edf22e929b2ca5c68` and the
DUR-006 14-file candidate at
`fe95bc4cee570936f9e6c9567e4bf3f94a69c2e4cbe2edfdbaf3d4356475bf1a`.

The acceptance is scoped. The independent review was a focused review of the
snapshot identity repair, not a new audit of every completed phase, and it did
not re-audit the earlier waves independently. The full Node 22/24 engineering
gate at 1,075/1,075 and the durability harness at 20/20 were reported by the
submission and were not independently rerun or log-verified in the review turn;
they are accepted as the author's reported evidence for the submitted
candidate, not as independently verified evidence. The candidate-record
correction changed no runtime file, so no prior runtime evidence was invalidated
and no runtime suite was rerun for it.

REL-001 stays **BLOCKED** on one item, which is not another acceptance review:
an **exact-candidate hosted CI run on Node 22 and Node 24 for the committed
candidate**. Run 42871859453 covers `b7966a0` exactly and predates this
working-tree repair, so it is not evidence for this candidate. Acceptance of
the repair does not move the release to READY.

One known stale statement is tracked rather than hidden: `MATRIX.md` is a
manifest member, so its bytes are bound by the accepted digests, and its
"Contract status" paragraph still says the repair is "submitted, not
accepted". Correcting it would change the DUR-006 and integrated digests away
from the independently reviewed values and require a new candidate review, so
it is deferred to the next documentation candidate. The decision record's
acceptance addendum is authoritative in the meantime.

The member digests are now stated with their membership so they are
reproducible from the repository: the DUR-005 candidate is 29 files
(`docs/next-phase/fixtures/dur005-members.txt`) at
`e239d002633ca94134ed18e170d8912304c69c1b6208499edf22e929b2ca5c68`, the DUR-006
candidate is 14 files at
`fe95bc4cee570936f9e6c9567e4bf3f94a69c2e4cbe2edfdbaf3d4356475bf1a`, and the
integrated union is 45 files
(`docs/next-phase/fixtures/integrated-members.txt`) at
`f46b90b424625f804d0e959dcb43151cd30e92b15f0f3818a5bb0b02797f7c28`. The earlier
28-file and 44-file lists were not recorded verbatim, so those values are
superseded by the memberships above rather than silently reused. The 43-file
integrated list recorded for the same repair was superseded by the candidate-record
correction below, which restores the two missing members.

**2026-11-12 candidate-record correction: integrated manifest restored to 45
members.** The focused re-review of the coverage-boundary repair
(`/tmp/matrix-dur001-independent-review.md`) closed the two runtime blockers —
38 submitted regression tests and 3 independent probes pass — and left one
candidate-record issue: `docs/next-phase/fixtures/integrated-members.txt` held
only the 43-file DUR-005/DUR-006 union and had dropped `package.json` and
`eval/durability/run.mjs`. The INT-101 integration report defines the
integrated fingerprint as the sorted union of the DUR-005 and DUR-006 path
lists **plus** `package.json` and `eval/durability/run.mjs`, so the 43-file list
was not the integrated manifest. Because the durability harness is modified in
this candidate, the 43-file digest did not bind the changed acceptance
evidence. Both members are restored, the list is 45 unique files and the
digest was recomputed from the repository root over sorted relative paths, each
followed by one NUL byte and the raw file bytes:

```sh
{ while IFS= read -r f; do printf '%s\0' "$f"; cat "$f"; done \
    < <(LC_ALL=C sort docs/next-phase/fixtures/integrated-members.txt); } | sha256sum
# f46b90b424625f804d0e959dcb43151cd30e92b15f0f3818a5bb0b02797f7c28  -
```

The digest was recomputed and checked, not copied from the review. The manifest
file is now stored in sorted order, so reading it top to bottom reproduces the
digest; the previous file listed `MATRIX.md` and `README.md` in ambient-locale
order, which hashed to a different value than the recorded sorted digest. The
correction is metadata only: **no runtime file changed**, the DUR-005 29-file
and DUR-006 14-file digests are unchanged, and the reviewed runtime evidence
therefore still covers this candidate, so no runtime suite was rerun. The
43-file value `db8fd6856f0780faa9cb84f94c51b461b31091a1f6c0b85b29d75d3db643cd88`
is superseded rather than deleted: it remains the identity of the 43-file list
that was recorded, which was not the integrated manifest. REL-001 stays
**BLOCKED** on a hosted CI run for the exact candidate; the run for `b7966a0`
does not cover this tree, and the independent acceptance review is closed — see
the acceptance disposition at the top of this board.

**2026-11-12 DUR-001 blocker repair (superseded).** The preceding repair
reproduced two source-identity blockers. Root-directory selection produced
`./name` paths that the bounded reader rejected, so a data file's content hash silently became
`null`; and installed `node_modules` bytes were excluded from the identity even
though the disposable snapshot copies and executes them. Both are repaired in
`lib/goal-source-manifest.mjs`: selection paths are normalized, every covered
regular file must be hashed (an unreadable input refuses verification), symbolic
link targets are bound, and installed dependency bytes are part of the identity,
with an explicit refusal when dependency coverage is unsupported or beyond the
snapshot-compatible budgets. The crash regression repaired on 2026-11-11 is
unchanged. Both independent reproductions now pass, together with permanent
regressions for nested data, dependency additions and deletions, symlink
retargeting, unreadable inputs, an oversized input and unchanged-input success
controls. `npm run check` passed 1,066/1,066 with 0 skipped on Node 22.23.1 and
Node 24.21.0, the durability harness passed 20/20 on both runtimes, and the
evaluation passed 16/16 with 0 safety violations on both. The DUR-005 28-file
candidate is now
`0eac7b61bb306f34258b9f0c651ae7fc8600e51d65f703a9f33ca38c5eadd27c`, the DUR-006
14-file candidate is
`c6a26536d1a20e699c5fa8693bfcdafbe5cd605be82e43b9bbc139b93486341e`, and the
integrated 44-file candidate is
`856312a0c2bd4444ae13f8458fb3f24dbb6f39447f6688f743d9acc3d147c771`. The repair
was **SUBMITTED, not accepted**, and the values above are superseded by the
coverage-boundary repair's memberships.

**Release-readiness review on 2026-11-11: verdict BLOCKED.** Candidate
`b7966a076fab79724e56ba79afb62c1ebdda0ed3` on branch `matrix/int101-hosted-ci`,
base `ff55a2c` unchanged. The hosted matrix for that exact commit is
[run 42871859453](https://github.com/imitravanu/Matrix/actions/runs/42871859453)
(run number 13, `head_sha` identical to the candidate, conclusion **success**):
1,033/1,033 tests with 0 skipped on Node 22.23.1 and Node 24.21.0, 16/16
evaluation contracts with 0 safety violations, 20/20 durability cases, 32 smoke
frames, 109 packed files, 0 audit vulnerabilities, the real Bubblewrap
adversarial tests, and the Doctor policy probe all green. Every verification,
safety and packaging gate in `RELEASE.md` is satisfied by evidence for this
candidate.

A documentation patch prepared on 2026-11-11 closes the release-readiness
findings: the 25 Markdown hard-break findings are removed so `git diff --check
ff55a2c` is empty, `CHANGELOG.md` records the durable-goal capability and its
Linux/Bubblewrap/pidfd requirements, and `MATRIX.md`/`README.md` now state the
goal process-ownership boundary, the live-filesystem and host-network test
containment, the credential exposure and the required trust and approval. The
patch edits `README.md` and `MATRIX.md`, which are members of the DUR-006 and
integrated manifests, so those digests were recomputed: DUR-006 is now
`fd89f0ab8d8a093310a936be29d1a428a1dc77df234241a8ddc1d1d47f266bf3` and the
integrated manifest is
`b436903fd2de87e19762e27380d2bcc7ecc9b51b34eec3a49df3139228dfc3e4`; DUR-005
remains `d43753d8c5362ad7a4ef102c6cc68c0f4a7f2aee0cf2b50a93a79bb626ece14e`.
An earlier statement that the edits changed no fingerprinted file was wrong and
has been corrected. The independent-review repair of 2026-11-11 changed those
members again, corrected `README.md` and `MATRIX.md` (both still described the
live-workspace and host-network test boundary that the contract repair
replaced) and expanded the manifests, so the digests after that repair were the
DUR-005 28-file candidate
`8c8821ede769ee338b0796a50f36cfa096ffe9c07ef8f122a545a7ade53df855`, the
DUR-006 14-file candidate
`0a39f962ba8976e81a8a29ab8b15ecd897b6cfcc1bf7ff078f7cd757fbbac237` and the
integrated 44-file candidate
`51d91f1351e817183358103991e9521f9c5d7f8ab8381f7295233e364248fea9`.

**The DUR-001 contract repair is SUBMITTED for a fresh independent security
review** (superseded 2026-11-12: the repair is now **ACCEPTED** against the
integrated 45-file candidate `f46b90b4…`; see the acceptance disposition at the
top of this board). The goal test path now runs in the disposable-snapshot
boundary the decision record requires: a disposable no-follow workspace snapshot
bound at the canonical workspace path, a minimal read-only root with no `/home`,
`/root` or `/var`, a new empty network namespace, and the credential-cleared
environment. The PID-namespace ownership, the reviewed pidfd signalling, the
durable teardown block, the exact test-plan approval, the cumulative budgets
and the crash-recovery path are unchanged.

The focused independent review of that repair returned **CHANGES REQUIRED**
with three findings, and all three are now addressed. **P1:** the test
evidence was bound only to the goal's artifact and edit paths, so an unedited
dependency of the approved test could change during the test and the goal
still completed. The new `lib/goal-source-manifest.mjs` binds the evidence to
the complete input set of the dispatch — the approved test's own files, the
runner configuration, the imported workspace modules and the runner's
selection directory — and detects a change, an addition or a deletion at
dispatch, after the test and at acceptance. **P2:** the crash regression
filtered a receipt field that does not exist, so its success check was
vacuous; it now uses the operation-history API and asserts the readiness
barrier, the observed `SIGKILL` and the fresh-process verified teardown.
**Manifest completeness:** the candidate manifest now binds
`lib/linux-bwrap.mjs`, the new manifest module and the three regression
files. The contract text is unchanged and the repair is **not accepted** until
a fresh independent security review takes it.

**Two things still block the release** (as recorded on 2026-11-11; superseded
2026-11-12). First, that fresh independent security review of the DUR-001
contract repair — **closed on 2026-11-12**, when the focused repair review
closed every finding and the repair was ACCEPTED against the integrated
45-file candidate `f46b90b4…`. Second, an exact-candidate hosted matrix run for
the patched and repaired candidate — **still open**. None of the four documented
QA-101 follow-ons blocks the release. See the
[release-readiness record](../../RELEASE.md#release-readiness-record--rel-001-candidate-b7966a0-reviewed-2026-11-11),
the [DUR-001 review addendum](decisions/DUR-001.md#2026-11-11-review-addendum-open-contract-discrepancy),
the [DUR-005 submission](submissions/DUR-005.md#november-11-dur-001-independent-review-repair-submitted)
and [section 14 of the integration report](reports/2026-11-09-int101-integration.md#14-release-readiness-review-2026-11-11).
No tag, publication or deployment was performed or authorized.

**Hosted CI PASSED on 2026-11-10 for branch `matrix/int101-hosted-ci`.** The
accepted integrated candidate was committed byte-exact as `1ad420e`, which
reproduces the integrated fingerprint
`dfa62616fa86221aa37601e1c271a9b7fe88e6d3bfc66340e4014a116e973847` when its
tree is extracted. Two follow-up commits add the missing hosted CI coverage
and a checkout-portable durability harness (`a8fe1c9`) and repair the
DUR-001 live-writer test's dependence on an ambient provider credential
(`46ed6ea`). The pushed head is `b7966a076fab79724e56ba79afb62c1ebdda0ed3`,
on base `ff55a2c` with no history rewritten. Hosted
[run 42867616263](https://github.com/imitravanu/Matrix/actions/runs/42867616263)
passed on Node 22 and Node 24 with every step green, including the newly
added durability harness, the Doctor policy probe and the real Bubblewrap
execution. The documentation-only follow-up commit was verified by
[run 42870057251](https://github.com/imitravanu/Matrix/actions/runs/42870057251),
and the branch head by
[run 42871859453](https://github.com/imitravanu/Matrix/actions/runs/42871859453),
all three green on both runtimes. See
[section 13 of the integration report](reports/2026-11-09-int101-integration.md#13-hosted-ci-verification-2026-11-10).

The CI portability repair changed three non-production files, so the DUR-005
23-file candidate is now
`d43753d8c5362ad7a4ef102c6cc68c0f4a7f2aee0cf2b50a93a79bb626ece14e` and the
39-file integrated candidate is
`2e7419851e8f26333a2219d4f026092b62968f26fd0538a54a299e00c192676c`. DUR-006
remains `da9d9d752d0c`, and the accepted QA-101 harness and audit hashes still
match. Every production runtime file is byte-identical to the accepted
candidate, and `test/goal-lock-spike.test.mjs` is not a member of any
published manifest, so its repair changed no fingerprint.

**INT-101 ACCEPTED on 2026-11-10.** The chief closed C1 after reviewing the
existing namespace test repair and independently checking identity cases and
SIGKILL recovery. The DUR-005 23-file candidate at the time of that closure
was `10d99cb02543adccf7bea8859632f21a0910ba6e8d25493c4fa5bd01f37dc749`; only
`test/goal-runtime.test.mjs` changed from the earlier accepted candidate.
DUR-006 remains `da9d9d752d0c`, and the accepted QA-101 harness and audit hashes
still match. The 39-file integrated candidate at the time of that closure was
`dfa62616fa86221aa37601e1c271a9b7fe88e6d3bfc66340e4014a116e973847`.

Both full engineering logs show 1,033/1,033 passing tests on Node 22 and Node 24.
The repair passed 20/20 stress runs. The chief reran the focused namespace and
SIGKILL tests, the durability harness on both runtimes, eval (16/16), smoke
(32 frames) and package verification (109 files). C2–C4 report corrections are
also closed. See the [final chief disposition](reports/2026-11-09-int101-integration.md#12-chief-closure-2026-11-10)
and [updated DUR-005 submission](submissions/DUR-005.md#november-10-c1-test-oracle-repair).
Local durability integration is complete, and hosted CI is now evaluated and
passing. Live capability improvement remains NOT EVALUATED. Release actions,
tags and publication remain unauthorized.

**QA-101 ACCEPTED on 2026-11-09.** The independent acceptance review of the
durability adversarial audit issued **ACCEPT** in the
[2026-11-09 acceptance review report](reports/2026-11-09-qa101-acceptance-review.md).
The candidate files match the reviewed hashes: `eval/durability/run.mjs`
(`e46b7a6f201e807d4f4601d71f0a13ef0ff0701b6901057694b258a35ed92334`) and
`docs/next-phase/reports/2026-11-08-qa101-durability-audit.md`
(`e501164b67616a120f6c3a1c3e0654071db015a7dba9bd9c92e64dd231bcabc6`) on base commit
`ff55a2c2aaeb863e881a5a8d0e112eb78ded0204`, with DUR-006 14-file candidate SHA-256
`da9d9d752d0c44b042cb8f608e8b50ca7eaef0498569c0c1870f37dcdecdbce8`, accepted DUR-005
23-file runtime SHA-256 `17c6992a5a507b301d3297f69ce598cdf0046ef0078081d8f4b5e15a032aea02`,
and clean `git diff --check`. Multi-runtime execution verified 18 PASS / 2 PARTIAL
(0 FAIL) across the 20 crash-recovery cases, with 57 PASS / 2 NOT EVALUATED (0 FAIL)
across 59 variants on both Node 24.21.0 and Node 22.23.1, with zero flakiness.
Engineering gates (`syntax`, `lint`, `typecheck`, `format:check`) all exit 0, and
recorded 1,032/1,032 test/coverage evidence is reused. The
[chief disposition](reports/2026-11-09-qa101-acceptance-review.md#11-chief-disposition-2026-11-09)
records that every mandatory CR case meets its criterion. CR-08 meets it through the
verified-stopped branch of "verified stopped or resume refuses". For CR-16, a chief probe
shows the production store refuses a post-cancel dispatch with `stale fence`, so the
cutoff does not depend on the harness barrier. Durability accepted; capability improvement
not evaluated. Follow-ons: CR-16 harness barrier forwards to the real store (P2, QA);
cancel-versus-dispatch stop classification (P3, executor); CR-08 refusal-branch test hook
(P3). See the [audit report](reports/2026-11-08-qa101-durability-audit.md)
and [acceptance review](reports/2026-11-09-qa101-acceptance-review.md).

**DUR-006 ACCEPTED on 2026-11-08.** The independent re-review of Finding R1
issued **ACCEPT** in the
[2026-11-08 R1 re-review report](reports/2026-11-08-dur006-r1-re-review.md).
The current working tree was re-fingerprinted against candidate `da9d9d752d0c`
before closure: base commit `ff55a2c2aaeb863e881a5a8d0e112eb78ded0204`, 14-file
candidate aggregate SHA-256
`da9d9d752d0c44b042cb8f608e8b50ca7eaef0498569c0c1870f37dcdecdbce8`, and the accepted
DUR-005 23-file runtime fingerprint
`17c6992a5a507b301d3297f69ce598cdf0046ef0078081d8f4b5e15a032aea02` all match
the report exactly, and `git diff --check` is clean. The report reuses the
recorded verification evidence (1,032/1,032 `npm run check` on Node 22.23.1
and Node 24.21.0 with all coverage floors, 35/35 targeted DUR-006 tests, 16/16 eval
contracts, 32 smoke frames, 109 pack files) along with the earlier verified
reproductions and independent subprocess tests for Findings 1, 2, and R1. See the
[submission](submissions/DUR-006.md),
[independent review](reports/2026-11-08-dur006-independent-review.md),
[repair re-review](reports/2026-11-08-dur006-repair-re-review.md), and
[R1 re-review](reports/2026-11-08-dur006-r1-re-review.md).

**DUR-005 ACCEPTED on 2026-11-08.** The independent verification of the
follow-up repair's remaining Findings 3 and 7 issued **ACCEPT** in the
[2026-11-08 follow-up findings report](reports/2026-11-08-dur005-followup-findings-3-7.md).
The current working tree was re-fingerprinted against that report before closure:
base commit `ff55a2c2aaeb863e881a5a8d0e112eb78ded0204`, 23-file candidate aggregate
SHA-256 `17c6992a5a507b301d3297f69ce598cdf0046ef0078081d8f4b5e15a032aea02` and tracked
patch digest `f8598a668cd9a25bc4d5d13aa5baf65bf224fa901615b8a707e315b85f1d295a` all
match the report exactly, and `git diff --check` is clean. The report reuses the
submitter's existing verification evidence (997/997 `npm run check` on Node 22.23.1
and Node 24.21.0 with all coverage floors, 16/16 eval contracts, 32 smoke frames)
and the earlier verdicts for the five already-closed findings, so no re-run was
required for acceptance. See the
[re-review](reports/2026-11-08-dur005-repair-re-review.md) and
[follow-up submission](submissions/DUR-005.md#november-8-follow-up-repair).

**PRV-107 ACCEPTED for the reviewed provider candidate.** The consolidated
[acceptance review](reports/2026-11-04-prv107-provider-acceptance.md) records 24/24
mandatory cases passing and the Node 22/24 engineering evidence. The accepted base
is `ff55a2c`, with 98-file runtime fingerprint
`2743c680fd6ad6549d9dfb2ae550585de756a0106cf6aebd1df01b24d9a2869c` and pre-report
working-tree fingerprint `7617cd71ba4a3e7423ced18254e370129623443cc7862cbe953f3d47183f7dfe`.
The tracing finding is closed for the documented Yama scope 2/3 threat model.
F-1 and F-3 remain prerequisites for evaluator certificate use. F-2 limits reported
success to conformance with the fixture until scoring improves. F-4 is deferred
hardening. Live provider compatibility and quality remain NOT EVALUATED.

**DUR-001 ACCEPTED on 2026-11-05.** The [independent re-review](reports/2026-11-05-dur001-independent-re-review.md)
recommends acceptance for base `ff55a2c` and the five-file candidate SHA-256
`71f7604be8181d45308d2602fc339bfff01a1134f668023de0416f55475c8528`.
The tracked patch digest and five-file fingerprint match the reviewed checkout.
The Linux lock spike shows
that a detached child can write after a second writer acquires a released lock,
including if it received and closed the descriptor. A Bubblewrap reaper holding the
descriptor kept the second writer out after both the supervisor and command died.
Killing the reaper exposed a teardown race on Node 22 and 24. A separate guardian
that kept the lease until both the reaper and worker exited prevented early lock
acquisition. Surviving writes stayed in the snapshot. See the
[DUR-001 decision record](decisions/DUR-001.md).
Dependent tasks use the reviewed DUR-001 contracts and ownership design.

DUR-001 now includes the pure `lib/goal-contracts.mjs` metadata, lifecycle, evidence,
budget, journal, operation-intent, dispatch, receipt and lease validators with tests in
`test/goal-contracts.test.mjs`. The implementation adds checkJs and coverage gates for
this module. Canonical bounded serialization, checksum links, sequence/generation
rules and pre-mutation lease validation are part of the reviewed contract layer.
Production process ownership, generation persistence and writer integration are
implementation work for the dependent tasks. The interfaces and Node 22/24 results
are in the decision record.

The model-agent write demonstration now holds the Linux workspace lock through atomic
replacement. A real contender at the rename boundary verifies that the lock remains held.
The independent re-review confirmed the repair.

**DUR-002 ACCEPTED for the Linux store boundary.** It implements lease-checked journal updates, previous checkpoints, recovery
blobs, quota enforcement and read-only inspection. The
[DUR-002 decision record](decisions/DUR-002.md) describes the commit protocol,
fault tests and handoff to reconciliation. The [submission](submissions/DUR-002.md)
records the independent acceptance of candidate `70e88900fe77` and the passing
Node 22 and 24 checks. DUR-003 can use the accepted store for reconciliation.

**DUR-003 ACCEPTED on 2026-11-06 for the implemented recovery boundary.** The
previous [independent review](reports/2026-11-05-dur003-independent-review.md)
returned **CHANGES REQUIRED** for candidate `09be91e971ea`: B1 hid later dispatched
effects after an undispatched intent, B2 missed cancellation committed during
the final validation read, and B3 silently overwrote targets replaced after
that read. The [repaired submission](submissions/DUR-003.md) records six-file
SHA-256 `b243209f0299f450f432fe93556bade953d5c0875c9a27af930f7d752df88f43`
(four owned files: `c2a4651d870177a7d46c86c1508b69877fada35268ce405a9ba8f56460637eee`)
on the same base `ff55a2c2aaeb863e881a5a8d0e112eb78ded0204`.

The repair uses state-chain reconciliation across abandoned intents, re-reads
commit authority after the final target read, and publishes through a
quarantine/verify/no-clobber `link(2)` protocol with rollback, retention and
cleanup reporting, including exact undo. It explicitly documents the residual
fence-to-publication and crash-retention boundaries rather than claiming full
store/filesystem atomicity. All three blockers were reproduced on Node 22 and
24 and are covered by persistent regressions for edits, deletions, creations,
undo, modes, cancellation, lease renewal, generation advance, cleanup failures,
repeated edits across attempts and SIGKILL crash boundaries.

The latest quarantine repair persists transaction identity before capture, surfaces
unresolved commits during read-only recovery, and blocks effects and undo until
operator reconciliation. Public results preserve accessible retention paths and
cleanup-pending information. Self-review and 11 added regressions cover crash and
cleanup-failure boundaries. The focused suite passes 98/98 tests.

Verification: full `npm run check` 906/906 pass, 0 fail, 0 skip on Node 24.21.0 and
Node 22.23.1 with coverage floors met; evaluation 16/16 contract pass, smoke 32
frame checks, package dry-run 95 files, and `git diff --check` clean.

The [independent acceptance review](reports/2026-11-06-dur003-acceptance-review.md)
matched all three candidate identities and issued **ACCEPTED** for the implemented
recovery boundary. It reproduced B1/B2/B3 as conservative, exercised 14 real-SIGKILL
capture/verification/publication boundaries for write, delete, create and undo,
cleanup retention and reopening, legacy artifacts, corrupt/oversized/unsafe metadata
and dual-object rollback on Node 22.23.1 and Node 24.21.0, and re-ran the focused
suite at 98/98 on both. Unresolved transaction artifacts still require operator
reconciliation; the boundary blocks effects and undo until the retained evidence is
resolved. Executor/controller integration (DUR-004/DUR-005), CLI/UI recovery
(DUR-006), physical power loss and non-Linux platforms remain NOT EVALUATED. P3
follow-ons: orphan pre-manifest staging files, cross-goal artifact over-block,
unstructured corrupt-metadata refusals, and partial multi-entry undo retention
reporting; none weakens the accepted boundary.

**DUR-004 ACCEPTED on 2026-11-06 for the implemented executor boundary.** The
[independent acceptance review](submissions/DUR-004.md#12-independent-acceptance-review-2026-11-06)
matched the eight-file, six-file and tracked-patch identities, exercised surviving
processes across workspace rename and replacement, concurrent admission, late
callbacks and positive controls, and found no blocker. DUR-005 retains process
reclamation and controller integration.
The [DUR-004 submission](submissions/DUR-004.md) implements the
resumable executor, bounded context and cumulative budgets in
[`lib/goal-executor.mjs`](../../lib/goal-executor.mjs), [`lib/goal-context.mjs`](../../lib/goal-context.mjs)
and [`lib/goal-budget.mjs`](../../lib/goal-budget.mjs), with focused tests and the
[two-source-file scripted-provider demonstration](fixtures/dur004-scripted-resume.mjs).
The revised six-file candidate is
`bc78ec7f92e1a27676bb89e0359f7c10fc62dc521858aaef659b1cc5732b0250` on base `ff55a2c`
(three owned modules `17767466fcd877cf37e0906c441fd363228bf0974e1a8d7333f69a68cc1b9999`);
the accepted DUR-003 six-file fingerprint remains
`b243209f0299f450f432fe93556bade953d5c0875c9a27af930f7d752df88f43`. Provider and
tool reservations are durable before dispatch and survive retries, crashes and
fresh-process resume; an interrupted provider retains its full reservation as
unknown usage, and only an explicit upward amendment under the frozen caps moves a
goal out of `budget-exhausted`. Context is rebuilt from trusted criteria,
re-verified facts and receipt summaries with no tool-role transcript. Pause,
cancellation and generation fencing refuse late callbacks; every provider and tool
dispatch is bounded by a hard deadline that aborts, fences late results and safe-stops
as `needs-attention`; three equivalent failures with unchanged evidence stop with a
continuation requirement. Completion is evaluated only from current artifact bytes,
fresh test evidence and explicit human decisions; model completion text is never
evidence. Test evidence is bound to a fingerprint captured at dispatch over declared
artifact and edited paths, so a change during execution (content, mode, creation,
deletion) or after the test process exits cannot produce a pass, and evaluator
snapshots must bind to the dispatched plan and bytes. Unresolved DUR-003 transaction
artifacts still block effects and preserve the operator-recovery requirement.

A deadline, pause, cancellation, adapter abort or unusable test observation now
persists a receipt-backed `execution: {teardown: "unverified", attemptId, generation}`
marker before the stop releases the lease, and a dispatched test/command with no
receipt is itself a durable block. Every resume entry point consults that block and
returns `safe-stop`/`teardown-unverified` without creating a generation, dispatching a
provider request or starting a tool. Only a block-bound attestation from the trusted
`executionOwnership.verifyTeardown` boundary can release it; elapsed time, PID
disappearance, a settled adapter promise or a bare caller assertion cannot. Provider
failures remain retryable because a remote request is uncertain usage, not surviving
local execution. Kill/reclaim and lease reclamation stay in DUR-005; until that
boundary exists, a goal whose test teardown is unverified safe-stops persistently.

The final candidate additionally scopes that durable block to the canonical workspace:
unresolved surviving execution of any goal bound to the same workspace identity now
refuses a fresh goal before authority, generation, dispatch, edit or completion, so a
new goal id, retry, restart, cancellation or elapsed time cannot bypass the block held
by the original execution records. The small additive store read
`createGoalStore.listWorkspaceGoals` supplies the sibling-goal discovery under the
caller-held workspace write lock. Discovery matches the same path or the same
device/inode pair, so renamed directories and replacement paths remain protected.

Verification: full `npm run check` passes 961/961 with zero failures and skips on
Node 24.21.0 and 22.23.1 after the identity repair. The affected store/executor
suite passes 72 tests on Node 24. The renamed-workspace reproduction passes on
both runtimes with the original child alive and zero new requests. Offline
evaluation passes 16/16 contracts, smoke passes 32 frames, and packaging passes
its 98-file dry run. See the submission for fingerprints and logs. Remaining limitations: live engine/controller
wiring, cross-process lease reclamation, durable approvals and human-decision
persistence belong to DUR-005/DUR-006; DUR-004 can detect but not tear down an owned
process, so the durable block is only released through the DUR-005 process-ownership
attestation and its marker is immutable until DUR-005 adds a durable reconciliation
record; physical power loss, non-Linux platforms and live providers remain NOT
EVALUATED. The new modules are not yet in the shared `jsconfig.json`/coverage
ratchet; ad hoc `tsc --checkJs` passes and the full-suite report measures
91.79/85.71/93.33 (budget), 95.38/79.83/100.00 (context), 88.28/77.03/92.31 (executor),
97.80/80.00/100.00 (lock) and 99.76/98.13/100.00 (store) line/branch/function
percentages; overall 93.87/84.30/95.10 (Node 24) and 93.89/84.14/95.10 (Node 22).

**Current provider candidate: tracing finding closed within the reviewed scope.** The
[independent Yama review](reports/2026-11-04-prv106-yama-tracing-verification.md) matches
the runtime fingerprint below. It reproduced scope 0 refusal and scope 2 enforcement
on Node 22 and 24 for the documented CLI and API. The finding is closed for
unprivileged same-user tracing under the stated host requirements.

The loopback workflow fixture passed on Node 24.21.0 and Node 22.23.1. Each run observed
default edit denial, separate headless test denial, terminal edit and test approval,
four real passing tests, exact byte undo, and six requests to the expected endpoint with
the exact model ID. The fake credential was absent from the inspected artifacts.

The owner reported 4/4 focused tests passing for PV-04, PV-14 and PV-16.
The tests cover concurrent routing of one model ID through two separate endpoints and
keys, selection invalidation after an endpoint change, restoration of the saved model,
and CLI refusal and explicit reselection for a changed provider binding.

The provider-removal demonstration passed on Node 24.21.0 and 22.23.1. Two profiles
were added through the CLI with the same exact model ID and distinct loopback endpoints
and fake keys. After the saved profile was removed, CLI resume exited 1, made zero
requests to either endpoint, and preserved the saved binding. Explicitly selecting the
replacement profile and exact model repaired the binding. A subsequent task sent one
request to the replacement endpoint with its key and exact model, and zero to the old
endpoint. The harness is in this chat's `work/provider-acceptance/provider-removal.mjs`.
This covers the removed-profile workflow for PV-16 and adds routing evidence for PV-04.

On the same working tree based on `ff55a2c`, both runtimes passed `npm run check`
(758 tests, no failures or skips), `npm run eval` (16 contracts), `npm run smoke`
(32 frames), `npm run pack:check` (90 files), and `git diff --check` passed.
The tested tree's 258-file SHA-256 manifest digest is
`1772555f02976a67ce22dc50625f41e9ce41c4fcf15929158807b23a0c76799b`.
Logs and manifest are in this chat's `work/provider-acceptance/` directory.
The consolidated verdict and advisory dispositions are recorded above.

**2026-11-04 real Yama scope 2 verification passed.** A disposable QEMU/KVM guest with
Linux `7.0.12+kali-amd64` ran the actual provider evaluation CLI against a loopback fixture
as UID 1000 with zero effective capabilities. On Node 24.21.0 and Node 22.23.1 (the latter
installed under `/opt`), the correct edit passed and the incorrect edit passed workspace
verification but failed both scoring checks and exited 1. In all four runs, an unprivileged
same-user probe received `EPERM` for both `PTRACE_ATTACH` and `process_vm_readv` against the
evaluator and each scoring child. A scope 0 control attached successfully to a sacrificial
process, and the guest powered down after all assertions passed. The host remained at scope 0.
The guest contained byte-identical copies of the 98 tracked runtime files under `eval/`,
`lib/`, `src/`, and `package.json` from `ff55a2c` plus the current runtime edits. Their
SHA-256 over sorted records (`path`, NUL, raw 32-byte file digest) is
`2743c680fd6ad6549d9dfb2ae550585de756a0106cf6aebd1df01b24d9a2869c`.
Harness and serial log are retained in this chat's `work/yama-vm/` directory. This is
implementer verification. The independent tracing verdict is recorded above.

**2026-11-04 scoring tracing mitigation submitted.** The provider evaluation CLI and API
require an untraced evaluator and Linux Yama `kernel.yama.ptrace_scope=2` or `3` before
starting a run and before returning a report. Scope 1 still permits ancestor tracing.
On this host at scope 0 the real CLI exited with an error, made zero provider requests,
and wrote no report. Integration tests use simulated policy reads for the protected path
while running the real workspace sandbox and scoring code. The mitigation assumes a trusted administrator,
runtime and checkout. It changes no host settings and does not accept the provider phase.

**2026-11-04 provider evaluator follow-up: PARTIAL, scoring security still open.**
The fixed evaluation fixture now runs its `node --test` command using the evaluator's
Node executable directly instead of relying on an externally installed npm inside the
sandbox. The focused provider-evaluation/process suite passed 43/43 with the official
Node 22.23.1 tarball and its npm first on PATH. This is a submitted portability repair,
not acceptance of the provider phase. A separate host-side ptrace probe on this Linux
host (`ptrace_scope=0`) successfully attached to an authoritative Node scoring process
even when that process was experimentally placed in a Bubblewrap user/PID namespace.
That experiment was not kept as a security fix: Bubblewrap alone did not prevent this
same-UID attack. The scoring-forgery finding remains open and independent review is
required for any further repair.

**2026-11-04 durable phase started at the owner's direction.** DUR-001 lock and
contract investigation was started in `/home/mitravanu/matrix` on base `ff55a2c` and
is now submitted for review.
The first cross-process lock spike and its limits are recorded in
[DUR-001](decisions/DUR-001.md). PRV-107 is not accepted; the independent
[provider evaluation review](reports/2026-11-04-prv106-independent-review.md)
records the same-UID scoring forgery residual and missing Node 22 evidence. Starting
durability work does not resolve or waive those findings. No DUR-001 interface or
lock design is accepted, and dependent implementation remains gated on that review.

**2026-11-03 PRV-106 Mode B independent audit: no findings within the tested
scope.** Executed by a fresh-context auditor per [PRV106_AUDIT.md](PRV106_AUDIT.md)
with the chief-dispatched Mode B: the repaired in-flight candidate was
snapshot-captured and audited under that fingerprint only, and the snapshot later
proved 8/8 byte-identical to the committed candidate `ff55a2c`, so the audit binds
exactly to this commit. Four P3 advisories carry repair directions (decorative
`checks.target` excluded from `taskSuccess`; behavioral gate reuses the
authoritative fixture vectors, so an overfit proposal passes both gates;
`checks.edit` conflates byte binding with the `authoritativeOk` scores; the
invoker binding name is discoverable in agent context); three attack forms remain
explicitly unverified. Documented boundary retained: with `ptrace_scope=0`, a
same-uid process still discloses receipt tokens from the host-spawned
result-phase scoring children (`eval/provider-eval.mjs:600-604`) and forges
passing TAP plus a substituted `exit_group(0)`, while the sandboxed agent-side
gate keeps `taskSuccess`/`report.ok` false for wrong bytes; the report records a
repair direction (route result-phase spawns through the same bubblewrap snapshot
runner) rather than a finding. Controls discriminated; Mode B alternate
counterexamples were self-designed and demonstrated; snapshot regression 43/43 on
Node v24.21.0 (Node 22 absent on this host, a named gap, so evidence is
single-version). Harness cleanup verified, with one disclosed read-only deviation
errata (a single unprovenance pid leak scan, no writes, no side effects). This
audit closes only the P2 "independent adversarial evidence" cell for the evaluator
scoring boundary; it decides no PRV-105 or PRV-106 acceptance; the ptrace residual
and the P3 dispositions are chief decision points. See
[the PRV-106 audit](reports/2026-11-02-prv106-audit.md).

**2026-11-02 workspace-test isolation submitted.** Provider evaluation probes the
Linux Bubblewrap backend before contacting the provider and runs agent workspace
tests against a disposable snapshot in separate user, PID and network namespaces.
The normal test-plan trust and execution audit remain in use. A workspace-source
regression verifies that the evaluator's host PID is invisible and a write to the
sandbox's `/tmp` does not reach host `/tmp`. A failed sandbox probe refuses the run.
Hostile processes already running as the same host user remain outside this boundary
and can still interfere with scoring. This is an implementer submission, not independent
PRV-106 acceptance; adversarial review and exact-candidate gates remain required.

**2026-11-02 source-binding repair submitted.** Provider evaluation now compares
the final source with the last approved, applied proposal before granting the edit
check. An end-to-end regression replaces the file with a different valid solution
after approval: both scoring gates pass, but task success fails. This does not fix
the separately demonstrated same-UID ptrace receipt forgery. Independent review
and an effective process isolation boundary remain required; PRV-105 is not accepted.

**2026-11-02 independent re-review: CHANGES REQUIRED (P1)** on the reviewed
v4 candidate `f54ce83`. Without a VM escape, submitted source could patch
`node:assert/strict` in the authoritative run, and the behavioral gate serialized
a candidate-controlled array with `JSON.stringify`, so `Array.prototype.toJSON`
could substitute the input. A deliberately wrong `keepLast` returning `[]`
produced `taskSuccess: true` with every check passing. The null-prototype context
closed the prior host-constructor reproduction, but assertion and serialization
authority still belonged to submitted code. See
[the re-review](reports/2026-11-02-eval-scoring-re-review.md). The independent
provider cache A → B → A check now fails closed and records only after a fresh
probe. PRV-105 remains SUBMITTED; the provider phase is not accepted.

**2026-11-02 scoring repair submitted.** Both independent verification runs now
import a host-controlled shim: submitted source is evaluated in a null-prototype
VM context with no Node APIs, imports or runtime code generation, and only
bounded primitive results are marshaled back to host assertions. The original
assert-patch/`toJSON` reproduction now reports `authoritative false`,
`behavioral false`, `taskSuccess false`, and `ok false`. This is an implementer
submission, not acceptance; independent re-review is required. See
[the repair](reports/2026-11-02-eval-scoring-repair.md).

**2026-11-02 candidate-binding finding and repair.** A follow-up review found that
the first host shim still stored the candidate in a mutable VM global
(`context.candidate = candidate`). A submitted module could install a `candidate`
accessor on `globalThis`, absorb the host assignment and return a fake identity
function, making a wrong `keepLast` pass both gates and the ordinary evaluation path.
The shim now captures the candidate in a VM closure and installs the per-call invoker
under a random non-configurable name. The end-to-end reproduction reports
`authoritative false`, `behavioral false`, `taskSuccess false` and `ok false`.
Independent re-review is required. See
[the candidate-binding repair](reports/2026-11-02-eval-candidate-binding-repair.md).

**2026-11-02 authoritative fixture-tamper finding and repair.** Adversarial review of
the binding repair found that the agent's own unsandboxed test child could pre-create
the authoritative `src/bounds.js` path as a FIFO and spawn a detached watcher. The
watcher replaced the host shim with one that read the completion token and returned the
input, so a wrong `keepLast` returning `[]` passed every check. The authoritative test
is now generated in the evaluator and delivered on stdin; there is no writable
authoritative fixture, shim, submitted file, or predictable fixture directory. The
source and token are absent from argv and audits, and a regression pre-creates the old
FIFO path and still fails a wrong source closed. The original FIFO end-to-end attack now
reports `authoritative false`, `behavioral false`, `taskSuccess false` and `ok false`.
`npm run check` passes 753 tests with no failures or skips and all critical coverage
floors met on both Node 24.21.0 and Node 22.23.4. An intermediate Node 22 run hit the known
unrelated 10 ms `provider-catalog` timing flake; that file passed 16/16 alone and the
full rerun passed. Independent re-review is required. See the same
[binding and fixture-tamper repair](reports/2026-11-02-eval-candidate-binding-repair.md).

**2026-11-02 committed-candidate partial review (initial checks).** The scoring repair is now
committed as `094642a` on top of `4708709`. A partial review of that clean candidate checked the
core scoring claim against the real verification subprocess: a valid spread-copy source passed
both scoring modes, while a wrong source returning an empty array through a proxy and a wrong
source that first replaced `JSON.stringify`, `Array.isArray` and `Number.isSafeInteger` both
failed both modes. The focused provider-eval/process suite passed 40/40. No live provider or
credentials were used. This is initial evidence only, not an acceptance decision: independent
end-to-end counterexamples (binding, stdin and receipt boundaries, the detached-process risk),
the provider acceptance matrix and exact-candidate release gates remain open. See
[the initial-checks review](reports/2026-11-02-eval-review-start.md).

**2026-11-02 implementer-side end-to-end counterexample sweep.** Executed in the same
session as the repair, so it is not audit-independent and does not open PRV-106. A full
provider loop with a wrong `keepLast` plus combined in-VM attacks (candidate accessor,
`toJSON` substitution, intrinsic hot-patch, `Object.freeze`) and a detached watcher
failed closed end to end (`taskSuccess false`, `ok false`, both gates failing); the
watcher's fixture decoys/FIFO were ignored, its `/proc` child discovery lost the audit
`home` race, and its `/proc` fd re-open injection and stdin theft attempts were refused
by the kernel with `ENXIO`. Per-mechanism isolation runs all failed with
`passed 0 / failed 1`; a same-uid watcher cannot be shipped inside `src/bounds.js`
without self-failing via import-link rejection; the positive control under the live
watcher passed with `taskSuccess true`. Focused suite 40/40; scoring-boundary
fingerprint unchanged (`4762ce89…`). ptrace-based token disclosure remains a documented
unattempted residual. See
[the end-to-end sweep](reports/2026-11-02-eval-scoring-e2e-review.md).

**2026-11-02 assigned review: file binding, receipt forgery and detached-process
interference.** Same-session assigned review, not the independent PRV-106 audit.
Verdict **CHANGES REQUIRED** with two live-verified integrity findings against the
committed candidate. (1) P1 file binding: score-time re-read of
`eval/provider-eval.mjs:538` is not compared to the approved proposal bytes (`checks.edit`
at line 593 never compares bytes); a same-uid detached side-writer that overwrote the
applied wrong `keepLast` with the correct body after the edit produced a full
`taskSuccess true` / `ok true` (proposal identity, on-disk capture and swap timestamp
retained in the review loot), and the in-source bait variant additionally proved the
submitted bytes can spawn persistent workspace children while the scoring VM stays
inert. (2) P1 ptrace receipt forgery: with `ptrace_scope = 0`, same-uid attach
disclosed the exact receipt token from both live scoring children of a negative-mode
run, injected forged passing TAP carrying those tokens, and substituted
`exit_group(0)`; the committed scoring path then recorded `authoritative ok true` and
`behavioral ok true` for the wrong proposal. Workspace-agent verification gate was NOT
uplifted by ptrace alone (explicit unachieved record). Controls discriminated
(positive `taskSuccess true`; negative `failed 1`); focused suite 40/40 twice;
fingerprint unchanged (`4762ce89…`); no repo code or credentials touched; all review
processes were harness-owned and cleaned up. See
[the integrity review](reports/2026-11-02-eval-scoring-integrity-review.md).

The latest v4 evaluator repair passes the full engineering gate on Node 22 and
Node 24: 746 tests each, with no failures or skips. VM-constructor escapes,
forged output and incomplete assertion runs fail; equivalent valid solutions pass.
The default offline evaluation and package checks pass on both versions. See
[final repair evidence](reports/2026-11-02-eval-final-repair.md) for candidate
identity, regressions and limits. Independent phase acceptance remains open.

The early-exit scoring bypass repair chain reached task revision v4. The original
early-exit reproduction reports failed edit/verification checks and
`taskSuccess false`, and the v3/v4 gates added a separate pure-function behavioral
gate plus per-run completion receipts. The independent re-review above nevertheless
returned **CHANGES REQUIRED (P1)**: another mechanism in the same failure family
still controls the verdict. The 745-test Node 24 gate, Node 22's 15-test
provider-evaluation suite and the 16-case default offline baseline were implementer
evidence for that repair, not acceptance. Logs: `/tmp/matrix-exit-check.log`,
`/tmp/matrix-exit-tests22.log`, and `/tmp/matrix-exit-offline.log`.

The three evaluation-review findings have a repair submitted for independent
review: both test runs use an allowlisted environment, cancellation aborts the
controller, and behavioral verification accepts equivalent edits. The fixture
revision is now v2. Test execution is not a filesystem or network sandbox.
Node 24's full check passed 744 tests without failures or skips; the 14-test
provider evaluation suite also passed on Node 22. The default offline evaluation
passed all 16 baseline cases. These are implementer checks, not acceptance.

The evaluation review returned **CHANGES REQUIRED** on the earlier candidate:
the first verification exposed credentials with custom environment names,
evaluation cancellation was not connected to the controller, and exact source
matching rejected a correct alternative solution. All three were reproduced; see
[the review and reproduction](reports/2026-11-02-provider-eval-review.md).
This follow-up review does not establish PRV-106 independence or acceptance.

The latest candidate displays saved probe observations separately from declared
capabilities in the picker and provider details. Endpoint changes hide stale
observations. The Node 24 full gate passed 741 tests without failures or skips;
see [integration evidence](reports/2026-11-02-integration-evidence.md) for the
candidate identity, other checks and remaining independent acceptance work.

The direct-edit A → B → A cache case now fails closed using a tracked configuration
file stamp and per-profile generations. Before an explicit probe or refresh adopts
an externally edited configuration, it invalidates earlier observations under the
configuration lock. Tests cover a late old probe, corrupt stamp, cancellation and
fresh evidence after adoption. This implementation still needs independent audit
and platform/filesystem-specific failure testing; it is not acceptance evidence.

The provider picker now offers explicit local catalog reload and explicit saving
of a highlighted custom model. Reload refuses execution against a changed selected
profile until it is reselected; an active run retains its original target. A
provider-bound session with a changed configuration can be resumed after explicit
`--provider` and exact `--model` reselection. These changes are submitted for
independent review, not accepted; re-run the P1/P2 matrix on the final candidate.

The CLI now has a complete-profile `providers replace` operation requiring the
previously observed configuration digest. File parsing is bounded, profile
validation and atomic mutation use the existing store, and stale digests are
refused. Endpoint changes hide discovery and probe records with an older target
digest. A per-profile generation now invalidates observations across endpoint
reversion and remove/re-add, and publication takes the configuration lock and
checks the captured generation. Targeted fake-provider tests cover A → B → A,
in-flight old probe and discovery responses, and fresh observations afterward.
The Node 24 full check passed 729 tests with no failures or skips; the affected
provider suites passed 67 tests on Node 22. The repair and crash/failure behavior
still require independent review; neither the command nor this repair constitutes
phase acceptance.

The authoritative evaluation verifier starts with a minimal sanitized child
environment and a disposable home. It now uses the shared process runner with
owned process-group cleanup and lifecycle regressions. Independent review of
the repair and the shared trusted test-execution/audit integration remains
outstanding; this change is not phase acceptance.

The interactive unsupported-tools refusal identified in the picker recheck is now
implemented at the UI and controller boundaries, with UI and controller regression
tests. The opt-in `providers test` probe is also implemented: synthetic fixtures only,
three requests / 256 completion tokens / 30 seconds per invocation, and bounded records
keyed to the provider/model/configuration digest. Its independent reviews returned four
findings; all are repaired at cause and the reviewer must reproduce them again. These
deliveries do not constitute acceptance of PRV-104 or the provider phase.

Updated 2026-11-02. Baseline `e1b3c66` plus the PRV-101–105 candidate in the working tree.
**Dynamic custom providers are first.** An independent review of the 617-test candidate
returned **CHANGES REQUIRED** (R1–R5) — see [the report](reports/2026-11-01-provider-review.md).
A second independent pass over the 634-test repair then returned **CHANGES REQUIRED**
again (RR1–RR3) — see [the re-review](reports/2026-11-01-provider-re-review.md) — and a
third pass on the 640-test repair found two discovery contract gaps (D1–D2) — see
[the third review](reports/2026-11-01-provider-review-3.md) — and a fourth check found one
remaining D2 path, the timeout that skipped persisted failure status — see
[check 4](reports/2026-11-01-provider-check-4.md). Check 5 then confirmed the timeout
repair with no new findings. Every reproduced finding is repaired with a regression case.
The provider management CLI (`providers list/add/show/update/remove/models`) now exists;
an independent [CLI review](reports/2026-11-01-provider-cli-review.md) found one projection
mismatch (a cached read hid the failed refresh), and a second
[show/update review](reports/2026-11-01-provider-cli-show-update-review.md) found one
default-model erasure. Both are repaired with regressions. The interactive model picker now lists named-provider
models with per-provider availability and the exact target, sessions bind
provider/model/configuration identity with repair-or-refuse resume, and a TTY `--provider`
preset plus direct exact-ID entry use the same resolved target. A separate picker/resume review
reproduced three defects (a remote wire ID named `local`, lost built-in resume identity, and
uncatalogued manual resume); all three are repaired with regressions. The PRV-105 opt-in
provider evaluation is now delivered and SUBMITTED (see its section below). Its independent
recheck then reproduced a package.json test-script substitution; the evaluator now denies every
non-source edit, protects the fixture/package bytes and scores against an independent run of the
original fixture (see the package/test-runner repair below). The phase is **not complete and not
accepted**: independent re-review of that repair and the release decision remain open. The
durable-phase adversarial audit (QA-101) was accepted on 2026-11-09.

States: READY → CLAIMED → IMPLEMENTING → SUBMITTED → ACCEPTED.
Use CHANGES REQUIRED after review, BLOCKED for an unresolved prerequisite and DEFERRED
for later phases. Only the chief records ACCEPTED against exact candidate evidence.

## Active provider phase

| Task                                                                            | Status                                                                                                                                                                                                                                                                                                                                                                                                                             | Owner / checkout                                         | Prerequisite / next action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Evidence / verdict                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PRV-101                                                                         | SUBMITTED                                                                                                                                                                                                                                                                                                                                                                                                                          | Chief/contracts implementer, `/home/mitravanu/matrix`    | R2/R4/RR1/RR3 repaired 2026-11-01; independent re-review required                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 16 config tests; repaired-candidate gate below                                                                                                                                                                                                                                        |
| PRV-102                                                                         | SUBMITTED                                                                                                                                                                                                                                                                                                                                                                                                                          | Chief/transport implementer, owner-directed exception    | R3/R5 repaired 2026-11-01; PRV-101 still not independently accepted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 14 transport + 20 legacy tests; repaired-candidate gate below                                                                                                                                                                                                                         |
| PRV-103                                                                         | SUBMITTED                                                                                                                                                                                                                                                                                                                                                                                                                          | Chief/catalog implementer, owner-directed exception      | R3/RR3/D1/D2 and check-4 timeout repaired 2026-11-01                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 16 catalog tests; repaired-candidate gate below                                                                                                                                                                                                                                       |
| PRV-104                                                                         | PARTIAL                                                                                                                                                                                                                                                                                                                                                                                                                            | Chief/integration implementer                            | Picker, exact target, session binding, explicit built-in routing, TTY `--provider` preset, exact-ID entry and `providers test` delivered 2026-11-01; picker/resume and probe review defects repaired; probe hostile-stream cases added                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Picker/app/session/probe/CLI regressions; 719-test gate; re-review required                                                                                                                                                                                                           |
| PRV-105                                                                         | SUBMITTED                                                                                                                                                                                                                                                                                                                                                                                                                          | Compatibility/eval implementer, `/home/mitravanu/matrix` | Opt-in evaluation delivered 2026-11-02; package/test-runner integrity & VM constructor escape repaired; re-review found CHANGES REQUIRED (P1) on assertion/serialization authority; host-shim repair submitted, then a follow-up candidate-binding bypass was repaired; adversarial review then found and repaired a FIFO fixture-tamper bypass; repair committed as `094642a`; an initial partial review on that clean candidate passed but is not acceptance; an implementer-side e2e counterexample sweep held the boundary but is not audit-independent; a same-session assigned integrity review then returned CHANGES REQUIRED on file binding and same-uid ptrace receipt forgery (score gates lifted, workspace gate not); at |
| `ff55a2c` the PRV-106 Mode B audit returned no findings within tested scope (4x |
| P3 advisories, ptrace result-phase residual documented, fingerprint-bound);     |
| chief acceptance outstanding; PRV-102/103/104 still SUBMITTED/PARTIAL           | 22 provider-eval tests; package-script denial, VM escape, assert-patch, `toJSON`, candidate-binding, fixture-tamper and audit-leak regressions; [binding and fixture-tamper repair](reports/2026-11-02-eval-candidate-binding-repair.md); [e2e sweep](reports/2026-11-02-eval-scoring-e2e-review.md); [integrity review](reports/2026-11-02-eval-scoring-integrity-review.md); [PRV-106 audit](reports/2026-11-02-prv106-audit.md) |
| PRV-106                                                                         | SUBMITTED                                                                                                                                                                                                                                                                                                                                                                                                                          | Independent fresh-context audit agent                    | Chief dispositions the 4x P3 advisories and the documented ptrace result-phase residual; Node-22 regression half remains a named single-host gap; full engineering gates stay chief-level (756/756 recorded in the `ff55a2c` commit message); PRV-107 next                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Mode B audit bound to `ff55a2c` by an 8/8 fingerprint match: [report](reports/2026-11-02-prv106-audit.md); verdict no findings within tested scope; loopback-only e2e cells and isolation families with discriminating controls; loot/kits retained under `/tmp/opencode/prv106-kit/` |
| PRV-107                                                                         | ACCEPTED                                                                                                                                                                                                                                                                                                                                                                                                                           | Chief integration                                        | Provider matrix complete. Evaluator advisories tracked above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | [Consolidated acceptance report](reports/2026-11-04-prv107-provider-acceptance.md), 24/24 cases and Node 22/24 gates                                                                                                                                                                  |

## Durable phase

| Task             | Status          | Owner                | Release condition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | --------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DUR-001          | ACCEPTED        | Chief integration    | Independent re-review matched the five-file candidate fingerprint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| EVAL-101         | DEFERRED        | Unassigned           | PRV-107 accepted; capability protocol uses new provider identity                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| DUR-002          | ACCEPTED        | Chief integration    | Independent review and Node 22/24 checks passed on `70e88900fe77`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| DUR-003          | ACCEPTED        | Recovery implementer | Independent review accepted b243209f0299 on base ff55a2c                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| DUR-004          | ACCEPTED        | Executor implementer | Independent review of `bc78ec7f`; DUR-005 owns attestation/reclaim and controller integration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| DUR-005          | ACCEPTED        | Chief integration    | C1 test repair accepted at `10d99cb02543`; 1,033/1,033 on Node 22/24. [Closure](reports/2026-11-09-int101-integration.md#12-chief-closure-2026-11-10)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| DUR-006          | ACCEPTED        | CLI/UI implementer   | Independent ACCEPT of `da9d9d752d0c` (Finding R1); 1,032/1,032 evidence reused; [report](reports/2026-11-08-dur006-r1-re-review.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| QA-101           | ACCEPTED        | Independent QA role  | Adversarial matrix 18 PASS / 2 PARTIAL (57 PASS / 2 NOT EVALUATED); [review](reports/2026-11-09-qa101-acceptance-review.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| INT-101          | ACCEPTED        | Chief role           | C1–C4 closed on integrated `dfa62616fa86`. Local gates passed; hosted CI passed on Node 22/24 in [run 42867616263](https://github.com/imitravanu/Matrix/actions/runs/42867616263) for `matrix/int101-hosted-ci` at `46ed6ea`. [Disposition](reports/2026-11-09-int101-integration.md#12-chief-closure-2026-11-10) · [Hosted CI](reports/2026-11-09-int101-integration.md#13-hosted-ci-verification-2026-11-10)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| REL-001          | BLOCKED         | Release reviewer     | Release-readiness review of candidate `b7966a0` on 2026-11-11. Every verification, safety and packaging gate passes; hosted [run 42871859453](https://github.com/imitravanu/Matrix/actions/runs/42871859453) covers that commit exactly. A documentation patch closed the release-readiness findings, and the DUR-001 contract repair is **ACCEPTED on 2026-11-12** against the integrated 45-file candidate `f46b90b4…` after the focused repair review closed every finding. Still blocked on a hosted matrix run for the exact committed candidate — run 42871859453 predates the repair and does not cover it. No tag, publication or deployment. [Record](../../RELEASE.md#release-readiness-record--rel-001-candidate-b7966a0-reviewed-2026-11-11) · [Review](reports/2026-11-09-int101-integration.md#14-release-readiness-review-2026-11-11)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| DUR-001 contract | REPAIR ACCEPTED | Security reviewer    | The 2026-11-11 repair brings the goal test path into the recorded disposable-snapshot contract: a disposable snapshot, no network, a cleared environment and a restricted root, with the PID-namespace ownership, the pidfd teardown proof and the crash-recovery path unchanged. The focused independent review of that repair returned **CHANGES REQUIRED** (an incomplete source identity, a vacuous success-receipt check and an incomplete candidate manifest); all three were repaired. The 2026-11-12 re-review reproduced two further source-identity blockers (unnormalized root-relative paths hid data-file content, and installed dependency bytes were untracked) and both are now repaired with explicit refusal for unreadable, unsupported or over-budget coverage. A third wave repaired the coverage boundary itself (permission bits, entry types and sibling inputs outside a subdirectory plan). **ACCEPTED on 2026-11-12** against the integrated 45-file candidate `f46b90b4…`, the DUR-005 29-file `e239d002…` and the DUR-006 14-file `fe95bc4c…`: the focused repair review closed every finding, with 38/38 submitted regression tests and 3/3 independent probes passing on Node 24.21.0 with real Bubblewrap, and the candidate-record correction closed and recomputed. Contract text unchanged. REL-001 stays blocked only on the exact-candidate hosted CI run. [Addendum](decisions/DUR-001.md#2026-11-12-acceptance-addendum-accepted) · [Submission](submissions/DUR-005.md#status-and-remaining-blockers) |

Preserved durable contracts/tasks are in [DURABLE_PHASE.md](DURABLE_PHASE.md),
[ARCHITECTURE.md](ARCHITECTURE.md) and [AGENT_TASKS.md](AGENT_TASKS.md). Their internal
READY labels indicate later-phase readiness only; this board governs current dispatch.

## File reservations

PRV-101 reserved and delivered these paths at base `e1b3c66`, candidate in the working tree:
`lib/provider-contracts.mjs`, `lib/provider-config.mjs`, `test/provider-contracts.test.mjs`,
`test/provider-config.test.mjs`, `docs/next-phase/decisions/PRV-101.md`, plus the ratchet/config
edits to `scripts/check-coverage.mjs` and `jsconfig.json`. No caller, CLI, UI, session or
transport file was modified. The reservation stays open until independent review; PRV-103
may read these exports but must not edit them without a handoff.

PRV-102 then touched, under an explicit owner-directed gate exception recorded in the audit
log: `lib/provider-transport.mjs` (new), `lib/openrouter.mjs` (streaming core extraction and
legacy adapter only), `test/provider-transport.test.mjs` (new), the `MATRIX.md` runtime row,
and the `provider-transport` coverage floor. It did not touch `lib/credentials.mjs`,
`lib/model-agent.mjs`, `lib/controller.mjs`, the CLI or the UI. PRV-103 still owns
`lib/models.mjs` and must not edit these paths without a handoff.

## Open proof gates

1. PRV-101: validated schema, immutable target/digest, precedence and session migration contracts.
   **Delivered in the candidate; self-reviewed only.**
2. PRV-101: safe bounded configuration mutation and concurrent-writer/process-death proof.
   **Delivered: kernel-held abstract-socket lock (no reclaim), immediate crash release,
   SIGSTOP-paused-owner exclusion, directory fallback that never steals, two-writer test,
   atomic-write conflict test and pre-write byte-limit refusal. Independent reproduction is
   still required.**
3. PRV-102/104: endpoint/key isolation through the entire actual tool loop. **Open.**
4. PRV-106/107: independent matrix evidence and exact integrated-candidate checks. **Open.**

These are deliverables, not requests for the owner to make routine implementation choices.

## Independent review and R1–R5 repairs (2026-11-01)

The review reproduced five defects against the 617-test candidate. Each is repaired at
cause and now has a durable regression case; no assertion was weakened or suppressed.

| Finding                                      | Repair                                                                                                                                                                                                                              | Regression evidence                                                                                                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 P1 TTY task bypassed `--provider`         | `assertProviderTerminalSupport` refuses every TTY provider invocation before the legacy resolver; headless tasks are unchanged                                                                                                      | `cli.test` cases for arbitrary ID, legacy alias and omitted model, plus a real PTY run asserting exit 1 and no `unknown model`; headless CLI run reaches the exact endpoint/model |
| R2 P1 delayed reclaimer stole a fresh lock   | Exclusion is an abstract Unix socket held by the kernel on Linux: crash release is automatic and **no code path reclaims a lock**. The non-Linux directory fallback never removes a dead owner's lock, it reports the recovery path | live-holder contention, SIGSTOP-paused holder, crash-then-immediate reacquire, concurrent writers, directory-fallback no-steal, token checks                                      |
| R3 P1 encoded credentials leaked             | One redaction module expands each secret to literal/URI/JSON/base64 and base64url forms, matches short secrets as tokens, redacts before truncation, and withholds a detail when any 4-char fragment survives                       | redaction unit tests, loopback HTTP 400 bodies echoing every encoding, a boundary-straddling key, a short key, and discovery error bodies                                         |
| R4 P2 mutation could exceed the loader limit | The writer serializes once and rejects `CONFIG_TOO_LARGE` before opening a temp file, leaving prior bytes intact                                                                                                                    | repeated large-profile growth with byte-for-byte comparison after the refused add                                                                                                 |
| R5 P2 credential re-resolved per tool round  | `bindProviderCredential` resolves once per run; transport and command audit share it; a fresh run resolves again                                                                                                                    | two-round agent run mutating the environment after round one: both requests carry the original key, the next run uses the replacement                                             |

Interface change: provider-config mutators and lock functions are asynchronous. Kernel-held
acquisition is asynchronous by nature and the candidate has no production callers yet, so
this was treated as a correctness fix rather than compatibility debt.

Historical note: the R1 TTY refusal guard was superseded on 2026-11-01 by the deliberate
`--provider` TUI preset in the PRV-104 interaction completion below; headless behavior and
endpoint/model freezing are unchanged. The guard no longer exists in `lib/cli.mjs`.

Gate on the R1–R5 repair, before the re-review, Node 24.21.0: `npm run check` exit 0 —
**634 tests, 634 pass, 0 fail, 0 skipped**; 166 modules syntax-checked; coverage 93.98%
lines / 83.67% branches / 94.41% functions, every floor passing. `npm run pack:check`:
86 files packed (dry-run), no tarball.

### Re-review RR1–RR3 (2026-11-01)

The re-review confirmed R1–R5 for their reproduced cases and found three remaining
defects. Each is repaired at cause:

| Finding                                        | Repair                                                                                                                                                                                                                                               | Regression evidence                                                                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RR1 P1 path aliases bypass the kernel lock     | Lock names hash the configuration directory's `dev:ino`, not its lexical path, so real and symlinked homes share one lock. Identity is re-derived after binding and immediately before the rename; a changed directory aborts with `CONFIG_CONFLICT` | acquiring through a symlinked home blocks while the real home holds the lock, then two concurrent processes add through both spellings and both updates survive |
| RR2 P2 Content-Type truncated before redaction | The complete untrusted header is redacted and bounded with fragment withholding; provider error codes are now redacted with the message instead of being interpolated afterwards                                                                     | HTTP 200 with a 70-character header prefix followed by the key leaks no fragment; a provider `code` echoing the key is redacted                                 |
| RR3 P2 FIFO cache hangs catalog loading        | Cache reads open with `O_NONBLOCK \| O_NOFOLLOW` and validate the opened descriptor as a regular file, so a FIFO cannot block and a symlink is treated as absent                                                                                     | a FIFO cache in a child process finishes within the hard timeout and keeps configured models; a valid payload read through a symlink is rejected                |

Gate on the RR1–RR3 repaired candidate, Node 24.21.0: `npm run check` exit 0 —
**640 tests, 640 pass, 0 fail, 0 skipped**; 166 modules syntax-checked; every coverage
floor passing. `npm run pack:check`: 86 files, no tarball.

### Review 3 D1–D2 (2026-11-01)

The third review confirmed every earlier reproduction and found two discovery contract
failures. Both are repaired:

| Finding                                     | Repair                                                                                                                                                                                                                                                                         | Regression evidence                                                                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1 P2 discovery ignored caller cancellation | `refreshProviderModels` accepts a caller `signal`, composes it with the deadline, checks before fetch, after the body and before cache replacement, and cancels a stalled reader. Cancellation never records a provider failure                                                | already-aborted call issues zero requests; abort during body streaming and abort after the bytes arrive both preserve the prior snapshot and commit nothing                                            |
| D2 P2 catalog dropped discovery freshness   | Each profile now keeps a bounded, redacted `refresh.json` outcome beside its snapshot. `buildProviderCatalog` exposes `provider.discovery` (`outcome`, `stale`, `error`, `fetchedAt`) and per-entry `stale`/`fetchedAt`/`discoveryError`, separate from configuration validity | failed refresh followed by a rebuilt catalog reports `error`/`stale` with the retained snapshot; a later success clears it; a pre-status snapshot is treated as fresh; digest change still invalidates |

Gate on the D1–D2 repaired candidate, Node 24.21.0: `npm run check` exit 0 —
**645 tests, 645 pass, 0 fail, 0 skipped**; 166 modules syntax-checked; every coverage floor
passing. `pack:check`: 86 files, no tarball.

### Check 4 — timeout status path (2026-11-01)

Check 4 confirmed D1 and the HTTP-failure half of D2, and found one remaining D2 path: a
deadline that cancels a stalled reader makes `readBoundedBody` resolve with partial bytes,
and that branch returned a failure without persisting it, so a rebuilt catalog still said
fresh. The branch now routes through the persistent failure recorder; explicit user
cancellation remains separate and still records nothing.

Gate on the check-4 repaired candidate, Node 24.21.0: `npm run check` exit 0 —
**647 tests, 647 pass, 0 fail, 0 skipped**; 166 modules syntax-checked; coverage 93.94%
lines / 83.65% branches / 94.45% functions, every floor passing (`provider-config`
87.56/77.36/96.00 against 85/70/95, `provider-catalog` 100.00/84.78/100.00 against
100/75/100, `provider-discovery` 90.30/76.34/91.67 against 85/68/85). `pack:check`: 86
files, no tarball. Node 22 and hosted CI were not run.

These repairs did not by themselves close the delivery gaps. The management half of the
CLI gap is now closed (below), as are the TUI picker/manual entry, session binding,
built-in explicit selection, the bounded `providers test` probe and the opt-in provider
evaluation (below); independent review of the evaluation, the full adversarial matrix and the
release decision are still missing.
PRV-101–104 remain SUBMITTED/PARTIAL; a repair or a self-tested delivery is not an
acceptance.

### Provider management CLI (2026-11-01)

The headless management path no longer requires editing `~/.matrix/providers.json`:

- `providers list` projects the catalog without a network call, showing named profiles,
  model counts, credential state (anonymous profiles report `no key required`, never a
  phantom key) and discovery freshness/staleness from the persisted status. An invalid
  configuration is printed as a diagnostic and exits 1; Local Forge and built-ins remain
  listed.
- `providers add` validates `--id`, `--base-url`, `--auth bearer|none`, `--name` and
  `--model`, then writes through the existing bounded, kernel-locked mutator. There is no
  flag that accepts a key value; only the environment-variable name is stored. Duplicate
  ids are refused rather than replaced.
- `providers show <id> [--json]` prints one profile: endpoint, transport, auth type and
  env-var name, default model, configured models with tool/capability and context state,
  discovered models, and the persisted refresh outcome. It never has access to the key value.
- `providers update <id> ...` changes only the fields named by flags (`--name`,
  `--base-url`, `--api-key-env`, `--auth`, `--model`, `--remove-model`,
  `--default-model`). It preserves unmentioned fields, including a valid default model
  that is not in the configured list (and accepts any syntactically valid exact ID for
  `--default-model`), refuses a duplicate model, and writes with the digest it read so a
  concurrent edit is refused instead of overwritten. The default is cleared only when
  this command removes the model it names; a replacement default in the same command
  wins. A changed endpoint/auth makes the old snapshot unreadable; a rename keeps it.
- `providers remove` deletes one exact id and refuses an unknown one.
- `providers models <id> [--refresh]` lists configured models plus cached discovered ones
  (configured always wins). `--refresh` is the only path that touches the network, uses
  that profile's endpoint and key, and a failed refresh is printed with the retained
  snapshot and exits 1 instead of looking fresh. A failure with no snapshot says so;
  it does not claim one was preserved.
- Untrusted provider text reaches the terminal only through redaction, ANSI stripping and
  single-line bounding, so a response body cannot paint escape sequences or forge extra
  output rows.
- A cached read (`models` without `--refresh`) now uses the same exported discovery
  summary as the catalog, so it warns when the last refresh failed instead of silently
  presenting the old snapshot as current. The formatter also renders an `error` outcome
  as stale, so a malformed or older summary cannot hide the failure either.
- `--json` is available on `list`, `show`, `update` and `models`; every subcommand
  refuses unrelated flags and positional arguments at parse time.

Gate after adding the CLI and its ratchet, Node 24.21.0: `npm run check` exit 0 —
**662 tests, 662 pass, 0 fail, 0 skipped**; 168 modules syntax-checked; coverage 94.05%
lines / 84.00% branches / 94.53% functions, every floor passing (`provider-catalog`
100.00/88.24/100.00 and `provider-commands` 100.00/95.19/97.44). `pack:check`: 87
files, no tarball.
The new tests cover parsing failures, the bounded store mutations, show/update round trips
with retained fields, an unlisted default surviving name/URL/auth edits, explicit default
removal and same-command replacement, a real loopback refresh with
configured/discovered filtering, cache invalidation on a target change but not on a
rename, a failed refresh that preserves the prior snapshot, a fresh CLI process reading
that failure from disk (text and JSON, no new request), anonymous profiles, hostile
multi-line/escaped provider text, and formatter output for built-in/fresh/stale/absent
states. This is
self-reviewed implementation evidence only; it does not satisfy P1, which still requires
the interactive workflow and a session that survives restart.

### Provider probe — `providers test` (2026-11-01)

- `providers test <id> --model <exact-id> [--checks text,tools] [--json]` is the only
  explicit probe path. It sends synthetic fixtures only, never repository contents, and
  no filesystem, shell or real Matrix tool is reachable from it.
- `text` requires a terminal completion event and records the observed content length.
  `tools` requires exactly one schema-valid `matrix_probe_noop` call with an id, then a
  clean follow-up: `finish_reason: "stop"`, non-empty text and no additional tool call.
  An ignored, malformed or mismatched call, a bare `[DONE]`, a `length` finish, a repeated
  tool request or an empty answer fails the check. Both checks send
  `max_tokens`/`max_completion_tokens` = 256 according to the profile request contract.
- Provider-controlled text in an error (an unexpected tool name or finish reason) is
  redacted with the bound credential in literal, URI, JSON and base64 forms before it is
  bounded; a surviving fragment withholds the detail instead of truncating a credential
  prefix. Errors reach the result, terminal output and stored bytes only after that step.
- The invocation cap is three requests (text one, tools two), retries are disabled, and a
  30-second deadline covers the whole invocation. Caller cancellation sends nothing
  further and writes no record; a provider or deadline failure is recorded honestly.
- Records are stored at `$MATRIX_HOME/provider-cache/<id>.probes.json` with mode 0600,
  one latest record per model, capped at 256 models with oldest eviction and a 512 KiB
  file bound. They carry the provider, exact model, configuration digest, timestamp,
  requested and actual checks, per-check pass/fail/not-evaluated, request count and usage
  when returned. Missing token fields stay absent, and `usageComplete` is true only when every
  request returned all three counts; a partial sum is labeled partial. No key or prompt
  bytes are stored. A changed endpoint, auth reference or request option makes matching
  records unreadable; display/catalog-only edits do not invalidate execution evidence.
- The store read is non-blocking and no-follow, so a FIFO cannot stall the command and a
  symlink cannot redirect a private read.
- Tests cover text/tool success with fragmented arguments, ignored and malformed tools,
  HTTP failure with zero retries, pre-aborted cancellation, the total deadline, digest
  invalidation, 256-model eviction, symlink refusal, a built-in OpenRouter target with an
  arbitrary exact model, pre-flight refusals, canary tool names in exact/URL/JSON forms,
  repeated/bare/truncated/empty follow-ups, partial usage, unfollowed redirects, abrupt
  disconnects, oversized SSE events, malformed tool-call IDs/arguments and malformed
  usage. A real CLI subprocess case covers the text/tool pass, JSON output and a failing
  endpoint.

Gate after adding the probe, Node 24.21.0: `npm run check` exit 0 — **703 tests, 703 pass,
0 fail, 0 skipped**; 174 modules syntax-checked; coverage 94.18% lines / 84.04% branches /
94.46% functions, every floor passing (`provider-probe` 92.65/78.47/100.00 against
90/75/95). `npm run pack:check`: 90 files packed (dry-run), no tarball. This is
initial implementation evidence; the independent review below then found one P1 and two
P2 defects, which are repaired with regressions. A probe pass is not a coding-quality,
context-length or full protocol claim.

### Provider probe review repairs (2026-11-01)

The independent [probe review](reports/2026-11-01-provider-probe-review.md) returned
**CHANGES REQUIRED** on the 703-test candidate with one P1 and two P2 findings. All three
are repaired at cause with regressions:

| Finding                                      | Repair                                                                                                                                                                                                                 | Regression evidence                                                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 unexpected tool name exposed credentials  | Error text from provider-controlled fields now goes through `redactedDetail` with the bound credential before bounding; literal, URI, JSON and base64 forms are removed, and a surviving fragment withholds the detail | exact, URL-encoded and JSON-escaped canaries are absent from result JSON, formatted output and persisted bytes                                                |
| P2 follow-up could pass without a round trip | The follow-up must complete with `finish_reason: "stop"`, contain text and carry no further tool call; a bare `[DONE]`, `length`, repeated calls and empty answers fail                                                | table-driven cases for repeat, bare, truncated and empty follow-ups, each exactly two requests                                                                |
| P2 missing usage became zero                 | Only observed token fields are aggregated; missing fields stay absent and `usageComplete` is true only when every request returned all three counts                                                                    | a `{completion_tokens: 2}` response stays partial (`prompt_tokens`/`total_tokens` absent) in the report, record and `providers test` output labeled `partial` |

Gate on the repaired candidate, Node 24.21.0: `npm run check` exit 0 — **706 tests, 706
pass, 0 fail, 0 skipped**; 174 modules syntax-checked; coverage 94.19% lines / 84.14%
branches / 94.59% functions, every floor passing (`provider-probe` 92.32/81.03/100.00
against 90/75/95). `npm run pack:check`: 90 files packed (dry-run), no tarball. The
reviewer must re-run the three reproductions; this repair is not an acceptance.

### Provider probe hostile-stream hardening (2026-11-01)

- A redirect is surfaced as an HTTP failure and never followed; the second origin
  receives zero requests, so the frozen credential cannot be forwarded.
- A mid-stream disconnect fails the check, records the failure and does not hang; a
  success is never invented from partial bytes.
- An SSE event above the shared 1 MiB parser bound is rejected before it becomes a probe
  observation.
- The synthetic tool-call id must be a string of at most 200 characters with no control
  characters, and the synthetic arguments must stay within 4 KiB before parsing. Violations
  fail before any follow-up request and are not echoed into the result or store.
- Usage counts are only accepted as non-negative safe integers. Strings, negatives,
  fractions and oversized numbers stay unknown; they never become zero, a floored value or
  a complete total.

Five new deterministic cases cover the redirect, disconnect, oversized event, invalid
id/oversized arguments and malformed usage. Gate, Node 24.21.0: `npm run check` exit 0 —
**711 tests, 711 pass, 0 fail, 0 skipped**; 174 modules syntax-checked; coverage 94.19%
lines / 84.20% branches / 94.53% functions, every floor passing (`provider-probe`
92.30/82.79/97.67 against 90/75/95). `npm run pack:check`: 90 files packed (dry-run), no
tarball. This remains self-tested until the independent re-review.

### Provider probe stream-bound repair (2026-11-02)

The independent [stream-bound review](reports/2026-11-02-probe-stream-bound-review.md)
reproduced one P2: `consume()` appended every tool-argument fragment and retained every
call/finish event until stream completion, so the 4 KiB argument bound was enforced only
after unbounded accumulation. The [repair report](reports/2026-11-02-probe-stream-bound-repair.md)
records the cause and evidence.

| Finding                                            | Repair                                                                                                                                                                                                                                       | Regression                                                                                                                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P2 argument bound enforced after stream completion | `consume()` tracks bytes per call as fragments arrive, breaks before appending the first fragment that would cross 4 KiB, and lets the stream generator's `finally` cancel the reader; only one call and the last finish reason are retained | 100 open-ended SSE events with 1,024-byte fragments: the probe fails with the bound error in under 2 s of a 4 s budget, sends one request and no follow-up, and the server observes cancellation |

Gate, Node 24.21.0: `npm run check` exit 0 — **719 tests, 719 pass, 0 fail, 0 skipped**;
176 modules syntax-checked; coverage 94.20% lines / 84.20% branches / 94.59% functions,
every floor passing (`provider-probe` 92.59/82.52/100.00 against 90/75/95). This remains
self-tested; the reviewer must re-run the fragmented-stream reproduction.

### Show/update review and default-model repair (2026-11-01)

A second independent [CLI review](reports/2026-11-01-provider-cli-show-update-review.md)
reproduced one P2 in `updateProvider`: a name-only update cleared a valid `defaultModel`
whenever it was absent from the configured model list, even though the provider contract
explicitly allows an exact unlisted default (model selection must not depend on a
catalog). The branch now clears the default only when `--remove-model` names that exact
default, and a `--default-model` replacement in the same command takes precedence.
Regressions cover name, endpoint and auth updates with an unlisted default (re-resolving
the default through `resolveProviderSelection` after each), setting an unlisted exact-ID
default through the command, explicit removal of a listed default, and same-command
removal plus replacement. A real CLI subprocess regression renames a profile that has an
unlisted default and checks the receipt and the stored state.

### Check 5, full engineering check and CLI review (2026-11-01)

- [Check 5](reports/2026-11-01-provider-check-5.md) reproduced the check-4 timeout case
  and confirmed the repair: the failure persists, the prior snapshot survives, a later
  success clears it, and caller cancellation still records nothing. 70 focused tests and
  a 647-test gate passed. No new finding.
- [Full engineering verification](reports/2026-11-01-full-engineering-check.md) passed the
  engineering gate, hostile-environment suite, 16-contract offline evaluation, 32-frame
  smoke and package dry-run on both Node 22.23.4 and 24.21.0. That candidate hash covers
  647 tests, not the current CLI work. It also found `npm audit` failing with five moderate
  development-chain advisories (minimatch/ESLint chain); `npm audit --omit=dev` is clean.
  Lockfile repair remains an open, separately reviewed task.
- The [CLI review](reports/2026-11-01-provider-cli-review.md) accepted the management
  commands as delivered and found one P2: `modelsReport` omitted the staleness flag and
  the text formatter keyed only on it, so `providers models <id>` after a failed refresh
  printed the cached models with no warning. Models, list and catalog now share one
  discovery summary, and the formatter also treats `outcome: "error"` as stale. Both
  text and JSON regressions run successful refresh → failed refresh → a new CLI process
  reading the cache, and assert the warning, the retained manual models and zero
  additional requests. Show/update/replace actions remain absent from the parser and are
  future management scope.
- This repair is self-tested; the independent reviewer has not re-run the new regression.

## Interactive provider picker and session binding (2026-11-01)

- `src/provider-picker.mjs` builds one picker list from the static registry plus configured
  and discovered profile models. Each entry carries a stable `provider:<id>:<model>` key,
  the profile display name, its resolved `providerTarget`, per-entry availability and
  discovery staleness. An invalid provider file degrades to the built-in list; nothing here
  reads a key value or performs network I/O.
- The Alt+M model screen renders the combined list, marks `[CUSTOM]`/`[DISC]`, shows
  per-provider "needs key" state, and keeps the exact target when selected. `/model <query>`
  matches the provider-scoped key, exact wire ID, display name, alias or provider name. A
  custom model without a usable target or credential is reported before the run starts
  instead of silently falling back to Local Forge.
- A run started from a picker selection passes the resolved `providerTarget` to the
  controller and model agent.
- Sessions persist `{id, modelId, digest}` with no key bytes. Resume refuses a missing
  profile, a changed endpoint/auth/request digest, a model no longer in the catalog,
  `--model`, and `--offline`, with an actionable message. Legacy model-only sessions keep
  their existing behavior. Provider identity accepts the full 512-character wire-ID limit.
- Tests: picker construction/lookup/custom-target regressions, two real app-interaction
  runs (selection and exact provider request), a provider-bound resume render, session
  round-trip/mismatch/limit cases, and a real TTY CLI run refusing a changed provider and
  `--offline`. This first picker candidate was self-tested, not independently reviewed.
- Follow-up delivery (same day): see the interaction-completion section below for the TTY
  preset, explicit built-ins and exact-ID entry. `providers test` was delivered later (see
  the probe section), as was the opt-in provider evaluation (2026-11-02, see its section);
  independent review, audit and the release decision remain open.

## PRV-104 interaction completion (2026-11-01)

- `--provider <id>` now presets the TUI instead of being refused. A named profile uses
  `--model` or its own `defaultModel`; the built-in ids `matrix`, `openrouter` and `ollama`
  route through `explicitBuiltinTarget`, which refuses a cross-provider model and requires
  an exact model for remote built-ins. The preset is projected by `pickerModelFromTarget`
  and installed as the initial selection, so the first frame is already on that exact
  target. This deliberately supersedes the earlier R1 refusal guard; the legacy model
  resolver still never runs for an explicit provider.
- Built-in explicit binding freezes the provider's own endpoint and credential policy:
  OpenRouter ignores `MATRIX_API_BASE`/`MATRIX_API_KEY` redirection, Ollama uses
  `OLLAMA_HOST` and its documented placeholder key, and a missing OpenRouter key fails
  before any network activity. Custom profiles keep the catalog/digest path.
- `e` in the model picker opens exact-ID entry for the selected provider. It accepts any
  valid wire ID, including one absent from the configured model list, and resolves the
  same custom target the headless CLI uses. Invalid IDs and missing keys stay visible in
  the picker instead of falling back to Local Forge.
- Tests: picker projection for presets/manual IDs, explicit built-in resolver precedence
  and refusal cases, built-in endpoint/key isolation, a preset render without the picker,
  a manual exact-ID app run that approves a proposed patch, verifies 4 passing tests and
  asserts both provider rounds carry the exact model, a real PTY launch of
  `matrix --provider lab` that renders the preset and exits without the old resolver, and
  headless `--provider local`/`--provider ollama` runs (the latter against loopback with
  `MATRIX_API_BASE` set to a decoy to prove the explicit endpoint wins). The headless local
  run also repaired a crash where a local resolved target was dereferenced as custom.
  Gate, Node 24.21.0: `npm run check` exit 0 — **682 tests, 682 pass, 0 fail, 0 skipped**;
  172 modules syntax-checked; coverage 94.19% lines / 84.11% branches / 94.43% functions,
  every floor passing. `npm run pack:check`: 89 files packed (dry-run), no tarball.
- `providers test <id> --model <exact-id> [--checks text,tools] [--json]` now runs the
  opt-in synthetic probe. `text` observes stream completion; `tools` requires a
  schema-valid no-op call and a completed response to its tool result. Retries are
  disabled, so the three-request cap is exact; a 30-second deadline covers the whole
  invocation. Records are bounded and private, keyed by provider/model/configuration
  digest, and caller cancellation writes nothing. A profile endpoint/auth/request change
  makes prior records unreadable rather than displaying stale badges. Unit cases cover
  pass/fail/not-evaluated, ignored and malformed tools, HTTP failure with zero retries,
  cancellation, the deadline, eviction at 256 models, symlink refusal and a built-in
  target; a real CLI subprocess case covers text+tool pass, JSON output and a failing
  endpoint.
- Not delivered at that point: PRV-105 evaluation selection (delivered 2026-11-02 below),
  PRV-106 adversarial audit and PRV-107 release decision. The probe review's P1/P2 findings
  are repaired above; an independent re-review of this repaired candidate is still required.

## PRV-104 picker/resume review repairs (2026-11-01)

An independent picker/resume review reproduced three defects on the 682-test candidate and
returned **CHANGES REQUIRED**. Each is repaired at cause; runtime files were otherwise left
as reviewed.

| Finding                                         | Repair                                                                                                                                                                                                         | Regression                                                                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remote wire model named `local` ran Local Forge | The controller routes an explicit non-local target to the model agent before the legacy `model.id === "local"` heuristic                                                                                       | Real controller run against a loopback profile serving `local`: one request to `/v1/chat/completions` with `model: "local"`, no Local Forge result |
| Built-in identities were discarded on resume    | `sessionProviderIdentity` persists explicit built-in provider/model with a fixed `builtinSessionDigest`; validation checks that digest and re-resolves the exact model without requiring profile configuration | Save/load/validate for arbitrary OpenRouter and raw Ollama IDs, plus UI resume rendering both without Local Forge                                  |
| Manual uncatalogued models could not resume     | Validation re-resolves the exact saved model against the unchanged profile instead of requiring catalog membership; the TUI rebuilds the picker selection from the saved provider target                       | Session validation with an empty catalog and UI resume of an unlisted manual model                                                                 |

A real PTY `--resume` test also restores an arbitrary OpenRouter ID from the saved sidecar.
Gate, Node 24.21.0: `npm run check` exit 0 — **688 tests, 688 pass, 0 fail, 0 skipped**;
172 modules syntax-checked; coverage 94.19% lines / 84.17% branches / 94.43% functions,
every floor passing. `npm run pack:check`: 89 files packed (dry-run), no tarball.
Self-tested only; the reviewer must re-run the three reproductions.

## PRV-105 opt-in provider evaluation (2026-11-02)

- `eval/provider-eval.mjs` is a separate explicit opt-in path, not a new profile in
  `eval/run.mjs`. It requires `--provider <id>` and `--model <exact-id>`, resolves the same
  validated target as normal execution, and runs one deterministic coding task through the
  real controller/model agent against that exact target. No repository contents are sent
  and shell/command tools stay disabled.
- The temporary workspace contains a buggy `src/bounds.js`, its test and `package.json`.
  Approvals are scoped to that disposable copy. Preflight rejects an unknown profile, a
  local/Local Forge selection and a missing credential before any request; a 60-second
  watchdog aborts. Task success requires the exact edited bytes, a passing verification
  through the separate test-approval path (auto-approved only inside the disposable copy),
  an `ok` outcome and confirmed workspace removal. Prose-only output remains a failed task
  even when the agent outcome is `success`.
- The report separates `target`, `edit`, `test`, `verification` and `cleanup` as
  pass/fail/not evaluated. The `test` check compares the final test-file bytes and rejects
  any applied edit to that file, including an edit later reverted; a weakened assertion
  cannot produce task success even when its verification passes. The report records
  provider/model/config identity and digest, endpoint, auth type and env-var name (never
  the value), task revision/digest, runtime, network class, outcome, verification,
  rounds/tool calls, finish reason, usage provenance and null unknown cost. Writes go to
  gitignored `eval/reports/provider.json`/`.txt`; the reviewed default baseline is never
  touched. `--json` prints the same report.
- The binding produced by the preflight is passed through the controller and model agent as
  `providerBinding`; execution uses that exact credential and endpoint instead of
  rebinding `process.env`. Callers that omit it keep the existing one-bind-per-run
  behavior.
- Tests: seven cases (six against a loopback fake provider) cover a full
  edit/approval/write/test run, a weakened-test rejection, explicit-credential execution,
  a prose-only non-success, an HTTP 503 reported honestly with cleanup, a real CLI
  subprocess that writes and redacts its report, and strict argument parsing. Canary and
  temporary absolute paths are asserted absent from serialized output.
- Gate, Node 24.21.0: `npm run check` exit 0 — **719 tests, 719 pass, 0 fail, 0 skipped**;
  `node --test test/provider-eval.test.mjs` 7/7 pass; 176 modules syntax-checked; coverage
  94.20% lines / 84.20% branches / 94.59% functions, every floor passing. `npm run eval`:
  16/16 contract pass, baseline PASS, 0 safety violations, cleanup complete. `npm run
pack:check`: 90 files packed (dry-run), no tarball.
- No live/paid provider was called. The evidence class is `opt-in-provider`; one run is not
  availability, quality, pricing, context-length or latency evidence. PRV-105 remains
  SUBMITTED, its dependencies remain unaccepted, and independent review is required. See
  the [initial report](reports/2026-11-02-provider-eval.md) and the
  [P1/P2 repair report](reports/2026-11-02-provider-eval-review-repairs.md).

## PRV-105 package/test-runner integrity repair (2026-11-02)

The independent [evaluation recheck](reports/2026-11-02-provider-eval-recheck.md) found the
previous repair incomplete: the evaluator approved every edit and trusted the workspace's
`npm test` command. A model could replace the `package.json` test script with a command that
printed a fake pass summary while leaving `test/bounds.test.mjs` untouched, and the report said
`taskSuccess: true` even though the original regression never ran.

- The approval gate now approves only the exact task source `src/bounds.js`. Every other
  proposal is denied with `n`, recorded in `deniedPaths`, and fails the new `scope` check. An
  unknown or escaping path is denied too.
- The `test` check still requires byte-identical test bytes and rejects an applied test edit. A
  new `package` check requires byte-identical `package.json` and rejects an applied package edit.
- `authoritativeVerification` independently runs `node --test test/bounds.test.mjs` in a fresh
  directory built from the original fixture test/package bytes and the final source bytes. It
  removes inherited `NODE_TEST_CONTEXT`/`NODE_OPTIONS`/`NODE_V8_COVERAGE` so a nested runner
  cannot silently skip files or write coverage, and it never uses the workspace's package script.
- `checks.verification` passes only when the run's own verification and the independent fixture
  verification both pass. `taskSuccess`/`ok` require `edit`, `test`, `package`, `scope`,
  `verification` and `cleanup`.
- The report adds `authoritativeVerification`, `package`, `scope` and `deniedPaths`; the text
  report prints all of them.

Regression: a loopback provider proposes a `package.json` test-script substitution, then applies
the correct source edit and finishes. The package edit is denied, the package/test bytes stay
intact, the run's own verification and the authoritative fixture run both pass, and the report
still records `scope: fail`, `taskSuccess: false` and `ok: false`. A second regression denies a
test-file edit; a third proves the authoritative run ignores replaced workspace runner files.
Gate, Node 24.21.0: `node --test test/provider-eval.test.mjs` 9/9 pass;
`npm run check` exit 0 — **721 tests, 721 pass, 0 fail, 0 skipped**; 176 modules
syntax-checked; coverage 94.20% lines / 84.19% branches / 94.59% functions, every floor
passing; `npm run eval` 16/16 contract pass, baseline PASS; `npm run pack:check` 90 files,
no tarball. This is self-tested; the independent reviewer must reproduce the package-script
case. See the [repair report](reports/2026-11-02-provider-eval-package-repair.md).

## Audit log

| Date       | Candidate                                                                | Reviewer                                                    | Verdict                                               | Follow-up                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-29 | Planning package against e1b3c66                                         | Chief planning self-review                                  | Prepared for PRV-101 dispatch                         | All runtime/provider compatibility acceptance pending                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-10-30 | PRV-101 candidate (working tree, base e1b3c66)                           | Chief self-review, not independent                          | SUBMITTED                                             | 598 tests pass, 0 fail/skip; check exit 0; Node 24 only. Independent PRV-106-style reproduction pending                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-10-30 | PRV-102 candidate (working tree, base e1b3c66)                           | Owner-directed gate exception; chief self-review            | SUBMITTED, not accepted                               | 11 transport + 20 legacy tests pass; full gate below. PRV-101 independent review still outstanding                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2026-10-30 | PRV-103 + partial PRV-104 candidate                                      | Owner-directed gate exception; chief self-review            | SUBMITTED / PARTIAL, not accepted                     | 8 new tests pass; UI, session binding, probes, audit and release decision remain open                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-11-01 | PRV-101–104 candidate (617 tests)                                        | Independent review                                          | CHANGES REQUIRED (R1–R5)                              | All five reproduced against the candidate; see the review report                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-11-01 | Repaired candidate (634 tests)                                           | Chief self-review, not independent                          | SUBMITTED, not accepted                               | R1–R5 fixed at cause with regressions; independent re-review required                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-11-01 | Repaired candidate (634 tests)                                           | Independent re-review                                       | CHANGES REQUIRED (RR1–RR3)                            | Shared-file alias lock, header truncation and FIFO cache reproduced                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-11-01 | Repaired candidate (640 tests)                                           | Chief self-review, not independent                          | SUBMITTED, not accepted                               | RR1–RR3 fixed at cause; independent re-review required                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-11-01 | Repaired candidate (640 tests)                                           | Independent review 3                                        | CHANGES REQUIRED (D1–D2)                              | Caller cancellation and catalog freshness reproduced; earlier repros pass                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-11-01 | Repaired candidate (645 tests)                                           | Chief self-review, not independent                          | SUBMITTED, not accepted                               | D1–D2 fixed at cause; independent re-review required                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-11-01 | Repaired candidate (645 tests)                                           | Independent check 4                                         | CHANGES REQUIRED (timeout status)                     | D1 and HTTP-failure D2 pass; timeout path rebuilt the catalog as fresh                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-11-01 | Repaired candidate (647 tests)                                           | Chief self-review, not independent                          | SUBMITTED, not accepted                               | Timeout now records failure status; independent re-review required                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2026-11-01 | Repaired candidate (647 tests)                                           | Independent check 5                                         | PASS, no new findings                                 | Timeout persistence confirmed; phase still incomplete                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-11-01 | Candidate `8ccc334a…` (647 tests)                                        | Independent full engineering check                          | PASS on Node 22/24; audit fails                       | 5 moderate dev-chain advisories; production audit clean; not the CLI candidate                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-11-01 | Provider CLI candidate (656 tests)                                       | Independent CLI review                                      | CHANGES REQUIRED (cached stale)                       | Cached `models` read hid the failed refresh                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-11-01 | Provider CLI repair (656 tests)                                          | Chief self-review, not independent                          | SUBMITTED, not accepted                               | Shared discovery summary plus real text/JSON CLI regression; re-review required                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-11-01 | Provider CLI show/update (660 tests)                                     | Chief self-implementation, not independent                  | SUBMITTED, not accepted                               | Show/update actions with digest-safe writes; independent re-review required                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-11-01 | Provider CLI show/update (660 tests)                                     | Independent show/update review                              | CHANGES REQUIRED (default erased)                     | Name-only update cleared an unlisted valid default; reproduced through the CLI                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-11-01 | Provider CLI default repair (662 tests)                                  | Chief self-review, not independent                          | SUBMITTED, not accepted                               | Default preserved unless explicitly removed; independent re-review required                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-11-01 | Provider picker/session candidate (675 tests)                            | Chief self-implementation, not independent                  | SUBMITTED, not accepted                               | Picker, exact target and digest-bound resume; independent review required                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-11-01 | PRV-104 interaction candidate (682 tests)                                | Chief self-implementation, not independent                  | SUBMITTED, not accepted                               | TTY preset, explicit built-ins and exact-ID entry; independent review required                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-11-01 | PRV-104 interaction candidate (682 tests)                                | Independent picker/resume review                            | CHANGES REQUIRED (3 defects)                          | Remote `local`, built-in resume identity and uncatalogued manual resume reproduced                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2026-11-01 | Picker/resume repair candidate (688 tests)                               | Chief self-implementation, not independent                  | SUBMITTED, not accepted                               | All three defects repaired at cause with regressions; re-review required                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-11-02 | PRV-105 opt-in eval candidate (716 tests)                                | Chief self-implementation, not independent                  | SUBMITTED, not accepted                               | 5 provider-eval tests and a fake-provider CLI run; default eval unchanged; independent review required                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-11-02 | Probe stream-bound repair (717 tests)                                    | Chief self-implementation, not independent                  | SUBMITTED, not accepted                               | P2 early argument-bound termination and reader cancellation regression; re-review required                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-11-02 | PRV-105 eval review repairs (719 tests)                                  | Chief self-implementation, not independent                  | SUBMITTED, not accepted                               | Weakened-test rejection and preflight credential binding; re-review required                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-11-02 | PRV-105 package/test-runner repair (721 tests)                           | Chief self-implementation, not independent                  | SUBMITTED, not accepted                               | Non-source edits denied; package/test bytes protected; authoritative fixture verification                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-11-02 | PRV-105 v4 scoring repair (746 tests; `f54ce83…`)                        | Independent re-review, new session                          | CHANGES REQUIRED (P1)                                 | Assertion-authority and `toJSON` bypass reproduced end-to-end; see [report](reports/2026-11-02-eval-scoring-re-review.md)                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-11-02 | PRV-105 host-shim scoring repair (18 eval, 141 focused)                  | Chief self-implementation, not independent                  | SUBMITTED, not accepted                               | Assert-patch/`toJSON` bypass fails both gates and task success; independent re-review required; [repair](reports/2026-11-02-eval-scoring-repair.md)                                                                                                                                                                                                                                                                                                                                                            |
| 2026-11-02 | PRV-105 candidate-binding bypass (20 eval)                               | Follow-up review finding                                    | CHANGES REQUIRED (P1)                                 | `context.candidate` accessor made a wrong function pass both gates and `taskSuccess`; see [finding](reports/2026-11-02-eval-candidate-binding-repair.md)                                                                                                                                                                                                                                                                                                                                                       |
| 2026-11-02 | PRV-105 candidate-binding repair (20 eval, 143 focused)                  | Chief self-implementation, not independent                  | SUBMITTED, not accepted                               | Candidate captured in a VM closure; random non-configurable invoker; end-to-end bypass fails closed; re-review required                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-11-02 | PRV-105 authoritative fixture-tamper bypass                              | Follow-up adversarial review finding                        | CHANGES REQUIRED (P1)                                 | Pre-created FIFO and detached watcher replaced the shim; wrong source passed every check; see [finding](reports/2026-11-02-eval-candidate-binding-repair.md)                                                                                                                                                                                                                                                                                                                                                   |
| 2026-11-02 | PRV-105 fixture-tamper repair (22 eval, 40 focused)                      | Chief self-implementation, not independent                  | SUBMITTED, not accepted                               | Inline stdin scoring source; no writable fixture; old FIFO path and audit-leak regressions; original attack fails closed; re-review required                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-11-02 | PRV-105 initial partial review of committed repair (`094642a`)           | Partial review, initial checks only (not the PRV-106 audit) | PASS on initial checks; not acceptance                | Valid source passes both modes; proxy-empty and intrinsic-replacement wrong sources fail both; 40/40 focused on Node 24.21.0; end-to-end counterexamples and acceptance matrix still required; [review](reports/2026-11-02-eval-review-start.md)                                                                                                                                                                                                                                                               |
| 2026-11-02 | PRV-105 end-to-end counterexample sweep on committed candidate           | Implementer-side adversarial review; not audit-independent  | Boundary held in all tried mechanisms; not acceptance | Wrong source with combined in-VM attacks plus detached watcher fails closed e2e; M1-M4 watcher evidence captured; per-mechanism isolations all `failed=1`; positive control passes under live watcher; 40/40 focused; ptrace residual unattempted; [sweep](reports/2026-11-02-eval-scoring-e2e-review.md)                                                                                                                                                                                                      |
| 2026-11-02 | PRV-105 assigned integrity review: file binding + ptrace receipt forgery | Same-session assigned review, not the PRV-106 audit         | **CHANGES REQUIRED (P1×2)**; not acceptance           | Score-time re-read (provider-eval.mjs:538) unbound to proposal bytes; wrong proposal reached `taskSuccess true` via post-apply same-uid side-writer; same-uid ptrace disclosed live receipt tokens from both scoring children and forged passing TAP + `exit_group(0)` (`authoritative`/`behavioral ok true` on the wrong body); workspace-agent gate not uplifted (unachieved record); positive/negative controls discriminated; 40/40 focused; [review](reports/2026-11-02-eval-scoring-integrity-review.md) |

## Historical baseline

At `e1b3c66`, prior checks passed 574 tests with no skips on Node 22.23.4 and 24.21.0,
16 evaluation contracts, 32 render smoke checks and the 81-file package check. These are
pre-phase results, not new provider evidence. Hosted CI and live model capability have
not been established by this board.

Re-run on 2026-10-30 before any edit, Node 24.21.0: `npm run check` exit 0, 574 tests,
574 pass, 0 fail, 0 skipped; coverage 93.99% lines / 83.62% branches / 94.15% functions;
155 modules syntax-checked. The planned 574-test figure was therefore accurate on this host.
PRV-101 candidate evidence is recorded in [decisions/PRV-101.md](decisions/PRV-101.md) and
in the candidate section below, not in this historical paragraph.

## PRV-101 candidate evidence (2026-10-30)

- `node --test test/provider-contracts.test.mjs test/provider-config.test.mjs`: 24 passed,
  0 failed, 0 skipped. Covers schema limits, reserved IDs, exact wire IDs, URL/auth rules,
  digest stability, precedence, secret canaries, private atomic writes, stale-digest refusal,
  corrupt/symlink/oversized files, live-lock blocking, dead-PID and crash recovery, and two
  concurrent writer processes.
- `npm run check` on the candidate, Node 24.21.0: exit 0; 598 tests, 598 pass, 0 fail,
  0 skipped; 159 modules syntax-checked; coverage 93.95% lines / 83.62% branches /
  94.46% functions. New ratcheted floors pass: `provider-config` 88.64/75.59/100.00 vs
  85/70/95 and `provider-contracts` 96.51/88.07/100.00 vs 95/85/100.
- Manual library demo on a temporary home: `${MATRIX_HOME}/providers.json` creation,
  `https://inference.example/team/v1/` normalized to `.../team/v1`, exact
  `vendor/Model-X:latest` identity preserved, 64-hex target digest, availability true/false
  by environment, key resolved privately, and no key bytes in the descriptor or file.
- `npm run pack:check`: 83 files packed (dry-run), posture verified, no tarball created.
- TypeScript `checkJs` now includes both new modules (clean). Coverage floors were added for
  both: `provider-config` 85/70/95 and `provider-contracts` 95/85/100 (line/branch/functions).
- Host coverage: only Node 24.21.0 is installed on this machine; the Node 22 line was not
  re-run for this candidate. That is a limitation of the current evidence, not a pass.
- Not done and not claimed: any CLI, UI, session, transport or catalog wiring; live inference;
  independent adversarial reproduction. Those belong to PRV-102 through PRV-107.

## PRV-103 / partial PRV-104 candidate evidence (2026-10-30)

- `lib/provider-catalog.mjs` exposes one read-only catalog for built-ins and configured
  profiles, availability per profile (built-ins stay `null`, Local Forge stays true), exact
  tuple lookup, grouping and an invalid-config diagnostic that keeps Local Forge usable.
- `lib/provider-discovery.mjs` performs an explicit `/models` GET with that profile's own
  base URL and auth, refuses redirects, bounds the body to 1 MiB / 1,000 entries / 15 s,
  writes a private per-profile cache keyed by the configuration digest, and returns the last
  snapshot as stale on failure. Manual models never depend on it; configured metadata wins.
- `node --test test/provider-catalog.test.mjs`: 6 passed, 0 failed, 0 skipped. Covers catalog
  availability, invalid-file diagnostic, authenticated discovery with duplicate/invalid IDs,
  private cache, stale failure behavior, redirect refusal, digest invalidation.
- Partial PRV-104: `--provider` parses and validates; headless runs resolve the target, fail
  on a missing key or declared-unsupported tools before fetching, route through
  `streamProviderChat`, and keep the legacy adapter untouched. `node --test
test/provider-integration.test.mjs`: 2 passed against a real loopback server, including a
  complete model-agent run with exact path, bearer key, exact model ID and tools payload.
- `npm run check` on the combined candidate, Node 24.21.0: exit 0; 617 tests, 617 pass,
  0 fail, 0 skipped; 165 modules syntax-checked; coverage 93.86% lines / 83.51% branches /
  94.45% functions. New floors pass: `provider-catalog` 100.00/78.95/100.00 vs 100/75/100
  and `provider-discovery` 88.06/70.51/88.24 vs 85/68/85.
- `npm run pack:check`: 86 files packed (dry-run), no tarball created.
- **Not delivered:** TUI provider selection/picker, session provider/digest persistence and
  mismatch repair, doctor/help output, `providers add/list/models/test` CLI subcommands,
  probes (PRV-105), independent audit (PRV-106) and the integrated release decision
  (PRV-107). The TUI explicitly refuses `--provider` rather than ignoring it, and the phase
  is **not** complete.

## PRV-102 candidate evidence (2026-10-30, owner-directed gate exception)

The owner directed work to continue while PRV-101 remains SUBMITTED. PRV-102 is **not**
accepted, and this exception does not establish that PRV-101 passed independent review.

- `lib/provider-transport.mjs` builds one frozen endpoint/payload/credential decision per run
  and delegates to the existing SSE parser, retry and deadline core. `streamOpenRouter` remains
  the legacy adapter with its original payload, headers and error text.
- `node --test test/provider-transport.test.mjs`: 11 passed, 0 failed, 0 skipped against real
  loopback HTTP servers. Covers two profiles sharing one exact wire model with distinct
  endpoints/keys, closed payload shape, `max_completion_tokens`, optional usage request,
  auth-none, redirect refusal with zero destination requests, missing-key-before-network,
  echoed-key redaction, cancellation, built-in refusal, target validation and optional
  payload fields.
- `node --test test/openrouter.test.mjs`: 20 passed, 0 failed after the core extraction.
- `npm run check` on the candidate, Node 24.21.0: exit 0; 609 tests, 609 pass, 0 fail,
  0 skipped; 161 modules syntax-checked; coverage 93.99% lines / 83.68% branches /
  94.48% functions; `provider-transport` 100.00/93.75/100.00 against a 90/80/95 floor.
- `npm run pack:check`: 84 files packed (dry-run), no tarball created.
- Deliberate compatibility note: redirects are now refused by the shared core, so the legacy
  OpenRouter adapter no longer follows 3xx either. This is intentional credential hardening;
  all 20 legacy streaming tests still pass. Built-in explicit-selection endpoint isolation is
  not wired here and remains PRV-104 work.
- Not done and not claimed: model-agent/controller/CLI/UI/session wiring, catalog or discovery,
  live provider inference, probes, and independent adversarial reproduction.

## Next handoff

PRV-101, PRV-102 and PRV-103 are SUBMITTED, and PRV-104 is PARTIAL. The 2026-11-01
reviews found R1–R5, RR1–RR3 and D1–D2, check 4 found the timeout status path, the first
CLI review found the cached-stale projection, and the show/update review found the
unlisted-default erasure; every reproduction is repaired with a regression case, but a
repair submission is not an acceptance. An independent reviewer must re-run
the lock (including aliased homes), secret-boundary (including headers and error codes),
isolation, catalog, cache-entry and CLI evidence on the repaired candidate before the
chief releases the remaining phase; the chief's own self-review cannot satisfy that gate.
The picker, digest-bound resume, TTY preset, explicit built-ins, exact-ID entry, profile
replacement and the `providers test` probe are implemented; an independent reviewer must
still check their target identity, availability, refusal and retention paths. The PRV-105
opt-in provider evaluation is SUBMITTED; its v4 scoring repair received an independent
**CHANGES REQUIRED (P1)** verdict because submitted code could patch the authoritative
assertions and substitute behavioral output through `toJSON`. The implementer has now
submitted a host-shim repair: both independent verification runs isolate submitted source
and keep assertions and result marshaling in the host realm. A follow-up finding then
showed the shim still stored the candidate in a mutable VM global; the repair now captures
it in a VM closure under a random non-configurable invoker. The original and
candidate-binding bypasses fail both gates and task success; independent re-review is
required before acceptance. PRV-106 adversarial audit and PRV-107 integration remain open. A development dependency override
resolved the five reported advisories, but its major-version compatibility still
needs independent review. **The dynamic-provider phase is not complete.**
Record actual ownership and evidence as work occurs. Do not prefill future success.
