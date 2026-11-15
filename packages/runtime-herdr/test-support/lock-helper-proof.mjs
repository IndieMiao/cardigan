// Design evidence only: a single-slot inherited-fd helper, not production IO.
// Does not implement the governor's multiplexing, cancellation or lifecycle.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const python = `
import fcntl,json,sys,time
for line in sys.stdin:
    request=json.loads(line)
    op=request['op']
    status='refused'
    if op=='try':
        try:
            fcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB)
            status='acquired'
        except BlockingIOError: status='busy'
    elif op=='unlock':
        fcntl.flock(3,fcntl.LOCK_UN)
        status='unlocked'
    elif op=='cpu': status='sample'
    print(json.dumps(dict(id=request['id'],status=status,cpu_ms=time.process_time()*1000)),flush=True)
`;
async function helper(path) {
  const fd = await open(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  const child = spawn("python3", ["-B", "-u", "-c", python], {
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "ignore", fd.fd],
  });
  child.stdin.on("error", () => {});
  const closed = new Promise((resolve) => child.once("close", resolve));
  const input = createInterface({ input: child.stdout });
  const lines = input[Symbol.asyncIterator]();
  let id = 0,
    disposed = false;
  return {
    child,
    closed,
    async command(op) {
      const expected = ++id;
      child.stdin.write(`${JSON.stringify({ id: expected, op })}\n`);
      const next = await lines.next();
      assert.equal(next.done, false);
      const reply = JSON.parse(next.value);
      assert.equal(reply.id, expected);
      return reply;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      child.stdin.end();
      await closed;
      input.close();
      await fd.close();
    },
  };
}
async function systemProbe(path, wait = false) {
  try {
    await execute("flock", [
      wait ? "--wait" : "--nonblock",
      ...(wait ? ["1"] : []),
      path,
      "true",
    ]);
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw error;
  }
}
if (process.argv[2] === "owner") {
  const held = await helper(process.argv[3]);
  assert.equal((await held.command("try")).status, "acquired");
  process.on("message", () => {});
  process.send({ ready: true });
} else {
  assert.equal(process.platform, "linux");
  const root = await mkdtemp(join(tmpdir(), "hc-helper-design-"));
  let held, owner;
  try {
    const path = join(root, "slot.lock");
    held = await helper(path);
    assert.equal((await held.command("try")).status, "acquired");
    assert.equal(await systemProbe(path), false);
    assert.equal((await held.command("unlock")).status, "unlocked");
    assert.equal(await systemProbe(path), true);
    assert.equal((await held.command("try")).status, "acquired");
    held.child.kill("SIGKILL");
    await held.closed;
    // Helper death cannot release the lock while the controller's fd lives.
    assert.equal(await systemProbe(path), false);
    await held.dispose();
    held = undefined;
    assert.equal(await systemProbe(path), true);
    owner = spawn(process.execPath, [process.argv[1], "owner", path], {
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const ended = new Promise((resolve) => owner.once("close", resolve));
    await new Promise((resolve, reject) => {
      owner.once("message", resolve);
      owner.once("error", reject);
    });
    assert.equal(await systemProbe(path), false);
    owner.kill("SIGKILL");
    await ended;
    assert.equal(await systemProbe(path, true), true);
    owner = undefined;
    console.log(
      JSON.stringify({
        proof: "single-slot-fd",
        system_flock_interop: true,
        helper_death_keeps_controller_lock: true,
        owner_death_releases_after_helper_eof: true,
      }),
    );

    for (const mode of ["helper-prototype"]) {
      held = await helper(path);
      const before = held ? (await held.command("cpu")).cpu_ms : 0;
      const started = performance.now(),
        cpu = process.cpuUsage();
      for (let i = 0; i < 10; i++) {
        if (held) {
          assert.equal((await held.command("try")).status, "acquired");
          assert.equal((await held.command("unlock")).status, "unlocked");
        }
        await delay(Math.max(0, started + (i + 1) * 1000 - performance.now()));
      }
      const usage = process.cpuUsage(cpu),
        elapsed = performance.now() - started;
      const helper_cpu_ms = held
        ? (await held.command("cpu")).cpu_ms - before
        : 0;
      console.log(
        JSON.stringify({
          mode,
          operations: 10,
          interval_ms: 1000,
          elapsed_ms: elapsed,
          controller_cpu_ms: (usage.user + usage.system) / 1000,
          helper_cpu_ms,
          caveat:
            "lock-only prototype, not background or full governed-client performance",
        }),
      );
      await held?.dispose();
      held = undefined;
    }
  } finally {
    owner?.kill("SIGKILL");
    await held?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}
