import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  agentProcessCommand,
  type ExecutionConfig,
  HC_RELEASE,
} from "@cardigan/runtime-herdr";
import { afterEach, expect, test, vi } from "vitest";
import { workerReadiness, workerReadinessScript } from "./worker-readiness.js";

vi.mock("@cardigan/runtime-herdr", async (original) => ({
  ...(await original<typeof import("@cardigan/runtime-herdr")>()),
  agentProcessCommand: vi.fn(),
}));
const execution: Extract<ExecutionConfig, { mode: "agent-ssh" }> = {
  mode: "agent-ssh",
  dataDir: "/private/data",
  agentRoot: "/workers/fixture",
  machine: "fixture-worker",
  gid: 2001,
  host: "worker.invalid",
  user: "fixture",
  identityFile: "/private/key",
  knownHostsFile: "/private/known-hosts",
  path: "/usr/bin:/bin",
  target: {
    project_id: "fixture",
    machine_id: "worker-a",
    session: "fixture",
    generation: "one",
    fingerprint: "a".repeat(64),
  },
  gitHelper: { python: "/usr/bin/python3", path: "/opt/worker/worker-git.py" },
  fileHelper: {
    python: "/usr/bin/python3",
    path: "/opt/worker/worker-files.py",
  },
};
afterEach(() => vi.resetAllMocks());
const reply = (value: unknown) =>
  vi.mocked(agentProcessCommand).mockResolvedValue({
    file: process.execPath,
    args: [
      "-e",
      `process.stdout.write(${JSON.stringify(JSON.stringify(value))})`,
    ],
  });

test("successful observations are collected through the pinned SSH entry with fixed read-only arguments", async () => {
  reply({ version: `hc ${HC_RELEASE.version}`, failures: [] });
  expect(await workerReadiness(execution)).toEqual([]);
  const [config, args] = vi.mocked(agentProcessCommand).mock.calls[0] ?? [];
  expect(config).toBe(execution);
  expect(args?.slice(0, 5)).toEqual([
    "/usr/bin/python3",
    "-I",
    "-B",
    "-c",
    workerReadinessScript,
  ]);
  expect(JSON.parse(args?.[5] ?? "null")).toEqual({
    root: "/workers/fixture",
    gid: 2001,
    project: "fixture",
    git_helper: "/opt/worker/worker-git.py",
    file_helper: "/opt/worker/worker-files.py",
  });
});
test.each(["hc 0.0.1", "SECRET", null])(
  "an incompatible or missing live version (%s) fails",
  async (version) => {
    reply({ version, failures: [] });
    expect(await workerReadiness(execution)).toEqual(["hc_version"]);
  },
);
test.each(["worker_directories", "worker_helpers"])(
  "actual %s failure is preserved",
  async (failure) => {
    reply({ version: `hc ${HC_RELEASE.version}`, failures: [failure] });
    expect(await workerReadiness(execution)).toEqual([failure]);
  },
);
test("malformed replies and transport errors never leak raw diagnostics or pass", async () => {
  reply({ version: `hc ${HC_RELEASE.version}`, failures: ["SECRET"] });
  expect(await workerReadiness(execution)).toEqual(["worker_unreachable"]);
  reply({ version: `hc ${HC_RELEASE.version}` });
  expect(await workerReadiness(execution)).toEqual(["worker_unreachable"]);
  vi.mocked(agentProcessCommand).mockRejectedValueOnce(new Error("SECRET"));
  expect(await workerReadiness(execution)).toEqual(["worker_unreachable"]);
});
test("a missing helper fails without SSH", async () => {
  const { gitHelper: _, ...missing } = execution;
  expect(await workerReadiness(missing)).toEqual(["worker_helpers"]);
  expect(agentProcessCommand).not.toHaveBeenCalled();
});
test("the actual Python probe refuses worker-writable helpers before importing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-probe-"));
  try {
    const helper = join(root, "worker-git.py");
    await writeFile(helper, "raise Exception('SECRET helper executed')\n");
    const { stdout, stderr } = await promisify(execFile)(
      "python3",
      [
        "-I",
        "-B",
        "-c",
        workerReadinessScript,
        JSON.stringify({
          root,
          gid: 2001,
          project: "fixture",
          git_helper: helper,
          file_helper: helper,
        }),
      ],
      { timeout: 10000 },
    );
    const report = JSON.parse(stdout);
    expect(report.failures).toEqual(["worker_helpers", "worker_directories"]);
    expect(stdout + stderr).not.toContain("SECRET");
    expect(stderr).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["Darwin", "share-everyone", true],
  ["Darwin", "share-process-only", true],
  ["Darwin", "firmlink-root", false],
  ["Darwin", "firmlink-helper", false],
  ["Darwin", "process-admin", false],
  ["Darwin", "share-direct-name", false],
  ["Darwin", "membership-unavailable", false],
  ["Linux", "safe", true],
  ["Linux", "linux-implicit", false],
  ["Linux", "linux-share", false],
] as const)(
  "%s readiness applies the shared group policy to %s",
  async (system, fixture, accepted) => {
    const [observations, native_source, group_fixture] = await Promise.all([
      readFile(
        new URL(
          "../test-support/worker-readiness-observations.py",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL("../../../deploy/worker-primitives.py", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL(
          "../../../test-support/worker-account-observations.py",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);
    const source = workerReadinessScript.replace(
      "try:\n    git=module",
      `${observations}\ntry:\n    git=module`,
    );
    const { stdout, stderr } = await promisify(execFile)(
      "python3",
      [
        "-I",
        "-B",
        "-c",
        source,
        JSON.stringify({
          root:
            fixture === "firmlink-root"
              ? "/System/Volumes/Data/Users/fixture"
              : "/Users/fixture",
          gid: 2201,
          project: "example",
          git_helper:
            fixture === "firmlink-helper"
              ? "/System/Volumes/Data/Users/fixture/git.py"
              : "/Users/fixture/git.py",
          file_helper: "/Users/fixture/files.py",
          version: `hc ${HC_RELEASE.version}`,
          system,
          fixture,
          native_source,
          group_fixture,
        }),
      ],
      { timeout: 3000 },
    );
    expect(stderr).toBe("");
    expect(JSON.parse(stdout).failures).toEqual(
      accepted ? [] : ["worker_directories"],
    );
  },
);
