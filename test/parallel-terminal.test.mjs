import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { copyDemo } from "./helpers.mjs";

// Drive the real Ink app through a PTY; inspect only text emitted after the
// alternate screen is restored, not earlier review frames.
const DRIVER = String.raw`
import os, pty, termios, fcntl, struct, subprocess, time, select, re, sys, json
root, home = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
env = dict(os.environ, MATRIX_HOME=home, TERM='xterm-256color', MATRIX_REDUCED_MOTION='1', MATRIX_SYNC='1')
for key in ('CI', 'NO_COLOR', 'MATRIX_NO_ALT_SCREEN'):
    env.pop(key, None)
task = 'Fix the off-by-one in the bounds slice in src/processor.py'
proc = subprocess.Popen(['node', 'bin/matrix.mjs', 'parallel', '--cwd', root, task, task], stdin=slave, stdout=slave, stderr=slave, env=env)
os.close(slave)
buffer = b''
answered = set()
deadline = time.monotonic() + 30
while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], .05)
    if ready:
        try: data = os.read(master, 65536)
        except OSError: break
        if not data: break
        buffer += data
    frame = buffer.split(b'\x1b[?2026h')[-1]
    clean = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', frame)
    key = choice = None
    if b'Approve this one request?' in clean:
        matches = list(re.finditer(rb'agent-0[12] (edit|test) approval (approval-[0-9]+)', clean))
        if matches:
            match = matches[-1]
            key = match.group(2)
            choice = b'n' if match.group(1) == b'test' else b'y'
    elif b'Choose base or' in clean: key, choice = b'choose', b'agent-01'
    elif b'Integrate these exact changes' in clean: key, choice = b'integrate', b'y'
    elif b'Run this exact test plan?' in clean: key, choice = b'combined', b'n'
    elif b'Finished:' in clean: key, choice = b'exit', b''
    if key is not None and key not in answered:
        answered.add(key)
        if choice:
            os.write(master, choice)
            time.sleep(.1)
        os.write(master, b'\r')
        time.sleep(.1)
    if proc.poll() is not None:
        # Remaining PTY bytes are still readable after process exit.
        while select.select([master], [], [], .05)[0]:
            try: buffer += os.read(master, 65536)
            except OSError: break
        break
if proc.poll() is None:
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        raise RuntimeError('terminal run timed out; decisions=' + repr(answered))
code = proc.wait()
os.close(master)
exit_sequence = b'\x1b[?1049l'
if exit_sequence not in buffer:
    raise RuntimeError('alternate screen did not exit')
summary = buffer.split(exit_sequence)[-1].decode('utf8', 'replace')
print(json.dumps({'code':code, 'summary':summary, 'decisions':[x.decode() for x in answered]}))
`;

for (const git of [false, true]) {
  test(`real terminal prints ${git ? "Git" : "directory"} result details after alternate-screen exit`, (t) => {
    const demo = copyDemo("matrix-parallel-terminal-");
    t.after(() => demo.cleanup());
    if (git) {
      const command = (...args) => execFileSync("git", ["-C", demo.workspace, ...args]);
      command("init", "-q");
      command("config", "user.name", "Fixture");
      command("config", "user.email", "fixture@example.invalid");
      command("add", ".");
      command("commit", "-qm", "fixture");
    }
    const child = spawnSync("python3", ["-c", DRIVER, demo.workspace, join(demo.root, "home")], {
      encoding: "utf8",
      timeout: 35000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(child.stdout);
    assert.equal(report.code, 1, "denied combined verification remains unverified");
    for (const text of [
      "FINAL RESULT",
      "Result workspace:",
      "Integration intent:",
      "Recovery session:",
      "Resume: matrix -C",
      "Verification: unverified",
      "Publication: published",
      "Final status: unverified",
    ]) {
      assert.ok(report.summary.includes(text), `missing ${text} after exiting alternate screen`);
    }
    if (git) {
      assert.match(report.summary, /Published branch: "refs\/heads\/matrix\/parallel\//);
      assert.match(report.summary, /Commit: [0-9a-f]{40}/);
    }
  });
}
