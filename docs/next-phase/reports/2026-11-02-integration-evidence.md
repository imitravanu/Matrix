# Provider integration evidence — 2026-11-02

This is an implementer/integrator submission, not an independent audit or an
acceptance decision. Base HEAD: `e1b3c66`; the working tree is uncommitted.
Runtime/test/config fingerprint:
`4d86da977a7eb9988abfcee448455b75220bafe71f4014a818a41e2e0b12e463`.
The fingerprint covers 51 changed/untracked files: sorted path + NUL + raw bytes

- NUL, excluding docs/, AGENTS.md, README.md, MATRIX.md and NEXT_PHASE.md.
  The Node 22 clean-install comparison copy contained byte-identical fingerprinted
  files. It is a disposable source copy, not a clean committed Git checkout.

## Real local provider workflow

`node docs/next-phase/fixtures/provider-p1-loopback.mjs` uses an isolated Matrix
home, copied workspaces, a real loopback HTTP server, and a fake bearer key. It
observed on both Node 24 and Node 22:

- Headless without edit approval: proposal denied, exact original file unchanged.
- Headless with `--yes` but without `--allow-tests`: edit applied; test execution
  denied by the separate trust gate.
- Interactive terminal: explicit patch approval, separate workspace/test-plan
  approvals, four real passing tests, and exact-byte undo of the applied edit.
- Six requests went to the selected loopback path with the exact mixed-case wire
  model ID and fake key. Captured output and files under the temporary Matrix home
  did not contain the fake key or its encoded forms.

The fixture cleans up its workspaces/server and does not contact a live service.
Logs: `/tmp/matrix-final-p1-24.log`, `/tmp/matrix-final-p1-22.log`. This is
integrator evidence, not an independent adversarial verdict or a claim about
model quality.

## Engineering checks

- Node 24.21.0, actual checkout: `npm run check`, 741 passed, 0 failed/skipped;
  log `/tmp/matrix-final-check24.log`.
- Node 22.23.4, matching source copy with a Node 22 `npm ci`: `npm run check`,
  741 passed, 0 failed/skipped; logs `/tmp/matrix-final-check22.log` and
  `/tmp/matrix-override-ci22.log`.
- Both Node versions: default `npm run eval` passed all 16 contracts and baseline;
  `npm run smoke` passed 32 frames; `npm run pack:check` passed 90 files. The
  Node 22 copy was made before the final README wording update.
- Linux sandbox: earlier targeted command suite passed 39 tests with no skips;
  actual workspace doctor reports sandbox available, 13 OK, 4 terminal-capability
  warnings and 0 failures (`/tmp/matrix-final-doctor.log`).
- Package audit: zero advisories after the development-only minimatch override
  (`/tmp/matrix-final-audit.log`). The override selects major 11 outside ESLint's
  declared major 10 range; clean installs, full checks on both Node versions,
  and 504 representative glob comparisons passed. Upstream compatibility remains
  a review consideration.
- Node 24 render benchmark completed previously with functional checks and cleanup
  passing; results are local reference measurements, not a performance claim.

The picker reload/save, empty-provider selection, exact-ID limit, active-run target
pinning, explicit session repair, headless session refusal, cache generation and
probe observation paths have targeted regressions included in the checks above.
No live model was called; availability and comparative model quality remain not
evaluated.

## Remaining acceptance work

The mandatory independent PRV-106 adversarial matrix and reviewer verdict remain
open. The external-edit cache stamp and crash/failure cases require independent
filesystem review. Hosted CI, a clean committed checkout and release-only gates
are not established by this report. The integrator cannot independently approve
its own implementation. No commit, push, package publication or deployment was
performed.
