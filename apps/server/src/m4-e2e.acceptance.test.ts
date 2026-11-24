/**
 * M4.4 end-to-end (plan §4 M4.4 acceptance, development plan §4.4, §6.4, §12).
 *
 * Real server, real Git (source, central repository, base clone and worktrees),
 * real MCP clients acting as the three Agents, and a fake Runtime so the
 * Dispatcher can open a terminal without hc. Covers:
 *
 * - a forged SHA is rejected by `submit_delivery`;
 * - delivery → review → completion → `merge confirm` produces a merge commit on
 *   the central baseline, the card becomes done, its Assignment is released and
 *   the clean worktree is removed;
 * - a released token can no longer call the MCP endpoint;
 * - a conflicting delivery rings the coder with a `fix` Run and returns the card
 *   to in_progress;
 * - a dirty worktree becomes a Needs You decision and survives;
 * - a manually created directory under the worktree root is reported by the
 *   reconciliation loop.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as cli, runCommand } from "@cardigan/cli";
import type {
  Assignment,
  Runtime,
  RuntimeLaunch,
  RuntimeRef,
  WorkItem,
} from "@cardigan/domain";
import { dispatchRun, queueRun } from "@cardigan/domain";
import {
  CentralRepositoryService,
  GitWorktreeService,
} from "@cardigan/git-service";
import {
  CentralGitTransport,
  LocalGitTransport,
} from "@cardigan/git-transport";
import { loadCommandState } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { roleConfig } from "../../../test-support/launch-fixture.js";
import { type CardiganServer, startCardiganServer } from "./server.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

const project = "p-m4e2e";
const sourceBranch = "main";
const ALL_TOOLS = [
  "whoami",
  "get_card",
  "get_updates",
  "ack_events",
  "submit_delivery",
  "submit_review",
  "finish_run",
  "request_decision",
  "create_card",
  "assign",
  "record_decision",
] as const;
const toolsFor = (role: string) =>
  ALL_TOOLS.filter(
    (tool) =>
      role === "pm" ||
      (tool !== "record_decision" &&
        tool !== (role === "coder" ? "submit_review" : "submit_delivery")),
  );
const kindFor = (role: string) =>
  role === "pm" ? "standing" : role === "coder" ? "produce" : "verify";

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();

/** One bell per startRun: the Dispatcher opened a terminal for this Run. */
interface Bell {
  readonly assignment: string;
  readonly run: string;
  readonly text: string;
}

class FakeRuntime implements Runtime {
  readonly bells: Bell[] = [];
  readonly refs = new Map<string, Assignment>();
  async provision(
    assignment: Assignment,
    _role: unknown,
    _machine: unknown,
    launch: RuntimeLaunch,
  ) {
    const ref: RuntimeRef = {
      machine_id: "local",
      runtime_machine: "local",
      terminal_ref: `t-${assignment.id}`,
      agent_name: launch.agent_name,
    };
    this.refs.set(ref.terminal_ref, assignment);
    return { ok: true as const, value: ref };
  }
  /** A quiet, long-lived subscription: the fixture never reports an event. */
  async *events(_ref: RuntimeRef, signal?: AbortSignal) {
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    yield* [] as never[];
  }
  async wake(ref: RuntimeRef, text: string) {
    // The bell names its Assignment in the terminal ref this fixture chose.
    this.bells.push({
      assignment: ref.terminal_ref.replace(/^t-/u, ""),
      run: "",
      text,
    });
    return { ok: true as const, value: { sent: true } };
  }
  async status() {
    // One live terminal per Assignment: the Dispatcher wakes it instead of
    // opening a new session, exactly like an Agent that is still running.
    return {
      ok: true as const,
      value: {
        process: "alive" as const,
        agent: "idle" as const,
        observed_seq: 1,
      },
    };
  }
  async interrupt() {
    return { ok: true as const, value: undefined };
  }
  async release() {
    return { ok: true as const, value: undefined };
  }
  async resume_or_replace(ref: RuntimeRef) {
    return { ok: true as const, value: ref };
  }
  async human_entry() {
    return { ok: true as const, value: "fixture" };
  }
}

interface Harness {
  readonly root: string;
  readonly dataDir: string;
  readonly source: string;
  readonly store: Store;
  readonly server: CardiganServer;
  readonly runtime: FakeRuntime;
  close(): Promise<void>;
  cardigan(...argv: string[]): Promise<string>;
  connect(token: string): Promise<Client>;
  state(): ReturnType<typeof loadState>;
  /** Start a non-writing Assignment's Run (no worktree needed). */
  start(assignment: Assignment): Promise<void>;
  /** Finish the Assignment's unfinished Run through the MCP tool. */
  finish(assignment: Assignment, client: Client): Promise<void>;
  /** Create the worktree, a running Run, and a token for one Assignment. */
  seat(
    assignment: Assignment,
    card: { id: string; base_branch: string },
    item: WorkItem,
    role: { role_id: string; worktree: string; version: number },
  ): Promise<{ token: string; worktree: string; branch: string }>;
}

const loadState = (store: Store) =>
  store.uow.read((tx) => loadCommandState(tx, project as never));

let h: Harness;
const clients: Client[] = [];

async function harness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "cardigan-m4e2e-"));

  return await (async () => {
    const dataDir = join(root, "data");
    const source = join(root, "source");
    git(root, "init", "-q", "-b", sourceBranch, source);
    writeFileSync(join(source, "README.md"), "fixture\n");
    git(source, "add", "README.md");
    git(source, "commit", "-qm", "init");

    let out: string[] = [];
    const io = {
      env: {
        CARDIGAN_CONFIG_DIR: roleConfig(root, "fixture"),
        CARDIGAN_DATA_DIR: dataDir,
        CARDIGAN_PROJECT: project,
        CARDIGAN_RUNTIME_MODE: "local",
      },
      cwd: root,
      platform: process.platform,
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => out.push(line),
      signals: { on: () => undefined, off: () => undefined },
      spawnInherit: () => {
        throw new Error("the e2e CLI must not spawn");
      },
      captureCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    } as never;
    const cardigan = async (...argv: string[]) => {
      out = [];
      const code = await cli([...argv, "--data-dir", dataDir], io);
      if (code !== 0) throw new Error(`CLI failed: ${out.join("\n")}`);
      return out.join("\n");
    };
    await cardigan("init");
    await cardigan(
      "project",
      "create",
      project,
      "--code",
      `T${project
        .replace(/[^a-z0-9]/gu, "")
        .slice(0, 3)
        .toUpperCase()}`,
    );
    await cardigan(
      "project",
      "set-repo",
      "--path",
      source,
      "--base-branch",
      sourceBranch,
    );
    for (const [role_id, worktree] of [
      ["coder", "write"],
      ["reviewer", "none"],
      ["pm", "none"],
    ] as const) {
      const file = join(root, `${role_id}.yaml`);
      writeFileSync(
        file,
        [
          `role_id: ${role_id}`,
          `display_name: ${role_id}`,
          `kind: ${kindFor(role_id)}`,
          `core_prompt: |`,
          `  You are the ${role_id}.`,
          "harness: pi",
          "launch_profile_ref: fixture",
          `allowed_tools: [${toolsFor(role_id).join(", ")}]`,
          `worktree: ${worktree}`,
          "",
        ].join("\n"),
      );
      await cardigan("role", "add", "--file", file);
    }
    await cardigan(
      "card",
      "create",
      "--template",
      "dev",
      "--title",
      "M4 e2e card",
      "--goal",
      "Ship through the merge gate",
      "--acceptance",
      "it merges",
      "--repo",
      "example/repo",
    );

    // Assign every template work item to the role the template picked.
    const seed = Store.open({ dataDir });
    const items = seed.uow.read((tx) => tx.work_items.list(project as never));
    seed.close();
    for (const item of items)
      await cardigan("assign", item.id, "--role", item.role_id);

    const store = Store.open({ dataDir });
    const runtime = new FakeRuntime();
    const central = new CentralRepositoryService(
      new CentralGitTransport({ dataDir }),
      { dataDir },
    );
    const worktrees = new GitWorktreeService(new LocalGitTransport(), central, {
      dataDir,
    });
    const server = await startCardiganServer({
      store,
      config: { dataDir, host: "127.0.0.1", port: 0 },
      warn: () => {},
      log: () => {},
      dispatcher: {
        runtime,
        intervalMs: 50,
        mergeIntervalMs: 100,
        cleanupIntervalMs: 100,
        reconcileIntervalMs: 150,
        deliveryLeaseMs: 2_000,
        retryBaseMs: 1_000,
        inactivityGraceMs: 3_600_000,
        lossGraceMs: 3_600_000,
        eventSilenceMs: 86_400_000,
        onError: () => undefined,
        snapshot: async () => ({
          model: "fixture-model",
          agent_cli_version: "pi 1.5.0",
        }),
        startRun: async ({ project: project_id, assignment, run, bell }) => {
          runtime.bells.push({
            assignment: assignment.id,
            run: run.id,
            text: bell,
          });
          const provisioned = await runtime.provision(
            assignment,
            undefined,
            undefined,
            {
              command: "fixture",
              args: [],
              cwd: root,
              agent_name: `agent-${assignment.id}`,
              labels: {},
            },
          );
          if (!provisioned.ok) throw new Error("provision failed");
          runCommand(store, {
            project_id: project_id,
            actor: { kind: "system", project_id: project_id },
            reduce: (state, actor, ports) =>
              dispatchRun(
                state,
                actor,
                { run_id: run.id, runtime_ref: provisioned.value },
                ports,
              ),
          });
        },
      },
    });
    const connect = async (token: string) => {
      const client = new Client({ name: "m4-e2e", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      clients.push(client);
      return client;
    };
    const state = () => loadState(store);
    const start = async (assignment: Assignment) => {
      const run = runCommand(store, {
        project_id: project as never,
        actor: { kind: "human", project_id: project as never },
        reduce: (s, a, p) =>
          queueRun(
            s,
            a,
            {
              assignment_id: assignment.id,
              model: "fixture-model",
              agent_cli_version: "pi 1.5.0",
            },
            p,
          ),
      });
      runCommand(store, {
        project_id: project as never,
        actor: { kind: "human", project_id: project as never },
        reduce: (s, a, p) =>
          dispatchRun(
            s,
            a,
            {
              run_id: run.id,
              runtime_ref: {
                machine_id: "local",
                runtime_machine: "local",
                terminal_ref: `t-${assignment.id}`,
                agent_name: `agent-${assignment.id}`,
              },
            },
            p,
          ),
      });
    };
    const finish = async (assignment: Assignment, client: Client) => {
      const run = state().runs.find(
        (candidate) =>
          candidate.assignment_id === assignment.id &&
          !["completed", "failed", "cancelled"].includes(candidate.status),
      );
      if (run === undefined) throw new Error("no unfinished run");
      // Acknowledge the card first: unread notifications would wake the
      // Assignment again as soon as its Run ends.
      const card = state().cards[0];
      if (card !== undefined)
        await client.callTool({
          name: "ack_events",
          arguments: {
            card_id: card.id,
            up_to_seq: h.store.getUpdates({
              project_id: project as never,
              card_id: card.id,
            }).latest_seq,
          },
        });
      const result = await client.callTool({
        name: "finish_run",
        arguments: {
          idempotency_key: `finish-${run.id}`,
          run_id: run.id,
          outcome: "completed",
          summary: "fixture finished",
        },
      });
      if (result.isError === true) throw new Error(JSON.stringify(result));
    };
    const seat: Harness["seat"] = async (assignment, card, item, role) => {
      const placement = await worktrees.ensureWorktree({
        project_id: project,
        source_repo: source,
        assignment,
        role: {
          role_id: role.role_id,
          version: role.version,
          display_name: role.role_id,
          kind: kindFor(role.role_id),
          core_prompt: role.role_id,
          harness: "pi",
          launch_profile_ref: "fixture",
          allowed_tools: toolsFor(role.role_id),
          capabilities: [],
          abilities: [],
          worktree: role.worktree as never,
          required_machine_tags: [],
        },
        card: {
          id: card.id,
          project_id: project,
          repo: source,
          base_branch: card.base_branch,
        } as never,
        work_item: item,
      });
      if (placement === undefined || placement.branch === undefined)
        throw new Error("no worktree for a writing role");
      const run = runCommand(store, {
        project_id: project as never,
        actor: { kind: "human", project_id: project as never },
        reduce: (s, a, p) =>
          queueRun(
            s,
            a,
            {
              assignment_id: assignment.id,
              model: "fixture-model",
              agent_cli_version: "pi 1.5.0",
            },
            p,
          ),
      });
      runCommand(store, {
        project_id: project as never,
        actor: { kind: "human", project_id: project as never },
        reduce: (s, a, p) =>
          dispatchRun(
            s,
            a,
            {
              run_id: run.id,
              runtime_ref: {
                machine_id: "local",
                runtime_machine: "local",
                terminal_ref: `t-${assignment.id}`,
                agent_name: `agent-${assignment.id}`,
                worktree_path: placement.worktree_path,
                branch: placement.branch as string,
              },
              base_sha: placement.base_sha,
            },
            p,
          ),
      });
      const token = (await cardigan("token", "issue", assignment.id))
        .split("\n")
        .at(-1) as string;
      return {
        token: token.trim(),
        worktree: placement.worktree_path,
        branch: placement.branch,
      };
    };
    return {
      root,
      dataDir,
      source,
      store,
      server,
      runtime,
      cardigan,
      connect,
      state,
      start,
      finish,
      seat,
      async close() {
        for (const client of clients.splice(0))
          await client.close().catch(() => undefined);
        await server.close();
        store.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  })();
}

beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
});

const call = async (
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) => {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content: { text: string }[];
  };
  return result;
};
let key = 0;
const idem = () => `e2e-${++key}`;
/** A tool call that must succeed; the whole payload is kept in the failure. */
const expectOk = (result: Awaited<ReturnType<typeof call>>) => {
  if (result.isError === true) throw new Error(JSON.stringify(result));
  return result;
};

/** The single card, its work items and the three Assignments. */
function positions() {
  const state = h.state(),
    card = state.cards[0],
    items = state.work_items.filter((item) => item.card_id === card?.id);
  const coder = state.assignments.find(
    (assignment) => assignment.role_id === "coder",
  );
  const reviewer = state.assignments.find(
    (assignment) => assignment.role_id === "reviewer",
  );
  const pm = state.assignments.find(
    (assignment) => assignment.role_id === "pm",
  );
  if (card === undefined || !coder || !reviewer || !pm)
    throw new Error("fixture is incomplete");
  return { card, items, coder, reviewer, pm };
}

const tokenOf = async (assignment: Assignment) =>
  (await h.cardigan("token", "issue", assignment.id))
    .split("\n")
    .at(-1) as string;

const idOf = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("missing id");
  return value;
};

/**
 * Seat the coder and connect the reviewers. Verification Runs wait for their
 * deliveries and are started by Dispatcher.
 */
async function seatAll() {
  const { card, items, coder, reviewer, pm } = positions();
  const development = items.find((item) => item.kind === "produce") as WorkItem;
  const codeReview = items.find(
    (item) =>
      item.kind === "verify" && item.target_work_item_id === development.id,
  ) as WorkItem;
  const acceptance = items.find(
    (item) => item.kind === "verify" && item.target_work_item_id === undefined,
  ) as WorkItem;
  const seated = await h.seat(coder, card, development, {
    role_id: "coder",
    worktree: "write",
    version: coder.role_version,
  });
  const coderClient = await h.connect(seated.token);
  const reviewerClient = await h.connect(await tokenOf(reviewer));
  const pmClient = await h.connect(await tokenOf(pm));
  expectOk(await call(coderClient, "whoami"));
  return {
    card,
    coder,
    reviewer,
    pm,
    development,
    codeReview,
    acceptance,
    seated,
    coderClient,
    reviewerClient,
    pmClient,
  };
}

/** Commit `files` in the coder worktree and return the new HEAD. */
function commitInWorktree(
  worktree: string,
  files: Record<string, string>,
  message: string,
): string {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(worktree, name), content);
    git(worktree, "add", name);
  }
  git(worktree, "commit", "-qm", message);
  return git(worktree, "rev-parse", "HEAD");
}

/** Delivery → review → completion → acceptance. */
async function deliverAndApprove(
  seeded: Awaited<ReturnType<typeof seatAll>>,
  sha: string,
) {
  const delivered = expectOk(
    await call(seeded.coderClient, "submit_delivery", {
      idempotency_key: idem(),
      work_item_id: seeded.development.id,
      kind: "code",
      summary: "code delivery",
      subject: { kind: "git_head", value: sha },
      requested_verifiers: [seeded.codeReview.id],
    }),
  );
  const deliveryId = idOf(delivered.structuredContent?.id);
  await expect
    .poll(() =>
      h
        .state()
        .runs.some(
          (r) =>
            r.assignment_id === seeded.reviewer.id && r.status === "dispatched",
        ),
    )
    .toBe(true);
  expectOk(await call(seeded.reviewerClient, "whoami"));
  expectOk(
    await call(seeded.reviewerClient, "submit_review", {
      idempotency_key: idem(),
      delivery_id: deliveryId,
      target_sha: sha,
      kind: "code",
      issues: [],
    }),
  );
  await h.finish(seeded.reviewer, seeded.reviewerClient);

  const completion = expectOk(
    await call(seeded.coderClient, "submit_delivery", {
      idempotency_key: idem(),
      work_item_id: seeded.development.id,
      kind: "card_completion",
      plain_summary: TEST_PLAIN_SUMMARY,
      summary: "complete",
      subject: { kind: "git_head", value: sha },
      requested_verifiers: [seeded.acceptance.id],
    }),
  );
  const completionId = idOf(completion.structuredContent?.id);
  await h.finish(seeded.coder, seeded.coderClient);
  await expect
    .poll(() =>
      h
        .state()
        .runs.some(
          (r) => r.assignment_id === seeded.pm.id && r.status === "dispatched",
        ),
    )
    .toBe(true);
  expectOk(await call(seeded.pmClient, "whoami"));
  expectOk(
    await call(seeded.pmClient, "submit_review", {
      idempotency_key: idem(),
      delivery_id: completionId,
      target_sha: sha,
      kind: "product",
      issues: [],
    }),
  );
  await h.finish(seeded.pm, seeded.pmClient);
  return { deliveryId, completionId };
}

/**
 * The Dispatcher keeps waking Agents for pending follow-up notifications. A
 * real Agent would answer them; this helper acknowledges and finishes each new
 * Run so the Cleanup loop sees Assignments with no unfinished Run.
 */
async function drainRuns(clients: ReadonlyMap<string, Client>) {
  for (let round = 0; round < 40; round += 1) {
    const unfinished = h
      .state()
      .runs.filter(
        (run) => !["completed", "failed", "cancelled"].includes(run.status),
      );
    if (unfinished.length === 0) return;
    for (const run of unfinished) {
      const client = clients.get(run.assignment_id);
      if (client === undefined) continue;
      await call(client, "whoami");
      const card = h.state().cards[0];
      if (card !== undefined)
        await call(client, "ack_events", {
          card_id: card.id,
          up_to_seq: h.store.getUpdates({
            project_id: project as never,
            card_id: card.id,
          }).latest_seq,
        });
      await call(client, "finish_run", {
        idempotency_key: idem(),
        run_id: run.id,
        outcome: "completed",
        summary: "follow-up handled",
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const centralRepo = () =>
  new CentralRepositoryService(
    new CentralGitTransport({ dataDir: h.dataDir }),
    {
      dataDir: h.dataDir,
    },
  );

test("a forged SHA is rejected, and the accepted flow merges, releases and cleans up", async () => {
  const seeded = await seatAll();
  // A SHA the repository has never seen is refused before any transaction.
  const forged = await call(seeded.coderClient, "submit_delivery", {
    idempotency_key: idem(),
    work_item_id: seeded.development.id,
    kind: "code",
    summary: "forged",
    subject: { kind: "git_head", value: "f".repeat(40) },
    requested_verifiers: [seeded.codeReview.id],
  });
  expect(forged.isError).toBe(true);
  expect(JSON.stringify(forged)).toContain("validation_failed");
  expect(h.state().deliveries).toEqual([]);

  const sha = commitInWorktree(
    seeded.seated.worktree,
    { "feature.txt": "feature\n" },
    "feature",
  );
  await deliverAndApprove(seeded, sha);
  expect(h.state().cards[0]?.status).toBe("awaiting_merge");

  expect(await h.cardigan("merge", "confirm", seeded.card.id)).toContain(
    "已确认合并",
  );
  await expect
    .poll(() => h.state().cards[0]?.status, { timeout: 20_000 })
    .toBe("done");
  await drainRuns(
    new Map<string, Client>([
      [seeded.coder.id, seeded.coderClient],
      [seeded.reviewer.id, seeded.reviewerClient],
      [seeded.pm.id, seeded.pmClient],
    ]),
  );

  const central = centralRepo();
  const repository = await central.ensureCentral({
    project_id: project,
    source_repo: h.source,
    base_branch: sourceBranch,
  });
  const tip = await central.git.readRef(repository, "refs/heads/main");
  expect(tip).not.toBe(undefined);
  expect(git(repository, "cat-file", "-p", tip as string)).toContain(
    "Merge C-1/W-1 delivery",
  );

  await expect
    .poll(
      () =>
        h
          .state()
          .assignments.find((assignment) => assignment.id === seeded.coder.id)
          ?.status,
      { timeout: 20_000 },
    )
    .toBe("released");
  await expect
    .poll(() => existsSync(seeded.seated.worktree), { timeout: 20_000 })
    .toBe(false);
  // A 401 aborts the MCP request, so the rejection itself is the evidence.
  await expect
    .poll(
      async () => {
        try {
          await call(seeded.coderClient, "whoami");
          return false;
        } catch {
          return true;
        }
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}, 60_000);

test("a conflict rings the coder with a fix Run and reopens the card", async () => {
  const seeded = await seatAll();
  const sha = commitInWorktree(
    seeded.seated.worktree,
    { "README.md": "agent side\n" },
    "agent side",
  );
  await deliverAndApprove(seeded, sha);
  // The registered source moves the same file; the merge can only conflict.
  writeFileSync(join(h.source, "README.md"), "source side\n");
  git(h.source, "add", "README.md");
  git(h.source, "commit", "-qm", "source side");
  expect(await h.cardigan("merge", "confirm", seeded.card.id)).toContain(
    "已确认合并",
  );

  await expect
    .poll(() => h.state().cards[0]?.status, { timeout: 30_000 })
    .toBe("in_progress");
  await expect
    .poll(
      () =>
        h
          .state()
          .runs.filter(
            (run) =>
              run.assignment_id === seeded.coder.id && run.kind === "fix",
          ).length,
      { timeout: 30_000 },
    )
    .toBe(1);
  await expect
    .poll(
      () =>
        h.runtime.bells.filter((bell) => bell.assignment === seeded.coder.id)
          .length,
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  expect(h.runtime.bells.at(-1)?.text).toContain(seeded.card.id);
}, 60_000);

test("a dirty worktree becomes a Needs You decision and is not deleted", async () => {
  const seeded = await seatAll();
  const sha = commitInWorktree(
    seeded.seated.worktree,
    { "feature.txt": "feature\n" },
    "feature",
  );
  await deliverAndApprove(seeded, sha);
  // Local work the removal would lose.
  writeFileSync(join(seeded.seated.worktree, "notes.txt"), "unsaved\n");
  expect(await h.cardigan("merge", "confirm", seeded.card.id)).toContain(
    "已确认合并",
  );

  await expect
    .poll(() => h.state().cards[0]?.status, { timeout: 20_000 })
    .toBe("done");
  await drainRuns(
    new Map<string, Client>([
      [seeded.coder.id, seeded.coderClient],
      [seeded.reviewer.id, seeded.reviewerClient],
      [seeded.pm.id, seeded.pmClient],
    ]),
  );
  await expect
    .poll(
      () =>
        h
          .state()
          .decisions.filter(
            (decision) => decision.trigger === "worktree_cleanup",
          ).length,
      { timeout: 30_000 },
    )
    .toBe(1);
  const decision = h
    .state()
    .decisions.find((entry) => entry.trigger === "worktree_cleanup");
  expect(await h.cardigan("needs-you")).toContain(decision?.id as string);
  expect(existsSync(join(seeded.seated.worktree, "notes.txt"))).toBe(true);

  // `worktree diff` shows what a removal would lose before the human decides.
  const diff = await h.cardigan("worktree", "diff", seeded.coder.id);
  expect(diff).toContain("notes.txt");

  expect(await h.cardigan("worktree", "keep", seeded.coder.id)).toContain(
    "已决定保留",
  );
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  expect(existsSync(join(seeded.seated.worktree, "notes.txt"))).toBe(true);
  expect(
    h.state().decisions.filter((entry) => entry.trigger === "worktree_cleanup"),
  ).toHaveLength(1);
}, 60_000);

test("reconciliation reports a manually created directory as an orphan", async () => {
  const orphan = join(h.dataDir, "agent", "worktrees", project, "A-99-manual");
  mkdirSync(orphan, { recursive: true });
  // Reconciliation needs a central repository and a base clone for the project.
  const central = centralRepo();
  const repository = await central.ensureCentral({
    project_id: project,
    source_repo: h.source,
    base_branch: sourceBranch,
  });
  mkdirSync(join(h.dataDir, "agent", "repos"), { recursive: true });
  git(
    h.root,
    "clone",
    "-q",
    "--no-local",
    repository,
    join(h.dataDir, "agent", "repos", project),
  );
  await expect
    .poll(
      () =>
        h.store
          .listReconcileFindings(project as never, { openOnly: true })
          .filter((finding) => finding.kind === "orphan_worktree").length,
      { timeout: 30_000 },
    )
    .toBe(1);
  expect(await h.cardigan("attention")).toContain("orphan_worktree");
}, 60_000);
