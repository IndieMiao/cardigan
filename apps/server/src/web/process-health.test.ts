/** C-638: heap use against the V8 limit on the control host's health page. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { call, type WebHarness, webHarness } from "../../test-support/web.js";
import { activitiesSince, activityNow } from "../activity.js";
import {
  PROCESS_HEALTH_STALE_MS,
  processHealthDirectory,
  publishProcessHealth,
  readProcessHealth,
  sampleProcessHealth,
  writeProcessHealth,
} from "../process-health.js";
import { requestRoute } from "./http.js";

const PASSWORD = "process-health-password";
let h: WebHarness | undefined;
afterEach(async () => {
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
        "role",
        "rss_bytes",
      ].sort(),
    );
    expect(p.heap_used_bytes as number).toBeGreaterThan(0);
    expect(p.heap_limit_bytes as number).toBeGreaterThan(
      p.heap_used_bytes as number,
    );
  }
  expect(body.processes[1]).toEqual(background);
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
  const stop = publishProcessHealth(h.dataDir, "background", 60_000);
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
