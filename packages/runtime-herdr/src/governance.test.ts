import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { governHcClient, HcCallQueue, hcCallPolicy } from "./call-queue.js";
import { type HcClient, RuntimeFailure } from "./client.js";
import { HerdrRuntime } from "./index.js";
import {
  assignment,
  launch,
  machine,
  ref,
  role,
  value,
} from "./test-support.js";

afterEach(() => vi.useRealTimers());
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
function fakeCore() {
  const terminals = new Map(
    Array.from({ length: 15 }, (_, i) => [
      `t${i + 1}`,
      { address: `t${i + 1}`, state: "live", status: { state: "idle" } },
    ]),
  );
  let seq = 1,
    active = 0,
    peak = 0,
    starts = 0,
    activeCalls = 0,
    peakCalls = 0,
    next = 16;
  const sources = new Set<{ pending: string[]; wake: () => void }>();
  const client: HcClient = {
    available: async () => true,
    exec: vi.fn(async (args: readonly string[]) => {
      peakCalls = Math.max(peakCalls, ++activeCalls);
      try {
        await Promise.resolve();
        if (args[0] === "--version") return "hc 0.1.18";
        if (args[0] === "run") {
          const address = `t${next++}`;
          terminals.set(address, {
            address,
            state: "live",
            status: { state: "idle" },
          });
          seq++;
          return JSON.stringify({ address });
        }
        const terminal = terminals.get(args[1] ?? "");
        if (args[0] === "get") {
          if (!terminal) throw new RuntimeFailure("runtime_not_found", "gone");
          return JSON.stringify(terminal);
        }
        if (args[0] === "kill" && terminal) {
          terminal.state = "finished";
          seq++;
        }
        if (args[0] === "rm") {
          terminals.delete(args[1] ?? "");
          seq++;
        }
        return "{}";
      } finally {
        activeCalls--;
      }
    }),
    async *lines(args, signal) {
      expect(args).toEqual(["events", "--json"]);
      active++;
      starts++;
      peak = Math.max(peak, active);
      const source = { pending: [] as string[], wake: () => {} };
      sources.add(source);
      const abort = () => source.wake();
      signal?.addEventListener("abort", abort);
      try {
        yield JSON.stringify({
          seq,
          type: "snapshot",
          terminals: [...terminals.values()],
        });
        while (!signal?.aborted) {
          const message = source.pending.shift();
          if (message) {
            yield message;
            continue;
          }
          await new Promise<void>((r) => {
            source.wake = r;
            if (signal?.aborted) r();
          });
        }
      } finally {
        signal?.removeEventListener("abort", abort);
        sources.delete(source);
        active--;
      }
    },
  };
  return {
    client,
    terminals,
    stats: () => ({ active, peak, starts, peakCalls }),
    emit: (message: unknown) => {
      for (const s of sources) {
        s.pending.push(JSON.stringify(message));
        s.wake();
      }
    },
  };
}

test("Q-489 config has approved defaults and rejects invalid values", () => {
  expect(hcCallPolicy({})).toEqual({ concurrency: 4, queueWaitMs: 30000 });
  for (const key of ["CARDIGAN_HC_CONCURRENCY", "CARDIGAN_HC_QUEUE_WAIT_MS"])
    for (const v of ["0", "-1", "x", "1.5", "2147483648"])
      expect(() => hcCallPolicy({ [key]: v })).toThrow(key);
});

test("15 observations and 7 startup calls share four FIFO slots and preserve execution timeouts", async () => {
  vi.useFakeTimers();
  const queue = new HcCallQueue({ concurrency: 4, queueWaitMs: 30000 });
  let active = 0,
    peak = 0;
  const order: number[] = [];
  const jobs = Array.from({ length: 22 }, (_, i) =>
    queue.run(async () => {
      order.push(i);
      peak = Math.max(peak, ++active);
      await new Promise<void>((r) => setTimeout(r, 10));
      active--;
      return i;
    }),
  );
  await vi.advanceTimersByTimeAsync(60);
  expect(await Promise.all(jobs)).toEqual(
    Array.from({ length: 22 }, (_, i) => i),
  );
  expect(peak).toBe(4);
  expect(order).toEqual(Array.from({ length: 22 }, (_, i) => i));
  expect(queue.diagnostics()).toMatchObject({
    active: 0,
    queued: 0,
    completed: 22,
    queue_timeouts: 0,
    last: { round_trip_ms: 10 },
  });
  const raw = fakeCore().client;
  const a = governHcClient(raw, {
    socket: "/fixture/shared.sock",
    session: "test",
    policy: { concurrency: 4, queueWaitMs: 30000 },
  });
  const b = governHcClient(raw, {
    socket: "/fixture/shared.sock",
    session: "test",
    policy: { concurrency: 4, queueWaitMs: 30000 },
  });
  expect(a.queue).toBe(b.queue);
  await a.exec(["exec", "--on", "worker-a", "--", "git", "rev-parse"], 47);
  expect(raw.exec).toHaveBeenLastCalledWith(
    ["exec", "--on", "worker-a", "--", "git", "rev-parse"],
    47,
  );
});

test("queue timeout never invokes the client and does not steal an active slot", async () => {
  vi.useFakeTimers();
  const queue = new HcCallQueue({ concurrency: 1, queueWaitMs: 30 });
  const held = gate(),
    entered = gate();
  const first = queue.run(async () => {
    entered.resolve();
    await held.promise;
  });
  await entered.promise;
  const work = vi.fn(async () => "unused");
  const waiting = expect(queue.run(work)).rejects.toMatchObject({
    code: "runtime_queue_timeout",
  });
  await vi.advanceTimersByTimeAsync(30);
  await waiting;
  expect(work).not.toHaveBeenCalled();
  expect(queue.diagnostics().active).toBe(1);
  held.resolve();
  await first;
  expect(queue.diagnostics().active).toBe(0);
});

test("15 terminal consumers use one core stream during seven fake launches", async () => {
  const f = fakeCore(),
    runtime = value(
      await HerdrRuntime.create({ client: f.client, session: "governance" }),
    );
  const controllers = Array.from({ length: 15 }, () => new AbortController());
  const streams = controllers.map((c, i) =>
    runtime.events({ ...ref, terminal_ref: `t${i + 1}` }, c.signal),
  );
  try {
    const snapshots = await Promise.all(streams.map((s) => s.next()));
    expect(snapshots.every((s) => !s.done && s.value.ok)).toBe(true);
    expect(f.stats()).toMatchObject({ active: 1, peak: 1, starts: 1 });
    const launching = Promise.all(
      Array.from({ length: 7 }, (_, i) =>
        runtime.provision(
          { ...assignment, id: `A-${i + 1}` as never },
          role,
          machine,
          { ...launch, agent_name: `fixture-${i}` },
        ),
      ),
    );
    const observing = Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        runtime.status({ ...ref, terminal_ref: `t${i + 1}` }),
      ),
    );
    const [launched, observed] = await Promise.all([launching, observing]);
    expect(launched.every((r) => r.ok)).toBe(true);
    expect(observed.every((r) => r.ok)).toBe(true);
    expect(f.stats().peakCalls).toBe(4);
    expect(f.stats().peak).toBe(1);
    expect(runtime.diagnostics()).toMatchObject({
      event_subscriptions: 1,
      event_consumers: 15,
      max_concurrent: 4,
    });
    controllers[0]?.abort();
    await streams[0]?.return(undefined);
    expect(f.stats().active).toBe(1);
  } finally {
    for (const c of controllers) c.abort();
    await Promise.all(streams.map((s) => s.return(undefined)));
  }
  expect(f.stats().active).toBe(0);
});

test("identical in-flight status requests share across adapters; release forces a new observation", async () => {
  const f = fakeCore();
  const runtime = value(
    await HerdrRuntime.create({ client: f.client, session: "dedup" }),
  );
  const other = value(
    await HerdrRuntime.create({ client: f.client, session: "dedup" }),
  );
  const blocked = gate(),
    entered = gate();
  const original = f.client.exec;
  let gets = 0;
  f.client.exec = vi.fn(async (args, ms) => {
    if (args[0] === "get" && ++gets === 1) {
      entered.resolve();
      await blocked.promise;
    }
    return ms === undefined ? original(args) : original(args, ms);
  });
  const stale = runtime.status(ref);
  await entered.promise;
  expect(other.status({ ...ref })).toBe(stale);
  await other.release(ref, { force: true });
  const fresh = runtime.status(ref);
  expect(fresh).not.toBe(stale);
  expect(await fresh).toMatchObject({
    ok: false,
    error: { code: "runtime_not_found" },
  });
  blocked.resolve();
  await stale;
  expect(gets).toBe(3);
});

test("snapshots, missed absence and terminal events retain their sequence and filter by terminal", async () => {
  const f = fakeCore(),
    runtime = value(
      await HerdrRuntime.create({ client: f.client, session: "sequences" }),
    );
  const controller = new AbortController(),
    stream = runtime.events(ref, controller.signal);
  try {
    expect((await stream.next()).value).toMatchObject({
      ok: true,
      value: {
        seq: 1,
        type: "snapshot",
        observations: [{ terminal_ref: "t1" }],
      },
    });
    const next = stream.next();
    f.emit({ seq: 2, type: "removed", terminal: "t1" });
    expect((await next).value).toMatchObject({
      ok: true,
      value: { seq: 2, type: "removed", terminal_ref: "t1" },
    });
    const missed = stream.next();
    f.emit({
      seq: 3,
      type: "missed",
      terminals: [{ address: "t2", state: "live" }],
    });
    expect((await missed).value).toMatchObject({
      ok: true,
      value: { seq: 3, type: "missed", observations: [] },
    });
  } finally {
    controller.abort();
    await stream.return(undefined);
  }
});

test("diagnostics contain only counts, timings and bounded categories", async () => {
  const queue = new HcCallQueue({ concurrency: 4, queueWaitMs: 30000 });
  await expect(
    queue.run(async () => {
      throw new Error("SECRET terminal output");
    }),
  ).rejects.toThrow();
  expect(JSON.stringify(queue.diagnostics())).not.toContain("SECRET");
  expect(queue.diagnostics().last?.error_category).toBe("runtime_unavailable");
});

test.skipIf(process.platform !== "linux").each(["release", "crash"])(
  "two control processes share a core's call slots and recover after %s",
  async (ending) => {
    const dataDir = await mkdtemp(join(tmpdir(), "cg-hc-slots-"));
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
    const {governHcClient}=await import(process.argv[1]);
    const root=process.argv[2];
    const raw={available:async()=>true,async *lines(){},exec:async()=>{
      process.stdout.write('ready');
      await new Promise(r=>process.stdin.once('data',r));
      return 'done';
    }};
    await governHcClient(raw,{dataDir:root,socket:root+'/hc.sock',session:'fixture',policy:{concurrency:1,queueWaitMs:300}}).exec(['get','t1']);
  `,
        new URL("../dist/call-queue.js", import.meta.url).href,
        dataDir,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code !== 0) reject(new Error("Fixture control process failed"));
        });
      });
      const raw = fakeCore().client;
      const client = governHcClient(raw, {
        dataDir,
        socket: join(dataDir, "hc.sock"),
        session: "fixture",
        policy: { concurrency: 1, queueWaitMs: 300 },
      });
      await expect(client.exec(["get", "t1"])).rejects.toMatchObject({
        code: "runtime_queue_timeout",
      });
      expect(raw.exec).not.toHaveBeenCalled();
      if (ending === "crash") child.kill("SIGKILL");
      else child.stdin.end("release");
      await closed;
      await expect(client.exec(["get", "t1"])).resolves.toContain(
        '"address":"t1"',
      );
    } finally {
      child.kill("SIGKILL");
      await closed;
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test("a malformed full snapshot fails every consumer instead of inventing missing terminals", async () => {
  const f = fakeCore(),
    runtime = value(
      await HerdrRuntime.create({ client: f.client, session: "malformed" }),
    );
  const controller = new AbortController();
  const a = runtime.events(ref, controller.signal),
    b = runtime.events({ ...ref, terminal_ref: "t2" }, controller.signal);
  try {
    await Promise.all([a.next(), b.next()]);
    const waiting = Promise.all([a.next(), b.next()]);
    f.emit({ seq: 2, type: "missed" });
    expect(await waiting).toMatchObject([
      { value: { ok: false, error: { code: "runtime_unavailable" } } },
      { value: { ok: false, error: { code: "runtime_unavailable" } } },
    ]);
  } finally {
    controller.abort();
    await Promise.all([a.return(undefined), b.return(undefined)]);
  }
});
