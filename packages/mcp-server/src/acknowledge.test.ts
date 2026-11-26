import { createHash } from "node:crypto";
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
import { authenticate, type Identity } from "./auth.js";
import type { McpBackend } from "./backend.js";
import { acknowledgeDispatchedRun } from "./commands/acknowledge.js";
import { loadCommandState, persistEffect } from "./commands/execute.js";
import { type RunningServer, startMcpServer } from "./server.js";
import { acceptingVerifierFor } from "./test-support.js";

const project_id = "p-ack" as ProjectId;
/** C-600: the per-launch key a harness sends from its MCP configuration. */
const SESSION_KEY = "fictional-session-key-0123456789";
const SESSION_DIGEST = createHash("sha256").update(SESSION_KEY).digest("hex");
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
  allowed_tools: [
    "whoami",
    "get_card",
    "submit_delivery",
    "get_updates",
    "ack_events",
  ],
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
  options: { readonly dispatch?: boolean; readonly verify?: boolean } = {},
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
  store.uow.run((tx) => {
    for (const role_id of ["pm", "reviewer"])
      tx.roles.put(project_id, {
        role_id,
        role_version: 1,
        allowed_tools: ["submit_review"],
        capabilities: [],
      });
  });
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
        ...(options.verify
          ? {
              verify_mcp_session: {
                key_sha256: SESSION_DIGEST,
                token_id: "issued-at-launch",
              },
            }
          : {}),
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

test("C-735: a refused acknowledgement throws as before and leaves its reason on the Run and card once", () => {
  const { assignment, run_id, card } = dispatchedRun("none", { verify: true });
  const launch = {
    ...identity(assignment),
    token: { id: "issued-at-launch" },
  } as Identity;
  const refused = () => acknowledgeDispatchedRun(store, launch, () => NOW);
  expect(refused).toThrow();
  expect(read(run_id)).toMatchObject({
    status: "dispatched",
    ack_refusal: { code: "illegal_transition", at: NOW },
  });
  const events = () =>
    store.uow
      .read((tx) => tx.events.listAfter(project_id, card.id, 0))
      .filter((e) => e.type === "run_ack_refused");
  expect(events()).toHaveLength(1);
  expect(events()[0]?.payload).toMatchObject({
    run_id,
    assignment_id: assignment.id,
    code: "illegal_transition",
    message: read(run_id)?.ack_refusal?.message,
  });
  expect(refused).toThrow();
  expect(events()).toHaveLength(1);
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
        allowed_tools: [
          "whoami",
          "get_card",
          "submit_delivery",
          "get_updates",
          "ack_events",
        ],
      },
    }).token;
    running = await startMcpServer({
      store,
      deliveryVerifier: acceptingVerifierFor,
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

  test("only a successful call on the addressed stream receipts the current Run", async () => {
    const run = store.uow.run((tx) => {
      const r = tx.runs.list(project_id)[0];
      const ref = tx.assignments.get(project_id, assignment.id)?.runtime_ref;
      const card = tx.cards.list(project_id)[0];
      if (!r || !ref || !card) throw new Error("missing fixture");
      const bell_delivery = {
        run_id: r.id,
        card_id: card.id,
        runtime_ref: ref,
        sent_at: NOW,
      };
      tx.runs.put(project_id, { ...r, bell_delivery });
      return bell_delivery;
    });
    const client = await connect();
    try {
      await client.callTool({ name: "whoami", arguments: {} });
      await client.callTool({ name: "get_updates", arguments: {} });
      const bad = await client.callTool({
        name: "ack_events",
        arguments: { card_id: run.card_id, up_to_seq: 99999 },
      });
      expect(bad.isError).toBe(true);
      expect(read(run.run_id)?.status).toBe("running");
      expect(read(run.run_id)?.bell_delivery?.received_at).toBeUndefined();
      await client.callTool({
        name: "get_updates",
        arguments: { card_id: run.card_id },
      });
      expect(read(run.run_id)?.bell_delivery?.received_at).toBeDefined();
    } finally {
      await client.close();
    }
  });

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

describe("C-600 a verified session must list the Card tools natively", () => {
  let running: RunningServer;
  const tools = ["whoami", "get_card", "get_updates"];
  let token: string;
  /** A Token of the previous launch of the same Assignment, still valid. */
  let oldToken: string;
  const connect = async (key?: string, bearer = token) => {
    const client = new Client({ name: "fictional-client", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(running.url), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${bearer}`,
            ...(key ? { "X-Cardigan-Session": key } : {}),
          },
        },
      }),
    );
    return client;
  };
  const start = async (verify: boolean, backend: McpBackend = store) => {
    const seeded = dispatchedRun("none", { verify });
    const issue = () =>
      store.issueToken({
        project_id,
        assignment_id: seeded.assignment.id,
        role: {
          role_version: seeded.assignment.role_version,
          allowed_tools: tools,
        },
      });
    oldToken = issue().token;
    const issued = issue();
    token = issued.token;
    // The host binds the verified session to the Token it issued for it.
    if (verify)
      store.uow.run((tx) => {
        const a = tx.assignments.get(project_id, seeded.assignment.id);
        if (a)
          tx.assignments.put(project_id, {
            ...a,
            mcp_session_token_id: issued.record.id,
          });
      });
    running = await startMcpServer({
      store: backend,
      host: "127.0.0.1",
      port: 0,
      log: () => undefined,
    });
    return seeded;
  };
  /** The real store whose handshake write fails `failures` times. */
  const busyStore = (failures: number) => {
    let left = failures;
    return new Proxy(store, {
      get(target, property) {
        if (property === "advanceMcpHandshake")
          return (...args: Parameters<Store["advanceMcpHandshake"]>) => {
            if (args[2] === "tools_listed" && left > 0) {
              left--;
              throw new Error("database is locked");
            }
            return target.advanceMcpHandshake(...args);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as McpBackend;
  };
  const handshake = (id: Assignment["id"]) =>
    store.uow.read((tx) => tx.assignments.get(project_id, id))?.mcp_handshake;
  afterEach(async () => {
    await running?.close();
  });

  test("only this launch's harness unlocks the session; its first call starts the Run", async () => {
    const { assignment, run_id } = await start(true);
    expect(handshake(assignment.id)).toBe("pending");
    // Another client of the same Token (or a wrong key) listing proves nothing.
    const other = await connect();
    await other.listTools();
    const wrong = await connect("another-launch-key-0123456789");
    await wrong.listTools();
    expect(handshake(assignment.id)).toBe("pending");
    // initialize alone proves nothing either.
    const native = await connect(SESSION_KEY);
    expect(handshake(assignment.id)).toBe("pending");
    expect(read(run_id)?.status).toBe("dispatched");
    await native.listTools();
    expect(handshake(assignment.id)).toBe("listed");
    const who = await native.callTool({ name: "whoami", arguments: {} });
    expect(who.isError).not.toBe(true);
    expect(read(run_id)?.status).toBe("running");
    for (const client of [other, wrong, native]) await client.close();
  });

  test("a call that is not this launch's harness is refused, never starts the Run and stays refused", async () => {
    const { assignment, run_id } = await start(true);
    const wrapper = await connect();
    await wrapper.listTools();
    const refused = await wrapper.callTool({ name: "whoami", arguments: {} });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({
      error: {
        code: "illegal_transition",
        message: expect.stringContaining("MCP 初始化失败"),
      },
    });
    expect(handshake(assignment.id)).toBe("missing");
    expect(read(run_id)?.status).toBe("dispatched");
    // Even the harness's own key cannot revive the session afterwards.
    const native = await connect(SESSION_KEY);
    await native.listTools();
    const again = await native.callTool({ name: "get_updates", arguments: {} });
    expect(again.isError).toBe(true);
    expect(read(run_id)?.status).toBe("dispatched");
    expect(
      store.uow.read((tx) => tx.assignments.get(project_id, assignment.id))
        ?.last_mcp_activity_at,
    ).toBeUndefined();
    for (const client of [wrapper, native]) await client.close();
  });

  test("calls on the previous launch's Token never decide the new session's handshake", async () => {
    const { assignment, run_id } = await start(true);
    const late = await connect(undefined, oldToken);
    await late.listTools();
    const call = await late.callTool({ name: "whoami", arguments: {} });
    expect(call.isError).not.toBe(true);
    expect(handshake(assignment.id)).toBe("pending");
    // Nor can it start the new session's Run.
    expect(read(run_id)?.status).toBe("dispatched");
    const native = await connect(SESSION_KEY);
    await native.listTools();
    expect(handshake(assignment.id)).toBe("listed");
    await native.callTool({ name: "whoami", arguments: {} });
    expect(read(run_id)?.status).toBe("running");
    for (const client of [late, native]) await client.close();
  });

  test("V-2999:1 a late call of the previous launch neither starts nor refreshes a session that has only listed", async () => {
    const { assignment, run_id } = await start(true);
    const activity = () =>
      store.uow.read((tx) => tx.assignments.get(project_id, assignment.id))
        ?.last_mcp_activity_at;
    // The new harness has listed its tools but not called one yet.
    const native = await connect(SESSION_KEY);
    await native.listTools();
    expect(handshake(assignment.id)).toBe("listed");
    expect(read(run_id)?.status).toBe("dispatched");
    // The replaced session's late call is answered, but writes nothing.
    const late = await connect(undefined, oldToken);
    const call = await late.callTool({ name: "whoami", arguments: {} });
    expect(call.isError).not.toBe(true);
    expect(read(run_id)?.status).toBe("dispatched");
    expect(activity()).toBeUndefined();
    // Replaying the confirmation with that authenticated identity: same.
    const previous = authenticate(store, oldToken);
    if (!previous.ok) throw new Error("old Token must still authenticate");
    acknowledgeDispatchedRun(store, previous.value, () => NOW);
    expect(read(run_id)?.status).toBe("dispatched");
    expect(
      store.touchAssignmentActivity(
        project_id,
        assignment.id,
        NOW,
        previous.value.token.id,
      ),
    ).toBe(false);
    expect(activity()).toBeUndefined();
    // Only this launch's own first call starts the Run and counts as activity.
    const who = await native.callTool({ name: "whoami", arguments: {} });
    expect(who.isError).not.toBe(true);
    expect(read(run_id)?.status).toBe("running");
    expect(activity()).toBeDefined();
    for (const client of [late, native]) await client.close();
  });

  test("a briefly busy database is retried before the listing is answered", async () => {
    const { assignment, run_id } = await start(true, busyStore(2));
    const native = await connect(SESSION_KEY);
    await native.listTools();
    expect(handshake(assignment.id)).toBe("listed");
    const who = await native.callTool({ name: "whoami", arguments: {} });
    expect(who.isError).not.toBe(true);
    expect(read(run_id)?.status).toBe("running");
    await native.close();
  });

  test("an unrecorded listing is an error, and the same healthy session still starts afterwards", async () => {
    const { assignment, run_id } = await start(true, busyStore(4));
    const native = await connect(SESSION_KEY);
    await expect(native.listTools()).rejects.toThrow(/retry tools\/list/u);
    expect(handshake(assignment.id)).toBe("pending");
    // The database recovers: the harness's next request still counts.
    const who = await native.callTool({ name: "whoami", arguments: {} });
    expect(who.isError).not.toBe(true);
    expect(handshake(assignment.id)).toBe("listed");
    expect(read(run_id)?.status).toBe("running");
    await native.close();
  });

  test("sessions launched without verification keep the old behaviour", async () => {
    const { assignment, run_id } = await start(false);
    const client = await connect();
    const who = await client.callTool({ name: "whoami", arguments: {} });
    expect(who.isError).not.toBe(true);
    expect(handshake(assignment.id)).toBeUndefined();
    expect(read(run_id)?.status).toBe("running");
    await client.close();
  });
});
