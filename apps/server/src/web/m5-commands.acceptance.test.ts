import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import {
  createWorkItem,
  type Decision,
  requestDecision,
  requestWorktreeCleanup,
} from "@cardigan/domain";
import { routeEvent } from "@cardigan/router";
import { afterEach, expect, test } from "vitest";
import {
  type M5Cross,
  m5Cross,
  TEST_PASSWORD,
} from "../../test-support/m5-cross.js";
import { Dispatcher } from "../dispatch.js";
import { HttpRejection } from "./http.js";
import { serveWrite } from "./write.js";

/**
 * M5.T2 cross-acceptance for M5.2 (plan phase-1-m5 §3.4–§3.6, §8.2).
 *
 * Oracles: the M5 plan and development plan §4.4/§4.5/§6.4/§8.2/§14. Every
 * fixture is a real store, server and Git workspace built by `m4Cross` through
 * public CLI/domain/MCP calls; the Workbench is driven over HTTP only.
 */

let f: M5Cross | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

/** A logged-in Workbench on a real project. */
async function workbench(): Promise<M5Cross> {
  const cross = await m5Cross();
  f = cross;
  await cross.password(TEST_PASSWORD);
  expect(await cross.login()).toMatchObject({ status: 200 });
  return cross;
}
const cardPath = (s: M5Cross, rest: string) =>
  s.projectPath(`/cards/${s.card.id}/${rest}`);
const decisionPath = (s: M5Cross, id: string, operation: string) =>
  s.projectPath(`/decisions/${encodeURIComponent(id)}/${operation}`);
const question = {
  category: "general" as const,
  kind: "choose" as const,
  question: "要发布吗？",
  context: "需要你的方向",
  options: [
    { key: "go", description: "继续", impact: "解锁实现" },
    { key: "wait", description: "等待", impact: "晚一天" },
  ],
  recommended: "go",
  affected_cards: [],
  affected_work_items: [],
  blocking: false,
  decider: "human" as const,
};

test("§3.5/§6.4: a human instruction rings the owning Assignment once and never duplicates its Run", async () => {
  const s = await workbench();
  await s.start(s.primary.owner);
  await s.finish(s.primary.owner);
  const assignment = s.current(s.primary.owner);
  const runsBefore = s
    .state()
    .runs.filter((r) => r.assignment_id === assignment.id).length;
  const dispatcher = new Dispatcher({
    store: s.store(),
    runtime: s.runtime,
    clock: { now: () => new Date(s.now()).toISOString() },
    snapshot: async () => ({
      model: "fixture-model",
      agent_cli_version: "fixture-1",
    }),
    startRun: async () => {
      throw new Error("A live session must be woken, not started");
    },
  });
  const posted = await s.call(cardPath(s, "instructions"), {
    method: "POST",
    body: {
      work_item_id: assignment.work_item_id,
      body: `按 ${s.card.id} 实现，先看 ${assignment.work_item_id}`,
    },
  });
  expect(posted).toMatchObject({
    status: 200,
    json: { type: "instruction", author: "human" },
  });
  // Invariant 7: the event is committed before any bell can exist.
  const event = s
    .state()
    .events.findLast((e) => e.type === "instruction_issued");
  if (!event) throw new Error("The instruction was not persisted");
  const bellsBefore = s.bells.length,
    runsBeforeNames = new Set(s.state().runs.map((r) => r.id));
  await dispatcher.tick(s.project.project_id);
  const bell = s.bells
    .slice(bellsBefore)
    .find((b) => b.text.startsWith("[bell]"));
  if (!bell) throw new Error("The instruction did not ring a bell");
  // §6.4: the bell goes to the work item's own Assignment and runtime.
  expect(bell.ref).toEqual(assignment.runtime_ref);
  // §6.2: the bell names card, Assignment, Run and seq; the body stays local.
  expect(bell.text).toMatch(
    new RegExp(
      `^\\[bell\\] card=${s.card.id} asg=${assignment.id} run=R-\\d+ seq=${event.seq}\\.\\.${event.seq} summary="1 instruction"`,
      "u",
    ),
  );
  expect(bell.text).not.toContain("按");
  const runs = s
    .state()
    .runs.filter(
      (r) => r.assignment_id === assignment.id && !runsBeforeNames.has(r.id),
    );
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    kind: "followup",
    trigger_event_id: event.id,
    status: "dispatched",
  });
  const note = s
    .store()
    .listNotifications({ project_id: s.project.project_id })
    .find((n) => n.event_id === event.id);
  expect(note).toMatchObject({
    recipient: { kind: "assignment", assignment_id: assignment.id },
    kind: "instruction",
    status: "belled",
    run_id: runs[0]?.id,
  });
  // Invariant 10: a repeat tick reuses the Run instead of starting another.
  await dispatcher.tick(s.project.project_id);
  await dispatcher.tick(s.project.project_id);
  expect(
    s.state().runs.filter((r) => r.assignment_id === assignment.id),
  ).toHaveLength(runsBefore + 1);
  expect(s.bells.filter((b) => b.text.startsWith("[bell]"))).toHaveLength(1);
  // §6.4: an unassigned work item is handed to PM Ops instead of guessing an owner.
  const unassigned = s.command((state, actor, ports) =>
    createWorkItem(
      state,
      actor,
      {
        card_id: s.card.id,
        title: "No owner yet",
        kind: "produce",
        role_id: "coder",
        required: false,
        completion_criteria: [],
      },
      ports,
    ),
  );
  expect(
    await s.call(cardPath(s, "instructions"), {
      method: "POST",
      body: { work_item_id: unassigned.id, body: "请先登记负责人" },
    }),
  ).toMatchObject({ status: 200 });
  const last = s
    .state()
    .events.findLast((e) => e.type === "instruction_issued");
  if (!last) throw new Error("Missing instruction");
  expect(
    routeEvent({ event: last, snapshot: s.state() }).notifications,
  ).toContainEqual(
    expect.objectContaining({
      recipient: { kind: "pm_ops" },
      kind: "instruction",
    }),
  );
});

test("§3.6: 要求补充信息 and 让 PM 解释后果 wake the right Assignment; project decisions are refused", async () => {
  const s = await workbench();
  await s.start(s.primary.owner);
  const q = await s.mcp<Decision>(s.primary.owner, "request_decision", {
    ...question,
    card_id: s.card.id,
    blocking: true,
    affected_work_items: [s.primary.owner.work_item_id],
  });
  const office = s
    .state()
    .assignments.find((a) => a.standing_mode === "office");
  if (!office) throw new Error("No PM Office");
  for (const [action, target] of [
    ["request_information", s.primary.owner.id],
    ["explain", office.id],
  ] as const) {
    const events = s.state().events.length;
    const response = await s.call(decisionPath(s, q.id, "comments"), {
      method: "POST",
      body: { action, body: "  请说明影响 " },
    });
    expect(response).toMatchObject({
      status: 200,
      json: {
        type: "comment",
        author: "human",
        body: "  请说明影响 ",
        mentions: [`@${target}`],
        refs: [{ kind: "decision", id: q.id }],
      },
    });
    const event = s.state().events.at(-1);
    if (!event) throw new Error("Missing comment event");
    expect(s.state().events).toHaveLength(events + 1);
    expect(
      routeEvent({ event, snapshot: s.state() }).notifications,
    ).toContainEqual(
      expect.objectContaining({
        recipient: { kind: "assignment", assignment_id: target },
        kind: "comment",
        card_id: s.card.id,
      }),
    );
  }
  // §8.2: a project-level decision has no card timeline, so the API says so.
  const projectDecision = s.command((state, actor, ports) =>
    requestDecision(state, actor, question, ports),
  );
  const before = {
    events: s.state().events.length,
    timeline: s.state().timeline.length,
  };
  for (const [action, code] of [
    ["request_information", "validation_failed"],
    ["explain", "validation_failed"],
  ] as const) {
    expect(
      await s.call(decisionPath(s, projectDecision.id, "comments"), {
        method: "POST",
        body: { action },
      }),
    ).toMatchObject({ status: 400, json: { error: { code } } });
  }
  expect(s.state().events).toHaveLength(before.events);
  expect(s.state().timeline).toHaveLength(before.timeline);
});

test("§3.6: the merge confirmation resolved in Needs You is the `cardigan merge confirm` decision", async () => {
  const s = await workbench();
  const delivery = await s.deliver(
    s.primary,
    await s.change(s.primary.owner, "feature.txt", "done\n"),
  );
  await s.review(s.primary.verifier, delivery);
  await s.complete(delivery);
  const confirmation = s
    .state()
    .decisions.find((q) => q.trigger === "merge_confirmation");
  if (!confirmation) throw new Error("No merge confirmation");
  expect(
    await s.call(decisionPath(s, confirmation.id, "resolve"), {
      method: "POST",
      body: { option: "merge", raw_quote: "确认合并" },
    }),
  ).toMatchObject({
    status: 200,
    json: {
      resolution: {
        option: "merge",
        via: "needs_you",
        resolved_by: "human",
        raw_quote: "确认合并",
      },
    },
  });
  // The CLI reads the same decision, so it reports it as already confirmed.
  expect(await s.cli("merge", "confirm", s.card.id)).toContain("已经确认过了");
  expect(
    s.state().decisions.filter((q) => q.trigger === "merge_confirmation"),
  ).toHaveLength(1);
  expect(s.plan().deliveries.map((d) => d.delivery_id)).toContain(delivery.id);
});

test("§3.6: the worktree keep/clean choice in Needs You is the `cardigan worktree` decision", async () => {
  const s = await workbench();
  await s.start(s.primary.owner);
  await s.finish(s.primary.owner);
  s.release(s.primary.owner);
  const cleanup = s.command((state, _actor, ports) =>
    requestWorktreeCleanup(
      state,
      { kind: "system", project_id: state.project_id },
      { assignment_id: s.primary.owner.id, reason: "Uncommitted work" },
      ports,
    ),
  );
  expect(
    await s.call(decisionPath(s, cleanup.id, "resolve"), {
      method: "POST",
      body: { option: "force_clean", raw_quote: "备份后清掉" },
    }),
  ).toMatchObject({
    status: 200,
    json: {
      resolution: { option: "force_clean", via: "needs_you" },
    },
  });
  // The executor is the cleanup loop, not the Web request (§12.6).
  expect(existsSync(s.path(s.primary.owner))).toBe(true);
  expect(
    await s.cli("worktree", "clean", s.primary.owner.id, "--force"),
  ).toContain("已经处理过");
});

test("§14: write routes refuse other credentials, foreign origins and non-JSON, and a revoked session writes nothing", async () => {
  const s = await workbench();
  await s.start(s.primary.owner);
  const token = s.token(s.primary.owner);
  if (!token) throw new Error("No MCP token");
  const post = (
    rest: string,
    path = cardPath(s, rest),
    options: { headers?: Record<string, string>; anonymous?: boolean } = {},
  ) =>
    s.call(path, {
      method: "POST",
      body: { body: "forged" },
      ...options,
    });
  // MCP tokens are not Workbench sessions (§3.2 credential separation).
  expect(
    await post("comments", undefined, {
      anonymous: true,
      headers: { authorization: `Bearer ${token}` },
    }),
  ).toMatchObject({ status: 401 });
  // CSRF: an Origin is required and must be this listener.
  expect(
    await post("comments", undefined, { headers: { origin: "" } }),
  ).toMatchObject({
    status: 403,
    json: { error: { code: "origin_required" } },
  });
  expect(
    await post("comments", undefined, {
      headers: { origin: "https://foreign.invalid" },
    }),
  ).toMatchObject({
    status: 403,
    json: { error: { code: "origin_rejected" } },
  });
  expect(
    await post("comments", undefined, {
      headers: { "content-type": "text/plain" },
    }),
  ).toMatchObject({ status: 415 });
  // Unknown or other-project identifiers fail before any entity changes.
  const before = {
    events: s.state().events.length,
    timeline: s.state().timeline.length,
  };
  expect(
    await post("comments", s.projectPath("/cards/C-999/comments")),
  ).toMatchObject({ status: 404 });
  // A syntactically valid body for an unknown decision reaches the domain lookup.
  expect(
    await s.call(s.projectPath("/decisions/q(999)/resolve"), {
      method: "POST",
      body: { option: "go" },
    }),
  ).toMatchObject({ status: 404 });
  expect(s.state().events).toHaveLength(before.events);
  expect(s.state().timeline).toHaveLength(before.timeline);
  // Changing the password revokes every session; the next write is unauthenticated.
  s.store().setWebPassword("another long passphrase");
  expect(await post("comments")).toMatchObject({ status: 401 });
  expect(s.state().timeline).toHaveLength(before.timeline);
});

test("§8.2/M5.4: Needs You returns blocking first, then the longest wait, with a bounded reason", async () => {
  const s = await workbench();
  const make = (overrides: Partial<typeof question> & { card_id: string }) =>
    s.command((state, actor, ports) =>
      requestDecision(state, actor, { ...question, ...overrides }, ports),
    );
  const general = make({ card_id: s.card.id });
  s.advance(120_000);
  const risk = make({ card_id: s.card.id, category: "permission" });
  s.advance(120_000);
  const blocking = make({
    card_id: s.card.id,
    blocking: true,
    category: "data_deletion",
  });
  const response = await s.call(s.projectPath("/needs-you"));
  const body = response.json as {
    decisions: {
      id: string;
      why: string;
      blocking: boolean;
      category: string;
      waited_ms: number | null;
    }[];
    human_actions: unknown[];
    incidents: unknown[];
  };
  expect(body.decisions.map((q) => q.id)).toEqual([
    blocking.id,
    general.id,
    risk.id,
  ]);
  expect(body.decisions[0]).toMatchObject({
    blocking: true,
    category: "data_deletion",
  });
  for (const q of body.decisions) {
    expect([...q.why].length).toBeLessThanOrEqual(40);
    expect(typeof q.waited_ms).toBe("number");
    expect(q.waited_ms as number).toBeGreaterThanOrEqual(0);
  }
  expect(body.incidents).toEqual([]);
});

// Plan risk for the owner to settle: §3.6/§8.2 ask every Needs You item to show
// how long it has waited, but a project-level decision has no card timeline and
// the decision entity carries no creation time, so `waited_ms` stays null.
test("§3.6: a project-level decision still reports how long it has waited", async () => {
  const s = await workbench();
  const q = s.command((state, actor, ports) =>
    requestDecision(state, actor, question, ports),
  );
  s.advance(60_000);
  const response = await s.call(s.projectPath("/needs-you"));
  expect(
    (
      response.json as { decisions: { id: string; waited_ms: unknown }[] }
    ).decisions.find((item) => item.id === q.id)?.waited_ms,
  ).toBeGreaterThan(0);
});

// Settled 2026-11-06 (M5.T2): the first version only ships the development card
// template, whose completion request the PM reviews, and verification work items
// are never assigned to the human (D4). So no delivery ever waits for the human
// and the Workbench adds no human review command or endpoint. Deferred: plan
// phase-1-m5 §5 后续事项 and development plan §8.2.
test.todo(
  "§8.2: Needs You lists deliveries waiting for your review (see 计划第 5 节后续事项; not in the first version)",
);

test("§8.2: a write re-checks the session after the body and inside the write transaction", async () => {
  const s = await workbench();
  const body = `会话中途失效-${String(Date.now())}`;
  const calls: number[] = [];
  const request = (failAt: number) =>
    Object.assign(
      Readable.from([
        JSON.stringify({ body: `${body}-${failAt}` }),
      ]) as Readable & {
        method: string;
        headers: Record<string, string>;
      },
      { method: "POST", headers: { "content-type": "application/json" } },
    );
  const attempt = (failAt: number) => {
    let seen = 0;
    const input = request(failAt);
    return {
      result: serveWrite(
        {
          req: input as never,
          res: {} as never,
          store: s.store(),
          project_id: s.project.project_id,
          dataDir: s.dataDir,
          clock: { now: () => new Date(s.now()).toISOString() },
          authorize: () => {
            seen += 1;
            calls.push(seen);
            if (seen === failAt)
              throw new HttpRejection(401, "unauthorized", "session revoked");
          },
        },
        `/cards/${s.card.id}/comments`,
      ),
      input,
    };
  };
  const before = s.state().timeline.length;
  // The body is read before the second check, so the revocation lands first.
  const afterBody = attempt(2);
  await expect(afterBody.result).rejects.toMatchObject({ status: 401 });
  expect(calls).toEqual([1, 2]);
  // The third check runs inside the write transaction: the command rolls back.
  const inTransaction = attempt(3);
  await expect(inTransaction.result).rejects.toMatchObject({ status: 401 });
  expect(calls).toEqual([1, 2, 1, 2, 3]);
  expect(s.state().timeline).toHaveLength(before);
  expect(
    s.state().timeline.filter((entry) => entry.body.startsWith(body)),
  ).toEqual([]);
  afterBody.input.destroy();
  inTransaction.input.destroy();
});
