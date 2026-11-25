import type { Assignment } from "@cardigan/domain";
import { describe, expect, test } from "vitest";
import {
  agent,
  assignment,
  card,
  entry,
  event,
  human,
  snapshot,
} from "./fixtures.js";
import { summarizeNotifications } from "./merge.js";
import { routeEvent } from "./route.js";
import type { RouterSnapshot } from "./types.js";

/**
 * C-748: what the owner does to a story proposal reaches the PM Office.
 *
 * - Confirm (one-click, card page or Needs You): Office is rung with the
 *   version and the children opened; PM Ops gets an FYI.
 * - Change request or checklist answer that @mentions someone: the Office
 *   still hears it (without mentions it already did, with an Ops FYI).
 * - Cancelling the story card: the Office is rung.
 *
 * Nobody else gains or loses a notification.
 */
const office = assignment("A-10", {
  scope: "standing",
  role_id: "pm",
  standing_mode: "office",
});
const ops = assignment("A-11", {
  scope: "standing",
  role_id: "pm",
  standing_mode: "ops",
});
const PROPOSAL = "C-1#25";
const GROUP = "C-1#4";
const story = (extra: Record<string, unknown> = {}) =>
  card({
    template: "story",
    status: "in_progress",
    story: {
      proposals: [
        {
          version: 4,
          entry_id: PROPOSAL,
          submitted_at: "2026-01-01T00:00:00.000Z",
          children: [],
        },
      ],
      question_groups: [
        {
          id: GROUP,
          questions: [
            {
              question: "Which?",
              recommended: "A",
              impact: "i",
              resolution: {
                source: "answer",
                value: "B",
                entry_id: "C-1#30",
              },
            },
          ],
        },
      ],
    },
    ...extra,
  });
const world = (overrides: Partial<RouterSnapshot> = {}) => {
  const base = snapshot({ cards: [story()], ...overrides } as never);
  return {
    ...base,
    assignments: [...base.assignments, office, ops] as Assignment[],
  };
};
const confirmed = (actor = human()) =>
  event(
    "story_proposal_confirmed",
    { version: 4, card_ids: ["C-155", "C-156"] },
    { seq: 28, actor },
  );
const recipients = (s: RouterSnapshot, e: ReturnType<typeof event>) =>
  routeEvent({ event: e, snapshot: s }).notifications.map((n) => [
    n.recipient,
    n.kind,
  ]);

describe("C-748 the owner confirms a story proposal", () => {
  test("Office is rung with the version and children; Ops gets an FYI; nobody else", () => {
    const result = routeEvent({ event: confirmed(), snapshot: world() });
    expect(result.notifications).toMatchObject([
      {
        recipient: { kind: "pm_office" },
        kind: "card",
        rule: "story/proposal confirmed",
        card_id: "C-1",
        seq: 28,
      },
      {
        recipient: { kind: "pm_ops" },
        kind: "story_fyi",
        rule: "story/proposal confirmed",
      },
    ]);
    const [toOffice, toOps] = result.notifications;
    for (const text of ["第 4 版", "C-155、C-156", "2 张子卡"]) {
      expect(toOffice?.summary).toContain(text);
      expect(toOps?.summary).toContain(text);
    }
    expect(toOffice?.summary).toContain("勿再催");
    expect(toOps?.summary).toMatch(/^知会：/u);
    expect(summarizeNotifications(result.notifications)).toBe(
      "1 card, 1 story FYI",
    );
    expect(result.problems).toEqual([]);
  });

  test("routing the same confirmation again gives the same single pair", () => {
    const s = world();
    const once = routeEvent({ event: confirmed(), snapshot: s });
    const twice = routeEvent({ event: confirmed(), snapshot: s });
    expect(twice).toEqual(once);
    expect(
      once.notifications.filter((n) => n.recipient.kind === "pm_office"),
    ).toHaveLength(1);
  });

  test("only the human's confirmation on a story card counts", () => {
    expect(recipients(world(), confirmed(agent("A-1")))).toEqual([]);
    expect(
      recipients(
        world(),
        confirmed({ kind: "system", project_id: "p-routing" } as never),
      ),
    ).toEqual([]);
    expect(recipients(world({ cards: [card()] }), confirmed())).toEqual([]);
  });

  test("work-item assignees on the card hear nothing", () => {
    const notes = routeEvent({
      event: confirmed(),
      snapshot: world(),
    }).notifications;
    expect(notes.some((n) => n.recipient.kind === "assignment")).toBe(false);
    expect(notes.some((n) => n.recipient.kind === "needs_you")).toBe(false);
  });
});

describe("C-748 the owner replies to the story discussion", () => {
  const comment = (fields: Record<string, unknown>, actor = human()) => ({
    e: event("comment_posted", {}, { seq: 30, actor }),
    s: world({
      timeline: [entry(30, { id: "C-1#30", mentions: [], ...fields })],
    }),
  });

  test("a change request without mentions keeps Office plus the Ops FYI", () => {
    const { e, s } = comment({ id: "C-1#31", reply_to: PROPOSAL });
    expect(recipients(s, e)).toEqual([
      [{ kind: "pm_office" }, "comment"],
      [{ kind: "pm_ops" }, "story_fyi"],
    ]);
  });

  test.each([
    ["a change request on the proposal", { id: "C-1#31", reply_to: PROPOSAL }],
    ["a reply to the question checklist", { id: "C-1#31", reply_to: GROUP }],
    ["a bound checklist answer", { id: "C-1#30" }],
  ])("%s that @mentions someone still reaches the Office", (_, fields) => {
    const { e, s } = comment({ ...fields, mentions: ["@A-1"] });
    const routed = routeEvent({ event: e, snapshot: s }).notifications;
    expect(routed.map((n) => [n.recipient, n.kind, n.rule])).toEqual([
      [
        { kind: "assignment", assignment_id: "A-1" },
        "comment",
        expect.any(String),
      ],
      [{ kind: "pm_office" }, "comment", "story/discuss"],
    ]);
  });

  test("an ordinary mention on the story card keeps its single route", () => {
    const { e, s } = comment({ id: "C-1#31", mentions: ["@A-1"] });
    expect(recipients(s, e)).toEqual([
      [{ kind: "assignment", assignment_id: "A-1" }, "comment"],
    ]);
  });

  test("mentioning the Office itself rings it once", () => {
    const { e, s } = comment({
      id: "C-1#31",
      reply_to: PROPOSAL,
      mentions: ["@A-10"],
    });
    expect(recipients(s, e)).toEqual([
      [{ kind: "assignment", assignment_id: "A-10" }, "comment"],
    ]);
  });

  test("an agent's reply with mentions is not the owner's", () => {
    const { e, s } = comment(
      { id: "C-1#31", reply_to: PROPOSAL, mentions: ["@A-2"] },
      agent("A-1"),
    );
    expect(recipients(s, e)).toEqual([
      [{ kind: "assignment", assignment_id: "A-2" }, "comment"],
    ]);
  });
});

describe("C-748 the owner cancels the story card", () => {
  const cancelled = (actor = human(), seq = 40) =>
    event(
      "card_updated",
      { card_id: "C-1", status: "cancelled" },
      { seq, actor },
    );
  const previous = (status: string) =>
    event("card_updated", { card_id: "C-1", status }, { seq: 39 });

  test("rings the Office once; nobody else", () => {
    const result = routeEvent({
      event: cancelled(),
      snapshot: world({
        cards: [story({ status: "cancelled" })],
        events: [previous("in_progress")],
      }),
    });
    expect(result.notifications).toMatchObject([
      {
        recipient: { kind: "pm_office" },
        kind: "card",
        rule: "story/cancelled",
      },
    ]);
    expect(result.notifications[0]?.summary).toContain("勿再催");
  });

  test("an already cancelled story, a plain card or a child is silent", () => {
    expect(
      recipients(
        world({
          cards: [story({ status: "cancelled" })],
          events: [previous("cancelled")],
        }),
        cancelled(),
      ),
    ).toEqual([]);
    expect(
      recipients(
        world({
          cards: [card({ status: "cancelled", parent_card_id: "C-9" })],
        }),
        cancelled(),
      ),
    ).toEqual([]);
  });
});
