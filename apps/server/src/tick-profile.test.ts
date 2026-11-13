import { afterEach, expect, test } from "vitest";
import {
  type ProfileLine,
  profileSpan,
  profileTick,
  setTickProfiler,
  TickProfiler,
  tickProfileEnabled,
  tickProfiler,
} from "./tick-profile.js";

let installed: TickProfiler | undefined;
afterEach(() => {
  installed?.stop();
  installed = undefined;
  setTickProfiler(undefined);
});

function install() {
  const lines: ProfileLine[] = [];
  installed = new TickProfiler({
    log: (l) => lines.push(l),
    reportIntervalMs: 0,
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
      "spans",
      "state_build_ms",
      "state_builds",
      "uow_count",
      "uow_max_ms",
      "uow_ms",
      "wall_ms",
    ].sort(),
  );
  expect(Object.keys(line.spans as object)).toEqual(["route"]);
  for (const [key, value] of Object.entries(line))
    if (!["event", "loop", "spans"].includes(key))
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
    },
    {
      event: "request_latency",
      channel: "mcp",
      during_tick: { n: 2, p50_ms: 60_000, p95_ms: 60_000, max_ms: 60_000 },
      idle: { n: 0 },
    },
  ]);
  expect(lines.some((l) => l.event === "event_loop_delay")).toBe(true);
  lines.length = 0;
  profiler.report();
  expect(lines.filter((l) => l.event === "request_latency")).toEqual([]);
});
