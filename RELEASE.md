# Matrix release checklist

REL-001 establishes a **private/internal CLI** posture. This checklist is a release gate, not a record
that a release or hosted validation has already happened.

## Fixed posture

- Keep `private: true`. Do not run `npm publish`, add registry publication automation, or remove the
  private marker as a side effect of packaging. `npm pack --dry-run` is inspection only and is valid
  for a private package.
- The supported consumer entry point is the `matrix` CLI (`bin/matrix.mjs`). Keep `main` pointing to
  `src/matrix.mjs` for compatibility, but do not describe it as a supported public module API or add an
  `exports` contract without a separate design decision.
- Keep `ink` and `react` in production `dependencies`. Development tools, tests, and benchmark modules
  are not runtime dependencies.
- The version remains **1.0.0** for REL-001. A future version change must be deliberate, update
  `package.json` and `package-lock.json` together, update `CHANGELOG.md`, and repeat every gate below.
  A successful local pack is not a reason to bump or publish.

## Package boundary

`package.json#files` is the deliberate allowlist. The internal pack contains the CLI/runtime modules
(`bin/`, `lib/`, and `src/`), the complete runnable demo (`demo-project/`), user/architecture docs
(`README.md` and `MATRIX.md`), `LICENSE`, `CHANGELOG.md`, and npm's required `package.json` metadata.
The demo's pytest file is a runtime demo fixture required by the tour, not the Matrix engineering test
suite.

The top-level `test/`, `bench/`, `eval/`, and `scripts/` trees, CI and development configuration, planning docs,
this maintainer checklist, dependency directories, provider credentials, logs, coverage, local Matrix
sessions/backups/run logs, scratch files, and tarballs must stay out. Benchmark commands are therefore
source-checkout development workflows, not a capability promised by the stripped internal pack.

The `scratch_*.png` rule remains in `.gitignore`; do not delete existing local scratch captures merely
to clean a pack. Ignoring does not untrack previously tracked files, and the pack allowlist—not Git
tracking state—is what keeps every scratch capture out of the artifact. Keep provider credentials and
local state outside the source tree as well; an allowlist is a packaging boundary, not secret hygiene.

## Required gates for every internal release candidate

Run from a clean checkout with no unrelated working-tree changes. Record the Node/npm versions and
exact results in the release handoff. A checkbox may be marked only against evidence for that candidate.

The marks below record the **REL-001 candidate `b7966a0`** as reviewed on 2026-11-11, updated by the
documentation patch prepared the same day. Each checked box cites the evidence for that candidate.
These marks do not carry forward: a later candidate must be re-evaluated on its own evidence. The
patch changes no runtime behavior, test or workflow, but it edits two packaged files and therefore
produces a new candidate that still needs its own hosted matrix run; see the
[release-readiness record](#release-readiness-record--rel-001-candidate-b7966a0-reviewed-2026-11-11).

- [x] Install exactly from the lockfile with `npm ci`; do not use an existing `node_modules` as evidence.
      Evidence: the hosted step `Install npm dependencies` (`npm ci`) succeeded on Node 22.23.1 and
      Node 24.21.0 in [run 42871859453](https://github.com/imitravanu/Matrix/actions/runs/42871859453).
      A fresh clone of the pushed branch also installed from the lockfile with `npm ci` and passed
      `npm run pack:check`. The lockfile is unchanged from base `ff55a2c`.
- [x] Run `npm run check` successfully (syntax, lint, JSDoc typecheck, formatting, full tests, and
      coverage ratchets).
      Evidence: the hosted step `Run engineering gate` succeeded on both runtimes — 1,033 tests,
      1,033 pass, 0 failed, 0 skipped, every coverage ratchet met (Node 22.23.1:
      93.21% lines / 82.97% branches / 94.85% functions; Node 24.21.0:
      93.27% / 83.18% / 94.88%).
- [x] Run `npm test` successfully as the standalone network-free suite.
      Evidence: the hosted step `Verify complete suite with hostile provider environment` succeeded —
      1,033 pass, 0 fail, 0 skipped. Reproduced locally on both runtimes with empty provider
      credentials and with fake credentials against unreachable endpoints.
- [x] Run `npm run eval` and require every case-specific contract and the strict reviewed baseline to
      pass with zero safety violations and complete cleanup. Keep stress and baseline updates separate.
      Evidence: the hosted step `Run network-free agent evaluation` succeeded on both runtimes —
      16 cases, 16 contract pass, 9 task success, 4 not completed, 3 task n/a, 0 safety violations;
      baseline PASS with 0 failures; cleanup reported roots removed, env/fetch/spawn restored and
      0 active processes. No stress run and no baseline update is part of this candidate.
- [x] On Linux, install `bubblewrap` and `util-linux`, run the real command sandbox adversarial tests,
      and require the Doctor policy probe to pass. On AppArmor-restricted Ubuntu, load the narrowly
      scoped `/usr/bin/bwrap` profile instead of changing the global AppArmor sysctl. Do not accept an
      unsandboxed fallback, skipped probe, or hidden seccomp/aggregate-quota claim.
      Evidence: the hosted workflow installs `bubblewrap util-linux apparmor` and loads the narrow
      `/usr/bin/bwrap` profile without touching the global AppArmor sysctl. The real sandbox
      adversarial tests ran on both runtimes with 0 skipped, including
      `network and host socket attempts cannot connect or send a payload`,
      `interpreter, traversal and denied-edit replacement affect only the disposable snapshot` and
      `unsupported backend and failed real probes are unavailable with no unsandboxed fallback`. The
      hosted step `Require the Doctor policy probe` reported `goal-ownership` ok
      (`pidfd helper and Bubblewrap PID-namespace containment verified`), `linux-sandbox` ok
      (`real namespace/snapshot probe passed`) and `sandbox-policy` ok
      (`network=new-empty-network-namespace … workspace=private no-follow snapshot … writes discarded`).
- [x] Run `npm run smoke` and require all responsive frame checks to pass.
      Evidence: the hosted step `Run responsive smoke checks` succeeded on both runtimes — 32 frame
      checks across 60×22, 80×26, 100×30 and 140×40, 8 screens each.
- [x] Run `npm run bench` and require all ordinary local benchmark cases to complete cleanly. Treat
      timings as local references, not portable performance SLAs; use explicit stress runs separately.
      Evidence: rerun locally on this candidate — every ordinary case completed, the functional
      checks passed, temp cleanup removed the fixtures, and 0/0 Ink and process resources remained
      active. The hosted benchmark smoke step also passed on both runtimes. Timings are recorded as
      local references only; no stress run and no performance claim is part of this candidate.
- [x] Run `npm run pack:check`. This invokes real `npm pack --dry-run --json` with lifecycle scripts
      disabled and a temporary pack destination, compares the complete file set with the source-backed
      allowlist, verifies private/main/bin posture and the executable bin, and fails on missing or
      unexpected files. It must neither create a tarball nor publish.
      Evidence: the hosted step `Verify internal package contents` succeeded on both runtimes and
      locally — 109 allowlisted files, private/main/bin posture verified, no tarball created and
      nothing published.
- [x] Run `npm pack --dry-run --json` directly for the release record; inspect entry count, packed and
      unpacked sizes, `main`, and `bin`. Confirm no `.tgz` appears in the workspace. Dry-run success does
      not authorize publication.
      Evidence: run directly on this candidate — 109 entries, 422,876 bytes packed, 1,656,438 bytes
      unpacked, shasum `345529ac19f5bfeed3b8c04d6cee50138b623b5e`, `bin/matrix.mjs` present with mode
      0755, `package.json#main` = `src/matrix.mjs` and `bin` = `{"matrix":"./bin/matrix.mjs"}`,
      `private: true`. No `.tgz` exists in the workspace before or after the dry run. The hosted runner
      reported 420,429 packed bytes for the identical 109-file, 1,656,438-byte content; the difference
      is npm 12.2.2 archive encoding against npm 12.2.0 locally, not different content.
- [x] Run `npm audit` and resolve or explicitly document every finding before release. An earlier clean
      audit is not evidence for a changed lockfile.
      Evidence: the hosted step `Audit locked dependencies` ran `npm audit` against this candidate's
      lockfile on both runtimes and reported `found 0 vulnerabilities`. The lockfile is unchanged from
      base `ff55a2c`, so this audit is evidence for the released lockfile.
- [x] Require the hosted clean-checkout CI matrix to pass on **both Node.js 22 and Node.js 24**, including
      its normal and hostile-provider-environment gates, static/test checks, real bubblewrap execution,
      network-free agent evaluation, package inspection, dependency audit, smoke, and benchmark smoke.
      Local Node 22/24 results are useful but do **not** satisfy this hosted-CI gate. Hosted run #6
      passed on `matrix/engineering-hardening`, including default evaluation and real bubblewrap
      execution; future candidates still require a fresh pass.
      Evidence: [run 42871859453](https://github.com/imitravanu/Matrix/actions/runs/42871859453)
      (run number 13, 2026-11-10T18:06:55Z to 18:11:32Z, event `push`) on branch
      `matrix/int101-hosted-ci` reports `head_sha`
      `b7966a076fab79724e56ba79afb62c1ebdda0ed3`, which is exactly the reviewed candidate commit, and
      concluded **success**. All 18 steps passed on the Node 22 job and on the Node 24 job: isolated
      0700 Matrix home, sandbox prerequisites, pidfd helper build, Doctor policy probe, engineering
      gate, package inspection, dependency audit, hostile-provider suite, network-free agent
      evaluation, durability adversarial harness (20/20), responsive smoke and benchmark smoke.
      This evidence covers `b7966a0` exactly. The 2026-11-11 documentation patch and the DUR-001
      contract repair both produce a later candidate, so the hosted matrix must be re-run for that
      head before this box can be marked against it.
- [x] Review the final diff and run `git diff --check`; confirm version, changelog, license, pack size,
      and file list are intentional. Leave commits, tags, and publication to an explicit later decision.
      Evidence, against the patched and repaired tree: `git diff --check ff55a2c` exits 0 with no
      output, and `npm run format:check` passes on every file. The 25 two-space Markdown hard-break findings in
      `docs/next-phase/decisions/DUR-001.md` and the two 2026-11-05 DUR-001 review reports were
      converted to backslash hard breaks; all 25 lines are outside code fences and outside `<pre>`
      blocks, so the two forms are equivalent CommonMark hard line breaks and the rendered meaning is
      unchanged. Version `1.0.0` and `private: true` are unchanged, `main`/`bin` are unchanged, `ink`
      and `react` are still the only production dependencies and no `exports` contract was added, the
      ISC `LICENSE` is unchanged, and `npm run pack:check` and `npm pack --dry-run --json` report the
      same 109 files with the packed set containing no `test/`, `eval/`, `bench/`, `scripts/`,
      `docs/`, `.github/` or scratch capture. `CHANGELOG.md` now records the durable-goal capability
      and its Linux, Bubblewrap and pidfd requirements under `Unreleased`, without a version bump and
      without changing `package.json` or `package-lock.json`.

Two further documentation items were required by `AGENTS.md` ("Update `README.md`, `MATRIX.md`, and
the task status when behavior or architecture changes"). The 2026-11-11 patch closes both:

3. `MATRIX.md` ships in the pack and now documents the new durable-goal process-ownership and
   containment boundary (`lib/goal-policy.mjs`, `lib/goal-guardian.mjs`,
   `lib/goal-containment.mjs`, `lib/goal-lease-probe.mjs` and the
   `scripts/matrix-pidfd-helper.c` ownership primitive), in a "Durable goal process ownership and
   test containment" section and a runtime-map row. It states that a goal's approved test command
   runs in a Bubblewrap PID namespace over the live root with host-network access, which is weaker
   than the `run_sandboxed_command` snapshot boundary, and it points at the open contract discrepancy.
4. `README.md` gained a "What the goal sandbox does and does not contain" section and a limitation
   bullet stating the same boundary, the credential exposure and the required trust and approval.

All four items are documentation-only. None of them changes runtime behavior, a test, a workflow, the
private/internal posture, or the version.

**Correction to an earlier statement in this file.** The first issue of this checklist said that
these edits "change no fingerprinted file". That was **wrong**. `README.md` and `MATRIX.md` are
members of the DUR-006 and integrated candidate manifests, so editing them changes both digests,
and `CHANGELOG.md` changes the packed artifact. The revised digests are recorded in the
[release-readiness record](#release-readiness-record--rel-001-candidate-b7966a0-reviewed-2026-11-11)
and in section 14.6 of the INT-101 integration report. The DUR-005 and DUR-006 accepted _reviews_
keep their own candidate identities and are not rewritten, because the change is a documentation
edit to two member files and not a runtime change.

## Live-provider validation boundary

The default suite and hosted CI must remain network-free and must use fake/no credentials. Mocked
OpenRouter/Ollama/custom-endpoint tests verify Matrix's routing and protocol behavior only; they do not
prove current provider availability, model naming, pricing, context limits, tool-call support, latency,
or response quality. Never turn a missing live check into a claim that those properties were verified.

Live-provider checks are optional, separately scoped manual evidence, not a substitute for any gate
above. If maintainers choose to run one, use an explicitly authorized low-risk fixture, never print or
attach credentials or sensitive repository context, and record the provider, exact model, date, request
scope, outcome, and redaction/retention limits. Do not generalize one model/result to the registry, and
do not put live secrets in CI logs, sessions, run logs, changelogs, or failure artifacts.

---

## Release-readiness record — REL-001 candidate `b7966a0` (reviewed 2026-11-11)

### Verdict

**BLOCKED.** Every verification, safety and packaging gate above is satisfied by evidence for
candidate `b7966a0`. A documentation patch prepared on 2026-11-11 closes the release-readiness
findings recorded in the first issue of this checklist: the final-diff checkbox, the changelog entry
and the `README.md`/`MATRIX.md` containment documentation. Two things still block the release, and
neither is a code, test, coverage, evaluation, sandbox, benchmark, package, audit or hosted-CI
failure:

1. **The DUR-001 durable-snapshot contract is unmet.** The goal test path runs in a live-root PID
   namespace with host-network access, while `docs/next-phase/decisions/DUR-001.md` requires that a
   surviving job may write only to a disposable snapshot. The discrepancy is recorded as **open, for
   chief disposition**, in the decision record's dated review addendum and in section 14.5 of the
   INT-101 integration report. Documenting the implementation does not meet the contract.
2. **The patched candidate still needs its own hosted matrix run.** The patch changes two packaged
   files, so it produces a new candidate that the hosted gate has to cover.

- **Candidate commit:** `b7966a076fab79724e56ba79afb62c1ebdda0ed3`
- **Branch:** `matrix/int101-hosted-ci`, pushed to `origin` at the same commit
- **Base:** `ff55a2c2aaeb863e881a5a8d0e112eb78ded0204` (unchanged; no history rewritten)
- **Working tree at review time:** clean, no uncommitted or untracked changes
- **Hosted CI:** [run 42871859453](https://github.com/imitravanu/Matrix/actions/runs/42871859453)
  — run number 13, `head_sha` `b7966a076fab79724e56ba79afb62c1ebdda0ed3`, conclusion **success**.
  The run's `head_sha` is byte-identical to the reviewed commit, so this gate is evidence for this
  candidate and not for an earlier one.
- **Runtimes:** Node 24.21.0 and Node 22.23.1, on the hosted `ubuntu-latest` matrix and locally.
- **Tagging state:** the candidate is not tagged. A pre-existing local tag `v1.0.0` points at the
  older ancestor commit `692f6f1` (`feat(matrix): v1.0.0 Sovereign Cockpit release`); it is not on the
  remote, and the repository has no GitHub release. Because REL-001 keeps the version at 1.0.0, any
  later tagging decision must not reuse the `v1.0.0` name against this candidate without first
  deciding what the existing tag means.

### Evidence summary

| Requirement area              | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lockfile install              | `npm ci` succeeded on both hosted runtimes and in a fresh clone of the pushed branch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Engineering gate              | 1,033/1,033 tests, 0 failed, 0 skipped, all coverage ratchets met, on Node 22 and Node 24                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Standalone network-free suite | 1,033/1,033 under the hostile provider environment and, locally, with empty provider credentials                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Agent evaluation              | 16/16 case contracts, 0 safety violations, strict reviewed baseline PASS, cleanup complete                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Linux sandbox                 | Real Bubblewrap adversarial tests ran with 0 skipped; Doctor policy probe ok for `goal-ownership`, `linux-sandbox` and `sandbox-policy`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Smoke                         | 32 frame checks across four geometries                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Bench                         | All ordinary cases completed; functional checks passed; temp cleanup removed; 0/0 active resources                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Package verification          | `npm run pack:check` passed; 109 allowlisted files; private/main/bin posture verified; no tarball                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Pack inspection               | 109 entries, 422,876 bytes packed, 1,656,438 unpacked, shasum `345529ac…`, executable `bin/matrix.mjs`, no `.tgz` in the workspace                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Dependency audit              | `npm audit` reported 0 vulnerabilities against this lockfile                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Hosted CI matrix              | Run 42871859453 success on Node 22 and Node 24, all 18 steps green                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| DUR-001 contract repair       | The goal test path now runs in the disposable-snapshot boundary the decision record requires. The focused independent review of that repair returned **CHANGES REQUIRED** (an incomplete source identity, a vacuous success-receipt check and an incomplete candidate manifest); all three were repaired. The 2026-11-12 reviews reproduced four further false completions in two waves — unnormalized root-relative paths hid data-file contents, installed dependency bytes were untracked, execution-relevant permission bits were absent from the directory walk, and a subdirectory plan could read unnamed sibling inputs — and all are now repaired. The identity is derived from the complete input boundary the disposable snapshot exposes (whole-workspace, bounded, no-follow traversal with the snapshot's own exclusions and budgets, recording content, entry types, permission bits and symlink targets), with explicit refusal when complete identity cannot be established. A working-directory selection or static import closure is no longer treated as a coverage proof. Both independent reproductions and the permanent regressions pass. Engineering gate 1,075/1,075 with 0 skipped on Node 22 and Node 24, durability harness 20/20 on both runtimes, evaluation 16/16 with 0 safety violations on both, 110 packed files with the private posture verified and no tarball. **ACCEPTED on 2026-11-12** against the integrated 45-file candidate `f46b90b4…` by the independent focused re-review: 38/38 submitted manifest and isolation regression tests with 0 failed and 0 skipped, 3/3 independently reconstructed probes with 0 failed, on Node 24.21.0 with real Bubblewrap, plus the closed candidate-record correction. That review was focused on the snapshot identity repair, not a new audit of every completed phase, and the full Node 22/24 gate and durability results above are the submission's reported evidence, not independently rerun results from that turn. The hosted gate below is still outstanding for this candidate. |
| Diff hygiene                  | `git diff --check ff55a2c` is empty after the 2026-11-11 patch; `npm run format:check` passes on every changed file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Candidate manifests           | The current candidate manifests are DUR-005 29-file `e239d002…`, DUR-006 14-file `fe95bc4c…` and integrated 45-file `f46b90b4…`, revised by the 2026-11-12 coverage-boundary repair and the candidate-record correction. The hosted run above covers `b7966a0` and therefore the earlier manifest values; it does **not** cover these values                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### Revised candidate manifests

The documentation patch and the DUR-001 contract repair both change manifest
members, so every affected digest was recomputed. The earlier statement in this
file that the edits "change no fingerprinted file" was wrong and is corrected
above.

| Manifest                         | Accepted value                                                     | After the documentation patch                                      | After the contract repair                                          | After the independent-review repair                                                        |
| -------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| DUR-005 23-file candidate        | `4ecd249ea37b6dd9150caa8942fbf0819e921b17afda8d1ada2b721d0718ee04` | `4ecd249ea37b6dd9150caa8942fbf0819e921b17afda8d1ada2b721d0718ee04` | `d43753d8c5362ad7a4ef102c6cc68c0f4a7f2aee0cf2b50a93a79bb626ece14e` | superseded by the 28-file candidate below                                                  |
| DUR-005 repair 28-file candidate | —                                                                  | —                                                                  | —                                                                  | `8c8821ede769ee338b0796a50f36cfa096ffe9c07ef8f122a545a7ade53df855` (superseded 2026-11-12) |
| DUR-006 14-file candidate        | `da9d9d752d0c44b042cb8f608e8b50ca7eaef0498569c0c1870f37dcdecdbce8` | `fd89f0ab8d8a093310a936be29d1a428a1dc77df234241a8ddc1d1d47f266bf3` | `fd89f0ab8d8a093310a936be29d1a428a1dc77df234241a8ddc1d1d47f266bf3` | `0a39f962ba8976e81a8a29ab8b15ecd897b6cfcc1bf7ff078f7cd757fbbac237` (unchanged 2026-11-12)  |
| Integrated 39-file candidate     | `2e7419851e8f26333a2219d4f026092b62968f26fd0538a54a299e00c192676c` | `b436903fd2de87e19762e27380d2bcc7ecc9b51b34eec3a49df3139228dfc3e4` | `b436903fd2de87e19762e27380d2bcc7ecc9b51b34eec3a49df3139228dfc3e4` | superseded by the 44-file candidate below                                                  |
| Integrated 44-file candidate     | —                                                                  | —                                                                  | —                                                                  | `51d91f1351e817183358103991e9521f9c5d7f8ab8381f7295233e364248fea9` (superseded 2026-11-12) |

After the 2026-11-12 blocker repair the current values are:

| Manifest                     | Current SHA-256                                                    |
| ---------------------------- | ------------------------------------------------------------------ |
| DUR-005 28-file candidate    | `0eac7b61bb306f34258b9f0c651ae7fc8600e51d65f703a9f33ca38c5eadd27c` |
| DUR-006 14-file candidate    | `c6a26536d1a20e699c5fa8693bfcdafbe5cd605be82e43b9bbc139b93486341e` |
| Integrated 44-file candidate | `856312a0c2bd4444ae13f8458fb3f24dbb6f39447f6688f743d9acc3d147c771` |

**Superseded again by the 2026-11-12 coverage-boundary repair.** That repair
reproduced two further false completions — a test that executed a helper whose
live execute bit had been removed still completed, and a subdirectory plan that
read a sibling `../input.json` still completed after that file changed — and
replaced the coverage heuristic with an identity derived from the whole
snapshot boundary, including permission bits and entry types. Because the
earlier 28-file and 44-file lists were never written down verbatim, the current
values are stated together with their membership so they are reproducible from
the repository:

| Manifest         | Members                                                | SHA-256                                                            |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| DUR-005          | 29 (`docs/next-phase/fixtures/dur005-members.txt`)     | `e239d002633ca94134ed18e170d8912304c69c1b6208499edf22e929b2ca5c68` |
| DUR-006          | 14                                                     | `fe95bc4cee570936f9e6c9567e4bf3f94a69c2e4cbe2edfdbaf3d4356475bf1a` |
| Integrated union | 45 (`docs/next-phase/fixtures/integrated-members.txt`) | `f46b90b424625f804d0e959dcb43151cd30e92b15f0f3818a5bb0b02797f7c28` |

**Candidate-record correction on 2026-11-12: integrated manifest restored to 45
members.** The focused re-review of the coverage-boundary repair closed the two
runtime blockers and left one candidate-record issue: the integrated manifest
held only the 43-file DUR-005/DUR-006 union and had dropped `package.json` and
`eval/durability/run.mjs`. The INT-101 integration report defines the
integrated fingerprint as the sorted union of the DUR-005 and DUR-006 path
lists **plus** `package.json` and `eval/durability/run.mjs`, so the 43-file list
was not the integrated manifest, and because the durability harness is modified
in this candidate, that digest did not bind the changed acceptance evidence.
Both members are restored, the list is 45 unique files, and the digest was
recomputed from the repository root over sorted relative paths, each followed by
one NUL byte and the raw file bytes. The digest was recomputed and checked, not
copied from the review. The manifest file is now stored in sorted order, so
reading it top to bottom reproduces the digest; the previous file listed
`MATRIX.md` and `README.md` in ambient-locale order, which hashed to a
different value than the recorded sorted digest. No runtime file changed, so the
DUR-005 and DUR-006 digests are unchanged, the reviewed runtime evidence still
covers this candidate, and no runtime suite was rerun for this metadata-only
correction. The 43-file value
`db8fd6856f0780faa9cb84f94c51b461b31091a1f6c0b85b29d75d3db643cd88` is
superseded, not deleted: it remains the identity of the 43-file list that was
recorded, which was not the integrated manifest.

**Acceptance disposition on 2026-11-12.** The DUR-001 contract repair is
**ACCEPTED** against the candidate above — HEAD
`b7966a076fab79724e56ba79afb62c1ebdda0ed3` on branch `matrix/int101-hosted-ci`
plus the submitted working-tree repair — on the independent focused re-review
(`/tmp/matrix-dur001-independent-review.md`): 38/38 submitted manifest and
isolation regression tests with 0 failed and 0 skipped, 3/3 independently
reconstructed probes with 0 failed, on Node 24.21.0 with real Bubblewrap, and
the closed candidate-record correction. The digest was recomputed from the
repository root and matches. The acceptance is scoped: the review was focused
on the snapshot identity repair, not a new audit of every completed phase, and
the full Node 22/24 gate at 1,075/1,075 and the durability harness at 20/20
were reported by the submission and were not independently rerun or log-verified
in that turn.

The release stays **BLOCKED** on one remaining item, which is not another
acceptance review: a **hosted CI run on Node 22 and Node 24 for the exact
committed candidate**. The hosted run for `b7966a0` covers that commit exactly
and predates this working-tree repair, so it is not evidence for this candidate
and cannot satisfy this gate. Acceptance of the repair does not move the
release to READY.

`lib/linux-snapshot.mjs` is now a DUR-005 member because the identity imports
the snapshot's own exclusion rules and budgets from it. Evidence for the
repair: `npm run check` 1,075/1,075 with 0 skipped on Node 22.23.1 and
24.21.0, durability harness 20/20 on both, evaluation 16/16 with 0 safety
violations on both, pack check 110 files with no tarball, both independent
reproductions passing, and `git diff --check` clean. The repair is
**ACCEPTED** as of 2026-11-12, and the release stays blocked on an
exact-candidate hosted CI run.

The blocker repair changed two manifest members,
`lib/goal-source-manifest.mjs` and `test/goal-source-manifest.test.mjs`. Their
per-file SHA-256 values are `03f8b93c3e2294cd56b17ec1291d924aa89ed0e24d5840ea61edd33faf69d345`
and `0eb00ab973b26fade6f7648960d97a787ea72b0b6fc2dc2566019cf812a3c2ef`. The
same repair corrected `README.md` and `MATRIX.md`, which still described the
narrower input set, so the DUR-006 and integrated digests changed again.

The contract repair changes four DUR-005 members (`lib/goal-containment.mjs`,
`lib/goal-policy.mjs`, `lib/goal-executor.mjs` and `test/goal-runtime.test.mjs`)
and the documentation patch changes the two packaged documents that are DUR-006
and integrated members.

The independent-review repair of the contract repair adds five files to the
manifests, so the DUR-005 candidate becomes a 28-file candidate and the
integrated candidate a 44-file candidate; the 2026-11-12 blocker repair changes
two existing members and adds none: the shared sandbox implementation
`lib/linux-bwrap.mjs`, the new manifest module `lib/goal-source-manifest.mjs`
and the three regression files `test/goal-isolation-builder.test.mjs`,
`test/goal-source-manifest.test.mjs` and `test/goal-test-isolation.test.mjs`.
It also changes `lib/goal-context.mjs`, `lib/goal-cli.mjs`,
`scripts/check-coverage.mjs` and `test/goal-cli-runtime.test.mjs`, which are
already members, and it corrects `README.md` and `MATRIX.md`, which are DUR-006
and integrated members: both still described the live-workspace and host-network
boundary that the contract repair replaced, so they were inaccurate about the
shipped behavior.

Per-file SHA-256 after the patch and the repair:

| File                                   | SHA-256                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| `MATRIX.md`                            | `4a03fcde363c59b7340d9bcb4a8f38b2f19fcc45b7c1f4bd8758a6840abbc99c` |
| `README.md`                            | `23972c4eb4e710f923d2ec1216a55b99d25a2d229b4561659258a38ade21966d` |
| `CHANGELOG.md`                         | `7985cb68877d3f71703aefb7b12cc92a8e90362c07d09a2b8f7366a0ef9b4340` |
| `lib/goal-source-manifest.mjs`         | `5c3a759d2f4ade6eb06703ed64c32f59c3c9e0a08fded61fbfe74854e87e94f7` |
| `lib/linux-bwrap.mjs`                  | `5c05c8172c8c8f7afb2af6a9ebb021ddd89f90c528e24d3f159f16556f35dcd6` |
| `test/goal-isolation-builder.test.mjs` | `b87e519c6d06f445bf77c272193ecff87e023f1bee9c4dfef0ff38b6dfa5d7b3` |
| `test/goal-source-manifest.test.mjs`   | `2b46fa6ea38834a6267026ce82e74e4c69e0b4e1060d4da3b25a120e8f9451e8` |
| `test/goal-test-isolation.test.mjs`    | `95066b35e16f58590f3cc4ff8c67e2163c8acba5d1940b491b24f01e93427a2a` |

`CHANGELOG.md` is in the package allowlist but in no manifest, so it changed no
digest. The accepted DUR-005 and DUR-006 reviews keep their own candidate
identities; the digests above supersede the values recorded for those manifests
in the integration report.

### Requirements closed by the 2026-11-11 documentation patch

1. **The final-diff checkbox.** The 25 two-space Markdown hard breaks in
   `docs/next-phase/decisions/DUR-001.md` and the two 2026-11-05 DUR-001 review reports were
   converted to backslash hard breaks. All 25 lines are outside code fences and outside `<pre>`
   blocks, so the two forms are equivalent CommonMark hard line breaks and the rendered meaning is
   unchanged. `git diff --check ff55a2c` is now empty, and Prettier still accepts all three files
   byte-for-byte.
2. **Changelog completeness.** `CHANGELOG.md` now records the durable-goal CLI, the reviewed pidfd
   ownership helper with its Linux, Bubblewrap, `util-linux` and C-toolchain requirements, and the
   durability adversarial harness. The version stays 1.0.0 and neither `package.json` nor
   `package-lock.json` changed.
3. **`MATRIX.md` architecture coverage.** `MATRIX.md` gained a "Durable goal process ownership and
   test containment" section and a runtime-map row describing the pidfd helper, guardian, namespace
   pinning, ownership records, the durable teardown block, the actual live-filesystem and host-network
   test boundary, the credential exposure and the required trust and approval.
4. **`README.md` limitation coverage.** `README.md` gained a "What the goal sandbox does and does not
   contain" section and a limitation bullet stating the same boundary.

### Requirements still open

1. **The DUR-001 durable-snapshot contract (chief disposition).** **Closed on
   2026-11-12.** The contract in `docs/next-phase/decisions/DUR-001.md` requires
   that a surviving job may write only to a disposable snapshot. The goal test
   path did not meet it. The contract repair of 2026-11-11 implemented it, and
   the focused independent review of that repair returned **CHANGES REQUIRED**:
   the test evidence was bound to an incomplete input set, the crash regression
   carried a vacuous success check, and the candidate manifest did not bind the
   shared sandbox implementation and the new regressions. All three were
   repaired, and two further waves repaired the source identity and the coverage
   boundary. The focused repair review of 2026-11-12 closed every finding —
   38/38 submitted regression tests and 3/3 independently reconstructed probes
   pass on Node 24.21.0 with real Bubblewrap, and the candidate-record
   correction is closed — and the repair is **ACCEPTED** against the exact
   candidate digests recorded above. The contract text is unchanged and is not
   amended by the acceptance.
2. **Exact-candidate hosted CI for the patched and repaired candidate.** The patch and both repairs
   change packaged files and runtime files, so the test, coverage, evaluation, sandbox, smoke, bench,
   package and audit evidence must be re-established by the hosted matrix for the new head. Run
   42871859453 covers `b7966a0` exactly and is not evidence for this candidate.
   **Closes with:** a hosted run covering the patched and repaired commit on both Node 22 and Node 24.

### Follow-on assessment

The four follow-ons accepted in the QA-101 disposition are reviewed and **none of them blocks this
release**:

| Follow-on                                                        | Priority | Release effect                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CR-16 harness barrier forwards to the real store                 | P2, QA   | Reduces the fidelity of one harness case only. The chief's independent probe shows the production store refuses a post-cancel dispatch with `stale fence`, so the safety cutoff does not depend on the harness barrier. Evidence-strength only. |
| Cancel-versus-dispatch stop classification                       | P3, exec | Affects the reported stop reason, not the safety decision. QA-101 CR-16 records pre-dispatch stopped and post-dispatch reconciled.                                                                                                              |
| CR-08 teardown-refusal branch test hook                          | P3, exec | A missing test hook for a branch that fails closed. CR-08 meets its criterion through the verified-stopped branch.                                                                                                                              |
| Production namespace membership discrimination after inode reuse | P3, exec | `namespaceMembers` matches on inode alone, so a reused inode can cause a spurious `namespace-member-survived` refusal. It can only over-refuse recovery and cannot authorize anything. Availability, not safety.                                |

One additional finding was raised by this review and is recorded as a new follow-on. It does **not**
block this release either.

**New follow-on (P2, executor) — the durable-goal test path is contained by a PID namespace over the
live host root, not by a disposable snapshot.** `lib/goal-containment.mjs` starts the goal's approved
test command with `bwrap --unshare-user --unshare-pid --dev-bind / / --`, and the command's working
directory is the live workspace (`plan.cwd ?? realpathSync(workspaceRoot)` in
`lib/goal-policy.mjs`). Reproduced on this host with that exact argv: a process inside the namespace
created a file on the live host filesystem and reached the host loopback network. This is weaker than
the `run_sandboxed_command` boundary (`lib/linux-bwrap.mjs`: minimal read-only root, `--unshare-net`,
disposable no-follow snapshot, cleared environment) and it diverges from the design contract recorded
in `docs/next-phase/decisions/DUR-001.md` — "exposing only disposable snapshots to detachable work"
and "Any surviving job may write only to its disposable snapshot".

Why it is not release-blocking: the ordinary test path already runs repository test code on the host
with the host user's permissions (`lib/process.mjs` defaults to `processBackend: "host"`), so this
release introduces no new class of host exposure; the goal path adds process-teardown guarantees on
top of that; dispatch still requires exact repository/test trust and a separate `--allow-tests`
decision; and the durable evidence model binds test evidence to a dispatch-time fingerprint, so a test
that changes a declared artifact cannot produce a pass (QA-101 CR-09). The shipped `README.md` and
`MATRIX.md` make no snapshot or no-network claim about the goal test path, so no user-facing statement
is inaccurate. The exposure to record is that a goal's approved test command can read host credential
files and reach the network while it runs.
**Closes with:** either giving the goal test path the same disposable, no-network snapshot boundary as
`run_sandboxed_command`, or recording the live-root boundary as an accepted, documented limitation with
the credential and network exposure stated, and amending `docs/next-phase/decisions/DUR-001.md` to
match the shipped design.

### Durability verification is not live-provider capability

This release establishes **durability verification only**. The candidate's evidence is that the
durable-goal runtime, its store, executor, recovery path and ownership boundary behave as reviewed,
that the QA-101 adversarial durability matrix passes 20/20 on both runtimes, and that the whole
delivery gate passes on Node 22 and Node 24 in hosted CI.

It establishes **no live-provider capability**. The hosted run and the default suite are network-free
and use no real credentials. No live provider availability, model naming, pricing, context limit,
tool-call support, latency or response-quality property was verified for this candidate, and the
opt-in live provider evaluation remains unevaluable on a hosted runner because it requires Linux Yama
`kernel.yama.ptrace_scope=2` or `3` and an untraced evaluator. The durability verdict must not be
read as a provider verdict, and the provider phase's own residual findings (F-1, F-3, F-2 and F-4 in
`docs/next-phase/STATUS.md`) are untouched by this release.

### Exact next action

No code change is needed to close this review. The documentation patch that closes the
release-readiness findings is prepared and uncommitted in the working tree; it is reviewed in
[section 14.6 of the integration report](docs/next-phase/reports/2026-11-09-int101-integration.md#146-documentation-patch-and-revised-fingerprints).

One thing is still required before the verdict can move to READY:

1. **Approval to commit and push the patch and the repairs on `matrix/int101-hosted-ci`, followed by
   a hosted matrix run for the resulting head.** The patch and the repairs change packaged files, so
   they create a new candidate; the hosted matrix must pass on Node 22 and Node 24 for that new head
   before the checklist can be marked. Run 42871859453 covers `b7966a0` exactly, predates this
   repair, and is not evidence for this candidate.

The second requirement above — the fresh independent security review of the DUR-001 contract repair —
was **closed on 2026-11-12**: the focused repair review closed every finding, and the repair is
**ACCEPTED** against the exact candidate digests recorded above. The decision record's contract
text is unchanged and is not amended by the acceptance. The acceptance is scoped to the focused
snapshot identity repair and is not a new audit of every completed phase.

After the hosted run, the checklist can be re-marked against the new candidate's own evidence and the
verdict moved to READY. Tagging, publication and deployment remain separate decisions that this record does
not authorize. A later tagging decision must also settle the pre-existing local `v1.0.0` tag
described in the verdict, since the version stays 1.0.0 for REL-001.
