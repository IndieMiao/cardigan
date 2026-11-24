/**
 * C-722: the PM Office reads routine progress (that never rings it) from its
 * project-stream `get_updates`. Real store, real server, MCP SDK client.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type RunningServer, startMcpServer } from "./server.js";
import { acceptingVerifierFor } from "./test-support.js";

const HOME = "p-home" as never;
const AWAY = "p-away" as never;
const CREATED = "2026-11-20T00:00:00.000Z";
const at = (hour: number) =>
  new Date(
    Date.parse("2026-11-21T00:00:00.000Z") + hour * 3_600_000,
  ).toISOString();
const TOOLS = ["get_updates", "ack_events", "whoami"] as never;

let dataDir: string;
let store: Store;
let server: RunningServer;
let tokens: Record<string, string>;

function payload(result: unknown): Record<string, unknown> {
  const structured = (result as { structuredContent?: unknown })
    .structuredContent;
  if (typeof structured === "object" && structured !== null)
    return structured as Record<string, unknown>;
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]
    ?.text;
  return text === undefined ? {} : JSON.parse(text);
}

async function call(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const client = new Client({ name: "fictional-office", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  try {
    return payload(await client.callTool({ name, arguments: args }));
  } finally {
    await client.close();
  }
}

type Digest = {
  since: string;
  omitted: number;
  entries: { card_id: string; seq: number; type: string }[];
};
const digestOf = (r: Record<string, unknown>) =>
  r.office_digest as Digest | undefined;
const entries = (r: Record<string, unknown>) =>
  digestOf(r)?.entries.map((e) => `${e.card_id}#${e.seq}:${e.type}`);

function seed(project: never, title: string) {
  return store.uow.run((tx) => {
    const issued: Record<string, string> = {};
    for (const card of ["C-1", "C-2"])
      tx.cards.put(project, {
        id: card as never,
        project_id: project,
        title: `${title} ${card}`,
        goal: "fictional",
        acceptance_criteria: [],
        source: { kind: "quote", text: "fictional" },
        out_of_scope: [],
        related_cards: [],
        repo: "example/repo",
        base_branch: "main",
        priority: 1,
        status: "todo",
        template: "dev",
        created_by: "human",
        created_at: CREATED,
      });
    tx.work_items.put(project, {
      id: "W-1" as never,
      card_id: "C-1" as never,
      title: "item",
      kind: "produce",
      role_id: "coder",
      required: true,
      depends_on: [],
      completion_criteria: [],
      status: "todo",
    });
    const people = [
      [
        "office",
        "A-10",
        { scope: "standing", role_id: "pm", standing_mode: "office" },
      ],
      [
        "ops",
        "A-11",
        { scope: "standing", role_id: "pm", standing_mode: "ops" },
      ],
      [
        "coder",
        "A-1",
        { scope: "work_item", role_id: "coder", work_item_id: "W-1" },
      ],
    ] as const;
    for (const [name, id, fields] of people) {
      tx.roles.put(project, {
        role_id: fields.role_id,
        role_version: 1,
        allowed_tools: TOOLS,
        capabilities: [],
      });
      tx.assignments.put(project, {
        id: id as never,
        ...(fields as never),
        role_version: 1,
        status: "active",
        runtime_state: "not_provisioned",
        machine_id: "local",
        runtime_ref: null,
        mcp_token_id: `token-${project}-${name}`,
        created_at: CREATED,
      });
      issued[name] = tx.issueToken({
        project_id: project,
        assignment_id: id as never,
        role: { role_version: 1, allowed_tools: TOOLS },
        token: `fictional-${project}-${name}`,
      }).token;
    }
    const append = (
      card: string | undefined,
      seq: number,
      type: string,
      hour: number,
      extra: Record<string, unknown> = {},
    ) =>
      tx.events.append(project, {
        id: tx.ids.nextEventId(),
        ...(card ? { card_id: card as never } : {}),
        seq,
        type,
        actor: { kind: "system", project_id: project },
        payload: extra,
        created_at: at(hour),
      });
    append("C-1", 1, "card_created", 1);
    append("C-1", 2, "delivery_submitted", 2, { delivery_id: "D-1" });
    append("C-1", 3, "comment_posted", 3);
    append("C-2", 1, "card_created", 4);
    append(undefined, 1, "host_deployment_recorded", 5);
    append("C-2", 2, "review_submitted", 6, { verdict: "pass" });
    append("C-2", 3, "card_merged", 7);
    return issued;
  });
}

function append(
  project: never,
  card: string,
  seq: number,
  type: string,
  created_at: string,
) {
  store.uow.run((tx) =>
    tx.events.append(project, {
      id: tx.ids.nextEventId(),
      card_id: card as never,
      seq,
      type,
      actor: { kind: "system", project_id: project },
      payload: {},
      created_at,
    }),
  );
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-office-digest-"));
  store = Store.open({ dataDir });
  store.createProject({ id: HOME });
  store.createProject({ id: AWAY });
  const home = seed(HOME, "Home");
  const away = seed(AWAY, "Away");
  tokens = {
    office: home.office as string,
    ops: home.ops as string,
    coder: home.coder as string,
    awayOffice: away.office as string,
  };
  server = await startMcpServer({
    store,
    deliveryVerifier: acceptingVerifierFor,
  });
});

afterEach(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("the Office reads routine card progress, oldest first, from the project stream", async () => {
  const read = await call(tokens.office as string, "get_updates");
  expect(digestOf(read)?.since).toBe(CREATED);
  expect(entries(read)).toEqual([
    "C-1#1:card_created",
    "C-1#2:delivery_submitted",
    "C-2#1:card_created",
    "C-2#2:review_submitted",
    "C-2#3:card_merged",
  ]);
  // The project-level routine event is in the same read's own events.
  expect((read.events as { type: string }[]).map((e) => e.type)).toEqual([
    "host_deployment_recorded",
  ]);
  // A card read carries no digest.
  expect(
    digestOf(
      await call(tokens.office as string, "get_updates", { card_id: "C-1" }),
    ),
  ).toBeUndefined();
});

test("reading alone moves nothing; the project ACK moves the window only to what was shown", async () => {
  const office = tokens.office as string;
  await call(office, "get_updates");
  // Nothing was acknowledged: the next session reads the same digest.
  expect(entries(await call(office, "get_updates"))).toHaveLength(5);
  // Acknowledging one card stream hides what the Office read there.
  await call(office, "ack_events", { card_id: "C-1", up_to_seq: 3 });
  expect(entries(await call(office, "get_updates"))).toEqual([
    "C-2#1:card_created",
    "C-2#2:review_submitted",
    "C-2#3:card_merged",
  ]);
  // The project ACK moves the window past what the last read showed.
  await call(office, "ack_events", { up_to_seq: 1 });
  const after = await call(office, "get_updates");
  expect(entries(after)).toEqual([]);
  // Later progress still arrives, even with no new project-stream event.
  append(HOME, "C-2", 4, "card_updated", new Date().toISOString());
  expect(entries(await call(office, "get_updates"))).toEqual([
    "C-2#4:card_updated",
  ]);
});

test("beyond one page, a project ACK never skips entries the Office was not shown", async () => {
  const office = tokens.office as string;
  // 60 more merges after the 5 seeded changes: 65 in all, one page is 50.
  for (let i = 0; i < 60; i++)
    append(
      HOME,
      "C-2",
      4 + i,
      "card_merged",
      new Date(Date.parse(at(10)) + i * 1000).toISOString(),
    );
  const first = await call(office, "get_updates");
  expect(entries(first)).toHaveLength(50);
  expect(digestOf(first)?.omitted).toBe(15);
  const shown = new Set(entries(first));
  // ACK the project stream twice without reading again: still no skip.
  await call(office, "ack_events", { up_to_seq: 1 });
  await call(office, "ack_events", { up_to_seq: 1 });
  const second = await call(office, "get_updates");
  expect(digestOf(second)?.omitted).toBe(0);
  const rest = entries(second) ?? [];
  expect(rest).toHaveLength(15);
  expect(rest.filter((e) => shown.has(e))).toEqual([]);
  expect(rest.at(-1)).toBe("C-2#63:card_merged");
});

test("only this project's Office on duty gets a digest, never another project's events", async () => {
  for (const token of [tokens.ops, tokens.coder])
    expect(
      digestOf(await call(token as string, "get_updates")),
    ).toBeUndefined();
  // The other project's Office sees only its own project's cards.
  const away = await call(tokens.awayOffice as string, "get_updates");
  expect(entries(away)).toHaveLength(5);
  store.uow.run((tx) =>
    tx.events.append(HOME, {
      id: tx.ids.nextEventId(),
      card_id: "C-1" as never,
      seq: 4,
      type: "card_merged",
      actor: { kind: "system", project_id: HOME },
      payload: {},
      created_at: at(9),
    }),
  );
  expect(
    entries(await call(tokens.awayOffice as string, "get_updates")),
  ).toEqual(entries(away));
  expect(
    entries(await call(tokens.office as string, "get_updates"))?.at(-1),
  ).toBe("C-1#4:card_merged");
});

test("a legacy PM row without standing_mode=office gets no digest and no error", async () => {
  // A suspended or released Office cannot authenticate at all; the domain
  // contract covers those states. Here the row is active but not explicit.
  store.uow.run((tx) => {
    const office = tx.assignments.get(HOME, "A-10" as never);
    if (office?.scope === "standing") {
      const { standing_mode: _mode, ...legacy } = office;
      tx.assignments.put(HOME, legacy);
    }
  });
  const read = await call(tokens.office as string, "get_updates");
  expect(read.events).toBeDefined();
  expect(digestOf(read)).toBeUndefined();
});
