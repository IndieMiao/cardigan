/**
 * M3.5 end-to-end: Router + Dispatcher on a real server, a real herdr-core (own
 * hc session and socket) and fake Agents that only speak the Card MCP protocol.
 *
 * Covers the M3 plan §5 M3.5 list: a coder delivery wakes the reviewer with a
 * new Run; a rejection wakes the coder with a rework Run; replaying the same
 * events creates no second Run; several events merge into one bell; PM Ops and
 * PM Office get the escalation/Needs You notifications they are owed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as cli, runCommand } from "@cardigan/cli";
import { postComment, requestDecision } from "@cardigan/domain";
import { parseLaunchConfig } from "@cardigan/roles";
import { HerdrRuntime } from "@cardigan/runtime-herdr";
import { Store } from "@cardigan/store";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { HcCore, runCleanupSteps } from "../test-support/hc.js";
import { routeProjectEvents } from "./dispatch-inbox.js";
import { stubGit } from "./git-test-support.js";
import { startQueuedRun } from "./host-start.js";
import { type CardiganServer, startCardiganServer } from "./server.js";

const HC_VERSION = "0.1.18";
const SESSION = `m3t2-${process.pid}-${Math.floor(Date.now() / 1000) % 100000}`;
const SDK = join(
  import.meta.dirname,
  "..",
  "node_modules",
  "@modelcontextprotocol",
  "sdk",
  "dist",
  "esm",
);
const project_id = "p-e2e";

const hcVersion = (() => {
  try {
    return execFileSync("hc", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
})();
const available = hcVersion === `hc ${HC_VERSION}`;

let root: string;
let dataDir: string;
let runtimeDir: string;
let socketPath: string;
let server: CardiganServer;
let store: Store;
let output: string[] = [];
let errors: string[] = [];
let savedEnv: NodeJS.ProcessEnv;
let hostEnv: Record<string, string> = {};
let core: HcCore;

const launch = parseLaunchConfig({
  providers: {
    fake: { harness: "pi", env: {}, secret_env: {} },
  },
  profiles: {
    "pi-agent": { harness: "pi", provider: "fake", model: "fixture-model" },
  },
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(
  label: string,
  probe: () => T | undefined,
  timeoutMs = 45_000,
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

async function cardigan(
  argv: readonly string[],
): Promise<{ code: number; out: string; err: string }> {
  output = [];
  errors = [];
  const code = await cli([...argv], {
    env: { ...process.env, ...hostEnv },
    cwd: root,
    platform: process.platform,
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("these commands must not spawn a CLI");
    },
    captureCommand: async (command, args, options) => {
      if (command === "pi" && args[0] === "--version")
        return { code: 0, stdout: "pi 1.5.0-fake\n", stderr: "" };
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

function writeFile(path: string, content: string, mode = 0o755): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, mode);
}

function sourceRepo(name: string): string {
  const repo = join(root, "src", name);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=f",
    "-c",
    "user.email=f@example.invalid",
    "commit",
    "-qm",
    "init",
  ]);
  return repo;
}

/** The role file the CLI loads; reviewer and pm need no worktree here. */
function roleFile(name: string, worktree: string, tools: string[]): string {
  const path = join(root, "config", `${name}.yaml`);
  writeFile(
    path,
    [
      `role_id: ${name}`,
      `display_name: ${name}`,
      "kind: work",
      `core_prompt: |`,
      `  You are the ${name}.`,
      "harness: pi",
      "launch_profile_ref: pi-agent",
      `allowed_tools: [${tools.join(", ")}]`,
      `worktree: ${worktree}`,
      "",
    ].join("\n"),
  );
  return path;
}

/** The fake Agent: one script, branches on the role it is started as. */
const AGENT = `
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { Client } from ${JSON.stringify(join(SDK, "client", "index.js"))};
import { StreamableHTTPClientTransport } from ${JSON.stringify(join(SDK, "client", "streamableHttp.js"))};

const stateDir = process.env.CARDIGAN_AGENT_DIR || "/tmp";
const log = (line) => {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(stateDir + "/agent.log", line + String.fromCharCode(10), { flag: "a" });
};
const marker = (name) => stateDir + "/" + name;

const client = new Client({ name: "fake-agent", version: "0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(process.env.CARDIGAN_MCP_URL), {
    requestInit: { headers: { Authorization: "Bearer " + process.env.MCP_TOKEN } },
  }),
);
const text = (result) => JSON.parse(result.content[0].text);
const call = async (name, args) => text(await client.callTool({ name, arguments: args }));

const who = await call("whoami", {});
log("who=" + JSON.stringify(who).slice(0, 300));

async function workOn(prompt) {
  const match = prompt.match(/run=(R-[0-9]+)/);
  if (!match) {
    log("no run in " + JSON.stringify(prompt.slice(0, 120)));
    return;
  }
  const run_id = match[1];
  try {
    // Standing Assignments (PM Office / Ops) have no card to read here.
    const card = who.card_id
      ? await call("get_card", { card_id: who.card_id })
      : { work_items: [], deliveries: [] };
    // One delivery and one review are enough to drive the pipeline; repeating
    // them would loop forever.
    if (who.role_id === "coder" && !existsSync(marker("delivered"))) {
      const item = card.work_items.find((w) => w.id === who.work_item_id);
      if (item && !["delivered", "accepted"].includes(item.status)) {
        const delivery = await call("submit_delivery", {
          idempotency_key: "delivery-" + run_id,
          work_item_id: who.work_item_id,
          kind: "code",
          summary: "delivery from " + run_id,
          subject: { kind: "git_head", value: "b".repeat(40) },
          requested_verifiers: card.work_items
            .filter((w) => w.kind === "verify" && w.target_work_item_id === who.work_item_id)
            .map((w) => w.id),
        });
        log("delivery " + JSON.stringify(delivery).slice(0, 200));
        writeFileSync(marker("delivered"), "1");
      }
    }
    if (who.role_id === "reviewer" && !existsSync(marker("reviewed"))) {
      const delivery = card.deliveries.find((d) => d.status === "submitted");
      if (delivery) {
        const review = await call("submit_review", {
          idempotency_key: "review-" + run_id,
          delivery_id: delivery.id,
          target_sha: delivery.subject.value,
          kind: "code",
          issues: [{ severity: "major", description: "please rework", must_fix: true, pre_existing: false }],
        });
        log("review " + JSON.stringify(review).slice(0, 200));
        writeFileSync(marker("reviewed"), "1");
      }
    }
    await call("ack_events", { card_id: who.card_id });
    const finished = await call("finish_run", {
      idempotency_key: "finish-" + run_id,
      run_id,
      outcome: "completed",
      summary: "fake agent",
    });
    log("finished " + run_id + " " + JSON.stringify(finished).slice(0, 120));
    writeFileSync(marker("done-" + run_id), "1");
  } catch (error) {
    log("work error " + String(error));
  }
}

// The first prompt arrives as argv; later bells arrive on stdin (hc send).
await workOn(process.argv.slice(2).join(" "));
process.stdout.write(String.fromCharCode(27) + "]7501;state=idle" + String.fromCharCode(7));
let buffer = "";
let queue = Promise.resolve();
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split(String.fromCharCode(10));
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.includes("run=")) continue;
    queue = queue.then(() => workOn(line));
  }
});
setInterval(() => {}, 1000);
`;

describe.skipIf(!available)("M3.5 router and dispatcher end to end", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "cardigan-m3-"));
    dataDir = join(root, "data");
    runtimeDir = join(root, "run");
    socketPath = join(runtimeDir, "cardigan", `${SESSION}.sock`);
    core = new HcCore(SESSION, socketPath, hostEnv);
    hostEnv = {
      CARDIGAN_DATA_DIR: dataDir,
      CARDIGAN_CONFIG_DIR: join(root, "config"),
      XDG_RUNTIME_DIR: runtimeDir,
      CARDIGAN_HC_SESSION: SESSION,
      HC_SESSION: SESSION,
      PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
    };
    savedEnv = { ...process.env };
    for (const [key, value] of Object.entries(hostEnv))
      process.env[key] = value;
    mkdirSync(runtimeDir, { recursive: true });

    writeFile(join(root, "bin", "pi"), `#!/usr/bin/env python3\n`); // placeholder, replaced below
    writeFile(
      join(root, "bin", "pi"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pi 1.5.0-fake"; exit 0; fi\nexec "${process.execPath}" "${join(root, "agent.mjs")}" "$@"\n`,
    );
    writeFile(join(root, "agent.mjs"), AGENT);

    expect((await cardigan(["init"])).code).toBe(0);
    expect((await cardigan(["project", "create", project_id])).code).toBe(0);
    expect(
      (
        await cardigan([
          "project",
          "set-repo",
          "--project",
          project_id,
          "--path",
          sourceRepo(project_id),
        ])
      ).code,
    ).toBe(0);
    for (const [name, worktree, tools] of [
      [
        "coder",
        "write",
        [
          "whoami",
          "get_card",
          "get_updates",
          "ack_events",
          "submit_delivery",
          "finish_run",
        ],
      ],
      [
        "reviewer",
        "none",
        [
          "whoami",
          "get_card",
          "get_updates",
          "ack_events",
          "submit_review",
          "finish_run",
        ],
      ],
      [
        "pm",
        "none",
        [
          "whoami",
          "get_card",
          "get_updates",
          "ack_events",
          "finish_run",
          "create_card",
          "assign",
          "record_decision",
        ],
      ],
    ] as const) {
      expect(
        (
          await cardigan([
            "role",
            "add",
            "--file",
            roleFile(name, worktree, [...tools]),
            "--project",
            project_id,
          ])
        ).code,
      ).toBe(0);
    }
    expect(
      (
        await cardigan([
          "card",
          "create",
          "--template",
          "dev",
          "--title",
          "M3 card",
          "--goal",
          "Ship through the dispatcher",
          "--acceptance",
          "it routes",
          "--repo",
          "example/repo",
          "--project",
          project_id,
        ])
      ).code,
    ).toBe(0);
    // PM Office and Ops exist as standing Assignments with their own tokens.
    expect(
      (await cardigan(["pm", "create", "--office", "--project", project_id]))
        .code,
    ).toBe(0);
    expect(
      (await cardigan(["pm", "create", "--ops", "--project", project_id])).code,
    ).toBe(0);

    store = Store.open({ dataDir });
    const created = await HerdrRuntime.create({ session: SESSION });
    if (!created.ok) throw new Error(created.error.code);
    const runtime = created.value;
    // Remember the core while its socket still exists: after a crash the socket
    // is gone and `hc server stop` can no longer reach it.
    core.remember();
    server = await startCardiganServer({
      config: { dataDir, host: "127.0.0.1", port: 0 },
      store,
      // M3.5 covers routing, not Git: the fake Agent delivers a fabricated SHA.
      git: stubGit(),
      dispatcher: {
        runtime,
        intervalMs: 150,
        snapshot: async () => ({
          model: "fixture-model",
          agent_cli_version: "pi 1.5.0-fake",
        }),
        startRun: async ({ project, assignment, run, bell }) => {
          await startQueuedRun(
            {
              store,
              runtime,
              launch: { config: launch, secrets: {} },
              mcpUrl: server.url,
              dataDir,
            },
            { project: project as never, assignment, run, bell },
          );
          // The first launch starts the core; record its PID right away.
          core.remember();
        },
        onError: (error) => errors.push(String(error)),
      },
    });
    // The wrapper inherits the launch env; the fake Agent needs the endpoint
    // that is only known once the server listens.
    writeFile(
      join(root, "config", "launch.yaml"),
      [
        "providers:",
        "  fake:",
        "    harness: pi",
        "    env:",
        `      CARDIGAN_MCP_URL: ${server.url}`,
        `      CARDIGAN_AGENT_DIR: ${join(root, "agent-state")}`,
        "profiles:",
        "  pi-agent:",
        "    harness: pi",
        "    provider: fake",
        "    model: fixture-model",
        "",
      ].join("\n"),
    );
    process.env.CARDIGAN_MCP_URL = server.url;
    process.env.CARDIGAN_AGENT_DIR = join(root, "agent-state");
  });

  afterAll(async () => {
    await runCleanupSteps({
      session: SESSION,
      socket: socketPath ?? "",
      steps: [
        { label: "stop herdr-core", run: () => core?.stop() },
        { label: "close server", run: () => server?.close() },
        { label: "close store", run: () => store?.close() },
        {
          label: "restore process environment",
          run: () => {
            process.env = savedEnv;
          },
        },
        { label: "stop herdr-core again", run: () => core?.stop() },
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

  const notes = () => store.listNotifications({ project_id });
  const runsFor = (assignment: string) =>
    store.uow.read((tx) =>
      tx.runs
        .list(project_id as never)
        .filter((run) => run.assignment_id === (assignment as never)),
    );
  const assignmentOf = (role: string) =>
    store.uow.read((tx) =>
      tx.assignments
        .list(project_id as never)
        .find(
          (candidate) =>
            candidate.role_id === role && candidate.scope === "work_item",
        ),
    );

  test("a delivery wakes the reviewer with a new Run", async () => {
    const started = await cardigan([
      "assign",
      "W-1",
      "--role",
      "coder",
      "--start",
      "--project",
      project_id,
    ]);
    expect(started.code, started.err).toBe(0);
    expect(
      (
        await cardigan([
          "assign",
          "W-2",
          "--role",
          "reviewer",
          "--project",
          project_id,
        ])
      ).code,
    ).toBe(0);
    const reviewer = assignmentOf("reviewer");
    expect(reviewer).toBeDefined();

    // The reviewer is belled about the delivery and gets its own Run.
    const run = await until("the reviewer Run", () =>
      runsFor(reviewer?.id as string).find(
        (candidate) => candidate.status !== "cancelled",
      ),
    );
    expect(run.kind).toBe("followup");
    const delivery = store.uow
      .read((tx) => tx.events.listAfter(project_id as never, "C-1" as never, 0))
      .find((event) => event.type === "delivery_submitted");
    expect(delivery).toBeDefined();
    expect(run.trigger_event_id).toBe(delivery?.id);
    await until("the reviewer bell", () =>
      notes().some(
        (note) =>
          note.recipient.kind === "assignment" &&
          note.recipient.assignment_id === reviewer?.id &&
          ["belled", "acked"].includes(note.status),
      )
        ? true
        : undefined,
    );
  }, 120_000);

  test("a rejection wakes the coder with a rework Run", async () => {
    const coder = assignmentOf("coder");
    const rework = await until("the coder rework Run", () =>
      runsFor(coder?.id as string).find(
        (candidate) => candidate.kind === "rework",
      ),
    );
    expect(rework.status).not.toBe("cancelled");
    const review = store.uow
      .read((tx) => tx.events.listAfter(project_id as never, "C-1" as never, 0))
      .find((event) => event.type === "review_submitted");
    expect(review).toBeDefined();
    expect(rework.trigger_event_id).toBe(review?.id);
  }, 120_000);

  test("replaying the routed events creates no second Run", async () => {
    // Wait until the bell exchange of the first three tests has finished.
    await until("the pipeline to settle", () =>
      store.uow
        .read((tx) => tx.runs.list(project_id as never))
        .every((run) =>
          ["completed", "failed", "cancelled"].includes(run.status),
        )
        ? true
        : undefined,
    );
    const before = new Map(notes().map((note) => [note.id, note.kind]));
    // Rewind every stream to the start: the router must not duplicate work.
    for (const stream of store.uow.read((tx) => [
      "",
      ...tx.cards.list(project_id as never).map((card) => card.id as string),
    ]))
      store.advanceRouterCursor(project_id as never, stream, 0);
    await sleep(1200);
    routeProjectEvents(store, project_id as never);
    await sleep(800);

    // The (event, recipient) key makes re-routing a no-op: same rows, and no
    // extra work for the delivery/review events that drove the pipeline.
    const after = notes();
    for (const [id, kind] of before) {
      expect(after.find((note) => note.id === id)?.kind, id).toBe(kind);
    }
    expect(
      after.filter((note) => ["delivery", "review"].includes(note.kind)),
    ).toHaveLength(
      [...before.values()].filter((kind) =>
        ["delivery", "review"].includes(kind),
      ).length,
    );
    // ...and no Assignment ever owns two Runs for the same trigger event.
    const keys = store.uow
      .read((tx) => tx.runs.list(project_id as never))
      .map((run) => `${run.assignment_id}/${run.trigger_event_id}`);
    expect(new Set(keys).size).toBe(keys.length);
  }, 60_000);

  test("several events for one Assignment merge into a single bell", async () => {
    const coder = assignmentOf("coder");
    const human = { kind: "human", project_id: project_id as never } as const;
    for (const body of ["one", "two", "three"])
      runCommand(store, {
        project_id: project_id as never,
        actor: human,
        reduce: (state, actor, ports) =>
          postComment(
            state,
            actor,
            {
              card_id: "C-1" as never,
              work_item_id: "W-1" as never,
              body,
            },
            ports,
          ),
      });

    const bell = await until("the merged bell", () =>
      notes().find(
        (note) =>
          note.recipient.kind === "assignment" &&
          note.recipient.assignment_id === coder?.id &&
          note.bell?.includes("3 comments"),
      ),
    );
    expect(bell.bell).toContain('summary="3 comments"');
    // The bell carries a seq range, not a single event.
    expect(bell.bell).toMatch(/seq=\d+\.\.\d+/u);
  }, 60_000);

  test("PM Office gets a Needs You prompt and PM Ops gets the escalation", async () => {
    const human = { kind: "human", project_id: project_id as never } as const;
    runCommand(store, {
      project_id: project_id as never,
      actor: human,
      reduce: (state, actor, ports) =>
        requestDecision(
          state,
          actor,
          {
            card_id: "C-1" as never,
            category: "general",
            kind: "choose",
            question: "Which shape should the API take?",
            context: "Two options",
            options: [
              { key: "a", description: "REST", impact: "simple" },
              { key: "b", description: "RPC", impact: "fast" },
            ],
            recommended: "a",
            affected_cards: ["C-1" as never],
            affected_work_items: ["W-1" as never],
            blocking: false,
            decider: "human",
          },
          ports,
        ),
    });

    const needsYou = await until("the Needs You notification", () =>
      notes().find((note) => note.recipient.kind === "needs_you"),
    );
    expect(needsYou.kind).toBe("needs_you");
    const office = await until("the PM Office prompt", () =>
      notes().find((note) => note.recipient.kind === "pm_office"),
    );
    // Office is only told about Needs You items, never about ordinary routing.
    expect(["needs_you", "decision"]).toContain(office.kind);
    expect(
      notes().filter(
        (note) =>
          note.recipient.kind === "pm_office" &&
          !["needs_you", "decision"].includes(note.kind),
      ),
    ).toEqual([]);

    // A bell that cannot be delivered escalates to PM Ops (§6.4).
    const released = assignmentOf("coder");
    expect(released).toBeDefined();
    store.uow.run((tx) =>
      tx.assignments.put(
        project_id as never,
        { ...released, status: "released" } as never,
      ),
    );
    runCommand(store, {
      project_id: project_id as never,
      actor: human,
      reduce: (state, actor, ports) =>
        postComment(
          state,
          actor,
          {
            card_id: "C-1" as never,
            work_item_id: "W-1" as never,
            body: "after release",
          },
          ports,
        ),
    });
    const ops = await until("the PM Ops escalation", () =>
      notes().find(
        (note) =>
          note.recipient.kind === "pm_ops" && note.kind === "run_attention",
      ),
    );
    expect(ops.kind).toBe("run_attention");
  }, 60_000);
});

if (!available) {
  describe("herdr-core is required", () => {
    test.skip(`herdr-core ${HC_VERSION} is not installed (found ${hcVersion ?? "nothing"})`, () => {
      expect(available).toBe(true);
    });
  });
}
