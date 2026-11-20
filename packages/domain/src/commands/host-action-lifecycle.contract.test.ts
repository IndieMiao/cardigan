import { expect, test } from "vitest";
import type { Actor, Assignment, Event, HumanAction } from "../entities.js";
import {
  acknowledgeRun,
  cancelHumanAction,
  completeHumanAction,
  dispatchRun,
  listNeedsYou,
  NEEDS_YOU_ITEM_READY,
  notices,
  postComment,
  queueRun,
  readyNotices,
  refreshCancelledHumanActions,
  requestDecision,
  requestDeploymentAction,
  requestHumanAction,
  standingTools,
  triageHumanAction,
  updateCard,
} from "../index.js";
import type { CommandState } from "./core.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  now,
  ports,
  role,
  value,
} from "./test-fixtures.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture row");
  return value;
}
const owner = actor(4, "pm");
const target = id("human_action", 1);
function setup(): CommandState {
  const state = fixture();
  return {
    ...state,
    assignments: state.assignments.map(
      (a): Assignment =>
        a.scope === "standing" && a.id === id("assignment", 4)
          ? { ...a, scope: "standing", standing_mode: "office", external: true }
          : a,
    ),
    human_actions: [
      {
        id: target,
        key: target,
        card_id: id("card", 1),
        requested_by: "human",
        category: "general",
        instructions: "Read host evidence",
        why_human: "Host access",
        expected_return: "Evidence",
        blocked_work_items: [],
        status: "open",
        triage: "host",
        host_operator: "external",
        host_assignment_id: id("assignment", 4),
      },
    ],
  };
}
const complete = (s: CommandState, a = owner, text = "Evidence recorded") =>
  completeHumanAction(s, a, { human_action_id: target, text }, ports());
const close = (s: CommandState, a = human, reason = "No longer needed") =>
  cancelHumanAction(s, a, { human_action_id: target, reason }, ports());
const handoff = {
  human_action_id: target,
  disposition: "host" as const,
  host_operator: "external" as const,
  host_assignment_id: id("assignment", 4),
  title: "Read evidence",
  summary: "Evidence",
  why_human: "Host access",
  instructions: "Read",
  expected_outcome: "Evidence recorded",
  expected_return: "Evidence",
  rationale: "Assign external owner",
};

test("exact external Office can complete, human remains allowed, and a notice preserves the result", () => {
  const state = setup();
  const effect = value(complete(state));
  expect(effect.data).toMatchObject({
    status: "done",
    result: { text: "Evidence recorded" },
  });
  expect(effect.events).toContainEqual(
    expect.objectContaining({
      type: "human_action_completed",
      actor: owner,
      payload: expect.objectContaining({
        completed_by_host_assignment_id: "A-4",
      }),
    }),
  );
  const next = apply(state, effect);
  expect(notices(next)).toContainEqual(
    expect.objectContaining({
      kind: "human_action",
      body: "Evidence recorded",
      read: false,
    }),
  );
  expect(complete(next).ok).toBe(false);
  expect(close(next).ok).toBe(false);
  expect(complete(state, human).ok).toBe(true);
  expect(complete(state, owner, "  ").ok).toBe(false);
});

test("owner, mode, current assignment, project and role/tool permissions are all required", () => {
  const state = setup();
  const { host_assignment_id: _legacyOwner, ...unowned } = required(
    state.human_actions[0],
  );
  expect(complete({ ...state, human_actions: [unowned] }).ok).toBe(false);
  expect(complete({ ...state, human_actions: [unowned] }, human).ok).toBe(true);
  const change = (patch: Partial<HumanAction>) => ({
    ...state,
    human_actions: state.human_actions.map((h) => ({ ...h, ...patch })),
  });
  for (const patch of [
    { host_assignment_id: id("assignment", 3) },
    { triage: "human" as const },
    { host_operator: "host_ops" as const },
  ])
    expect(complete(change(patch)).ok).toBe(false);
  for (const patch of [
    { status: "released" as const },
    { status: "suspended" as const },
    { external: false },
    { standing_mode: "ops" as const },
    { role_version: 2 },
  ])
    expect(
      complete({
        ...state,
        assignments: state.assignments.map((a) =>
          a.scope === "standing" && a.id === id("assignment", 4)
            ? { ...a, ...patch }
            : a,
        ),
      }).ok,
    ).toBe(false);
  for (const a of [
    actor(),
    actor(3, "pm"),
    { ...owner, project_id: "other" },
    { ...owner, allowed_tools: [] } as Actor,
  ])
    expect(complete(state, a).ok).toBe(false);
  expect(
    complete({
      ...state,
      roles: state.roles.map((r) => ({
        ...r,
        allowed_tools: r.allowed_tools.filter(
          (t) => t !== "complete_host_action",
        ),
      })),
    }).ok,
  ).toBe(false);
  expect(
    complete({
      ...state,
      roles: [
        ...state.roles,
        { ...required(state.roles[2]), role_version: 2, status: "inactive" },
      ],
    }).ok,
  ).toBe(false);
  expect(standingTools(["complete_host_action"], "ops")).toEqual([]);
});

test("external handoff requires an explicit valid identity, audits transfers and clears ownership for other triage", () => {
  const state = setup();
  const { host_assignment_id: _owner, ...legacy } = handoff;
  expect(triageHumanAction(state, human, legacy, ports()).ok).toBe(false);
  const originalOwner = state.assignments.find((a) => a.scope === "standing");
  if (!originalOwner || originalOwner.scope !== "standing")
    throw new Error("Missing owner");
  const other: Assignment = {
    ...originalOwner,
    id: id("assignment", 5),
    scope: "standing",
    standing_mode: "office",
    external: true,
  };
  const transferred = value(
    triageHumanAction(
      { ...state, assignments: [...state.assignments, other] },
      human,
      { ...handoff, host_assignment_id: other.id },
      ports(),
    ),
  );
  expect(transferred.events[0]?.payload).toMatchObject({
    previous_host_assignment_id: "A-4",
    host_assignment_id: "A-5",
  });
  const afterTransfer = apply(
    { ...state, assignments: [...state.assignments, other] },
    transferred,
  );
  expect(complete(afterTransfer).ok).toBe(false);
  expect(complete(afterTransfer, actor(5, "pm")).ok).toBe(true);
  expect(
    triageHumanAction(
      state,
      human,
      { ...handoff, host_assignment_id: id("assignment", 1) },
      ports(),
    ).ok,
  ).toBe(false);
  const { host_operator: _operator, ...humanParams } = legacy;
  const humanHandoff = value(
    triageHumanAction(
      state,
      human,
      { ...humanParams, disposition: "human" },
      ports(),
    ),
  );
  expect(humanHandoff.data.host_assignment_id).toBeUndefined();
});

test("human close is distinct, rejects agents and blank reasons, and preserves other blockers", () => {
  const state = setup();
  for (const a of [
    owner,
    actor(),
    { kind: "system", project_id: state.project_id } as Actor,
  ])
    expect(close(state, a).ok).toBe(false);
  expect(close(state, human, "  ").ok).toBe(false);
  const io = ports();
  let held = state;
  for (let i = 0; i < 2; i++) {
    const effect = value(
      requestHumanAction(
        held,
        human,
        {
          card_id: id("card", 1),
          instructions: "Configure account",
          why_human: "Account",
          expected_return: "Ready",
          blocked_work_items: [id("work_item", 1)],
          blocks_merge: true,
          prerequisite: "external_account",
        },
        io,
      ),
    );
    held = apply(held, effect);
  }
  const first = required(
    held.human_actions.find((h) => h.blocked_work_items.length),
  );
  const cancelled = value(
    cancelHumanAction(
      held,
      human,
      { human_action_id: first.id, reason: "Duplicate" },
      io,
    ),
  );
  expect(cancelled.data).toMatchObject({
    status: "cancelled",
    cancellation: { source: "human", reason: "Duplicate", by: "human" },
  });
  expect(cancelled.data.result).toBeUndefined();
  const next = apply(held, cancelled);
  expect(next.work_items.find((w) => w.id === id("work_item", 1))?.status).toBe(
    "blocked",
  );
  const remaining = required(
    next.human_actions.find(
      (h) => h.status === "open" && h.blocked_work_items.length,
    ),
  );
  const last = value(
    cancelHumanAction(
      next,
      human,
      { human_action_id: remaining.id, reason: "Not required" },
      io,
    ),
  );
  expect(
    apply(next, last).work_items.find((w) => w.id === id("work_item", 1))
      ?.status,
  ).toBe("in_progress");
  expect(complete(apply(state, value(close(state)))).ok).toBe(false);
});

test("card cancellation and compensation preserve history, do not resume work, and reject late completion", () => {
  const state = setup();
  const original = required(state.human_actions[0]);
  const done: HumanAction = {
    ...original,
    id: id("human_action", 2),
    key: id("human_action", 2),
    status: "done",
    result: { text: "Already done", attachments: [], at: now },
  };
  const other: HumanAction = {
    ...original,
    id: id("human_action", 3),
    key: id("human_action", 3),
    card_id: id("card", 2),
  };
  const all = { ...state, human_actions: [original, done, other] };
  const effect = value(
    updateCard(
      all,
      human,
      { card_id: id("card", 1), status: "cancelled" },
      ports(),
    ),
  );
  const next = apply(all, effect);
  expect(next.human_actions.find((h) => h.id === target)).toMatchObject({
    status: "cancelled",
    instructions: original.instructions,
    cancellation: { source: "card_cancelled" },
  });
  expect(next.human_actions.filter((h) => h.id !== target)).toEqual([
    done,
    other,
  ]);
  expect(
    effect.events.filter((e) => e.type === "human_action_cancelled"),
  ).toHaveLength(1);
  expect(complete(next, human).ok).toBe(false);
  expect(complete(next).ok).toBe(false);
  expect(triageHumanAction(next, human, handoff, ports()).ok).toBe(false);
  expect(
    value(listNeedsYou(next, human)).data.human_actions.map((h) => h.id),
  ).not.toContain(target);
  const system: Actor = { kind: "system", project_id: state.project_id };
  const legacy = { ...next, human_actions: all.human_actions };
  const repaired = value(refreshCancelledHumanActions(legacy, system, ports()));
  expect(
    repaired.events.filter((e) => e.type === "human_action_cancelled"),
  ).toHaveLength(1);
  expect(
    value(
      refreshCancelledHumanActions(apply(legacy, repaired), system, ports()),
    ).events,
  ).toEqual([]);
  expect(refreshCancelledHumanActions(legacy, owner, ports()).ok).toBe(false);
});

function diagnosticOwners() {
  const base = setup();
  const pm = {
    ...required(base.assignments.find((a) => a.scope === "standing")),
    scope: "standing" as const,
    standing_mode: "ops" as const,
    external: false,
  };
  const host = {
    ...pm,
    id: id("assignment", 5),
    role_id: "host_ops",
    standing_mode: undefined,
  };
  const { standing_mode: _mode, ...internal } = host;
  const state = {
    ...base,
    roles: [...base.roles, role("host_ops")],
    assignments: [...base.assignments.slice(0, 3), pm, internal],
  };
  const { host_assignment_id: _office, ...params } = handoff;
  return { state, pm, host, base, params };
}

test.each(["human", "host", undefined, "pm_ops"] as const)(
  "PM can assign a diagnosis from its inbox or a legacy host handoff (prior triage: %s)",
  (triage) => {
    const { state, pm, host, params } = diagnosticOwners();
    const {
      triage: _oldTriage,
      host_operator: _operator,
      host_assignment_id: _owner,
      ...original
    } = required(state.human_actions[0]);
    const action = { ...original, ...(triage ? { triage } : {}) };
    for (const hasHost of [true, false]) {
      const snapshot = {
        ...state,
        human_actions: [action],
        assignments: state.assignments.filter(
          (a) => hasHost || a.id !== host.id,
        ),
      };
      const diagnose = (who: Actor) =>
        triageHumanAction(
          snapshot,
          who,
          { ...params, host_operator: "host_ops", host_diagnostic: true },
          ports(),
        );
      const authorized = {
        host_diagnostic: true,
        host_assignment_id: hasHost ? host.id : pm.id,
      };
      if (triage === "pm_ops" || triage === "host")
        expect(value(diagnose(owner)).data).toMatchObject(authorized);
      else
        expect(diagnose(owner)).toMatchObject({
          ok: false,
          error: { code: "unauthorized" },
        });
      expect(value(diagnose(human)).data).toMatchObject(authorized);
    }
  },
);

test("internal non-blocking handoff binds a result author; only their explicit final report closes it", () => {
  const { state, pm, host, base, params } = diagnosticOwners();
  const io = ports();
  const assign = (s: CommandState) =>
    triageHumanAction(
      s,
      human,
      { ...params, host_operator: "host_ops", host_diagnostic: true },
      io,
    );
  const assigned = value(assign(state));
  expect(assigned.data.host_assignment_id).toBe(host.id);
  const after = apply(state, assigned);
  const result = {
    card_id: id("card", 1),
    body: "H-1: checked the session",
    host_result_for: target,
  };
  const report = (s: CommandState, a = actor(5, "host_ops")) =>
    postComment(s, a, result, ports());
  expect(
    value(
      postComment(
        after,
        actor(5, "host_ops"),
        { card_id: result.card_id, body: result.body },
        ports(),
      ),
    ).changes.some((c) => c.collection === "human_actions"),
  ).toBe(false);
  expect(report(after, actor()).ok).toBe(false);
  expect(report(after, owner).ok).toBe(false);
  expect(
    postComment(
      after,
      actor(5, "host_ops"),
      { ...result, card_id: id("card", 2) },
      ports(),
    ).ok,
  ).toBe(false);
  for (const patch of [
    { blocks_merge: true },
    { requested_by: "system" as const },
    { host_operator: "external" as const },
    { ready_when: { kind: "manual" as const } },
  ]) {
    expect(
      report({ ...after, human_actions: [{ ...assigned.data, ...patch }] }).ok,
    ).toBe(false);
  }
  // Rewriting a diagnosis as ordinary host work must revoke the result grant.
  const ordinary = value(
    triageHumanAction(
      after,
      human,
      { ...params, host_operator: "host_ops" },
      ports(),
    ),
  );
  expect(ordinary.data.host_diagnostic).toBeUndefined();
  expect(ordinary.data.host_assignment_id).toBeUndefined();
  expect(report(apply(after, ordinary)).ok).toBe(false);
  for (const overrides of [
    { disposition: "human" as const },
    { ...handoff }, // external operator
    { blocks_merge: true, prerequisite: "credential" as const },
  ]) {
    expect(
      triageHumanAction(
        state,
        human,
        { ...params, ...overrides, host_diagnostic: true },
        ports(),
      ).ok,
    ).toBe(false);
  }
  const closed = apply(after, value(report(after)));
  expect(closed.human_actions[0]).toMatchObject({
    status: "done",
    result: { text: result.body },
  });
  expect(report(closed).ok).toBe(false);
  const fallback = {
    ...state,
    assignments: state.assignments.filter((a) => a.id !== host.id),
  };
  const assignedPm = value(assign(fallback));
  expect(assignedPm.data.host_assignment_id).toBe(pm.id);
  const fallbackState = apply(fallback, assignedPm);
  const evidence = value(
    postComment(
      fallbackState,
      owner,
      { card_id: result.card_id, body: result.body, host_report_for: target },
      io,
    ),
  );
  expect(
    value(
      triageHumanAction(
        apply(fallbackState, evidence),
        owner,
        {
          human_action_id: target,
          disposition: "done",
          rationale: `Result verified: ${evidence.data?.id}`,
        },
        ports(),
      ),
    ).data.status,
  ).toBe("done");
  expect(assign(base).ok).toBe(false);
});

test.each([false, true])(
  "PM verifies the actual operator's result on a legacy host handoff, deferred=%s",
  (deferred) => {
    const { state, host } = diagnosticOwners();
    const { host_assignment_id: _owner, ...original } = required(
      state.human_actions[0],
    );
    const legacy: CommandState = {
      ...state,
      cards: state.cards.map((c) => ({ ...c, status: "done" })),
      human_actions: [
        {
          ...original,
          host_operator: "host_ops",
          ...(deferred ? { ready_when: { kind: "manual" } } : {}),
        },
      ],
    };
    const evidence = value(
      postComment(
        legacy,
        actor(5, "host_ops"),
        {
          card_id: id("card", 1),
          body: `${target}: verified host state`,
          host_report_for: target,
        },
        ports(),
      ),
    );
    const entry = required(evidence.data);
    const cited = apply(legacy, evidence);
    const reason = `Verified: ${entry.id}`;
    const completePm = (s: CommandState, rationale = reason) =>
      triageHumanAction(
        s,
        owner,
        { human_action_id: target, disposition: "done", rationale },
        ports(),
      );
    const note = {
      card_id: entry.card_id,
      body: `${target}: awaiting execution`,
      refs: [{ kind: "human_action" as const, id: target }],
    };
    for (const who of [actor(5, "host_ops"), owner]) {
      const progress = value(postComment(legacy, who, note, ports()));
      expect(
        completePm(apply(legacy, progress), `Completed: ${progress.data?.id}`)
          .ok,
      ).toBe(false);
    }
    for (const who of [actor(), owner])
      expect(
        postComment(legacy, who, { ...note, host_report_for: target }, ports())
          .ok,
      ).toBe(false);
    expect(evidence.changes).toEqual([]);
    expect(completePm(cited, "No reference").ok).toBe(false);
    expect(completePm(cited, "C-1#999").ok).toBe(false);
    for (const patch of [
      { human_action_id: id("human_action", 2) },
      { card_id: id("card", 2) },
      { type: "system" as const },
      { retracted: true },
      { author: `assignment:${id("assignment", 1)}` as const },
      { body: " " },
    ])
      expect(
        completePm({ ...cited, timeline: [{ ...entry, ...patch }] }).ok,
      ).toBe(false);
    for (const patch of [
      { blocks_merge: true },
      { blocked_work_items: [id("work_item", 1)] },
      { prerequisite: "credential" as const },
      { prerequisite: "external_account" as const },
      ...(
        [
          "spending",
          "credential",
          "account",
          "data_deletion",
          "publish",
        ] as const
      ).map((category) => ({ category })),
    ]) {
      expect(
        completePm({
          ...cited,
          human_actions: [{ ...required(legacy.human_actions[0]), ...patch }],
        }).ok,
      ).toBe(false);
    }
    expect(
      completePm({
        ...cited,
        cards: cited.cards.map((c) => ({ ...c, sensitive: true })),
      }).ok,
    ).toBe(false);
    const needs = (s: CommandState) => value(listNeedsYou(s, human)).data;
    expect([
      ...needs(cited).later,
      ...needs(cited).human_actions,
    ]).toContainEqual(expect.objectContaining({ id: target }));
    const completed = apply(cited, value(completePm(cited)));
    expect(completed.human_actions[0]?.result?.text).toBe(reason);
    expect([
      ...needs(completed).later,
      ...needs(completed).human_actions,
    ]).not.toContainEqual(expect.objectContaining({ id: target }));
    expect(notices(completed)).toContainEqual(
      expect.objectContaining({
        body: reason,
        kind: "human_action",
        resolved_by: "assignment:A-4",
      }),
    );
    expect(completePm(completed).ok).toBe(false);
    // Reassign instead of closing, preserving deferral and the merged card.
    const external: Assignment = {
      ...host,
      id: id("assignment", 6),
      role_id: "pm",
      scope: "standing",
      external: true,
      standing_mode: "office",
    };
    const transferable = {
      ...cited,
      assignments: [...cited.assignments, external],
    };
    const extIo = ports();
    const wrongOwner = {
      ...legacy,
      assignments: transferable.assignments,
      human_actions: legacy.human_actions.map((h) => ({
        ...h,
        host_operator: "external" as const,
        host_assignment_id: id("assignment", 7),
      })),
    };
    const report = value(
      postComment(
        wrongOwner,
        actor(6, "pm"),
        {
          card_id: entry.card_id,
          body: "I verified the new version",
          host_report_for: target,
        },
        extIo,
      ),
    );
    const reported = apply(wrongOwner, report);
    expect(complete(wrongOwner, actor(6, "pm")).ok).toBe(false);
    expect(completePm(reported, `Verified ${report.data?.id}`).ok).toBe(true);
    const superseded = value(
      postComment(
        reported,
        actor(6, "pm"),
        {
          card_id: entry.card_id,
          supersedes: required(report.data).id,
          body: "Still pending",
        },
        extIo,
      ),
    );
    expect(
      completePm(apply(reported, superseded), `Verified ${report.data?.id}`).ok,
    ).toBe(false);
    const transfer = value(
      triageHumanAction(
        transferable,
        owner,
        { ...handoff, host_assignment_id: external.id },
        ports(),
      ),
    );
    expect(transfer.data).toMatchObject({
      status: "open",
      host_assignment_id: external.id,
    });
    expect(transfer.data.ready_when).toEqual(
      legacy.human_actions[0]?.ready_when,
    );
    expect(complete(apply(transferable, transfer), actor(6, "pm")).ok).toBe(
      true,
    );
  },
);

test("protected actions cannot be closed directly by their external owner or stripped of a prerequisite by PM", () => {
  const s = setup();
  for (const patch of [
    { category: "publish" as const },
    { blocks_merge: true, prerequisite: "credential" as const },
  ]) {
    const held = {
      ...s,
      human_actions: [{ ...required(s.human_actions[0]), ...patch }],
    };
    expect(complete(held).ok).toBe(false);
    expect(complete(held, human).ok).toBe(true);
  }
  const { state, params } = diagnosticOwners();
  expect(
    triageHumanAction(
      {
        ...state,
        human_actions: [
          {
            ...required(s.human_actions[0]),
            prerequisite: "credential",
            blocks_merge: true,
          },
        ],
      },
      owner,
      { ...params, host_operator: "host_ops", blocks_merge: false },
      ports(),
    ).ok,
  ).toBe(false);
});

test("a standalone action's declared category survives handoff; a legacy action inherits card risk", () => {
  const s = setup();
  const io = ports();
  const h = required(s.human_actions[0]);
  const request = value(
    requestHumanAction(
      s,
      owner,
      {
        card_id: id("card", 1),
        instructions: h.instructions,
        why_human: h.why_human,
        expected_return: h.expected_return,
        blocked_work_items: [],
        category: "data_deletion",
      },
      io,
    ),
  );
  const assigned = value(
    triageHumanAction(
      apply(s, request),
      human,
      { ...handoff, human_action_id: request.data.id },
      io,
    ),
  );
  expect(assigned.data.category).toBe("data_deletion");
  expect(
    completeHumanAction(
      apply(apply(s, request), assigned),
      owner,
      { human_action_id: request.data.id, text: "Done" },
      io,
    ).ok,
  ).toBe(false);
  const risk = value(
    requestDecision(
      s,
      human,
      {
        card_id: id("card", 1),
        category: "publish",
        kind: "choose",
        decider: "human",
        question: "Publish?",
        context: "Public release",
        options: [
          { key: "approve", description: "Approve", impact: "Visible" },
        ],
        recommended: "approve",
        affected_cards: [],
        affected_work_items: [],
        blocking: false,
        plain_summary: { changed: "发布", impact: "公开", risk: "对外发布" },
      },
      io,
    ),
  );
  expect(complete(apply(s, risk)).ok).toBe(false);
});

test("PM can classify an unclassified legacy host request only against the original request, separately from a final report", () => {
  const { state } = diagnosticOwners();
  const io = ports();
  const source = value(
    requestHumanAction(
      state,
      human,
      {
        card_id: id("card", 1),
        instructions: "Check the recorded runtime version",
        why_human: "Host",
        expected_return: "Readback",
        blocked_work_items: [],
      },
      io,
    ),
  );
  const original = required(source.timeline[0]);
  const action = source.data;
  const s = {
    ...apply(state, source),
    human_actions: [{ ...action, triage: "host" as const }],
  };
  const report = value(
    postComment(
      s,
      actor(5, "host_ops"),
      {
        card_id: original.card_id,
        host_report_for: action.id,
        body: "I checked the runtime version: v1",
      },
      io,
    ),
  );
  const next = apply(s, report);
  const params = {
    human_action_id: action.id,
    disposition: "done" as const,
    rationale: `Verified ${report.data?.id}`,
  };
  const basis = {
    request: original.id,
    explanation: "Only reads the recorded runtime version",
  };
  for (const invalid of [
    undefined,
    { ...basis, request: required(report.data).id },
    ...[
      "",
      " ",
      `（${original.id}）`,
      `**${original.id}** / ${report.data?.id}`,
      `${action.id}：123`,
    ].map((explanation) => ({ ...basis, explanation })),
  ])
    expect(
      triageHumanAction(
        next,
        owner,
        { ...params, ...(invalid ? { ordinary_host_basis: invalid } : {}) },
        io,
      ).ok,
    ).toBe(false);
  const result = value(
    triageHumanAction(
      next,
      owner,
      { ...params, ordinary_host_basis: basis },
      io,
    ),
  );
  expect(result.data).toMatchObject({ category: "general", status: "done" });
  expect(result.events[0]).toMatchObject({
    type: "human_action_classified",
    actor: owner,
    payload: { human_action_id: action.id, basis },
  });
  const missingClassification = {
    ...setup(),
    human_actions: setup().human_actions.map(
      ({ category: _unused, ...h }) => h,
    ),
  };
  expect(complete(missingClassification).ok).toBe(false);
  expect(complete(missingClassification, human).ok).toBe(true);
  for (const category of ["spending", "data_deletion", "publish"] as const) {
    const protectedState = {
      ...next,
      human_actions: next.human_actions.map((h) => ({ ...h, category })),
    };
    expect(
      triageHumanAction(
        protectedState,
        owner,
        { ...params, ordinary_host_basis: basis },
        io,
      ).ok,
    ).toBe(false);
  }
});

test("system evidence-wait request can be completed by its human-designated external owner", () => {
  const s = setup();
  const io = ports();
  const requested = value(
    requestDeploymentAction(
      s,
      { kind: "system", project_id: s.project_id },
      {
        key: `deployment-evidence:${"a".repeat(40)}`,
        instructions: "Read the deployment evidence",
        reason: "evidence_wait",
      },
      io,
    ),
  );
  const before = apply(s, requested);
  const designated = value(
    triageHumanAction(
      before,
      human,
      { ...handoff, human_action_id: requested.data.id },
      io,
    ),
  );
  const end = value(
    completeHumanAction(
      apply(before, designated),
      owner,
      { human_action_id: requested.data.id, text: "Evidence checked" },
      io,
    ),
  );
  // A pre-classification evidence wait is identified by its original system request, not its title.
  const delegated = apply(before, designated);
  const legacy = {
    ...delegated,
    human_actions: delegated.human_actions.map(
      ({ category: _old, ...item }) => item,
    ),
  };
  const finish = (s: CommandState) =>
    completeHumanAction(
      s,
      owner,
      { human_action_id: requested.data.id, text: "Evidence verified" },
      io,
    );
  expect(finish(legacy).ok).toBe(true);
  expect(finish({ ...legacy, events: [] }).ok).toBe(false);
  expect(end.data.status).toBe("done");
  expect(end.events[0]?.payload).toMatchObject({
    completed_by_host_assignment_id: "A-4",
    resume_work_items: [],
  });
});

function startHostOpsRun(
  routed: CommandState,
  trigger: Event,
  io: ReturnType<typeof ports>,
) {
  const system = { kind: "system" as const, project_id: routed.project_id };
  const queued = value(
    queueRun(
      routed,
      system,
      {
        assignment_id: id("assignment", 5),
        trigger_event_id: trigger.id,
        kind: "followup",
        model: "fixture",
        agent_cli_version: "fixture",
      },
      io,
    ),
  );
  routed = apply(routed, queued);
  const dispatched = value(
    dispatchRun(
      routed,
      system,
      {
        run_id: queued.data.id,
        runtime_ref: {
          machine_id: "local",
          runtime_machine: "local",
          terminal_ref: "fixture-host",
          agent_name: "host_ops",
        },
      },
      io,
    ),
  );
  routed = apply(routed, dispatched);
  const started = value(
    acknowledgeRun(
      routed,
      actor(5, "host_ops"),
      { run_id: queued.data.id },
      io,
    ),
  );
  expect(started.data.trigger_event_id).toBe(trigger.id);
  return apply(routed, started);
}

function historicalReport(
  executor: "host_ops" | "fallback" | "external" | "team" = "host_ops",
  link: "action" | "request" | "handoff" | "comment" = "action",
  options: {
    moveToOffice?: "before" | "after";
    poster?: Actor;
    readback?: string;
    dispatch?: "immediate" | "manual" | "ready" | "unrelated";
  } = {},
) {
  const f = diagnosticOwners();
  const state = {
    ...f.state,
    assignments: [
      ...f.state.assignments.filter(
        (a) => executor !== "fallback" || a.id !== f.host.id,
      ),
      {
        ...f.pm,
        id: id("assignment", 7),
        external: true,
        standing_mode: "office" as const,
      },
    ],
  };
  let tick = Date.parse(now);
  const io = { ...ports(), clock: { now: () => new Date(tick).toISOString() } };
  const source = value(
    requestHumanAction(
      state,
      human,
      {
        card_id: id("card", 1),
        instructions: "Read the installed version",
        why_human: "Host check",
        expected_return: "Installed version number",
        blocked_work_items: [],
      },
      io,
    ),
  );
  const request = required(source.timeline[0]);
  const action = source.data;
  const requested = apply(state, source);
  const hand = value(
    triageHumanAction(
      requested,
      human,
      {
        ...f.params,
        expected_return: "Installed version number",
        ...(options.dispatch === "manual"
          ? { ready_when: { kind: "manual" as const } }
          : options.dispatch === "ready"
            ? {
                ready_when: {
                  kind: "card_merged" as const,
                  card_id: id("card", 2),
                },
              }
            : {}),
        human_action_id: action.id,
        ...(executor === "external"
          ? {
              host_operator: "external" as const,
              host_assignment_id: id("assignment", 7),
            }
          : {
              host_operator: "host_ops" as const,
              ...(executor === "team"
                ? {}
                : { host_diagnostic: true as const }),
            }),
      },
      io,
    ),
  );
  const assigned = required(hand.timeline[0]);
  let routed = apply(requested, hand);
  if (options.dispatch) {
    let trigger = required(hand.events[0]);
    if (options.dispatch === "manual") {
      const released = value(
        triageHumanAction(
          routed,
          owner,
          {
            human_action_id: action.id,
            disposition: "release",
            rationale: "Host is ready",
          },
          io,
        ),
      );
      routed = apply(routed, released);
      trigger = required(released.events[0]);
      expect(trigger.payload).toMatchObject({
        released: true,
        disposition: "host",
        human_action_id: action.id,
      });
    } else if (options.dispatch === "ready") {
      const sourceCard = id("card", 2);
      const fact: Event = {
        type: "card_merged",
        card_id: sourceCard,
        actor: { kind: "system", project_id: routed.project_id },
        created_at: io.clock.now(),
        id: io.ids.nextEventId(),
        seq: io.ids.nextEventSequence(routed.project_id, sourceCard),
        payload: {},
      };
      routed = {
        ...routed,
        cards: routed.cards.map((c) =>
          c.id === sourceCard ? { ...c, status: "done" } : c,
        ),
        events: [...routed.events, fact],
      };
      const notice = required(readyNotices(routed, fact)[0]);
      trigger = {
        ...fact,
        type: NEEDS_YOU_ITEM_READY,
        card_id: request.card_id,
        payload: notice.payload,
        id: io.ids.nextEventId(),
        seq: io.ids.nextEventSequence(routed.project_id, request.card_id),
      };
      routed = { ...routed, events: [...routed.events, trigger] };
    } else if (options.dispatch === "unrelated") {
      const note = value(
        postComment(
          routed,
          human,
          { card_id: request.card_id, body: `Reminder for ${action.id}` },
          io,
        ),
      );
      routed = apply(routed, note);
      trigger = required(note.events[0]);
    }
    tick += 1000;
    routed = startHostOpsRun(routed, trigger, io);
    tick += 1000;
  }
  const other = value(
    postComment(
      routed,
      human,
      { card_id: request.card_id, body: `Following ${action.id}` },
      io,
    ),
  );
  const toOffice = (from: CommandState) =>
    apply(
      from,
      value(
        triageHumanAction(
          from,
          human,
          {
            ...handoff,
            human_action_id: action.id,
            host_assignment_id: id("assignment", 7),
          },
          io,
        ),
      ),
    );
  const before = apply(routed, other);
  const open = options.moveToOffice === "before" ? toOffice(before) : before;
  const operator =
    executor === "fallback"
      ? owner
      : executor === "external"
        ? actor(7, "pm")
        : actor(5, "host_ops");
  const quote =
    options.readback ?? "I verified that the running version is 7.2.";
  const body = link === "action" ? `${action.id}: ${quote}` : quote;
  const posted = value(
    postComment(
      open,
      options.poster ?? operator,
      {
        card_id: request.card_id,
        body,
        ...(link === "action"
          ? {}
          : {
              reply_to:
                link === "request"
                  ? request.id
                  : link === "handoff"
                    ? assigned.id
                    : required(other.data).id,
            }),
      },
      io,
    ),
  );
  const entry = required(posted.data);
  const reported = apply(open, posted);
  const postedState =
    options.moveToOffice === "after" ? toOffice(reported) : reported;
  const released = {
    ...postedState,
    assignments: [
      ...postedState.assignments.map((a) =>
        a.id === hand.data.host_assignment_id || a.id === f.pm.id
          ? { ...a, status: "released" as const }
          : a,
      ),
      { ...f.pm, id: id("assignment", 6) },
    ],
  };
  // Historical storage shape: no server protocol discriminator, no dedicated action field on the comment.
  const old = {
    ...released,
    events: released.events.map((e) =>
      e.seq === entry.event_seq && e.type === "comment_posted"
        ? { ...e, payload: { body } }
        : e,
    ),
  };
  const params = {
    human_action_id: action.id,
    disposition: "done" as const,
    rationale: `Verified ${entry.id}`,
    ordinary_host_basis: {
      request: request.id,
      explanation:
        "Reading the installed version requires no mutation or protected operation",
    },
  };
  const attestation = {
    entry: entry.id,
    result_quote: quote,
    verification:
      "Matched the reported version to the read-only supervisor status",
  };
  const finish = (s: CommandState, legacy = attestation) =>
    triageHumanAction(
      s,
      actor(6, "pm"),
      { ...params, legacy_host_result: legacy },
      io,
    );
  return {
    request,
    action,
    hand,
    assigned,
    entry,
    old,
    released,
    params,
    attestation,
    finish,
    io,
    quote,
  };
}

test.each([
  ["host_ops", "action"],
  ["host_ops", "request"],
  ["host_ops", "handoff"],
  ["fallback", "action"],
  ["fallback", "handoff"],
  ["external", "handoff"],
] as const)(
  "historical report: %s linked by %s survives executor rotation",
  (executor, link) => {
    const { old, finish, assigned, request, attestation, entry } =
      historicalReport(executor, link);
    const effect = value(finish(old));
    expect(effect.data.status).toBe("done");
    expect(effect.events).toContainEqual(
      expect.objectContaining({
        type: "legacy_host_result_verified",
        actor: actor(6, "pm"),
        payload: expect.objectContaining({
          request: request.id,
          handoff: assigned.id,
          executor: entry.author,
          ...attestation,
        }),
      }),
    );
    expect(apply(old, effect).timeline.find((e) => e.id === entry.id)).toEqual(
      entry,
    );
    expect(finish(apply(old, effect)).ok).toBe(false);
  },
);

test("PM cannot repurpose ordinary, obsolete or unverified comments", () => {
  const {
    request,
    action,
    entry,
    old,
    released,
    params,
    attestation,
    finish,
    io,
    quote,
  } = historicalReport();
  expect(finish(released).ok).toBe(false); // new-protocol progress intentionally has no report
  expect(triageHumanAction(old, actor(6, "pm"), params, io).ok).toBe(false); // citing the old comment alone is not verification
  for (const patch of [
    { entry: request.id },
    { result_quote: "Not in the original report" },
    { verification: `（${entry.id}）` },
    { verification: quote },
  ])
    expect(finish(old, { ...attestation, ...patch }).ok).toBe(false);
  const noFinal = `${action.id}: will check later`;
  expect(
    finish({
      ...old,
      timeline: old.timeline.map((e) =>
        e.id === entry.id ? { ...e, body: noFinal } : e,
      ),
      events: old.events.map((e) =>
        e.type === "comment_posted" ? { ...e, payload: { body: noFinal } } : e,
      ),
    }).ok,
  ).toBe(false);
  for (const patch of [
    { refs: [] },
    { retracted: true },
    { card_id: id("card", 2) },
    { author: "system" as const },
  ])
    expect(
      finish({
        ...old,
        timeline: old.timeline.map((e) =>
          e.id === entry.id ? { ...e, ...patch } : e,
        ),
      }).ok,
    ).toBe(false);
  const unrelated = historicalReport("host_ops", "comment");
  expect(unrelated.finish(unrelated.old).ok).toBe(false);
});

test("use the effective owner when the comment was posted, not today's owner or a matching role", () => {
  const office = actor(7, "pm");
  for (const [poster, moveToOffice, valid] of [
    [actor(5, "host_ops"), "after", true], // Released since; current owner differs.
    [office, "before", true], // Replies to an earlier formal handoff of this same action.
    [actor(5, "host_ops"), "before", false], // Former owner.
    [office, "after", false], // Future owner.
    [owner, "after", false], // PM but never appointed to this diagnosis.
  ] as const) {
    const { old, finish } = historicalReport("host_ops", "handoff", {
      poster,
      moveToOffice,
    });
    expect(finish(old).ok).toBe(valid);
  }
});

test("a team handoff needs a contemporaneous per-executor dispatch, not just a host_ops role", () => {
  const { old, finish, hand, entry } = historicalReport("team", "handoff");
  expect(finish(old).ok).toBe(false);
  const event = required(
    hand.events.find((e) => e.type === "human_action_requested"),
  );
  const run = {
    ...required(old.runs[0]),
    assignment_id: id("assignment", 5),
    trigger_event_id: event.id,
    started_at: now,
  };
  const state = {
    ...old,
    timeline: old.timeline.map((t) =>
      t.id === entry.id ? { ...t, created_at: "2026-01-01T00:00:02.000Z" } : t,
    ),
    events: old.events.map((e) =>
      e.seq === entry.event_seq && e.card_id === entry.card_id
        ? { ...e, created_at: "2026-01-01T00:00:02.000Z" }
        : e,
    ),
    runs: [run],
  };
  expect(
    value(finish(state)).events.find(
      (e) => e.type === "legacy_host_result_verified",
    )?.payload,
  ).toMatchObject({ executor_run_id: run.id });
  for (const patch of [
    { started_at: "2026-01-01T00:00:03.000Z" },
    { assignment_id: id("assignment", 4) },
    { trigger_event_id: required(old.events[0]).id },
  ])
    expect(finish({ ...state, runs: [{ ...run, ...patch }] }).ok).toBe(false);
});

test("a valid historical report cannot lift a human-only or blocking fence", () => {
  const { old, action, finish } = historicalReport("fallback", "handoff");
  expect(finish(old).ok).toBe(true);
  for (const fence of [
    { blocks_merge: true },
    { blocked_work_items: [id("work_item", 1)] },
    { prerequisite: "credential" },
    { prerequisite: "external_account" },
    ...(
      ["spending", "credential", "account", "data_deletion", "publish"] as const
    ).map((category) => ({ category })),
  ] as const) {
    expect(
      finish({
        ...old,
        human_actions: old.human_actions.map((a) =>
          a.id === action.id ? { ...a, ...fence } : a,
        ),
      }).ok,
    ).toBe(false);
  }
  expect(
    finish({ ...old, cards: old.cards.map((c) => ({ ...c, sensitive: true })) })
      .ok,
  ).toBe(false);
});

test("a same-card release does not replace the handoff and a timeline link is not itself proof", () => {
  const { old, finish, hand, entry, action, assigned } = historicalReport(
    "fallback",
    "handoff",
  );
  const transfer = required(
    hand.events.find((e) => e.type === "human_action_requested"),
  );
  // The entry in the gap is just a notification that a deferred item became visible.
  const release = {
    ...transfer,
    seq: assigned.event_seq + 1,
    payload: {
      human_action_id: action.id,
      disposition: "host",
      released: true,
      reason: "Ready",
    },
  };
  const withoutGap = old.events.filter(
    (e) => e.card_id !== entry.card_id || e.seq !== release.seq,
  );
  expect(finish({ ...old, events: [...withoutGap, release] }).ok).toBe(true);
  for (const patch of [
    { human_action_id: id("human_action", 9) },
    { disposition: "human" },
    { host_diagnostic: false },
    { host_assignment_id: null },
  ]) {
    expect(
      finish({
        ...old,
        events: old.events.map((e) =>
          e.id === transfer.id
            ? { ...e, payload: { ...(e.payload as object), ...patch } }
            : e,
        ),
      }).ok,
    ).toBe(false);
  }
  expect(
    finish({
      ...old,
      timeline: old.timeline.filter((t) => t.id !== assigned.id),
    }).ok,
  ).toBe(false);
});

test.each([
  ["immediate", true],
  ["manual", true],
  ["ready", true],
  ["unrelated", false],
] as const)("historical team dispatch: %s", (dispatch, valid) => {
  const { old, finish } = historicalReport("team", "handoff", { dispatch });
  expect(finish(old).ok).toBe(valid);
});

test.each(["Version: 7.2.1", "7.2.1", "7.2"])(
  "literal version readback: %s",
  (readback) => {
    const { old, finish, attestation, request } = historicalReport(
      "host_ops",
      "handoff",
      { readback },
    );
    const result = value(finish(old));
    expect(
      result.events.find((e) => e.type === "legacy_host_result_verified")
        ?.payload,
    ).toMatchObject({
      request: request.id,
      result_quote: readback,
      verification: attestation.verification,
    });
  },
);

test("literal readback cannot substitute punctuation, citation, a progress fragment or a missing independent check", () => {
  for (const [body, quote] of [
    ["...", "..."],
    ["C-1#123", "123"],
    ["H-123", "H-123"],
    ["Will check 7.2.1 later", "7.2.1"],
    ["7.2.1", "7.2"],
    ["7.2.1", "7.2.0"],
  ] as const) {
    const { old, finish, attestation } = historicalReport(
      "host_ops",
      "handoff",
      { readback: body },
    );
    expect(finish(old, { ...attestation, result_quote: quote }).ok).toBe(false);
  }
  const { old, finish, attestation } = historicalReport("host_ops", "handoff", {
    readback: "7.2.1",
  });
  for (const verification of ["", "...", "C-1#123", "7.2.1"])
    expect(finish(old, { ...attestation, verification }).ok).toBe(false);
});

test.each(["manual", "ready"] as const)(
  "a %s dispatch must be for this action during its effective handoff, before the run and post",
  (dispatch) => {
    const { old, finish, entry, assigned } = historicalReport(
      "team",
      "handoff",
      { dispatch },
    );
    const run = required(
      old.runs.find((r) => r.assignment_id === id("assignment", 5)),
    );
    const wake = required(
      old.events.find((e) => e.id === run.trigger_event_id),
    );
    const effect = value(finish(old));
    expect(
      effect.events.find((e) => e.type === "legacy_host_result_verified")
        ?.payload,
    ).toMatchObject({
      executor_run_id: run.id,
      executor_trigger_event_id: wake.id,
      handoff: assigned.id,
    });
    const fields = wake.payload as object;
    for (const change of [
      { seq: assigned.event_seq - 1 },
      { seq: entry.event_seq + 1 },
      { card_id: id("card", 2) },
      { created_at: entry.created_at },
      { payload: { ...fields, human_action_id: target } },
      ...(dispatch === "manual"
        ? [
            { payload: { ...fields, disposition: "human" } },
            { payload: { ...fields, released: false } },
          ]
        : [
            { actor: human },
            { payload: { ...fields, condition: { kind: "manual" } } },
          ]),
    ])
      expect(
        finish({
          ...old,
          events: old.events.map((e) =>
            e.id === wake.id ? { ...e, ...change } : e,
          ),
        }).ok,
      ).toBe(false);
  },
);

test("a literal readback may follow the action address without rewriting the quote", () => {
  const { old, finish } = historicalReport("host_ops", "action", {
    readback: "7.2.1",
  });
  expect(finish(old).ok).toBe(true);
});
