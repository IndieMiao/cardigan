import type { Assignment } from "@cardigan/domain";
import { expect, test } from "vitest";
import { dispatchFixture } from "../../test-support/dispatch.js";
import { needsYou } from "./read.js";

test("C-153 Needs You says who looks after lost runtimes and how often host_ops patrols", () => {
  const f = dispatchFixture();
  try {
    const target = f.create();
    const state = f.state();
    const now = "2026-01-01T00:00:00.000Z";
    const { work_item_id: _workItem, ...base } = target.assignment;
    const standing = (id: string, extra: Partial<Assignment>): Assignment => ({
      ...base,
      id,
      scope: "standing",
      ...extra,
    });
    const hostOps = standing("A-90", { role_id: "host_ops" });
    const office = standing("A-91", { role_id: "pm", standing_mode: "office" });
    const ops = standing("A-92", { role_id: "pm", standing_mode: "ops" });

    expect(
      needsYou({ ...state, assignments: [] }, now).incident_handling,
    ).toEqual({ host_ops: null, pm_office: null, hc_session: null });

    // Without an employee the Assignment id is what a comment mentions.
    expect(
      needsYou(
        { ...state, assignments: [hostOps, office, ops] },
        now,
        "disabled",
        10 * 60_000,
        "prod-hc",
      ).incident_handling,
    ).toEqual({
      host_ops: {
        assignment_id: "A-90",
        name: null,
        mention: "A-90",
        patrol_interval_ms: 10 * 60_000,
      },
      pm_office: { assignment_id: "A-91", name: null, mention: "A-91" },
      hc_session: "prod-hc",
    });

    // Default cadence is the 30-minute patrol; inactive standings do not count.
    expect(
      needsYou(
        {
          ...state,
          assignments: [hostOps, { ...office, status: "suspended" }, ops],
        },
        now,
      ).incident_handling,
    ).toMatchObject({
      host_ops: { patrol_interval_ms: 30 * 60_000 },
      pm_office: null,
    });
  } finally {
    f.close();
  }
});
