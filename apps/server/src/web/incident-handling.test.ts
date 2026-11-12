import { type Assignment, type Employee, postComment } from "@cardigan/domain";
import { routeEvent } from "@cardigan/router";
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

test("C-153 / V-504 the PM Office mention in the steps reaches the Office, not PM Ops", () => {
  const f = dispatchFixture();
  try {
    const target = f.create();
    const state = f.state();
    const { work_item_id: _workItem, ...base } = target.assignment;
    const employee: Employee = {
      id: "E-91",
      name: "示例前台",
      title: "前台",
      bio: "",
      avatar: null,
      role_id: "pm",
      launch_profile_ref: null,
      status: "active",
      created_at: state.events[0]?.created_at ?? "2026-01-01T00:00:00.000Z",
      updated_at: state.events[0]?.created_at ?? "2026-01-01T00:00:00.000Z",
    };
    const office: Assignment = {
      ...base,
      id: "A-91",
      scope: "standing",
      role_id: "pm",
      standing_mode: "office",
      employee_id: employee.id,
    };
    const ops: Assignment = { ...office, id: "A-92", standing_mode: "ops" };
    const s = {
      ...state,
      employees: [...(state.employees ?? []), employee],
      assignments: [...state.assignments, office, ops],
    };
    const contact = needsYou(s, "2026-01-01T00:00:00.000Z").incident_handling
      .pm_office;
    // The name is for display; the mention must route.
    expect(contact).toEqual({
      assignment_id: "A-91",
      name: "示例前台",
      mention: "A-91",
    });
    // Same text NeedsYouPage asks the human to post on the card.
    const body = `@${contact?.mention} ${target.assignment.id} 运行异常超过 30 分钟仍未恢复，请处理。`;
    // Not persisted: only the reducer output is routed.
    const result = f.store.uow.run((tx) =>
      postComment(
        s,
        { kind: "human", project_id: f.project },
        { card_id: target.card.id, body },
        { clock: f.clock, ids: tx.ids },
      ),
    );
    if (!result.ok) throw new Error(result.error.message);
    const effect = result.value;
    const event = effect.events.find((e) => e.type === "comment_posted");
    if (!event) throw new Error("Missing comment event");
    const routed = routeEvent({
      event,
      snapshot: {
        ...s,
        events: [...s.events, ...effect.events],
        timeline: [...s.timeline, ...effect.timeline],
      },
    });
    expect(routed.notifications.map((n) => n.recipient)).toContainEqual({
      kind: "assignment",
      assignment_id: "A-91",
    });
    expect(routed.notifications.map((n) => n.recipient)).not.toContainEqual({
      kind: "pm_ops",
    });
  } finally {
    f.close();
  }
});
