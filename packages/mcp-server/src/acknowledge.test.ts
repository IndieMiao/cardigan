import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Actor,
  Assignment,
  Card,
  CommandEffect,
  CommandPorts,
  CommandState,
  ProjectId,
  Role,
  TransactionContext,
  WorkItem,
} from "@cardigan/domain";
import { assign, createCard, dispatchRun, queueRun } from "@cardigan/domain";
import { Store, writeRole } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Identity } from "./auth.js";
import { acknowledgeDispatchedRun } from "./commands/acknowledge.js";
import { loadCommandState, persistEffect } from "./commands/execute.js";
import { type RunningServer, startMcpServer } from "./server.js";

const project_id = "p-ack" as ProjectId;
const NOW = "2026-01-01T00:00:00.000Z";
const human: Actor = { kind: "human", project_id };
const agent = (assignment_id: string): Actor => ({
  kind: "assignment",
  project_id,
  assignment_id: assignment_id as Assignment["id"],
  role_id: "coder" as never,
  role_version: 1,
});

const role: Role = {
  role_id: "coder" as never,
  version: 1,
  display_name: "Coder",
  kind: "work",
  core_prompt: "Fictional core prompt.",
  harness: "pi",
  launch_profile_ref: "pi-agent",
  allowed_tools: ["whoami", "get_card"],
  capabilities: [],
  abilities: [],
  worktree: "none",
  required_machine_tags: [],
};

let dataDir: string;
let store: Store;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-ack-"));
  store = Store.open({ dataDir });
  store.createProject({ id: project_id, name: "Ack" });
  store.uow.run((tx) => writeRole(tx, project_id, role, { mode: "add" }));
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Apply one domain command inside a write transaction, like the CLI does. */
function apply<T>(
  reduce: (
    state: CommandState,
    actor: Actor,
    ports: CommandPorts,
  ) =>
    | { ok: true; value: CommandEffect<T> }
    | { ok: false; error: { message: string } },
  actor: Actor = human,
): CommandEffect<T> {
  return store.uow.run((tx) => {
    const effect = reduce(loadCommandState(tx, project_id), actor, ports(tx));
    if (!effect.ok) throw new Error(effect.error.message);
    persistEffect(tx, project_id, effect.value);
    return effect.value;
  });
}

function ports(tx: TransactionContext): CommandPorts {
  return { clock: { now: () => NOW }, ids: tx.ids };
}

/** A card with one coder assignment, dispatched with a runtime ref. */
function dispatchedRun(
  worktree: Role["worktree"] = "none",
  options: { readonly dispatch?: boolean } = {},
) {
  if (worktree !== "none") {
    store.uow.run((tx) =>
      writeRole(
        tx,
        project_id,
        { ...role, worktree },
        { mode: "add", version: 2 },
      ),
    );
  }
  const card = apply((state, actor, p) =>
    createCard(
      state,
      actor,
      {
        title: "Fictional card",
        goal: "Acknowledge a run",
        acceptance_criteria: ["the run advances"],
        source: { kind: "quote", text: "fictional" },
        repo: "example/repo",
        base_branch: "main",
      },
      p,
    ),
  ).changes.find((change) => change.collection === "cards")?.entity as Card;
  const item = store.uow.read((tx) =>
    tx.work_items
      .list(project_id)
      .find((candidate) => candidate.card_id === card.id),
  ) as WorkItem;
  const assignment = apply((state, actor, p) =>
    assign(state, actor, { work_item_id: item.id, role_id: "coder" }, p),
  ).changes.find((change) => change.collection === "assignments")
    ?.entity as Assignment;
  const run = apply((state, actor, p) =>
    queueRun(
      state,
      actor,
      {
        assignment_id: assignment.id,
        model: "fictional-model",
        agent_cli_version: "pi 1.5.0",
      },
      p,
    ),
  ).changes.find((change) => change.collection === "runs")?.entity as {
    id: string;
  };
  if (options.dispatch === false)
    return { assignment, item, run_id: run.id, card };
  apply((state, actor, p) =>
    dispatchRun(
      state,
      actor,
      {
        run_id: run.id as never,
        runtime_ref: {
          machine_id: "local",
          runtime_machine: "local",
          terminal_ref: "t1",
          agent_name: "coder-abcdef12-c-1-w-1-a-1",
        },
      },
      p,
    ),
  );
  return { assignment, item, run_id: run.id, card };
}

function identity(assignment: Assignment): Identity {
  return {
    actor: agent(assignment.id),
    token: { id: "tok-1" } as never,
    assignment,
    role: {
      role_id: assignment.role_id,
      role_version: assignment.role_version,
    },
  } as Identity;
}

const read = (run_id: string) =>
  store.uow.read((tx) => tx.runs.get(project_id, run_id as never));
const itemOf = (id: string) =>
  store.uow.read((tx) => tx.work_items.get(project_id, id as never));

describe("acknowledgeDispatchedRun", () => {
  test("moves the caller's dispatched Run to running on the first call", () => {
    const { assignment, item, run_id } = dispatchedRun();
    expect(read(run_id)?.status).toBe("dispatched");

    acknowledgeDispatchedRun(store, identity(assignment), () => NOW);

    expect(read(run_id)?.status).toBe("running");
    // run_started advances the caller's own work item (§4 step 8).
    expect(itemOf(item.id)?.status).toBe("in_progress");
  });

  test("does nothing on later calls", () => {
    const { assignment, run_id } = dispatchedRun();
    acknowledgeDispatchedRun(store, identity(assignment), () => NOW);
    const events = store.uow.read((tx) =>
      tx.events.listAfter(project_id, undefined, 0),
    ).length;

    acknowledgeDispatchedRun(store, identity(assignment), () => NOW);

    expect(read(run_id)?.status).toBe("running");
    expect(
      store.uow.read((tx) => tx.events.listAfter(project_id, undefined, 0))
        .length,
    ).toBe(events);
  });

  test("cannot acknowledge another Assignment's Run", () => {
    const { assignment, item, run_id } = dispatchedRun();
    // A second Assignment on the same project with no Run of its own.
    const other: Assignment = {
      ...assignment,
      id: "A-2" as never,
      work_item_id: "W-2" as never,
    };

    acknowledgeDispatchedRun(store, identity(other), () => NOW);

    expect(read(run_id)?.status).toBe("dispatched");
    expect(itemOf(item.id)?.status).not.toBe("in_progress");
  });
});

test("a tool call before dispatch acknowledges nothing, and the next call recovers", () => {
  // The wrapper starts the CLI during provision, so a fast Agent can reach the
  // MCP endpoint while its Run is still queued. There is nothing to acknowledge
  // then — and the Run must not be left behind once it is dispatched.
  const unqueued = dispatchedRun("none", { dispatch: false });
  expect(read(unqueued.run_id)?.status).toBe("queued");

  // The first call finds no dispatched Run: it must not throw.
  acknowledgeDispatchedRun(store, identity(unqueued.assignment), () => NOW);
  expect(read(unqueued.run_id)?.status).toBe("queued");

  // The host dispatches the Run, and the Agent's next call acknowledges it.
  apply(
    (state, actor, ports) =>
      dispatchRun(
        state,
        actor,
        {
          run_id: unqueued.run_id as never,
          runtime_ref: {
            machine_id: "local",
            runtime_machine: "local",
            terminal_ref: "t1",
            agent_name: "coder-abcdef12-c-1-w-1-a-1",
          },
        },
        ports,
      ),
    human,
  );
  expect(read(unqueued.run_id)?.status).toBe("dispatched");
  acknowledgeDispatchedRun(store, identity(unqueued.assignment), () => NOW);
  expect(read(unqueued.run_id)?.status).toBe("running");
  expect(itemOf(unqueued.item.id)?.status).toBe("in_progress");
});

describe("the HTTP layer", () => {
  let running: RunningServer;
  let token: string;
  let assignment: Assignment;

  beforeEach(async () => {
    const seeded = dispatchedRun();
    assignment = seeded.assignment;
    token = store.issueToken({
      project_id,
      assignment_id: seeded.assignment.id,
      role: {
        role_version: seeded.assignment.role_version,
        allowed_tools: ["whoami", "get_card"],
      },
    }).token;
    running = await startMcpServer({
      store,
      host: "127.0.0.1",
      port: 0,
      log: () => undefined,
    });
  });

  afterEach(async () => {
    await running.close();
  });

  function connect() {
    const client = new Client({ name: "fictional-client", version: "0.0.0" });
    return client
      .connect(
        new StreamableHTTPClientTransport(new URL(running.url), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      )
      .then(() => client);
  }

  test("only a tool call records the Assignment's last MCP activity", async () => {
    const activity = () =>
      store.uow.read((tx) => tx.assignments.get(project_id, assignment.id))
        ?.last_mcp_activity_at;
    expect(activity()).toBeUndefined();

    const client = await connect();
    try {
      await client.listTools();
      // Connecting and listing tools is not activity: the Agent has not acted.
      expect(activity()).toBeUndefined();
      await client.callTool({ name: "whoami", arguments: {} });
      expect(activity()).toBeDefined();
    } finally {
      await client.close();
    }
  });

  test("connecting and listing tools does not acknowledge the Run", async () => {
    const client = await connect();
    // connect() already sent initialize; list the tools as a real client does.
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain("whoami");

    expect(
      read(store.uow.read((tx) => tx.runs.list(project_id))[0]?.id as string)
        ?.status,
    ).toBe("dispatched");

    // The first tool call is what starts the Run.
    await client.callTool({ name: "whoami", arguments: {} });
    const run = store.uow.read((tx) => tx.runs.list(project_id)[0]);
    expect(run?.status).toBe("running");
    expect(assignment.id).toBe(run?.assignment_id);
  });
});
