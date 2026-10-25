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

The top-level `test/`, `bench/`, and `scripts/` trees, CI and development configuration, planning docs,
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

- [ ] Install exactly from the lockfile with `npm ci`; do not use an existing `node_modules` as evidence.
- [ ] Run `npm run check` successfully (syntax, lint, JSDoc typecheck, formatting, full tests, and
      coverage ratchets).
- [ ] Run `npm test` successfully as the standalone network-free suite.
- [ ] Run `npm run smoke` and require all responsive frame checks to pass.
- [ ] Run `npm run bench` and require all ordinary local benchmark cases to complete cleanly. Treat
      timings as local references, not portable performance SLAs; use explicit stress runs separately.
- [ ] Run `npm run pack:check`. This invokes real `npm pack --dry-run --json` with lifecycle scripts
      disabled and a temporary pack destination, compares the complete file set with the source-backed
      allowlist, verifies private/main/bin posture and the executable bin, and fails on missing or
      unexpected files. It must neither create a tarball nor publish.
- [ ] Run `npm pack --dry-run --json` directly for the release record; inspect entry count, packed and
      unpacked sizes, `main`, and `bin`. Confirm no `.tgz` appears in the workspace. Dry-run success does
      not authorize publication.
- [ ] Run `npm audit` and resolve or explicitly document every finding before release. An earlier clean
      audit is not evidence for a changed lockfile.
- [ ] Require the hosted clean-checkout CI matrix to pass on **both Node.js 22 and Node.js 24**, including
      its normal and hostile-provider-environment gates, static/test checks, package inspection,
      dependency audit, smoke, and benchmark smoke.
      Local Node 22/24 results are useful but do **not** satisfy this hosted-CI gate. As of REL-001,
      hosted execution has not been verified and this item remains required.
- [ ] Review the final diff and run `git diff --check`; confirm version, changelog, license, pack size,
      and file list are intentional. Leave commits, tags, and publication to an explicit later decision.

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
