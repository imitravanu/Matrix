# Probe stream-bound review — 2026-11-02

## Subsequent repair recheck

The accumulation finding below is repaired for the reproduced case. consume()
now enforces cumulative argument bytes before concatenation, refuses extra calls,
and retains only bounded finish metadata. An independent open-stream fixture
crossed the byte limit without sending DONE: the probe failed after one request,
cancelled the reader, and returned in 34 ms against a 2-second test deadline.
The probe suite passed 21 tests with zero failures/skips; `git diff --check`
passed. Log: `/tmp/matrix-stream-bound-recheck.log`. This focused recheck does
not establish full provider-phase acceptance. No runtime code was edited.

## Original finding

Candidate fingerprint: `443150c5aa323ae997f0135949aa04a904ebac37d87d90cb8f16d78be7c16b3a`
(41 runtime/test/config files, same fingerprint procedure as prior reviews).

New work adds malformed-ID, oversized-argument, redirect, disconnect, oversized
SSE-event and malformed-usage coverage. The probe suite passes 20 tests with
zero failures/skips. Log: `/tmp/matrix-probe-latest-review.log`.

## P2 — Argument bound is enforced after unbounded accumulation

`lib/provider-probe.mjs` consume() appends every tool argument fragment to a
string and retains every distinct call and finish reason until stream completion.
runToolsCheck() only checks the argument bound after consume() returns. The
shared parser's per-event bound does not cap the aggregate of small SSE events.

Independent reproduction injected 100 valid SSE events, each with a 5,000-byte
argument fragment for the same tool call, then DONE. The probe consumed and
accumulated all 500,000 argument bytes before reporting the argument-bound
failure. No external service, real credential or repository content was used.

A provider can continue streaming small fragments throughout the deadline,
growing memory well beyond the advertised argument limit. Enforce cumulative
byte/call bounds while consuming, terminate and close the stream immediately
on violation, and keep only bounded finish metadata. Add a regression with
fragmented over-limit input that stays open, asserting early refusal and reader
cancellation without waiting for DONE or the total timeout.

The prior credential, follow-up completion and usage fixes remain present.
This new streaming limit finding blocks acceptance of the hardening. Evaluation
selection and configuration replacement are still not implemented. Runtime files
were not changed during this review; no commit was made.
