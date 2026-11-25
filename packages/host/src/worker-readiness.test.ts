import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  agentProcessCommand,
  type ExecutionConfig,
  HC_RELEASE,
} from "@cardigan/runtime-herdr";
import { afterEach, expect, test, vi } from "vitest";
import {
  previousWorkerHelperRelease,
  workerHelperDigests,
} from "./worker-helper-release.js";
import {
  observedHelperRelease,
  workerReadiness,
  workerReadinessScript,
} from "./worker-readiness.js";

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
const reply = (value: Record<string, unknown>) =>
  vi.mocked(agentProcessCommand).mockResolvedValue({
    file: process.execPath,
    args: [
      "-e",
      `process.stdout.write(${JSON.stringify(JSON.stringify({ protocol: 3, matching: true, previous: false, ...value }))})`,
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
    digests: workerHelperDigests(),
    previous: previousWorkerHelperRelease.digests,
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
      "try:\n    paths=",
      `${observations}\ntry:\n    paths=`,
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
          digests: workerHelperDigests(),
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

test("a legacy publication helper is rejected before launch; version alone cannot hide a stale file", async () => {
  reply({
    version: `hc ${HC_RELEASE.version}`,
    failures: [],
    protocol: 1,
    matching: false,
  });
  expect(await workerReadiness(execution)).toEqual([
    "worker helper 落后（已装 1，需要 3）",
  ]);
  reply({ version: `hc ${HC_RELEASE.version}`, failures: [], matching: false });
  expect(await workerReadiness(execution)).toEqual([
    "worker helper 与当前部署的 SHA-256 不一致",
  ]);
});

test("real probe compares a release and a pre-run-command whitelist on a simulated worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-compat-"));
  try {
    for (const name of Object.keys(workerHelperDigests()))
      await copyFile(
        new URL(`../../../deploy/${name}`, import.meta.url),
        join(root, name),
      );
    // Only substitute the fixture's administrator-owned namespace. Keep module loading,
    // protocol detection and checksums identical to the distributed read-only probe.
    vi.mocked(agentProcessCommand).mockImplementation(
      async (_config, args) => ({
        file: "python3",
        args: [
          "-IB",
          "-c",
          workerReadinessScript.replace(
            "try:\n    paths=",
            "protected=lambda path: None\ntry:\n    paths=",
          ),
          args.at(-1) ?? "",
        ],
      }),
    );
    const path = join(root, "worker-files.py");
    const config = {
      ...execution,
      agentRoot: root,
      gitHelper: {
        python: "/usr/bin/python3",
        path: join(root, "worker-git.py"),
      },
      fileHelper: { python: "/usr/bin/python3", path },
    };
    const current = await workerReadiness(config);
    expect(
      current.every((b) => b === "worker_directories" || b === "hc_version"),
    ).toBe(true);
    // A protected older git helper without check_layout is a confirmed release
    // mismatch, even though it also fails the separate capability probe.
    const gitPath = config.gitHelper.path;
    const original = await readFile(gitPath, "utf8");
    await writeFile(
      gitPath,
      original.replace("def check_layout(", "def legacy_layout("),
    );
    expect(await workerReadiness(config)).toEqual(
      expect.arrayContaining([
        "worker helper 与当前部署的 SHA-256 不一致",
        "worker_helpers",
      ]),
    );
    await writeFile(gitPath, original);
    const legacy = (await readFile(path, "utf8"))
      .replace(/^PUBLICATION_PROTOCOL = .*$/mu, "")
      .replace("run-command\\.py|", "");
    expect(legacy).not.toContain("run-command\\.py|");
    await writeFile(path, legacy);
    expect((await workerReadiness(config))[0]).toBe(
      "worker helper 落后（已装 1，需要 3）",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// C-666: the usage report raised the release to protocol 3. A worker still on
// the exact previous release keeps dispatching; only its usage is skipped.
test("the exact previous release is admitted and remembered; other protocol-2 bytes are not", async () => {
  const fingerprint = execution.target?.fingerprint;
  reply({ version: `hc ${HC_RELEASE.version}`, failures: [] });
  expect(await workerReadiness(execution)).toEqual([]);
  expect(observedHelperRelease(fingerprint)).toBe("current");
  reply({
    version: `hc ${HC_RELEASE.version}`,
    failures: [],
    protocol: 2,
    matching: false,
    previous: true,
  });
  expect(await workerReadiness(execution)).toEqual([]);
  expect(observedHelperRelease(fingerprint)).toBe("previous");
  // Any other protocol-2 helper is still a release mismatch, as before.
  reply({
    version: `hc ${HC_RELEASE.version}`,
    failures: [],
    protocol: 2,
    matching: false,
    previous: false,
  });
  expect(await workerReadiness(execution)).toEqual([
    "worker helper 与当前部署的 SHA-256 不一致",
  ]);
  expect(observedHelperRelease(fingerprint)).toBeUndefined();
  // A previous-release claim from a newer protocol is not the previous release.
  reply({
    version: `hc ${HC_RELEASE.version}`,
    failures: [],
    protocol: 3,
    matching: false,
    previous: true,
  });
  expect(await workerReadiness(execution)).toEqual([
    "worker helper 与当前部署的 SHA-256 不一致",
  ]);
  vi.mocked(agentProcessCommand).mockRejectedValueOnce(new Error("offline"));
  expect(await workerReadiness(execution)).toEqual(["worker_unreachable"]);
  expect(observedHelperRelease(fingerprint)).toBeUndefined();
});

test("real probe admits the verbatim previous release (protocol 2) without a helper blocker", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-previous-"));
  try {
    const sha = (bytes: Buffer | string) =>
      createHash("sha256").update(bytes).digest("hex");
    // The previous release: its verbatim worker-git.py, worker-files.py before
    // the protocol bump, and the unchanged worker-primitives.py.
    const files = {
      "worker-git.py": await readFile(
        new URL("../test-support/worker-git-v2.py", import.meta.url),
      ),
      "worker-files.py": Buffer.from(
        (
          await readFile(
            new URL("../../../deploy/worker-files.py", import.meta.url),
            "utf8",
          )
        )
          .replace(/^# 3 \(C-666\): .*\n/mu, "")
          .replace(/^PUBLICATION_PROTOCOL = 3$/mu, "PUBLICATION_PROTOCOL = 2"),
      ),
      "worker-primitives.py": await readFile(
        new URL("../../../deploy/worker-primitives.py", import.meta.url),
      ),
    };
    for (const [name, bytes] of Object.entries(files)) {
      expect(sha(bytes)).toBe(
        previousWorkerHelperRelease.digests[
          name as keyof typeof previousWorkerHelperRelease.digests
        ],
      );
      await writeFile(join(root, name), bytes);
    }
    // The old helper has no usage report; the current one does.
    expect(files["worker-git.py"].toString()).not.toContain("def usage(");
    expect(
      await readFile(
        new URL("../../../deploy/worker-git.py", import.meta.url),
        "utf8",
      ),
    ).toContain("def usage(");
    vi.mocked(agentProcessCommand).mockImplementation(
      async (_config, args) => ({
        file: "python3",
        args: [
          "-IB",
          "-c",
          workerReadinessScript.replace(
            "try:\n    paths=",
            "protected=lambda path: None\ntry:\n    paths=",
          ),
          args.at(-1) ?? "",
        ],
      }),
    );
    const config = {
      ...execution,
      agentRoot: root,
      gitHelper: {
        python: "/usr/bin/python3",
        path: join(root, "worker-git.py"),
      },
      fileHelper: {
        python: "/usr/bin/python3",
        path: join(root, "worker-files.py"),
      },
    };
    const blockers = await workerReadiness(config);
    // Only the fixture's missing directory layout and hc remain.
    expect(
      blockers.every((b) => b === "worker_directories" || b === "hc_version"),
    ).toBe(true);
    expect(observedHelperRelease(config.target?.fingerprint)).toBe("previous");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
