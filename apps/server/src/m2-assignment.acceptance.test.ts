/**
 * M2.6 end-to-end: `cardigan assignment start` against a real server, a real
 * herdr-core (own hc session and socket) and a fake Agent that reads MCP_TOKEN,
 * calls whoami/get_card and reports OSC 7501 idle.
 *
 * Plan references: docs/plans/phase-1-m2.md §3 (names and paths), §4 (flow) and
 * §5 M2.6.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentNameFor, main as cli } from "@cardigan/cli";
import type { Assignment } from "@cardigan/domain";
import { RuntimeTargets } from "@cardigan/host";
import { Store } from "@cardigan/store";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TEST_HC_VERSION, testHcBinary } from "../../../test-support/hc.js";
import { createTestRuntime } from "../../../test-support/paths.js";
import { HcCore, runCleanupSteps } from "../test-support/hc.js";
import { type CardiganServer, startCardiganServer } from "./server.js";

const HC_VERSION = TEST_HC_VERSION;
const SESSION = `m2t1-${process.pid}-${Math.floor(Date.now() / 1000) % 100000}`;
const SDK = join(
  import.meta.dirname,
  "..",
  "node_modules",
  "@modelcontextprotocol",
  "sdk",
  "dist",
  "esm",
);

const available = Boolean(testHcBinary());

let root: string;
let dataDir: string;
let runtimeDir: string;
let server: CardiganServer;
let output: string[] = [];
let errors: string[] = [];
let socketPath: string;
let core: HcCore;

/** Derive the expectation from trusted configuration, then compare the stored and real terminal names. */
async function expectedAgentName(
  store: Store,
  project_id: string,
  assignment: Assignment,
): Promise<string> {
  const targets = await RuntimeTargets.create({
    execution: { mode: "local", dataDir },
    store,
    project: project_id,
    session: SESSION,
    env: { CARDIGAN_CONFIG_DIR: join(root, "config") },
  });
  if (!targets.ok) throw new Error(targets.error.code);
  const binding = targets.value.resolve(project_id, assignment.machine_id)
    .execution.target;
  if (!binding) throw new Error("Missing trusted target binding");
  expect(assignment.runtime_ref?.target).toEqual(binding);
  expect(binding).toMatchObject({
    project_id,
    machine_id: assignment.machine_id,
    session: SESSION,
  });
  const expected = agentNameFor({
    role_id: assignment.role_id,
    project_id,
    assignment_id: assignment.id,
    machine_id: assignment.machine_id,
    execution_identity: binding.fingerprint,
  });
  expect(expected).toMatch(/^[a-z0-9_-]{1,32}$/u);
  expect(assignment.runtime_ref?.agent_name).toBe(expected);
  return expected;
}

/** Run the CLI in-process so failures surface as thrown errors with stack. */
async function cardigan(
  argv: readonly string[],
): Promise<{ code: number; out: string; err: string }> {
  output = [];
  errors = [];
  const code = await cli([...argv], {
    env: {
      ...process.env,
      CARDIGAN_DATA_DIR: dataDir,
      CARDIGAN_CONFIG_DIR: join(root, "config"),
      XDG_RUNTIME_DIR: runtimeDir,
      CARDIGAN_HC_SESSION: SESSION,
      PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
    },
    cwd: root,
    platform: process.platform,
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("assignment start must not spawn a CLI");
    },
    captureCommand: async (command, args, options) => {
      if (command === "pi" && args[0] === "--version") {
        return { code: 0, stdout: "pi 1.5.0-fake\n", stderr: "" };
      }
      const result = spawnSync(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
      });
      return {
        code: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
  });
  return { code, out: output.join("\n"), err: errors.join("\n") };
}

/** Environment every host process (CLI, hc, git) shares. */
let hostEnv: Record<string, string> = {};
let savedEnv: NodeJS.ProcessEnv = {};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(
  label: string,
  probe: () => T | undefined,
  timeoutMs = 30000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}

function writeFile(path: string, content: string, mode = 0o755): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, mode);
}

/** A source repository the host can clone from. */
function sourceRepo(name: string): string {
  const repo = join(root, "src", name);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "init",
  ]);
  return repo;
}

/** Project, role, card and one coder Assignment, all through the CLI/domain. */
async function seedProject(
  project: string,
  repo: string,
  cardTitle: string,
): Promise<string> {
  expect(
    (
      await cardigan([
        "project",
        "create",
        project,
        "--code",
        `T${project
          .replace(/[^a-z0-9]/gu, "")
          .slice(0, 3)
          .toUpperCase()}`,
      ])
    ).code,
  ).toBe(0);
  expect(
    (
      await cardigan([
        "project",
        "set-repo",
        "--project",
        project,
        "--path",
        repo,
      ])
    ).code,
  ).toBe(0);
  writeFileSync(
    join(root, "config", "role.yaml"),
    [
      "role_id: coder",
      "display_name: Coder",
      "kind: work",
      "core_prompt: |",
      "  你负责实现并交付。",
      "harness: pi",
      "launch_profile_ref: pi-agent",
      "allowed_tools: [whoami, get_card, get_updates, ack_events]",
      "worktree: write",
      "",
    ].join("\n"),
  );
  expect(
    (
      await cardigan([
        "role",
        "add",
        "--file",
        join(root, "config", "role.yaml"),
        "--project",
        project,
      ])
    ).code,
  ).toBe(0);
  for (const role of ["reviewer", "pm"])
    expect(
      (
        await cardigan([
          "role",
          "add",
          project,
          role,
          "--allowed-tools",
          "submit_review",
        ])
      ).code,
    ).toBe(0);
  // C-684: a person opens dev cards only once the project allows them.
  expect(
    (
      await cardigan([
        "preference",
        "set",
        "human-card-templates",
        "dev",
        "on",
        "--project",
        project,
      ])
    ).code,
  ).toBe(0);
  expect(
    (
      await cardigan([
        "card",
        "create",
        "--template",
        "dev",
        "--title",
        cardTitle,
        "--goal",
        "fixture",
        "--acceptance",
        "it runs",
        "--repo",
        "example/repo",
        "--project",
        project,
      ])
    ).code,
  ).toBe(0);

  return "C-1";
}

function hc(args: string[]): string {
  return execFileSync("hc", args, {
    encoding: "utf8",
    env: { ...process.env, HC_SESSION: SESSION, HC_SOCKET: socketPath },
  });
}

describe.skipIf(!available)("assignment start end to end", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "cardigan-m26-"));
    dataDir = join(root, "data");
    runtimeDir = createTestRuntime(join(root, "run"));
    socketPath = join(runtimeDir, "cardigan", `${SESSION}.sock`);
    core = new HcCore(SESSION, socketPath, {});
    hostEnv = {
      CARDIGAN_DATA_DIR: dataDir,
      CARDIGAN_CONFIG_DIR: join(root, "config"),
      XDG_RUNTIME_DIR: runtimeDir,
      HC_SESSION: SESSION,
      CARDIGAN_HC_SESSION: SESSION,
      PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
    };
    mkdirSync(runtimeDir, { recursive: true });
    // The runtime adapter reads the process environment, not the CLI's env.
    savedEnv = { ...process.env };
    for (const [key, value] of Object.entries(hostEnv))
      process.env[key] = value;
    expect((await cardigan(["init"])).code).toBe(0);

    server = await startCardiganServer({
      config: { dataDir, host: "127.0.0.1", port: 0 },
    });

    // The fake harness: `pi` on PATH, plus the Agent program it runs.
    writeFile(
      join(root, "bin", "pi"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "pi 1.5.0-fake"; exit 0; fi
exec "${process.execPath}" "${join(root, "agent.mjs")}" "$@"
`,
    );
    writeFile(
      join(root, "agent.mjs"),
      `import { renameSync, writeFileSync } from "node:fs";
import { Client } from "${join(SDK, "client", "index.js")}";
import { StreamableHTTPClientTransport } from "${join(SDK, "client", "streamableHttp.js")}";
const client = new Client({ name: "fake-agent", version: "0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(process.env.CARDIGAN_MCP_URL), {
    requestInit: { headers: { Authorization: \`Bearer \${process.env.MCP_TOKEN}\` } },
  }),
);
const who = await client.callTool({ name: "whoami", arguments: {} });
const card = await client.callTool({
  name: "get_card",
  arguments: { card_id: process.env.CARDIGAN_CARD_ID },
});
// Write then rename so the test never reads a half-written report.
writeFileSync(
  process.env.CARDIGAN_REPORT + ".tmp",
  JSON.stringify({ who: who.structuredContent ?? who, card: card.structuredContent ?? card }),
);
renameSync(process.env.CARDIGAN_REPORT + ".tmp", process.env.CARDIGAN_REPORT);
process.stdout.write("\\u001b]7501;state=idle\\u0007");
setInterval(() => {}, 1000);
`,
    );

    // Launch profile: the fake harness plus the values the fake Agent needs.
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(
      join(root, "config", "launch.yaml"),
      [
        "providers:",
        "  fake:",
        "    harness: pi",
        "    env:",
        `      CARDIGAN_MCP_URL: ${server.url}`,
        "      CARDIGAN_CARD_ID: C-1",
        "profiles:",
        "  codex-agent: {harness: codex}",
        "  pi-agent:",
        "    harness: pi",
        "    provider: fake",
        "    model: fictional-model",
        "",
      ].join("\n"),
    );
  });

  afterAll(async () => {
    // Order matters (§P2a-2): the server drains every hc-calling task first.
    await runCleanupSteps({
      session: SESSION,
      socket: socketPath ?? "",
      steps: [
        { label: "close server", run: () => server?.close() },
        {
          label: "restore process environment",
          run: () => {
            process.env = savedEnv;
          },
        },
        { label: "stop herdr-core", run: () => core?.finalStop() },
        { label: "stop herdr-core again", run: () => core?.finalStop() },
        {
          label: "verify herdr-core stopped",
          run: () => core?.assertStopped(),
        },
        {
          label: "remove temporary directory",
          run: () => {
            if (root) rmSync(root, { recursive: true, force: true });
          },
        },
      ],
    });
  }, 120_000);

  test("a coder Assignment starts, the Run advances and the Agent reads its task", async () => {
    const repo = sourceRepo("p-one");
    await seedProject("p-one", repo, "Fictional card");

    const report = join(root, "report.json");
    process.env.CARDIGAN_REPORT = report;
    writeFileSync(
      join(root, "config", "launch.yaml"),
      readFileSync(join(root, "config", "launch.yaml"), "utf8").replace(
        "      CARDIGAN_CARD_ID: C-1",
        `      CARDIGAN_CARD_ID: C-1\n      CARDIGAN_REPORT: ${report}`,
      ),
    );

    let terminalRef = "",
      expectedName = "";
    // One command from a card to a running Agent (plan §5 M2.6).
    const result = await cardigan([
      "assign",
      "W-1",
      "--role",
      "coder",
      "--start",
      "--project",
      "p-one",
      "--mcp-url",
      server.url,
    ]);
    expect(result.code, result.err).toBe(0);
    core.remember();
    expect(result.out).toContain("已启动 A-1");

    const store = Store.open({ dataDir });
    try {
      const assignment = store.uow.read((tx) =>
        tx.assignments.get("p-one" as never, "A-1" as never),
      );
      const run = store.uow.read((tx) => tx.runs.list("p-one" as never)[0]);
      if (!assignment) throw new Error("Missing Assignment");
      expectedName = await expectedAgentName(store, "p-one", assignment);
      // The terminal is recorded before the Agent has spoken.
      expect(assignment?.runtime_ref?.terminal_ref).toMatch(/^t[a-z0-9]+$/u);
      terminalRef = assignment?.runtime_ref?.terminal_ref ?? "";
      expect(assignment?.worktree_path).toBe(
        join(dataDir, "agent", "worktrees", "p-one", "A-1"),
      );
      expect(assignment?.branch).toBe("agent/C-1/W-1");
      expect(run?.status).toBe("dispatched");

      // Wait for the Agent to read its task; the Run then advances.
      try {
        await until("the agent report", () =>
          existsSync(report) ? true : undefined,
        );
      } catch (error) {
        // Surface what the fake Agent printed so a broken launch is debuggable.
        const terminals = JSON.parse(hc(["ls", "--all", "--json"]))
          .terminals as Array<{
          id: string;
        }>;
        const screen = terminals.map((t) => {
          try {
            return `--- ${t.id}\n${hc(["read", t.id])}`;
          } catch {
            return `--- ${t.id} (unreadable)`;
          }
        });
        throw new Error(`${(error as Error).message}\n${screen.join("\n")}`);
      }
      const payload = JSON.parse(readFileSync(report, "utf8")) as {
        who: { assignment_id: string };
        card: { card: { id: string } };
      };
      expect(payload.who.assignment_id).toBe("A-1");
      expect(payload.card.card.id).toBe("C-1");

      const running = await until("the Run to be running", () => {
        const current = store.uow.read((tx) =>
          tx.runs.get("p-one" as never, run?.id as never),
        );
        return current?.status === "running" ? current : undefined;
      });
      expect(running.agent_cli_version).toBe("pi 1.5.0-fake");
      const item = store.uow.read((tx) =>
        tx.work_items.list("p-one" as never).find((w) => w.role_id === "coder"),
      );
      expect(item?.status).toBe("in_progress");

      // The Run went queued -> dispatched -> running, in order.
      const events = store
        .getUpdates({
          project_id: "p-one" as never,
          card_id: "C-1" as never,
          since_seq: 0,
        })
        .events.map((event) => event.type)
        .filter((type) => type.startsWith("run_"));
      expect(events).toEqual(["run_queued", "run_dispatched", "run_started"]);
    } finally {
      store.close();
    }

    // Worktree on the agreed path and branch.
    const worktree = join(dataDir, "agent", "worktrees", "p-one", "A-1");
    expect(existsSync(join(worktree, "README.md"))).toBe(true);
    expect(
      execFileSync(
        "git",
        ["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"],
        { encoding: "utf8" },
      ).trim(),
    ).toBe("agent/C-1/W-1");

    // Terminal name and labels (hc get <t> --json).
    const terminal = JSON.parse(hc(["get", terminalRef, "--json"])) as {
      name: string;
      labels: Record<string, string>;
      state: string;
      status: { state?: string } | null;
    };
    expect(terminal.name).toBe(expectedName);
    expect(terminal.labels).toMatchObject({
      cardigan: "1",
      project: "p-one",
      assignment: "A-1",
    });
    // The fake Agent reported OSC 7501 idle, so hc knows it is waiting.
    expect(terminal.state).toBe("live");
    expect(terminal.status).toEqual({ state: "idle" });

    // The run directory holds no token file after the wrapper ran.
    const runDir = join(dataDir, "runs", "p-one", "A-1");
    expect(existsSync(join(runDir, "token"))).toBe(false);
    expect(existsSync(join(runDir, "launch.sh"))).toBe(true);
  }, 120000);

  test("starting the same Assignment twice is refused", async () => {
    const again = await cardigan([
      "assignment",
      "start",
      "A-1",
      "--project",
      "p-one",
      "--mcp-url",
      server.url,
    ]);
    expect(again.code).not.toBe(0);
    expect(again.err).toContain("invariant_violation");
  }, 60000);

  test("two projects that both have A-1 start independently", async () => {
    // A second project with its own repository and card; both use W-1/A-1.
    await seedProject("p-two", sourceRepo("p-two"), "Second card");

    const result = await cardigan([
      "assign",
      "W-1",
      "--role",
      "coder",
      "--start",
      "--project",
      "p-two",
      "--mcp-url",
      server.url,
    ]);
    expect(result.code, result.err).toBe(0);
    core.remember();

    const store2 = Store.open({ dataDir });
    try {
      const one = store2.uow.read((tx) =>
        tx.assignments.get("p-one" as never, "A-1" as never),
      );
      const two = store2.uow.read((tx) =>
        tx.assignments.get("p-two" as never, "A-1" as never),
      );
      expect(one?.worktree_path).toBe(
        join(dataDir, "agent", "worktrees", "p-one", "A-1"),
      );
      expect(two?.worktree_path).toBe(
        join(dataDir, "agent", "worktrees", "p-two", "A-1"),
      );
      // Full project and execution identities distinguish equal Assignment IDs.
      expect(one?.runtime_ref?.terminal_ref).not.toBe(
        two?.runtime_ref?.terminal_ref,
      );
      expect(one?.runtime_ref?.agent_name).not.toBe(
        two?.runtime_ref?.agent_name,
      );
      if (!one || !two) throw new Error("Missing project Assignment");
      for (const [project, assignment] of [
        ["p-one", one],
        ["p-two", two],
      ] as const) {
        const expected = await expectedAgentName(store2, project, assignment);
        const terminal = JSON.parse(
          hc(["get", assignment.runtime_ref?.terminal_ref ?? "", "--json"]),
        );
        expect(terminal.name).toBe(expected);
        expect(terminal.labels).toMatchObject({
          project,
          assignment: assignment.id,
        });
      }
    } finally {
      store2.close();
    }
  }, 120000);

  test("a token stops working once the Assignment is stopped", async () => {
    const store = Store.open({ dataDir });
    let assignment:
      | { runtime_ref?: { terminal_ref: string } | null }
      | undefined;
    // Issue a token while the Agent runs: the one in the run directory is
    // already gone, because launch.sh deletes it.
    const issued = await cardigan([
      "token",
      "issue",
      "A-1",
      "--project",
      "p-one",
    ]);
    expect(issued.code, issued.err).toBe(0);
    const lines = issued.out.split("\n").map((line) => line.trim());
    const token =
      lines[
        lines.indexOf(
          "Token（只显示这一次，复制后请自行保存，不要写进仓库）：",
        ) + 1
      ];
    expect(token).toBeDefined();
    try {
      expect(store.verifyToken(token as string)?.assignment_id).toBe("A-1");
    } finally {
      store.close();
    }

    // Stopping revokes the Assignment's tokens (§9.1).
    const stopped = await cardigan([
      "assignment",
      "stop",
      "A-1",
      "--project",
      "p-one",
    ]);
    expect(stopped.code, stopped.err).toBe(0);

    const reopened = Store.open({ dataDir });
    try {
      expect(reopened.verifyToken(token as string)).toBeUndefined();
      assignment = reopened.uow.read((tx) =>
        tx.assignments.get("p-one" as never, "A-1" as never),
      ) as unknown as { runtime_ref?: { terminal_ref: string } | null };
    } finally {
      reopened.close();
    }
    expect(assignment?.runtime_ref).toBeNull();

    // The same token over HTTP is a 401 now.
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "stopped-agent", version: "0" },
        },
      }),
    });
    expect(response.status).toBe(401);
    await response.body?.cancel();
  }, 60000);
});

if (!available) {
  describe("herdr-core is required", () => {
    test.skip(`herdr-core ${HC_VERSION} is unavailable or has a different version`, () => {
      expect(available).toBe(true);
    });
  });
}
