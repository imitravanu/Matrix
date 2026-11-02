# Evaluator scoring repair — 2026-11-02

Implementer repair submission; independent acceptance remains open.
Base HEAD: `e1b3c66`. Candidate runtime/test/config fingerprint:
`f54ce83fcff21ae65168dd5b21d45c872d448933632f605d25915fe51859e763`.
The 51-file fingerprint uses the integration report's sorted-path/NUL/raw-bytes
procedure and excludes shared documentation. The Node 22 comparison copy matches.

## Behavior repaired

The pure-function gate now uses a null-prototype context, removes its default
console, denies runtime code generation and imports, and marshals results to a
primitive string under the VM deadline. Its assertion harness receives parsed
values rather than objects whose getters execute in the host realm.

Both fixture verification and behavioral verification require a random per-run
completion receipt emitted only after all assertions. An aggregate test count or
zero exit status without that receipt fails. The report preserves the two
verification results and requires both for task success. The task revision is v4.
This is a scoring boundary for the pure-function fixture, not a general security
sandbox for arbitrary Node programs or the ordinary coding/test run.

## Evidence

- Original VM-constructor escape: taskSuccess false on Node 22 and Node 24;
  original early exit and forged TAP also fail.
- Correct alternatives using `items.slice()` and `[...items]` pass.
- Dynamic-import error constructor, object constructor, hostile returned proxy,
  and non-array JSON conversion attempts fail. The hostile serialization case is
  tested directly within a bounded verification rather than spending a complete
  coding-run timeout.
- Credential and cancellation regressions remain included in the offline suite.
- Node 24.21.0: full `npm run check` passes 746 tests, no failures or skips;
  log `/tmp/matrix-final-repair24.log`.
- Node 22.23.4: full `npm run check` passes 746 tests, no failures or skips;
  log `/tmp/matrix-final-repair22.log` from the matching source copy.
- Default offline evaluation and package checks pass on both runtimes; logs
  `/tmp/matrix-final-repair-eval24.log`, `/tmp/matrix-final-repair-eval22.log`,
  `/tmp/matrix-final-repair-pack24.log`, `/tmp/matrix-final-repair-pack22.log`.

No real credentials or paid calls were used, no test/coverage thresholds were
lowered, and no Git history or publication action was performed. This submission
addresses the reproduced scoring findings; it does not close the full PRV-106
adversarial matrix or PRV-107 acceptance.
