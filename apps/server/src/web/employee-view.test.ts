import {
  type CommandState,
  type Employee,
  postComment,
  prepareDelivery,
  requestDecision,
  requestHumanAction,
  submitDelivery,
  submitReview,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  actor,
  apply,
  fixture,
  id,
  ports,
  subject,
  value,
} from "../../../../packages/domain/src/commands/test-fixtures.js";
import {
  activity,
  cardDetail,
  cardListViews,
  executionView,
  needsYou,
} from "./read.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

test("read views resolve employees through original author identities, retaining inactive names and legacy fallback", async () => {
  const employee: Employee = {
    id: id("employee", 1),
    name: "Alice",
    title: "工程师",
    avatar: "avatar:one",
    bio: "公开简介",
    launch_profile_ref: "private-profile",
    status: "inactive",
    role_id: "coder",
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  };
  let state = { ...fixture(), employees: [employee] };
  state = {
    ...state,
    assignments: state.assignments.map((a) =>
      a.id === id("assignment", 1) ? { ...a, employee_id: employee.id } : a,
    ),
  };
  const p = ports();
  const comment = value(
    postComment(
      state,
      actor(),
      {
        card_id: id("card", 1),
        body: "Review this",
        work_item_id: id("work_item", 1),
      },
      p,
    ),
  );
  state = { ...apply(state, comment), employees: [employee] };
  const params = {
    work_item_id: id("work_item", 1),
    kind: "code" as const,
    summary: "Ready",
    subject,
    requested_verifiers: [id("work_item", 2)],
  };
  const receipt = value(
    await prepareDelivery(state, actor(), params, {
      verify: async () => ({ ok: true, value: [] }),
    }),
  );
  const delivered = value(submitDelivery(state, actor(), params, receipt, p));
  state = { ...apply(state, delivered), employees: [employee] };
  const reviewed = value(
    submitReview(
      state,
      actor(2, "reviewer"),
      {
        delivery_id: delivered.data.id,
        target_sha: subject.value,
        kind: "code",
        issues: [],
      },
      p,
    ),
  );
  state = {
    ...apply(state, reviewed),
    employees: [employee],
    attachments: [
      {
        id: "file",
        card_id: id("card", 1),
        sha256: "a".repeat(64),
        mime: "text/plain",
        size: 1,
        kind: "evidence",
        storage_path: "/private",
        uploaded_by: `assignment:${id("assignment", 1)}`,
        attach_to: { kind: "delivery", id: delivered.data.id },
      },
    ],
  };
  // Reassignment must not rewrite the author of an existing delivery or comment.
  const original = state.assignments[0];
  if (!original) throw new Error("Missing original assignment");
  state = {
    ...state,
    employees: [
      { ...employee, role_id: "reviewer" },
      { ...employee, id: id("employee", 2), name: "Bob", status: "active" },
    ],
    assignments: [
      ...state.assignments.map((a) =>
        a.id === original.id ? { ...a, status: "released" as const } : a,
      ),
      { ...original, id: id("assignment", 20), employee_id: id("employee", 2) },
    ],
    work_items: state.work_items.map((w) =>
      w.id === id("work_item", 1)
        ? { ...w, assignment_id: id("assignment", 20) }
        : w,
    ),
  };
  const detail = cardDetail(state, id("card", 1));
  const expected = {
    employee: {
      id: "E-1",
      name: "Alice",
      title: "工程师",
      avatar: null,
      bio: "公开简介",
      role_id: "coder",
    },
    author_display: "Alice",
  };
  expect(detail?.timeline.find((e) => e.type === "comment")).toMatchObject(
    expected,
  );
  expect(detail?.deliveries[0]).toMatchObject({
    ...expected,
    author: "assignment:A-1",
  });
  expect(detail?.reviews[0]).toMatchObject({
    employee: null,
    author_display: "未命名的 reviewer",
  });
  expect(detail?.attachments[0]).toMatchObject({
    ...expected,
    uploaded_by: "assignment:A-1",
  });
  expect(
    activity(state, {}).events.find((e) => e.type === "comment_posted"),
  ).toMatchObject(expected);
  expect(executionView(state, "2026-01-01").assignments[0]).toMatchObject(
    expected,
  );
  expect(JSON.stringify(detail)).not.toContain("private-profile");
  expect(detail?.deliveries[0]?.employee).toHaveProperty("bio", "公开简介");
  expect(detail?.deliveries[0]?.employee).not.toHaveProperty(
    "launch_profile_ref",
  );
});

function employeeState(): CommandState {
  const state = fixture();
  return {
    ...state,
    employees: [
      {
        id: id("employee", 1),
        name: "林舟",
        title: "工程师",
        bio: "负责实现",
        avatar: "library:guan-yu",
        role_id: "coder",
        launch_profile_ref: "private-profile",
        status: "active",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    ],
    assignments: state.assignments.map((a) =>
      a.id === id("assignment", 1)
        ? { ...a, employee_id: id("employee", 1) }
        : a,
    ),
  };
}

test("board owners use current produce assignments, deduplicate employees and exclude released or verify assignments", () => {
  const state = employeeState();
  const work = state.work_items[0];
  const assignment = state.assignments[0];
  if (!work || !assignment) throw new Error("Missing fixture");
  const { employee_id: _employee, ...anonymous } = assignment;
  const extended: CommandState = {
    ...state,
    work_items: [
      ...state.work_items,
      { ...work, id: id("work_item", 10), assignment_id: id("assignment", 10) },
      { ...work, id: id("work_item", 11), assignment_id: id("assignment", 11) },
      { ...work, id: id("work_item", 12), assignment_id: id("assignment", 12) },
    ],
    assignments: [
      ...state.assignments,
      {
        ...assignment,
        id: id("assignment", 10),
        work_item_id: id("work_item", 10),
      },
      {
        ...assignment,
        id: id("assignment", 11),
        work_item_id: id("work_item", 11),
        status: "released",
      },
      {
        ...anonymous,
        id: id("assignment", 12),
        work_item_id: id("work_item", 12),
      },
    ],
  };
  const before = JSON.stringify(extended);
  const card = cardListViews(extended)[0];
  expect(card?.produce_owners).toHaveLength(2);
  expect(card?.produce_owners[0]?.employee).toMatchObject({
    name: "林舟",
    bio: "负责实现",
    role_id: "coder",
    avatar: "/avatars/v1/guan-yu/head-64.webp",
  });
  expect(card?.produce_owners[1]).toMatchObject({
    employee: null,
    author_display: "未命名的 coder",
  });
  expect(
    card?.next_owners.find((o) => o.ref === assignment.id)?.employee?.name,
  ).toBe("林舟");
  expect(JSON.stringify(extended)).toBe(before);
});

test("Needs You reads original requesters, including project decisions, without mutating state", () => {
  let state = employeeState();
  const originalEmployee = state.employees?.[0];
  if (!originalEmployee) throw new Error("Missing employee");
  state = {
    ...state,
    employees: [
      ...(state.employees ?? []),
      {
        ...originalEmployee,
        id: id("employee", 2),
        name: "陈青",
        role_id: "pm",
      },
    ],
    assignments: state.assignments.map((a) =>
      a.id === id("assignment", 4)
        ? { ...a, employee_id: id("employee", 2) }
        : a,
    ),
  };
  const p = ports();
  const decision = value(
    requestDecision(
      state,
      actor(4, "pm"),
      {
        kind: "choose",
        category: "general",
        question: "继续吗？",
        context: "背景",
        options: [{ key: "go", description: "继续", impact: "开始" }],
        recommended: "go",
        decider: "human",
        plain_summary: TEST_PLAIN_SUMMARY,
        affected_cards: [],
        affected_work_items: [],
        blocking: false,
      },
      p,
    ),
  );
  state = apply(state, decision);
  const action = value(
    requestHumanAction(
      state,
      actor(),
      {
        card_id: id("card", 1),
        instructions: "连接设备",
        why_human: "需要人工",
        expected_return: "连接结果",
        blocked_work_items: [],
      },
      p,
    ),
  );
  state = apply(state, action);
  const before = JSON.stringify(state);
  const view = needsYou(state, "2026-01-02");
  expect(view.decisions[0]).toMatchObject({
    author: "assignment:A-4",
    employee: { name: "陈青", bio: "负责实现" },
  });
  expect(view.human_actions[0]).toMatchObject({
    author: "assignment:A-1",
    employee: { name: "林舟" },
  });
  expect(JSON.stringify(view)).not.toContain("private-profile");
  expect(JSON.stringify(state)).toBe(before);
});

test.each([
  "https://example.com/a.png",
  "//example.com/a.png",
  "/\\example.com/a.png",
  "data:image/png;base64,YQ==",
  "avatar:one",
  "/avatars/legacy.png",
  "library:unknown",
  "library:../guan-yu",
  "upload:../../secret",
])("read views omit unsafe or opaque avatar reference %s", (avatar) => {
  const state = employeeState();
  expect(
    executionView(
      { ...state, employees: state.employees?.map((e) => ({ ...e, avatar })) },
      "2026-01-01",
    ).assignments[0]?.employee?.avatar,
  ).toBeNull();
});

test.each([
  ["library:guan-yu", "/avatars/v1/guan-yu/head-64.webp"],
  [`upload:${"a".repeat(64)}`, `/api/avatars/${"a".repeat(64)}`],
])(
  "read views resolve %s without exposing the persisted reference",
  (avatar, path) => {
    const base = employeeState();
    const state = {
      ...base,
      employees: base.employees?.map((e) => ({ ...e, avatar })),
    };
    expect(cardListViews(state)[0]?.produce_owners[0]?.employee?.avatar).toBe(
      path,
    );
    expect(
      executionView(state, "2026-01-01").assignments[0]?.employee?.avatar,
    ).toBe(path);
    expect(state.employees?.[0]?.avatar).toBe(avatar);
  },
);

test("all human read surfaces resolve the same owner, including legacy decision and attachment authors", () => {
  const p = ports();
  const human = { kind: "human", project_id: fixture().project_id } as const;
  let state: CommandState = {
    ...fixture(),
    members: [
      {
        id: id("member", 1),
        name: "邵杰",
        title: "所有者",
        role: "owner",
        status: "active",
        avatar: "library:liu-bei",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    ],
  };
  const comment = value(
    postComment(state, human, { card_id: id("card", 1), body: "历史评论" }, p),
  );
  state = apply(state, comment);
  const decision = value(
    requestDecision(
      state,
      human,
      {
        card_id: id("card", 1),
        kind: "choose",
        question: "选择方案",
        category: "general",
        context: "背景",
        options: [{ key: "go", description: "继续", impact: "开始" }],
        recommended: "go",
        decider: "human",
        plain_summary: TEST_PLAIN_SUMMARY,
        affected_cards: [],
        affected_work_items: [],
        blocking: false,
      },
      p,
    ),
  );
  state = apply(state, decision);
  const action = value(
    requestHumanAction(
      state,
      human,
      {
        card_id: id("card", 1),
        instructions: "连接设备",
        why_human: "需要人工",
        expected_return: "连接结果",
        blocked_work_items: [],
      },
      p,
    ),
  );
  state = apply(state, action);
  state = {
    ...state,
    attachments: [
      {
        id: "file",
        card_id: id("card", 1),
        sha256: "a".repeat(64),
        mime: "text/plain",
        size: 1,
        kind: "evidence",
        storage_path: "/private",
        uploaded_by: "human",
        attach_to: { kind: "timeline_entry", id: comment.data.id },
      },
    ],
  };
  const expected = {
    employee: null,
    author_display: "邵杰",
    member: {
      id: "M-1",
      name: "邵杰",
      title: "所有者",
      avatar: "/avatars/v1/liu-bei/head-64.webp",
    },
  };
  const before = JSON.stringify(state);
  const detail = cardDetail(state, id("card", 1));
  expect(
    detail?.timeline.find((entry) => entry.id === comment.data.id),
  ).toMatchObject(expected);
  expect(detail?.attachments[0]).toMatchObject({
    ...expected,
    uploaded_by: "human",
  });
  expect(detail?.decisions[0]?.decider_view).toMatchObject(expected);
  expect(detail?.human_actions[0]).toMatchObject(expected);
  expect(needsYou(state, "2026-01-02").decisions[0]).toMatchObject(expected);
  expect(needsYou(state, "2026-01-02").human_actions[0]).toMatchObject(
    expected,
  );
  expect(
    activity(state, {}).events.find((event) => event.type === "comment_posted"),
  ).toMatchObject(expected);
  expect(JSON.stringify(state)).toBe(before);
  const resolved = {
    ...decision.data,
    status: "resolved" as const,
    resolution: {
      option: "go",
      rationale: "确认",
      raw_quote: "继续",
      at: "2026-01-02",
      resolved_by: "human" as const,
      via: "needs_you" as const,
    },
  };
  state = { ...state, decisions: [resolved] };
  expect(
    cardDetail(state, id("card", 1))?.decisions[0]?.resolution,
  ).toMatchObject({ ...expected, resolved_by: "human" });
});
