// C-742: actions for the host operator (张良) never ring the owner's Needs You;
// handing one back to the owner rings them as an ordinary action.
import type { HumanAction } from "@cardigan/domain";
import { expect, test } from "vitest";
import { event, humanAction, snapshot } from "./fixtures.js";
import { routeEvent } from "./route.js";

const action = (overrides: Partial<HumanAction> = {}): HumanAction => ({
  ...humanAction(),
  status: "open",
  triage: "human",
  blocked_work_items: [],
  ...overrides,
});
const notes = (type: string, h: HumanAction) =>
  routeEvent({
    event: event(type, { human_action_id: h.id }),
    snapshot: snapshot({ human_actions: [h] }),
  }).notifications;

test("an operator action rings PM Office only, whether requested or released", () => {
  const h = action({ executor: "operator" });
  for (const type of ["human_action_requested", "human_action_reassigned"]) {
    const routed = notes(type, h);
    expect(routed.map((n) => n.recipient.kind)).toEqual(
      type === "human_action_requested" ? ["pm_office"] : [],
    );
  }
  expect(notes("human_action_requested", h)[0]?.summary).toContain(
    "等张良执行",
  );
  // Even after PM triage to host, the operator executor wins.
  expect(
    notes("human_action_requested", {
      ...h,
      triage: "host",
      host_operator: "host_ops",
    }).map((n) => n.recipient.kind),
  ).toEqual(["pm_office"]);
});

test("taking an action back rings the owner; closed or PM-triage actions stay quiet", () => {
  expect(
    notes("human_action_reassigned", action()).map((n) => [
      n.recipient.kind,
      n.rule,
    ]),
  ).toEqual([
    ["needs_you", "6.4/human action requested"],
    ["pm_office", "6.4/human action requested"],
  ]);
  for (const h of [action({ status: "done" }), action({ triage: "pm_ops" })])
    expect(notes("human_action_reassigned", h)).toEqual([]);
});
