import { expect, test } from "vitest";
import {
  ASSIGNMENT_MISFIT_REASONS,
  assign,
  assignmentMisfit,
  type CommandState,
  createWorkItem,
  type RoleWorktree,
  type WorkItem,
} from "../index.js";
import { apply, fixture, human, id, ports, value } from "./test-fixtures.js";

// C-836: combinations that can never run are refused when assigned (or
// created), with the reason and the fix, instead of a silent bell or a Run
// that fails while preparing its checkout.
function state(
  worktree: Partial<Record<string, RoleWorktree>> = {},
  repo = true,
): CommandState {
  const s = fixture();
  return {
    ...s,
    roles: s.roles.map((r) => ({
      ...r,
      worktree:
        worktree[r.role_id] ?? (r.role_id === "coder" ? "write" : "readonly"),
    })),
    cards: repo ? s.cards : s.cards.map(({ repo: _repo, ...c }) => c),
    assignments: s.assignments.filter((a) => a.scope === "standing"),
    runs: [],
    work_items: s.work_items.map(({ assignment_id: _id, ...w }) => w),
  };
}
const assignTo = (s: CommandState, n: number, role_id: string) =>
  assign(s, human, { work_item_id: id("work_item", n), role_id }, ports());
const withoutTarget = (s: CommandState, n: number): CommandState => ({
  ...s,
  work_items: s.work_items.map((w) => {
    if (w.id !== id("work_item", n) || w.kind !== "verify") return w;
    const { target_work_item_id: _target, ...rest } = w;
    return rest;
  }),
});
function refused(
  result: ReturnType<typeof assign> | ReturnType<typeof createWorkItem>,
  misfit: keyof typeof ASSIGNMENT_MISFIT_REASONS,
) {
  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "validation_failed",
      message: ASSIGNMENT_MISFIT_REASONS[misfit],
    },
  });
}

test("the reasons name the cause and the fix", () => {
  expect(ASSIGNMENT_MISFIT_REASONS.untargeted_verifier).toMatch(
    /没有目标产出项.*不会派发.*target_work_item_id/,
  );
  expect(ASSIGNMENT_MISFIT_REASONS.readonly_producer).toMatch(
    /只读角色不能执行产出项.*可写角色.*验证项/,
  );
});

test("a readonly role is refused a producer on a repo card; a writable role is not", () => {
  refused(
    assignTo(state({ coder: "readonly" }), 1, "coder"),
    "readonly_producer",
  );
  expect(value(assignTo(state(), 1, "coder")).data).toMatchObject({
    work_item_id: id("work_item", 1),
    status: "active",
  });
  // Without a repo there is no checkout to prepare, so nothing changes.
  expect(
    value(assignTo(state({ coder: "readonly" }, false), 1, "coder")).data,
  ).toMatchObject({ work_item_id: id("work_item", 1) });
});

test("the role version being assigned decides, not an older one", () => {
  const s = state({ coder: "readonly" });
  const upgraded = {
    ...s,
    roles: [
      ...s.roles,
      {
        ...(s.roles.find((r) => r.role_id === "coder") as (typeof s.roles)[0]),
        role_version: 2,
        worktree: "write" as const,
      },
    ],
  };
  expect(value(assignTo(upgraded, 1, "coder")).data.role_version).toBe(2);
  refused(
    assign(
      upgraded,
      human,
      { work_item_id: id("work_item", 1), role_id: "coder", role_version: 1 },
      ports(),
    ),
    "readonly_producer",
  );
});

test("a template completion verifier and a targeted verifier are still assigned", () => {
  const s = state();
  expect(value(assignTo(s, 3, "pm")).data.work_item_id).toBe(
    id("work_item", 3),
  );
  expect(value(assignTo(s, 2, "reviewer")).data.work_item_id).toBe(
    id("work_item", 2),
  );
});

test("an untargeted verifier no completion can name is refused", () => {
  // Not a template item at all (e.g. created before create_work_item refused it).
  const { template_key: _key, ...untemplated } = state()
    .work_items[2] as WorkItem;
  refused(
    assignTo(
      {
        ...state(),
        work_items: state().work_items.map((w) =>
          w.id === untemplated.id ? untemplated : w,
        ),
      },
      3,
      "pm",
    ),
    "untargeted_verifier",
  );
  // A template item whose role is not the template's completion reviewer.
  refused(
    assignTo(withoutTarget(state(), 2), 2, "reviewer"),
    "untargeted_verifier",
  );
  // dev@2 completes by system summary: it has no completion verifier.
  refused(
    assignTo(
      {
        ...state(),
        cards: state().cards.map((c) => ({ ...c, template_version: 2 })),
      },
      3,
      "pm",
    ),
    "untargeted_verifier",
  );
});

test("create_work_item refuses both combinations and keeps ordinary items", () => {
  const base = {
    card_id: id("card", 1),
    title: "Extra",
    required: true,
    completion_criteria: ["done"],
  };
  const s = state();
  refused(
    createWorkItem(
      s,
      human,
      { ...base, kind: "verify", role_id: "reviewer" },
      ports(),
    ),
    "untargeted_verifier",
  );
  refused(
    createWorkItem(
      s,
      human,
      { ...base, kind: "produce", role_id: "reviewer" },
      ports(),
    ),
    "readonly_producer",
  );
  expect(
    value(
      createWorkItem(
        s,
        human,
        { ...base, kind: "produce", role_id: "coder" },
        ports(),
      ),
    ).data.kind,
  ).toBe("produce");
  expect(
    value(
      createWorkItem(
        s,
        human,
        {
          ...base,
          kind: "verify",
          role_id: "reviewer",
          target_work_item_id: id("work_item", 1),
        },
        ports(),
      ),
    ).data.target_work_item_id,
  ).toBe(id("work_item", 1));
});

test("assignmentMisfit reads a stored Assignment under its own role version", () => {
  const s = state({ coder: "readonly" });
  const stored = apply(
    state({ coder: "write" }),
    value(assignTo(state({ coder: "write" }), 1, "coder")),
  );
  const a = stored.assignments.find((x) => x.scope === "work_item");
  if (!a) throw new Error("missing assignment");
  expect(assignmentMisfit(a, stored)).toBeUndefined();
  expect(assignmentMisfit(a, { ...stored, roles: s.roles })).toBe(
    "readonly_producer",
  );
  const verifier = { ...a, work_item_id: id("work_item", 3), role_id: "pm" };
  expect(assignmentMisfit(verifier, stored)).toBeUndefined();
  const { template_key: _key, ...untemplated } = stored.work_items.find(
    (w) => w.id === id("work_item", 3),
  ) as WorkItem;
  expect(
    assignmentMisfit(verifier, {
      ...stored,
      work_items: stored.work_items.map((w) =>
        w.id === untemplated.id ? untemplated : w,
      ),
    }),
  ).toBe("untargeted_verifier");
});
