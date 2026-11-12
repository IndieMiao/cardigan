import { describe, expect, it } from "vitest";
import type { Actor, Assignment, Card } from "../entities.js";
import type { CardId } from "../ids.js";
import { updateCard } from "./pm.js";
import { openPreMergeChecks } from "./pre-merge-checks.js";
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
    expect(openPreMergeChecks(cardOf(state)).map((c) => c.label)).toEqual([
      "独立安全审核",
    ]);
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
    expect(openPreMergeChecks(cardOf(state))).toEqual([]);
    expect(cardOf(state).pre_merge_checks?.[0]).toMatchObject({
      status: "passed",
      note: "R-1 结论通过",
      updated_by: `assignment:${id("assignment", 5)}`,
    });
    expect(value(passed).timeline[0]?.body).toBe(
      "合并前核对「独立安全审核」：待完成 → 已通过。备注：R-1 结论通过",
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
    expect(openPreMergeChecks(cardOf(state))).toHaveLength(1);
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
});
