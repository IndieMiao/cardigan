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

const project = "management-fixture";
let store: Store, server: RunningServer, office: Client, card: Card;
let clients: Client[], sequence: number;
let logger: ReturnType<typeof memoryLogger>;
async function connect(assignment: Assignment, ops = false, token?: string) {
  const issued = token
    ? { token }
    : store.issueToken({
        project_id: project,
        assignment_id: assignment.id,
        role: {
          role_version: 1,
          allowed_tools: ops
            ? toolNames.filter((t) => t !== "record_decision")
            : toolNames,
        },
      });
  const client = new Client({ name: "management-test", version: "1" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${issued.token}` } },
    }),
  );
  return client;
}
const raw = (
  client: Client,
  name: string,
  args: object,
  key = `request-${++sequence}`,
) => client.callTool({ name, arguments: { idempotency_key: key, ...args } });
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
  server = await startMcpServer({ store, log: logger.log });
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
  const assignment = await ok<
    Assignment & { issued_tokens: { token: string }[] }
  >(office, "assign", { work_item_id: work("coder").id, role_id: "coder" });
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
  const credential = assignment.issued_tokens[0];
  if (!credential) throw new Error("Missing one-time credential");
  return connect(assignment, false, credential.token);
}

test("PM tools create/update cards and work, assign atomically and replay without extra credentials", async () => {
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
  type Reply = Assignment & { issued_tokens?: { token: string }[] };
  const replies = await Promise.all(
    [0, 1].map(() => ok<Reply>(office, "assign", params, "assign-once")),
  );
  expect(replies.filter((reply) => reply.issued_tokens)).toHaveLength(1);
  const first = replies.find((reply) => reply.issued_tokens);
  if (!first?.issued_tokens) throw new Error("Missing one-time credential");
  const { issued_tokens, ...assignment } = first;
  const credential = issued_tokens?.[0];
  if (!credential) throw new Error("Missing one-time credential");
  expect(store.verifyToken(credential.token)?.assignment_id).toBe(
    assignment.id,
  );
  const after = rows();
  expect(await ok(office, "assign", params, "assign-once")).toEqual(assignment);
  expect(await ok(office, "assign", params, "assign-another-key")).toEqual(
    assignment,
  );
  expect(rows()).toEqual(after);
  const stored = store.database
    .prepare("SELECT * FROM tokens WHERE id = ?")
    .get(assignment.mcp_token_id);
  expect(stored).toMatchObject({
    assignment_id: assignment.id,
    role_version: 1,
  });
  expect(stored?.token_hash).toMatch(/^[a-f0-9]{64}$/u);
  const cached = JSON.parse(
    String(
      store.database
        .prepare("SELECT response FROM idempotency WHERE key = 'assign-once'")
        .get()?.response,
    ),
  );
  expect(cached).toEqual(assignment);
  expect(cached).not.toHaveProperty("issued_tokens");
  expect(
    JSON.stringify(store.database.prepare("SELECT * FROM tokens").all()),
  ).not.toContain(credential.token);
  expect(
    JSON.stringify(store.database.prepare("SELECT * FROM idempotency").all()),
  ).not.toContain(credential.token);
  expect(JSON.stringify(logger.entries)).not.toContain(credential.token);
  expect(JSON.stringify(logger.entries)).not.toContain(
    String(stored?.token_hash),
  );
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

test("a failure after credential issuance rolls back the Assignment, token, events, counters and cache", async () => {
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
    tokens: before.tokens + 1,
    events: before.events + 1,
  });
});
