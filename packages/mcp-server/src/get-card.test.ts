import type {
  Card,
  Decision,
  Delivery,
  Review,
  WorkItem,
} from "@cardigan/domain";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { memoryLogger } from "./log.js";
import { type RunningServer, startMcpServer } from "./server.js";
import {
  card_id,
  type Fixture,
  project_id,
  seedFixture,
  serverCard,
} from "./test-support.js";

const allowed = ["whoami", "get_card", "get_updates", "ack_events"] as const;

let fixture: Fixture;
let server: RunningServer;

function connect(token: string): Promise<Client> {
  const client = new Client({ name: "fictional-client", version: "0.0.0" });
  return client
    .connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    )
    .then(() => client);
}

function textOf(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  const text = content?.[0]?.text;
  return text === undefined
    ? {}
    : (JSON.parse(text) as Record<string, unknown>);
}

/** Add a second card with a verify work item, a delivery, a review and a decision. */
function seedCardRelations(): void {
  const secondCard: Card = {
    ...serverCard,
    id: "C-2" as never,
    title: "Other card",
  };
  const produce: WorkItem = {
    id: "W-2" as never,
    card_id,
    title: "Verify the work",
    kind: "verify",
    role_id: "reviewer",
    required: true,
    depends_on: [],
    completion_criteria: [],
    status: "todo",
    target_work_item_id: "W-1" as never,
    max_review_rounds: 2,
  };
  const otherSide: WorkItem = {
    ...produce,
    id: "W-3" as never,
    card_id: "C-2" as never,
    kind: "produce",
    role_id: "coder",
    status: "todo",
  };
  const delivery: Delivery = {
    id: "D-1" as never,
    work_item_id: "W-1" as never,
    run_id: "R-1" as never,
    kind: "code",
    summary: "fictional delivery",
    subject: { kind: "git_head", value: "sha-abc" },
    evidence: [],
    attachments: [],
    known_gaps: [],
    requested_verifiers: [],
    status: "submitted",
  };
  const review: Review = {
    id: "V-1" as never,
    delivery_id: delivery.id,
    target_sha: "sha-abc",
    work_item_id: produce.id,
    run_id: "R-1" as never,
    kind: "code",
    issues: [],
    verdict: "pass",
    blocking: false,
    recheck_required: false,
    attachments: [],
  };
  const decision: Decision = {
    id: "q(1)" as never,
    key: "q(1)" as never,
    kind: "choose",
    card_id,
    raised_by: "human",
    question: "fictional question",
    context: "",
    options: [],
    recommended: "a",
    affected_cards: [],
    affected_work_items: [],
    blocking: false,
    decider: "human",
    doc_refs: [],
    status: "open",
  };

  fixture.store.uow.run((tx) => {
    // The produce item has been delivered, so the card derives `review`.
    tx.work_items.put(project_id, {
      ...fixture.workItem,
      status: "delivered",
    } as never);
    tx.work_items.put(project_id, produce);
    tx.cards.put(project_id, secondCard);
    tx.work_items.put(project_id, otherSide);
    tx.deliveries.put(project_id, delivery);
    tx.reviews.put(project_id, review);
    tx.decisions.put(project_id, decision);
  });
}

beforeEach(async () => {
  fixture = seedFixture({ allowed_tools: allowed });
  const logger = memoryLogger();
  server = await startMcpServer({ store: fixture.store, log: logger.log });
});

afterEach(async () => {
  await server.close();
  fixture.close();
});

describe("get_card", () => {
  test("returns the card with derived status, work items and review matrix", async () => {
    seedCardRelations();
    const client = await connect(fixture.token);

    const result = await client.callTool({
      name: "get_card",
      arguments: { card_id: card_id },
    });
    expect(result.isError).toBeFalsy();

    const payload = textOf(result) as {
      card: { id: string; status: string; stored_status: string };
      work_items: Array<{ id: string }>;
      open_decisions: Array<{ key: string }>;
      deliveries: Array<{ id: string; summary: string }>;
      review_matrix: Array<{
        delivery_id: string;
        work_item_id: string;
        target_sha: string;
        verdict: string | null;
      }>;
    };

    // Inferred from the work items (M1.2), not read from the stored status.
    expect(payload.card.status).toBe("review");
    expect(payload.card.stored_status).toBe("todo");
    expect(payload.work_items.map((item) => item.id).sort()).toEqual([
      "W-1",
      "W-2",
    ]);
    expect(payload.open_decisions.map((decision) => decision.key)).toEqual([
      "q(1)",
    ]);
    expect(payload.deliveries).toEqual([
      expect.objectContaining({ id: "D-1", summary: "fictional delivery" }),
    ]);
    expect(payload.review_matrix).toEqual([
      {
        delivery_id: "D-1",
        work_item_id: "W-2",
        target_sha: "sha-abc",
        verdict: "pass",
        review_id: "V-1",
      },
    ]);
  });

  test("rejected completion keeps the card in progress", async () => {
    const completion: Delivery = {
      id: "D-2" as never,
      work_item_id: "W-1" as never,
      run_id: "R-2" as never,
      kind: "card_completion",
      summary: "fictional completion request",
      subject: { kind: "git_head", value: "sha-def" },
      evidence: [],
      attachments: [],
      known_gaps: [],
      requested_verifiers: [],
      status: "rejected",
    };
    fixture.store.uow.run((tx) => tx.deliveries.put(project_id, completion));

    const client = await connect(fixture.token);
    const payload = textOf(
      await client.callTool({
        name: "get_card",
        arguments: { card_id: card_id },
      }),
    ) as { card: { status: string } };
    expect(payload.card.status).toBe("in_progress");
  });

  test("an unknown card is not_found", async () => {
    const client = await connect(fixture.token);
    const result = await client.callTool({
      name: "get_card",
      arguments: { card_id: "C-404" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatchObject({ error: { code: "not_found" } });
  });

  test("a card outside the assignment scope is not_found", async () => {
    seedCardRelations();
    const client = await connect(fixture.token);

    // C-2 exists in the project, but this work-item assignment may only read C-1.
    const result = await client.callTool({
      name: "get_card",
      arguments: { card_id: "C-2" },
    });
    expect(textOf(result)).toMatchObject({ error: { code: "not_found" } });

    const updates = await client.callTool({
      name: "get_updates",
      arguments: { card_id: "C-2" },
    });
    expect(textOf(updates)).toMatchObject({ error: { code: "not_found" } });
  });

  test("a standing assignment may read any card of the project", async () => {
    seedCardRelations();
    const standing = fixture.store.uow.run((tx) => {
      const assignment = {
        ...fixture.assignment,
        id: "A-2" as never,
        scope: "standing" as const,
        work_item_id: undefined,
      };
      tx.assignments.put(project_id, assignment as never);
      return assignment;
    });
    const issued = fixture.store.issueToken({
      project_id,
      assignment_id: standing.id,
      role: { role_version: 1, allowed_tools: ["get_card"] },
    });

    const client = await connect(issued.token);
    const result = await client.callTool({
      name: "get_card",
      arguments: { card_id: "C-2" },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatchObject({ card: { id: "C-2" } });
  });

  test("recent deliveries are capped and newest first", async () => {
    const deliveries: Delivery[] = Array.from({ length: 12 }, (_, index) => ({
      id: `D-${index + 10}` as never,
      work_item_id: "W-1" as never,
      run_id: "R-1" as never,
      kind: "code",
      summary: `fictional ${index}`,
      subject: { kind: "git_head", value: `sha-${index}` },
      evidence: [],
      attachments: [],
      known_gaps: [],
      requested_verifiers: [],
      status: "submitted",
    }));
    fixture.store.uow.run((tx) => {
      for (const delivery of deliveries) {
        tx.deliveries.put(project_id, delivery);
      }
    });

    const client = await connect(fixture.token);
    const payload = textOf(
      await client.callTool({
        name: "get_card",
        arguments: { card_id: card_id },
      }),
    ) as { deliveries: Array<{ id: string }>; counts: { deliveries: number } };

    expect(payload.counts.deliveries).toBe(12);
    expect(payload.deliveries).toHaveLength(10);
    expect(payload.deliveries[0]?.id).toBe("D-21");
  });
});
