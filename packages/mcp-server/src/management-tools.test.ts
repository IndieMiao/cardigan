import type {
  Assignment,
  Card,
  Decision,
  HumanAction,
  TimelineEntry,
  WorkItem,
} from "@cardigan/domain";
import { toolNames } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { memoryLogger } from "./log.js";
import { type RunningServer, startMcpServer } from "./server.js";
import { acceptingVerifierFor } from "./test-support.js";

const project = "management-fixture";
let store: Store, server: RunningServer, office: Client, card: Card;
let clients: Client[], sequence: number;
let secrets: string[], responses: unknown[];
type AssignmentReply = Assignment & {
  token_status: "pending_host_issuance" | "host_managed";
};
let logger: ReturnType<typeof memoryLogger>;
async function connect(assignment: Assignment, ops = false) {
  // Simulate the trusted host, not an MCP call: validate and issue in one transaction.
  const issued = store.uow.run((tx) => {
    const current = tx.assignments.get(project, assignment.id);
    if (
      current?.status !== "active" ||
      current.role_version !== assignment.role_version
    )
      throw new Error("Assignment cannot be provisioned");
    const role = tx.roles.get(project, {
      role_id: current.role_id,
      role_version: current.role_version,
    });
    if (!role) throw new Error("Missing role version");
    return tx.issueToken({
      id: ops ? `${current.mcp_token_id}:ops` : current.mcp_token_id,
      project_id: project,
      assignment_id: current.id,
      role: {
        role_version: role.role_version,
        allowed_tools: ops
          ? role.allowed_tools.filter((t) => t !== "record_decision")
          : role.allowed_tools,
      },
    });
  });
  secrets.push(issued.token);
  const client = new Client({ name: "management-test", version: "1" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${issued.token}` } },
    }),
  );
  return client;
}
const raw = async (
  client: Client,
  name: string,
  args: object,
  key = `request-${++sequence}`,
) => {
  const response = await client.callTool({
    name,
    arguments: { idempotency_key: key, ...args },
  });
  responses.push(response);
  return response;
};
async function ok<T>(
  client: Client,
  name: string,
  args: object,
  key?: string,
): Promise<T> {
  const result = await raw(client, name, args, key);
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(
    true,
  );
  return result.structuredContent as unknown as T;
}
const rows = () => ({
  assignments: store.uow.read((tx) => tx.assignments.list(project).length),
  events: store.uow.read(
    (tx) => tx.events.listAfter(project, card.id, 0).length,
  ),
  tokens: Number(
    store.database.prepare("SELECT COUNT(*) AS n FROM tokens").get()?.n,
  ),
});
beforeEach(async () => {
  store = Store.open({ dbPath: ":memory:" });
  clients = [];
  secrets = [];
  responses = [];
  sequence = 0;
  logger = memoryLogger();
  const standing = store.uow.run((tx): Assignment => {
    for (const role_id of ["pm", "coder", "reviewer"])
      tx.roles.put(project, {
        role_id,
        role_version: 1,
        allowed_tools: toolNames,
        capabilities: [],
      });
    const assignment: Assignment = {
      id: tx.ids.next(project, "assignment"),
      scope: "standing",
      role_id: "pm",
      role_version: 1,
      status: "active",
      runtime_state: "idle",
      runtime_ref: null,
      machine_id: "local",
      mcp_token_id: "fixture-office",
      created_at: "2026-01-01T00:00:00Z",
    };
    tx.assignments.put(project, assignment);
    return assignment;
  });
  server = await startMcpServer({
    store,
    deliveryVerifier: acceptingVerifierFor,
    log: logger.log,
  });
  office = await connect(standing);
  card = await ok<Card>(office, "create_card", {
    title: "Fixture",
    goal: "Ship",
    acceptance_criteria: ["Pass"],
    source: { kind: "quote", text: "Build it" },
    repo: "example/repo",
    base_branch: "main",
  });
});
afterEach(async () => {
  const persisted = store.database.prepare("SELECT * FROM idempotency").all();
  for (const secret of secrets) {
    for (const output of [responses, persisted, logger.entries])
      expect(JSON.stringify(output)).not.toContain(secret);
  }
  expect(JSON.stringify(responses)).not.toContain('"issued_tokens"');
  await Promise.all(clients.map((c) => c.close()));
  await server.close();
  store.close();
});
const work = (role: string) => {
  const found = store.uow.read((tx) =>
    tx.work_items
      .list(project)
      .find((w) => w.card_id === card.id && w.role_id === role),
  );
  if (!found) throw new Error("Missing work item");
  return found;
};
async function coder() {
  const assignment = await ok<AssignmentReply>(office, "assign", {
    work_item_id: work("coder").id,
    role_id: "coder",
  });
  expect(assignment.token_status).toBe("pending_host_issuance");
  store.uow.run((tx) =>
    tx.runs.put(project, {
      id: tx.ids.next(project, "run"),
      assignment_id: assignment.id,
      trigger_event_id: tx.ids.nextEventId(),
      kind: "initial",
      status: "running",
      role_version: 1,
      model: "fixture-model",
      agent_cli_version: "1",
      outcome: null,
      summary: "",
    }),
  );
  return connect(assignment);
}

test("MCP assign creates pending Assignments without credentials on initial calls, concurrency or replay", async () => {
  const updated = await ok<Card>(office, "update_card", {
    card_id: card.id,
    title: "Renamed",
  });
  expect(updated.title).toBe("Renamed");
  const added = await ok<WorkItem>(office, "create_work_item", {
    card_id: card.id,
    title: "Extra",
    kind: "produce",
    role_id: "coder",
    required: false,
    completion_criteria: ["Pass"],
  });
  expect(
    (
      await ok<WorkItem>(office, "update_work_item", {
        work_item_id: added.id,
        title: "Extra work",
      })
    ).title,
  ).toBe("Extra work");
  const params = { work_item_id: added.id, role_id: "coder" };
  const before = rows();
  const replies = await Promise.all(
    [0, 1].map(() =>
      ok<AssignmentReply>(office, "assign", params, "assign-once"),
    ),
  );
  const pending = replies[0];
  if (!pending) throw new Error("Missing assignment");
  expect(pending.token_status).toBe("pending_host_issuance");
  expect(replies[1]).toEqual(pending);
  expect(await ok(office, "assign", params, "assign-once")).toEqual(pending);
  const { token_status: _pending, ...assignment } = pending;
  expect(await ok(office, "assign", params, "assign-another-key")).toEqual({
    ...assignment,
    token_status: "host_managed",
  });
  expect(rows()).toEqual({
    assignments: before.assignments + 1,
    events: before.events + 1,
    tokens: before.tokens,
  });
  expect(
    store.database
      .prepare(
        "SELECT * FROM tokens WHERE project_id = ? AND assignment_id = ?",
      )
      .all(project, assignment.id),
  ).toEqual([]);
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${assignment.mcp_token_id}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(response.status).toBe(401);
  const cached = JSON.parse(
    String(
      store.database
        .prepare("SELECT response FROM idempotency WHERE key = 'assign-once'")
        .get()?.response,
    ),
  );
  expect(cached).toEqual(pending);
  expect(cached).not.toHaveProperty("issued_tokens");
  expect(cached).not.toHaveProperty("token");
});

test("collaboration tools use domain commands and preserve reviewable identities and decision quotes", async () => {
  const caller = await coder();
  const item = work("coder");
  const comment = await ok<TimelineEntry>(
    caller,
    "post_comment",
    {
      card_id: card.id,
      body: `See ${card.id}`,
      refs: [{ kind: "card", id: card.id }],
    },
    "comment-once",
  );
  expect(comment.author).toMatch(/^assignment:/u);
  expect(
    (
      await ok<TimelineEntry>(
        caller,
        "post_comment",
        {
          card_id: card.id,
          body: `See ${card.id}`,
          refs: [{ kind: "card", id: card.id }],
        },
        "comment-once",
      )
    ).id,
  ).toBe(comment.id);
  await ok(caller, "report_blocker", {
    work_item_id: item.id,
    reason: "Need help",
    needs: "role",
  });
  expect(
    (
      await ok<WorkItem>(office, "update_work_item", {
        work_item_id: item.id,
        status: "in_progress",
      })
    ).status,
  ).toBe("in_progress");
  const decision = await ok<Decision>(caller, "request_decision", {
    card_id: card.id,
    kind: "choose",
    category: "general",
    question: "Continue?",
    context: "Choice",
    options: [{ key: "go", description: "Continue", impact: "Unblocks" }],
    recommended: "go",
    affected_cards: [],
    affected_work_items: [],
    blocking: true,
    decider: "human",
  });
  const resolved = await ok<Decision>(office, "record_decision", {
    decision_id: decision.id,
    option: "go",
    rationale: "Confirmed",
    raw_quote: "  go  ",
    via_chain: ["human"],
    batch: "fixture-batch",
  });
  expect(resolved.resolution).toMatchObject({
    raw_quote: "  go  ",
    via_chain: ["human", "assignment:A-1"],
    batch: "fixture-batch",
  });
  store.uow.run((tx) => {
    for (const run of tx.runs.list(project))
      if (run.status === "queued")
        tx.runs.put(project, { ...run, status: "running" });
  });
  expect(
    (
      await ok<HumanAction>(caller, "request_human_action", {
        card_id: card.id,
        instructions: "Connect device",
        why_human: "Device",
        expected_return: "Connected",
        blocked_work_items: [item.id],
      })
    ).status,
  ).toBe("open");
  expect((await office.listTools()).tools.map((t) => t.name)).not.toContain(
    "complete_human_action",
  );
});

test("Ops and Office permissions and schema validation remain effective over MCP", async () => {
  const caller = await coder();
  expect(
    (
      await raw(caller, "create_card", {
        title: "No",
        goal: "No",
        acceptance_criteria: ["No"],
        source: { kind: "quote", text: "No" },
        repo: "example/repo",
        base_branch: "main",
      })
    ).structuredContent,
  ).toMatchObject({ error: { code: "forbidden_tool" } });
  const params = { work_item_id: work("reviewer").id, max_review_rounds: 5 };
  expect(
    (await raw(office, "update_work_item", params)).structuredContent,
  ).toMatchObject({ error: { code: "forbidden_tool" } });
  const standing = store.uow.read((tx) =>
    tx.assignments.list(project).find((a) => a.scope === "standing"),
  );
  if (!standing) throw new Error("Missing office");
  const ops = await connect(standing, true);
  expect(await ok<WorkItem>(ops, "update_work_item", params)).toMatchObject({
    max_review_rounds: 5,
  });
  expect((await ops.listTools()).tools.map((t) => t.name)).not.toContain(
    "record_decision",
  );
  expect(
    (
      await raw(office, "record_decision", {
        decision_id: "q(1)",
        option: "go",
        rationale: "x",
        raw_quote: "x",
        via_chain: ["A-1"],
      })
    ).structuredContent,
  ).toMatchObject({ error: { code: "validation_failed" } });
});

test("a failed pending assignment rolls back entities, events, counters and cache without issuing credentials", async () => {
  const params = { work_item_id: work("coder").id, role_id: "coder" };
  const before = rows();
  store.database.exec(
    "CREATE TRIGGER fail_assign BEFORE INSERT ON events WHEN NEW.type = 'work_item_assigned' BEGIN SELECT RAISE(ABORT, 'assignment fixture failure'); END",
  );
  expect((await raw(office, "assign", params, "atomic-assign")).isError).toBe(
    true,
  );
  expect(rows()).toEqual(before);
  expect(work("coder").assignment_id).toBeUndefined();
  store.database.exec("DROP TRIGGER fail_assign");
  const assigned = await ok<Assignment>(
    office,
    "assign",
    params,
    "atomic-assign",
  );
  expect(assigned.id).toBe("A-2");
  expect(rows()).toEqual({
    assignments: before.assignments + 1,
    tokens: before.tokens,
    events: before.events + 1,
  });
});
