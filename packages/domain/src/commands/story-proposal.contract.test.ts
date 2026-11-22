import { expect, test } from "vitest";
import type { Actor, Card } from "../entities.js";
import type { Result } from "../errors.js";
import {
  STORY_PROPOSAL_MAX_CHILDREN,
  type StoryProposalChildInput,
} from "../story-discussion.js";
import { postComment } from "./coordination.js";
import type { CommandEffect, CommandPorts, CommandState } from "./core.js";
import { createCard, updateCard } from "./pm.js";
import { listNeedsYou, listNeedsYouCounts } from "./queries.js";
import { confirmStoryProposal } from "./story-proposal.js";
import { markCardDone } from "./templates.js";
import {
  actor,
  apply,
  fixture,
  human,
  ports,
  role,
  value,
} from "./test-fixtures.js";

const office = actor(4, "pm");
const clock = { now: () => "2026-01-01T00:00:00.000Z" };
const child = (
  title: string,
  extra: Partial<StoryProposalChildInput> = {},
): StoryProposalChildInput => ({
  title,
  template_id: "general",
  goal: `${title} goal`,
  acceptance_criteria: [`${title} works`],
  owner_role: "coder",
  ...extra,
});

function setup(
  project_repositories: CommandPorts["project_repositories"] = [],
) {
  let state: CommandState = fixture();
  state = {
    ...state,
    assignments: state.assignments.map((a) =>
      a.scope === "standing" ? { ...a, standing_mode: "office" } : a,
    ),
  };
  const p = { ...ports(), project_repositories };
  const commit = <T>(result: Result<CommandEffect<T>>) => {
    const effect = value(result);
    state = apply(state, effect);
    return effect.data;
  };
  const story = commit(
    createCard(
      state,
      human,
      {
        template_id: "story",
        title: "Request",
        goal: "Original need",
        source: { kind: "quote", text: "Original need" },
      },
      p,
    ),
  );
  const propose = (
    children: readonly StoryProposalChildInput[] | undefined,
    by: Actor = office,
    card_id = story.id,
  ) =>
    postComment(
      state,
      by,
      {
        card_id,
        body: "拆解",
        story_discussion: {
          action: "propose",
          ...(children ? { children } : {}),
        },
      },
      p,
    );
  const confirm = (version: number, by: Actor = human, card_id = story.id) =>
    confirmStoryProposal(state, by, { card_id, version }, p);
  return {
    p,
    story,
    propose,
    confirm,
    commit,
    get state() {
      return state;
    },
    set state(next: CommandState) {
      state = next;
    },
    current: () => {
      const found = state.cards.find((c) => c.id === story.id);
      if (!found) throw new Error("missing story");
      return found;
    },
    children: () => state.cards.filter((c) => c.parent_card_id === story.id),
  };
}

test("Office submits versioned proposals; each revision is a new version and the old one stays readable", () => {
  const f = setup();
  const first = f.commit(f.propose([child("A"), child("B")]));
  expect(first?.body).toContain("拆解方案第 1 版（2 张子卡）");
  const second = f.commit(
    f.propose([child("A"), child("B", { depends_on: [1] }), child("C")]),
  );
  expect(f.current().story?.proposals).toMatchObject([
    { version: 1, entry_id: first?.id, children: [{ title: "A" }, {}] },
    {
      version: 2,
      entry_id: second?.id,
      children: [
        { title: "A", priority: 0, depends_on: [] },
        { title: "B", depends_on: [1], owner_role: "coder" },
        { title: "C" },
      ],
    },
  ]);
  // A text-only proposal keeps C-502 behavior and adds no version.
  f.commit(f.propose(undefined));
  expect(f.current().story?.proposals).toHaveLength(2);
  expect(f.children()).toEqual([]);
});

test("proposal shape is checked before it can be confirmed", () => {
  const f = setup();
  const rejects = (children: StoryProposalChildInput[], by: Actor = office) =>
    expect(f.propose(children, by).ok).toBe(false);
  rejects([child("A")], human);
  rejects([child("A")], actor(1, "coder"));
  rejects([]);
  rejects(
    Array.from({ length: STORY_PROPOSAL_MAX_CHILDREN + 1 }, (_, i) =>
      child(`C${i}`),
    ),
  );
  rejects([child("A", { template_id: "missing" })]);
  rejects([child("A", { template_id: "story" })]);
  rejects([child("A", { owner_role: "nobody" })]);
  rejects([child("A", { title: " " })]);
  rejects([child("A", { acceptance_criteria: [" "] })]);
  rejects([child("A", { priority: 9 })]);
  rejects([child("A", { depends_on: [1] })]);
  rejects([child("A", { depends_on: [3] }), child("B")]);
  rejects([child("A", { depends_on: [2] }), child("B", { depends_on: [1] })]);
  rejects([child("A", { depends_on_cards: ["C-999" as Card["id"]] })]);
  expect(f.current().story?.proposals).toBeUndefined();
});

test("one human confirmation opens every child with parent, dependencies and source in one transaction", () => {
  const f = setup();
  const entry = f.commit(
    f.propose([
      child("Later", { depends_on: [2], priority: 2 }),
      child("First"),
      child("Third", { depends_on: [1, 2] }),
    ]),
  );
  const result = value(f.confirm(1));
  f.state = apply(f.state, result);
  expect(result.data).toMatchObject({ version: 1, replayed: false });
  const opened = f.children();
  expect(opened).toHaveLength(3);
  const byTitle = (title: string) => {
    const found = opened.find((c) => c.title === title);
    if (!found) throw new Error(title);
    return found;
  };
  const first = byTitle("First"),
    later = byTitle("Later"),
    third = byTitle("Third");
  // Proposal order, while creation followed the dependencies.
  expect(result.data.card_ids).toEqual([later.id, first.id, third.id]);
  expect(Number(first.id.slice(2))).toBeLessThan(Number(later.id.slice(2)));
  expect(later).toMatchObject({
    parent_card_id: f.story.id,
    depends_on_cards: [first.id],
    priority: 2,
    status: "backlog",
    story_source: {
      card_id: f.story.id,
      version: 1,
      entry_id: entry?.id,
      number: 1,
    },
    source: { kind: "quote" },
  });
  expect(later.source).toMatchObject({
    text: expect.stringContaining(`${f.story.id} 拆解方案第 1 版第 1 张`),
  });
  expect(third.depends_on_cards).toEqual([later.id, first.id]);
  expect(first.depends_on_cards).toBeUndefined();
  expect(first.status).toBe("todo");
  expect(f.current().story?.proposals?.[0]?.confirmed).toMatchObject({
    card_ids: result.data.card_ids,
  });
  expect(
    f.state.timeline.find((e) => e.body.startsWith("已确认拆解方案第 1 版")),
  ).toMatchObject({ card_id: f.story.id });
  expect(
    f.state.events.filter((e) => e.type === "story_proposal_confirmed"),
  ).toHaveLength(1);
});

test("repeated confirmation of the same version opens nothing new", () => {
  const f = setup();
  f.commit(f.propose([child("A"), child("B")]));
  const first = value(f.confirm(1));
  f.state = apply(f.state, first);
  const again = value(f.confirm(1));
  expect(again.data).toEqual({ ...first.data, replayed: true });
  expect(again.changes).toEqual([]);
  expect(again.events).toEqual([]);
  expect(f.children()).toHaveLength(2);
});

test("old versions and unknown versions are refused with the current version", () => {
  const f = setup();
  expect(f.confirm(1)).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
  f.commit(f.propose([child("A")]));
  f.commit(f.propose([child("A"), child("B")]));
  for (const version of [1, 3, 0, 1.5])
    expect(f.confirm(version)).toMatchObject({
      ok: false,
      error: { code: "stale_target", details: { current_version: 2 } },
    });
  expect(f.children()).toEqual([]);
});

test("only the human may confirm; PM, Office, Ops and work-item agents are refused", () => {
  const f = setup();
  f.commit(f.propose([child("A")]));
  const ops = {
    ...f.state,
    assignments: f.state.assignments.map((a) =>
      a.scope === "standing" ? { ...a, standing_mode: "ops" as const } : a,
    ),
  };
  for (const [state, by] of [
    [f.state, office],
    [ops, office],
    [f.state, actor(3, "pm")],
    [f.state, actor(1, "coder")],
    [f.state, { kind: "system", project_id: human.project_id } as Actor],
  ] as const)
    expect(
      confirmStoryProposal(state, by, { card_id: f.story.id, version: 1 }, f.p),
    ).toMatchObject({ ok: false });
  expect(f.children()).toEqual([]);
});

const registered = { repo: "registered/repo", base_branch: "trunk" };

test("a repository-less story can propose and confirm children using its project's only registration", () => {
  const f = setup([registered]);
  expect(f.story.repo).toBeUndefined();
  f.commit(
    f.propose([
      child("A", { template_id: "dev", base_branch: "release" }),
      child("B", { template_id: "dev" }),
      child("C"),
    ]),
  );
  expect(f.children()).toHaveLength(0);
  expect(f.current().story?.proposals?.[0]?.children[0]?.repo).toBeUndefined();
  f.commit(f.confirm(1));
  expect(f.children()).toMatchObject([
    { repo: registered.repo, base_branch: "release" },
    registered,
    { title: "C" },
  ]);
  expect(f.children()[2]?.repo).toBeUndefined();
});

test.each(
  [[], [registered, { repo: "another/repo", base_branch: "main" }]].map(
    (repos) => ({ repos }),
  ),
)(
  "zero or ambiguous registrations reject the proposal before Needs You: $repos",
  ({ repos }) => {
    const f = setup(repos);
    const ask = f.commit(
      postComment(
        f.state,
        office,
        {
          card_id: f.story.id,
          body: "问题",
          story_discussion: {
            action: "ask",
            questions: [
              { question: "哪种？", recommended: "A", impact: "实现" },
            ],
          },
        },
        f.p,
      ),
    );
    const b = child("B", { template_id: "dev", base_branch: "release" });
    expect(f.propose([child("A"), b])).toMatchObject({
      ok: false,
      error: {
        code: "validation_failed",
        message: "第 2 张子卡「B」无法开出：缺少 repo",
      },
    });
    expect(f.current().story?.proposals).toBeUndefined();
    expect(f.current().story?.question_groups?.[0]).toMatchObject({
      id: ask?.id,
    });
    expect(
      f.current().story?.question_groups?.[0]?.questions[0]?.resolution,
    ).toBeUndefined();
    expect(
      value(listNeedsYou(f.state, human, clock)).data.story_proposals,
    ).toEqual([]);
    f.commit(f.propose([child("A"), { ...b, repo: "another/repo" }]));
    f.commit(f.confirm(1));
    expect(f.children()[1]).toMatchObject({
      repo: "another/repo",
      base_branch: "release",
    });
  },
);

test("submission identifies the child with an invalid template form or dependency", () => {
  const f = setup([registered]);
  f.state = {
    ...f.state,
    project_preferences: [
      {
        id: f.state.project_id,
        flow_version: 5,
        auto_merge_after_minutes: null,
      },
    ],
    roles: [
      ...f.state.roles,
      role("frontend_engineer"),
      role("design_director"),
    ],
  };
  for (const [extra, message] of [
    [{ template_id: "ui" }, "state_and_save"],
    [{ template_id: "unknown" }, "模板不存在"],
    [{ depends_on_cards: ["C-999" as Card["id"]] }, "前置卡 C-999"],
  ] as const) {
    const result = f.propose([child("A"), child("B", extra)]);
    expect(result).toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining(`第 2 张子卡「B」无法开出：`),
        details: { child: 2 },
      },
    });
    expect(result).toMatchObject({
      error: { message: expect.stringContaining(message) },
    });
  }
  expect(f.current().story?.proposals).toBeUndefined();
  expect(
    value(listNeedsYou(f.state, human, clock)).data.story_proposals,
  ).toEqual([]);
});

test("confirmation rechecks changed dependencies and rolls back the whole batch", () => {
  const f = setup();
  const before = f.state.cards[0];
  if (!before) throw new Error("missing fixture card");
  f.commit(
    f.propose([child("A"), child("B", { depends_on_cards: [before.id] })]),
  );
  f.state = {
    ...f.state,
    cards: f.state.cards.filter((c) => c.id !== before.id),
  };
  expect(f.confirm(1)).toMatchObject({
    ok: false,
    error: {
      message: expect.stringContaining(
        `第 2 张子卡「B」无法开出：前置卡 ${before.id}`,
      ),
    },
  });
  expect(f.children()).toEqual([]);
  expect(f.current().story?.proposals?.[0]?.confirmed).toBeUndefined();
});

test("paused, unscheduled or finished stories cannot be confirmed", () => {
  const f = setup();
  f.commit(f.propose([child("A")]));
  const story = f.current();
  for (const state of [
    { ...f.state, cards: [{ ...story, hold: { reason: "x" } } as Card] },
    { ...f.state, cards: [{ ...story, status: "backlog" } as Card] },
  ])
    expect(
      confirmStoryProposal(
        state,
        human,
        { card_id: story.id, version: 1 },
        f.p,
      ),
    ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
  f.state = apply(
    f.state,
    value(
      markCardDone(f.state, human, { card_id: story.id, result: "x" }, f.p),
    ),
  );
  expect(f.confirm(1)).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
  expect(f.children()).toEqual([]);
});

test("Needs You lists the current unconfirmed proposal for the human until it is confirmed", () => {
  const f = setup();
  const list = () =>
    value(listNeedsYou(f.state, human, clock)).data.story_proposals;
  const count = () =>
    value(listNeedsYouCounts(f.state, human, clock)).data.tabs.decisions.count;
  expect(list()).toEqual([]);
  f.commit(f.propose([child("A")]));
  const second = f.commit(f.propose([child("A"), child("B")]));
  expect(list()).toEqual([
    {
      card_id: f.story.id,
      card_title: "Request",
      version: 2,
      entry_id: second?.id,
      submitted_at: expect.any(String),
      children: [
        { title: "A", template_id: "general", owner_role: "coder" },
        { title: "B", template_id: "general", owner_role: "coder" },
      ],
    },
  ]);
  expect(count()).toBe(1);
  expect(
    value(listNeedsYou(f.state, human, clock, { section: "actions" })).data
      .story_proposals,
  ).toEqual([]);
  f.state = apply(f.state, value(f.confirm(2)));
  expect(list()).toEqual([]);
  expect(count()).toBe(0);
  // Cancelling a story with no open proposal leaves Needs You empty as well.
  const cancelled = updateCard(
    f.state,
    human,
    {
      card_id: f.story.id,
      status: "cancelled",
      story_children: {
        action: "detach",
        ids: f.children().map((c) => c.id),
      },
    },
    f.p,
  );
  expect(cancelled.ok).toBe(true);
});

test("V-2625: every structured child needs at least one review point", () => {
  const f = setup();
  const { acceptance_criteria: _omit, ...bare } = child("A");
  for (const children of [
    [bare as StoryProposalChildInput],
    [child("A", { acceptance_criteria: [] })],
  ])
    expect(f.propose(children)).toMatchObject({
      ok: false,
      error: { message: "第 1 张子卡至少需要一条非空验收要点" },
    });
});

test("V-2625: the confirmation entry is the story's own, even when children emit many notices", () => {
  const f = setup();
  // Framework dependencies give each child its own run of timeline entries.
  const frameworks = Array.from({ length: 6 }, (_, i) =>
    f.commit(
      createCard(
        f.state,
        human,
        {
          template_id: "general",
          title: `Frame ${i}`,
          goal: "Frame",
          source: { kind: "quote", text: "Frame" },
          is_ui_framework: true,
        },
        f.p,
      ),
    ),
  );
  f.commit(
    f.propose([
      child("A", { depends_on_cards: frameworks.map((c) => c.id) }),
      child("B", { depends_on_cards: frameworks.map((c) => c.id) }),
    ]),
  );
  const effect = value(f.confirm(1));
  f.state = apply(f.state, effect);
  const confirmed = f.current().story?.proposals?.[0]?.confirmed;
  const entry = f.state.timeline.find((e) => e.id === confirmed?.entry_id);
  expect(entry).toMatchObject({
    card_id: f.story.id,
    body: expect.stringContaining("已确认拆解方案第 1 版"),
  });
});

test("V-2625: Needs You counts proposals with decisions only and hides ones that cannot be confirmed", () => {
  const f = setup();
  f.commit(f.propose([child("A")]));
  const counts = () => value(listNeedsYouCounts(f.state, human, clock)).data;
  expect(counts().tabs.decisions).toEqual({ count: 1, attention: 1 });
  expect(counts().tabs.merges).toEqual({ count: 0, attention: 0 });
  expect(counts().total_pending).toBe(1);
  // Moved back to backlog: the confirmation would fail, so it is not offered.
  f.commit(
    updateCard(f.state, human, { card_id: f.story.id, status: "backlog" }, f.p),
  );
  expect(
    value(listNeedsYou(f.state, human, clock)).data.story_proposals,
  ).toEqual([]);
  expect(counts().tabs.decisions.count).toBe(0);
  expect(f.confirm(1)).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
});

test("V-2625: completion against a summary requires that summary to be current and every child ended", () => {
  const f = setup();
  f.commit(f.propose([child("A")]));
  f.state = apply(f.state, value(f.confirm(1)));
  const [a] = f.children();
  if (!a) throw new Error("missing child");
  f.state = apply(
    f.state,
    value(markCardDone(f.state, human, { card_id: a.id, result: "ok" }, f.p)),
  );
  const summary = f.commit(
    postComment(
      f.state,
      office,
      { card_id: f.story.id, body: "对照完成", story_summary: true },
      f.p,
    ),
  );
  if (!summary) throw new Error("missing summary");
  const done = (story_summary_entry_id?: typeof summary.id) =>
    markCardDone(
      f.state,
      human,
      {
        card_id: f.story.id,
        result: "已对照",
        ...(story_summary_entry_id ? { story_summary_entry_id } : {}),
      },
      f.p,
    );
  // Another window opens a new child: the old summary no longer holds.
  f.commit(f.propose([child("B")]));
  f.state = apply(f.state, value(f.confirm(2)));
  expect(f.current().story?.summary_entry_id).toBeUndefined();
  expect(done(summary.id)).toMatchObject({
    ok: false,
    error: { code: "stale_target" },
  });
  expect(f.current().status).not.toBe("done");
  // The existing manual completion is unchanged.
  expect(done().ok).toBe(true);
});

test("V-2625: a current summary with every child ended confirms the story done", () => {
  const f = setup();
  f.commit(f.propose([child("A")]));
  f.state = apply(f.state, value(f.confirm(1)));
  const [a] = f.children();
  if (!a) throw new Error("missing child");
  f.state = apply(
    f.state,
    value(markCardDone(f.state, human, { card_id: a.id, result: "ok" }, f.p)),
  );
  const summary = f.commit(
    postComment(
      f.state,
      office,
      { card_id: f.story.id, body: "对照完成", story_summary: true },
      f.p,
    ),
  );
  if (!summary) throw new Error("missing summary");
  expect(
    markCardDone(
      f.state,
      human,
      {
        card_id: f.story.id,
        result: "已对照",
        story_summary_entry_id: summary.id,
      },
      f.p,
    ).ok,
  ).toBe(true);
});
