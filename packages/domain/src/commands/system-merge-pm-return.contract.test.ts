import { expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  type CommandState,
  type Decision,
  notices,
  recordDecision,
  resolveDelegatedDecision,
  standingTools,
  systemConfirmMerge,
} from "../index.js";
import { system, systemMergeFixture } from "./system-merge/test-fixtures.js";
import { assignment, human, id, role } from "./test-fixtures.js";

const { work_item_id: _work, ...base } = assignment(900, "pm");
const ops: Assignment = { ...base, scope: "standing", standing_mode: "ops" };
const office: Assignment = {
  ...base,
  id: id("assignment", 901),
  scope: "standing",
  standing_mode: "office",
};
const standing = (a: Assignment): Actor => ({
  kind: "assignment",
  project_id: human.project_id,
  assignment_id: a.id,
  ...role("pm"),
  allowed_tools: standingTools(
    role("pm").allowed_tools,
    a.standing_mode ?? "ops",
  ),
});
const authority = `project:${human.project_id}/pm-system-merge-return`;
const basis = "人在 Q-11 选 A：按图 2 返工";

/** C-591: a system-held confirmation plus active PM Ops and PM Office. */
async function setup() {
  const fixture = await systemMergeFixture();
  fixture.f.commit({
    ok: true,
    value: {
      data: null,
      changes: [ops, office].map((entity) => ({
        collection: "assignments" as const,
        entity,
      })),
      events: [],
      timeline: [],
      token_requests: [],
    },
  });
  expect(fixture.q).toMatchObject({ decider: "system", status: "open" });
  return fixture;
}
const decision = (s: CommandState, q: Decision) =>
  s.decisions.find((v) => v.id === q.id);
/** Card, work items and fix runs: what request-changes changes for everyone. */
const outcome = (s: CommandState) => ({
  cards: s.cards.map((c) => c.status),
  work_items: s.work_items.map((w) => [w.id, w.status]),
  runs: s.runs.filter((r) => r.kind === "fix").map((r) => r.assignment_id),
  events: s.events
    .filter((e) => e.type === "merge_changes_requested")
    .map((e) => (e.payload as { run_kind?: string }).run_kind),
});

test("C-591: PM Ops returns a system-held merge confirmation with reason and basis, same effect as the human", async () => {
  const human_ = await setup();
  human_.f.commit(
    recordDecision(
      human_.f.state,
      human,
      {
        decision_id: human_.q.id,
        option: "request_changes",
        rationale: "按图 2 返工",
        raw_quote: "退回修改",
      },
      human_.f.io,
    ),
  );

  const { f, q } = await setup();
  const pm = standing(ops);
  const resolve = (input: { rationale?: string; notice?: string }) =>
    resolveDelegatedDecision(
      f.state,
      pm,
      {
        decision_id: q.id,
        option: "request_changes",
        rationale: input.rationale ?? "按图 2 返工",
        ...(input.notice !== undefined ? { notice: input.notice } : {}),
      },
      f.io,
    );
  expect(resolve({ notice: basis, rationale: " " })).toMatchObject({
    ok: false,
    error: { code: "validation_failed" },
  });
  for (const notice of [undefined, " "])
    expect(
      resolve({ ...(notice === undefined ? {} : { notice }) }),
    ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  f.commit(resolve({ notice: basis }));

  expect(decision(f.state, q)).toMatchObject({
    decider: "system",
    status: "resolved",
    resolution: {
      option: "request_changes",
      resolved_by: `assignment:${ops.id}`,
      via: "delegated",
      proxy_authority: authority,
      notice: `按图 2 返工\n依据：${basis}`,
    },
  });
  expect(outcome(f.state)).toEqual(outcome(human_.f.state));
  expect(outcome(f.state).events).toEqual(["fix"]);
  expect(notices(f.state)).toMatchObject([
    {
      kind: "merge",
      decision_id: q.id,
      option: "request_changes",
      resolved_by: "pm",
      body: `按图 2 返工\n依据：${basis}`,
      proxy_authority: authority,
    },
  ]);
  expect(
    f.state.timeline.some(
      (t) => t.decision_id === q.id && t.body.includes("退回修改：按图 2 返工"),
    ),
  ).toBe(true);
});

test("C-591: PM Ops holds a system-held merge confirmation; the system cannot merge it while held", async () => {
  const { f, q, check } = await setup();
  check();
  expect(
    resolveDelegatedDecision(
      f.state,
      standing(ops),
      { decision_id: q.id, option: "hold", rationale: "等人确认图 2" },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  f.commit(
    resolveDelegatedDecision(
      f.state,
      standing(ops),
      {
        decision_id: q.id,
        option: "hold",
        rationale: "等人确认图 2",
        notice: basis,
      },
      f.io,
    ),
  );
  expect(decision(f.state, q)).toMatchObject({
    decider: "system",
    status: "snoozed",
    snooze: { reason: "等人确认图 2", by: `assignment:${ops.id}` },
  });
  expect(notices(f.state)[0]).toMatchObject({
    kind: "merge",
    decision_id: q.id,
    option: "hold",
    resolved_by: "pm",
    proxy_authority: authority,
  });
  expect(
    systemConfirmMerge(f.state, system, { decision_id: q.id }, f.io).ok,
  ).toBe(false);
  // A held confirmation can still be returned with a basis.
  f.commit(
    resolveDelegatedDecision(
      f.state,
      standing(ops),
      {
        decision_id: q.id,
        option: "request_changes",
        rationale: "按图 2 返工",
        notice: basis,
      },
      f.io,
    ),
  );
  expect(decision(f.state, q)?.status).toBe("resolved");
});

test("C-591: PM can never confirm or escalate a system-held merge in place of the system", async () => {
  const { f, q, check } = await setup();
  check();
  expect(
    resolveDelegatedDecision(
      f.state,
      standing(ops),
      {
        decision_id: q.id,
        option: "merge",
        rationale: "门禁已过",
        notice: basis,
      },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  expect(
    resolveDelegatedDecision(
      f.state,
      standing(ops),
      {
        decision_id: q.id,
        option: "request_changes",
        rationale: "交人",
        notice: basis,
        escalate: true,
      },
      f.io,
    ).ok,
  ).toBe(false);
  expect(
    recordDecision(
      f.state,
      standing(office),
      {
        decision_id: q.id,
        option: "merge",
        rationale: "门禁已过",
        raw_quote: "合并吧",
      },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  // Non-PM roles and Office via the Ops tool stay rejected.
  for (const caller of [f.actor(f.coder), standing(office)])
    expect(
      resolveDelegatedDecision(
        f.state,
        caller,
        {
          decision_id: q.id,
          option: "request_changes",
          rationale: "按图 2 返工",
          notice: basis,
        },
        f.io,
      ).ok,
    ).toBe(false);
  expect(
    recordDecision(
      f.state,
      f.actor(f.coder),
      {
        decision_id: q.id,
        option: "request_changes",
        rationale: "按图 2 返工",
        raw_quote: basis,
      },
      f.io,
    ).ok,
  ).toBe(false);
  expect(decision(f.state, q)?.status).toBe("open");
});

test("C-591: PM Office returns a system-held merge confirmation citing the quoted basis", async () => {
  const { f, q } = await setup();
  f.commit(
    recordDecision(
      f.state,
      standing(office),
      {
        decision_id: q.id,
        option: "request_changes",
        rationale: "按图 2 返工",
        raw_quote: basis,
      },
      f.io,
    ),
  );
  expect(decision(f.state, q)).toMatchObject({
    status: "resolved",
    resolution: {
      option: "request_changes",
      resolved_by: `assignment:${office.id}`,
      via: "delegated",
      proxy_authority: authority,
      raw_quote: basis,
    },
  });
  expect(outcome(f.state).events).toEqual(["fix"]);
  expect(notices(f.state)[0]).toMatchObject({
    decision_id: q.id,
    option: "request_changes",
  });
});
