# Independent verification — Matrix provider-eval Yama tracing fix

Reviewer: independent fresh-context review. Review date: 2026-11-04. No
repository code, host kernel setting, or git history was modified. All harness
artifacts are under `/tmp/opencode/review-kit/`.

## 1. Candidate identity

- Repository: `/home/mitravanu/matrix`
- Branch: `matrix/engineering-hardening`
- HEAD: `ff55a2c2aaeb863e881a5a8d0e112eb78ded0204`
- Dirty tracked files:
  - `README.md`
  - `docs/next-phase/STATUS.md`
  - `eval/README.md`
  - `eval/provider-eval.mjs`
  - `test/provider-eval.test.mjs`
- Untracked files present before and after review:
  - `docs/next-phase/decisions/DUR-001.md`
  - `docs/next-phase/reports/2026-11-02-prv106-audit.md`
  - `docs/next-phase/reports/2026-11-04-prv106-independent-review.md`
  - `test/goal-lock-spike.test.mjs`

This review added only this report
(`docs/next-phase/reports/2026-11-04-prv106-yama-tracing-verification.md`).

Candidate file hashes (working tree, re-verified at end):

```text
d3697d540b27a2522992148bfd081e55f686404324b376f0ff78aedd038af70c  README.md
77bd39baaf5ae7aa83521a1605382cbe12c6045e618a73b1e3a857785a0717b1  docs/next-phase/STATUS.md
8d5c3cd4555df9dca38cd0e8870750d71a271fcd3ece8d8fcbc8f4a377d3e816  eval/README.md
8c7826aa96a974a27c1a62844e9e77631d690e72a5c8200df21d8f994e960dde  eval/provider-eval.mjs
1660c607527d18ee6063bd2515317bf9a7b49998e3282187da3bf178e893a3ab  test/provider-eval.test.mjs
```

Tested-tree manifest: 99 files (98 runtime files under `eval/`, `lib/`,
`src/`, plus `package.json`, plus `test/provider-eval.test.mjs`).
`sha256sum -c /tmp/opencode/review-kit/harness/manifest.sha256 --quiet`
passed before and after the VM runs. The 98-file aggregate
`sha256(concat(sorted(path, NUL, raw digest)))` is
`2743c680fd6ad6549d9dfb2ae550585de756a0106cf6aebd1df01b24d9a2869c`,
matching the candidate STATUS claim.

## 2. Change under review

`eval/provider-eval.mjs` adds `requireProviderEvalTracingProtection()`, which
requires:

- Linux `kernel.yama.ptrace_scope` to be exactly `2` or `3`; and
- `/proc/self/status` `TracerPid` to be `0`.

It is called three times in `runProviderEvaluation()`: after provider binding
and before the sandbox probe, again after the sandbox probe, and immediately
before returning the report. The CLI writes the report only after
`runProviderEvaluation()` returns, so a failure at the final check also
prevents a report write.

The same diff replaces the fixture's workspace test plan with
`process.execPath --test` directly, avoiding npm's external installation tree.
`lib/linux-bwrap.mjs` already mounts `realpath(process.execPath)` as an exact
read-only file when it is outside `/usr` and outside the workspace.

## 3. Claim and counterexample

Claim: on a Linux host with real Yama scope 2 or 3 and an untraced evaluator,
an unprivileged same-UID process cannot attach to or read the evaluator or
either scoring child, so it cannot forge scoring receipts; and an edit that
passes the workspace test but is behaviorally wrong fails both scoring checks.

Counterexample attempted: a same-UID sibling probe using `PTRACE_ATTACH`,
`process_vm_readv`, and `/proc/<pid>/mem` against the evaluator and each
scoring child, plus a deliberately wrong edit that passes the workspace test.

## 4. Host real scope-0 control

Host kernel setting (unchanged before and after):

```text
$ cat /proc/sys/kernel/yama/ptrace_scope
0
```

Command:

```text
$ cd /home/mitravanu/matrix
$ node /tmp/opencode/review-kit/harness/host-control.mjs
```

Observed:

```json
{
  "probe": "host-cli-scope0",
  "scope": "0",
  "node": "v24.21.0",
  "exit": 1,
  "signal": null,
  "stdout": "",
  "stderr": "PROVIDER EVAL ERROR: provider evaluation requires Linux Yama kernel.yama.ptrace_scope=2 or 3 and an untraced evaluator\n",
  "requestCount": 0,
  "requests": [],
  "assertions": {
    "hostScopeIs0": true,
    "exitIs1": true,
    "stderrNamesYama": true,
    "zeroProviderRequests": true,
    "reportsDirectoryAbsent": true,
    "noNewEvalTempDirs": true,
    "credentialNotEchoed": true
  },
  "ok": true
}
```

The real CLI exited 1 before any provider request, wrote no report directory,
created no new `matrix-provider-eval-*` temp directory, and did not echo the
fake credential. The harness itself exited 0.

## 5. Disposable VM at real Yama scope 2

VM: Firecracker v1.13.1, kernel `7.0.12+kali-amd64` extracted from the host's
`/boot/vmlinuz-7.0.12+kali-amd64`, 2 vCPU, 2048 MiB, no network interfaces,
custom initramfs. Guest user: UID 1000, `CapEff 0000000000000000`,
`TracerPid 0`. Node 24.21.0 and Node 22.23.1 were the official Linux x64
builds. Provider traffic was loopback-only with fake bearer
`sk-yama-review-canary`.

Build and launch:

```text
$ bash /tmp/opencode/review-kit/vm/build-rootfs.sh
$ bash /tmp/opencode/review-kit/vm/run-vm.sh
```

Guest init sequence:

1. scope 0, run `scope0` control as UID 1000;
2. scope 1, run `scope1` control as UID 1000;
3. scope 2, run `root-control` as UID 0;
4. scope 2, run `main` as UID 1000.

### 5.1 Yama controls

| Probe                     | Scope | UID  | ptrace | process_vm_readv | /proc/pid/mem | Expected | Result  |
| ------------------------- | ----- | ---- | ------ | ---------------- | ------------- | -------- | ------- |
| same-UID sibling          | 0     | 1000 | OK     | OK               | OK            | allowed  | allowed |
| descendant                | 1     | 1000 | OK     | OK               | OK            | allowed  | allowed |
| sibling                   | 1     | 1000 | EPERM  | EPERM            | EACCES        | denied   | denied  |
| root/CAP_SYS_PTRACE       | 2     | 0    | OK     | OK               | OK            | allowed  | allowed |
| unprivileged parent-child | 2     | 1000 | EPERM  | EPERM            | EACCES        | denied   | denied  |
| unprivileged sibling      | 2     | 1000 | EPERM  | EPERM            | EACCES        | denied   | denied  |

The scope-0 and scope-1 controls show the probe discriminates and that the
guest kernel is not denying everything. The root control at scope 2 shows
scope 2 is admin-only, not a blanket ptrace disable. A debug run also showed a
victim that called `PR_SET_PTRACER_ANY` was still denied at scope 2.

### 5.2 Main run matrix

Each run used the real provider evaluation CLI against the loopback fixture.
The wrong edit returns the correct value when `process` is defined (so the
workspace test passes) and the wrong value when `process` is undefined (the
import-free scoring VM), with a 350 ms delay.

| Node    | Edit    | Exit | taskSuccess | Workspace verification | Authoritative | Behavioral | edit / verification checks |
| ------- | ------- | ---- | ----------- | ---------------------- | ------------- | ---------- | -------------------------- |
| 24.21.0 | correct | 0    | true        | verified 1/0           | pass 1/0      | pass 1/0   | pass / pass                |
| 24.21.0 | wrong   | 1    | false       | verified 1/0           | fail 0/1      | fail 0/1   | fail / fail                |
| 22.23.1 | correct | 0    | true        | verified 1/0           | pass 1/0      | pass 1/0   | pass / pass                |
| 22.23.1 | wrong   | 1    | false       | verified 1/0           | fail 0/1      | fail 0/1   | fail / fail                |

In all four runs, test, package, scope, and cleanup checks passed. The correct
runs printed `Overall: PASS`; the wrong runs printed `Overall: FAIL`. Each run
made two provider requests, all to the expected loopback path with the fake
bearer. (The harness's per-mode request list is cumulative, so the second run
of each mode displays four entries.)

### 5.3 Tracing probes during the real runs

For every run, the harness observed at least two scoring children with
`--experimental-vm-modules --test-reporter=tap --input-type=module -` and
probed each one. The evaluator itself, both scoring children, and the
Bubblewrap workspace children all returned:

```text
PTRACE_ATTACH        EPERM
process_vm_readv     EPERM
/proc/<pid>/mem      EACCES
```

The VM's final assertion object was:

```json
{
  "scopeIs2": true,
  "uidIs1000": true,
  "noEffectiveCapabilities": true,
  "untraced": true,
  "manifestMatches": true,
  "parentChildDeniedAtScope2": true,
  "siblingControlDenied": true,
  "allRunsPass": true,
  "ok": true
}
```

## 6. Host focused tests

Both runs used the real workspace sandbox and scoring code; the tracing policy
read is mocked only for the protected path on this scope-0 host.

```text
$ cd /home/mitravanu/matrix
$ node --version
v24.21.0
$ node --test test/provider-eval.test.mjs test/process.test.mjs
# tests 44
# pass 44
# fail 0
# skipped 0
```

```text
$ /tmp/opencode/review-kit/dist/node-v22.23.1-linux-x64/bin/node --version
v22.23.1
$ /tmp/opencode/review-kit/dist/node-v22.23.1-linux-x64/bin/node \
    --test test/provider-eval.test.mjs test/process.test.mjs
# tests 44
# pass 44
# fail 0
# skipped 0
```

The Node 22 binary lives under `/tmp`, outside `/usr`, so this run exercises
the exact-file `process.execPath` mount branch in `lib/linux-bwrap.mjs`. The
provider-eval file contributes 26 tests; process contributes 18.

## 7. Verdict

**The same-UID ptrace scoring-forgery finding can be closed for this candidate
under the tested threat model.** On a host actually enforcing Yama scope 2, an
unprivileged same-UID process could not attach to or read the evaluator or
either scoring child on Node 24.21.0 or Node 22.23.1. A wrong edit that passed
the workspace test failed both scoring checks and produced exit 1 and
`taskSuccess: false`. On the real scope-0 host, the CLI failed closed before
any provider request or report write.

This is a conditional closure, not a claim that scoring is sandboxed:

- The host must enforce `kernel.yama.ptrace_scope=2` or `3`. The CLI now
  refuses scope 0/1 and missing/unreadable Yama. The check is re-run before the
  report is returned.
- The evaluator must start untraced (`TracerPid: 0`).
- A trusted host administrator, runtime, and checkout are assumed. Root or a
  process with `CAP_SYS_PTRACE` can still trace at scope 2; scope 3 denies even
  root, but a malicious root can do anything. A privileged attacker who can
  change the sysctl mid-run and restore it is outside the tested model.
- The fix is host-policy enforcement, not a new sandbox around scoring.
- Direct callers of the exported lower-level `runAuthoritativeVerification`
  bypass the guard; the guard is enforced by `runProviderEvaluation()` and the
  CLI, which are the documented provider-evaluation entry points.

## 8. Residual gaps / not independently verified

1. The implementer's STATUS says the VM was QEMU/KVM and Node 22 was under
   `/opt`. My independent VM was Firecracker and used `/usr/local/node22`
   (inside `/usr`). The `/opt` layout itself was not reproduced in the VM.
   However, the host Node 22 focused suite used a `/tmp` tarball outside
   `/usr`, exercised the exact-file `process.execPath` mount, and passed 44/44.
2. The VM's wrong-edit scoring error is the generic "verification assertions
   did not complete (early exit or unhandled termination)" with `failed: 1`,
   not a specific assertion message. Both scoring gates fail, so the verdict
   is unaffected.
3. The candidate's own tests simulate scope 2 via `fs.readFileSync` mocking;
   this review adds real scope-2 CLI evidence, but only on the kernel/VMM
   described above.
4. No live provider, paid call, availability, quality, pricing, context-length,
   or latency claim. The provider was loopback-only with a fake credential.
5. The other PRV-106 unverified cells (overfit behavioral vectors,
   invoker-name disclosure, large payloads, provider-count lies) were not
   re-tested here.
6. A malicious runtime or checkout is out of scope; the guard reads kernel
   evidence through the running Node process.

## 9. Final state

- Host `kernel.yama.ptrace_scope` is still `0`.
- Apart from this report, `git status --porcelain` is unchanged from the
  start; HEAD is still `ff55a2c2aaeb863e881a5a8d0e112eb78ded0204`.
- All candidate and manifest hashes match the start-of-review values.
- No Firecracker process, VM socket, or `/tmp/firecracker*` artifact remains.
- This report is saved at
  `docs/next-phase/reports/2026-11-04-prv106-yama-tracing-verification.md`.
- Review artifacts are retained under `/tmp/opencode/review-kit/`; the full
  serial log is `logs/vm-serial.log`, summarized output `logs/vm-run2.out`,
  host control `logs/host-control.json`, and the 99-file manifest
  `harness/manifest.sha256`.
