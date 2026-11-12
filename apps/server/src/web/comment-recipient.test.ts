import type { Assignment } from "@cardigan/domain";
import { expect, test } from "vitest";
import { dispatchFixture } from "../../test-support/dispatch.js";
import { cardDetail } from "./read.js";

test("C-90 card details report only active standing PM Ops as the default comment recipient", () => {
  const f = dispatchFixture();
  try {
    const target = f.create();
    const state = f.state();
    const { work_item_id: _workItem, ...base } = target.assignment;
    const ops: Assignment = {
      ...base,
      scope: "standing",
      role_id: "pm",
      standing_mode: "ops",
    };
    const cases: { assignments: Assignment[]; available: boolean }[] = [
      { assignments: [], available: false },
      {
        assignments: [{ ...target.assignment, role_id: "pm" }],
        available: false,
      },
      { assignments: [{ ...ops, standing_mode: "office" }], available: false },
      { assignments: [{ ...ops, status: "suspended" }], available: false },
      { assignments: [{ ...ops, status: "released" }], available: false },
      { assignments: [{ ...ops, role_id: "host_ops" }], available: false },
      { assignments: [ops], available: true },
      { assignments: [{ ...ops, runtime_state: "running" }], available: true },
      { assignments: [{ ...ops, external: true }], available: true },
    ];
    for (const { assignments, available } of cases) {
      expect(
        cardDetail({ ...state, assignments }, target.card.id)?.has_pm_ops,
        JSON.stringify(assignments),
      ).toBe(available);
    }
  } finally {
    f.close();
  }
});
