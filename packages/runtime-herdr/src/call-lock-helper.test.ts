import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { closeIdleHcLockHelpers } from "./call-lock-helper.js";
import { governHcClient } from "./call-queue.js";
import { workerPreflight } from "./index.js";
import { RuntimeFailure } from "./runtime-failure.js";

const state = vi.hoisted(() => ({
  mode: "normal",
  children: [] as ChildProcess[],
  launches: [] as { args: string[]; cwd: unknown }[],
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((binary, args, options) => {
      if (binary !== "python3") return actual.spawn(binary, args, options);
      const scriptIndex = args.indexOf("-c") + 1;
      let script = args[scriptIndex];
      if (state.mode === "missing") binary = "/missing-private-lock-helper";
      if (state.mode === "ready-stall") script = "import sys\nsys.stdin.read()";
      if (state.mode === "malformed")
        script = "print('private malformed diagnostic',flush=True)";
      if (state.mode === "wrong-id")
        script = 'print(\'{"id":1,"status":"ready"}\',flush=True)';
      if (state.mode === "wrong-status-type")
        script = 'print(\'{"id":0,"status":["ready"]}\',flush=True)';
      if (state.mode === "reply-stall")
        script =
          'import sys\nprint(\'{"id":0,"status":"ready"}\',flush=True)\nsys.stdin.read()';
      if (state.mode === "unlock-stall")
        script = script.replace(
          "fcntl.flock(3,fcntl.LOCK_UN)",
          "sys.stdin.read()",
        );
      if (state.mode === "lost-ack")
        script = script.replace("status='acquired'", "sys.exit(1)");
      const helperArgs = [...args];
      helperArgs[scriptIndex] = script;
      state.launches.push({ args: helperArgs, cwd: options.cwd });
      const child = actual.spawn(binary, helperArgs, options);
      state.children.push(child);
      return child;
    }) as typeof actual.spawn,
  };
});
const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await closeIdleHcLockHelpers();
  state.mode = "normal";
  state.children.length = 0;
  state.launches.length = 0;
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(queueWaitMs = 500, concurrency = 1) {
  const root = await mkdtemp(join(tmpdir(), "hc-helper-"));
  roots.push(root);
  const socket = join(root, "hc.sock"),
    session = "fixture";
  await mkdir(join(root, "locks"), { mode: 0o700 });
  const key = createHash("sha256")
    .update(JSON.stringify([socket, session]))
    .digest("hex");
  const path = (slot = 0) => join(root, "locks", `hc-${key}-${slot}.lock`);
  const raw = {
    available: async () => true,
    async *lines() {},
    exec: vi.fn(async () => "done"),
  };
  return {
    root,
    path,
    raw,
    client: governHcClient(raw, {
      dataDir: root,
      socket,
      session,
      policy: { concurrency, queueWaitMs },
    }),
  };
}
async function probe(path: string) {
  try {
    await execute("flock", ["--nonblock", path, "true"]);
    return true;
  } catch (error) {
    if ((error as { code: unknown }).code === 1) return false;
    throw error;
  }
}
async function holder(path: string) {
  await writeFile(path, "", { mode: 0o600 });
  const child = (await import("node:child_process")).spawn(
    "flock",
    ["--exclusive", path, "sh", "-c", "printf ready; read reply"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
  });
  return {
    child,
    closed,
    async release() {
      child.stdin.end("release\n");
      await closed;
    },
  };
}
const linux = test.skipIf(process.platform !== "linux");
linux.each([
  "missing",
  "malformed",
  "wrong-id",
  "wrong-status-type",
  "lost-ack",
])("%s helper fails closed without leaking diagnostics", async (mode) => {
  state.mode = mode;
  expect(typeof workerPreflight).toBe("function");
  const f = await fixture();
  await expect(f.client.exec(["get", "t1"])).rejects.toMatchObject({
    code: "runtime_unavailable",
    message: "hc queue helper unavailable",
  });
  expect(f.raw.exec).not.toHaveBeenCalled();
  await closeIdleHcLockHelpers();
  expect(await probe(f.path())).toBe(true);
});
linux.each(["ready-stall", "reply-stall"])(
  "%s uses the original absolute queue deadline",
  async (mode) => {
    state.mode = mode;
    const f = await fixture(100);
    const started = performance.now();
    await expect(f.client.exec(["get", "t1"])).rejects.toMatchObject({
      code: "runtime_queue_timeout",
    });
    expect(performance.now() - started).toBeLessThan(350);
    expect(f.raw.exec).not.toHaveBeenCalled();
  },
);
linux(
  "a stalled unlock fails as unavailable after IO and closes the owned helper",
  async () => {
    state.mode = "unlock-stall";
    const f = await fixture(100);
    await expect(f.client.exec(["get", "t1"])).rejects.toMatchObject({
      code: "runtime_unavailable",
    });
    expect(f.raw.exec).toHaveBeenCalledTimes(1);
    expect(f.client.queue.diagnostics().last?.error_category).toBe(
      "runtime_unavailable",
    );
    await closeIdleHcLockHelpers();
    expect(await probe(f.path())).toBe(true);
  },
);
linux(
  "cleanup failure preserves the actual command error and detail",
  async () => {
    state.mode = "unlock-stall";
    const f = await fixture(100);
    const failure = new RuntimeFailure("runtime_conflict", "command refused", {
      exit_code: 2,
      stderr: "fixture diagnostic",
    });
    f.raw.exec.mockRejectedValueOnce(failure);
    await expect(f.client.exec(["get", "t1"])).rejects.toBe(failure);
    expect(f.client.queue.diagnostics().last?.error_category).toBe(
      "runtime_conflict",
    );
    await closeIdleHcLockHelpers();
    expect(await probe(f.path())).toBe(true);
  },
);
linux(
  "warm calls reuse a helper and refuse a replacement lock inode",
  async () => {
    const f = await fixture();
    await expect(f.client.exec(["get", "t1"])).resolves.toBe("done");
    await expect(f.client.exec(["get", "t1"])).resolves.toBe("done");
    expect(state.children).toHaveLength(1);
    expect(state.launches[0]).toMatchObject({
      args: expect.arrayContaining(["-I", "-B", "-u", "-c"]),
      cwd: "/",
    });
    await rename(f.path(), `${f.path()}.old`);
    await writeFile(f.path(), "", { mode: 0o600 });
    await expect(f.client.exec(["get", "t1"])).rejects.toMatchObject({
      code: "runtime_unavailable",
    });
    expect(f.raw.exec).toHaveBeenCalledTimes(2);
  },
);
linux(
  "helper death cannot free an active call's lock before its IO settles",
  async () => {
    const f = await fixture();
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const gate = new Promise<void>((r) => {
      finish = r;
    });
    f.raw.exec.mockImplementationOnce(async () => {
      enter();
      await gate;
      return "done";
    });
    const running = f.client.exec(["get", "t1"]);
    try {
      await entered;
      const child = state.children[0];
      if (!child) throw Error("Missing owned helper");
      const closed = new Promise<void>((r) => child.once("close", () => r()));
      child.kill("SIGKILL");
      await closed;
      expect(await probe(f.path())).toBe(false);
    } finally {
      finish();
      await running;
    }
    expect(await probe(f.path())).toBe(true);
    await expect(f.client.exec(["get", "t1"])).resolves.toBe("done");
    expect(state.children).toHaveLength(2);
  },
);
linux(
  "local callers cannot reenter a shared OFD and exceed the global slots",
  async () => {
    const f = await fixture(300, 2),
      h = await holder(f.path(0));
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const gate = new Promise<void>((r) => {
      finish = r;
    });
    f.raw.exec.mockImplementationOnce(async () => {
      enter();
      await gate;
      return "done";
    });
    const running = f.client.exec(["get", "t1"]);
    try {
      await entered;
      await expect(f.client.exec(["get", "t2"])).rejects.toMatchObject({
        code: "runtime_queue_timeout",
      });
      expect(f.raw.exec).toHaveBeenCalledTimes(1);
      expect(await probe(f.path(1))).toBe(false);
    } finally {
      finish();
      await running;
      await h.release();
    }
  },
);
linux(
  "cancellation while waiting for a foreign lock prevents raw IO after release",
  async () => {
    const f = await fixture(1000),
      h = await holder(f.path());
    let current = true;
    const pending = f.client.execIfCurrent(["get", "t1"], () => current);
    try {
      await delay(150);
      current = false;
      await h.release();
      await expect(pending).resolves.toBe(false);
      expect(f.raw.exec).not.toHaveBeenCalled();
    } finally {
      h.child.kill("SIGKILL");
      await h.closed;
      await pending.catch(() => {});
    }
  },
);

linux(
  "an idle CLI controller exits naturally and closes its owned helper",
  async () => {
    const f = await fixture();
    const script = `
    import cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    let helperPid;
    const spawn = cp.spawn;
    cp.spawn = function(binary, ...args) {
      const child = spawn.call(this, binary, ...args);
      if (binary === 'python3') helperPid = child.pid;
      return child;
    };
    syncBuiltinESMExports();
    const {governHcClient} = await import(process.argv[1]);
    const root = process.argv[2];
    const client = governHcClient({available:async()=>true, async *lines(){}, exec:async()=> 'done'},
      {dataDir:root, socket:root+'/hc.sock', session:'fixture', policy:{concurrency:1,queueWaitMs:1000}});
    await client.exec(['get','t1']);
    console.log(JSON.stringify({helperPid}));
  `;
    const result = await execute(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        script,
        new URL("../dist/call-queue.js", import.meta.url).href,
        f.root,
      ],
      { timeout: 3000 },
    );
    expect(JSON.parse(result.stdout).helperPid).toBeGreaterThan(0);
    expect(await probe(f.path())).toBe(true);
  },
);

linux.each(["json", "fcntl"])(
  "a caller directory's %s.py cannot execute inside the lock helper",
  async (module) => {
    const f = await fixture();
    const planted = join(f.root, "caller");
    const marker = join(f.root, "untrusted-import");
    await mkdir(planted, { mode: 0o700 });
    await writeFile(
      join(planted, `${module}.py`),
      `open(${JSON.stringify(marker)}, 'w').write('untrusted module imported')\nraise RuntimeError('untrusted caller module')\n`,
      { mode: 0o600 },
    );
    const script = `
      const {governHcClient} = await import(process.argv[1]);
      const root = process.argv[2];
      let calls = 0;
      const client = governHcClient({available:async()=>true, async *lines(){},
        exec:async()=> {calls++; return 'done';}},
        {dataDir:root, socket:root+'/hc.sock', session:'fixture',
          policy:{concurrency:1,queueWaitMs:1000}});
      let result;
      try { result = await client.exec(['get','t1']); }
      catch (error) { result = error.code; }
      console.log(JSON.stringify({result, calls}));
    `;
    const child = await execute(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        script,
        new URL("../dist/call-queue.js", import.meta.url).href,
        f.root,
      ],
      { cwd: planted, timeout: 3000 },
    );
    expect(
      await stat(marker).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(JSON.parse(child.stdout)).toEqual({ result: "done", calls: 1 });
    expect(await probe(f.path())).toBe(true);
  },
);
