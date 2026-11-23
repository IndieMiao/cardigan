import { afterEach, expect, test } from "vitest";
import {
  activitiesSince,
  activityNow,
  beginActivity,
  currentActivity,
  type StallLine,
  StallWatch,
  trackActivity,
} from "./activity.js";
import { profileTick } from "./tick-profile.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TS = "2026-11-23T08:00:00.000Z";

let watch: StallWatch | undefined;
afterEach(() => {
  watch?.stop();
  watch = undefined;
});

const block = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const settle = () => new Promise((done) => setTimeout(done, 40));

/** Real timers with a small cadence; the event loop is blocked without CPU. */
function install(thresholdMs = 60) {
  const lines: StallLine[] = [];
  watch = new StallWatch({
    log: (line) => lines.push(line),
    sha: SHA,
    now: () => new Date(TS),
    thresholdMs,
    intervalMs: 10,
  });
  return { lines };
}

test("C-638: an activity is current inside its context and leaves the running set when it ends", async () => {
  expect(currentActivity()).toBeUndefined();
  const seen = await trackActivity("loop", "c638-tracked", async () => {
    await new Promise((done) => setTimeout(done, 1));
    return currentActivity()?.name;
  });
  expect(seen).toBe("c638-tracked");
  expect(currentActivity()).toBeUndefined();
  const handle = beginActivity("request", "c638-handle");
  expect(handle.run(() => currentActivity()?.kind)).toBe("request");
  const at = activityNow();
  expect(
    activitiesSince(at).find((a) => a.name === "c638-handle"),
  ).toMatchObject({ finished: false });
  handle.end();
  handle.end(); // idempotent
  expect(
    activitiesSince(at)
      .filter((a) => a.name === "c638-handle")
      .map((a) => a.finished),
  ).toEqual([true]);
  await expect(
    trackActivity("loop", "c638-failing", async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(
    activitiesSince(activityNow() + 1).some((a) => a.name === "c638-failing"),
  ).toBe(false);
});

test("C-638: profileTick names the loop even with profiling off", async () => {
  const name = await profileTick("c638-loop", async () => currentActivity());
  expect(name).toMatchObject({ kind: "loop", name: "c638-loop" });
});

test("C-638: a stall over the threshold logs the loops and requests running during it", async () => {
  const { lines } = install();
  await settle();
  // Short delays are not stalls.
  expect(lines.filter((l) => JSON.stringify(l).includes("c638-"))).toEqual([]);
  const snapshot = beginActivity("request", "web GET c638-snapshot");
  const stream = beginActivity("request", "web GET c638-stream");
  const tick = beginActivity("loop", "c638-dispatcher");
  block(150);
  snapshot.end(); // finished with the stall: the likely cause
  await settle();
  stream.end();
  tick.end();
  const line = lines.find((l) => JSON.stringify(l).includes("c638-snapshot"));
  expect(line).toMatchObject({
    event: "event_loop_stall",
    delay_ms: expect.any(Number),
    ts: TS,
    sha: SHA,
  });
  expect(line?.delay_ms as number).toBeGreaterThanOrEqual(60);
  const requests = (line?.requests ?? []) as {
    name: string;
    finished?: true;
  }[];
  expect(requests[0]).toEqual({
    name: "web GET c638-snapshot",
    running_ms: expect.any(Number),
    finished: true,
  });
  expect(requests).toContainEqual({
    name: "web GET c638-stream",
    running_ms: expect.any(Number),
  });
  expect(line?.loops).toContainEqual({
    name: "c638-dispatcher",
    running_ms: expect.any(Number),
  });
});

test("C-638: a stall line lists at most 20 activities per kind and counts the rest", async () => {
  const { lines } = install();
  await settle();
  const handles = Array.from({ length: 25 }, (_, i) =>
    beginActivity("request", `mcp-c638-${i}`),
  );
  block(150);
  await settle();
  for (const handle of handles) handle.end();
  const line = lines.find((l) => JSON.stringify(l).includes("mcp-c638-"));
  expect(line?.requests).toHaveLength(20);
  expect(line?.more_requests as number).toBeGreaterThanOrEqual(5);
});
