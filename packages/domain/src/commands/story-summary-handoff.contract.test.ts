import { expect, test } from "vitest";
import type { Assignment, Card } from "../entities.js";
import { postComment } from "./coordination.js";
import type { CommandPorts, CommandState } from "./core.js";
import { notices } from "./notices.js";
import { createCard } from "./pm.js";
import {
  DEFAULT_STORY_SUMMARY_HANDOFF_MS,
  maintainStorySummaries,
  STORY_SUMMARY_ESCALATED,
  STORY_SUMMARY_HANDED_OFF,
} from "./story-summary-handoff.js";
import { markCardDone } from "./templates.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  now,
  ports,
  value,
} from "./test-fixtures.js";

const system = { kind: "system" as const, project_id: human.project_id };
const HOUR = 3_600_000;

/** A-4 is the Office (external or not); A-5 is PM Ops. */
function setup(external: boolean) {
  const base = fixture();
  const office = base.assignments.find((a) => a.scope === "standing");
  if (!office) throw new Error("missing standing fixture");
  const ops: Assignment = {
    ...office,
    id: id("assignment", 5),
    standing_mode: "ops",
  } as Assignment;
  let state: CommandState = {
    ...base,
    assignments: [
      ...base.assignments.filter((a) => a !== office),
      { ...office, standing_mode: "office", external } as Assignment,
      ops,
    ],
  };
  let t = Date.parse(now);
  const shared = ports();
  const p: CommandPorts = {
    ...shared,
    clock: { now: () => new Date(t).toISOString() },
  };
  const create = (template_id: string, parent_card_id?: Card["id"]) => {
    const x = value(
      createCard(
        state,
        human,
        {
          template_id,
          title: template_id === "story" ? "Story" : "Child",
          goal: "Need",
          source: { kind: "quote", text: "Need" },
          ...(parent_card_id ? { parent_card_id } : {}),
        },
        p,
      ),
    );
    state = apply(state, x);
    return x.data;
  };
  const parent = create("story");
  const child = create("general", parent.id);
  const settle = () =>
    (state = apply(
      state,
      value(
        markCardDone(state, human, { card_id: child.id, result: "Shipped" }, p),
      ),
    ));
  const tick = (ms = DEFAULT_STORY_SUMMARY_HANDOFF_MS) => {
    const x = value(maintainStorySummaries(state, system, p, ms));
    state = apply(state, x);
    return x.events;
  };
  const summary = (n: 4 | 5) =>
    postComment(
      state,
      actor(n, "pm"),
      { card_id: parent.id, body: "Compared", story_summary: true },
      p,
    );
  return {
    p,
    parent,
    child,
    settle,
    tick,
    summary,
    advance: (ms: number) => {
      t += ms;
    },
    get state() {
      return state;
    },
    set state(next: CommandState) {
      state = next;
    },
  };
}

const types = (events: readonly { type: string }[]) =>
  events.map((e) => e.type);
const story = (f: ReturnType<typeof setup>) =>
  f.state.cards.find((c) => c.id === f.parent.id);

test("external Office: a settled story raises one Needs You notice; non-external Office is left alone", () => {
  const external = setup(true);
  external.settle();
  const [raised, ...rest] = external.tick();
  expect(rest).toEqual([]);
  expect(raised).toMatchObject({
    type: STORY_SUMMARY_ESCALATED,
    card_id: external.parent.id,
    actor: { kind: "system" },
    payload: {
      office_assignment_id: id("assignment", 4),
      handoff_after_ms: DEFAULT_STORY_SUMMARY_HANDOFF_MS,
    },
  });
  expect(
    notices(external.state).filter((n) => n.id === raised?.id),
  ).toMatchObject([{ card_id: external.parent.id, option: "需求总结待提交" }]);
  // Repeated ticks never raise it twice.
  expect(external.tick()).toEqual([]);

  const resident = setup(false);
  resident.settle();
  expect(resident.tick()).toEqual([]);
  resident.advance(10 * DEFAULT_STORY_SUMMARY_HANDOFF_MS);
  expect(resident.tick()).toEqual([]);
  expect(notices(resident.state)).toEqual([]);
});

test("nothing is raised before every child ended", () => {
  const f = setup(true);
  expect(f.tick()).toEqual([]);
  f.advance(DEFAULT_STORY_SUMMARY_HANDOFF_MS);
  expect(f.tick()).toEqual([]);
});

test("handoff to PM Ops happens exactly at the threshold, once, with children and conclusions", () => {
  const f = setup(true);
  f.settle();
  f.tick(4 * HOUR);
  f.advance(4 * HOUR - 1);
  expect(f.tick(4 * HOUR)).toEqual([]);
  f.advance(1);
  const handed = f.tick(4 * HOUR);
  expect(handed).toMatchObject([
    {
      type: STORY_SUMMARY_HANDED_OFF,
      card_id: f.parent.id,
      payload: {
        handoff_after_ms: 4 * HOUR,
        children: [
          {
            card_id: f.child.id,
            title: "Child",
            status: "done",
            conclusion: "已完成",
          },
        ],
      },
    },
  ]);
  const notice = (handed[0]?.payload as { notice?: string } | undefined)
    ?.notice;
  expect(notice).toContain(`${f.child.id}「Child」：已完成`);
  f.advance(DEFAULT_STORY_SUMMARY_HANDOFF_MS);
  expect(f.tick(4 * HOUR)).toEqual([]);
  // The handoff replaces the first notice in Needs You.
  expect(notices(f.state).map((n) => n.option)).toEqual([
    "需求总结已转交 PM Ops",
  ]);
});

test("an Office summary before the threshold cancels the handoff and clears the notice", () => {
  const f = setup(true);
  f.settle();
  f.tick();
  f.advance(DEFAULT_STORY_SUMMARY_HANDOFF_MS - 1);
  f.state = apply(f.state, value(f.summary(4)));
  f.advance(1);
  expect(f.tick()).toEqual([]);
  expect(notices(f.state)).toEqual([]);
  expect(
    types(f.state.events).filter((t) => t === STORY_SUMMARY_HANDED_OFF),
  ).toEqual([]);
});

test("PM Ops may draft only after the handoff, and its summary never completes the story", () => {
  const f = setup(true);
  f.settle();
  f.tick();
  expect(f.summary(5).ok).toBe(false);
  f.advance(DEFAULT_STORY_SUMMARY_HANDOFF_MS);
  f.tick();
  const drafted = value(f.summary(5));
  f.state = apply(f.state, drafted);
  expect(types(drafted.events)).toContain("story_summary_submitted");
  expect(story(f)).toMatchObject({
    status: "review",
    story: { summary_entry_id: expect.any(String) },
  });
  expect(f.tick()).toEqual([]);
  expect(notices(f.state)).toEqual([]);
  // Still only the human closes it.
  expect(
    markCardDone(
      f.state,
      actor(5, "pm"),
      { card_id: f.parent.id, result: "x" },
      f.p,
    ).ok,
  ).toBe(false);
  expect(story(f)?.status).toBe("review");
});

test("a non-external Office keeps PM Ops out of the summary", () => {
  const f = setup(false);
  f.settle();
  f.advance(10 * DEFAULT_STORY_SUMMARY_HANDOFF_MS);
  f.tick();
  expect(f.summary(5).ok).toBe(false);
  expect(f.summary(4).ok).toBe(true);
});

test("a later child starts a new episode; the old handoff does not authorize PM Ops", () => {
  const f = setup(true);
  f.settle();
  f.tick();
  f.advance(DEFAULT_STORY_SUMMARY_HANDOFF_MS);
  f.tick();
  expect(f.summary(5).ok).toBe(true);
  const extra = value(
    createCard(
      f.state,
      human,
      {
        template_id: "general",
        title: "Extra",
        goal: "x",
        source: { kind: "quote", text: "x" },
        parent_card_id: f.parent.id,
      },
      f.p,
    ),
  );
  f.state = apply(f.state, extra);
  f.state = apply(
    f.state,
    value(
      markCardDone(
        f.state,
        human,
        { card_id: extra.data.id, result: "ok" },
        f.p,
      ),
    ),
  );
  expect(f.summary(5).ok).toBe(false);
  expect(types(f.tick())).toEqual([STORY_SUMMARY_ESCALATED]);
});

test("a closed story is never raised or handed off", () => {
  const f = setup(true);
  f.settle();
  f.tick();
  f.state = apply(
    f.state,
    value(
      markCardDone(
        f.state,
        human,
        { card_id: f.parent.id, result: "Closed early" },
        f.p,
      ),
    ),
  );
  f.advance(DEFAULT_STORY_SUMMARY_HANDOFF_MS);
  expect(f.tick()).toEqual([]);
  expect(notices(f.state)).toEqual([]);
});

test("another project's external Office never counts for this project", () => {
  const f = setup(false);
  f.settle();
  // Command state is per project; an Office row from elsewhere is not on duty here.
  const elsewhere = {
    ...f.state,
    assignments: f.state.assignments.filter(
      (a) => !(a.scope === "standing" && a.standing_mode === "office"),
    ),
  };
  expect(
    value(maintainStorySummaries(elsewhere, system, ports())).events,
  ).toEqual([]);
});
