/**
 * M1.T3 (M1.6 part): acceptance tests for the MCP write tools, written from
 * docs/plans/phase-1-m1.md (M1.6, M1.T3), docs/development-plan.md §9.2/§16 and
 * packages/domain/COMMANDS.md. Only public interfaces are used: a real server,
 * the MCP SDK client, and the host-side CLI for token issuance.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as cli } from "@cardigan/cli";
import { newUlid, Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type CardiganServer, startCardiganServer } from "./server.js";

const PM_TOOLS = [
  "create_card",
  "update_card",
  "create_work_item",
  "update_work_item",
  "assign",
  "project_snapshot",
  "list_needs_you",
  "record_decision",
  "submit_review",
  "post_comment",
  "request_decision",
  "request_human_action",
  "report_blocker",
  "upload_attachment",
  "get_card",
  "get_updates",
  "ack_events",
  "whoami",
  "heartbeat",
  "finish_run",
];
const CODER_TOOLS = [
  "submit_delivery",
  "post_comment",
  "report_blocker",
  "request_decision",
  "request_human_action",
  "upload_attachment",
  "get_card",
  "get_updates",
  "ack_events",
  "whoami",
  "heartbeat",
  "finish_run",
];
const REVIEWER_TOOLS = [
  "submit_review",
  "post_comment",
  "get_card",
  "get_updates",
  "ack_events",
  "whoami",
  "heartbeat",
  "finish_run",
];

const sha = (letter: string): string => letter.repeat(40);

let dataDir: string;
let server: CardiganServer;
let output: string[];
let errors: string[];

/** The host (a human at the terminal) runs the CLI for everything privileged. */
async function host(argv: readonly string[]): Promise<string> {
  output = [];
  errors = [];
  const code = await cli([...argv], {
    env: { ...process.env, CARDIGAN_DATA_DIR: dataDir },
    cwd: dataDir,
    platform: process.platform,
    signals: { on: () => undefined, off: () => undefined },
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    spawnInherit: () => {
      throw new Error("the host must not spawn");
    },
    captureCommand: async () => ({ code: 1, stdout: "", stderr: "" }),
  });
  if (code !== 0) {
    throw new Error(`cardigan ${argv.join(" ")} failed: ${errors.join("\n")}`);
  }
  return output.join("\n");
}

function lastToken(): string {
  const lines = output
    .join("\n")
    .split("\n")
    .map((line) => line.trim());
  const token =
    lines[lines.findIndex((line) => line.startsWith("token_id：")) + 2];
  if (token === undefined)
    throw new Error(`no token in:\n${output.join("\n")}`);
  return token;
}

function connect(token: string): Promise<Client> {
  const client = new Client({ name: "fictional-verifier", version: "0.0.0" });
  return client
    .connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    )
    .then(() => client);
}

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

/** The domain error code carried back through MCP (§4.3), or `undefined`. */
function errorCode(result: unknown): unknown {
  const body = payload(result) as { error?: { code?: string } };
  return body.error?.code;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return payload(await client.callTool({ name, arguments: args }));
}

/** The M1 dispatcher stand-in: one running Run for the assignment's turn. */
function provisionRun(assignmentId: string): string {
  const store = Store.open({ dataDir });
  try {
    return store.uow.run((tx) => {
      const project = "p-write" as never;
      const assignment = tx.assignments
        .list(project)
        .find((candidate) => candidate.id === assignmentId);
      if (assignment === undefined)
        throw new Error(`no assignment ${assignmentId}`);
      const run = {
        id: tx.ids.next(project, "run"),
        assignment_id: assignment.id,
        trigger_event_id: newUlid() as never,
        kind: "initial" as const,
        status: "running" as const,
        role_version: assignment.role_version,
        model: "fictional-model",
        agent_cli_version: "0.0.1",
        started_at: new Date().toISOString(),
        outcome: null,
        summary: "",
      };
      tx.runs.put(project, run as never);
      return run.id;
    });
  } finally {
    store.close();
  }
}

interface World {
  readonly cardId: string;
  readonly development: string;
  readonly codeReview: string;
  readonly acceptance: string;
  readonly office: Client;
  readonly coder: Client;
  readonly reviewer: Client;
  readonly acceptanceClient: Client;
  readonly assignments: Record<"coder" | "reviewer" | "pm", string>;
}

/** Create the card over MCP, assign the three work items, issue tokens. */
async function world(): Promise<World> {
  await host(["pm", "create", "--office"]);
  const officeToken = lastToken();
  const office = await connect(officeToken);

  const card = await call(office, "create_card", {
    idempotency_key: "w-card",
    title: "Fictional write-tool card",
    goal: "Exercise every MCP write tool",
    acceptance_criteria: ["tools work"],
    source: { kind: "quote", text: "fictional request" },
    repo: "example/repo",
    base_branch: "main",
  });
  const cardId = String(card.id);
  const view = await call(office, "get_card", { card_id: cardId });
  const items = view.work_items as Array<{ id: string; role_id: string }>;
  const development = items.find((item) => item.role_id === "coder")?.id;
  const codeReview = items.find((item) => item.role_id === "reviewer")?.id;
  const acceptance = items.find((item) => item.role_id === "pm")?.id;
  if (!development || !codeReview || !acceptance)
    throw new Error("template items missing");

  const assignments: Record<string, string> = {};
  for (const [workItemId, role] of [
    [development, "coder"],
    [codeReview, "reviewer"],
    [acceptance, "pm"],
  ] as const) {
    const assigned = await call(office, "assign", {
      idempotency_key: `w-assign-${workItemId}`,
      work_item_id: workItemId,
      role_id: role,
    });
    assignments[role] = String(assigned.id);
  }

  const tokens: Record<string, string> = {};
  for (const role of ["coder", "reviewer", "pm"] as const) {
    await host(["token", "issue", assignments[role] ?? ""]);
    tokens[role] = lastToken();
  }

  return {
    cardId,
    development,
    codeReview,
    acceptance,
    office,
    coder: await connect(tokens.coder ?? ""),
    reviewer: await connect(tokens.reviewer ?? ""),
    acceptanceClient: await connect(tokens.pm ?? ""),
    assignments: assignments as World["assignments"],
  };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-write-"));
  output = [];
  errors = [];
  await host(["init"]);
  await host(["project", "create", "p-write"]);
  for (const [role, tools] of [
    ["pm", PM_TOOLS],
    ["coder", CODER_TOOLS],
    ["reviewer", REVIEWER_TOOLS],
  ] as const) {
    await host([
      "role",
      "add",
      "p-write",
      role,
      "--allowed-tools",
      tools.join(","),
    ]);
  }
  server = await startCardiganServer({
    config: { dataDir, host: "127.0.0.1", port: 0 },
  });
});

afterEach(async () => {
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("every write tool has one normal call", () => {
  test("card, work item and assignment tools (pm)", async () => {
    const w = await world();

    // update_card
    const updated = await call(w.office, "update_card", {
      idempotency_key: "w-update-card",
      card_id: w.cardId,
      priority: 7,
    });
    expect(updated.priority).toBe(7);

    // create_work_item
    const created = await call(w.office, "create_work_item", {
      idempotency_key: "w-create-item",
      card_id: w.cardId,
      title: "Fictional extra review",
      kind: "verify",
      role_id: "reviewer",
      required: false,
      completion_criteria: [],
      target_work_item_id: w.development,
    });
    expect(created.kind).toBe("verify");

    // update_work_item
    const renamed = await call(w.office, "update_work_item", {
      idempotency_key: "w-update-item",
      work_item_id: String(created.id),
      title: "Fictional extra review (renamed)",
    });
    expect(renamed.title).toBe("Fictional extra review (renamed)");

    // assign (already used by the fixture; a repeat is answered from the key)
    const assigned = await call(w.office, "assign", {
      idempotency_key: `w-assign-${w.development}`,
      work_item_id: w.development,
      role_id: "coder",
    });
    expect(assigned.id).toBe(w.assignments.coder);
  });

  test("collaboration tools (coder) and the office decision record", async () => {
    const w = await world();
    provisionRun(w.assignments.coder);

    // post_comment
    const comment = await call(w.coder, "post_comment", {
      idempotency_key: "w-comment",
      card_id: w.cardId,
      body: "fictional note that mentions C-1",
    });
    expect(comment.type).toBe("comment");

    // report_blocker (returns guidance; the work item itself becomes blocked)
    const blocked = await call(w.coder, "report_blocker", {
      idempotency_key: "w-blocker",
      work_item_id: w.development,
      reason: "fictional blocker",
      needs: "role",
    });
    expect(blocked.work_item_id).toBe(w.development);
    expect(String(blocked.guidance).length).toBeGreaterThan(0);
    const afterBlocker = await call(w.office, "get_card", {
      card_id: w.cardId,
    });
    const developmentItem = (
      afterBlocker.work_items as Array<{ id: string; status: string }>
    ).find((item) => item.id === w.development);
    expect(developmentItem?.status).toBe("blocked");

    // request_decision (non blocking, so work continues)
    const decision = await call(w.coder, "request_decision", {
      idempotency_key: "w-decision",
      card_id: w.cardId,
      kind: "choose",
      category: "general",
      question: "Fictional choice?",
      context: "Fictional context",
      options: [
        { key: "a", description: "Option A", impact: "none" },
        { key: "b", description: "Option B", impact: "none" },
      ],
      recommended: "a",
      affected_cards: [w.cardId],
      affected_work_items: [],
      blocking: false,
      decider: "human",
    });
    expect(decision.status).toBe("open");

    // record_decision (PM Office only, with the human's words)
    const recorded = await call(w.office, "record_decision", {
      idempotency_key: "w-record",
      decision_id: String(decision.id),
      option: "a",
      rationale: "fictional rationale",
      raw_quote: "fictional quote",
    });
    expect(recorded.status).toBe("resolved");

    // request_human_action
    const action = await call(w.coder, "request_human_action", {
      idempotency_key: "w-human-action",
      card_id: w.cardId,
      instructions: "Fictional manual step",
      why_human: "needs a credential",
      expected_return: "confirmation",
      blocked_work_items: [],
    });
    expect(action.status).toBe("open");
  });

  test("delivery, review, attachment, heartbeat and finish_run", async () => {
    const w = await world();
    const coderRun = provisionRun(w.assignments.coder);

    // heartbeat writes no event and no timeline entry
    const beforeHeartbeat = await call(w.coder, "get_updates", {
      card_id: w.cardId,
    });
    const beat = await call(w.coder, "heartbeat", {
      idempotency_key: "w-heartbeat",
      run_id: coderRun,
      note: "fictional note",
    });
    expect(beat.id).toBe(coderRun);
    const afterHeartbeat = await call(w.coder, "get_updates", {
      card_id: w.cardId,
    });
    expect(afterHeartbeat.latest_seq).toBe(beforeHeartbeat.latest_seq);

    // upload_attachment (evidence, then an artifact bound to a decision)
    const evidence = await call(w.coder, "upload_attachment", {
      idempotency_key: "w-evidence",
      card_id: w.cardId,
      file: Buffer.from("fictional evidence").toString("base64"),
      mime: "text/plain",
      kind: "evidence",
      attach_to: { kind: "timeline_entry", id: "C-1#1" },
    });
    expect(evidence.kind).toBe("evidence");

    // submit_delivery
    const delivery = await call(w.coder, "submit_delivery", {
      idempotency_key: "w-delivery",
      work_item_id: w.development,
      kind: "code",
      summary: "fictional delivery",
      subject: { kind: "git_head", value: sha("a") },
      requested_verifiers: [w.codeReview],
    });
    expect(delivery.status).toBe("submitted");

    // finish_run
    const finished = await call(w.coder, "finish_run", {
      idempotency_key: "w-finish",
      run_id: coderRun,
      outcome: "completed",
      summary: "delivered",
    });
    expect(finished.status).toBe("completed");

    // submit_review
    provisionRun(w.assignments.reviewer);
    const review = await call(w.reviewer, "submit_review", {
      idempotency_key: "w-review",
      delivery_id: String(delivery.id),
      target_sha: sha("a"),
      kind: "code",
      issues: [],
    });
    expect(review.verdict).toBe("pass");
  });
});

describe("domain error codes come back verbatim", () => {
  test("unauthorized / forbidden_tool / not_found", async () => {
    const w = await world();
    const other = await call(w.office, "create_card", {
      idempotency_key: "w-card-2",
      title: "Another card",
      goal: "Stay out of the coder's scope",
      acceptance_criteria: ["nothing"],
      source: { kind: "quote", text: "fictional" },
      repo: "example/repo",
      base_branch: "main",
    });

    // A work-item assignment may not touch another card.
    const outside = await w.coder.callTool({
      name: "post_comment",
      arguments: {
        idempotency_key: "w-outside",
        card_id: String(other.id),
        body: "x",
      },
    });
    expect(errorCode(outside)).toBe("unauthorized");

    // The reviewer's token has no submit_delivery at all.
    const forbidden = await w.reviewer.callTool({
      name: "submit_delivery",
      arguments: {
        idempotency_key: "w-forbidden",
        work_item_id: w.development,
        kind: "code",
        summary: "should not pass",
        subject: { kind: "git_head", value: sha("a") },
        requested_verifiers: [w.codeReview],
      },
    });
    expect(errorCode(forbidden)).toBe("forbidden_tool");

    const missing = await w.office.callTool({
      name: "post_comment",
      arguments: { idempotency_key: "w-missing", card_id: "C-99", body: "x" },
    });
    expect(errorCode(missing)).toBe("not_found");
  });

  test("illegal_transition / invariant_violation / validation_failed", async () => {
    const w = await world();

    // Progress states cannot be set by hand.
    const manual = await w.office.callTool({
      name: "update_work_item",
      arguments: {
        idempotency_key: "w-manual",
        work_item_id: w.development,
        status: "in_progress",
      },
    });
    expect(errorCode(manual)).toBe("illegal_transition");

    // One work item keeps one persistent assignment.
    const reassign = await w.office.callTool({
      name: "assign",
      arguments: {
        idempotency_key: "w-reassign",
        work_item_id: w.development,
        role_id: "reviewer",
      },
    });
    expect(["invariant_violation", "validation_failed"]).toContain(
      errorCode(reassign),
    );

    // A delivery must request every required verifier.
    provisionRun(w.assignments.coder);
    const incomplete = await w.coder.callTool({
      name: "submit_delivery",
      arguments: {
        idempotency_key: "w-incomplete",
        work_item_id: w.development,
        kind: "code",
        summary: "missing a verifier",
        subject: { kind: "git_head", value: sha("a") },
        requested_verifiers: [w.acceptance],
      },
    });
    expect(errorCode(incomplete)).toBe("invariant_violation");

    // Zod-level rejection also surfaces as validation_failed.
    const badSummary = await w.coder.callTool({
      name: "submit_delivery",
      arguments: {
        idempotency_key: "w-bad-summary",
        work_item_id: w.development,
        kind: "code",
        summary: "x".repeat(161),
        subject: { kind: "git_head", value: sha("a") },
        requested_verifiers: [w.codeReview],
      },
    });
    expect(errorCode(badSummary)).toBe("validation_failed");
  });

  test("stale_target and idempotency_conflict", async () => {
    const w = await world();
    const coderRun = provisionRun(w.assignments.coder);
    const first = await call(w.coder, "submit_delivery", {
      idempotency_key: "w-d1",
      work_item_id: w.development,
      kind: "code",
      summary: "fictional first",
      subject: { kind: "git_head", value: sha("a") },
      requested_verifiers: [w.codeReview],
    });
    await call(w.coder, "finish_run", {
      idempotency_key: "w-finish-1",
      run_id: coderRun,
      outcome: "completed",
      summary: "first",
    });

    // Same key with different parameters is a conflict, not an overwrite.
    const conflict = await w.coder.callTool({
      name: "submit_delivery",
      arguments: {
        idempotency_key: "w-d1",
        work_item_id: w.development,
        kind: "code",
        summary: "different content",
        subject: { kind: "git_head", value: sha("b") },
        requested_verifiers: [w.codeReview],
      },
    });
    expect(errorCode(conflict)).toBe("idempotency_conflict");

    provisionRun(w.assignments.reviewer);
    const rejected = await call(w.reviewer, "submit_review", {
      idempotency_key: "w-reject",
      delivery_id: String(first.id),
      target_sha: sha("a"),
      kind: "code",
      issues: [
        {
          severity: "major",
          description: "fictional bug",
          must_fix: true,
          pre_existing: false,
        },
      ],
    });
    expect(rejected.verdict).toBe("reject");

    provisionRun(w.assignments.coder);
    const second = await call(w.coder, "submit_delivery", {
      idempotency_key: "w-d2",
      work_item_id: w.development,
      kind: "code",
      summary: "fictional second",
      subject: { kind: "git_head", value: sha("b") },
      requested_verifiers: [w.codeReview],
    });

    provisionRun(w.assignments.reviewer);
    const stale = await w.reviewer.callTool({
      name: "submit_review",
      arguments: {
        idempotency_key: "w-stale",
        delivery_id: String(first.id),
        target_sha: sha("a"),
        kind: "code",
        issues: [],
      },
    });
    expect(errorCode(stale)).toBe("stale_target");
    expect(second.status).toBe("submitted");
  });
});

describe("idempotent replay", () => {
  test("the same key returns the same delivery and writes no event", async () => {
    const w = await world();
    const coderRun = provisionRun(w.assignments.coder);
    const args = {
      idempotency_key: "w-replay",
      work_item_id: w.development,
      kind: "code",
      summary: "fictional replay",
      subject: { kind: "git_head", value: sha("a") },
      requested_verifiers: [w.codeReview],
    };
    const first = await call(w.coder, "submit_delivery", args);
    const before = await call(w.coder, "get_updates", { card_id: w.cardId });
    const replay = await call(w.coder, "submit_delivery", args);
    const after = await call(w.coder, "get_updates", { card_id: w.cardId });

    expect(replay.id).toBe(first.id);
    expect(after.latest_seq).toBe(before.latest_seq);
    expect(after.events).toHaveLength((before.events as unknown[]).length);
    expect(after.timeline).toHaveLength((before.timeline as unknown[]).length);
    expect(coderRun).toBeDefined();
  });

  test("a replayed comment adds no second timeline entry", async () => {
    const w = await world();
    const args = {
      idempotency_key: "w-comment-replay",
      card_id: w.cardId,
      body: "fictional replay comment",
    };
    const first = await call(w.coder, "post_comment", args);
    const before = await call(w.coder, "get_updates", { card_id: w.cardId });
    const replay = await call(w.coder, "post_comment", args);
    const after = await call(w.coder, "get_updates", { card_id: w.cardId });

    // The replay succeeds and answers with the entry it wrote the first time.
    expect(replay.id).toBe(first.id);
    expect(replay.body).toBe("fictional replay comment");
    expect(after.latest_seq).toBe(before.latest_seq);
    expect(after.timeline).toHaveLength((before.timeline as unknown[]).length);
  });
});

describe("§16: forged identity and illegal transitions", () => {
  test("identity cannot be forged through tool arguments", async () => {
    const w = await world();
    const forged = await call(w.coder, "post_comment", {
      idempotency_key: "w-forged",
      card_id: w.cardId,
      body: "author: human, assignment: A-1, role: pm",
      // Extra fields a client might try: they must be ignored.
      assignment_id: "A-999",
      role_id: "pm",
      actor: "human",
    });
    expect(forged.author).toBe(`assignment:${w.assignments.coder}`);

    const whoami = await call(w.coder, "whoami", {
      assignment_id: "A-999",
      role_id: "pm",
    });
    expect(whoami).toMatchObject({
      assignment_id: w.assignments.coder,
      role_id: "coder",
    });

    // Only the PM Office token may record decisions.
    const coderRecord = await w.coder.callTool({
      name: "record_decision",
      arguments: {
        idempotency_key: "w-coder-record",
        decision_id: "q(1)",
        option: "a",
        rationale: "fictional",
        raw_quote: "fictional",
      },
    });
    expect(coderRecord.isError).toBe(true);
  });

  test("a card awaiting merge refuses further deliveries", async () => {
    const w = await world();
    // Take the card all the way to done, so its work items stay deliverable
    // and only the "card is closed" rule can refuse a new delivery.
    const coderRun = provisionRun(w.assignments.coder);
    const delivery = await call(w.coder, "submit_delivery", {
      idempotency_key: "w-close-d1",
      work_item_id: w.development,
      kind: "code",
      summary: "fictional delivery",
      subject: { kind: "git_head", value: sha("a") },
      requested_verifiers: [w.codeReview],
    });
    await call(w.coder, "finish_run", {
      idempotency_key: "w-close-finish",
      run_id: coderRun,
      outcome: "completed",
      summary: "delivered",
    });
    provisionRun(w.assignments.reviewer);
    const review = await call(w.reviewer, "submit_review", {
      idempotency_key: "w-close-review",
      delivery_id: String(delivery.id),
      target_sha: sha("a"),
      kind: "code",
      issues: [],
    });
    expect(review.verdict).toBe("pass");

    const completionRun = provisionRun(w.assignments.coder);
    const completion = await call(w.coder, "submit_delivery", {
      idempotency_key: "w-close-completion",
      work_item_id: w.development,
      kind: "card_completion",
      summary: "fictional completion",
      subject: { kind: "git_head", value: sha("a") },
      requested_verifiers: [w.acceptance],
    });
    await call(w.coder, "finish_run", {
      idempotency_key: "w-close-finish-2",
      run_id: completionRun,
      outcome: "completed",
      summary: "completion requested",
    });
    provisionRun(w.assignments.pm);
    const accepted = await call(w.acceptanceClient, "submit_review", {
      idempotency_key: "w-close-accept",
      delivery_id: String(completion.id),
      target_sha: sha("a"),
      kind: "product",
      issues: [],
    });
    expect(accepted.verdict).toBe("pass");

    const closed = await call(w.office, "get_card", { card_id: w.cardId });
    expect((closed.card as { status: string }).status).toBe("awaiting_merge");

    // A new delivery while awaiting merge is refused and writes nothing, even
    // though `accepted --delivery_submitted--> delivered` exists in the table.
    const before = await call(w.office, "get_updates", { card_id: w.cardId });
    provisionRun(w.assignments.coder);
    const after = await w.coder.callTool({
      name: "submit_delivery",
      arguments: {
        idempotency_key: "w-after-done",
        work_item_id: w.development,
        kind: "code",
        summary: "should be refused",
        subject: { kind: "git_head", value: sha("b") },
        requested_verifiers: [w.codeReview],
      },
    });
    expect(errorCode(after)).toBe("illegal_transition");
    const updates = await call(w.office, "get_updates", { card_id: w.cardId });
    expect(updates.latest_seq).toBe(before.latest_seq);

    // And the card cannot be flipped back to done by hand either.
    const manualDone = await w.office.callTool({
      name: "update_card",
      arguments: {
        idempotency_key: "w-manual-done",
        card_id: w.cardId,
        status: "done",
      },
    });
    expect(errorCode(manualDone)).toBe("illegal_transition");
  });
});

describe("assign never returns a credential", () => {
  test("the response carries a pending status and no token", async () => {
    const w = await world();
    // A fresh work item, so this assign really has to provision credentials.
    const created = await call(w.office, "create_work_item", {
      idempotency_key: "w-item-for-assign",
      card_id: w.cardId,
      title: "Fictional second producer",
      kind: "produce",
      role_id: "coder",
      required: false,
      completion_criteria: [],
    });
    const response = await call(w.office, "assign", {
      idempotency_key: "w-assign-fresh",
      work_item_id: String(created.id),
      role_id: "coder",
    });

    // §9.2 / plan v7: MCP only registers the assignment; the host issues the token.
    expect(response.token_status).toBe("pending_host_issuance");
    const text = JSON.stringify(response);
    expect(text).not.toMatch(/"(token|token_id|secret|authorization)"/i);
    // No credential-shaped value (base64url tokens are 43 characters here).
    expect(text).not.toMatch(/[A-Za-z0-9_-]{32,}/);

    const store = Store.open({ dataDir });
    try {
      const tokens = store.uow.run((tx) =>
        tx.tokensForAssignment(
          "p-write" as never,
          String(response.id) as never,
        ),
      );
      // The assignment exists and has no token at all until the host issues one.
      expect(tokens).toEqual([]);
    } finally {
      store.close();
    }

    // Repeating the assignment needs no credential either.
    const repeat = await call(w.office, "assign", {
      idempotency_key: "w-assign-repeat",
      work_item_id: String(created.id),
      role_id: "coder",
    });
    expect(repeat.id).toBe(response.id);
    expect(repeat.token_status).toBe("host_managed");
    expect(JSON.stringify(repeat)).not.toMatch(/[A-Za-z0-9_-]{32,}/);
  });
});

describe("attachment limits", () => {
  test("non-canonical base64 is rejected", async () => {
    const w = await world();
    for (const file of ["not base64!!", "YQ", "YQ==extra"]) {
      const result = await w.coder.callTool({
        name: "upload_attachment",
        arguments: {
          idempotency_key: `w-b64-${file.length}-${file.charCodeAt(0)}`,
          card_id: w.cardId,
          file,
          mime: "text/plain",
          kind: "evidence",
          attach_to: { kind: "timeline_entry", id: "C-1#1" },
        },
      });
      expect(errorCode(result)).toBe("validation_failed");
    }
  });

  test("more than 10 MiB is rejected", async () => {
    const w = await world();
    const tooBig = Buffer.alloc(10 * 1024 * 1024 + 1, 97).toString("base64");
    const result = await w.coder.callTool({
      name: "upload_attachment",
      arguments: {
        idempotency_key: "w-too-big",
        card_id: w.cardId,
        file: tooBig,
        mime: "application/octet-stream",
        kind: "evidence",
        attach_to: { kind: "timeline_entry", id: "C-1#1" },
      },
    });
    expect(errorCode(result)).toBe("validation_failed");
  });

  test("an artifact without a basis is rejected, evidence is accepted", async () => {
    const w = await world();
    const file = Buffer.from("fictional bytes").toString("base64");

    provisionRun(w.assignments.coder);
    const delivery = await call(w.coder, "submit_delivery", {
      idempotency_key: "w-delivery-for-attachment",
      work_item_id: w.development,
      kind: "code",
      summary: "fictional delivery for attachment",
      subject: { kind: "git_head", value: sha("a") },
      requested_verifiers: [w.codeReview],
    });

    // The target exists, so only the missing basis can explain the refusal.
    const artifact = await w.coder.callTool({
      name: "upload_attachment",
      arguments: {
        idempotency_key: "w-artifact-no-basis",
        card_id: w.cardId,
        file,
        mime: "text/plain",
        kind: "artifact",
        attach_to: { kind: "delivery", id: String(delivery.id) },
      },
    });
    expect(errorCode(artifact)).toBe("validation_failed");

    const decision = await call(w.coder, "request_decision", {
      idempotency_key: "w-basis",
      card_id: w.cardId,
      kind: "choose",
      category: "general",
      question: "Fictional artifact basis?",
      context: "Fictional context",
      options: [
        { key: "a", description: "Option A", impact: "none" },
        { key: "b", description: "Option B", impact: "none" },
      ],
      recommended: "a",
      affected_cards: [w.cardId],
      affected_work_items: [],
      blocking: false,
      decider: "human",
    });

    const accepted = await call(w.coder, "upload_attachment", {
      idempotency_key: "w-artifact-with-basis",
      card_id: w.cardId,
      file,
      mime: "text/plain",
      kind: "artifact",
      attach_to: { kind: "delivery", id: String(delivery.id) },
      basis: String(decision.id),
    });
    expect(accepted.kind).toBe("artifact");
    expect(accepted.basis).toBe(String(decision.id));
    expect(delivery.status).toBe("submitted");
  });
});
