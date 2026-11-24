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
import { main as cli } from "@cardigan/cli";
import type {
  Actor,
  CommandState,
  ProjectId,
  RuntimeRef,
} from "@cardigan/domain";
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
import { resolveWebConfig } from "../../apps/server/src/web/config.js";
import { HcCore, runCleanupSteps } from "../../apps/server/test-support/hc.js";
import { createTestRuntime } from "../../test-support/paths.js";

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
  /**
   * Wait until the host has started this Assignment (M5.S S6).
   *
   * Nothing is started from the test: assigning over MCP routes a bell, the
   * Dispatcher queues the `initial` Run and opens the terminal through the same
   * `launchRun` the CLI uses. This method only waits for that and records the
   * hc core PID, so a crash can still be cleaned up by PID.
   */
  awaitAgent(assignmentId: string): Promise<void>;
  /** The Workbench URL, for the human steps of the appendix. */
  readonly webUrl: string;
  /** Call the Workbench API as the logged-in human; throws on a non-2xx. */
  api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, any>>;
  /** Stop the hc core without removing the session; nothing restarts it. */
  stopCore(): Promise<void>;
  /** Record the PID of a core that came up after `stopCore()`. */
  rememberCore(): number | undefined;
  /** What the host runtime answers for an Assignment's `runtime_ref`. */
  probeRuntime(ref: unknown): Promise<unknown>;
  repeatBell(ref: RuntimeRef, bell: string): Promise<void>;
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
  const runtimeDir = createTestRuntime(join(root, "run"));
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
  const webPort = await freePort();
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

  const WEB_PASSWORD = "appendix-a-password";
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
    promptSecret: async () => WEB_PASSWORD,
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
  await cardigan("project", "create", PROJECT, "--code", "PRO");
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
    "resolve_delegated_decision",
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
    ["reviewer", "readonly", REVIEW_TOOLS],
    ["tester", "none", REVIEW_TOOLS],
    ["pm", "none", PM_TOOLS],
  ] as const) {
    const file = join(root, "roles", `${role_id}.yaml`);
    writeFile(
      file,
      [
        `role_id: ${role_id}`,
        `display_name: ${role_id}`,
        // PM combines coordination and acceptance; it is not a verifier role.
        `kind: ${role_id === "pm" ? "standing" : role_id === "coder" ? "produce" : "verify"}`,
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
  const host = await createHostWiring({
    env: hostEnv,
    store,
    dataDir,
    // §P2a-2: a late hc call fails with its stack instead of restarting a core.
    client: core.client(),
  });
  const errors: string[] = [];
  let server: CardiganServer;
  try {
    server = await startCardiganServer({
      store,
      config: { dataDir, host: "127.0.0.1", port },
      web: {
        config: resolveWebConfig(
          {},
          {
            port: webPort,
            staticDir: join(root, "web"),
            loginFailureDelayMs: 0,
          },
        ),
      },
      warn: () => undefined,
      log: () => undefined,
      dispatcher: {
        runtime: host.runtime,
        snapshot: host.snapshot,
        beforeWake: host.beforeWake,
        // Standing PM Assignments (Office/Ops) have no RuntimeRef here: their
        // conversation lives in Herdr and is driven by the human, so a scripted
        // Agent cannot stand in for them. Returning no Assignment makes every
        // Office/Ops notification ownerless (`notificationOwner`), so no bell is
        // claimed for them and nothing escalates when it is not delivered. It
        // has to be explicit: without `standing` the control plane builds a
        // resolver from the store, claims those bells, and the failed start
        // escalates to the human. The test's own PM clients drive steps 1 and 8.
        standing: () => undefined,
        startRun: async (input) => {
          if (input.assignment.scope === "standing")
            throw new Error(
              `no scripted PM session for standing Assignment ${input.assignment.id}`,
            );
          await host.startRun(input);
        },
        intervalMs: 100,
        // The appendix reaches the merge and cleanup phases; keep the phase
        // loops fast enough for a test run.
        mergeIntervalMs: 200,
        cleanupIntervalMs: 200,
        deliveryLeaseMs: 5_000,
        retryBaseMs: 1_000,
        onError: (error) => errors.push(String(error)),
      },
    });
  } catch (error) {
    try {
      await runCleanupSteps({
        session,
        socket: socketPath,
        steps: [
          { label: "stop herdr-core", run: () => core.finalStop() },
          { label: "close store", run: () => store.close() },
          {
            label: "restore process environment",
            run: () => {
              process.env = savedEnv;
            },
          },
          { label: "stop herdr-core again", run: () => core.finalStop() },
          {
            label: "verify herdr-core stopped",
            run: () => core.assertStopped(),
          },
          {
            label: "remove temporary directory",
            run: () => rmSync(root, { recursive: true, force: true }),
          },
        ],
      });
    } catch (cleanupError) {
      throw new Error(
        `E2E harness setup failed: ${String(error)}\n${String(cleanupError)}`,
      );
    }
    throw error;
  }
  core.remember();

  const clients: Client[] = [];
  const webUrl = `http://127.0.0.1:${webPort}`;
  let cookie = "";
  async function login(): Promise<void> {
    const response = await fetch(`${webUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: webUrl },
      body: JSON.stringify({ password: WEB_PASSWORD }),
    });
    if (response.status !== 200) {
      throw new Error(`Workbench login failed: ${response.status}`);
    }
    cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }
  try {
    // The human's Workbench password; `web set-password` prompts twice.
    await cardigan("web", "set-password");
    await login();
  } catch (error) {
    try {
      await runCleanupSteps({
        session,
        socket: socketPath,
        steps: [
          { label: "close Cardigan server", run: () => server.close() },
          { label: "stop herdr-core", run: () => core.finalStop() },
          { label: "close store", run: () => store.close() },
          {
            label: "restore process environment",
            run: () => {
              process.env = savedEnv;
            },
          },
          { label: "stop herdr-core again", run: () => core.finalStop() },
          {
            label: "verify herdr-core stopped",
            run: () => core.assertStopped(),
          },
          {
            label: "remove temporary directory",
            run: () => rmSync(root, { recursive: true, force: true }),
          },
        ],
      });
    } catch (cleanupError) {
      throw new Error(
        `E2E harness setup failed: ${String(error)}\n${String(cleanupError)}`,
      );
    }
    throw error;
  }
  const api = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, any>> => {
    const response = await fetch(`${webUrl}${path}`, {
      method,
      headers: {
        cookie,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(method === "GET" ? {} : { origin: webUrl }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const parsed = text.length > 0 ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
    }
    return parsed;
  };
  const harness: E2eHarness = {
    root,
    dataDir,
    server,
    store,
    core,
    agentDir,
    cardigan,
    probeRuntime: (ref) => host.runtime.status(ref as never),
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
    webUrl,
    api,
    async awaitAgent(assignmentId: string) {
      // A Run the host started is the evidence that the assign bell did its
      // job; without it the next wait would blame the wrong step.
      const run = await harness
        .until(
          `a Run for ${assignmentId}`,
          () =>
            store.uow.read((tx) =>
              tx.runs
                .list(PROJECT)
                .filter(
                  (entry) =>
                    entry.assignment_id === assignmentId &&
                    !["completed", "failed", "cancelled"].includes(
                      entry.status,
                    ),
                )
                .at(-1),
            ),
          120_000,
        )
        .catch(async (error: unknown) => {
          throw new Error(
            `${String(error)}\nnotifications:\n${JSON.stringify(
              store.listNotifications({ project_id: PROJECT }),
            )}\ndispatcher errors:\n${errors.join("; ")}`,
          );
        });
      // The launch started the hc core; record its PID while the socket exists.
      core.remember();
      // The Agent must actually connect: wait for its whoami line.
      await harness
        .until(
          `agent for ${assignmentId}`,
          () =>
            harness.agentLog().includes(`"assignment_id":"${assignmentId}"`)
              ? true
              : undefined,
          90_000,
        )
        .catch(async (error: unknown) => {
          const terminals = await exec("hc", ["ls"], {
            env: { ...process.env },
          })
            .then((result) => result.stdout)
            .catch((failure: unknown) => String(failure));
          throw new Error(
            `${String(error)}\nrun:\n${JSON.stringify(run)}\nterminals:\n${terminals}`,
          );
        });
    },
    async repeatBell(ref, bell) {
      for (let n = 0; n < 2; n++) {
        const sent = await host.runtime.wake(ref, bell);
        if (!sent.ok || !sent.value.sent)
          throw new Error("Duplicate bell was not delivered");
      }
    },
    async stopCore() {
      // Appendix pass criterion 3 (M5.6): the Herdr server dies and its
      // terminals with it. Nothing here starts a core again — the system has to
      // recover on its own, and the next hc call it makes brings a core up (0.3:
      // hc commands start one when the socket is absent).
      await core.stop();
      await sleep(500);
    },
    rememberCore() {
      // A core that came up after `stopCore()` gets a new PID; record it while
      // the socket exists so cleanup can stop exactly that process.
      return core.remember();
    },
    async close() {
      // The core first: its terminals and Agents die with it. Every step still
      // runs after a failure, and the final error names the session, socket and
      // every cleanup step that failed instead of silently failing the group.
      if (errors.length > 0)
        process.emitWarning(`dispatcher errors: ${errors.join("; ")}`);
      await runCleanupSteps({
        session,
        socket: socketPath,
        steps: [
          {
            label: "close MCP clients",
            run: async () => {
              for (const client of clients.splice(0)) await client.close();
            },
          },
          // §P2a-2: every background task that can call `hc` stops and drains
          // before the core goes away; otherwise a late bell or launch starts a
          // fresh holder and core after cleanup.
          { label: "close Cardigan server", run: () => server.close() },
          { label: "stop herdr-core", run: () => core.finalStop() },
          { label: "close store", run: () => store.close() },
          {
            label: "restore process environment",
            run: () => {
              process.env = savedEnv;
            },
          },
          { label: "stop herdr-core again", run: () => core.finalStop() },
          {
            label: "verify herdr-core stopped",
            run: () => core.assertStopped(),
          },
          {
            label: "remove temporary directory",
            run: () => rmSync(root, { recursive: true, force: true }),
          },
        ],
      });
    },
  };
  return harness;
}

export const human = (): Actor => ({ kind: "human", project_id: PROJECT });
