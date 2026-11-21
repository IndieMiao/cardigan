import type {
  Assignment,
  Card,
  Decision,
  Delivery,
  HumanAction,
  RoleRuleBasis,
  RoleRuleInventory,
  TimelineEntry,
  WorkItem,
} from "@cardigan/domain";
import {
  prepareMergePlan,
  productCardTemplate,
  recordDecision,
  recordMergeCheck,
  saveMachine,
  toolNames,
} from "@cardigan/domain";
import { hashRequest, Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DeliveryVerifierFor } from "./commands/delivery-tools.js";
import { loadCommandState, persistEffect, unwrap } from "./commands/execute.js";
import { managementTools } from "./commands/management-tools.js";
import { memoryLogger } from "./log.js";
import { type RunningServer, startMcpServer } from "./server.js";
import { acceptingVerifierFor } from "./test-support.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

const project = "management-fixture";
let store: Store, server: RunningServer, office: Client, card: Card;
let clients: Client[], sequence: number;
let secrets: string[], responses: unknown[];
type AssignmentReply = Assignment & {
  token_status: "pending_host_issuance" | "host_managed";
};
let logger: ReturnType<typeof memoryLogger>;
let verifierFor: DeliveryVerifierFor;
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
test("B3b create_card expands registered product with PM acceptance and pins its version", async () => {
  store.uow.run((tx) => tx.card_templates.put(project, productCardTemplate));
  const created = await ok<Card>(office, "create_card", {
    title: "Product",
    goal: "Ship",
    template_id: "product",
    acceptance_criteria: ["Accepted"],
    source: { kind: "quote", text: "Build it" },
    repo: "example/repo",
    base_branch: "main",
  });
  expect(created).toMatchObject({
    template: "product",
    template_version: 1,
    flow_version: 1,
  });
  const items = store.uow
    .read((tx) => tx.work_items.list(project))
    .filter((w) => w.card_id === created.id);
  expect(items.map((w) => w.template_key)).toEqual([
    "development",
    "code_review",
    "pm_acceptance",
  ]);
  expect(items[1]?.completion_criteria).toEqual([
    "Accepted",
    productCardTemplate.work_items[1].completion_criteria[0],
  ]);
  expect(
    store.uow.read((tx) => tx.cards.get(project, card.id))?.template_version,
  ).toBe(1);
});

test("create_card passes a design write contract from discovery through storage and review", async () => {
  store.uow.run((tx) => {
    for (const role_id of ["ui_ux_designer", "design_director"])
      tx.roles.put(project, {
        role_id,
        role_version: 1,
        allowed_tools: toolNames,
        capabilities: [],
      });
  });
  const { templates } = await ok<{
    templates: { id: string; requires_state_and_save?: boolean }[];
  }>(office, "list_templates", {});
  expect(
    templates.find((t) => t.id === "design")?.requires_state_and_save,
  ).toBe(true);
  const input = {
    template_id: "design",
    title: "Settings",
    goal: "Design",
    acceptance_criteria: ["Review the draft"],
    source: { kind: "quote", text: "Settings" },
  };
  const missing = await raw(office, "create_card", input);
  expect(missing.isError).toBe(true);
  expect(JSON.stringify(missing.content)).toContain("状态与保存");
  const plan = {
    save_timing: "即时",
    leave_behavior: "允许离开",
    failure_feedback: "全站提示",
    consistency: "按版本补读",
  };
  const created = await ok<Card>(office, "create_card", {
    ...input,
    state_and_save: plan,
  });
  expect(
    store.uow.read((tx) => tx.cards.get(project, created.id))?.state_and_save,
  ).toEqual(plan);
  const items = store.uow
    .read((tx) => tx.work_items.list(project))
    .filter((w) => w.card_id === created.id);
  expect(items.find((w) => w.role_id === "design_director")).toMatchObject({
    required: true,
    completion_criteria: expect.arrayContaining([
      expect.stringContaining("读写一致性：按版本补读"),
    ]),
  });
});

beforeEach(async () => {
  store = Store.open({ dbPath: ":memory:" });
  store.createProject({ id: project });
  clients = [];
  secrets = [];
  responses = [];
  sequence = 0;
  logger = memoryLogger();
  verifierFor = acceptingVerifierFor;
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
    deliveryVerifier: (...args) => verifierFor(...args),
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

test("MCP ordinary card writes cannot select or overwrite the human-owned flow version", async () => {
  await raw(office, "create_card", {
    title: "Flow override",
    goal: "Keep project flow",
    acceptance_criteria: ["Fixed"],
    source: { kind: "quote", text: "Fixture" },
    repo: "example/repo",
    base_branch: "main",
    flow_version: 2,
  });
  // Unknown fields may be rejected or stripped by the tool schema.
  expect(
    store.uow
      .read((tx) => tx.cards.list(project))
      .every((c) => c.flow_version === 1),
  ).toBe(true);
  await raw(office, "update_card", { card_id: card.id, flow_version: 2 });
  expect(
    store.uow.read((tx) => tx.cards.get(project, card.id))?.flow_version,
  ).toBe(1);
});

test("PM assign filters trusted machines but MCP cannot register or widen authorization", async () => {
  const tools = await office.listTools();
  expect(tools.tools.map((t) => t.name)).not.toContain("manage_machines");
  const params = {
    work_item_id: work("coder").id,
    role_id: "coder",
    machine_id: "worker-a",
    os: "darwin",
    arch: "arm64",
    required_tags: ["gpu"],
  };
  const before = rows();
  expect((await raw(office, "assign", params)).isError).toBe(true);
  expect(rows()).toEqual(before);
  store.uow.run((tx) => {
    const effect = unwrap(
      saveMachine(
        loadCommandState(tx, project),
        { kind: "human", project_id: project },
        {
          operation: "register",
          machine: {
            id: "worker-a",
            label: "Worker A",
            herdr_machine: "worker-a",
            os: "darwin",
            arch: "arm64",
            tags: ["gpu"],
            status: "online",
            last_seen: "2026-01-01T00:00:00Z",
            max_assignments: 1,
          },
        },
        { clock: { now: () => "2026-01-01T00:00:00Z" }, ids: tx.ids },
      ),
    );
    persistEffect(tx, project, effect);
  });
  expect(
    (await raw(office, "assign", { ...params, required_tags: ["missing"] }))
      .isError,
  ).toBe(true);
  const selected = await ok<AssignmentReply>(office, "assign", params);
  expect(selected.machine_id).toBe("worker-a");
  expect(
    (await raw(office, "assign", { ...params, machine_id: "local" })).isError,
  ).toBe(true);
  expect(
    store.uow.read((tx) => tx.assignments.get(project, selected.id))
      ?.machine_id,
  ).toBe("worker-a");
});
async function coder(reused = false) {
  return assignee("coder", reused);
}
async function assignee(role: string, reused = false) {
  const assignment = await ok<AssignmentReply>(office, "assign", {
    work_item_id: work(role).id,
    role_id: role,
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
    events: before.events + 2, // Assignment and machine-selection audit commit together.
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
    plain_summary: TEST_PLAIN_SUMMARY,
  });
  expect(decision.decider).toBe("role:pm");
  const opsAssignment = store.uow.run((tx): Assignment => {
    const front = tx.assignments.list(project)[0];
    if (!front) throw new Error("Missing Office");
    const a: Assignment = {
      ...front,
      id: tx.ids.next(project, "assignment"),
      standing_mode: "ops",
      mcp_token_id: "fixture-triage-ops",
    };
    tx.assignments.put(project, a);
    return a;
  });
  const ops = await connect(opsAssignment, true);
  await ok(ops, "resolve_delegated_decision", {
    decision_id: decision.id,
    option: "go",
    rationale: "Human choice requested after triage",
    escalate: true,
    plain_summary: TEST_PLAIN_SUMMARY,
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
  // Free text is never respelled: a pre-upgrade request whose raw_quote reads
  // like a new number replays unchanged, and changing only that text conflicts.
  store.database
    .prepare(
      "INSERT INTO idempotency (project_id, assignment_id, key, request_hash, response, created_at) " +
        "SELECT project_id, assignment_id, 'retry-text', ?, response, created_at FROM idempotency WHERE key = 'retry-same'",
    )
    .run(
      hashRequest({
        tool: "record_decision",
        params: {
          ...legacyParams,
          decision_id: recordArgs.decision_id,
          raw_quote: decision.id,
        },
      }),
    );
  expect(
    await ok<Decision>(
      office,
      "record_decision",
      { ...recordArgs, raw_quote: decision.id },
      "retry-text",
    ),
  ).toEqual(resolved);
  const textChanged = await raw(
    office,
    "record_decision",
    { ...recordArgs, raw_quote: recordArgs.decision_id },
    "retry-text",
  );
  expect(JSON.stringify(textChanged.structuredContent)).toContain(
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
        blocks_merge: true,
        prerequisite: "external_account" as const,
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
    "CREATE TRIGGER fail_assign BEFORE INSERT ON events WHEN NEW.type = 'machine_selected' BEGIN SELECT RAISE(ABORT, 'assignment fixture failure'); END",
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
    events: before.events + 2, // Assignment and machine-selection audit commit together.
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
  ["product", 1],
  ["dev", 2],
] as const)(
  "flow 5 MCP creates %s@%i with the registered repository when metadata is omitted",
  async (template, version) => {
    registerRepository();
    store.uow.run((tx) =>
      tx.project_preferences.put(project, {
        id: project,
        auto_merge_after_minutes: null,
        flow_version: 5,
        system_merge_shadow_policy: { role_rule_paths: [], release_paths: [] },
      }),
    );
    const created = await ok<Card>(office, "create_card", {
      ...newCard,
      template_id: template,
    });
    expect(created).toMatchObject({
      template,
      template_version: version,
      flow_version: 5,
    });
    expect(
      store.uow.read((tx) => tx.cards.get(project, created.id)),
    ).toMatchObject({
      repo: "/fixture/registered",
      base_branch: "release/default",
      template_version: version,
    });
    expect(
      store.uow.read((tx) => tx.cards.get(project, card.id))?.template_version,
    ).toBe(1);
  },
);

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
      plain_summary: TEST_PLAIN_SUMMARY,
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
    plain_summary: TEST_PLAIN_SUMMARY,
  };
  expect((await raw(office, "request_decision", question)).isError).toBe(true);
  const q = await ok<Decision>(office, "request_decision", {
    ...question,
    category: "feature_detail",
  });
  expect(q.decider).toBe("role:pm");
  expect(q).toMatchObject({
    routed_to: "role:pm",
    routing_reason: `project:${project}/default-decision-delegation/feature_detail`,
  });
  expect(
    store.uow
      .read((tx) => tx.timeline.list(project))
      .some(
        (entry) =>
          entry.decision_id === q.id &&
          entry.body.includes("已按常驻授权转给 PM"),
      ),
  ).toBe(true);
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
  for (const client of [office, agent]) {
    const forcedParams = {
      ...question,
      category: "credential",
      human_required_reason: "凭据操作须由人决定",
    };
    const key = `forced-${++sequence}`;
    const forced = await ok<Decision>(
      client,
      "request_decision",
      forcedParams,
      key,
    );
    expect(forced).toMatchObject({
      decider: client === agent ? "role:pm" : "human",
      human_required_reason: forcedParams.human_required_reason,
    });
    expect(await ok(client, "request_decision", forcedParams, key)).toEqual(
      forced,
    );
    const {
      routed_to: _to,
      routing_reason: _reason,
      ...persisted
    } = forced as Decision & { routed_to?: string; routing_reason?: string };
    expect(
      store.uow.read((tx) => tx.decisions.get(project, forced.id)),
    ).toEqual(persisted);
    const before = rows();
    for (const invalid of ["", "  ", null, 7])
      expect(
        (
          await raw(client, "request_decision", {
            ...forcedParams,
            human_required_reason: invalid,
          })
        ).isError,
      ).toBe(true);
    expect(
      (
        await raw(client, "request_decision", {
          ...forcedParams,
          decider: "role:pm",
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await raw(
          client,
          "request_decision",
          { ...forcedParams, human_required_reason: "另一个理由" },
          key,
        )
      ).isError,
    ).toBe(true);
    expect(
      (
        await raw(ops, "resolve_delegated_decision", {
          ...p,
          decision_id: forced.id,
          human_required_reason: "",
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await raw(office, "record_decision", {
          ...p,
          decision_id: forced.id,
          raw_quote: "同意",
          human_required_reason: "",
        })
      ).isError,
    ).toBe(true);
    expect(rows()).toEqual(before);
    expect(
      store.uow.read((tx) => tx.decisions.get(project, forced.id)),
    ).toEqual(persisted);
  }
  for (const category of [
    "spending",
    "account",
    "credential",
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

test.each([
  "none",
  "low",
  "medium",
  "high",
  "urgent",
  "无",
  "低",
  "中",
  "高",
  "紧急",
])("MCP card commands accept priority tier %s", async (priority) => {
  const rank =
    [
      "none",
      "low",
      "medium",
      "high",
      "urgent",
      "无",
      "低",
      "中",
      "高",
      "紧急",
    ].indexOf(priority) % 5;
  const created = await ok<Card>(office, "create_card", {
    title: "Priority",
    goal: "Queue order",
    acceptance_criteria: ["Fixed tier"],
    source: { kind: "quote", text: "Priority" },
    repo: "fixture",
    base_branch: "main",
    priority,
  });
  expect(created.priority).toBe(rank);
  expect(
    (await ok<Card>(office, "update_card", { card_id: card.id, priority }))
      .priority,
  ).toBe(rank);
});

test.each([0, 5, "3", "rush"])(
  "MCP rejects non-name priority %s without writes",
  async (priority) => {
    const before = rows();
    expect(
      (await raw(office, "update_card", { card_id: card.id, priority }))
        .isError,
    ).toBe(true);
    expect(rows()).toEqual(before);
  },
);

test("risk tags survive MCP update, storage and get_card; invalid values have no effects", async () => {
  expect(card.risk_tags).toBeUndefined();
  const risk_tags = ["security", "permission", "numeric_rule"];
  expect(
    await ok<Card>(office, "update_card", { card_id: card.id, risk_tags }),
  ).toMatchObject({ risk_tags });
  expect(
    store.uow.read((tx) => tx.cards.get(project, card.id))?.risk_tags,
  ).toEqual(risk_tags);
  expect(await ok(office, "get_card", { card_id: card.id })).toMatchObject({
    card: { risk_tags },
  });
  const before = rows();
  for (const invalid of [
    ["spending"],
    ["security", "concurrency"],
    "security",
    null,
  ])
    expect(
      (
        await raw(office, "update_card", {
          card_id: card.id,
          risk_tags: invalid,
        })
      ).isError,
    ).toBe(true);
  expect(rows()).toEqual(before);
  expect(
    await ok<Card>(office, "update_card", { card_id: card.id, risk_tags: [] }),
  ).toMatchObject({ risk_tags: [] });
});

test("C-160 update_card.pre_merge_check: Ops adds pending, only Office passes", async () => {
  const [officeA, opsA] = store.uow.run((tx) =>
    (["office", "ops"] as const).map((standing_mode): Assignment => {
      const a: Assignment = {
        id: tx.ids.next(project, "assignment"),
        scope: "standing",
        standing_mode,
        role_id: "pm",
        role_version: 1,
        status: "active",
        runtime_state: "idle",
        runtime_ref: null,
        machine_id: "local",
        mcp_token_id: `fixture-${standing_mode}-160`,
        created_at: "2026-01-01T00:00:00Z",
      };
      tx.assignments.put(project, a);
      return a;
    }),
  );
  const officeClient = await connect(officeA as Assignment);
  const opsClient = await connect(opsA as Assignment, true);
  const added = await ok<Card>(opsClient, "update_card", {
    card_id: card.id,
    pre_merge_check: { label: "独立安全审核", status: "pending" },
  });
  expect(added.pre_merge_checks?.[0]?.status).toBe("pending");
  const before = rows();
  expect(
    (
      await raw(opsClient, "update_card", {
        card_id: card.id,
        pre_merge_check: { label: "独立安全审核", status: "passed" },
      })
    ).isError,
  ).toBe(true);
  expect(rows()).toEqual(before);
  // A conclusion binds to the current producing delivery, so one must exist.
  store.uow.run((tx) => {
    const item = tx.work_items
      .list(project)
      .find((w) => w.card_id === card.id && w.kind === "produce");
    if (!item) throw new Error("Missing producing work item");
    tx.deliveries.put(project, {
      id: "D-1",
      work_item_id: item.id,
      run_id: "R-1",
      kind: "code",
      summary: "Ready",
      subject: { kind: "git_head", value: "a".repeat(40) },
      status: "submitted",
      evidence: [],
      attachments: [],
      known_gaps: [],
      requested_verifiers: [],
    } as Delivery);
  });
  const passed = await ok<Card>(officeClient, "update_card", {
    card_id: card.id,
    pre_merge_check: { label: "独立安全审核", status: "passed", note: "通过" },
  });
  expect(passed.pre_merge_checks?.[0]).toMatchObject({
    status: "passed",
    note: "通过",
    updated_by: `assignment:${officeA?.id}`,
    checked_versions: [{ delivery_id: "D-1", subject: "a".repeat(40) }],
  });
  const reservedBefore = rows();
  for (const client of [officeClient, opsClient])
    for (const status of ["passed", "failed"])
      expect(
        (
          await raw(client, "update_card", {
            card_id: card.id,
            pre_merge_check: { label: " 独立复核 ", status },
          })
        ).isError,
      ).toBe(true);
  expect(rows()).toEqual(reservedBefore);
  const reserved = await ok<Card>(officeClient, "update_card", {
    card_id: card.id,
    pre_merge_check: { label: "独立复核", status: "pending" },
  });
  expect(reserved.pre_merge_checks).toContainEqual(
    expect.objectContaining({ label: "独立复核", status: "pending" }),
  );
});

/** Drive the fixture card to awaiting_merge through the real MCP tools. */
async function awaitingMerge(independent?: Client) {
  const producer = await coder();
  const reviewer = await assignee("reviewer");
  const pm = await assignee("pm");
  const subject = { kind: "git_head", value: "a".repeat(40) };
  const delivery = await ok<{ id: string }>(producer, "submit_delivery", {
    work_item_id: work("coder").id,
    kind: "code",
    summary: "Ready to merge",
    subject,
    requested_verifiers: [
      work("reviewer").id,
      ...(independent ? [work("independent_reviewer").id] : []),
    ],
  });
  await ok(reviewer, "submit_review", {
    delivery_id: delivery.id,
    target_sha: subject.value,
    kind: "code",
    issues: [],
  });
  if (independent)
    await ok(independent, "submit_review", {
      delivery_id: delivery.id,
      target_sha: subject.value,
      kind: "code",
      issues: [],
    });
  const completion = await ok<{ id: string }>(producer, "submit_delivery", {
    work_item_id: work("coder").id,
    kind: "card_completion",
    plain_summary: TEST_PLAIN_SUMMARY,
    summary: "Done",
    subject,
    requested_verifiers: [work("pm").id],
  });
  await ok(pm, "submit_review", {
    delivery_id: completion.id,
    target_sha: subject.value,
    kind: "product",
    issues: [],
  });
  expect(store.uow.read((tx) => tx.cards.get(project, card.id)?.status)).toBe(
    "awaiting_merge",
  );
  return producer;
}
const mergeCheck = () =>
  store.uow.read((tx) =>
    prepareMergePlan(loadCommandState(tx, project), card.id),
  );

test.each([true, undefined])(
  "C-162: request_human_action over MCP with blocks_merge=%s records the flag and holds the merge only when set",
  async (blocks_merge) => {
    const caller = await awaitingMerge();
    expect(mergeCheck().ok).toBe(true);
    const action = await ok<HumanAction>(caller, "request_human_action", {
      card_id: card.id,
      instructions: "Rotate the deploy credential",
      why_human: "Only a person holds the credential",
      expected_return: "Rotated",
      blocked_work_items: [],
      ...(blocks_merge === undefined
        ? {}
        : { blocks_merge, prerequisite: "credential" }),
    });
    const stored = store.uow.read((tx) =>
      tx.human_actions.get(project, action.id),
    );
    const requested = store.uow.read((tx) =>
      tx.events
        .listAfter(project, card.id, 0)
        .find((e) => e.type === "human_action_requested"),
    );
    if (blocks_merge) {
      expect(action.blocks_merge).toBe(true);
      expect(stored?.blocks_merge).toBe(true);
      expect(requested?.payload).toMatchObject({
        human_action_id: action.id,
        blocks_merge: true,
        prerequisite: "credential" as const,
      });
      expect(mergeCheck()).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining(action.id) },
      });
    } else {
      expect(action).not.toHaveProperty("blocks_merge");
      expect(stored).not.toHaveProperty("blocks_merge");
      expect(requested?.payload).not.toHaveProperty("blocks_merge");
      expect(mergeCheck().ok).toBe(true);
    }
  },
);

test("C-202: MCP leaves plain_summary checks to the domain, so a missing or non-text field gets the plain error", async () => {
  const request = (plain_summary: unknown) =>
    raw(office, "request_decision", {
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
      plain_summary,
    });
  const before = rows().events;
  const cases: [unknown, string][] = [
    [{ changed: "调整显示", impact: "更容易阅读" }, "缺少“风险”"],
    [{ changed: "调整显示", impact: 3, risk: "无" }, "缺少“对你的影响”"],
    [{ ...TEST_PLAIN_SUMMARY, extra: "多余" }, "不认识：extra"],
    [undefined, "缺少人话概述"],
    ["一句话", "要写成一个对象"],
  ];
  for (const [input, message] of cases) {
    const result = await request(input);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "validation_failed" },
    });
    expect(JSON.stringify(result.structuredContent)).toContain(message);
  }
  expect(rows().events).toBe(before);
});

/** C-202: bad plain_summary inputs and the plain words each must produce. */
const BAD_PLAIN_SUMMARIES: [unknown, string][] = [
  [{ changed: "调整显示", impact: "更容易阅读" }, "缺少“风险”"],
  [{ changed: "调整显示", impact: 3, risk: "无" }, "缺少“对你的影响”"],
  [{ impact: "更容易阅读", risk: "无" }, "缺少“改了什么”"],
  [{ ...TEST_PLAIN_SUMMARY, extra: "多余" }, "不认识：extra"],
  ["一句话", "要写成一个对象"],
];
async function expectPlainRejections(
  call: (plain_summary: unknown) => Promise<{
    isError?: unknown;
    structuredContent?: unknown;
  }>,
  writes: () => unknown,
) {
  const before = writes();
  for (const [input, message] of BAD_PLAIN_SUMMARIES) {
    const result = await call(input);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "validation_failed" },
    });
    expect(JSON.stringify(result.structuredContent)).toContain(message);
  }
  expect(writes()).toEqual(before);
}

test("C-202: resolve_delegated_decision escalate over MCP gives the plain error for a bad summary and writes nothing", async () => {
  const opsAssignment = store.uow.run((tx): Assignment => {
    const front = tx.assignments.list(project)[0];
    if (!front) throw new Error("Missing Office");
    const next: Assignment = {
      ...front,
      id: tx.ids.next(project, "assignment"),
      scope: "standing",
      standing_mode: "ops",
      mcp_token_id: "fixture-escalate-ops",
    };
    tx.assignments.put(project, next);
    return next;
  });
  const ops = await connect(opsAssignment, true);
  // For PM, with PM Ops active: no summary is needed when raising it.
  const q = await ok<Decision>(office, "request_decision", {
    card_id: card.id,
    kind: "choose",
    category: "feature_detail",
    question: "如何继续",
    context: "已确认可选方案",
    options: [{ key: "go", description: "继续", impact: "推进工作" }],
    recommended: "go",
    affected_cards: [card.id],
    affected_work_items: [],
    blocking: false,
    decider: "role:pm",
  });
  expect(q).toMatchObject({ decider: "role:pm" });
  expect(q).not.toHaveProperty("plain_summary");
  const escalate = (plain_summary: unknown) =>
    raw(ops, "resolve_delegated_decision", {
      decision_id: q.id,
      option: "go",
      rationale: "需要人来定",
      escalate: true,
      plain_summary,
    });
  const stored = () => store.uow.read((tx) => tx.decisions.get(project, q.id));
  await expectPlainRejections(escalate, () => ({
    rows: rows(),
    decision: stored(),
  }));
  expect(stored()).toMatchObject({ decider: "role:pm", status: "open" });
  // The same call with a proper summary goes through to the human.
  const handed = await ok<Decision>(ops, "resolve_delegated_decision", {
    decision_id: q.id,
    option: "go",
    rationale: "需要人来定",
    escalate: true,
    plain_summary: TEST_PLAIN_SUMMARY,
  });
  expect(stored()).toMatchObject({
    decider: "human",
    plain_summary: TEST_PLAIN_SUMMARY,
  });
  expect(handed).toBeDefined();
});

test("C-202: submit_delivery card_completion over MCP gives the plain error for a bad change note and writes nothing", async () => {
  const producer = await coder();
  const reviewer = await assignee("reviewer");
  const subject = { kind: "git_head", value: "b".repeat(40) };
  const delivery = await ok<{ id: string }>(producer, "submit_delivery", {
    work_item_id: work("coder").id,
    kind: "code",
    summary: "Ready",
    subject,
    requested_verifiers: [work("reviewer").id],
  });
  await ok(reviewer, "submit_review", {
    delivery_id: delivery.id,
    target_sha: subject.value,
    kind: "code",
    issues: [],
  });
  const complete = (plain_summary: unknown) =>
    raw(producer, "submit_delivery", {
      work_item_id: work("coder").id,
      kind: "card_completion",
      summary: "Done",
      subject,
      requested_verifiers: [work("pm").id],
      plain_summary,
    });
  const deliveries = () =>
    store.uow.read((tx) => tx.deliveries.list(project).map((x) => x.id));
  await expectPlainRejections(complete, () => ({
    rows: rows(),
    deliveries: deliveries(),
  }));
  // A completion without any change note gets the plain error too.
  const missing = await raw(producer, "submit_delivery", {
    work_item_id: work("coder").id,
    kind: "card_completion",
    summary: "Done",
    subject,
    requested_verifiers: [work("pm").id],
  });
  expect(missing.isError).toBe(true);
  expect(JSON.stringify(missing.structuredContent)).toContain("人话改动说明");
  await ok(producer, "submit_delivery", {
    work_item_id: work("coder").id,
    kind: "card_completion",
    summary: "Done",
    subject,
    requested_verifiers: [work("pm").id],
    plain_summary: TEST_PLAIN_SUMMARY,
  });
  expect(deliveries()).toHaveLength(2);
});

test("C-237 manual assignment flag uses existing PM tool authority", async () => {
  const added = await ok<WorkItem>(office, "create_work_item", {
    card_id: card.id,
    title: "Held verifier",
    kind: "verify",
    role_id: "reviewer",
    required: false,
    completion_criteria: ["Review"],
  });
  for (const manual_assign of [true, false])
    expect(
      await ok<WorkItem>(office, "update_work_item", {
        work_item_id: added.id,
        manual_assign,
      }),
    ).toMatchObject({ manual_assign });
  expect(managementTools).not.toHaveProperty("auto_assign_verifier");
  expect(managementTools).not.toHaveProperty("remind_system_waits");
});

test("role basis is exposed in MCP and rejected outside a current merge without changing the decision", async () => {
  const front = store.uow.read((tx) =>
    tx.assignments
      .list(project)
      .find((a) => a.scope === "standing" && a.standing_mode !== "ops"),
  )!;
  const opsAssignment = store.uow.run((tx) => {
    const ops: Assignment = {
      ...front,
      id: tx.ids.next(project, "assignment"),
      scope: "standing",
      standing_mode: "ops",
      mcp_token_id: "fixture-role-rule-ops",
    };
    tx.assignments.put(project, ops);
    return ops;
  });
  const ops = await connect(opsAssignment, true);
  const list = await ops.listTools();
  expect(
    list.tools.find((t) => t.name === "resolve_delegated_decision")?.inputSchema
      .properties,
  ).toHaveProperty("role_rule_basis");
  const q = await ok<Decision>(office, "request_decision", {
    card_id: card.id,
    kind: "choose",
    question: "如何继续",
    context: "普通功能细节",
    category: "feature_detail",
    options: [{ key: "go", description: "继续", impact: "推进" }],
    recommended: "go",
    affected_cards: [card.id],
    affected_work_items: [],
    blocking: false,
    decider: "human",
    plain_summary: TEST_PLAIN_SUMMARY,
  });
  const p = { decision_id: q.id, option: "go", rationale: "功能细节" };
  expect(
    (
      await raw(ops, "resolve_delegated_decision", {
        ...p,
        role_rule_basis: {
          completion_id: "D-1",
          inventories: [],
          mappings: [],
        },
      })
    ).isError,
  ).toBe(true);
  expect(store.uow.read((tx) => tx.decisions.get(project, q.id))?.status).toBe(
    "open",
  );
  expect(
    (await ok<Decision>(ops, "resolve_delegated_decision", p)).status,
  ).toBe("resolved");
});

test("PM reads all trusted inventories through get_card and confirms a mapped body implementation over MCP", async () => {
  const inventory: RoleRuleInventory = {
    version: 1,
    complete: true,
    base_sha: "b".repeat(40),
    sha: "a".repeat(40),
    tree_sha: "c".repeat(40),
    changes: [
      {
        id: "AGENTS.md",
        path: "AGENTS.md",
        status: "M",
        old_mode: "100644",
        new_mode: "100644",
        old_oid: "d".repeat(40),
        new_oid: "e".repeat(40),
        category: "body",
        edits: [
          {
            id: "AGENTS.md:@@ -1 +1 @@",
            before: "日志使用中文。\n",
            after: "日志和说明使用中文。\n",
          },
        ],
      },
    ],
  };
  // Trusted host verifier fixture; MCP submit_delivery has no evidence input.
  verifierFor = () => ({
    verify: async () => ({
      ok: true,
      value: [
        {
          kind: "diff",
          details: {
            role_rule_inventory: JSON.parse(JSON.stringify(inventory)),
          },
        },
        {
          kind: "git",
          details: { private_transport_detail: "must-not-be-projected" },
        },
      ],
    }),
  });
  store.uow.run((tx) => {
    tx.roles.put(project, {
      role_id: "independent_reviewer",
      role_version: 1,
      allowed_tools: toolNames,
      capabilities: [],
    });
  });
  await ok(office, "create_work_item", {
    card_id: card.id,
    title: "Independent",
    kind: "verify",
    role_id: "independent_reviewer",
    required: true,
    target_work_item_id: work("coder").id,
    completion_criteria: ["Safe"],
  });
  const independent = await assignee("independent_reviewer");
  const front = store.uow.read((tx) =>
    tx.assignments.list(project).find((a) => a.scope === "standing"),
  )!;
  const opsAssignment = store.uow.run((tx) => {
    const a: Assignment = {
      ...front,
      id: tx.ids.next(project, "assignment"),
      standing_mode: "ops",
      mcp_token_id: "mapped-body-ops",
    };
    tx.assignments.put(project, a);
    return a;
  });
  const ops = await connect(opsAssignment, true);
  await awaitingMerge(independent);
  store.uow.run((tx) =>
    tx.project_preferences?.put(project, {
      id: project,
      auto_merge_after_minutes: null,
      decision_delegation: { feature_detail: false },
    }),
  );
  const source = await ok<Decision>(office, "request_decision", {
    card_id: card.id,
    kind: "choose",
    question: "日志语言？",
    context: "落实语言指引",
    category: "feature_detail",
    options: [{ key: "chinese", description: "中文", impact: "日志中文" }],
    recommended: "chinese",
    affected_cards: [card.id],
    affected_work_items: [],
    blocking: false,
    decider: "human",
    plain_summary: TEST_PLAIN_SUMMARY,
  });
  // The person's direct control-plane answer and the host's merge check use
  // domain commands, preserving their real audit chain. No agent transcribes it.
  store.uow.run((tx) => {
    const io = {
      clock: { now: () => "2026-01-02T00:00:00.000Z" },
      ids: tx.ids,
    };
    const effect = unwrap(
      recordDecision(
        loadCommandState(tx, project),
        { kind: "human", project_id: project },
        {
          decision_id: source.id,
          option: "chinese",
          rationale: "日志和说明使用中文。",
          raw_quote: "日志和说明使用中文。",
        },
        io,
      ),
    );
    persistEffect(tx, project, effect);
    const completion = tx.deliveries
      .list(project)
      .find((v) => v.kind === "card_completion")!;
    for (const status of ["queued", "running", "passed"] as const) {
      const identity = {
        card_id: card.id,
        completion_id: completion.id,
        attempt_id: "mapped-body-check",
        candidate_sha: "f".repeat(40),
        tree_sha: "c".repeat(40),
      };
      persistEffect(
        tx,
        project,
        unwrap(
          recordMergeCheck(
            {
              ...loadCommandState(tx, project),
              project_settings: { merge_gate_enabled: true },
            },
            { kind: "system", project_id: project },
            status === "passed"
              ? {
                  ...identity,
                  status,
                  summary: "pass",
                  log_ref: "mapped-body-check.log",
                  checks: [
                    {
                      name: "test",
                      status: "passed",
                      exit_code: 0,
                      duration_ms: 1,
                    },
                  ],
                }
              : { ...identity, status },
            io,
          ),
        ),
      );
    }
  });
  type InventoryView = {
    deliveries: Delivery[];
    open_decisions: Decision[];
    role_rule_inventories: {
      delivery_id: Delivery["id"];
      role_rule_inventory: RoleRuleInventory;
    }[];
  };
  const view = await ok<InventoryView>(ops, "get_card", { card_id: card.id });
  expect(view.role_rule_inventories).toHaveLength(1);
  expect(view.role_rule_inventories[0]?.role_rule_inventory).toEqual(inventory);
  expect(JSON.stringify(view)).not.toContain("must-not-be-projected");
  const completion = view.deliveries.find((v) => v.kind === "card_completion")!;
  const q = view.open_decisions.find(
    (q) => q.trigger === "merge_confirmation",
  )!;
  expect(q.decider).toBe("role:pm"); // ordinary role changes use normal review gates
  const basis: RoleRuleBasis = {
    completion_id: completion.id,
    inventories: view.role_rule_inventories.map(
      ({ delivery_id, role_rule_inventory: i }) => ({
        delivery_id,
        base_sha: i.base_sha,
        sha: i.sha,
        tree_sha: i.tree_sha,
      }),
    ),
    mappings: view.role_rule_inventories.flatMap(
      ({ delivery_id, role_rule_inventory: i }) =>
        i.changes.flatMap((c) =>
          c.edits.map((e) => ({
            delivery_id,
            edit_id: e.id,
            category: "body" as const,
            decision_id: source.id,
            quote: "日志和说明使用中文。",
            explanation: "此处落实人指定的语言。",
          })),
        ),
    ),
  };
  const request = {
    decision_id: q.id,
    option: "merge",
    role_rule_basis: basis,
    rationale: "逐处落实日志语言决定",
    notice: "日志与说明使用中文",
  };
  const before = rows();
  expect(
    (
      await raw(ops, "resolve_delegated_decision", {
        ...request,
        role_rule_basis: { ...basis, mappings: [] },
      })
    ).isError,
  ).toBe(true);
  expect(rows()).toEqual(before);
  const answer = await ok<Decision>(ops, "resolve_delegated_decision", request);
  expect(answer.resolution?.via).toBe("delegated");
  expect(answer.role_rule_basis).toEqual(basis);
  expect(mergeCheck().ok).toBe(true);
});

test("get_card inventories cover every current Git product beyond the recent window and exclude superseded versions", async () => {
  await awaitingMerge();
  const currentIds = store.uow.run((tx) => {
    const product = tx.deliveries.list(project).find((v) => v.kind === "code")!;
    const ids: string[] = [product.id];
    for (let n = 0; n < 12; n++) {
      const item: WorkItem = {
        ...tx.work_items.get(project, product.work_item_id)!,
        id: tx.ids.next(project, "work_item"),
        title: `Extra ${n}`,
        required: false,
      };
      tx.work_items.put(project, item);
      const delivery: Delivery = {
        ...product,
        id: tx.ids.next(project, "delivery"),
        work_item_id: item.id,
      };
      tx.deliveries.put(project, delivery);
      ids.push(delivery.id);
      // A newer superseded version cannot hide the current product.
      tx.deliveries.put(project, {
        ...delivery,
        id: tx.ids.next(project, "delivery"),
        status: "superseded",
      });
    }
    return ids;
  });
  const view = await ok<{
    deliveries: Delivery[];
    role_rule_inventories: { delivery_id: string; role_rule_inventory: null }[];
  }>(office, "get_card", { card_id: card.id });
  expect(view.deliveries).toHaveLength(10);
  expect(view.role_rule_inventories.map((i) => i.delivery_id).sort()).toEqual(
    currentIds.sort(),
  );
  expect(
    view.role_rule_inventories.every((i) => i.role_rule_inventory === null),
  ).toBe(true);
});

test("C-238 existing update_card classifies versions, rejects spoofed audit fields, and get_card exposes staleness/comparisons", async () => {
  const item = store.uow.read((tx) =>
    tx.work_items
      .list(project)
      .find((w) => w.card_id === card.id && w.kind === "produce"),
  );
  if (!item) throw new Error("Missing fixture producer");
  store.uow.run((tx) =>
    tx.deliveries.put(project, {
      id: "D-900",
      work_item_id: item.id,
      run_id: "R-900",
      kind: "code",
      summary: "Synthetic",
      subject: { kind: "git_head", value: "a".repeat(40) },
      status: "submitted",
      evidence: [],
      attachments: [],
      known_gaps: [],
      requested_verifiers: [],
    } as Delivery),
  );
  const input = {
    checked_versions: [
      { work_item_id: item.id, delivery_id: "D-900", subject: "a".repeat(40) },
    ],
    read_through_seq: store.uow.read((tx) =>
      Math.max(...tx.events.listAfter(project, card.id, 0).map((e) => e.seq)),
    ),
    risk_tags: [],
    risk_reviewed: true,
    is_ui: false,
    numeric_rules_approved: true,
    numeric_decision_ids: [],
    not_external_release: true,
    no_role_changes: true,
    timeline_reviewed: true,
  };
  const before = rows();
  expect(
    (
      await raw(office, "update_card", {
        card_id: card.id,
        merge_classification: { ...input, confirmed_by: "human" },
      })
    ).isError,
  ).toBe(true);
  expect(rows()).toEqual(before);
  const saved = await ok<Card>(office, "update_card", {
    card_id: card.id,
    merge_classification: input,
  });
  expect(saved.merge_classification).toMatchObject({
    checked_versions: input.checked_versions,
    confirmed_by: expect.stringMatching(/^assignment:/),
  });
  const fresh = await ok<{
    card: { merge_classification: { stale: boolean } };
    merge_shadow: unknown[];
    role_rule_inventories: {
      delivery_id: string;
      role_rule_inventory: null;
    }[];
  }>(office, "get_card", { card_id: card.id });
  expect(fresh.card.merge_classification.stale).toBe(false);
  expect(fresh.merge_shadow).toEqual([]);
  expect(fresh.role_rule_inventories).toEqual([
    expect.objectContaining({
      delivery_id: "D-900",
      role_rule_inventory: null,
    }),
  ]);
  store.uow.run((tx) =>
    tx.deliveries.put(project, {
      ...tx.deliveries.get(project, "D-900"),
      id: "D-901",
    } as Delivery),
  );
  const stale = await ok<{
    card: { merge_classification: { stale: boolean } };
  }>(office, "get_card", { card_id: card.id });
  expect(stale.card.merge_classification.stale).toBe(true);
});

test("B8 legacy hold reclassification persists through PM MCP and replays without duplicate effects", async () => {
  const opsAssignment = store.uow.run((tx): Assignment => {
    const front = tx.assignments.list(project)[0];
    if (!front) throw new Error("Missing Office");
    const ops: Assignment = {
      ...front,
      id: tx.ids.next(project, "assignment"),
      standing_mode: "ops",
      mcp_token_id: "fixture-legacy-hold-ops",
    };
    tx.assignments.put(project, ops);
    return ops;
  });
  const ops = await connect(opsAssignment, true);
  const workItemId = work("coder").id;
  const action = store.uow.run((tx): HumanAction => {
    const id = tx.ids.next(project, "human_action");
    const action: HumanAction = {
      id,
      key: id,
      card_id: card.id,
      requested_by: "human",
      triage: "human",
      status: "open",
      blocks_merge: true,
      blocked_work_items: [workItemId],
      instructions: "Field evidence",
      why_human: "Physical access",
      expected_return: "Evidence",
    };
    tx.human_actions.put(project, action);
    return action;
  });
  const params = {
    human_action_id: action.id,
    disposition: "human",
    blocks_merge: false,
    rationale: "Verify after merge",
    title: "Collect field evidence after deployment",
    summary: "Field evidence",
    why_human: "Physical access",
    instructions: "Verify deployed code",
    expected_outcome: "Evidence recorded",
    expected_return: "Evidence",
  };
  expect((await raw(office, "triage_human_action", params)).isError).toBe(true);
  expect(
    store.uow.read((tx) => tx.human_actions.get(project, action.id)),
  ).toEqual(action);
  const result = await ok<HumanAction>(
    ops,
    "triage_human_action",
    params,
    "reclassify-legacy-hold",
  );
  expect(result).toMatchObject({
    id: action.id,
    status: "open",
    blocks_merge: false,
    blocked_work_items: [],
    follow_up_work_items: action.blocked_work_items,
    ready_when: { kind: "card_merged", card_id: card.id },
  });
  // Authentication updates activity even when the business command is replayed.
  const businessState = () =>
    store.uow.read((tx) => {
      const state = loadCommandState(tx, project);
      return {
        ...state,
        assignments: state.assignments.map(
          ({ last_mcp_activity_at: _activity, ...assignment }) => assignment,
        ),
      };
    });
  const state = businessState();
  expect(
    await ok<HumanAction>(
      ops,
      "triage_human_action",
      params,
      "reclassify-legacy-hold",
    ),
  ).toEqual(result);
  expect(businessState()).toEqual(state);
});

test("C-383 external Office completes only its bound host action through MCP and replays once", async () => {
  const external = store.uow.run((tx): Assignment => {
    const identity: Assignment = {
      id: tx.ids.next(project, "assignment"),
      scope: "standing",
      standing_mode: "office",
      external: true,
      role_id: "pm",
      role_version: 1,
      status: "active",
      runtime_state: "not_provisioned",
      runtime_ref: null,
      machine_id: "local",
      mcp_token_id: "external-fixture",
      created_at: "2026-01-01T00:00:00Z",
    };
    tx.assignments.put(project, identity);
    return identity;
  });
  const caller = await connect(external);
  const tools = (await caller.listTools()).tools.map((t) => t.name);
  expect(tools).toContain("complete_host_action");
  expect((await office.listTools()).tools.map((t) => t.name)).not.toContain(
    "complete_host_action",
  );
  const action = await ok<HumanAction>(caller, "request_human_action", {
    card_id: card.id,
    category: "general",
    instructions: "Read evidence",
    why_human: "Host access",
    expected_return: "Evidence",
    blocked_work_items: [],
  });
  const complete = {
    human_action_id: action.id,
    text: "Read-only evidence recorded",
  };
  expect((await raw(caller, "complete_host_action", complete)).isError).toBe(
    true,
  );
  store.uow.run((tx) =>
    tx.human_actions.put(project, {
      ...action,
      triage: "host",
      host_operator: "external",
      host_assignment_id: external.id,
    }),
  );
  expect(
    (await raw(caller, "complete_host_action", { ...complete, text: "   " }))
      .isError,
  ).toBe(true);
  const [one, replay] = await Promise.all([
    ok<HumanAction>(
      caller,
      "complete_host_action",
      complete,
      "host-complete-once",
    ),
    ok<HumanAction>(
      caller,
      "complete_host_action",
      complete,
      "host-complete-once",
    ),
  ]);
  expect(one).toEqual(replay);
  expect(one).toMatchObject({
    status: "done",
    result: { text: complete.text },
  });
  expect(
    store.uow.read((tx) =>
      tx.events
        .listAfter(project, card.id, 0)
        .filter((e) => e.type === "human_action_completed"),
    ),
  ).toHaveLength(1);
  expect((await raw(caller, "complete_host_action", complete)).isError).toBe(
    true,
  );
  store.uow.run((tx) =>
    tx.assignments.put(project, { ...external, status: "released" }),
  );
  await expect(caller.listTools()).rejects.toThrow();
});

test("C-370 MCP preserves explicit dependency fields and rejects cycles or unaudited early start", async () => {
  const next = (await ok(office, "create_card", {
    title: "Dependent",
    goal: "Wait",
    source: { kind: "quote", text: "Wait" },
    template: "general",
    depends_on_cards: [card.id],
    wait_for_dependencies: true,
  })) as Card;
  expect(next).toMatchObject({
    status: "backlog",
    depends_on_cards: [card.id],
    wait_for_dependencies: true,
  });
  expect(
    (
      await office.callTool({
        name: "update_card",
        arguments: {
          card_id: card.id,
          depends_on_cards: [next.id],
          idempotency_key: `dep-cycle-${++sequence}`,
        },
      })
    ).isError,
  ).toBe(true);
  expect(
    (
      await office.callTool({
        name: "update_card",
        arguments: {
          card_id: next.id,
          early_start: true,
          idempotency_key: `dep-reason-${++sequence}`,
        },
      })
    ).isError,
  ).toBe(true);
  expect(
    await ok(office, "update_card", {
      card_id: next.id,
      early_start: true,
      dependency_reason: "Parallel",
      status: "todo",
    }),
  ).toMatchObject({ early_start: { reason: "Parallel" } });
  expect(
    await ok(office, "update_card", {
      card_id: next.id,
      depends_on_cards: [],
      early_start: false,
      dependency_reason: "Wait cleared",
      wait_for_dependencies: false,
    }),
  ).toMatchObject({ depends_on_cards: [], wait_for_dependencies: false });
});

test("C-414 report_blocker persists optional machine-readable conditions through MCP", async () => {
  const caller = await coder();
  const item = work("coder");
  const resume_when = { kind: "deployment_ready", target_id: "a".repeat(40) };
  await ok(caller, "report_blocker", {
    work_item_id: item.id,
    reason: "Wait deployment",
    needs: "role",
    resume_when,
  });
  expect(
    store.uow.read((tx) => tx.work_items.get(project, item.id))
      ?.reported_blocker,
  ).toMatchObject({ resume_when });
});

test("report_blocker supports the registered baseline as a structured resume condition", async () => {
  const caller = await coder();
  const item = work("coder");
  const base = "b".repeat(40);
  store.uow.run((tx) => {
    const owner = tx.assignments.get(project, item.assignment_id!)!;
    tx.assignments.put(project, { ...owner, base_sha: base });
  });
  const resume_when = { kind: "baseline_updated", target_id: base };
  await ok(caller, "report_blocker", {
    work_item_id: item.id,
    reason: "Wait for baseline",
    needs: "role",
    resume_when,
  });
  expect(
    store.uow.read((tx) => tx.work_items.get(project, item.id))
      ?.reported_blocker,
  ).toMatchObject({ resume_when });
});

test("MCP recovery selection is validated and cannot become an ordinary assign when there is no confirmed loss", async () => {
  const params = {
    work_item_id: work("coder").id,
    role_id: "coder",
    machine_id: "local",
  };
  const before = rows();
  expect(
    (await raw(office, "assign", { ...params, recovery_source: "backup" }))
      .isError,
  ).toBe(true);
  expect(rows()).toEqual(before);
  await ok<AssignmentReply>(office, "assign", params);
  expect(
    (await raw(office, "assign", { ...params, recovery_source: "main" }))
      .isError,
  ).toBe(true);
});

test("MC-2 MCP persists template, card and item requirements and rejects invalid expressions", async () => {
  store.uow.run((tx) =>
    tx.card_templates.put(project, {
      ...productCardTemplate,
      id: "machine-work",
      builtin: false,
      work_items: productCardTemplate.work_items.map((w) => ({
        ...w,
        requirements: { capabilities: ["godot>=4.7"], tags: ["office"] },
      })),
    }),
  );
  const created = await ok<Card>(office, "create_card", {
    title: "Machine work",
    goal: "Build",
    template_id: "machine-work",
    acceptance_criteria: ["Pass"],
    source: { kind: "quote", text: "Build" },
    repo: "example/repo",
    base_branch: "main",
    work_item_requirements: { development: { capabilities: ["blender=4.2"] } },
  });
  const view = await ok<{ work_items: WorkItem[] }>(office, "get_card", {
    card_id: created.id,
  });
  const item = view.work_items.find((w) => w.kind === "produce");
  if (!item) throw new Error("Missing producer");
  expect(item.requirements).toEqual({
    capabilities: ["godot>=4.7", "blender=4.2"],
    tags: ["office"],
  });
  const updated = await ok<WorkItem>(office, "update_work_item", {
    work_item_id: item.id,
    requirements: {},
  });
  expect(updated.requirements).toEqual({
    capabilities: ["godot>=4.7"],
    tags: ["office"],
  });
  const extra = await ok<WorkItem>(office, "create_work_item", {
    card_id: created.id,
    title: "Extra",
    kind: "produce",
    role_id: "coder",
    required: false,
    completion_criteria: [],
    requirements: { arch: "arm64", capabilities: ["xcode"] },
  });
  expect(extra.requirements).toEqual({
    arch: "arm64",
    capabilities: ["xcode"],
  });
  for (const requirements of [
    { capabilities: ["godot~4"] },
    { os: "" },
    { command: "probe" },
    null,
  ]) {
    const before = rows();
    expect(
      (
        await raw(office, "update_work_item", {
          work_item_id: item.id,
          requirements,
        })
      ).isError,
    ).toBe(true);
    expect(rows()).toEqual(before);
  }
  expect(
    (
      await raw(office, "create_card", {
        title: "Typo",
        goal: "Build",
        acceptance_criteria: ["Pass"],
        source: { kind: "quote", text: "Build" },
        repo: "example/repo",
        base_branch: "main",
        work_item_requirements: { typo: {} },
      })
    ).isError,
  ).toBe(true);
  const templates = await ok<{
    templates: { id: string; work_items: { requirements?: unknown }[] }[];
  }>(office, "list_templates", {});
  expect(
    templates.templates.find((t) => t.id === "machine-work")?.work_items[0]
      ?.requirements,
  ).toEqual({ capabilities: ["godot>=4.7"], tags: ["office"] });
});

test("MC-2 an author with advertised management tools still cannot edit machine requirements", async () => {
  const assigned = await ok<AssignmentReply>(office, "assign", {
    work_item_id: work("coder").id,
    role_id: "coder",
  });
  const author = await connect(assigned);
  const before = rows();
  expect(
    (
      await raw(author, "update_work_item", {
        work_item_id: work("coder").id,
        requirements: { capabilities: ["godot"] },
      })
    ).isError,
  ).toBe(true);
  expect(
    (
      await raw(author, "create_work_item", {
        card_id: card.id,
        title: "Extra",
        kind: "produce",
        role_id: "coder",
        required: false,
        completion_criteria: [],
        requirements: {},
      })
    ).isError,
  ).toBe(true);
  expect(rows()).toEqual(before);
  expect(work("coder").requirements).toBeUndefined();
});

test("PM can create and clear the explicit UI framework marker through MCP", async () => {
  const framework = (await ok(office, "create_card", {
    title: "Layout",
    goal: "Layout",
    source: { kind: "quote", text: "Layout" },
    template: "general",
    is_ui_framework: true,
  })) as Card;
  expect(framework.is_ui_framework).toBe(true);
  expect(
    await ok(office, "update_card", {
      card_id: framework.id,
      is_ui_framework: false,
    }),
  ).toMatchObject({ is_ui_framework: false });
});

test("MCP creates a repo-free story and links a child without creating a dependency", async () => {
  const parent = await ok<Card>(office, "create_card", {
    title: "Need",
    goal: "Outcome",
    source: { kind: "quote", text: "Need" },
    template_id: "story",
  });
  expect(parent).toMatchObject({ template: "story", merge_policy: "none" });
  const child = await ok<Card>(office, "create_card", {
    title: "Part",
    goal: "Outcome",
    source: { kind: "quote", text: "Part" },
    template_id: "general",
    parent_card_id: parent.id,
  });
  expect(child.parent_card_id).toBe(parent.id);
  expect(child.depends_on_cards).toBeUndefined();
});

test("Office posts a checklist and proposal through MCP; reads show defaults, their source and zero rounds after silence", async () => {
  store.uow.run((tx) => {
    const owner = tx.assignments
      .list(project)
      .find((a) => a.scope === "standing");
    if (owner?.scope !== "standing") throw new Error("Missing Office");
    tx.assignments.put(project, { ...owner, standing_mode: "office" });
  });
  const { id: card_id } = await ok<Card>(office, "create_card", {
    title: "Need",
    goal: "Outcome",
    source: { kind: "quote", text: "Need" },
    template_id: "story",
  });
  const params = {
    card_id,
    body: "需要澄清",
    story_discussion: {
      action: "ask",
      questions: [
        { question: "布局？", recommended: "一栏", impact: "容易阅读" },
      ],
    },
  };
  const ask = await ok<TimelineEntry>(
    office,
    "post_comment",
    params,
    "ask-once",
  );
  expect(await ok(office, "post_comment", params, "ask-once")).toEqual(ask);
  const plan = await ok<TimelineEntry>(office, "post_comment", {
    card_id,
    body: "先调整布局",
    story_discussion: { action: "propose" },
  });
  expect(await ok(office, "get_card", { card_id })).toMatchObject({
    card: {
      story: {
        discussion_rounds: 0,
        question_groups: [
          {
            id: ask.id,
            questions: [
              {
                resolution: {
                  source: "proposal_default",
                  value: "一栏",
                  entry_id: plan.id,
                },
              },
            ],
          },
        ],
      },
    },
    decisions: [],
  });
  expect(
    await ok(office, "get_updates", { card_id, since_seq: ask.event_seq }),
  ).toMatchObject({ timeline: [{ body: expect.stringContaining("按默认") }] });
});
