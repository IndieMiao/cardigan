import { describe, expect, it } from "vitest";
import type { Actor, Assignment, Delivery, HumanAction } from "../entities.js";
import type { CardId, HumanActionId } from "../ids.js";
import { updateCard } from "./pm.js";
import {
  humanActionLink,
  PRE_MERGE_CHECK_REMINDED,
} from "./pre-merge-checks.js";
import { listNeedsYou } from "./queries.js";
import {
  actor as agent,
  apply,
  assignment,
  fixture,
  human,
  id,
  ports,
  role,
  value,
} from "./test-fixtures.js";

/**
 * C-179 (§7.4): a pre-merge check that newly passes reminds the triage owner
 * of each open merge-blocking human action once, persistently (event +
 * timeline + Needs You), and never completes the action.
 */
const card_id = id("card", 1) as CardId;
type State = ReturnType<typeof fixture>;

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
function action(n: number, overrides: Partial<HumanAction> = {}): HumanAction {
  const hid = id("human_action", n) as HumanActionId;
  return {
    id: hid,
    key: hid,
    card_id,
    requested_by: "assignment:A-1" as HumanAction["requested_by"],
    instructions: "确认截图\n第二行细节",
    why_human: "需要人看",
    expected_return: "结论",
    blocked_work_items: [],
    blocks_merge: true,
    status: "open",
    triage: "pm_ops",
    ...overrides,
  } as HumanAction;
}
function setup(actions: readonly HumanAction[]) {
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
    human_actions: [...actions],
  };
  const as = (a: Assignment): Actor => ({
    kind: "assignment",
    project_id: human.project_id,
    assignment_id: a.id,
    ...role("pm"),
  });
  return { state, io: ports(), ops: as(ops), office: as(office) };
}
function check(
  state: State,
  by: Actor,
  status: "pending" | "passed" | "failed",
  note?: string,
) {
  return value(
    updateCard(
      state,
      by,
      {
        card_id,
        pre_merge_check: {
          label: "张良截图核对",
          status,
          ...(note ? { note } : {}),
        },
      },
      ports(),
    ),
  );
}
const reminders = (r: { events: readonly { type: string }[] }) =>
  r.events.filter((e) => e.type === PRE_MERGE_CHECK_REMINDED);

describe("C-179 pre-merge check passed → remind the triage owner", () => {
  it("records one persisted reminder with the Q-279 text and a direct link; the action stays open", () => {
    const { state, office } = setup([
      action(1),
      action(2, {
        triage: "human",
        handoff: { title: "人工确认截图" } as NonNullable<
          HumanAction["handoff"]
        >,
      }),
    ]);
    const passed = check(state, office, "passed");
    expect(reminders(passed)).toHaveLength(1);
    const h1 = id("human_action", 1) as HumanActionId;
    const h2 = id("human_action", 2) as HumanActionId;
    const link1 = humanActionLink(state.project_id, card_id, h1);
    expect(link1).toBe(
      `#/p/${encodeURIComponent(state.project_id)}/cards/${card_id}?at=human-action-${h1}`,
    );
    expect(reminders(passed)[0]).toMatchObject({
      card_id,
      payload: {
        label: "张良截图核对",
        reminders: [
          {
            human_action_id: h1,
            title: "确认截图",
            recipient: "pm_ops",
            link: link1,
            text: `合并前核对项「张良截图核对」已通过，${h1}「确认截图」仍在挡合并，请确认是否可以完成`,
          },
          {
            human_action_id: h2,
            title: "人工确认截图",
            recipient: "needs_you",
          },
        ],
      },
    });
    const entry = passed.timeline.find((t) => t.body.includes("仍在挡合并"));
    expect(entry?.body.split("\n")[0]).toBe(
      `合并前核对项「张良截图核对」已通过，${h1}「确认截图」仍在挡合并，请确认是否可以完成：${link1}`,
    );
    expect(entry?.refs).toEqual([
      { kind: "human_action", id: h1 },
      { kind: "human_action", id: h2 },
    ]);
    // Only a reminder: no action changes state.
    expect(apply(state, passed).human_actions.map((h) => h.status)).toEqual([
      "open",
      "open",
    ]);
  });

  it("counts actions that block one of the card's work items (C-112 rule)", () => {
    const { state, office } = setup([
      action(1, {
        blocks_merge: false,
        blocked_work_items: [id("work_item", 1)],
      }),
    ]);
    expect(reminders(check(state, office, "passed"))).toHaveLength(1);
  });

  it.each([
    ["no human action", []],
    ["a read-only escalation", [action(1, { blocks_merge: false })]],
    ["a completed action", [action(1, { status: "done" })]],
    [
      "an action on another card",
      [action(1, { card_id: id("card", 2) as CardId })],
    ],
  ] as const)("records nothing when there is %s", (_, actions) => {
    const { state, office } = setup(actions);
    const passed = check(state, office, "passed");
    expect(reminders(passed)).toEqual([]);
    expect(passed.timeline.some((t) => t.body.includes("仍在挡合并"))).toBe(
      false,
    );
  });

  it("pending and failed remind nobody", () => {
    const { state, office, ops } = setup([action(1)]);
    expect(reminders(check(state, ops, "pending"))).toEqual([]);
    expect(reminders(check(state, office, "failed"))).toEqual([]);
  });

  it("the same pass reminds once: a note-only edit, even after a same-SHA redelivery, is not a new pass", () => {
    let { state, office } = setup([action(1)]);
    state = apply(state, check(state, office, "passed"));
    expect(reminders(check(state, office, "passed", "补充备注"))).toEqual([]);
    // Same SHA delivered again (D-2): versions are equal by work item + subject.
    state = {
      ...state,
      deliveries: [
        { ...delivery(1, "a"), status: "superseded" },
        delivery(2, "a"),
      ],
    };
    expect(reminders(check(state, office, "passed", "只补充备注"))).toEqual([]);
  });

  it("a pass on a new version after rework is a new pass and reminds again", () => {
    let { state, office } = setup([action(1)]);
    state = apply(state, check(state, office, "passed"));
    state = {
      ...state,
      deliveries: [
        { ...delivery(1, "a"), status: "superseded" },
        delivery(2, "b"),
      ],
    };
    expect(reminders(check(state, office, "passed"))).toHaveLength(1);
  });

  it("Needs You shows the reminder on the open action to its triage owner", () => {
    let { state, office, ops } = setup([
      action(1),
      action(2, { triage: "human" }),
    ]);
    state = apply(state, check(state, office, "passed"));
    const forHuman = value(listNeedsYou(state, human)).data;
    const h2 = forHuman.human_actions.find(
      (h) => h.id === id("human_action", 2),
    );
    expect(h2?.pre_merge_check_reminder).toMatchObject({
      label: "张良截图核对",
      text: expect.stringContaining("仍在挡合并"),
      link: humanActionLink(
        state.project_id,
        card_id,
        id("human_action", 2) as HumanActionId,
      ),
    });
    const forOps = value(listNeedsYou(state, ops)).data;
    expect(
      forOps.pm_queue?.human_actions.find((h) => h.id === id("human_action", 1))
        ?.pre_merge_check_reminder?.label,
    ).toBe("张良截图核对");
    // Once completed, the reminder disappears with the action.
    state = {
      ...state,
      human_actions: state.human_actions.map((h) => ({
        ...h,
        status: "done" as const,
      })),
    };
    expect(
      value(listNeedsYou(state, human)).data.human_actions.some(
        (h) => h.pre_merge_check_reminder,
      ),
    ).toBe(false);
  });

  it("only a standing PM or the human can pass a check, so an agent cannot trigger reminders", () => {
    const { state } = setup([action(1)]);
    const denied = updateCard(
      state,
      agent(),
      { card_id, pre_merge_check: { label: "x", status: "passed" } },
      ports(),
    );
    expect(denied.ok).toBe(false);
  });
});
