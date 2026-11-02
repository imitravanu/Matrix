# Review method for Matrix agents

This is an executable review procedure, not a claim that following a checklist
proves correctness. Apply it to changed behavior and affected boundaries. It
supplements AUDIT.md and PROVIDER_AUDIT.md; their acceptance rules still apply.

## 1. Write the claim before inspecting the tests

Translate the requirement into an observable statement and a counterexample.
Avoid statements such as "validation exists" or "tests pass".

| Claim                                  | Counterexample to try                                                         | Evidence to capture                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Evaluation uses the original test      | Replace the assertion, replace package.json's test command, add a test loader | Original fixture hashes, actual command, actual test result, final verdict |
| Explicit credentials control execution | Give the explicit environment key A and process.env key B                     | Exact fake-server auth and destination on every request                    |
| Stream accumulation is bounded         | Send many individually valid fragments without DONE                           | Retained-byte bound, early refusal, reader cancellation, elapsed time      |
| Errors cannot disclose credentials     | Echo a canary in tool names, finish reasons, headers and error codes          | Returned JSON, formatted output, logs and persisted bytes                  |
| Tool compatibility is observed         | Ignore tools, repeat a call after its result, truncate the follow-up          | Request count, linked call ID, finish reason, verdict                      |
| Saved identity resumes exactly         | Use a remote model named local, two providers sharing an ID, an unlisted ID   | Actual destination/model after save/load and UI restoration                |
| Usage is honest                        | Omit one field or omit usage on one round                                     | Unknown fields remain unknown; partial sums explicitly labeled             |

These cases came from real Matrix review failures. A repair must address the
underlying claim, not only the exact input in the first reproduction.

## 2. Trace the complete path

Read from the user entry point through selection, configuration, controller,
agent, transport, effects, reporting and persistence. Record where values are
resolved, copied, rebound, truncated or discarded. Check every exposed entry
point affected by the change: CLI, UI, resume and programmatic callers.

For each important value, identify its authority. Examples: the selected target
controls routing; the bound credential controls requests; the original fixture
controls evaluation scoring; observed process evidence controls verification.
A report must describe the operation actually executed, not merely preflight.

Review adjacent dependencies. Protecting a test file does not protect its runner,
package scripts, imports, loader or test selection. A size check after reading
does not bound memory while reading. A sanitized transport error does not sanitize
a new error assembled from raw tool output.

## 3. Build a reproduction independent of the implementation

Use the public entry point and real downstream components where practical.
For provider cases, prefer a recording loopback HTTP server. Inject fetch only
when the parser/lifecycle remains real and document that limitation. Mock the
external service, not the routing, validator or verdict being reviewed.

Use temporary workspaces and MATRIX_HOME, fake keys, and intercepted or loopback
network traffic. Preserve the user's checkout and other agents' changes. Do not
run real paid calls or weaken security boundaries to make a test pass.

State expected behavior before running. Observe side effects as well as return
values: destination, auth, request count, filesystem bytes, actual child command,
reader closure and stored records. A success string from the model is not proof.

For a behavioral repair, demonstrate the new regression fails on the old behavior
when feasible, then passes with the repair. Use an isolated copy or worktree if
needed; never undo someone else's current work to manufacture a failing run.

## 4. Exercise the failure family

Choose relevant boundary cases, not arbitrary test volume:

- Happy path, refusal, malformed input, cancellation and timeout.
- At-limit and over-limit data, fragmented across events, including an open stream.
- Missing versus empty versus invalid data; unknown versus zero versus partial.
- Conflicting ambient state, stale identity and mutation between phases.
- Alternate entry points and equivalent ways to bypass the same requirement.

After fixing one counterexample, deliberately try another mechanism that violates
the same claim. For the evaluation finding, changing the assertion and replacing
the test script are two mechanisms within the same integrity problem.

## 5. Use tools to obtain evidence

Start with git status and the relevant diff, including untracked new modules.
Use rg (or grep when unavailable) to locate callers, not just definitions. Read
the surrounding branches before drawing a conclusion from a search match.

Use node:test for persistent regressions, short isolated Node scripts for exploratory
reproductions, and real subprocesses for CLI/process claims. Inspect actual output
files and requests. Use git diff --check for patch hygiene. Run the repository's
required targeted and engineering gates after behavioral edits; report exact
commands and results. Test counts do not substitute for adversarial evidence.

Do not assume a tool or model available in one agent host exists in another.
The portable part of this method uses repository code, Git, Node and local fixtures.
There is no special review tool that automatically detects all these defects.

## 6. Submit a reviewable result

Include candidate identity (commit plus dirty/untracked fingerprint), changed
behavior, claim tested, expected/actual evidence, test results and remaining scope.
For a finding give severity, tight file/line location, reproducible trigger,
consequence and the required behavior. Do not label speculation as reproduced.

Use precise verdicts: "the three reported reproductions pass" is different from
"the feature is accepted". State what was not evaluated. If a new bypass defeats
the same requirement, mark the original repair incomplete rather than suggesting
that an unrelated new requirement appeared.

Self-review is required but is not an independent audit. A different reviewer must
construct their own counterexamples, not merely rerun the author's tests. Changing
the model in the same ongoing implementation conversation does not by itself
establish audit independence. Only the authorized acceptance process closes the phase.

## Reusable assignment

> Review this candidate against its behavioral claims. Read REVIEW_METHOD.md and
> the applicable acceptance matrix. Trace the real execution and evidence paths.
> Try independent counterexamples, including an alternate mechanism for each
> repaired failure family. Use isolated fixtures and fake credentials. Report only
> supported findings with reproductions, exact verification results, scope limits
> and candidate identity. Do not edit runtime code during a review unless assigned
> to fix it; do not equate passing author tests with acceptance.
