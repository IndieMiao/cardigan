import { randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  CPU_PROFILE_LIMITS,
  CPU_PROFILE_POLICY,
  CpuProfileController,
  cpuProfileCommand,
} from "./cpu-profile-control.js";
import { CpuProfileDirectory } from "./cpu-profile-files.js";
import {
  CpuProfileRecorder,
  type CpuProfileSession,
} from "./cpu-profile-recorder.js";

const sha = "a".repeat(40);
let root: string;
let roleDir: string;
const controllers: CpuProfileController[] = [];
let calls: string[];
let notices: string[];
const fakeProfile = { nodes: [], startTime: 1, endTime: 2, samples: [] };
function start(role: "web" | "background" = "background") {
  const session: CpuProfileSession = {
    connect: () => {
      calls.push("connect");
    },
    enable: async () => {},
    setSamplingInterval: async () => {},
    start: async () => {},
    stop: async () => fakeProfile,
    disable: async () => {},
    disconnect: () => {},
  };
  const controller = new CpuProfileController({
    dataDir: root,
    role,
    sha,
    recorder: new CpuProfileRecorder(CPU_PROFILE_LIMITS, () => session),
    notice: (code) => notices.push(code),
  });
  controllers.push(controller);
  return controller;
}
const command = (
  action: "start" | "stop" | "status",
  target: "web" | "background" | "both" = "background",
) =>
  cpuProfileCommand({
    dataDir: root,
    action,
    target,
    ...(action === "start" ? { seconds: 1 } : {}),
  });
const profileFiles = () =>
  readdirSync(roleDir).filter((n) => n.endsWith(".cpuprofile"));
const state = () =>
  JSON.parse(readFileSync(join(roleDir, "state.json"), "utf8"));
const fixtureName = () =>
  `cpu-background-${sha}-${process.pid}-2026-01-01T00-00-00.000Z-${randomUUID()}.cpuprofile`;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cpu-control-"));
  roleDir = join(root, "cpu-profiles", "background");
  calls = [];
  notices = [];
  vi.useFakeTimers();
});
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((c) => c.close()));
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

test("off by default; a trusted request produces a private complete artifact once", async () => {
  const controller = start();
  controller.sync();
  expect(calls).toEqual([]);
  command("start");
  controller.sync();
  controller.sync();
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls).toEqual(["connect"]);
  expect(profileFiles()).toHaveLength(1);
  const name = profileFiles()[0] as string;
  expect(name).toContain(`cpu-background-${sha}-${process.pid}-`);
  expect(JSON.parse(readFileSync(join(roleDir, name), "utf8"))).toEqual(
    fakeProfile,
  );
  expect(statSync(roleDir).mode & 0o7777).toBe(0o700);
  expect(statSync(join(roleDir, name)).mode & 0o7777).toBe(0o600);
  expect(statSync(join(roleDir, name)).nlink).toBe(1);
  expect(state()).toMatchObject({
    phase: "completed",
    reason: "duration",
    file: name,
  });
  controller.sync();
  await vi.advanceTimersByTimeAsync(1000);
  expect(profileFiles()).toHaveLength(1);
});

test("normal stop and graceful close publish successfully stopped data", async () => {
  const controller = start();
  command("start");
  controller.sync();
  await vi.advanceTimersByTimeAsync(1);
  expect(() => command("start")).toThrow("cpu_profile_busy");
  command("stop");
  controller.sync();
  await vi.advanceTimersByTimeAsync(1);
  expect(state()).toMatchObject({ phase: "completed", reason: "stopped" });
  expect(command("status")).toMatchObject({
    states: [{ phase: "completed", reason: "stopped" }],
  });
  command("start");
  controller.sync();
  await vi.advanceTimersByTimeAsync(1);
  await controller.close();
  controllers.splice(controllers.indexOf(controller), 1);
  expect(profileFiles()).toHaveLength(2);
  controller.sync();
  expect(state().phase).toBe("closed");
});

const malformedActions = [
  { name: "stop array", action: ["stop"] },
  { name: "start array", action: ["start"] },
  { name: "nested stop array", action: [["stop"]] },
  { name: "empty array", action: [] },
  { name: "object", action: {} },
  { name: "null", action: null },
  { name: "boolean", action: false },
  { name: "number", action: 1 },
];
test.each(
  malformedActions.flatMap((value) =>
    [false, true].map((recording) => ({ ...value, recording })),
  ),
)(
  "rejects $name without consuming stop while recording=$recording",
  async ({ action, recording }) => {
    const controller = start();
    if (recording) {
      command("start");
      controller.sync();
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toEqual(["connect"]);
    }
    const consumed = state().sequence;
    command("stop");
    const path = join(root, "cpu-profiles", "request.json");
    const validStop = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...validStop, action }));
    controller.sync();
    await vi.advanceTimersByTimeAsync(1);
    expect(notices).toEqual(["invalid_request"]);
    expect(calls).toEqual(recording ? ["connect"] : []);
    expect(profileFiles()).toEqual([]);
    expect(state()).toMatchObject({
      sequence: consumed,
      phase: recording ? "recording" : "failed",
    });

    // Repair the same request: success proves the malformed version did not
    // consume its sequence, including when an existing recording stayed alive.
    writeFileSync(path, JSON.stringify(validStop));
    controller.sync();
    await vi.advanceTimersByTimeAsync(1);
    expect(state()).toMatchObject({
      sequence: validStop.sequence,
      phase: recording ? "completed" : "idle",
    });
    expect(profileFiles()).toHaveLength(recording ? 1 : 0);
    if (recording) expect(state().reason).toBe("stopped");
  },
);

test.each([
  { field: "phase", value: ["idle"] },
  { field: "reason", value: ["stopped"] },
  { field: "code", value: ["busy"] },
])("rejects a coercible array in state $field", ({ field, value }) => {
  start();
  const path = join(roleDir, "state.json");
  const valid = state();
  writeFileSync(path, JSON.stringify({ ...valid, [field]: value }));
  expect(() => command("status")).toThrow("cpu_profile_unsafe");
  expect(() => command("start")).toThrow("cpu_profile_unsafe");
  expect(calls).toEqual([]);
  writeFileSync(path, JSON.stringify(valid));
  expect(command("status")).toMatchObject({ states: [{ phase: "idle" }] });
});

test("same-role process lock and stale generation prevent wrong target and replay", async () => {
  const controller = start();
  expect(() => start()).toThrow("cpu_profile_busy");
  command("start");
  const previousRequest = readFileSync(
    join(root, "cpu-profiles", "request.json"),
    "utf8",
  );
  await controller.close();
  controllers.splice(controllers.indexOf(controller), 1);
  const next = start();
  next.sync();
  expect(calls).toEqual([]);
  command("start");
  next.sync();
  await vi.advanceTimersByTimeAsync(1000);
  writeFileSync(join(root, "cpu-profiles", "request.json"), previousRequest);
  next.sync();
  expect(profileFiles()).toHaveLength(1);
});

test("both publishes one target-bound request; another command cannot erase pending work", async () => {
  start("web");
  start();
  const result = command("start", "both");
  expect(result).toMatchObject({ targets: ["web", "background"] });
  expect(() => command("start", "web")).toThrow("cpu_profile_busy");
  expect(command("status", "both")).toMatchObject({
    pending: ["web", "background"],
  });
  expect(() => command("stop", "web")).toThrow("cpu_profile_busy");
  command("stop", "both");
});

test.each([
  [0, 1000],
  [121, 1000],
  [1.5, 1000],
  [1, 999],
  [1, 10001],
  [1, Number.NaN],
])("approved limits reject seconds=%s interval=%s", (seconds, intervalUs) => {
  start();
  expect(() =>
    cpuProfileCommand({
      dataDir: root,
      action: "start",
      target: "background",
      seconds,
      intervalUs,
    }),
  ).toThrow("cpu_profile_invalid_request");
  expect(calls).toEqual([]);
});

test("full count, full bytes, and interrupted temporaries preserve old files and refuse capture", () => {
  const controller = start();
  const names = Array.from(
    { length: CPU_PROFILE_POLICY.maxFilesPerRole },
    fixtureName,
  );
  for (const name of names)
    writeFileSync(join(roleDir, name), "{}", { mode: 0o600 });
  command("start");
  controller.sync();
  expect(state()).toMatchObject({ phase: "failed", code: "capacity" });
  expect(profileFiles()).toHaveLength(10);
  for (const name of names.slice(1)) rmSync(join(roleDir, name));
  truncateSync(
    join(roleDir, names[0] as string),
    CPU_PROFILE_POLICY.maxBytesPerRole,
  );
  command("start");
  controller.sync();
  expect(calls).toEqual([]);
  rmSync(join(roleDir, names[0] as string));
  writeFileSync(join(roleDir, `partial-${randomUUID()}`), "incomplete", {
    mode: 0o600,
  });
  command("start");
  controller.sync();
  expect(state().code).toBe("capacity");
  expect(readdirSync(roleDir).some((n) => n.startsWith("partial-"))).toBe(true);
});

test("output exceeding remaining byte budget is discarded without deleting old evidence", async () => {
  const controller = start();
  const old = join(roleDir, fixtureName());
  writeFileSync(old, "{}", { mode: 0o600 });
  truncateSync(old, CPU_PROFILE_POLICY.maxBytesPerRole - 1);
  command("start");
  controller.sync();
  await vi.advanceTimersByTimeAsync(1000);
  expect(state()).toMatchObject({ phase: "failed", code: "capacity" });
  expect(profileFiles()).toHaveLength(1);
  expect(statSync(old).size).toBe(CPU_PROFILE_POLICY.maxBytesPerRole - 1);
});

test.each(["symlink", "hardlink", "permissions", "oversized", "malformed"])(
  "untrusted request %s cannot trigger inspector",
  (kind) => {
    const controller = start();
    command("start");
    const request = join(root, "cpu-profiles", "request.json");
    if (kind === "symlink") {
      renameSync(request, `${request}.old`);
      symlinkSync(`${request}.old`, request);
    }
    if (kind === "hardlink") linkSync(request, `${request}.old`);
    if (kind === "permissions") chmodSync(request, 0o640);
    if (kind === "oversized") truncateSync(request, 4097);
    if (kind === "malformed")
      writeFileSync(request, '{"secret":"synthetic-value"}');
    controller.sync();
    expect(calls).toEqual([]);
    expect(state().phase).toBe("failed");
  },
);

test.each(["symlink", "hardlink", "permissions"])(
  "unsafe retained profile %s rejects capture",
  (kind) => {
    const controller = start();
    const path = join(roleDir, fixtureName());
    const outside = join(root, "outside");
    writeFileSync(outside, "synthetic-private", { mode: 0o600 });
    if (kind === "symlink") symlinkSync(outside, path);
    else if (kind === "hardlink") linkSync(outside, path);
    else writeFileSync(path, "{}", { mode: 0o644 });
    command("start");
    controller.sync();
    expect(calls).toEqual([]);
    expect(readFileSync(outside, "utf8")).toBe("synthetic-private");
  },
);

test.each(["parent", "role", "lock"])(
  "directory/lock replacement during capture fails closed (%s)",
  async (kind) => {
    const controller = start();
    command("start");
    controller.sync();
    await vi.advanceTimersByTimeAsync(1);
    const path =
      kind === "parent"
        ? join(root, "cpu-profiles")
        : kind === "role"
          ? roleDir
          : join(roleDir, "owner.lock");
    renameSync(path, `${path}.old`);
    if (kind === "lock") writeFileSync(path, "", { mode: 0o600 });
    else mkdirSync(path, { mode: 0o700 });
    if (kind === "parent") mkdirSync(roleDir, { mode: 0o700 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(
      readdirSync(roleDir).filter((n) => n.endsWith(".cpuprofile")),
    ).toEqual([]);
    if (kind !== "parent")
      expect(
        readdirSync(`${roleDir}${kind === "role" ? ".old" : ""}`).filter((n) =>
          n.endsWith(".cpuprofile"),
        ),
      ).toEqual([]);
    else
      expect(
        readdirSync(join(`${path}.old`, "background")).filter((n) =>
          n.endsWith(".cpuprofile"),
        ),
      ).toEqual([]);
  },
);

test("metadata and artifact publication refuse links and never replace existing artifacts", () => {
  const directory = new CpuProfileDirectory(root);
  try {
    writeFileSync(join(root, "outside"), "unchanged", { mode: 0o600 });
    symlinkSync(join(root, "outside"), join(root, "state.json"));
    expect(() => directory.write("state.json", {})).toThrow();
    expect(readFileSync(join(root, "outside"), "utf8")).toBe("unchanged");
    directory.publish("artifact.cpuprofile", Buffer.from("complete"));
    expect(() =>
      directory.publish("artifact.cpuprofile", Buffer.from("different")),
    ).toThrow();
    expect(readFileSync(join(root, "artifact.cpuprofile"), "utf8")).toBe(
      "complete",
    );
    expect(readdirSync(root).some((n) => n.startsWith("partial-"))).toBe(false);
  } finally {
    directory.close();
  }
});

test("unsafe directory permissions and intermediate symlinks fail before registration", () => {
  chmodSync(root, 0o750);
  expect(() => start()).toThrow();
  chmodSync(root, 0o700);
  const alias = join(root, "alias");
  symlinkSync(root, alias);
  expect(
    () => new CpuProfileController({ dataDir: alias, role: "web", sha }),
  ).toThrow();
});
