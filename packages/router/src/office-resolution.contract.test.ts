import {
  type Assignment,
  DECISION_OTHER_OPTION,
  type Decision,
  type Event,
} from "@cardigan/domain";
import { describe, expect, test } from "vitest";
import {
  agent,
  assignment,
  decision,
  entry,
  event,
  snapshot,
} from "./fixtures.js";
import { routeEvent } from "./route.js";
import type { RoutedNotification, RouterSnapshot } from "./types.js";

/**
 * C-740: when the human closes a Needs You question, the project's PM Office
 * on duty is rung at once with the answer. Every other recipient is exactly
 * what the same event routes without an Office.
 */
const OFFICE = "A-10";
const OPS = "A-11";
const office = (fields: Record<string, unknown> = {}): Assignment =>
  assignment(OFFICE, {
    scope: "standing",
    role_id: "pm",
    standing_mode: "office",
    ...fields,
  });
const ops = assignment(OPS, {
  scope: "standing",
  role_id: "pm",
  standing_mode: "ops",
});

const OPTIONS = [
  { key: "a", description: "Shape A", impact: "keeps the old layout" },
  { key: "b", description: "Shape B", impact: "moves the column" },
];

const closed = (
  fields: Record<string, unknown> = {},
  resolution: Record<string, unknown> = {},
): Decision =>
  decision({
    raised_by: "assignment:A-1",
    status: "resolved",
    options: OPTIONS,
    resolution: {
      option: "a",
      rationale: "",
      resolved_by: "human",
      via: "needs_you",
      raw_quote: "选 a",
      via_chain: ["human"],
      at: "2026-11-25T05:00:47.000Z",
      ...resolution,
    },
    ...fields,
  } as never);

const resolved = (
  type = "decision_resolved",
  actor?: Parameters<typeof event>[2]["actor"],
): Event =>
  event(
    type,
    { decision_id: "Q-1", via: "needs_you", resume_work_items: [] },
    actor ? { actor } : {},
  );

const world = (
  q: Decision,
  staff: readonly Assignment[],
  extra: Partial<RouterSnapshot> = {},
): RouterSnapshot => {
  const base = snapshot({ decisions: [q], ...extra } as never);
  return { ...base, assignments: [...base.assignments, ops, ...staff] };
};

const offices = (notes: readonly RoutedNotification[]) =>
  notes.filter((n) => n.recipient.kind === "pm_office");
const others = (notes: readonly RoutedNotification[]) =>
  notes.filter((n) => n.recipient.kind !== "pm_office");

function route(q: Decision, e: Event, extra: Partial<RouterSnapshot> = {}) {
  return {
    before: routeEvent({ event: e, snapshot: world(q, [], extra) }),
    after: routeEvent({ event: e, snapshot: world(q, [office()], extra) }),
  };
}

describe("C-740 Office hears about questions the human closed", () => {
  test.each([
    ["decided by the human", closed()],
    [
      "marked human-only",
      closed({ decider: "role:pm", human_required_reason: "x" }),
    ],
    [
      "taken over from PM",
      closed({ decider: "role:pm" }, { taken_over_from: "role:pm" }),
    ],
  ])(
    "a Needs You question %s rings the Office once with the answer",
    (_, q) => {
      const { before, after } = route(q, resolved());
      expect(offices(before.notifications)).toEqual([]);
      const [note, ...rest] = offices(after.notifications);
      expect(rest).toEqual([]);
      expect(note).toMatchObject({
        recipient: { kind: "pm_office" },
        kind: "decision",
        rule: "C-740/office decision closed",
        card_id: "C-1",
      });
      expect(note?.summary).toContain("Q-1 已由人结案");
      expect(note?.summary).toContain("选择 a：Shape A");
      expect(note?.summary).toContain("影响：keeps the old layout");
      expect(note?.summary).toContain("选项：a、b");
      // Nobody else hears more or less than before.
      expect(others(after.notifications)).toEqual(others(before.notifications));
      expect(after.problems).toEqual(before.problems);
      expect(after.checks).toEqual(before.checks);
    },
  );

  test("the raiser still gets its own result", () => {
    const { after } = route(closed(), resolved());
    expect(
      after.notifications.some(
        (n) =>
          n.recipient.kind === "assignment" &&
          n.recipient.assignment_id === "A-1" &&
          n.rule === "6.4/decision resolved",
      ),
    ).toBe(true);
  });

  test("a provisional resolution by the human also rings the Office", () => {
    const q = closed({ status: "provisional" });
    const { after } = route(q, resolved("decision_provisionally_resolved"));
    expect(offices(after.notifications)).toHaveLength(1);
  });

  test("the owner's own words are passed on for “其他”", () => {
    const q = closed(
      {},
      { option: DECISION_OTHER_OPTION, raw_quote: "都不要，先放着" },
    );
    const { after } = route(q, resolved());
    const [note] = offices(after.notifications);
    expect(note?.summary).toContain("选择“其他”，原话：都不要，先放着");
  });

  test("a PM question counts once the Office raised, suggested or cited it", () => {
    const pmQuestion = (fields: Record<string, unknown> = {}) =>
      closed({ decider: "role:pm", ...fields });
    // Not listed in Needs You and never touched by the Office: silent.
    expect(
      offices(route(pmQuestion(), resolved()).after.notifications),
    ).toEqual([]);
    for (const [q, extra] of [
      [
        pmQuestion({
          suggestion: {
            option: "a",
            rationale: "r",
            by: `assignment:${OFFICE}`,
          },
        }),
        {},
      ],
      [
        pmQuestion(),
        {
          timeline: [
            entry(5, {
              author: `assignment:${OFFICE}`,
              refs: [{ kind: "decision", id: "Q-1" }],
              retracted: false,
            }),
          ],
        },
      ],
    ] as const) {
      const { before, after } = route(q, resolved(), extra);
      expect(offices(after.notifications)).toHaveLength(1);
      expect(others(after.notifications)).toEqual(others(before.notifications));
    }
    // A retracted Office comment does not count.
    expect(
      offices(
        route(pmQuestion(), resolved(), {
          timeline: [
            entry(5, {
              author: `assignment:${OFFICE}`,
              refs: [{ kind: "decision", id: "Q-1" }],
              retracted: true,
            }),
          ],
        }).after.notifications,
      ),
    ).toEqual([]);
  });

  test("an Office that raised the question is told once, as the raiser", () => {
    const q = closed({ raised_by: `assignment:${OFFICE}` });
    const after = routeEvent({
      event: resolved(),
      snapshot: world(q, [office()]),
    });
    const toOffice = after.notifications.filter(
      (n) =>
        n.recipient.kind === "pm_office" ||
        n.recipient.assignment_id === OFFICE,
    );
    expect(toOffice).toHaveLength(1);
    expect(toOffice[0]?.rule).toBe("6.4/decision resolved");
  });

  test("delegated, Office-chat and system resolutions do not ring the Office", () => {
    for (const [via, actor] of [
      ["delegated", agent(OPS)],
      ["pm_office_chat", agent(OFFICE)],
      ["system_rule", { kind: "system", project_id: "p-1" }],
    ] as const) {
      const q = closed({}, { via });
      const { before, after } = route(
        q,
        resolved("decision_resolved", actor as never),
      );
      expect(offices(after.notifications)).toEqual(
        offices(before.notifications),
      );
    }
  });

  test.each([
    ["suspended", { status: "suspended" }],
    ["released", { status: "released" }],
    ["not standing_mode=office", { standing_mode: undefined }],
  ])("an Office that is %s is skipped without error", (_, fields) => {
    const q = closed();
    const before = routeEvent({ event: resolved(), snapshot: world(q, []) });
    const after = routeEvent({
      event: resolved(),
      snapshot: world(q, [office(fields)]),
    });
    expect(after).toEqual(before);
  });

  test("another project's resolution does not reach this project's Office", () => {
    const foreign = resolved("decision_resolved", {
      kind: "human",
      project_id: "p-other",
    } as never);
    const routed = routeEvent({
      event: foreign,
      snapshot: world(closed(), [office()]),
    });
    expect(offices(routed.notifications)).toEqual([]);
  });

  test("other resolution events and other roles are unchanged", () => {
    for (const type of ["decision_implementation_recorded", "card_merged"]) {
      const { before, after } = route(closed(), resolved(type));
      expect(offices(after.notifications)).toEqual(
        offices(before.notifications),
      );
      expect(others(after.notifications)).toEqual(others(before.notifications));
    }
  });
});
