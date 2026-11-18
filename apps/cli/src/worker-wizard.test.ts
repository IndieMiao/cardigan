import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolNames } from "@cardigan/domain";
import { WORKER_PROBES } from "@cardigan/host";
import { readMachineObservations, Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { parse, stringify } from "yaml";
import { CLI_TOOLS, requireCliTool } from "./command-access.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";
import { runWorkerCommand } from "./worker-wizard.js";

let root: string, configRoot: string, io: CliIo, lines: string[];
let file: string;
const args = ["--project", "example", "--machine", "worker-a"];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "worker-cli-"));
  configRoot = join(root, "config");
  mkdirSync(configRoot, { mode: 0o700 });
  file = join(configRoot, "worker-worker-a-example.yaml");
  lines = [];
  io = {
    cwd: root,
    platform: "linux",
    env: {
      CARDIGAN_DATA_DIR: join(root, "data"),
      CARDIGAN_CONFIG_DIR: configRoot,
    },
    signals: { on() {}, off() {} },
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
    spawnInherit: () => {
      throw new Error("unexpected spawn");
    },
    captureCommand: async () => {
      throw new Error("unexpected process");
    },
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
async function bootstrap() {
  expect(await main(["init"], io)).toBe(0);
  expect(await main(["project", "create", "example"], io)).toBe(0);
  const input = {
    version: 1,
    uid: 2201,
    home: "/home/cg_example",
    mcp_url: "https://control.example.ts.net/mcp",
    runtime: {
      version: 1,
      machines: [
        {
          id: "worker-a",
          os: "linux",
          arch: "x64",
          host: "worker.invalid",
          port: 22,
          identity_file: "/private/identity",
          known_hosts_file: "/private/known_hosts",
          host_key_alias: "worker-a",
          projects: [
            {
              project_id: "example",
              user: "cg_example",
              gid: 2201,
              alias: "example-a",
              session: "example-a",
              root: "/workers/example",
              path: "/usr/local/bin:/usr/bin:/bin",
              generation: "one",
              publication: {
                header_max_bytes: 65536,
                file_max_bytes: 1048576,
                batch_max_bytes: 8388608,
                timeout_ms: 30000,
              },
              python: "/usr/bin/python3",
              file_helper: "/workers/example/libexec/worker-files.py",
              git_helper: "/workers/example/libexec/worker-git.py",
            },
          ],
        },
      ],
    },
  };
  writeFileSync(file, stringify(input), { mode: 0o600 });
  lines = [];
}
function machines() {
  const store = Store.open({ dataDir: join(root, "data") });
  try {
    return store.uow.read((tx) => tx.machines.list("example"));
  } finally {
    store.close();
  }
}

test("macOS add/resume/check/status preserve offline identity and recheck capacity", async () => {
  await bootstrap();
  const guide = readFileSync(
    new URL("../../../docs/macos-worker.md", import.meta.url),
    "utf8",
  );
  const input = parse(/```yaml\n([\s\S]*?)```/u.exec(guide)?.[1] ?? "");
  writeFileSync(file, stringify(input));
  writeFileSync(
    join(configRoot, "run-capacity.yaml"),
    stringify({ machines: { "worker-a": { limit: 1, max_limit: 1 } } }),
    { mode: 0o600 },
  );
  const probe = vi.fn(async () => true);
  for (const mode of ["add", "resume", "check", "status"]) {
    probe.mockClear();
    expect(await runWorkerCommand([mode, ...args], io, probe)).toBe(0);
    expect(probe).toHaveBeenCalledTimes(
      mode === "status" ? 0 : WORKER_PROBES.length,
    );
    expect(machines().filter((machine) => machine.id === "worker-a")).toEqual([
      expect.objectContaining({
        os: "darwin",
        arch: "arm64",
        status: "offline",
      }),
    ]);
  }
  expect(lines.join("\n")).not.toContain("systemctl");
});

test.each(["add", "resume", "check", "status"] as const)(
  "worker %s is human-only even with all Assignment capabilities",
  async (command) => {
    expect(CLI_TOOLS[`worker ${command}`]).toBeNull();
    expect(() =>
      requireCliTool(
        {
          kind: "assignment",
          project_id: "example",
          assignment_id: "A-1" as never,
          role_id: "pm",
          role_version: 1,
          allowed_tools: toolNames,
          capabilities: [],
        },
        `worker ${command}`,
      ),
    ).toThrow("仅限人类");
    for (const tokenIo of [
      { ...io, env: { ...io.env, CARDIGAN_TOKEN: "SYNTHETIC_TOKEN" } },
      { ...io, env: { ...io.env, MCP_TOKEN: "SYNTHETIC_TOKEN" } },
      { ...io, tokenFile: join(root, "missing") },
    ]) {
      expect(
        await main(["worker", command, ...args, "--dry-run"], tokenIo),
      ).not.toBe(0);
      await expect(
        runWorkerCommand([command, ...args], tokenIo),
      ).rejects.toThrow("仅限人类");
    }
    expect(readdirSync(root)).toEqual(["config"]);
    expect(lines.join("\n")).not.toContain("SYNTHETIC_TOKEN");
  },
);

test("worker check reports a failed capability refresh instead of claiming success", async () => {
  await bootstrap();
  writeFileSync(
    join(configRoot, "machine-capabilities.yaml"),
    "version: 1\ncapabilities:\n  node:\n    check: [echo, forged]\n",
    { mode: 0o600 },
  );
  await expect(
    runWorkerCommand(["add", ...args], io, async () => true),
  ).rejects.toThrow("worker_capability_check_failed");
  const store = Store.open({ dataDir: join(root, "data") });
  try {
    expect(
      readMachineObservations(store, "example", "worker-a").health,
    ).toMatchObject({ status: "failed", available: false });
    expect(lines.join("\n")).not.toContain("接入检查通过");
  } finally {
    store.close();
  }
});

test("dry-run has no filesystem, database or process side effects even with nonexistent configuration", async () => {
  const probe = vi.fn(async () => true);
  expect(
    await runWorkerCommand(
      [
        "add",
        ...args,
        "--host",
        "worker.invalid",
        "--config",
        join(root, "missing"),
        "--dry-run",
      ],
      io,
      probe,
    ),
  ).toBe(0);
  expect(probe).not.toHaveBeenCalled();
  expect(readdirSync(root)).toEqual(["config"]);
  expect(readdirSync(configRoot)).toEqual([]);
  expect(lines.join("\n")).toContain("dry-run");
});

test("actual CLI registers offline once, creates draft, and repeats without changing identity or state", async () => {
  await bootstrap();
  const probe = vi.fn(async () => true);
  expect(
    await runWorkerCommand(
      ["add", ...args, "--host", "worker.invalid"],
      io,
      probe,
    ),
  ).toBe(0);
  const first = machines();
  expect(first.filter((m) => m.id === "worker-a")).toMatchObject([
    { status: "offline", arch: "x64", os: "linux" },
  ]);
  expect(await runWorkerCommand(["resume", ...args], io, probe)).toBe(0);
  expect(machines()).toEqual(first);
  expect(probe).toHaveBeenCalledTimes(WORKER_PROBES.length * 2);
  expect(existsSync(join(configRoot, "runtime-workers.yaml"))).toBe(false);
  expect(await main(["worker", "status", ...args], io)).toBe(0);
  const output = lines.join("\n");
  expect(output).toContain("recorded_at");
  for (const value of [
    "worker.invalid",
    "/private/identity",
    "cg_example",
    "control.example.ts.net",
    "identity_file:",
  ])
    expect(output).not.toContain(value);
});

test("existing draining machine and descriptive label are preserved", async () => {
  await bootstrap();
  expect(
    await main(
      [
        "machine",
        "register",
        "worker-a",
        "--project",
        "example",
        "--label",
        "Worker A",
        "--os",
        "linux",
        "--arch",
        "x64",
        "--status",
        "draining",
      ],
      io,
    ),
  ).toBe(0);
  const first = machines();
  expect(await runWorkerCommand(["add", ...args], io, async () => true)).toBe(
    0,
  );
  expect(machines()).toEqual(first);
});

test("check cannot register an absent machine, and physical metadata conflicts block before SSH", async () => {
  await bootstrap();
  const probe = vi.fn(async () => true);
  expect(await runWorkerCommand(["check", ...args], io, probe)).toBe(1);
  expect(machines().some((m) => m.id === "worker-a")).toBe(false);
  expect(
    await main(
      [
        "machine",
        "register",
        "worker-a",
        "--project",
        "example",
        "--label",
        "Worker A",
        "--os",
        "linux",
        "--arch",
        "arm64",
      ],
      io,
    ),
  ).toBe(0);
  expect(await runWorkerCommand(["add", ...args], io, probe)).toBe(1);
  expect(probe).not.toHaveBeenCalled();
});

test("invalid config and host override fail closed without exposing content", async () => {
  await bootstrap();
  const probe = vi.fn(async () => true);
  await expect(
    runWorkerCommand(
      ["add", ...args, "--host", "different.invalid"],
      io,
      probe,
    ),
  ).rejects.toThrow("worker_identity_conflict");
  writeFileSync(
    file,
    `${readFileSync(file, "utf8")}\ntoken: SYNTHETIC_SECRET\n`,
  );
  expect(await main(["worker", "add", ...args], io)).toBe(1);
  expect(lines.join("\n")).not.toContain("SYNTHETIC_SECRET");
  expect(probe).not.toHaveBeenCalled();
  expect(machines().some((m) => m.id === "worker-a")).toBe(false);
});
