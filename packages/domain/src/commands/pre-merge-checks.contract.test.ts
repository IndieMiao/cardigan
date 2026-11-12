import { describe, expect, it } from "vitest";
import type { Actor, Assignment, Card, Delivery } from "../entities.js";
import type { CardId } from "../ids.js";
import { recordDecision } from "./coordination.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { updateCard } from "./pm.js";
import {
  effectivePreMergeChecks,
  openPreMergeChecks,
} from "./pre-merge-checks.js";
import {
  actor,
  apply,
  assignment,
  fixture,
  human,
  id,
  ports,
  role,
  value,
} from "./test-fixtures.js";

function delivery(n: number, sha: string): Delivery {
  return {
    id: id("delivery", n),
    work_item_id: id("work_item", 1),
    run_id: id("run", 1),
    kind: "code",
    summary: "Ready",
    subject: { kind: "git_head", value: sha.repeat(40) },
    status: "submitted",
    evidence: [],
    attachments: [],
    known_gaps: [],
    requested_verifiers: [],
  };
}
function setup() {
  let state = fixture();
  const { work_item_id: _work, ...base } = assignment(4, "pm");
  const ops: Assignment = { ...base, scope: "standing", standing_mode: "ops" };
  const office: Assignment = {
    ...base,
    id: id("assignment", 5),
    scope: "standing",
    standing_mode: "office",
  };
  state = {
    ...state,
    assignments: [
      ...state.assignments.filter((a) => a.id !== ops.id),
      ops,
      office,
    ],
    deliveries: [delivery(1, "a")],
  };
  const as = (a: Assignment): Actor => ({
    kind: "assignment",
    project_id: human.project_id,
    assignment_id: a.id,
    ...role("pm"),
  });
  return { state, io: ports(), ops: as(ops), office: as(office) };
}
const card_id = id("card", 1) as CardId;
const cardOf = (state: ReturnType<typeof fixture>): Card =>
  state.cards.find((c) => c.id === card_id) as Card;
const open = (state: ReturnType<typeof fixture>) =>
  openPreMergeChecks(cardOf(state), state.work_items, state.deliveries);

describe("C-160 pre-merge checks via update_card", () => {
  it("PM Ops adds a pending check; PM Office passes it; each change is on the timeline", () => {
    let { state, io, ops, office } = setup();
    const added = updateCard(
      state,
      ops,
      {
        card_id,
        pre_merge_check: { label: "独立安全审核", status: "pending" },
      },
      io,
    );
    state = apply(state, value(added));
    expect(open(state).map((c) => c.label)).toEqual(["独立安全审核"]);
    expect(value(added).timeline[0]?.body).toBe(
      "合并前核对「独立安全审核」：新增，待完成",
    );
    expect(value(added).timeline[0]?.author).toBe(
      `assignment:${id("assignment", 4)}`,
    );
    expect(value(added).events[0]?.type).toBe("pre_merge_check_updated");

    const passed = updateCard(
      state,
      office,
      {
        card_id,
        pre_merge_check: {
          label: "独立安全审核",
          status: "passed",
          note: "R-1 结论通过",
        },
      },
      io,
    );
    state = apply(state, value(passed));
    expect(open(state)).toEqual([]);
    expect(cardOf(state).pre_merge_checks?.[0]).toMatchObject({
      status: "passed",
      note: "R-1 结论通过",
      updated_by: `assignment:${id("assignment", 5)}`,
    });
    expect(value(passed).timeline[0]?.body).toBe(
      `合并前核对「独立安全审核」：待完成 → 已通过（核对版本 ${id("delivery", 1)}@aaaaaaaaaaaa）。备注：R-1 结论通过`,
    );
    expect(value(passed).events[0]?.payload).toMatchObject({
      label: "独立安全审核",
      status: "passed",
      previous_status: "pending",
    });
  });

  it("no agent other than PM Office can mark a check passed or failed", () => {
    let { state, io, ops } = setup();
    state = apply(
      state,
      value(
        updateCard(
          state,
          ops,
          {
            card_id,
            pre_merge_check: { label: "截图核对", status: "pending" },
          },
          io,
        ),
      ),
    );
    const workItemPm = actor(3, "pm");
    for (const who of [ops, workItemPm, actor(1, "coder")])
      for (const status of ["passed", "failed"] as const) {
        const r = updateCard(
          state,
          who,
          { card_id, pre_merge_check: { label: "截图核对", status } },
          io,
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("forbidden_tool");
      }
    // A work-item PM (e.g. PM acceptance) may not even add a pending check.
    const r = updateCard(
      state,
      workItemPm,
      { card_id, pre_merge_check: { label: "另一项", status: "pending" } },
      io,
    );
    expect(r.ok).toBe(false);
    expect(open(state)).toHaveLength(1);
  });

  it("C-160#25: PM Ops cannot withdraw a failed check; PM Office and the human can", () => {
    let { state, io, ops, office } = setup();
    const set = (
      who: Actor,
      label: string,
      status: "pending" | "passed" | "failed",
    ) =>
      updateCard(
        state,
        who,
        { card_id, pre_merge_check: { label, status } },
        io,
      );
    state = apply(state, value(set(office, "截图核对", "failed")));
    state = apply(state, value(set(office, "独立安全审核", "passed")));
    // Ops may not turn "failed" back into "pending".
    const withdraw = set(ops, "截图核对", "pending");
    expect(withdraw.ok).toBe(false);
    if (!withdraw.ok) expect(withdraw.error.code).toBe("forbidden_tool");
    expect(
      cardOf(state).pre_merge_checks?.find((c) => c.label === "截图核对")
        ?.status,
    ).toBe("failed");
    // Ops may still add a pending check and demote a passed one.
    state = apply(state, value(set(ops, "新增项", "pending")));
    state = apply(state, value(set(ops, "独立安全审核", "pending")));
    expect(
      cardOf(state).pre_merge_checks?.find((c) => c.label === "独立安全审核")
        ?.status,
    ).toBe("pending");
    // PM Office and the human may withdraw "failed".
    expect(value(set(office, "截图核对", "pending")).events).toHaveLength(1);
    expect(value(set(human, "截图核对", "passed")).events).toHaveLength(1);
  });

  it("the human may update checks too; unchanged updates write nothing", () => {
    let { state, io, office } = setup();
    const first = updateCard(
      state,
      office,
      { card_id, pre_merge_check: { label: "截图核对", status: "failed" } },
      io,
    );
    state = apply(state, value(first));
    const same = updateCard(
      state,
      office,
      { card_id, pre_merge_check: { label: "截图核对", status: "failed" } },
      io,
    );
    expect(value(same).events).toHaveLength(0);
    const byHuman = updateCard(
      state,
      human,
      { card_id, pre_merge_check: { label: "截图核对", status: "passed" } },
      io,
    );
    expect(value(byHuman).timeline[0]?.author).toBe("human");
  });

  it("validates input and refuses mixing with other card edits", () => {
    const { state, io, office } = setup();
    const bad = [
      { label: " ", status: "pending" },
      { label: "a\nb", status: "pending" },
      { label: "x".repeat(41), status: "pending" },
      { label: "ok", status: "done" },
      { label: "ok", status: "pending", note: "n".repeat(501) },
    ];
    for (const pre_merge_check of bad) {
      const r = updateCard(
        state,
        office,
        { card_id, pre_merge_check: pre_merge_check as never },
        io,
      );
      expect(r.ok).toBe(false);
    }
    const mixed = updateCard(
      state,
      office,
      {
        card_id,
        title: "New",
        pre_merge_check: { label: "截图核对", status: "pending" },
      },
      io,
    );
    expect(mixed.ok).toBe(false);
  });

  it("caps the number of checks and rejects closed cards", () => {
    let { state, io, office } = setup();
    for (let i = 0; i < 8; i++)
      state = apply(
        state,
        value(
          updateCard(
            state,
            office,
            {
              card_id,
              pre_merge_check: { label: `项 ${i}`, status: "pending" },
            },
            io,
          ),
        ),
      );
    expect(
      updateCard(
        state,
        office,
        { card_id, pre_merge_check: { label: "项 9", status: "pending" } },
        io,
      ).ok,
    ).toBe(false);
    const closed = {
      ...state,
      cards: state.cards.map((c) =>
        c.id === card_id ? { ...c, status: "done" as const } : c,
      ),
    };
    expect(
      updateCard(
        closed,
        office,
        { card_id, pre_merge_check: { label: "项 0", status: "passed" } },
        io,
      ).ok,
    ).toBe(false);
  });
  it("a conclusion only holds for the version it was reached on", () => {
    let { state, io, office } = setup();
    state = apply(
      state,
      value(
        updateCard(
          state,
          office,
          {
            card_id,
            pre_merge_check: { label: "独立安全审核", status: "passed" },
          },
          io,
        ),
      ),
    );
    expect(open(state)).toEqual([]);
    expect(cardOf(state).pre_merge_checks?.[0]?.checked_versions).toEqual([
      {
        work_item_id: id("work_item", 1),
        delivery_id: id("delivery", 1),
        subject: "a".repeat(40),
      },
    ]);
    // A new producing delivery (rework) makes the old conclusion stale.
    state = { ...state, deliveries: [...state.deliveries, delivery(2, "b")] };
    expect(open(state)).toMatchObject([
      { label: "独立安全审核", status: "pending", stale: true },
    ]);
    // Re-passing the same status for the new version is a real change.
    const again = value(
      updateCard(
        state,
        office,
        {
          card_id,
          pre_merge_check: { label: "独立安全审核", status: "passed" },
        },
        io,
      ),
    );
    expect(again.events).toHaveLength(1);
    state = apply(state, again);
    expect(open(state)).toEqual([]);
  });

  it("refuses passed/failed before any delivery exists", () => {
    const { state, io, office } = setup();
    const empty = { ...state, deliveries: [] };
    for (const status of ["passed", "failed"] as const)
      expect(
        updateCard(
          empty,
          office,
          { card_id, pre_merge_check: { label: "截图核对", status } },
          io,
        ).ok,
      ).toBe(false);
  });
});

describe("C-160 pre-merge checks across a returned merge", () => {
  it("rework and redelivery reset a passed check to pending", async () => {
    const f = mergeFixture();
    await f.accept();
    f.commit(
      updateCard(
        f.state,
        human,
        {
          card_id: f.card.id,
          pre_merge_check: {
            label: "独立安全审核",
            status: "passed",
            note: "已审核 a 版本",
          },
        },
        f.io,
      ),
    );
    const card = () => f.state.cards.find((c) => c.id === f.card.id) as Card;
    const checks = () =>
      effectivePreMergeChecks(card(), f.state.work_items, f.state.deliveries);
    expect(checks()[0]).toMatchObject({ status: "passed", stale: false });
    const decision = f.state.decisions.at(-1);
    if (!decision) throw new Error("Missing confirmation");
    f.commit(
      recordDecision(
        f.state,
        human,
        {
          decision_id: decision.id,
          option: "request_changes",
          rationale: "Fix it",
          raw_quote: "Fix it",
        },
        f.io,
      ),
    );
    const next = await f.deliver("code", "b".repeat(40));
    f.review(next);
    f.review(await f.deliver("card_completion", next.subject.value));
    expect(card().status).toBe("awaiting_merge");
    expect(checks()[0]).toMatchObject({
      status: "pending",
      stale: true,
      note: "已审核 a 版本",
    });
  });
});
