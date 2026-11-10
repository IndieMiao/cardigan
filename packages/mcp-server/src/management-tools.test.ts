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
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
  const risk = await ok<Decision>(office, "request_decision", {
    ...question,
    category: "permission",
  });
  expect(
    (
      await raw(ops, "resolve_delegated_decision", {
        ...p,
        decision_id: risk.id,
      })
    ).isError,
  ).toBe(true);
  expect(
    (
      await raw(office, "record_decision", {
        ...p,
        decision_id: risk.id,
        raw_quote: "同意",
      })
    ).isError,
  ).toBe(true);
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
    instructions: "请在主机同步当前项目基线",
    expected_return: "回传最新 main SHA",
  });
  expect(triage).toMatchObject({
    triage: "host",
    instructions: "请在主机同步当前项目基线",
  });
});
