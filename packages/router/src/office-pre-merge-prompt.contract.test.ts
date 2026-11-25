import {
  type Assignment,
  officePreMergePromptText,
  PRE_MERGE_CHECK_OFFICE_PROMPTED,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  assignment,
  card,
  delivery,
  event,
  project_id,
  snapshot,
} from "./fixtures.js";
import { routeEvent } from "./route.js";
import type { RouterSnapshot } from "./types.js";

/**
 * C-744: a pre-merge prompt rings only the PM Office on duty, with the card,
 * delivery ID and SHA and the labels still waiting. Nobody else is told.
 */
const SHA = "a".repeat(40);
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
const versions = [{ work_item_id: "W-1", delivery_id: "D-1", subject: SHA }];
const pending = (label: string, status = "pending") => ({
  label,
  status,
  ...(status === "pending" ? {} : { checked_versions: versions }),
  updated_by: "human",
  updated_at: "2026-01-01T00:00:00.000Z",
});

const prompt = (
  moment = "accepted",
  checks = ["合并边界确认"],
  actor: "system" | "human" = "system",
) =>
  event(
    PRE_MERGE_CHECK_OFFICE_PROMPTED,
    { card_id: "C-1", moment, versions, checks, text: "x" },
    { actor: { kind: actor, project_id } as never },
  );

const world = (
  fields: {
    checks?: readonly unknown[];
    staff?: readonly Assignment[];
    status?: string;
    deliveries?: RouterSnapshot["deliveries"];
  } = {},
): RouterSnapshot => {
  const base = snapshot();
  return {
    ...base,
    cards: [
      card({
        status: fields.status ?? "awaiting_merge",
        pre_merge_checks: fields.checks ?? [pending("合并边界确认")],
      }),
    ],
    deliveries: fields.deliveries ?? [
      delivery("D-1", { status: "accepted", subject: { value: SHA } }),
    ],
    assignments: [...base.assignments, ops, ...(fields.staff ?? [office])],
  };
};

test.each(["accepted", "merge_check_passed"])(
  "%s: one PM Office bell with card, delivery, SHA and label",
  (moment) => {
    const notes = routeEvent({
      event: prompt(moment),
      snapshot: world(),
    }).notifications;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      recipient: { kind: "pm_office" },
      kind: "card",
      rule: "C-744/office pre-merge checks",
      card_id: "C-1",
    });
    for (const part of [
      "C-1",
      "D-1",
      SHA,
      "「合并边界确认」",
      "pre_merge_check",
    ])
      expect(notes[0]?.summary).toContain(part);
    expect(notes[0]?.summary).toBe(
      officePreMergePromptText(
        "C-1" as never,
        moment as never,
        ["合并边界确认"],
        versions,
      ),
    );
  },
);

test("labels recorded before routing are dropped; all recorded rings nobody", () => {
  const both = prompt("accepted", ["合并边界确认", "发布说明"]);
  const one = routeEvent({
    event: both,
    snapshot: world({
      checks: [pending("合并边界确认"), pending("发布说明", "passed")],
    }),
  }).notifications;
  expect(one).toHaveLength(1);
  expect(one[0]?.summary).toContain("「合并边界确认」");
  expect(one[0]?.summary).not.toContain("发布说明");
  for (const status of ["passed", "failed"])
    expect(
      routeEvent({
        event: prompt(),
        snapshot: world({ checks: [pending("合并边界确认", status)] }),
      }).notifications,
    ).toEqual([]);
});

test("a replaced delivery, a closed card, no Office on duty or a non-system event ring nobody", () => {
  const silent = [
    world({
      deliveries: [
        delivery("D-1", { status: "superseded", subject: { value: SHA } }),
        delivery("D-2", { status: "submitted", subject: { value: SHA } }),
      ],
    }),
    world({ status: "done" }),
    world({ status: "cancelled" }),
    world({ staff: [] }),
    world({ staff: [{ ...office, status: "suspended" } as Assignment] }),
  ];
  for (const s of silent)
    expect(routeEvent({ event: prompt(), snapshot: s }).notifications).toEqual(
      [],
    );
  expect(
    routeEvent({
      event: prompt("accepted", ["合并边界确认"], "human"),
      snapshot: world(),
    }).notifications,
  ).toEqual([]);
  expect(
    routeEvent({ event: prompt("other"), snapshot: world() }).notifications,
  ).toEqual([]);
});
