/**
 * The Appendix A end-to-end fixture (M5 plan §4 M5.5; development plan §20.1).
 *
 * Real server (`startCardiganServer` with the real Git service), real herdr-core
 * (`HerdrRuntime` on its own hc session and socket), real Git (a local source
 * repository, the central repository and per-Assignment worktrees) and real
 * Agent processes that only speak the Card MCP protocol.
 *
 * The fixture is deliberately the production wiring: the Dispatcher's `startRun`
 * is `createHostWiring`'s, so a queued Run gets the same worktree, token,
 * launch files and terminal as `cardigan server` would give it.
 */
import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { main as cli, runCommand } from "@cardigan/cli";
import type { Actor, CommandState, ProjectId } from "@cardigan/domain";
import { dispatchRun } from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import {
  type CardiganServer,
  createHostWiring,
  startCardiganServer,
} from "@cardigan/server";
import type { Store } from "@cardigan/store";
import { Store as SqliteStore } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HcCore } from "../../apps/server/test-support/hc.js";

const exec = promisify(execFile);

export const PROJECT = "p-appendix-a" as ProjectId;

export const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

export interface E2eHarness {
  readonly root: string;
  readonly dataDir: string;
  readonly server: CardiganServer;
  readonly store: Store;
  readonly core: HcCore;
  readonly agentDir: string;
  /** Run one CLI command in-process; throws on a non-zero exit. */
  cardigan(...argv: string[]): Promise<string>;
  /** MCP client for a token, closed with the harness. */
  connect(token: string): Promise<Client>;
  /** The project's command state, reloaded on every call. */
  state(): CommandState;
  /** Wait until `probe` returns a value; the timeout names the step. */
  until<T>(
    label: string,
    probe: () => T | undefined,
    timeoutMs?: number,
  ): Promise<T>;
  /** Appended log of the simulated Agents. */
  agentLog(): string;
  /** Marker files the Agents left behind (one per completed action). */
  markers(): readonly string[];
  /** Start an Assignment the way the host does (`cardigan assignment start`). */
  startAssignment(assignmentId: string): Promise<void>;
  /** Stop the hc core without removing the session, then let it come back. */
  restartCore(): Promise<void>;
  close(): Promise<void>;
}

/** A free loopback port, claimed and released before the server binds it. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=e2e",
      "-c",
      "user.email=e2e@example.invalid",
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();

function writeFile(path: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, mode);
}

export interface HarnessOptions {
  /** Extra tools the coder role may use (delivery, attachment, decision). */
  readonly salt?: string;
}

export async function createHarness(
  options: HarnessOptions = {},
): Promise<E2eHarness> {
  const root = mkdtempSync(join(tmpdir(), "cardigan-e2e-"));
  const dataDir = join(root, "data");
  const configDir = join(root, "config");
  const runtimeDir = join(root, "run");
  const binDir = join(root, "bin");
  const agentDir = join(root, "agent-state");
  const source = join(root, "source");
  const session = `e2e-${process.pid}-${Math.floor(Date.now() / 1000) % 100000}`;
  const socketPath = join(runtimeDir, "cardigan", `${session}.sock`);
  const salt = options.salt ?? "appendix-a";

  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  // A real source repository. The host clones from it; the Agents commit on
  // their own worktree branches and never touch it directly.
  mkdirSync(source, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", source]);
  writeFile(join(source, "README.md"), "appendix a\n");
  git(source, "add", "README.md");
  git(source, "commit", "-qm", "init");

  // The Agent binary `pi` is the wrapper: `--version` is answered by the shell,
  // everything else becomes the scripted Agent process herdr-core talks to.
  const agentScript = join(import.meta.dirname, "agent.mjs");
  writeFile(
    join(binDir, "pi"),
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "pi 1.5.0-e2e"; exit 0; fi',
      `exec "${process.execPath}" "${agentScript}" "$@"`,
      "",
    ].join("\n"),
    0o755,
  );

  // The Agent imports the MCP SDK from where `@cardigan/mcp-server` keeps it.
  const sdkRequire = createRequire(
    join(
      import.meta.dirname,
      "..",
      "..",
      "packages",
      "mcp-server",
      "package.json",
    ),
  );
  const sdkClient = pathToFileURL(
    sdkRequire.resolve("@modelcontextprotocol/sdk/client/index.js"),
  ).href;
  const sdkTransport = pathToFileURL(
    sdkRequire.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ).href;

  const hostEnv: Record<string, string> = {
    CARDIGAN_DATA_DIR: dataDir,
    CARDIGAN_CONFIG_DIR: configDir,
    CARDIGAN_PROJECT: PROJECT,
    CARDIGAN_RUNTIME_MODE: "local",
    CARDIGAN_HC_SESSION: session,
    CARDIGAN_AGENT_DIR: agentDir,
    CARDIGAN_E2E_SALT: salt,
    CARDIGAN_E2E_SDK_CLIENT: sdkClient,
    CARDIGAN_E2E_SDK_TRANSPORT: sdkTransport,
    HC_SESSION: session,
    XDG_RUNTIME_DIR: runtimeDir,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  };
  const savedEnv = { ...process.env };
  Object.assign(process.env, hostEnv);

  const port = await freePort();
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;
  hostEnv.CARDIGAN_MCP_URL = mcpUrl;
  process.env.CARDIGAN_MCP_URL = mcpUrl;

  // One provider/profile for every role; the Agent reads its role from whoami.
  writeFile(
    join(configDir, "launch.yaml"),
    [
      "providers:",
      "  local:",
      "    harness: pi",
      "    env:",
      `      CARDIGAN_MCP_URL: ${mcpUrl}`,
      `      CARDIGAN_AGENT_DIR: ${agentDir}`,
      `      CARDIGAN_E2E_SALT: ${salt}`,
      `      CARDIGAN_E2E_SDK_CLIENT: ${sdkClient}`,
      `      CARDIGAN_E2E_SDK_TRANSPORT: ${sdkTransport}`,
      "profiles:",
      "  pi-agent:",
      "    harness: pi",
      "    provider: local",
      "    model: fixture-model",
      "",
    ].join("\n"),
  );

  let out: string[] = [];
  const io = {
    env: hostEnv as Record<string, string>,
    cwd: root,
    platform: process.platform,
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => out.push(line),
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("the e2e CLI must not spawn");
    },
    captureCommand: async (command: string, args: readonly string[]) => {
      const result = await exec(command, [...args], { cwd: root }).catch(
        (error: { stdout?: string; stderr?: string; code?: number }) => ({
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? "",
          code: error.code ?? 1,
        }),
      );
      return {
        code: "code" in result ? (result.code as number) : 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
  } as never;
  const cardigan = async (...argv: string[]): Promise<string> => {
    out = [];
    const code = await cli([...argv], io);
    const text = out.join("\n");
    if (code !== 0) throw new Error(`CLI failed (${code}): ${text}`);
    return text;
  };

  await cardigan("init");
  await cardigan("project", "create", PROJECT);
  await cardigan(
    "project",
    "set-repo",
    "--path",
    source,
    "--base-branch",
    "main",
  );

  const DELIVERY_TOOLS = [
    "whoami",
    "get_card",
    "get_updates",
    "ack_events",
    "submit_delivery",
    "upload_attachment",
    "request_decision",
    "post_comment",
    "heartbeat",
    "finish_run",
  ];
  const REVIEW_TOOLS = [
    "whoami",
    "get_card",
    "get_updates",
    "ack_events",
    "submit_review",
    "post_comment",
    "heartbeat",
    "finish_run",
  ];
  const PM_TOOLS = [
    "whoami",
    "get_card",
    "get_updates",
    "ack_events",
    "create_card",
    "update_card",
    "create_work_item",
    "update_work_item",
    "assign",
    // 产品确认 is a produce item owned by the pm role; the standing Assignments
    // of that role are cut back to their standing tool sets by `standingTools`.
    "submit_delivery",
    "upload_attachment",
    "record_decision",
    "project_snapshot",
    "list_needs_you",
    "submit_review",
    "post_comment",
    "heartbeat",
    "finish_run",
  ];
  for (const [role_id, worktree, tools] of [
    ["coder", "write", DELIVERY_TOOLS],
    ["designer", "none", REVIEW_TOOLS],
    ["reviewer", "none", REVIEW_TOOLS],
    ["tester", "none", REVIEW_TOOLS],
    ["pm", "none", PM_TOOLS],
  ] as const) {
    const file = join(root, "roles", `${role_id}.yaml`);
    writeFile(
      file,
      [
        `role_id: ${role_id}`,
        `display_name: ${role_id}`,
        "kind: work",
        "core_prompt: |",
        `  You are the ${role_id}.`,
        "harness: pi",
        "launch_profile_ref: pi-agent",
        `allowed_tools: [${tools.join(", ")}]`,
        `worktree: ${worktree}`,
        "",
      ].join("\n"),
    );
    await cardigan("role", "add", "--file", file);
  }

  const store = SqliteStore.open({ dataDir });
  const core = new HcCore(session, socketPath, hostEnv);
  const host = await createHostWiring({ env: hostEnv, store, dataDir });
  const errors: string[] = [];
  let server: CardiganServer;
  try {
    server = await startCardiganServer({
      store,
      config: { dataDir, host: "127.0.0.1", port },
      warn: () => undefined,
      log: () => undefined,
      dispatcher: {
        runtime: host.runtime,
        snapshot: host.snapshot,
        // Standing PM Assignments (Office/Ops) are recorded but not launched:
        // their conversation lives in Herdr and is driven by the human, so a
        // scripted Agent cannot stand in for them. Starting them would also
        // rotate their tokens on every bell, which the test's own PM clients
        // use for steps 1 and 8.
        startRun: async (input) => {
          if (input.assignment.scope === "standing") {
            runCommand(store, {
              project_id: input.project,
              actor: { kind: "system", project_id: input.project },
              reduce: (state, actor, ports) =>
                dispatchRun(
                  state,
                  actor,
                  {
                    run_id: input.run.id,
                    runtime_ref: {
                      machine_id: "local",
                      runtime_machine: "local",
                      terminal_ref: `standing-${input.assignment.id}`,
                      agent_name: `standing-${input.assignment.id}`,
                    },
                  },
                  ports,
                ),
            });
            return;
          }
          await host.startRun(input);
        },
        standing: host.standing,
        intervalMs: 100,
        deliveryLeaseMs: 5_000,
        retryBaseMs: 1_000,
        onError: (error) => errors.push(String(error)),
      },
    });
  } catch (error) {
    store.close();
    await core.stop();
    process.env = savedEnv;
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  core.remember();

  const clients: Client[] = [];
  const harness: E2eHarness = {
    root,
    dataDir,
    server,
    store,
    core,
    agentDir,
    cardigan,
    async connect(token: string) {
      const client = new Client({ name: "appendix-a-test", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      clients.push(client);
      return client;
    },
    state: () => store.uow.read((tx) => loadCommandState(tx, PROJECT)),
    async until<T>(
      label: string,
      probe: () => T | undefined,
      timeoutMs = 60_000,
    ): Promise<T> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = probe();
        if (value !== undefined) return value;
        if (Date.now() > deadline)
          throw new Error(
            `timed out waiting for ${label}\nagent log:\n${harness.agentLog()}`,
          );
        await sleep(100);
      }
    },
    agentLog() {
      const file = join(agentDir, "agent.log");
      return existsSync(file) ? readFileSync(file, "utf8") : "";
    },
    markers() {
      return readdirSync(agentDir).filter((name) => name.startsWith("marker-"));
    },
    async startAssignment(assignmentId: string) {
      const output = await cardigan(
        "assignment",
        "start",
        assignmentId,
        "--project",
        PROJECT,
        "--data-dir",
        dataDir,
        "--hc-session",
        session,
        "--mcp-url",
        mcpUrl,
      );
      // The first launch starts the core; record its PID while the socket is
      // still there, so a crash can be cleaned up by PID.
      core.remember();
      // Starting is only useful if the terminal exists and the Run left the
      // queue; otherwise the next wait would blame the wrong step.
      const run = store.uow.read((tx) =>
        tx.runs
          .list(PROJECT)
          .filter(
            (entry) =>
              entry.assignment_id === assignmentId &&
              !["completed", "failed", "cancelled"].includes(entry.status),
          )
          .at(-1),
      );
      if (run === undefined) {
        throw new Error(
          `no open Run after starting ${assignmentId}: ${output}`,
        );
      }
      // The Agent must actually connect: otherwise the next `until` would blame
      // the wrong step. Wait for its whoami line, or fail with evidence.
      const connected = await harness
        .until(
          `agent for ${assignmentId}`,
          () =>
            harness.agentLog().includes(`"assignment_id":"${assignmentId}"`)
              ? true
              : undefined,
          45_000,
        )
        .catch(async (error: unknown) => {
          const terminals = await exec("hc", ["ls"], {
            env: { ...process.env },
          })
            .then((result) => result.stdout)
            .catch((failure: unknown) => String(failure));
          throw new Error(
            `${String(error)}\nstart output:\n${output}\nterminals:\n${terminals}`,
          );
        });
      void connected;
    },
    async restartCore() {
      // §12.9: the core is gone, its terminals with it. The monitor then has to
      // resume the Assignments or report them.
      await core.stop();
      await sleep(500);
    },
    async close() {
      for (const client of clients.splice(0))
        await client.close().catch(() => undefined);
      // The core first: its terminals and Agents die with it. No
      // `assignment stop` follows, because that hc command would start a fresh
      // core after this one is gone.
      await core.stop();
      for (const step of [() => server.close(), async () => store.close()]) {
        try {
          await step();
        } catch {
          // Best effort: the next step still runs.
        }
      }
      process.env = savedEnv;
      await core.stop();
      rmSync(root, { recursive: true, force: true });
      if (errors.length > 0) {
        // Surfaced, not thrown: a dispatcher error is a real failure of the
        // run, but it should not mask a failed assertion above.
        process.emitWarning(`dispatcher errors: ${errors.join("; ")}`);
      }
    },
  };
  return harness;
}

export const human = (): Actor => ({ kind: "human", project_id: PROJECT });
