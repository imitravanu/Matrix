# Full local engineering verification — 2026-11-01

Candidate: working tree over `e1b3c66`. Runtime/test/config SHA-256:
`8ccc334a42a1fc64cf78ccd5f4513cbd01a0bcc5ff9c2c369d1eee1494b2f224`.
The same 22-file identity as check 5: sorted path + NUL + raw bytes + NUL, excluding
planning/docs. No source, dependencies or lockfile changed for this verification.
Node 22.23.4 was obtained in a temporary directory, with PATH explicitly set and the
actual runtime version checked; default system runtime is Node 24.21.0.

## Results

| Check                                                          | Node 24.21.0                               | Node 22.23.4                               |
| -------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| Engineering gate (syntax/lint/typecheck/format/tests/coverage) | PASS: 647 tests, no failures/skips         | PASS: 647 tests, no failures/skips         |
| Standalone suite with hostile provider environment             | PASS: 647 tests, no failures/skips         | PASS: 647 tests, no failures/skips         |
| Offline evaluation                                             | PASS: 16 contracts, zero safety violations | PASS: 16 contracts, zero safety violations |
| Responsive UI smoke                                            | PASS: 32 frames, four geometries           | PASS: 32 frames, four geometries           |
| Package dry-run check                                          | PASS: 86 files                             | PASS: 86 files                             |
| Local benchmarks                                               | PASS: functional checks and cleanup        | PASS: one-iteration smoke and cleanup      |

Node 24 engineering coverage: 93.94% lines, 83.65% branches, 94.45% functions.
Node 22 engineering coverage: 94.00% lines, 83.36% branches, 94.50% functions.
Both engineering runs exited 0; npm version was 12.2.0.
Evaluation includes expected denied/failed scenarios: all 16 contracts pass, not all
16 coding tasks succeed. Neither evaluation uses live model inference.

The initial Node 22 engineering process disappeared before a final summary; it is not
counted as passing. The separate final rerun completed with exit 0 and 647 tests passed, zero failures/skips.
Hostile-environment checks used fake credentials and loopback port 9 endpoints only.
Packaging remained a dry run; nothing was published.

## Dependency-audit finding

`npm audit --json` exits 1: five moderate findings, zero high or critical. Affected
packages are minimatch, eslint, @eslint/js, @eslint/config-array and
@eslint-community/eslint-utils. These are related dependency-chain findings, not five
independent vulnerabilities. The direct advisory is minimatch globparts amplification
potential denial of service, GHSA-g3hv-75wg-m249. The installed lint dependency chain is
affected; npm's suggested automatic changes include major-version downgrades and were
not applied during verification.

`npm audit --omit=dev --json` exits 0 with zero production dependency findings.
This narrows exposure to the development dependency graph; it does not turn the full
audit into a pass. Resolve the lint dependency chain in a separately reviewed change
before declaring the release gate green. Dependency repair was not performed as part of this verification.

## Environment and acceptance limits

Doctor: 12 checks OK, 4 terminal/display warnings, 0 failures. Its actual Linux namespace /
snapshot probe passed. The warnings reflect a noninteractive tool terminal, not failures
of sandbox isolation. No live provider was contacted or credential value printed.

This verifies the existing working checkout/dependency installation. It is not a fresh
`npm ci` clean-checkout release reproduction and does not establish hosted CI. The
repository's release policy requires those separately. No commit, tag, publication or
live-model quality claim follows from these local results.

The provider phase still lacks management commands, TUI provider selection, saved
provider/configuration binding, compatibility probes and complete end-to-end acceptance.
Passing local tests closes engineering checks on delivered code, not missing product work.

## Final verdict

Local Node 22/24 engineering and behavioral checks pass on this candidate. The full
dependency audit fails with five moderate development-chain findings; production audit
is clean. Provider-phase and release acceptance are not granted for the reasons above.
