/**
 * M1.7b end-to-end test: a real server, MCP SDK clients playing pm, coder and
 * reviewer, and the CLI acting as the host for token issuance.
 *
 * The host side (this test) also stands in for the M1 dispatcher: the domain
 * only checks that an assignment has exactly one running Run, so the test
 * provisions that Run before each agent turn, exactly like M2 will.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as cli } from "@cardigan/cli";
import { newUlid, Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, test } from "vitest";
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
  "request_decision",
  "report_blocker",
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

/** Run a CLI command as the human would, capturing what it prints. */
async function host(argv: readonly string[]): Promise<string> {
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

/** The last token the host printed; tokens are only ever printed once. */
function lastToken(): string {
  const lines = output
    .join("\n")
    .split("\n")
    .map((line) => line.trim());
  const index = lines.findIndex((line) => line.startsWith("token_id："));
  const token = lines[index === -1 ? -1 : index + 2];
  if (token === undefined || token.length === 0) {
    throw new Error(`no token in output:\n${output.join("\n")}`);
  }
  return token;
}

function resetOutput(): void {
  output = [];
  errors = [];
}

function client(token: string): Promise<Client> {
  const instance = new Client({ name: "fictional-agent", version: "0.0.0" });
  return instance
    .connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    )
    .then(() => instance);
}

function payload(result: unknown): Record<string, unknown> {
  const structured = (result as { structuredContent?: unknown })
    .structuredContent;
  if (typeof structured === "object" && structured !== null) {
    return structured as Record<string, unknown>;
  }
  const content = (result as { content?: Array<{ text?: string }> }).content;
  const text = content?.[0]?.text;
  return text === undefined
    ? {}
    : (JSON.parse(text) as Record<string, unknown>);
}

function errorCode(result: unknown): unknown {
  const body = payload(result) as { error?: { code?: string } };
  return body.error?.code;
}

/** M1 dispatcher stand-in: give an assignment exactly one running Run. */
function provisionRun(assignmentId: string): string {
  const store = Store.open({ dataDir });
  try {
    return store.uow.run((tx) => {
      const assignment = tx.assignments
        .list("p-e2e" as never)
        .find((candidate) => candidate.id === assignmentId);
      if (assignment === undefined)
        throw new Error(`no assignment ${assignmentId}`);
      const running = tx.runs
        .list("p-e2e" as never)
        .filter(
          (run) =>
            run.assignment_id === assignment.id &&
            !["completed", "failed", "cancelled"].includes(run.status),
        );
      if (running.length > 0) {
        throw new Error(`assignment ${assignmentId} already has a live Run`);
      }
      const run = {
        id: tx.ids.next("p-e2e" as never, "run"),
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
      tx.runs.put("p-e2e" as never, run as never);
      return run.id;
    });
  } finally {
    store.close();
  }
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-e2e-"));
  output = [];
  errors = [];
  await host(["init"]);
  await host(["project", "create", "p-e2e"]);
  for (const [role, tools] of [
    ["pm", PM_TOOLS],
    ["coder", CODER_TOOLS],
    ["reviewer", REVIEWER_TOOLS],
  ] as const) {
    await host([
      "role",
      "add",
      "p-e2e",
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

test("pm, coder and reviewer walk a dev card from creation to merge readiness", async () => {
  // --- host: a standing PM Office assignment with a token -------------------
  resetOutput();
  await host(["pm", "create", "--office"]);
  const pmToken = lastToken();
  const pm = await client(pmToken);
  const whoami = payload(await pm.callTool({ name: "whoami", arguments: {} }));
  expect(whoami).toMatchObject({ role_id: "pm", scope: "standing" });
  expect(whoami.allowed_tools).toContain("record_decision");

  // --- pm: create the card and assign coder, reviewer and acceptance -------
  const card = payload(
    await pm.callTool({
      name: "create_card",
      arguments: {
        idempotency_key: "e2e-card",
        title: "Fictional end-to-end card",
        goal: "Prove the M1 loop",
        acceptance_criteria: ["tests pass"],
        source: { kind: "quote", text: "fictional request" },
        repo: "example/repo",
        base_branch: "main",
      },
    }),
  ) as { id: string };
  const view = payload(
    await pm.callTool({ name: "get_card", arguments: { card_id: card.id } }),
  ) as { work_items: Array<{ id: string; role_id: string }> };
  const development = view.work_items.find((item) => item.role_id === "coder");
  const codeReview = view.work_items.find(
    (item) => item.role_id === "reviewer",
  );
  const acceptance = view.work_items.find((item) => item.role_id === "pm");
  if (!development || !codeReview || !acceptance)
    throw new Error("missing work items");

  const assigned: Record<string, string> = {};
  for (const [item, role] of [
    [development, "coder"],
    [codeReview, "reviewer"],
    [acceptance, "pm"],
  ] as const) {
    const assignment = payload(
      await pm.callTool({
        name: "assign",
        arguments: {
          idempotency_key: `e2e-assign-${item.id}`,
          work_item_id: item.id,
          role_id: role,
        },
      }),
    ) as { id: string; token_status: string };
    // MCP only creates the assignment; the host issues credentials.
    expect(assignment.token_status).toBe("pending_host_issuance");
    assigned[role] = assignment.id;
  }

  // --- host: issue the agent tokens one by one -----------------------------
  const tokens: Record<string, string> = {};
  for (const role of ["coder", "reviewer", "pm"] as const) {
    resetOutput();
    await host(["token", "issue", assigned[role] ?? ""]);
    tokens[role] = lastToken();
  }
  const coder = await client(tokens.coder ?? "");
  const reviewer = await client(tokens.reviewer ?? "");
  const acceptanceClient = await client(tokens.pm ?? "");

  // Tokens are printed once and only their hashes reach the database.
  for (const token of Object.values(tokens)) {
    for (const file of readdirSync(dataDir)) {
      expect(readFileSync(join(dataDir, file)).includes(token)).toBe(false);
    }
  }

  // --- coder: comment, then delivery D-1 -----------------------------------
  const commentArgs = {
    idempotency_key: "e2e-comment",
    card_id: card.id,
    body: "fictional progress note",
  };
  await coder.callTool({ name: "post_comment", arguments: commentArgs });
  const commentSeq = payload(
    await coder.callTool({
      name: "get_updates",
      arguments: { card_id: card.id },
    }),
  ) as { latest_seq: number; timeline: unknown[] };
  // Replaying the comment key must not append a second timeline entry.
  await coder.callTool({ name: "post_comment", arguments: commentArgs });
  const commentReplay = payload(
    await coder.callTool({
      name: "get_updates",
      arguments: { card_id: card.id },
    }),
  ) as { latest_seq: number; timeline: unknown[] };
  expect(commentReplay.latest_seq).toBe(commentSeq.latest_seq);
  expect(commentReplay.timeline).toHaveLength(commentSeq.timeline.length);
  const coderRun = provisionRun(assigned.coder ?? "");
  const d1 = payload(
    await coder.callTool({
      name: "submit_delivery",
      arguments: {
        idempotency_key: "e2e-d1",
        work_item_id: development.id,
        kind: "code",
        summary: "fictional first delivery",
        subject: { kind: "git_head", value: sha("a") },
        requested_verifiers: [codeReview.id],
      },
    }),
  ) as { id: string; status: string };
  expect(d1.status).toBe("submitted");
  await coder.callTool({
    name: "finish_run",
    arguments: {
      idempotency_key: "e2e-coder-run-1",
      run_id: coderRun,
      outcome: "completed",
      summary: "delivered",
    },
  });

  // The reviewer token cannot deliver.
  const wrongRole = await reviewer.callTool({
    name: "submit_delivery",
    arguments: {
      idempotency_key: "e2e-wrong-role",
      work_item_id: development.id,
      kind: "code",
      summary: "should be refused",
      subject: { kind: "git_head", value: sha("a") },
      requested_verifiers: [codeReview.id],
    },
  });
  expect(errorCode(wrongRole)).toBe("forbidden_tool");

  // --- reviewer: reject D-1 ------------------------------------------------
  const reviewRun1 = provisionRun(assigned.reviewer ?? "");
  const rejected = payload(
    await reviewer.callTool({
      name: "submit_review",
      arguments: {
        idempotency_key: "e2e-review-1",
        delivery_id: d1.id,
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
      },
    }),
  ) as { verdict: string };
  expect(rejected.verdict).toBe("reject");
  await reviewer.callTool({
    name: "finish_run",
    arguments: {
      idempotency_key: "e2e-reviewer-run-1",
      run_id: reviewRun1,
      outcome: "completed",
      summary: "rejected",
    },
  });

  // --- coder: delivery D-2 supersedes D-1 ----------------------------------
  const coderRun2 = provisionRun(assigned.coder ?? "");
  const d2 = payload(
    await coder.callTool({
      name: "submit_delivery",
      arguments: {
        idempotency_key: "e2e-d2",
        work_item_id: development.id,
        kind: "code",
        summary: "fictional second delivery",
        subject: { kind: "git_head", value: sha("b") },
        requested_verifiers: [codeReview.id],
      },
    }),
  ) as { id: string };
  expect(d2.id).not.toBe(d1.id);
  await coder.callTool({
    name: "finish_run",
    arguments: {
      idempotency_key: "e2e-coder-run-2",
      run_id: coderRun2,
      outcome: "completed",
      summary: "reworked",
    },
  });
  const afterRework = payload(
    await coder.callTool({ name: "get_card", arguments: { card_id: card.id } }),
  ) as { deliveries: Array<{ id: string; status: string }> };
  expect(
    afterRework.deliveries.find((delivery) => delivery.id === d1.id)?.status,
  ).toBe("superseded");

  // --- reviewer: old SHA is stale, the new one passes ----------------------
  const reviewRun2 = provisionRun(assigned.reviewer ?? "");
  const stale = await reviewer.callTool({
    name: "submit_review",
    arguments: {
      idempotency_key: "e2e-review-stale",
      delivery_id: d1.id,
      target_sha: sha("a"),
      kind: "code",
      issues: [],
    },
  });
  expect(errorCode(stale)).toBe("stale_target");

  const passed = payload(
    await reviewer.callTool({
      name: "submit_review",
      arguments: {
        idempotency_key: "e2e-review-2",
        delivery_id: d2.id,
        target_sha: sha("b"),
        kind: "code",
        issues: [],
      },
    }),
  ) as { verdict: string };
  expect(passed.verdict).toBe("pass");
  await reviewer.callTool({
    name: "finish_run",
    arguments: {
      idempotency_key: "e2e-reviewer-run-2",
      run_id: reviewRun2,
      outcome: "completed",
      summary: "passed",
    },
  });

  // --- coder: completion request, replaying the key writes once -----------
  provisionRun(assigned.coder ?? "");
  const completionArgs = {
    idempotency_key: "e2e-completion",
    work_item_id: development.id,
    kind: "card_completion",
    summary: "fictional completion request",
    subject: { kind: "git_head", value: sha("b") },
    requested_verifiers: [acceptance.id],
  };
  const completion = payload(
    await coder.callTool({
      name: "submit_delivery",
      arguments: completionArgs,
    }),
  ) as { id: string };
  const beforeReplay = payload(
    await coder.callTool({
      name: "get_updates",
      arguments: { card_id: card.id },
    }),
  ) as { latest_seq: number; events: unknown[]; timeline: unknown[] };
  const replay = payload(
    await coder.callTool({
      name: "submit_delivery",
      arguments: completionArgs,
    }),
  ) as { id: string };
  // A replayed idempotency key returns the same delivery and writes nothing.
  expect(replay.id).toBe(completion.id);
  const afterReplay = payload(
    await coder.callTool({
      name: "get_updates",
      arguments: { card_id: card.id },
    }),
  ) as { latest_seq: number; events: unknown[]; timeline: unknown[] };
  expect(afterReplay.latest_seq).toBe(beforeReplay.latest_seq);
  expect(afterReplay.events).toHaveLength(beforeReplay.events.length);
  expect(afterReplay.timeline).toHaveLength(beforeReplay.timeline.length);

  // --- pm acceptance turns the card done -----------------------------------
  const acceptanceRun = provisionRun(assigned.pm ?? "");
  const accepted = payload(
    await acceptanceClient.callTool({
      name: "submit_review",
      arguments: {
        idempotency_key: "e2e-acceptance",
        delivery_id: completion.id,
        target_sha: sha("b"),
        kind: "product",
        issues: [],
      },
    }),
  ) as { verdict: string };
  expect(accepted.verdict).toBe("pass");
  await acceptanceClient.callTool({
    name: "finish_run",
    arguments: {
      idempotency_key: "e2e-pm-run",
      run_id: acceptanceRun,
      outcome: "completed",
      summary: "accepted",
    },
  });

  const finalView = payload(
    await pm.callTool({ name: "get_card", arguments: { card_id: card.id } }),
  ) as { card: { status: string; resolution?: string } };
  expect(finalView.card.status).toBe("awaiting_merge");
  expect(finalView.card.resolution).toBeUndefined();

  // --- the host can re-issue a token, which revokes the previous one ------
  resetOutput();
  await host(["token", "issue", assigned.coder ?? ""]);
  const rotated = lastToken();
  expect(rotated).not.toBe(tokens.coder);
  // The old token is dead: the MCP handshake itself is refused with 401.
  await expect(client(tokens.coder ?? "")).rejects.toThrow(/unauthorized/i);
  await expect(client(rotated)).resolves.toBeDefined();
});

test("pm create --ops issues a token without record_decision", async () => {
  resetOutput();
  await host(["pm", "create", "--ops"]);
  const opsToken = lastToken();
  const ops = await client(opsToken);

  const identity = payload(
    await ops.callTool({ name: "whoami", arguments: {} }),
  );
  expect(identity.role_id).toBe("pm");
  expect(identity.allowed_tools).not.toContain("record_decision");

  // The Office token of the previous test would allow it; Ops is refused.
  const denied = await ops.callTool({
    name: "record_decision",
    arguments: {
      idempotency_key: "e2e-ops-record",
      decision_id: "q(1)",
      option: "a",
      rationale: "fictional",
      raw_quote: "fictional",
    },
  });
  expect(denied.isError ?? true).toBe(true);

  // Two standing PMs are not created: the command reuses the active one.
  const store = Store.open({ dataDir });
  try {
    const standing = store.uow.read((tx) =>
      tx.assignments
        .list("p-e2e" as never)
        .filter((a) => a.scope === "standing"),
    );
    expect(standing).toHaveLength(1);
  } finally {
    store.close();
  }
});
