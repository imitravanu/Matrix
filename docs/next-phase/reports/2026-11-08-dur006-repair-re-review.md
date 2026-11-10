# Independent Re-Review: DUR-006 repairs (Findings 1 and 2)

- **Date:** 2026-11-08
- **Task:** `DUR-006` — CLI and user-visible continuation, repair re-review
- **Repository:** `/home/mitravanu/matrix`
- **Base Git commit (`HEAD`):** `ff55a2c2aaeb863e881a5a8d0e112eb78ded0204`
- **DUR-006 14-file candidate SHA-256:** `0665e76f365fdc344d5671d71a6fd429ffe9d2d28d224b335482cafd8b3ee79a`
- **Accepted DUR-005 23-file runtime SHA-256:** `17c6992a5a507b301d3297f69ce598cdf0046ef0078081d8f4b5e15a032aea02`
- **Verdict:** **`CHANGES REQUIRED`** for one new credential-disclosure finding in the
  repair's recorded-workspace guidance. Both original findings are otherwise closed.

---

## 1. Executive summary

Both fingerprints match the submission exactly: the 14-file candidate starts
`0665e76f365f` and the accepted DUR-005 23-file runtime is
`17c6992a5a50…`. The recorded `npm run check` evidence — **1,031 tests on Node
22.23.1 and 1,031 on Node 24.21.0** — is therefore reused as recorded and was
not re-run. The other recorded engineering gates (`eval`, `smoke`,
`pack:check`) are likewise reused. Only independent harness evidence was added.

The two repaired behaviors are verified with independent subprocesses, real
PTYs, temporary homes/workspaces and fake credentials:

1. **Finding 1 (workspace-mismatch guidance): fixed for the reported behavior.**
   From a foreign directory, `inspect` names the recorded workspace and prints
   `matrix goal resume <id> --cwd '<recorded path>'`; pasting that command works.
   A moved directory (same device/inode) is listed and resumable from its new
   location. A replacement at the recorded path is described as missing or
   replaced, the continuation is inspect-only, and no printed `resume` command
   targets the replacement. Single-quote paths survive shell parsing and are
   usable. A path containing a normal fake credential is redacted and loses its
   `--cwd` suffix. A live owner inspected from a foreign directory yields a
   working `matrix goal pause <id> --cwd '<recorded>'` continuation.
2. **Finding 2 (stale-owner control refusal): fixed.** `pause` and `cancel`
   against a killed owner exit `2`, report `result: "refused"`, and name both
   `matrix goal resume <id>` and `matrix goal inspect <id>` in JSON and terminal
   output. `checkpoint.json` and `journal.jsonl` stayed byte-identical across all
   four invocations, and a real unrelated `sleep` sentinel was never signalled.
   A forged lease naming a live unrelated pid (wrong start time) is refused
   identically; a forged lease with the sentinel's correct pid/start time still
   exits `2` with inspect guidance; state stayed byte-identical in both cases.

One new defect remains in the repair's own redaction claim:

> **R1 (`P2`, security, narrow trigger): the new recorded-path guidance can
> print the provider credential.** `workspaceMismatchReason` shell-quotes the
> recorded path _before_ the redactor runs, so a credential containing `'` is
> printed in reversible `'"'"'` form in JSON and terminal output. Separately,
> `inspect`/refusal redaction is built only from environment variables whose
> names look sensitive; a provider whose `auth.env` is another valid name
> (e.g. `FOO`) is printed verbatim in the reason, `nextCommand`, and the
> `resume` refusal. The loopback fixture proves the printed value is the actual
> `Authorization: Bearer` value.

Because printing a credential violates the repository invariant and the
submission's explicit "a path containing the credential is redacted and never
printed" claim, the repair cannot be accepted as written. The original Finding 1
guidance logic and Finding 2 are otherwise correct.

---

## 2. Candidate identity

Commands run from `/home/mitravanu/matrix`; the 14-file list and order are the
submission's.

```sh
git rev-parse HEAD
# ff55a2c2aaeb863e881a5a8d0e112eb78ded0204
git diff --check
# exit 0, no output

{
  for f in MATRIX.md README.md bin/matrix.mjs lib/cli.mjs lib/goal-cli.mjs \
    lib/goal-control.mjs lib/goal-engine.mjs lib/goal-human-review.mjs \
    src/goal-app.mjs src/goal-screen.mjs src/screens/goal.mjs \
    test/goal-app.test.mjs test/goal-cli-runtime.test.mjs test/goal-cli.test.mjs; do
    printf '%s\0' "$f"; cat "$f"
  done
} | sha256sum
# 0665e76f365fdc344d5671d71a6fd429ffe9d2d28d224b335482cafd8b3ee79a  -
```

The accepted DUR-005 23-file list from
[`DUR-005.md`](../submissions/DUR-005.md) and the review appendix recomputes to
`17c6992a5a507b301d3297f69ce598cdf0046ef0078081d8f4b5e15a032aea02`.

| Check                       | Observed                                                           | Matches          |
| --------------------------- | ------------------------------------------------------------------ | ---------------- |
| Base commit                 | `ff55a2c2aaeb863e881a5a8d0e112eb78ded0204`                         | Submission       |
| 14-file candidate aggregate | `0665e76f365fdc344d5671d71a6fd429ffe9d2d28d224b335482cafd8b3ee79a` | Submission       |
| 23-file DUR-005 runtime     | `17c6992a5a507b301d3297f69ce598cdf0046ef0078081d8f4b5e15a032aea02` | Accepted DUR-005 |
| `git diff --check`          | exit `0`, no output                                                | Clean            |

### 2.1 Scope of the repair relative to the reviewed candidate

Comparing per-file hashes with the reviewed candidate
`41033efb9219d7ef57749dc16d11d4476a2f7e7dc5354dda8e35b837d4446fb1`
shows exactly two changed files; the other twelve hashes are unchanged,
including `lib/goal-control.mjs` (`3581817e…`), which confirms Finding 2 was
fixed in the CLI mapping rather than by changing lease verification.

| File                             | Reviewed SHA-256                                                   | Current SHA-256                                                    | Changed |
| -------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------- |
| `MATRIX.md`                      | `f1d8b51555a395c5f58d02a13c03624bd9e1ad3b1f2c5fe62a2170202ea5f72d` | same                                                               | no      |
| `README.md`                      | `85a2b9c99b1872e0825b1aff8d508180122245c2e233e676bc7fb118258be778` | same                                                               | no      |
| `bin/matrix.mjs`                 | `580bdbf2d6bd2c39be6cdbad21e447caf2b6d4329648679fdfd8aec600f2965b` | same                                                               | no      |
| `lib/cli.mjs`                    | `e86dbe171ee9d835d2a5b134001100e87d8cfa97966226cadc5f580d414825dc` | same                                                               | no      |
| `lib/goal-cli.mjs`               | `fea29921d08d7b4e00783600c5ed5ca2e6ba1d1145f4bc55f668863ae7101e51` | `e0e268512813c594b8eb85e12c1a649dfc1b20cb302e62031ff2fe2c5b855967` | **yes** |
| `lib/goal-control.mjs`           | `3581817edf7fdffccba393da5f4723ecf94be71037173fe37faf7d883e8566e4` | same                                                               | no      |
| `lib/goal-engine.mjs`            | `4015aea01c371be8949930e690917be35620ff1e8341c3683067fccc45345c28` | same                                                               | no      |
| `lib/goal-human-review.mjs`      | `af71a783232f1e3003f66204fafcb8049efa47fa1ae9ac7be032663ba9cab484` | same                                                               | no      |
| `src/goal-app.mjs`               | `5b2aad035107d2681010a3d23a0441be02cca59ebbffc16ce3829acba330e97d` | same                                                               | no      |
| `src/goal-screen.mjs`            | `43ef317cd7561c49f6538bcd7523fdb413a50384574be5617e913ed45f30a8a8` | same                                                               | no      |
| `src/screens/goal.mjs`           | `aa0a6d296bf2be1c6634f0819499fb46ca9289b9bd356ad9ef58a6ada351f318` | same                                                               | no      |
| `test/goal-app.test.mjs`         | `9bbd9646b1aaa0e3c8b5964dd107f706111f0da2147a4e8c8b5f77454191524a` | same                                                               | no      |
| `test/goal-cli-runtime.test.mjs` | `23357f23273051da9ec5175e25c1a9d2747a4e92b97c2b539c3d508b329278ee` | same                                                               | no      |
| `test/goal-cli.test.mjs`         | `abd11c0bcee8d6dd4ad2c4a915a287acef4144887187f27d73d71422b70bdb9b` | `8628079251446e8aaad29a82de073ebb16e2d1f9ad84fa3227ce369e83126454` | **yes** |

Only the report file was added to the working tree by this review. All
temporary fixtures are outside the repository under
`/tmp/dur006-rereview*`; implementation files, `docs/next-phase/STATUS.md`,
host settings and Git history were left untouched.

---

## 3. Reused versus new evidence

| Evidence                                                       | Source                              | Status                                                         |
| -------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| `npm run check`, 1,031 tests on Node `v22.23.1` and `v24.21.0` | submission, both fingerprints match | **Reused (not re-run)**                                        |
| `npm run eval` 16/16, `npm run smoke` 32 frames, `pack:check`  | submission, fingerprints match      | **Reused (not re-run)**                                        |
| Targeted DUR-006 suites                                        | submission                          | **Reused (not re-run)**                                        |
| DUR-005 23-file runtime behavior                               | accepted DUR-005 submission/reports | **Reused**; fingerprint re-derived                             |
| 59-check repair harness (scenarios A–H and F)                  | this review                         | **New**: 57 passed, 2 failed (both R1 quote credential)        |
| Standalone credential-disclosure reproduction                  | this review                         | **New**: both R1 mechanisms reproduced with real bearer values |

The recorded test count changed from the previous review's 1,027 to 1,031 for
this repair candidate. Because the candidate fingerprint matches the submission
and both runtimes' 1,031-test evidence is bound to that fingerprint, the task
instruction to reuse the recorded results was followed. No full suite, targeted
author suite, evaluation, smoke or pack check was re-run.

---

## 4. Method and fixtures

Independent scripts live outside the repository at
`/tmp/dur006-rereview/harness.mjs` and
`/tmp/dur006-rereview/repro-redaction.mjs`. They drive the real
`bin/matrix.mjs` as a subprocess and never import the implementation under
test except the canonical JSON encoder used to construct a private forged
checkpoint fixture.

- One private temporary `MATRIX_HOME` per harness run (`0700`;
  `providers.json` `0600`).
- One temporary workspace per scenario (`0700`); foreign directories are
  separate temp directories with different device/inode.
- A fake bearer value (`q7zk3x9pw2mf4t`) exported only through the provider's
  `STUB_KEY` environment reference; a second fixture used a quote-bearing fake
  value; a third used an ordinary value under an `auth.env` named `FOO`.
- A loopback HTTP provider in the review's own process records the actual
  `Authorization` header; it is used only for the credential proof. The normal
  `stub` profile points at a closed loopback port to produce an honest failed
  provider operation without egress.
- Real PTYs through `script -qec` for terminal output (the terminal path appends
  the complete, unwrapped `Reason:` and `Next command:` lines).
- Real `/proc/<pid>/stat` identities and real `SIGKILL` for owner death.
- A real unrelated `/bin/sleep 300` process as a signalling sentinel, with its
  pid and `/proc` start time observed before and after every control request.
- A forged lease is written only to the temporary checkpoint using the
  repository's canonical JSON encoder and recomputed checksum; the store's
  validation still accepts the record and is exercised by every subsequent
  command. No runtime code was modified.
- All state-preservation comparisons cover every file in the goal directory,
  including `checkpoint.json`, `journal.jsonl` and any previous checkpoint, with
  byte length, SHA-256, mode, mtime and ctime.

---

## 5. Finding 1 re-review — workspace-mismatch guidance

The repaired projection is in
[`lib/goal-cli.mjs:89-121`](../../../lib/goal-cli.mjs#L89-L121) and
[`lib/goal-cli.mjs:211-221`](../../../lib/goal-cli.mjs#L211-L221); the `resume`
refusal is at [`lib/goal-cli.mjs:290-293`](../../../lib/goal-cli.mjs#L290-L293).

### 5.1 Scenario A — recorded path intact, caller in a foreign directory

| #   | Observation                                                                                                                                                                                                  | Result |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 1   | `goal inspect <id> --json` from a foreign directory exits `0`.                                                                                                                                               | PASS   |
| 2   | JSON `reason` is `This goal belongs to the recorded workspace '<recorded>'. Run the printed command from that directory.`                                                                                    | PASS   |
| 3   | JSON `nextCommand` is exactly `matrix goal resume <id> --cwd '<recorded>'`.                                                                                                                                  | PASS   |
| 4   | Real-PTY terminal output contains the same reason and the complete unwrapped `Next command: matrix goal resume <id> --cwd '<recorded>'`.                                                                     | PASS   |
| 5   | `goal resume <id> --json` from the foreign directory exits `2`, `result: "refused"`, and its reason embeds the same `run from the recorded workspace: matrix goal resume <id> --cwd '<recorded>'`.           | PASS   |
| 6   | Pasting the JSON `nextCommand` through bash exits `1` (incomplete work), prints `Goal resumed and stopped` and `Goal <id>`, and advances `generation 1 → 2`; it is not a usage error or a workspace refusal. | PASS   |

Observed command:

```text
matrix goal resume goal_69e515e4a3a14c75942f60380bf5b97b --cwd '/tmp/dur006-rereview-8pZ9Y3/a/work'
```

### 5.2 Scenario B — directory moved (identity preserved)

The recorded workspace was renamed within the same filesystem after the goal
started, so the recorded path is missing but the moved directory has the same
device/inode.

| #   | Observation                                                                                                                                                                    | Result |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 1   | Foreign `inspect` reports the recorded path as `missing or has been replaced`.                                                                                                 | PASS   |
| 2   | `nextCommand` is exactly `matrix goal inspect <id>`; it has no `--cwd` and does not name the moved directory.                                                                  | PASS   |
| 3   | Real-PTY terminal output matches the JSON guidance.                                                                                                                            | PASS   |
| 4   | `goal list --json` from the moved directory lists the goal.                                                                                                                    | PASS   |
| 5   | `goal resume <id> --yes --json` from the moved directory is admitted: exit `1`, `goalId` matches, provider failure is reported honestly.                                       | PASS   |
| 6   | Foreign `resume` exits `2` and explains how to locate the moved directory with `matrix goal list --cwd <new directory>`; it does not print a `--cwd` resume at the moved path. | PASS   |

### 5.3 Scenario C — recorded path replaced by a different directory

| #   | Observation                                                                                                                                                  | Result |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 1   | The replacement is reported as `missing or has been replaced`, naming the recorded path.                                                                     | PASS   |
| 2   | `nextCommand` is inspect-only.                                                                                                                               | PASS   |
| 3   | No printed `matrix goal resume …` command contains the replacement path or a `--cwd` argument.                                                               | PASS   |
| 4   | `goal resume <id>` in the replacement exits `2`, `result: "refused"`, with the restore/locate guidance and `Resuming in a replacement directory is refused`. | PASS   |
| 5   | `goal list --json` in the replacement returns no goals.                                                                                                      | PASS   |
| 6   | The original directory at its moved location still resumes (same identity), exit `1`.                                                                        | PASS   |

### 5.4 Scenario D — single quote in the recorded path

| #   | Observation                                                                                                               | Result |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | The printed quoted path parses through `bash -c "printf '%s' <quoted>"` to exactly the recorded path as one argument.     | PASS   |
| 2   | Pasting the full `nextCommand` through bash exits `1`, prints `Goal <id>`, and is not a workspace refusal or usage error. | PASS   |

Observed quoted form:

```text
'/tmp/dur006-rereview-8pZ9Y3/d/work'"'"'space'
```

### 5.5 Scenario E — recorded path contains a normal fake credential

| #   | Observation                                                                                   | Result |
| --- | --------------------------------------------------------------------------------------------- | ------ |
| 1   | JSON inspect never contains the raw credential; the reason shows `cred-[redacted]`.           | PASS   |
| 2   | JSON `nextCommand` drops the unshowable `--cwd` suffix and remains `matrix goal resume <id>`. | PASS   |
| 3   | Real-PTY terminal output also shows `[redacted]` and keeps a `Next command:` line.            | PASS   |
| 4   | Foreign `resume` exits `2`, keeps the reason visible, and never prints the credential.        | PASS   |

### 5.6 Scenario H — live owner, foreign caller, pause continuation

| #   | Observation                                                                                                 | Result |
| --- | ----------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Foreign `inspect` shows `ownerAlive: true` and `nextCommand === matrix goal pause <id> --cwd '<recorded>'`. | PASS   |
| 2   | Pasting that command reaches the live control socket: exit `0`, output `pause requested`.                   | PASS   |
| 3   | The goal state becomes `paused` after the continuation.                                                     | PASS   |

### 5.7 Scenario G / R1 — credential redaction is not reliable

This is the one failing area. The projection calls
`plainText(workspaceMismatchReason(recorded), redactor, 512, true)`.
`workspaceMismatchReason` builds the path with `shellQuote(recorded.path)`
first; the trusted redactor runs afterward. A single quote inside the credential
is therefore split into the shell-quote sequence `'"'"'`, and the raw credential
is no longer a substring for the redactor to replace. The same function is
reached from JSON and terminal `inspect`.

**Reproduction (b): sensitive env name, credential contains `'`.**

```sh
# Same temporary-home/workspace fixture as scenario E, with:
#   auth.env = STUB_KEY
#   STUB_KEY = "q7z'k3x9pw2mf4t"
#   workspace = "$BASE/ws-q7z'k3x9pw2mf4t"
MATRIX_HOME=$H STUB_KEY="q7z'k3x9pw2mf4t" node bin/matrix.mjs \
  goal inspect "$ID" --json -C "$OTHER"
```

Observed:

```text
{"schemaVersion":1,"goalId":"goal_131a…","state":"needs-attention",…
 "reason":"This goal belongs to the recorded workspace
   '/tmp/…/ws-q7z'\"'\"'k3x9pw2mf4t'. Run the printed command from that directory.",
 "nextCommand":"matrix goal resume goal_131a…"}
```

The terminal path prints the same line without JSON escaping. Reversing the
shell quoting (`'"'"'` → `'`) yields the exact bearer value; the loopback
fixture recorded `Authorization: Bearer q7z'k3x9pw2mf4t`. `nextCommand` itself
correctly drops `--cwd`, but the reason still discloses the credential. This is
a direct consequence of redacting after shell quoting and is introduced by the
repair's new path text.

**Reproduction (a): ordinary credential under a non-sensitive env name.**

```sh
# providers.json auth.env = "FOO"; FOO = "n4m3l3ssV4lu3"
# workspace = "$BASE/ws-n4m3l3ssV4lu3"
MATRIX_HOME=$H FOO=n4m3l3ssV4lu3 node bin/matrix.mjs \
  goal inspect "$ID" --json -C "$OTHER"
MATRIX_HOME=$H FOO=n4m3l3ssV4lu3 node bin/matrix.mjs \
  goal resume "$ID" --json -C "$OTHER"
```

Observed:

```text
bearer sent: Bearer n4m3l3ssV4lu3
inspect reason: This goal belongs to the recorded workspace
  '/tmp/…/ws-n4m3l3ssV4lu3'. Run the printed command from that directory.
inspect nextCommand: matrix goal resume goal_17c6… --cwd '/tmp/…/ws-n4m3l3ssV4lu3'
resume status: 2
resume reason: current workspace does not match the recorded goal; run from the
  recorded workspace: matrix goal resume goal_17c6… --cwd '/tmp/…/ws-n4m3l3ssV4lu3'
credential present in inspect JSON: true
credential present in resume JSON: true
```

Here `inspect` and the `resume` refusal construct their redactor with
`createRedactor()` before any provider binding
([`lib/goal-cli.mjs:246`](../../../lib/goal-cli.mjs#L246)). The redactor only
collects environment values whose names match its sensitive-name heuristic, so
a valid provider profile whose `auth.env` is `FOO` is unknown to it. This is a
related limitation of the new path disclosure; it is reachable through the
public CLI and prints the actual credential the provider transport sends.

**Consequence.** The repair's statement "a path containing the credential is
redacted and never printed" is false in two independently reachable ways. JSON
and terminal output disclose the credential; the `inspect` command is read-only
but its output can be copied into logs or transcripts. The DUR-006 requirement
"Use bounded, redacted JSON" and `AGENTS.md`'s "Do not print, copy, or commit
credentials" are not met for these inputs.

**Required behavior.** Redact the raw recorded path before shell-quoting it for
display, or replace it with a bounded placeholder when redaction changes it;
never interpolate the quoted form before redaction. For the read-only/refusal
paths, resolve the saved provider's `auth.env` (or its credential) when
constructing the redactor, or otherwise narrow the claim and test the actual
boundary. Add regressions for a quote-bearing credential and for a
non-sensitive env name, asserting that the raw value is absent from JSON and
terminal output and that the guidance remains visible.

### 5.8 Non-finding — piped terminal wrapping

When stdout is a pipe, `renderGoalStatus` wraps the long `Next command:` line;
this is why a naive pipe capture shows a line break before `--cwd`. A real PTY
uses `renderGoalApp`, which appends the complete unwrapped reason and command
after the frame; the PTY check confirms the full command is copyable. The
wrapping is not counted as a finding.

---

## 6. Finding 2 re-review — stale and mismatched owners

The repair maps both refusal branches to the invalid-request class at
[`lib/goal-cli.mjs:298-307`](../../../lib/goal-cli.mjs#L298-L307);
`lib/goal-control.mjs` is byte-identical to the reviewed candidate, so lease
verification and the live socket path are unchanged.

### 6.1 Dead owner

Fixture: a hanging loopback provider kept a real owner live; the harness waited
for a persisted lease, then `SIGKILL`ed the owner and verified the pid was gone.

| #   | Observation                                                                                                                                                                                        | Result |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | `goal pause <id> --json` after the kill exits `2`, `result: "refused"`, reason `the goal has no verified live owner; use matrix goal resume <id> to verify recovery, or matrix goal inspect <id>`. | PASS   |
| 2   | `goal cancel <id> --json` produces the same result and guidance.                                                                                                                                   | PASS   |
| 3   | `goal pause <id>` (terminal) exits `2`, writes nothing to stdout, and puts the same guidance on stderr as `matrix goal: …`.                                                                        | PASS   |
| 4   | `goal cancel <id>` (terminal) behaves identically.                                                                                                                                                 | PASS   |
| 5   | After all four invocations every file in the goal directory is byte-identical: same length, SHA-256, mode, mtime and ctime for `checkpoint.json`, `journal.jsonl` and any other state file.        | PASS   |
| 6   | The unrelated `/bin/sleep 300` sentinel is still alive; no signal reached it.                                                                                                                      | PASS   |

### 6.2 Forged lease naming a live unrelated process

The private temporary checkpoint was rewritten with the sentinel's pid and a
different start time, then re-encoded with the repository canonical encoder and
a fresh checksum. `goal inspect` accepted the record (exit `0`).

| #   | Observation                                                                                                                                                                                                                                   | Result |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | `goal pause --json` exits `2`, `result: "refused"`, same "no verified live owner" reason and both recovery commands.                                                                                                                          | PASS   |
| 2   | `goal cancel --json` is identical.                                                                                                                                                                                                            | PASS   |
| 3   | The goal directory is byte-identical after each request.                                                                                                                                                                                      | PASS   |
| 4   | The sentinel is still alive after both requests.                                                                                                                                                                                              | PASS   |
| 5   | With the sentinel's correct pid and start time (identity check passes, but no control socket exists for it), both commands still exit `2` with `result: "refused"` and `use matrix goal inspect <id> to see the current attempt, then retry`. | PASS   |
| 6   | The goal directory is byte-identical after the matching-pid requests.                                                                                                                                                                         | PASS   |
| 7   | The sentinel is still alive and its `/proc` start time is unchanged.                                                                                                                                                                          | PASS   |

The forged matching-pid message includes the internal `/proc/self/fd/…/<hash>.sock`
path from the connect failure; it contains no credential and is bounded to 160
characters. The actionable path for the user is the named `inspect` command;
this is acceptable for a forged lease that cannot be a verified live owner.

---

## 7. Findings and disposition

### R1 — Recorded-workspace guidance can disclose the provider credential (`P2`, security)

- **Location:** [`lib/goal-cli.mjs:116-121`](../../../lib/goal-cli.mjs#L116-L121)
  (quote before redaction in `workspaceMismatchReason`),
  [`lib/goal-cli.mjs:217-221`](../../../lib/goal-cli.mjs#L217-L221)
  (reason/nextCommand projection), and
  [`lib/goal-cli.mjs:246`](../../../lib/goal-cli.mjs#L246) (env-only redactor for
  `inspect` and the pre-binding mismatch refusal).
- **Trigger:** a goal whose recorded workspace path contains its provider
  credential, and either (a) the credential contains a single quote, or (b) the
  provider's `auth.env` name is not matched by the sensitive-name heuristic
  (for example `FOO`).
- **Impact:** the actual bearer credential is printed in `inspect` JSON, real-PTY
  terminal output, and the foreign `resume` refusal; it can be copied into logs
  and transcripts. Read-only inspection does not mutate state, but the
  disclosure persists in the output.
- **Requested fix:** redact the raw path before shell-quoting or skip the path
  when redaction changes it; make the inspect/refusal redactor aware of the
  saved provider's credential/env name. Add regressions asserting the raw value
  is absent while the reason remains visible and a usable continuation is still
  produced when no credential is involved.
- **Acceptance proof:** the same fixtures with `STUB_KEY`/quote and `FOO`/
  ordinary values must produce `[redacted]` (or omit the path) in JSON and PTY
  output, with no recoverable encoding, no credential in `nextCommand`, and the
  existing A–H scenarios still passing.

| #   | Finding from prior review                                       | Disposition                                                                                               |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | Workspace-mismatch recovery guidance circular/misleading (`P2`) | **CLOSED** for the reported behavior (A–D, H); the repair's additional redaction claim fails as R1.       |
| 2   | Stale-owner control refusal exit code and guidance (`P3`)       | **CLOSED** (dead, mismatched and forged owners all exit `2` with guidance; state and sentinel preserved). |
| R1  | New credential disclosure in recorded-workspace guidance (`P2`) | **OPEN** — blocks acceptance.                                                                             |

### Verdict

**`CHANGES REQUIRED`** for R1. The two original findings are behaviorally fixed,
but the repair's new recorded-path disclosure prints the provider credential in
two reachable configurations, which violates the repository's credential
invariant and the submission's explicit redaction claim. Re-run the A–H
harness, the R1 redaction repro, and the recorded Node 22/24 gates after the
fix; the current 1,031-test evidence is valid only for this candidate.

---

## 8. Scope limits

- **Reused, not repeated:** the full `npm run check` (1,031 tests) on Node
  `v22.23.1` and `v24.21.0`, `npm run eval`, `npm run smoke`, `npm run
pack:check`, and the author's targeted DUR-006 suites. Only independent
  harnesses were run here; the current host Node is `v24.21.0`.
- **Not evaluated:** the contained `--allow-tests`/Bubblewrap/pidfd runner, UI
  React frame content beyond the PTY reason/next-command lines, reduced-motion
  and screen-reader paths, non-Linux hosts, physical power loss, live provider
  quality/cost, and the full QA-101 adversarial matrix.
- **Fixture limits:** the credential-in-path scenarios are synthetic (a
  workspace directory named after a fake bearer value). They are included
  because the submission explicitly claims that case and the repair test suite
  seeds it; the quote-bearing and non-sensitive-env-name variants are
  additionally adversarial. The real bearer value is only a fake loopback
  credential; no real key or network egress was used.
- **Host load:** no unrelated process was signalled; the sentinel and its
  `/proc` identity were checked after every control request. The hang server
  and sentinel were terminated and temporary directories removed except the
  evidence directory retained for this report.

---

## Appendix A — Key commands

```sh
cd /home/mitravanu/matrix
git rev-parse HEAD                     # ff55a2c2aaeb863e881a5a8d0e112eb78ded0204
git diff --check                       # exit 0

# 14-file candidate (list/order from the submission)
{
  for f in MATRIX.md README.md bin/matrix.mjs lib/cli.mjs lib/goal-cli.mjs \
    lib/goal-control.mjs lib/goal-engine.mjs lib/goal-human-review.mjs \
    src/goal-app.mjs src/goal-screen.mjs src/screens/goal.mjs \
    test/goal-app.test.mjs test/goal-cli-runtime.test.mjs test/goal-cli.test.mjs; do
    printf '%s\0' "$f"; cat "$f"
  done
} | sha256sum                          # 0665e76f365f…

# 23-file accepted DUR-005 runtime (list in docs/next-phase/submissions/DUR-005.md)
# → 17c6992a5a507b301d3297f69ce598cdf0046ef0078081d8f4b5e15a032aea02

# Independent harness
KEEP=1 node /tmp/dur006-rereview/harness.mjs
# 57/59 checks passed; the two failures are the R1 quote-credential checks.

# Independent redaction reproduction
node /tmp/dur006-rereview/repro-redaction.mjs
```

## Appendix B — Harness result summary

```text
PASS A: inspect/resume continuation names the recorded workspace and works when pasted
PASS B: moved directory is listed and resumable from its new location
PASS C: replacement is never a resume target; resume is refused with restore guidance
PASS D: single-quote path survives shell parsing and the pasted command acts on the goal
PASS E: ordinary credential in the path is redacted and loses --cwd
PASS H: live-owner pause continuation from a foreign directory reaches the owner
FAIL G: quote-bearing credential is recoverable from JSON guidance
FAIL G: quote-bearing credential is recoverable from terminal guidance
PASS F: dead-owner pause/cancel exit 2 with recovery guidance (JSON and terminal)
PASS F: checkpoint/journal byte-identical after all dead-owner control requests
PASS F: unrelated sentinel survives every control request
PASS F: forged wrong-start-time owner is refused identically, state byte-identical
PASS F: forged matching-pid owner still exits 2 with inspect guidance, state byte-identical
PASS F: sentinel unchanged after forged control requests

SUMMARY 57/59 passed; 2 failed
```

The separate redaction reproduction additionally shows the `FOO` env-name case:
`credential present in inspect JSON: true` and `credential present in resume
JSON: true`, with the loopback server recording `Bearer n4m3l3ssV4lu3`.

## Appendix C — Verdict

**`CHANGES REQUIRED`** — R1 (`P2`, credential disclosure in the new
recorded-workspace guidance, two mechanisms). Finding 1's guidance behavior and
Finding 2's control behavior are independently verified fixed; the credential
redaction claim must be repaired before acceptance.
