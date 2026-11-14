import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  type ProfileLine,
  profileSpan,
  profileSpanSync,
  profileTick,
  releaseSha,
  setTickProfiler,
  setTickProfileSync,
  TickProfiler,
  TickProfileSwitch,
  tickProfileEnabled,
  tickProfiler,
  tickStoreObserver,
} from "./tick-profile.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TS = "2026-11-14T05:00:00.000Z";

let installed: TickProfiler | undefined;
afterEach(() => {
  installed?.stop();
  installed = undefined;
  setTickProfiler(undefined);
  setTickProfileSync(undefined);
});

function install() {
  const lines: ProfileLine[] = [];
  installed = new TickProfiler({
    log: (l) => lines.push(l),
    reportIntervalMs: 0,
    sha: SHA,
    now: () => new Date(TS),
  });
  setTickProfiler(installed);
  return { profiler: installed, lines };
}

test("only CARDIGAN_TICK_PROFILE=1 turns measurement on", () => {
  expect(tickProfileEnabled({})).toBe(false);
  expect(tickProfileEnabled({ CARDIGAN_TICK_PROFILE: "0" })).toBe(false);
  expect(tickProfileEnabled({ CARDIGAN_TICK_PROFILE: "true" })).toBe(false);
  expect(tickProfileEnabled({ CARDIGAN_TICK_PROFILE: "1" })).toBe(true);
});

test("when off, ticks and spans are plain pass-throughs", async () => {
  expect(tickProfiler()).toBeUndefined();
  const order: string[] = [];
  const result = await profileTick("dispatcher", async () => {
    order.push("tick");
    return profileSpan("route", async () => {
      order.push("span");
      return 7;
    });
  });
  expect(result).toBe(7);
  expect(order).toEqual(["tick", "span"]);
  await expect(
    profileTick("cleanup", async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
});

test("when on, a tick logs numbers only: wall, UnitOfWork, state builds and spans", async () => {
  const { profiler, lines } = install();
  const result = await profileTick("dispatcher", async () => {
    profiler.storeObserver.transaction("read", 5);
    profiler.storeObserver.transaction("write", 3);
    profiler.storeObserver.stateBuild(2);
    await profileSpan("route", async () => undefined);
    await profileSpan("route", async () => undefined);
    return "done";
  });
  expect(result).toBe("done");
  // Outside any tick, store activity is not attributed.
  profiler.storeObserver.transaction("read", 100);
  expect(lines).toHaveLength(1);
  const line = lines[0] ?? {};
  expect(line).toMatchObject({
    event: "tick_profile",
    loop: "dispatcher",
    ts: TS,
    sha: SHA,
    uow_ms: 8,
    uow_count: 2,
    uow_max_ms: 5,
    state_build_ms: 2,
    state_builds: 1,
  });
  expect(Object.keys(line).sort()).toEqual(
    [
      "event",
      "event_loop_utilization",
      "loop",
      "outside_uow_ms",
      "sha",
      "spans",
      "state_build_ms",
      "state_builds",
      "uow_count",
      "uow_max_ms",
      "uow_ms",
      "ts",
      "wall_ms",
    ].sort(),
  );
  expect(Object.keys(line.spans as object)).toEqual(["route"]);
  for (const [key, value] of Object.entries(line))
    if (!["event", "loop", "spans", "ts", "sha"].includes(key))
      expect(typeof value).toBe("number");
});

test("a failing tick is still logged and rethrown; the loop is no longer active", async () => {
  const { profiler, lines } = install();
  await expect(
    profileTick("backup", async () => {
      expect(profiler.activeLoops()).toEqual(["backup"]);
      throw new Error("disk");
    }),
  ).rejects.toThrow("disk");
  expect(profiler.activeLoops()).toEqual([]);
  expect(lines[0]).toMatchObject({ event: "tick_profile", loop: "backup" });
});

test("requests are bucketed by overlap with a tick, and report resets the window", async () => {
  const { profiler, lines } = install();
  profiler.request("web", 4);
  await profileTick("dispatcher", async () => {
    profiler.request("mcp", 9);
  });
  profiler.request("mcp", 60_000);
  profiler.request("web", Number.NaN);
  profiler.report();
  const latency = lines.filter((l) => l.event === "request_latency");
  expect(latency).toEqual([
    {
      event: "request_latency",
      channel: "web",
      during_tick: { n: 0 },
      idle: { n: 1, p50_ms: 4, p95_ms: 4, max_ms: 4 },
      ts: TS,
      sha: SHA,
    },
    {
      event: "request_latency",
      channel: "mcp",
      during_tick: { n: 2, p50_ms: 60_000, p95_ms: 60_000, max_ms: 60_000 },
      idle: { n: 0 },
      ts: TS,
      sha: SHA,
    },
  ]);
  expect(lines.some((l) => l.event === "event_loop_delay")).toBe(true);
  lines.length = 0;
  profiler.report();
  expect(lines.filter((l) => l.event === "request_latency")).toEqual([]);
});

test("C-221: synchronous spans return inline (off and on), accumulate by name and survive throws", async () => {
  // Off: a plain call, no promise involved.
  expect(profileSpanSync("route.step", () => 3)).toBe(3);
  const { lines } = install();
  const order: string[] = [];
  await profileTick("dispatcher", async () => {
    const value = profileSpanSync("route.step", () => {
      order.push("first");
      return 1;
    });
    // Returned synchronously: no microtask ran between the step and here.
    queueMicrotask(() => order.push("microtask"));
    order.push(`value ${value}`);
    profileSpanSync("route.step", () => order.push("second"));
    expect(() =>
      profileSpanSync("route.fail", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    order.push("sync end");
  });
  expect(order).toEqual([
    "first",
    "value 1",
    "second",
    "sync end",
    "microtask",
  ]);
  const spans = lines[0]?.spans as Record<string, number>;
  expect(Object.keys(spans).sort()).toEqual(["route.fail", "route.step"]);
  for (const v of Object.values(spans)) expect(typeof v).toBe("number");
});

test("C-265: every line carries the wall-clock ts and the release sha", async () => {
  const { profiler, lines } = install();
  await profileTick("cleanup", async () => undefined);
  profiler.report();
  expect(lines.length).toBeGreaterThan(1);
  for (const line of lines) expect(line).toMatchObject({ ts: TS, sha: SHA });
  // Without a known release the sha says so instead of being left out.
  const bare: ProfileLine[] = [];
  const other = new TickProfiler({
    log: (l) => bare.push(l),
    reportIntervalMs: 0,
  });
  setTickProfiler(other);
  try {
    await profileTick("backup", async () => undefined);
  } finally {
    other.stop();
  }
  expect(bare[0]?.sha).toBe("unknown");
  expect(Number.isNaN(Date.parse(String(bare[0]?.ts)))).toBe(false);
});

function runtimeSwitch(
  options: { forced?: boolean; reportIntervalMs?: number } = {},
) {
  const lines: ProfileLine[] = [];
  const state = { on: false, attached: 0, detached: 0, reads: 0 };
  const errors: unknown[] = [];
  let fail = false;
  const toggle = new TickProfileSwitch({
    forced: options.forced ?? false,
    enabled: () => {
      state.reads++;
      if (fail) throw new Error("db busy");
      return state.on;
    },
    create: () =>
      new TickProfiler({
        log: (l) => lines.push(l),
        ...(options.reportIntervalMs === undefined
          ? { reportIntervalMs: 0 }
          : options.reportIntervalMs < 0
            ? {}
            : { reportIntervalMs: options.reportIntervalMs }),
        sha: SHA,
      }),
    attach: () => state.attached++,
    detach: () => state.detached++,
    onError: (error) => errors.push(error),
  });
  setTickProfileSync(() => toggle.sync());
  return {
    toggle,
    lines,
    state,
    errors,
    failReads: (value: boolean) => {
      fail = value;
    },
  };
}

test("C-265: turning the switch on or off takes effect on the next loop tick", async () => {
  const { toggle, lines, state } = runtimeSwitch();
  await profileTick("dispatcher", async () => undefined);
  expect(lines).toEqual([]);
  expect(tickProfiler()).toBeUndefined();

  state.on = true;
  await profileTick("dispatcher", async () => undefined);
  expect(lines.map((l) => [l.event, l.loop])).toEqual([
    ["tick_profile", "dispatcher"],
  ]);
  expect(tickProfiler()).toBe(toggle.profiler);
  // Staying on keeps the same profiler (one event-loop window, one observer).
  const first = toggle.profiler;
  await profileTick("merge", async () => undefined);
  expect(toggle.profiler).toBe(first);
  expect(state.attached).toBe(1);

  state.on = false;
  await profileTick("dispatcher", async () => undefined);
  // Off: the last window is flushed, the next tick logs nothing.
  expect(lines.map((l) => l.event)).toEqual([
    "tick_profile",
    "tick_profile",
    "event_loop_delay",
  ]);
  expect(tickProfiler()).toBeUndefined();
  expect(state.detached).toBe(1);

  // And back on again, with a fresh profiler.
  state.on = true;
  await profileTick("cleanup", async () => undefined);
  expect(lines.at(-1)).toMatchObject({
    event: "tick_profile",
    loop: "cleanup",
  });
  expect(toggle.profiler).not.toBe(first);
  toggle.close();
  expect(tickProfiler()).toBeUndefined();
  // Closed: later ticks never reinstall it.
  await profileTick("cleanup", async () => undefined);
  expect(tickProfiler()).toBeUndefined();
});

test("C-265: a tick already running when the switch turns off still logs its line", async () => {
  const { lines, state } = runtimeSwitch();
  state.on = true;
  await profileTick("backup", async () => {
    state.on = false;
    // Another loop starts meanwhile and turns the profiler off.
    await profileTick("dispatcher", async () => undefined);
  });
  expect(
    lines.filter((l) => l.event === "tick_profile").map((l) => l.loop),
  ).toEqual(["backup"]);
  expect(tickProfiler()).toBeUndefined();
});

test("C-265 V-910: switching off while another loop's tick runs keeps that tick's full measurement", async () => {
  const { lines, state } = runtimeSwitch();
  state.on = true;
  const gate = Promise.withResolvers<void>();
  const backup = profileTick("backup", async () => {
    profileSpanSync("before", () => tickStoreObserver.transaction("read", 5));
    await gate.promise;
    profileSpanSync("after", () => tickStoreObserver.transaction("read", 7));
    await profileSpan("after.async", async () =>
      tickStoreObserver.stateBuild(2),
    );
  });
  // A different loop, in its own async context, sees the switch off.
  state.on = false;
  await profileTick("dispatcher", async () => {
    // Not measured: it started after the switch went off.
    tickStoreObserver.transaction("write", 100);
  });
  expect(tickProfiler()).toBeUndefined();
  // Not detached yet: the backup tick still needs the observer.
  expect(state.detached).toBe(0);
  gate.resolve();
  await backup;
  const ticks = lines.filter((l) => l.event === "tick_profile");
  expect(ticks).toHaveLength(1);
  expect(ticks[0]).toMatchObject({
    loop: "backup",
    uow_count: 2,
    uow_ms: 12,
    uow_max_ms: 7,
    state_builds: 1,
    state_build_ms: 2,
  });
  expect(Object.keys(ticks[0]?.spans as object).sort()).toEqual([
    "after",
    "after.async",
    "before",
  ]);
  // Once the last running tick logged, the window is flushed and detached.
  expect(lines.at(-1)?.event).toBe("event_loop_delay");
  expect(state.detached).toBe(1);
});

test("C-265 V-910: switching off flushes the unreported window with the default report timer", async () => {
  const { lines, state } = runtimeSwitch({ reportIntervalMs: -1 });
  state.on = true;
  await profileTick("dispatcher", async () => undefined);
  tickProfiler()?.request("web", 123);
  state.on = false;
  await profileTick("dispatcher", async () => undefined);
  expect(lines.map((l) => l.event)).toEqual([
    "tick_profile",
    "event_loop_delay",
    "request_latency",
  ]);
  expect(lines.at(-1)).toMatchObject({
    channel: "web",
    sha: SHA,
    ts: expect.any(String),
  });
  const latency = lines.at(-1) as {
    during_tick: { n: number };
    idle: { n: number };
  };
  expect(latency.during_tick.n + latency.idle.n).toBe(1);
});

test("C-265: closing the switch flushes the last window too, exactly once", async () => {
  const { toggle, lines, state } = runtimeSwitch();
  state.on = true;
  await profileTick("dispatcher", async () => undefined);
  toggle.close();
  toggle.close();
  expect(lines.map((l) => l.event)).toEqual([
    "tick_profile",
    "event_loop_delay",
  ]);
});

test("C-265: CARDIGAN_TICK_PROFILE=1 forces measurement regardless of the switch", async () => {
  const { toggle, lines, state } = runtimeSwitch({ forced: true });
  await profileTick("dispatcher", async () => undefined);
  expect(lines).toHaveLength(1);
  expect(state.reads).toBe(0);
  toggle.close();
});

test("C-265: a failed switch read keeps the current state and is reported once", async () => {
  const { toggle, lines, state, errors, failReads } = runtimeSwitch();
  state.on = true;
  await profileTick("dispatcher", async () => undefined);
  failReads(true);
  state.on = false;
  await profileTick("dispatcher", async () => undefined);
  await profileTick("dispatcher", async () => undefined);
  expect(lines).toHaveLength(3);
  expect(errors).toHaveLength(1);
  failReads(false);
  await profileTick("dispatcher", async () => undefined);
  expect(lines.filter((l) => l.event === "tick_profile")).toHaveLength(3);
  expect(lines.at(-1)?.event).toBe("event_loop_delay");
  expect(toggle.profiler).toBeUndefined();
});

test("C-265: without the switch hook, ticks behave exactly as before", async () => {
  setTickProfileSync(undefined);
  expect(await profileTick("dispatcher", async () => 5)).toBe(5);
  expect(tickProfiler()).toBeUndefined();
});

test("C-265: releaseSha reads a detached or branch HEAD and never returns anything but a SHA", () => {
  const root = mkdtempSync(join(tmpdir(), "cardigan-release-sha-"));
  try {
    expect(releaseSha(root)).toBe("unknown");
    mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), `${SHA}\n`);
    expect(releaseSha(root)).toBe(SHA);
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    expect(releaseSha(root)).toBe("unknown");
    writeFileSync(join(root, ".git", "refs", "heads", "main"), `${SHA}\n`);
    expect(releaseSha(root)).toBe(SHA);
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/../../x\n");
    expect(releaseSha(root)).toBe("unknown");
    writeFileSync(join(root, ".git", "HEAD"), "TOKEN=secret\n");
    expect(releaseSha(root)).toBe("unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
