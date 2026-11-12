import type {
  Assignment,
  Card,
  Decision,
  HumanAction,
  TimelineEntry,
  WorkItem,
} from "@cardigan/domain";
import { toolNames } from "@cardigan/domain";
import { hashRequest, Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { managementTools } from "./commands/management-tools.js";
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
  vi.restoreAllMocks();
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
async function coder(reused = false) {
  const assignment = await ok<AssignmentReply>(office, "assign", {
    work_item_id: work("coder").id,
    role_id: "coder",
  });
  expect(assignment.token_status).toBe(
    reused ? "host_managed" : "pending_host_issuance",
  );
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
  // C-132: new decisions are Q-n; the legacy q(n) spelling resolves the same one.
  expect(decision.id).toMatch(/^Q-[1-9][0-9]*$/u);
  const recordArgs = {
    decision_id: decision.id.replace(/^Q-(\d+)$/u, "q($1)"),
    option: "go",
    rationale: "Confirmed",
    raw_quote: "  go  ",
    via_chain: ["human"],
    batch: "fixture-batch",
  };
  const resolved = await ok<Decision>(
    office,
    "record_decision",
    recordArgs,
    "retry-same",
  );
  expect(resolved.id).toBe(decision.id);
  // C-132: pretend this record was written before migration 0018, when the
  // server hashed the request with the id exactly as sent (`q(n)`). The same
  // retry through the real MCP entry still replays instead of conflicting.
  const parsed = managementTools()
    .find((t) => t.name === "record_decision")
    ?.input.parse({ ...recordArgs, idempotency_key: "retry-same" }) as Record<
    string,
    unknown
  >;
  const { idempotency_key: _key, ...legacyParams } = parsed;
  expect(legacyParams.decision_id).toBe(decision.id);
  store.database
    .prepare(
      "UPDATE idempotency SET request_hash = ?, created_at = '2000-01-01T00:00:00.000Z' WHERE key = 'retry-same'",
    )
    .run(
      hashRequest({
        tool: "record_decision",
        params: { ...legacyParams, decision_id: recordArgs.decision_id },
      }),
    );
  expect(
    await ok<Decision>(office, "record_decision", recordArgs, "retry-same"),
  ).toEqual(resolved);
  const conflict = await raw(
    office,
    "record_decision",
    { ...recordArgs, rationale: "Different" },
    "retry-same",
  );
  expect(conflict.isError).toBe(true);
  expect(JSON.stringify(conflict.structuredContent)).toContain(
    "idempotency_conflict",
  );
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

const newCard = {
  title: "Defaults",
  goal: "Use project defaults",
  acceptance_criteria: ["Created"],
  source: { kind: "quote", text: "Fixture" },
};
function registerRepository(
  repo = "/fixture/registered",
  branch = "release/default",
) {
  if (!store.getProject(project))
    store.createProject({ id: project, name: "Fixture" });
  expect(
    store.setProjectRepo({
      project_id: project,
      repo_path: repo,
      base_branch: branch,
    }).ok,
  ).toBe(true);
}
test.each([
  {},
  { repo: "explicit/repository" },
  { base_branch: "feature/explicit" },
])(
  "S21 create_card fills omitted fields from the token's project (%j)",
  async (explicit) => {
    registerRepository();
    store.createProject({ id: "other", name: "Other" });
    store.setProjectRepo({
      project_id: "other",
      repo_path: "/fixture/other",
      base_branch: "other-branch",
    });
    const created = await ok<Card>(office, "create_card", {
      ...newCard,
      ...explicit,
      project_id: "other",
    });
    expect(
      store.uow.read((tx) => tx.cards.get(project, created.id)),
    ).toMatchObject({
      repo: explicit.repo ?? "/fixture/registered",
      base_branch: explicit.base_branch ?? "release/default",
    });
    expect(created).not.toHaveProperty("repo");
    expect(JSON.stringify(created)).not.toContain("/fixture/registered");
    expect(
      await ok(office, "update_card", {
        card_id: created.id,
        title: "Updated",
      }),
    ).not.toHaveProperty("repo");
  },
);

test("S21 defaults resolve inside the command transaction and replay ignores changed project settings", async () => {
  registerRepository();
  const get = store.getProject.bind(store),
    reads: boolean[] = [];
  const spy = vi.spyOn(store, "getProject").mockImplementation((id) => {
    reads.push(store.database.isTransaction);
    return get(id);
  });
  const first = await ok<Card>(
    office,
    "create_card",
    newCard,
    "defaults-replay",
  );
  expect(reads).toEqual([true]);
  spy.mockRestore();
  const before = store.uow.read((tx) => ({
    cards: tx.cards.list(project),
    events: tx.events.listAfter(project, first.id, 0),
  }));
  registerRepository("/fixture/replacement", "replacement-branch");
  const replaySpy = vi.spyOn(store, "getProject");
  expect(await ok(office, "create_card", newCard, "defaults-replay")).toEqual(
    first,
  );
  expect(replaySpy).not.toHaveBeenCalled();
  replaySpy.mockRestore();
  expect(
    store.uow.read((tx) => ({
      cards: tx.cards.list(project),
      events: tx.events.listAfter(project, first.id, 0),
    })),
  ).toEqual(before);
});

test("S21 an unregistered project needs explicit metadata and a failed attempt can be retried", async () => {
  const before = store.uow.read((tx) => tx.cards.list(project).length);
  const failed = await raw(office, "create_card", newCard, "missing-default");
  expect(failed.structuredContent).toMatchObject({
    error: {
      code: "validation_failed",
      message: expect.stringContaining("registered repository"),
    },
  });
  expect(store.uow.read((tx) => tx.cards.list(project).length)).toBe(before);
  registerRepository();
  expect(
    (await ok<Card>(office, "create_card", newCard, "missing-default"))
      .base_branch,
  ).toBe("release/default");
});

test("S21 explicit repository and branch keep the existing mismatch behavior", async () => {
  registerRepository();
  const created = await ok<Card>(office, "create_card", {
    ...newCard,
    repo: "different/repo",
    base_branch: "different-base",
  });
  expect(
    store.uow.read((tx) => tx.cards.get(project, created.id)),
  ).toMatchObject({ repo: "different/repo", base_branch: "different-base" });
});

test("S21 tools/list advertises optional project defaults", async () => {
  const tool = (await office.listTools()).tools.find(
    (t) => t.name === "create_card",
  );
  expect(tool?.inputSchema.required).not.toContain("repo");
  expect(tool?.inputSchema.required).not.toContain("base_branch");
  expect(tool?.description).toMatch(/registered repository/);
  expect(tool?.description).toMatch(/default base branch/);
});

test("MCP assign accepts employee IDs/names, auto selects globally and whoami/read views resolve trusted identity", async () => {
  const employee = store.uow.run((tx) => {
    const e = {
      id: tx.global_ids.nextEmployeeId(),
      name: "Alice",
      title: "开发工程师",
      bio: "private bio",
      avatar: "avatar:alice",
      role_id: "coder",
      launch_profile_ref: "private-profile",
      status: "active" as const,
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
    };
    tx.employees.put(e);
    return e;
  });
  const assigned = await ok<AssignmentReply>(office, "assign", {
    work_item_id: work("coder").id,
    role_id: "coder",
    employee_id: " ALICE ",
  });
  expect(assigned.employee_id).toBe(employee.id);
  const client = await coder(true);
  expect(await ok(client, "whoami", { employee_id: "E-999" })).toMatchObject({
    employee_id: employee.id,
    employee_name: "Alice",
    employee_title: "开发工程师",
  });
  expect(await ok(office, "whoami", {})).toMatchObject({
    employee_id: null,
    employee_name: null,
    employee_title: null,
  });
  await ok(client, "post_comment", {
    card_id: card.id,
    body: "I am somebody else",
    work_item_id: work("coder").id,
  });
  const updates = await ok<{
    timeline: (TimelineEntry & { employee: unknown; author_display: string })[];
  }>(office, "get_updates", { card_id: card.id, since_seq: 0 });
  expect(updates.timeline.at(-1)).toMatchObject({
    author: `assignment:${assigned.id}`,
    author_display: "Alice",
    employee: {
      id: employee.id,
      name: "Alice",
      title: "开发工程师",
      avatar: "avatar:alice",
    },
  });
  expect(JSON.stringify(updates)).not.toContain("private-profile");
  expect(JSON.stringify(updates)).not.toContain("private bio");
  const delivery = await ok(client, "submit_delivery", {
    work_item_id: work("coder").id,
    kind: "code",
    summary: "Done",
    subject: { kind: "doc_version", value: "v1" },
    requested_verifiers: [work("reviewer").id],
  });
  expect(delivery).toBeDefined();
  const detail = await ok<{
    deliveries: { employee: { id: string }; author: string }[];
  }>(office, "get_card", { card_id: card.id });
  expect(detail.deliveries[0]).toMatchObject({
    author: `assignment:${assigned.id}`,
    employee: { id: employee.id, name: "Alice" },
  });
  const failed = await raw(office, "assign", {
    work_item_id: work("reviewer").id,
    role_id: "reviewer",
    employee_id: employee.id,
  });
  expect(failed.isError).toBe(true);
});

test("Agent comments discover full employee names without trusting the client's truncated mentions", async () => {
  store.uow.run((tx) =>
    tx.employees.put({
      id: "E-1",
      name: "Mary Jane",
      title: "开发",
      bio: "",
      avatar: null,
      role_id: "coder",
      launch_profile_ref: null,
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    }),
  );
  const comment = await ok<TimelineEntry>(office, "post_comment", {
    card_id: card.id,
    body: "请 @MARY　JANE 和 @reviewer 检查",
    mentions: ["MARY", "reviewer"],
  });
  expect(comment.mentions).toContain("@Mary Jane");
  expect(comment.mentions).toContain("reviewer");
  expect(comment.mentions).not.toContain("MARY");
  expect(comment.author).toBe("assignment:A-1");
  expect(
    store.uow.read((tx) => tx.timeline.get(project, comment.id))?.mentions,
  ).toEqual(comment.mentions);
});

test("MCP hides globally external employees from PM candidates and rejects explicit or automatic assignment", async () => {
  store.createProject({ id: "external-project" });
  store.uow.run((tx) => {
    tx.employees.put({
      id: "E-1",
      name: "External Office",
      title: "PM",
      bio: "private bio",
      avatar: null,
      role_id: "pm",
      launch_profile_ref: "private-profile",
      status: "active",
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
    });
    tx.assignments.put("external-project", {
      id: "A-1",
      scope: "standing",
      standing_mode: "office",
      employee_id: "E-1",
      external: true,
      role_id: "pm",
      role_version: 1,
      status: "active",
      runtime_state: "not_provisioned",
      runtime_ref: null,
      machine_id: "local",
      mcp_token_id: "external-office",
      created_at: "2026-01-01",
    });
  });
  const before = rows();
  for (const employee_id of ["E-1", "external office", undefined]) {
    const result = await raw(office, "assign", {
      work_item_id: work("pm").id,
      role_id: "pm",
      ...(employee_id ? { employee_id } : {}),
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("外接员工，不由 Cardigan 启动");
    expect(rows()).toEqual(before);
  }
  expect(await ok(office, "project_snapshot", {})).toMatchObject({
    available_employees: [],
  });
  store.uow.run((tx) => {
    const external = tx.employees.get("E-1");
    if (!external) throw new Error("Missing employee");
    tx.employees.put({ ...external, id: "E-2", name: "Internal PM" });
  });
  const snapshot = await ok<{ available_employees: unknown[] }>(
    office,
    "project_snapshot",
    {},
  );
  expect(snapshot.available_employees).toEqual([
    { id: "E-2", name: "Internal PM", title: "PM", role_id: "pm" },
  ]);
  expect(JSON.stringify(snapshot)).not.toContain("private-profile");
  expect(JSON.stringify(snapshot)).not.toContain("private bio");
  expect(
    await ok(office, "assign", {
      work_item_id: work("pm").id,
      role_id: "pm",
    }),
  ).toMatchObject({ employee_id: "E-2" });
});

test.each(
  [false, true].flatMap((paused) =>
    ["current", "missing"].map((target) => ({ paused, target })),
  ),
)(
  "record_decision raises review limits once through PM Office (paused=$paused, target=$target)",
  async ({ paused, target }) => {
    const reviewer = work("reviewer");
    if (reviewer.kind !== "verify") throw new Error("Missing verifier");
    const assignment = await ok<AssignmentReply>(office, "assign", {
      work_item_id: reviewer.id,
      role_id: "reviewer",
    });
    if (target === "current") {
      const producer = await coder();
      await ok(producer, "submit_delivery", {
        work_item_id: work("coder").id,
        kind: "code",
        summary: "Current review target",
        subject: { kind: "doc_version", value: "v1" },
        requested_verifiers: [reviewer.id],
      });
    }
    const q = await ok<Decision>(office, "request_decision", {
      card_id: card.id,
      kind: "choose",
      category: "general",
      question: "Review limit",
      context: "Review budget exhausted",
      options: [
        { key: "raise_limit", description: "Add a round", impact: "Resume" },
        { key: "pause", description: "Pause", impact: "Wait" },
      ],
      recommended: "raise_limit",
      affected_cards: [card.id],
      affected_work_items: [],
      blocking: true,
      decider: "human",
    });
    // Trusted control-plane fixture; request_decision cannot forge the trigger.
    store.uow.run((tx) => {
      tx.decisions.put(project, {
        ...q,
        trigger: "review_limit",
        affected_work_items: [reviewer.id],
      });
      tx.work_items.put(project, {
        ...reviewer,
        assignment_id: assignment.id,
        status: "waiting_decision",
        max_review_rounds: 1,
      });
      tx.runs.put(project, {
        id: tx.ids.next(project, "run"),
        assignment_id: assignment.id,
        trigger_event_id: tx.ids.nextEventId(),
        kind: "initial",
        status: "completed",
        role_version: 1,
        model: "fixture-model",
        agent_cli_version: "1",
        outcome: "blocked",
        summary: "Review limit",
      });
    });
    if (paused)
      await ok(office, "record_decision", {
        decision_id: q.id,
        option: "pause",
        rationale: "Check first",
        raw_quote: "Wait",
      });
    const params = {
      decision_id: q.id,
      option: "raise_limit",
      rationale: "Confirmed",
      raw_quote: "One more round",
    };
    const result = await ok<Decision>(
      office,
      "record_decision",
      params,
      "raise-once",
    );
    expect(result).toMatchObject({
      status: "resolved",
      resolution: { via: "pm_office_chat", raw_quote: params.raw_quote },
    });
    expect(work("reviewer")).toMatchObject({
      max_review_rounds: 2,
      status: "ready",
    });
    const queued = () =>
      store.uow.read((tx) =>
        tx.runs
          .list(project)
          .filter(
            (r) => r.assignment_id === assignment.id && r.status === "queued",
          ),
      );
    const resumed = queued();
    // Raising the budget resumes work, but only a current target permits a Run.
    expect(resumed).toHaveLength(target === "current" ? 1 : 0);
    if (target === "current")
      expect(resumed[0]).toMatchObject({
        kind: "decision_resumed",
        role_version: 1,
        model: "fixture-model",
        agent_cli_version: "1",
      });
    expect(await ok(office, "record_decision", params, "raise-once")).toEqual(
      result,
    );
    expect((await raw(office, "record_decision", params)).isError).toBe(true);
    expect(work("reviewer")).toMatchObject({ max_review_rounds: 2 });
    expect(queued()).toEqual(resumed);
    expect(
      store.uow.read((tx) =>
        tx.events
          .listAfter(project, card.id, 0)
          .filter((e) => e.type === "work_item_updated"),
      ),
    ).toHaveLength(1);
  },
);

test("category authorization uses PM Ops tools, rejects Office/high-risk bypasses, and replays once", async () => {
  const opsAssignment = store.uow.run((tx): Assignment => {
    const front = tx.assignments.list(project)[0];
    if (!front) throw new Error("Missing Office");
    const ops: Assignment = {
      ...front,
      id: tx.ids.next(project, "assignment"),
      scope: "standing",
      standing_mode: "ops",
      mcp_token_id: "fixture-delegation-ops",
    };
    tx.assignments.put(project, ops);
    return ops;
  });
  const ops = await connect(opsAssignment, true);
  const question = {
    card_id: card.id,
    kind: "choose",
    question: "如何继续",
    context: "已确认可选方案",
    options: [{ key: "go", description: "继续", impact: "推进工作" }],
    recommended: "go",
    affected_cards: [card.id],
    affected_work_items: [],
    blocking: false,
    decider: "human",
  };
  expect((await raw(office, "request_decision", question)).isError).toBe(true);
  const q = await ok<Decision>(office, "request_decision", {
    ...question,
    category: "feature_detail",
  });
  expect(q.decider).toBe("role:pm");
  const p = {
    decision_id: q.id,
    option: "go",
    rationale: "确认属于功能细节授权",
  };
  expect((await raw(office, "resolve_delegated_decision", p)).isError).toBe(
    true,
  );
  const resolved = await ok<Decision>(
    ops,
    "resolve_delegated_decision",
    p,
    "delegation-answer",
  );
  expect(resolved.resolution).toMatchObject({
    via: "delegated",
    proxy_authority: expect.stringContaining("feature_detail"),
    rationale: p.rationale,
  });
  expect(
    await ok(ops, "resolve_delegated_decision", p, "delegation-answer"),
  ).toEqual(resolved);
  const agent = await coder();
  for (const category of [
    "spending",
    "account",
    "permission",
    "data_deletion",
  ]) {
    const risk = await ok<Decision>(office, "request_decision", {
      ...question,
      category,
    });
    for (const client of [ops, office, agent]) {
      expect(
        (
          await raw(client, "resolve_delegated_decision", {
            ...p,
            decision_id: risk.id,
          })
        ).isError,
      ).toBe(true);
      expect(
        (
          await raw(client, "record_decision", {
            ...p,
            decision_id: risk.id,
            raw_quote: "同意",
            actor: { kind: "human" },
            human_confirmation: "workbench",
          })
        ).isError,
      ).toBe(true);
    }
    expect(
      store.uow.read((tx) => tx.decisions.get(project, risk.id))?.status,
    ).toBe("open");
  }
  const action = await ok<HumanAction>(office, "request_human_action", {
    card_id: card.id,
    instructions: "同步代码",
    why_human: "主机持有凭据",
    expected_return: "SHA",
    blocked_work_items: [],
  });
  expect(action.triage).toBe("pm_ops");
  const triage = await ok<HumanAction>(ops, "triage_human_action", {
    human_action_id: action.id,
    disposition: "host",
    rationale: "需要主机同步",
    title: "请同步主机上的最新代码",
    summary: "开发者正在等待项目的新基线。",
    why_human: "同步凭据只在主机上，需要你操作。",
    expected_outcome: "同步完成后开发者可继续修改。",
    instructions: "请在主机同步当前项目基线",
    expected_return: "回传最新 main SHA",
  });
  expect(triage).toMatchObject({
    triage: "host",
    instructions: "同步代码",
    handoff: {
      title: "请同步主机上的最新代码",
      instructions: "请在主机同步当前项目基线",
    },
  });
});

test("C-110: only standing PM Ops can replace a template verifier; invalid attempts and persistence failure roll back", async () => {
  const tool = "replace_verification_work_item";
  const old = work("pm");
  const opsAssignment = store.uow.run((tx): Assignment => {
    const front = tx.assignments.list(project)[0];
    if (!front) throw new Error("Missing Office");
    const ops: Assignment = {
      ...front,
      id: tx.ids.next(project, "assignment"),
      scope: "standing",
      standing_mode: "ops",
      mcp_token_id: "fixture-replacement-ops",
    };
    tx.assignments.put(project, ops);
    return ops;
  });
  const ops = await connect(opsAssignment, true);
  const p = {
    work_item_id: old.id,
    card_id: card.id,
    template_key: old.template_key,
    reason: "原验证项取消后换人",
  };
  const agent = await coder();
  const reviewer = await ok<AssignmentReply>(office, "assign", {
    work_item_id: work("reviewer").id,
    role_id: "reviewer",
  });
  const acceptance = await ok<AssignmentReply>(office, "assign", {
    work_item_id: old.id,
    role_id: "pm",
  });
  for (const client of [
    office,
    agent,
    await connect(reviewer),
    await connect(acceptance),
  ]) {
    expect((await client.listTools()).tools.some((t) => t.name === tool)).toBe(
      false,
    );
    expect((await raw(client, tool, p)).isError).toBe(true);
  }
  expect((await ops.listTools()).tools.some((t) => t.name === tool)).toBe(true);
  const snapshot = () =>
    store.uow.read((tx) => ({
      items: tx.work_items.list(project),
      assignments: tx.assignments
        .list(project)
        .map(({ last_mcp_activity_at: _activity, ...assignment }) => assignment)
        .sort((a, b) => a.id.localeCompare(b.id)),
      deliveries: tx.deliveries.list(project),
      events: tx.events.listAfter(project, card.id, 0),
      timeline: tx.timeline.list(project),
      id_counters: store.database
        .prepare("SELECT * FROM id_counters ORDER BY project_id, kind")
        .all(),
      event_counters: store.database
        .prepare("SELECT * FROM event_counters ORDER BY project_id, stream")
        .all(),
    }));
  const beforeActive = snapshot();
  expect((await raw(ops, tool, p)).isError).toBe(true);
  expect(snapshot()).toEqual(beforeActive);
  store.uow.run((tx) => {
    const current = tx.work_items.get(project, old.id);
    if (!current) throw new Error("Missing original");
    tx.work_items.put(project, { ...current, status: "cancelled" });
  });
  const before = snapshot();
  for (const invalid of [
    { ...p, card_id: "C-999" },
    { ...p, template_key: "code_review" },
    { ...p, work_item_id: work("coder").id },
  ]) {
    const r = await raw(ops, tool, invalid);
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).toMatch(/[\u4e00-\u9fff]/u);
    expect(snapshot()).toEqual(before);
  }
  store.database.exec(
    "CREATE TRIGGER fail_replace BEFORE INSERT ON events WHEN NEW.type = 'work_item_replaced' BEGIN SELECT RAISE(ABORT, 'replacement fixture failure'); END",
  );
  expect((await raw(ops, tool, p, "replace-once")).isError).toBe(true);
  expect(snapshot()).toEqual(before);
  store.database.exec("DROP TRIGGER fail_replace");
  const replacement = await ok<WorkItem>(ops, tool, p, "replace-once");
  expect(replacement).toMatchObject({
    template_key: old.template_key,
    card_id: card.id,
    required: true,
    status: "todo",
  });
  expect(replacement.assignment_id).toBeUndefined();
  expect(await ok<WorkItem>(ops, tool, p, "replace-once")).toEqual(replacement);
  expect((await raw(ops, tool, p)).isError).toBe(true);
  expect(
    store.uow.read((tx) => tx.work_items.get(project, old.id)),
  ).toMatchObject({
    required: false,
    replaced_by_work_item_id: replacement.id,
    assignment_id: acceptance.id,
  });
  expect(
    store.uow.read((tx) =>
      tx.events
        .listAfter(project, card.id, 0)
        .filter((e) => e.type === "work_item_replaced"),
    ),
  ).toHaveLength(1);
  const assigned = await ok<AssignmentReply>(ops, "assign", {
    work_item_id: replacement.id,
    role_id: "pm",
  });
  expect(assigned.id).not.toBe(acceptance.id);
});
