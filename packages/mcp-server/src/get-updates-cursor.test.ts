/**
 * get_updates must continue from the caller's saved ACK cursor when no
 * `since_seq` is given (§6.1 step 4, §9.2). Uses the real server and the MCP
 * SDK client only.
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

const PROJECT = "p-cursor" as never;
const CARD = "C-1" as never;
const NOW = "2026-01-01T00:00:00.000Z";

let dataDir: string;
let store: Store;
let server: RunningServer;
let tokens: Record<"one" | "two", string>;

function payload(result: unknown): Record<string, unknown> {
  const structured = (result as { structuredContent?: unknown })
    .structuredContent;
  if (typeof structured === "object" && structured !== null) {
    return structured as Record<string, unknown>;
  }
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]
    ?.text;
  return text === undefined
    ? {}
    : (JSON.parse(text) as Record<string, unknown>);
}

async function call(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const client = new Client({ name: "fictional-cursor", version: "0.0.0" });
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

function seqsOf(response: Record<string, unknown>): number[] {
  return (response.events as Array<{ seq: number }>).map((event) => event.seq);
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-cursor-"));
  store = Store.open({ dataDir });

  store.createProject({ id: PROJECT });
  const issued = store.uow.run((tx) => {
    tx.cards.put(PROJECT, {
      id: CARD,
      project_id: PROJECT,
      title: "Fictional cursor card",
      goal: "Exercise get_updates",
      acceptance_criteria: ["cursors work"],
      source: { kind: "quote", text: "fictional" },
      out_of_scope: [],
      related_cards: [],
      repo: "example/repo",
      base_branch: "main",
      priority: 1,
      status: "todo",
      template: "dev",
      created_by: "human",
      created_at: NOW,
    });

    // Two work items on the same card, each with its own assignment, so the
    // cursor can be shown to belong to the assignment rather than the card.
    const tokens: Record<string, string> = {};
    for (const [index, name] of ["one", "two"].entries()) {
      const workItemId = `W-${index + 1}` as never;
      tx.work_items.put(PROJECT, {
        id: workItemId,
        card_id: CARD,
        title: `Fictional item ${name}`,
        kind: "produce",
        role_id: "coder",
        required: true,
        depends_on: [],
        completion_criteria: [],
        status: "todo",
      });
      const assignmentId = `A-${index + 1}` as never;
      tx.assignments.put(PROJECT, {
        id: assignmentId,
        scope: "work_item",
        work_item_id: workItemId,
        role_id: "coder",
        role_version: 1,
        status: "active",
        runtime_state: "not_provisioned",
        machine_id: "local",
        runtime_ref: null,
        mcp_token_id: `token-${name}`,
        created_at: NOW,
      });
      tx.roles.put(PROJECT, {
        role_id: "coder",
        role_version: 1,
        allowed_tools: ["get_updates", "ack_events", "whoami"],
        capabilities: [],
      });
      const token = tx.issueToken({
        project_id: PROJECT,
        assignment_id: assignmentId,
        role: {
          role_version: 1,
          allowed_tools: ["get_updates", "ack_events", "whoami"],
        },
        token: `fictional-${name}`,
      });
      tokens[name] = token.token;
    }

    for (let seq = 1; seq <= 3; seq += 1) {
      tx.events.append(PROJECT, {
        id: tx.ids.nextEventId(),
        card_id: CARD,
        seq,
        type: "comment_added",
        actor: { kind: "system", project_id: PROJECT },
        payload: { note: `fictional ${seq}` },
        created_at: NOW,
      });
      const entryId = tx.ids.nextTimelineEntryId(PROJECT, CARD);
      tx.timeline.put(PROJECT, {
        id: entryId,
        short_id: entryId,
        card_id: CARD,
        event_seq: seq,
        type: "comment",
        author: "human",
        refs: [],
        retracted: false,
        body: `fictional comment ${seq}`,
        mentions: [],
        created_at: NOW,
      });
    }
    // Project-level events have their own stream (and seqs), so the two
    // cursors can be shown to be independent (S5).
    for (let seq = 1; seq <= 2; seq += 1) {
      tx.events.append(PROJECT, {
        id: tx.ids.nextEventId(),
        seq,
        type: "run_queued",
        actor: { kind: "system", project_id: PROJECT },
        payload: { note: `project ${seq}` },
        created_at: NOW,
      });
    }
    return tokens;
  });
  tokens = issued as Record<"one" | "two", string>;

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

test("without a cursor it reads from the start", async () => {
  const updates = await call(tokens.one, "get_updates", { card_id: CARD });
  expect(updates.since_seq).toBe(0);
  expect(seqsOf(updates)).toEqual([1, 2, 3]);
});

test("without since_seq it continues after the saved ACK", async () => {
  await call(tokens.one, "ack_events", { card_id: CARD, up_to_seq: 2 });

  const updates = await call(tokens.one, "get_updates", { card_id: CARD });
  expect(updates.since_seq).toBe(2);
  expect(seqsOf(updates)).toEqual([3]);
  expect(
    (updates.timeline as Array<{ event_seq: number }>).map((e) => e.event_seq),
  ).toEqual([3]);
});

test("an explicit since_seq still wins, even below the cursor", async () => {
  await call(tokens.one, "ack_events", { card_id: CARD, up_to_seq: 2 });

  const fromStart = await call(tokens.one, "get_updates", {
    card_id: CARD,
    since_seq: 0,
  });
  expect(fromStart.since_seq).toBe(0);
  expect(seqsOf(fromStart)).toEqual([1, 2, 3]);

  const fromOne = await call(tokens.one, "get_updates", {
    card_id: CARD,
    since_seq: 1,
  });
  expect(fromOne.since_seq).toBe(1);
  expect(seqsOf(fromOne)).toEqual([2, 3]);
});

test("the cursor belongs to the assignment, not the card", async () => {
  await call(tokens.one, "ack_events", { card_id: CARD, up_to_seq: 3 });

  // The second assignment of the same card never acknowledged anything.
  const other = await call(tokens.two, "get_updates", { card_id: CARD });
  expect(other.since_seq).toBe(0);
  expect(seqsOf(other)).toEqual([1, 2, 3]);
});

test("the project-level stream keeps starting at 0 (cursors are per card)", async () => {
  await call(tokens.one, "ack_events", { card_id: CARD, up_to_seq: 3 });

  const projectLevel = await call(tokens.one, "get_updates");
  expect(projectLevel.card_id).toBeNull();
  expect(projectLevel.since_seq).toBe(0);
  expect(projectLevel.events).toHaveLength(2);
});

test("S5 ack_events without card_id acknowledges the project-level stream", async () => {
  const acked = await call(tokens.one, "ack_events", { up_to_seq: 1 });
  expect(acked.changed).toBe(true);
  expect(acked.card_id).toBeNull();

  const projectLevel = await call(tokens.one, "get_updates");
  expect(projectLevel.since_seq).toBe(1);
  expect(seqsOf(projectLevel)).toEqual([2]);
});

test("S5 the two streams keep separate cursors", async () => {
  await call(tokens.one, "ack_events", { up_to_seq: 2 });

  // The card stream is untouched by the project acknowledgement ...
  const card = await call(tokens.one, "get_updates", { card_id: CARD });
  expect(card.since_seq).toBe(0);
  expect(seqsOf(card)).toEqual([1, 2, 3]);

  // ... and acknowledging it does not move the project cursor back.
  await call(tokens.one, "ack_events", { card_id: CARD, up_to_seq: 3 });
  const projectLevel = await call(tokens.one, "get_updates");
  expect(projectLevel.since_seq).toBe(2);
  expect(projectLevel.events).toEqual([]);
});

test("S5 a project acknowledgement cannot pass the newest project seq", async () => {
  const rejected = await call(tokens.one, "ack_events", { up_to_seq: 3 });
  const error = rejected.error as { message?: string } | undefined;
  expect(error?.message).toContain("newest seq is 2");
});

test("acknowledging everything leaves an empty read", async () => {
  await call(tokens.one, "ack_events", { card_id: CARD, up_to_seq: 3 });

  const updates = await call(tokens.one, "get_updates", { card_id: CARD });
  expect(updates.since_seq).toBe(3);
  expect(updates.events).toEqual([]);
  expect(updates.timeline).toEqual([]);
  expect(updates.latest_seq).toBe(3);
});

test("human authors in historical updates resolve the global owner's latest name and avatar", async () => {
  const before = await call(tokens.one, "get_updates", { card_id: CARD });
  expect((before.timeline as unknown[])[0]).toMatchObject({
    author: "human",
    author_display: "所有者",
    member: { id: "M-1" },
  });
  store.uow.run((tx) => {
    const owner = tx.members.list()[0];
    if (!owner) throw new Error("Missing owner");
    tx.members.put({ ...owner, name: "邵杰", avatar: "library:liu-bei" });
  });
  const after = await call(tokens.one, "get_updates", { card_id: CARD });
  expect((after.timeline as unknown[])[0]).toMatchObject({
    author: "human",
    author_display: "邵杰",
    member: {
      id: "M-1",
      name: "邵杰",
      title: "所有者",
      avatar: "library:liu-bei",
    },
  });
  expect(store.uow.read((tx) => tx.timeline.list(PROJECT))[0]?.author).toBe(
    "human",
  );
});
