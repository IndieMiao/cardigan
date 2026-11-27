/** C-638: heap use against the V8 limit on the control host's health page. */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { call, type WebHarness, webHarness } from "../../test-support/web.js";
import { activitiesSince, activityNow } from "../activity.js";
import {
  appendProcessHealthHistory,
  PROCESS_HEALTH_HISTORY_INTERVAL_MS,
  PROCESS_HEALTH_HISTORY_POINTS,
  PROCESS_HEALTH_STALE_MS,
  type ProcessHealthPoint,
  processHealthDirectory,
  processHealthHistoryPoints,
  processHealthSegments,
  processHealthView,
  publishProcessHealth,
  readProcessHealth,
  readProcessHealthHistory,
  sampleProcessHealth,
  writeProcessHealth,
} from "../process-health.js";
import { requestRoute } from "./http.js";

const PASSWORD = "process-health-password";
let h: WebHarness | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await h?.close();
  h = undefined;
});

test("the web process shows its own heap and the background process's published sample", async () => {
  h = await webHarness({ password: PASSWORD, processRole: "web" });
  const cookie = await h.login(PASSWORD);
  const background = { ...sampleProcessHealth("background") };
  writeProcessHealth(h.dataDir, background);
  const res = await call(h.port, "/api/process-health", { cookie });
  expect(res.status).toBe(200);
  const body = res.json as {
    processes: Record<string, number | string>[];
  };
  expect(body.processes.map((p) => p.role)).toEqual(["web", "background"]);
  for (const p of body.processes) {
    expect(Object.keys(p).sort()).toEqual(
      [
        "checked_at",
        "heap_limit_bytes",
        "heap_used_bytes",
        "history",
        "role",
        "rss_bytes",
      ].sort(),
    );
    expect(p.heap_used_bytes as number).toBeGreaterThan(0);
    expect(p.heap_limit_bytes as number).toBeGreaterThan(
      p.heap_used_bytes as number,
    );
  }
  expect(body.processes[1]).toEqual({
    ...background,
    history: { points: [], segments: [] },
  });
  expect((await call(h.port, "/api/process-health")).status).toBe(401);
  expect(
    (
      await call(h.port, "/api/process-health", {
        cookie,
        method: "POST",
        body: "{}",
        headers: {
          "content-type": "application/json",
          origin: `http://${h.hostHeader}`,
        },
      })
    ).status,
  ).toBe(405);
  expect(requestRoute("/api/process-health")).toBe("/api/process-health");
});

test("a single server process shows only itself, even beside an old background file", async () => {
  h = await webHarness({ password: PASSWORD });
  const cookie = await h.login(PASSWORD);
  writeProcessHealth(h.dataDir, sampleProcessHealth("background"));
  const res = await call(h.port, "/api/process-health", { cookie });
  expect(
    (res.json as { processes: { role: string }[] }).processes.map(
      (p) => p.role,
    ),
  ).toEqual(["server"]);
});

test("missing, stale, oversized or malformed background samples are not shown", async () => {
  h = await webHarness();
  const dataDir = h.dataDir;
  expect(readProcessHealth(dataDir, "background")).toBeUndefined();
  const sample = sampleProcessHealth("background", new Date(0));
  writeProcessHealth(dataDir, sample);
  expect(
    readProcessHealth(
      dataDir,
      "background",
      new Date(PROCESS_HEALTH_STALE_MS + 1),
    ),
  ).toBeUndefined();
  expect(
    readProcessHealth(dataDir, "background", new Date(PROCESS_HEALTH_STALE_MS)),
  ).toEqual(sample);
  const file = join(processHealthDirectory(dataDir), "background.json");
  for (const content of [
    "not json",
    JSON.stringify({ ...sample, role: "web" }),
    JSON.stringify({ ...sample, heap_used_bytes: -1 }),
    JSON.stringify({ ...sample, rss_bytes: "1" }),
    JSON.stringify({ ...sample, checked_at: "never" }),
    JSON.stringify({ ...sample, note: "x".repeat(5000) }),
  ]) {
    writeFileSync(file, content);
    expect(
      readProcessHealth(dataDir, "background", new Date(0)),
    ).toBeUndefined();
  }
  // Unknown extra keys are dropped, never echoed.
  writeFileSync(file, JSON.stringify({ ...sample, path: "/secret" }));
  expect(readProcessHealth(dataDir, "background", new Date(0))).toEqual(sample);
});

test("the background role publishes a sample at once and keeps it fresh", async () => {
  h = await webHarness();
  const stop = publishProcessHealth(h.dataDir, "background", {
    intervalMs: 60_000,
  });
  try {
    expect(readProcessHealth(h.dataDir, "background")).toMatchObject({
      role: "background",
    });
  } finally {
    stop();
  }
});

test("C-638: a Workbench request is tracked by method and route template only", async () => {
  h = await webHarness({ password: PASSWORD });
  const cookie = await h.login(PASSWORD);
  const since = activityNow();
  await call(h.port, "/api/projects/secret-project/cards/C-99?q=secret-text", {
    cookie,
  });
  const names = activitiesSince(since)
    .filter((a) => a.kind === "request")
    .map((a) => a.name);
  expect(names).toContain("web GET /api/projects/:project_id/cards/:id");
  expect(names.join("\n")).not.toContain("secret");
});

const MIB = 1024 * 1024;
const HOUR = 3_600_000;
const BOOT_A = "00000000-0000-4000-8000-00000000000a";
const BOOT_B = "00000000-0000-4000-8000-00000000000b";
const point = (
  boot_id: string,
  hour: number,
  heapMib: number,
): ProcessHealthPoint => ({
  boot_id,
  started_at: new Date(Date.UTC(2026, 10, 27)).toISOString(),
  checked_at: new Date(Date.UTC(2026, 10, 27) + hour * HOUR).toISOString(),
  heap_used_bytes: heapMib * MIB,
  heap_limit_bytes: 8192 * MIB,
  rss_bytes: 2 * heapMib * MIB,
});

test("C-835: each process keeps an hourly history that survives restarts, one segment per start", async () => {
  h = await webHarness();
  const dataDir = h.dataDir;
  vi.useFakeTimers({
    toFake: ["Date", "setInterval", "clearInterval"],
    now: Date.UTC(2026, 10, 27, 8),
  });
  const first = publishProcessHealth(dataDir, "background", {
    intervalMs: 30_000,
  });
  // The start itself is not a point: warm-up is not growth.
  expect(readProcessHealthHistory(dataDir, "background")).toEqual([]);
  vi.advanceTimersByTime(PROCESS_HEALTH_HISTORY_INTERVAL_MS - 30_000);
  expect(readProcessHealthHistory(dataDir, "background")).toEqual([]);
  vi.advanceTimersByTime(30_000);
  vi.advanceTimersByTime(2 * PROCESS_HEALTH_HISTORY_INTERVAL_MS);
  first();
  const before = readProcessHealthHistory(dataDir, "background");
  expect(before.map((p) => p.checked_at)).toEqual([
    "2026-11-27T09:00:00.000Z",
    "2026-11-27T10:00:00.000Z",
    "2026-11-27T11:00:00.000Z",
  ]);
  expect(new Set(before.map((p) => p.boot_id)).size).toBe(1);
  for (const p of before) {
    expect(p.started_at).toBe("2026-11-27T08:00:00.000Z");
    expect(p.heap_used_bytes).toBeGreaterThan(0);
    expect(p.heap_limit_bytes).toBeGreaterThan(p.heap_used_bytes);
    expect(p.rss_bytes).toBeGreaterThan(0);
  }

  // A deploy restarts the process: earlier points stay, a new run begins.
  vi.advanceTimersByTime(10 * 60_000);
  const second = publishProcessHealth(dataDir, "background", {
    intervalMs: 30_000,
  });
  vi.advanceTimersByTime(PROCESS_HEALTH_HISTORY_INTERVAL_MS);
  second();
  const after = readProcessHealthHistory(dataDir, "background");
  expect(after.slice(0, 3)).toEqual(before);
  expect(after).toHaveLength(4);
  expect(after[3]?.boot_id).not.toBe(before[0]?.boot_id);
  expect(after[3]?.started_at).toBe("2026-11-27T11:10:00.000Z");
  const segments = processHealthSegments(after);
  expect(segments.map((s) => s.points)).toEqual([3, 1]);
  expect(segments[0]?.heap_growth_bytes_per_day).toEqual(expect.any(Number));
  expect(segments[1]?.heap_growth_bytes_per_day).toBeNull();
  const mode = statSync(
    join(processHealthDirectory(dataDir), "background-history.json"),
  ).mode;
  expect(mode & 0o777).toBe(0o600);
});

test("C-835: history keeps only the newest points (48 by default), so the file stays bounded", async () => {
  h = await webHarness();
  const dataDir = h.dataDir;
  for (let i = 0; i < 60; i++)
    appendProcessHealthHistory(
      dataDir,
      "web",
      point(i < 30 ? BOOT_A : BOOT_B, i, 100 + i),
    );
  const kept = readProcessHealthHistory(dataDir, "web");
  expect(kept).toHaveLength(PROCESS_HEALTH_HISTORY_POINTS);
  expect(kept[0]).toEqual(point(BOOT_A, 12, 112));
  expect(kept.at(-1)).toEqual(point(BOOT_B, 59, 159));
  const file = join(processHealthDirectory(dataDir), "web-history.json");
  const size = statSync(file).size;
  appendProcessHealthHistory(dataDir, "web", point(BOOT_B, 60, 160));
  expect(Math.abs(statSync(file).size - size)).toBeLessThan(16);
  expect(readProcessHealthHistory(dataDir, "background")).toEqual([]);

  // A configured limit applies the same way.
  for (let i = 0; i < 5; i++)
    appendProcessHealthHistory(dataDir, "background", point(BOOT_A, i, 1), 3);
  expect(
    readProcessHealthHistory(dataDir, "background").map((p) => p.checked_at),
  ).toEqual([3, 4, 5].map((i) => point(BOOT_A, i - 1, 1).checked_at));
});

test("C-835: growth is reported per continuous run in MB/day; a run with one point cannot be computed", () => {
  const segments = processHealthSegments([
    point(BOOT_A, 0, 1000),
    point(BOOT_A, 12, 1030),
    point(BOOT_A, 24, 1060),
    point(BOOT_B, 25, 400),
  ]);
  expect(segments).toEqual([
    {
      boot_id: BOOT_A,
      started_at: point(BOOT_A, 0, 0).started_at,
      first_at: point(BOOT_A, 0, 0).checked_at,
      last_at: point(BOOT_A, 24, 0).checked_at,
      points: 3,
      heap_growth_bytes_per_day: 60 * MIB,
    },
    {
      boot_id: BOOT_B,
      started_at: point(BOOT_B, 0, 0).started_at,
      first_at: point(BOOT_B, 25, 0).checked_at,
      last_at: point(BOOT_B, 25, 0).checked_at,
      points: 1,
      heap_growth_bytes_per_day: null,
    },
  ]);
  // Two points at the same instant give no slope, not a division error.
  expect(
    processHealthSegments([point(BOOT_A, 1, 1), point(BOOT_A, 1, 2)])[0]
      ?.heap_growth_bytes_per_day,
  ).toBeNull();
  expect(processHealthSegments([])).toEqual([]);
});

test("C-835: the health endpoint returns each process's history and per-run growth", async () => {
  h = await webHarness({ password: PASSWORD, processRole: "web" });
  const cookie = await h.login(PASSWORD);
  writeProcessHealth(h.dataDir, sampleProcessHealth("background"));
  for (const [hour, heap] of [
    [0, 500],
    [1, 501],
  ] as const) {
    appendProcessHealthHistory(h.dataDir, "web", point(BOOT_A, hour, heap));
    appendProcessHealthHistory(
      h.dataDir,
      "background",
      point(BOOT_B, hour, heap),
    );
  }
  appendProcessHealthHistory(h.dataDir, "background", point(BOOT_A, 2, 9));
  const res = await call(h.port, "/api/process-health", { cookie });
  const body = res.json as {
    processes: {
      role: string;
      history: {
        points: ProcessHealthPoint[];
        segments: { heap_growth_bytes_per_day: number | null }[];
      };
    }[];
  };
  expect(body.processes.map((p) => p.role)).toEqual(["web", "background"]);
  expect(body.processes[0]?.history.points).toHaveLength(2);
  expect(
    body.processes[0]?.history.segments.map((s) => s.heap_growth_bytes_per_day),
  ).toEqual([24 * MIB]);
  expect(
    body.processes[1]?.history.segments.map((s) => s.heap_growth_bytes_per_day),
  ).toEqual([24 * MIB, null]);
  expect(processHealthView(h.dataDir, "server").processes[0]?.history).toEqual({
    points: [],
    segments: [],
  });
});

test("C-835: invalid, oversized or foreign history files are ignored point by point", async () => {
  h = await webHarness();
  const dataDir = h.dataDir;
  appendProcessHealthHistory(dataDir, "web", point(BOOT_A, 0, 1));
  const file = join(processHealthDirectory(dataDir), "web-history.json");
  const good = point(BOOT_A, 1, 2);
  writeFileSync(
    file,
    JSON.stringify({
      role: "web",
      points: [
        { ...good, path: "/secret" },
        { ...good, boot_id: "../x" },
        { ...good, heap_used_bytes: -1 },
        { ...good, checked_at: "never" },
        "x",
      ],
    }),
  );
  expect(readProcessHealthHistory(dataDir, "web")).toEqual([good]);
  expect(readFileSync(file, "utf8")).toContain("/secret");
  for (const content of [
    "not json",
    JSON.stringify({ role: "background", points: [good] }),
    JSON.stringify({ role: "web", points: "x" }),
    JSON.stringify({ role: "web", points: [good], pad: "x".repeat(600_000) }),
  ]) {
    writeFileSync(file, content);
    expect(readProcessHealthHistory(dataDir, "web")).toEqual([]);
  }
  // A broken file is replaced by a fresh history on the next point.
  appendProcessHealthHistory(dataDir, "web", good);
  expect(readProcessHealthHistory(dataDir, "web")).toEqual([good]);
});

test("C-835: the history size is configurable within 2–720 points", () => {
  const warn = vi.fn();
  expect(processHealthHistoryPoints({}, warn)).toBe(48);
  expect(
    processHealthHistoryPoints(
      { CARDIGAN_PROCESS_HEALTH_HISTORY_POINTS: " 96 " },
      warn,
    ),
  ).toBe(96);
  expect(warn).not.toHaveBeenCalled();
  for (const value of ["1", "721", "-5", "12.5", "abc"])
    expect(
      processHealthHistoryPoints(
        { CARDIGAN_PROCESS_HEALTH_HISTORY_POINTS: value },
        warn,
      ),
    ).toBe(48);
  expect(warn).toHaveBeenCalledTimes(5);
});
