import { spawn } from "node:child_process";
import { once } from "node:events";
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
import { fileURLToPath } from "node:url";
import { toolNames } from "@cardigan/domain";
import {
  type CapabilityProbe,
  configureMachinePlacement,
  loadRunCapacityConfig,
  onboardWorker,
  parseWorkerOnboarding,
  RuntimeTargets,
  WORKER_PROBES,
} from "@cardigan/host";
import {
  readMachineObservations,
  recordAcceptedBrowserPath,
  Store,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { parse, stringify } from "yaml";
import { MachineChecks } from "../../server/src/web/machine-checks.js";
import { machineHost } from "../../server/src/web/machine-host.js";
import { CLI_TOOLS, requireCliTool } from "./command-access.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";
import { runWorkerCommand } from "./worker-wizard.js";

const capabilityProbe = vi.hoisted(() => vi.fn<CapabilityProbe>());
// Onboarding fixtures contain example SSH paths; never contact those endpoints.
vi.mock("@cardigan/host", async (importOriginal) => {
  const host = await importOriginal<typeof import("@cardigan/host")>();
  return {
    ...host,
    onboardWorker: vi.fn(host.onboardWorker),
    observeRegisteredMachine: (
      ...[options, create]: Parameters<typeof host.observeRegisteredMachine>
    ) =>
      host.observeRegisteredMachine(
        { ...options, probe: capabilityProbe },
        create,
      ),
    refreshWorkerObservations: (
      ...args: Parameters<typeof host.refreshWorkerObservations>
    ) =>
      host.refreshWorkerObservations(args[0], args[1], args[2], args[3], {
        ...args[4],
        probe: capabilityProbe,
      }),
  };
});

let root: string, configRoot: string, io: CliIo, lines: string[];
let file: string;
const args = ["--project", "example", "--machine", "worker-a"];
beforeEach(() => {
  capabilityProbe.mockReset().mockResolvedValue({ ok: false, output: "" });
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

test("CLI and Workbench checks use only the dispatch owner's accepted browser directory", async () => {
  await bootstrap();
  const dataDir = join(root, "data"),
    store = Store.open({ dataDir });
  const directory = "/fixture/registry";
  let webPath = directory;
  const execution = { mode: "local" as const, dataDir };
  const host = machineHost(store, execution, "example", io.env, () => webPath);
  const runtimeCheck = vi
    .spyOn(RuntimeTargets.prototype, "check")
    .mockResolvedValue({
      ok: true,
      value: { machine_id: "local", blockers: [], launch_enabled: false },
    });
  const browserScopes = () =>
    capabilityProbe.mock.calls.flatMap(([, , cmd]) =>
      "scopes" in cmd
        ? [cmd.scopes.filter((s) => s.kind === "registry").map((s) => s.value)]
        : [],
    );
  try {
    writeFileSync(
      join(configRoot, "launch.yaml"),
      stringify({
        browser: { command: "/fixture/mcp", browsers_path: directory },
      }),
    );
    recordAcceptedBrowserPath(store, directory);
    expect(await runWorkerCommand(["add", ...args], io, async () => true)).toBe(
      0,
    );
    expect(browserScopes()).toEqual([[directory]]);
    for (const kind of ["machine", "worker"] as const) {
      for (webPath of [directory, "/fixture/unaccepted"]) {
        capabilityProbe.mockClear();
        if (kind === "worker")
          vi.mocked(onboardWorker).mockResolvedValueOnce(true);
        const machine = kind === "worker" ? "worker-a" : "local";
        expect(
          await host.check(
            "example",
            machine,
            kind,
            () => {},
            new AbortController().signal,
            "fixture-job",
          ),
        ).toMatchObject({ status: "passed" });
        expect(browserScopes()).toEqual([
          webPath === directory ? [directory] : [],
        ]);
      }
    }
  } finally {
    runtimeCheck.mockRestore();
    store.close();
  }
});

test("a changed session offers exact-digest confirmation and preserves CLI config selection", async () => {
  await bootstrap();
  const probe = vi.fn(async () => true);
  expect(await runWorkerCommand(["add", ...args], io, probe)).toBe(0);
  const input = parse(readFileSync(file, "utf8"));
  input.runtime.machines[0].projects[0].session = "short";
  writeFileSync(file, stringify(input));
  lines = [];
  expect(await main(["worker", "resume", ...args, "--config", file], io)).toBe(
    1,
  );
  const digest = /--confirm-config ([a-f0-9]{64})/u.exec(lines.join("\n"))?.[1];
  expect(digest).toBeDefined();
  expect(lines.join("\n")).toContain(`--config '${file}'`);
  probe.mockClear();
  expect(
    await runWorkerCommand(
      [
        "resume",
        ...args,
        "--config",
        file,
        "--confirm-config",
        digest as string,
      ],
      io,
      probe,
    ),
  ).toBe(0);
  expect(probe).toHaveBeenCalledTimes(WORKER_PROBES.length);
  for (const mode of ["add", "check", "status"])
    await expect(
      runWorkerCommand(
        [mode, ...args, "--confirm-config", digest as string],
        io,
        probe,
      ),
    ).rejects.toThrow("仅用于 resume");
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

test.skipIf(process.platform !== "linux")(
  "Web joins a live CLI worker by id and reports its final capability failure; the second CLI fails busy",
  async () => {
    await bootstrap();
    expect(await runWorkerCommand(["add", ...args], io, async () => true)).toBe(
      0,
    );
    writeFileSync(
      join(configRoot, "machine-capabilities.yaml"),
      "version: 1\ncapabilities:\n  node:\n    check: [echo, forged]\n",
      { mode: 0o600 },
    );
    const dataDir = join(root, "data");
    const store = Store.open({ dataDir });
    const host = machineHost(store, { mode: "local", dataDir }, "test", io.env);
    const check = vi.fn(host.check);
    const checks = new MachineChecks(
      store,
      { now: () => new Date().toISOString() },
      new AbortController().signal,
      { ...host, check },
    );
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL("../test-support/held-worker-check.mjs", import.meta.url),
        ),
        ...args,
      ],
      {
        env: { ...io.env, PATH: process.env.PATH },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 20_000,
      },
    );
    const closed = once(child, "close");
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (s) => {
      stderr += s;
    });
    child.stdout.resume();
    const latest = () => checks.latest("worker-a", "example", "worker");
    try {
      await vi.waitFor(
        () =>
          expect(latest()).toMatchObject({ status: "running", step: "ssh" }),
        { timeout: 10_000 },
      );
      const actual = latest();
      const joined = checks.start(
        "example",
        "worker-a",
        "machine",
        () => "fixture-human",
      );
      expect(joined).toEqual(actual);
      expect(host.workerRecord("example", "worker-a")).toMatchObject({
        status: "checking",
      });
      const secondProbe = vi.fn(async () => true);
      await expect(
        runWorkerCommand(["check", ...args], io, secondProbe),
      ).rejects.toThrow("worker_busy");
      expect(secondProbe).not.toHaveBeenCalled();
      child.stdin.end("release\n");
      expect(await closed).toEqual([1, null]);
      expect(stderr).toContain("worker_capability_check_failed");
      await checks.settled();
      expect(check).not.toHaveBeenCalled();
      const final = checks.read("worker-a", joined.id);
      expect(final).toMatchObject({
        kind: "worker",
        status: "failed",
        failed_steps: ["capabilities"],
      });
      expect(latest()).toEqual(final);
      expect(host.workerRecord("example", "worker-a")).toEqual({
        status: "failed",
        checked_at: final?.checked_at,
        failed_steps: ["capabilities"],
      });
      expect(
        store.uow.read((tx) => tx.global_events.listAfter(0)),
      ).toContainEqual(
        expect.objectContaining({
          type: "machine_check_joined",
          payload: expect.objectContaining({ check_id: joined.id }),
        }),
      );
    } finally {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
      store.close();
    }
  },
  30_000,
);

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

test.each(["wizard", "capability"] as const)(
  "registry change during %s probes cannot certify a different platform",
  async (phase) => {
    await bootstrap();
    const project = "example",
      machine = "worker-a",
      dataDir = join(root, "data");
    const version = { ok: true, output: "codex-cli 1.2.3" };
    capabilityProbe.mockImplementation(async (_e, _os, command) =>
      !("scopes" in command) && command[0] === "codex"
        ? version
        : { ok: false, output: "" },
    );
    expect(await runWorkerCommand(["add", ...args], io, async () => true)).toBe(
      0,
    );
    const input = parse(readFileSync(file, "utf8"));
    input.runtime.machines[0].projects[0].allow_remote_launch = true;
    const enable = () =>
      writeFileSync(
        join(configRoot, "runtime-workers.yaml"),
        stringify(parseWorkerOnboarding(input, dataDir).runtime),
        { mode: 0o600 },
      );
    enable();
    const store = Store.open({ dataDir });
    try {
      configureMachinePlacement(
        store,
        dataDir,
        io.env,
        await loadRunCapacityConfig({ env: io.env }),
        () => undefined,
      );
      const placement = () =>
        store.uow.run((tx) =>
          tx
            .read_machine_placement?.(project, new Date().toISOString())
            .machines.get(machine),
        );
      expect(placement()).toMatchObject({
        remote_binding: "allowed",
        observation_target_matches: true,
        capabilities: [{ key: "harness.codex", version: "1.2.3" }],
      });
      const changeRegistry = async () => {
        expect(
          await main(
            [
              "machine",
              "update",
              machine,
              "--project",
              project,
              "--arch",
              "arm64",
            ],
            io,
          ),
        ).toBe(0);
      };
      capabilityProbe
        .mockClear()
        .mockImplementation(async (_e, _os, command) => {
          if ("scopes" in command || command[0] !== "codex")
            return { ok: false, output: "" };
          if (phase === "capability") await changeRegistry();
          return version; // Result from the x64 worker, even when the registry now says arm64.
        });
      await expect(
        runWorkerCommand(["check", ...args], io, async (step) => {
          if (phase === "wizard" && step === "mcp") await changeRegistry();
          return true;
        }),
      ).rejects.toThrow(
        phase === "wizard"
          ? "worker_identity_conflict"
          : "worker_capability_check_failed",
      );
      if (phase === "wizard") expect(capabilityProbe).not.toHaveBeenCalled();
      input.runtime.machines[0].arch = "arm64";
      enable();
      expect(placement()).toMatchObject({
        remote_binding: "allowed",
        observation_target_matches: false,
      });
    } finally {
      store.close();
    }
  },
);

test("apply-config dry-run describes drain and both checks without opening the registry", async () => {
  expect(
    await runWorkerCommand(["apply-config", ...args, "--dry-run"], io),
  ).toBe(0);
  expect(lines.join(" ")).toMatch(/排空.*worker.*机器/u);
  await expect(
    runWorkerCommand(["apply-config", ...args], {
      ...io,
      env: { ...io.env, MCP_TOKEN: "fixture" },
    }),
  ).rejects.toThrow(/人类/u);
});
