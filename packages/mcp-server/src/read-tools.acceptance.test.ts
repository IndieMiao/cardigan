import { request as httpRequest } from "node:http";
import type {
  Assignment,
  Card,
  CardId,
  Event,
  TimelineEntry,
  ToolName,
} from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { memoryLogger, type RunningServer, startMcpServer } from "./index.js";

// Independent fixtures from M1.5 / development plan §4, §6, §9, §14, §16.
// Only public package APIs are used; no implementation helpers or SQL queries.
const tools = ["whoami", "get_card", "get_updates", "ack_events"] as const;
const now = "2026-01-01T00:00:00.000Z";
const own = "C-1" as CardId;
let store: Store,
  server: RunningServer,
  caller: Client,
  foreign: Client,
  limited: Client;
let clients: Client[], token: string, tokenId: string;
let log: ReturnType<typeof memoryLogger>;
const forged = {
  project_id: "beta",
  assignment_id: "A-2",
  role_id: "pm",
  role_version: 99,
  allowed_tools: tools,
  author: "human",
};

function seed(
  project: string,
  number: number,
  allowed: readonly ToolName[] = tools,
) {
  return store.uow.run((tx) => {
    const card_id = `C-${number}` as CardId;
    const work_item_id = `W-${number}` as never;
    const card: Card = {
      id: card_id,
      project_id: project,
      title: `${project}/${card_id}`,
      goal: `Private ${project}/${card_id}`,
      acceptance_criteria: ["Read safely"],
      source: { kind: "quote", text: "Fixture" },
      out_of_scope: [],
      related_cards: [],
      repo: "example/repo",
      base_branch: "main",
      priority: 1,
      status: "todo",
      template: "development",
      created_by: "human",
      created_at: now,
    };
    tx.cards.put(project, card);
    const role_id = allowed.length === 1 ? "observer" : "coder";
    const assignment: Assignment = {
      id: `A-${number}` as never,
      scope: "work_item",
      work_item_id,
      role_id,
      role_version: 1,
      status: "active",
      runtime_state: "idle",
      machine_id: "local",
      runtime_ref: null,
      mcp_token_id: `${project}:A-${number}`,
      created_at: now,
      worktree_path: `/fixture/${project}/${number}`,
      branch: `agent/${card_id}/${work_item_id}`,
    };
    tx.work_items.put(project, {
      id: work_item_id,
      card_id,
      title: "Implement",
      kind: "produce",
      role_id,
      required: true,
      depends_on: [],
      completion_criteria: ["Pass"],
      assignment_id: assignment.id,
      status: "todo",
    });
    tx.assignments.put(project, assignment);
    tx.roles.put(project, {
      role_id,
      role_version: 1,
      allowed_tools: allowed,
      capabilities: [],
    });
    for (let i = 1; i <= 3; i++) {
      const seq = tx.ids.nextEventSequence(project, card_id);
      tx.events.append(project, {
        id: tx.ids.nextEventId(),
        card_id,
        seq,
        type: "comment_added",
        actor: { kind: "human", project_id: project },
        payload: { marker: `${project}/${card_id}/${i}` },
        created_at: now,
      });
      const id = tx.ids.nextTimelineEntryId(project, card_id);
      tx.timeline.put(project, {
        id,
        short_id: id,
        card_id,
        event_seq: seq,
        type: "comment",
        author: "human",
        refs: [],
        retracted: false,
        body: `${project}/${card_id}/${i}`,
        mentions: [],
        created_at: now,
      });
    }
    return { project_id: project, assignment, allowed };
  });
}
async function connect(fixture: ReturnType<typeof seed>) {
  const issued = store.issueToken({
    project_id: fixture.project_id,
    assignment_id: fixture.assignment.id,
    id: fixture.assignment.mcp_token_id,
    role: { role_version: 1, allowed_tools: fixture.allowed },
  });
  const client = new Client({ name: "read-acceptance", version: "1" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${issued.token}` } },
    }),
  );
  return { client, ...issued };
}
const call = (
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) => client.callTool({ name, arguments: args });
async function ok<T>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await call(client, name, args);
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(
    true,
  );
  return result.structuredContent as T;
}
const cursors = () =>
  ["alpha", "beta"].map((project) =>
    store.uow.read((tx) => tx.cursors.list(project)),
  );
const request = (bearer?: string, headers: Record<string, string> = {}) =>
  fetch(server.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "whoami", arguments: forged },
    }),
  });
beforeEach(async () => {
  store = Store.open({ dbPath: ":memory:" });
  clients = [];
  log = memoryLogger();
  const alpha = seed("alpha", 1);
  seed("alpha", 2);
  const observer = seed("alpha", 4, ["whoami"]);
  seed("beta", 1); // Colliding card, work item and Assignment IDs are intentional.
  const beta = seed("beta", 9);
  server = await startMcpServer({ store, log: log.log });
  const connected = await connect(alpha);
  caller = connected.client;
  token = connected.token;
  tokenId = connected.record.id;
  foreign = (await connect(beta)).client;
  limited = (await connect(observer)).client;
});
afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await server.close();
  store.close();
});

test.each(["missing", "wrong", "revoked"])(
  "R01-%s: untrusted credentials return HTTP 401 even with forged identity",
  async (kind) => {
    // The revoked token has already completed an SDK connection successfully.
    if (kind === "revoked") expect(store.revokeToken(tokenId)).toBe(true);
    const bearer =
      kind === "missing"
        ? undefined
        : kind === "wrong"
          ? `${token}invalid`
          : token;
    const response = await request(bearer);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "unauthorized" },
    });
  },
);

test("R02: whoami ignores forged identity and returns the Token's complete context", async () => {
  const identity = await ok(caller, "whoami", {
    ...forged,
    actor: forged,
    identity: forged,
  });
  expect(identity).toMatchObject({
    project_id: "alpha",
    assignment_id: "A-1",
    role_id: "coder",
    role_version: 1,
    card_id: own,
    work_item_id: "W-1",
    machine_id: "local",
    worktree_path: "/fixture/alpha/1",
    branch: "agent/C-1/W-1",
  });
  expect(JSON.stringify(identity)).not.toContain(token);
});

test.each(["get_card", "get_updates", "ack_events"])(
  "R03-%s: forbidden tools are hidden and cannot be called by forging a role",
  async (name) => {
    expect((await limited.listTools()).tools.map((t) => t.name)).toEqual([
      "whoami",
    ]);
    const result = await call(limited, name, {
      ...forged,
      card_id: "C-4",
      up_to_seq: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "forbidden_tool" },
    });
  },
);

test("R04: get_card returns the owning card and derives its status from work items", async () => {
  store.uow.run((tx) => {
    const item = tx.work_items.get("alpha", "W-1" as never);
    if (item?.kind !== "produce") throw new Error("Missing fixture");
    tx.work_items.put("alpha", { ...item, status: "in_progress" });
  });
  const result = await ok<{ card: Card; work_items: { id: string }[] }>(
    caller,
    "get_card",
    { card_id: own },
  );
  expect(result.card).toMatchObject({
    id: own,
    title: "alpha/C-1",
    status: "in_progress",
  });
  expect(result.work_items.map((w) => w.id)).toEqual(["W-1"]);
  expect(result).toHaveProperty("waiting_on");
  expect(result).toHaveProperty("next_owners");
  expect(result).toHaveProperty("why");
});

const targets = [
  { scope: "card", card_id: "C-2" },
  { scope: "project", card_id: "C-9" },
];
for (const name of ["get_card", "get_updates", "ack_events"]) {
  test.each(targets)(
    `R05-${name}-$scope: an out-of-scope target is refused without changing cursors`,
    async ({ card_id, scope }) => {
      if (scope === "project") await ok(foreign, "get_card", { card_id });
      const before = cursors();
      const result = await call(caller, name, {
        ...forged,
        card_id,
        since_seq: 0,
        up_to_seq: 2,
        actor: forged,
      });
      expect(result.isError).toBe(true);
      // Both denial and non-disclosing not_found satisfy the scope contract.
      expect(["unauthorized", "not_found"]).toContain(
        (result.structuredContent as { error: { code: string } }).error.code,
      );
      expect(cursors()).toEqual(before);
      expect(JSON.stringify(result)).not.toContain(
        `Private ${scope === "card" ? "alpha/C-2" : "beta/C-9"}`,
      );
    },
  );
}

test.each(["get_card", "get_updates", "ack_events"])(
  "R06-%s: colliding IDs cannot switch the Token's project via request parameters",
  async (name) => {
    const result = await ok(caller, name, {
      ...forged,
      card_id: own,
      since_seq: 0,
      up_to_seq: 2,
    });
    if (name === "get_card")
      expect(result).toMatchObject({ card: { title: "alpha/C-1" } });
    if (name === "get_updates")
      expect(result).toMatchObject({
        events: [
          { payload: { marker: "alpha/C-1/1" } },
          { payload: { marker: "alpha/C-1/2" } },
          { payload: { marker: "alpha/C-1/3" } },
        ],
      });
    if (name === "ack_events")
      expect(cursors()).toEqual([
        [{ assignment_id: "A-1", card_id: own, acked_seq: 2 }],
        [],
      ]);
    expect(JSON.stringify(result)).not.toContain("beta/");
  },
);

test("R07: get_updates returns ordered events and timeline for its own card after since_seq", async () => {
  type Updates = { events: Event[]; timeline: TimelineEntry[] };
  const all = await ok<Updates>(caller, "get_updates", { card_id: own });
  expect(all.events.map((e) => [e.card_id, e.seq])).toEqual([
    [own, 1],
    [own, 2],
    [own, 3],
  ]);
  const later = await ok<Updates>(caller, "get_updates", {
    card_id: own,
    since_seq: 1,
  });
  expect(later.events.map((e) => e.seq)).toEqual([2, 3]);
  expect(later.timeline.map((e) => [e.event_seq, e.body])).toEqual([
    [2, "alpha/C-1/2"],
    [3, "alpha/C-1/3"],
  ]);
});

test("R08: ack_events advances only its own cursor and never moves it backwards", async () => {
  expect(
    await ok(caller, "ack_events", { card_id: own, up_to_seq: 2 }),
  ).toMatchObject({ acked_seq: 2 });
  expect(
    await ok(caller, "ack_events", { ...forged, card_id: own, up_to_seq: 1 }),
  ).toMatchObject({ acked_seq: 2 });
  expect(cursors()).toEqual([
    [{ assignment_id: "A-1", card_id: own, acked_seq: 2 }],
    [],
  ]);
});

test("R09: request bodies and Token plaintext never enter MCP logs", async () => {
  await ok(caller, "whoami", { body: "private-acceptance-probe" });
  const output = JSON.stringify(log.entries);
  expect(output).not.toContain(token);
  expect(output).not.toContain("private-acceptance-probe");
  expect(log.entries).toContainEqual(
    expect.objectContaining({
      tool: "whoami",
      assignment_id: "A-1",
      code: "ok",
    }),
  );
});

test("R10: the default server binds loopback and refuses a foreign Host header", async () => {
  expect(server.host).toBe("127.0.0.1");
  // Node fetch rewrites Host; use node:http so the adversarial header reaches the server.
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(
      server.url,
      {
        method: "POST",
        headers: {
          Host: "attacker.invalid",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  });
  expect(status).toBe(403);
});

// §9.2 promises updates after the cursor. With card_id present but since_seq omitted,
// the current server returns seq 1..3 even after ACK 2. Keep this as a regression.
test.fails("R11: get_updates without since_seq starts after the caller's saved ACK", async () => {
  await ok(caller, "ack_events", { card_id: own, up_to_seq: 2 });
  const updates = await ok<{ events: Event[]; timeline: TimelineEntry[] }>(
    caller,
    "get_updates",
    { card_id: own },
  );
  expect(updates.events.map((e) => e.seq)).toEqual([3]);
  expect(updates.timeline.map((e) => e.event_seq)).toEqual([3]);
});
