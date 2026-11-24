import type { Assignment, Card, Role, WorkItem } from "@cardigan/domain";
import { Store, writeRole } from "@cardigan/store";
import { afterEach, expect, test } from "vitest";
import { missingWorktreePrompt, worktreeBaselinePrompt } from "./worktree.js";

const project = "start-point";
const sha = "9172f56f".padEnd(40, "0");
let store: Store | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

function seed(worktree: Role["worktree"], card: Partial<Card>) {
  store = Store.open({ dbPath: ":memory:" });
  store.createProject({ id: project, name: "Start point" });
  const s = store;
  s.uow.run((tx) => {
    writeRole(
      tx,
      project,
      {
        role_id: "coder",
        version: 1,
        display_name: "Coder",
        kind: "work",
        harness: "codex",
        core_prompt: "Fixture",
        launch_profile_ref: "fixture",
        allowed_tools: ["whoami", "finish_run"],
        capabilities: [],
        abilities: [],
        worktree,
        required_machine_tags: [],
      },
      { mode: "add" },
    );
    tx.cards.put(project, {
      id: "C-1",
      project_id: project,
      title: "Release",
      goal: "Package",
      acceptance_criteria: ["Packaged"],
      source: { kind: "quote", text: "Fixture" },
      status: "in_progress",
      priority: 0,
      template: "dev",
      merge_policy: "none",
      out_of_scope: [],
      related_cards: [],
      created_by: "human",
      created_at: "2026-01-01T00:00:00.000Z",
      ...card,
    } as Card);
    tx.work_items.put(project, {
      id: "W-1",
      card_id: "C-1",
      title: "Package",
      kind: "produce",
      role_id: "coder",
      required: true,
      depends_on: [],
      completion_criteria: [],
      status: "in_progress",
      assignment_id: "A-1",
    } as WorkItem);
    tx.assignments.put(project, {
      id: "A-1",
      scope: "work_item",
      work_item_id: "W-1",
      role_id: "coder",
      role_version: 1,
      status: "active",
      runtime_state: "idle",
      runtime_ref: null,
      machine_id: "local",
      mcp_token_id: "fixture",
      created_at: "2026-01-01T00:00:00.000Z",
    } as Assignment);
  });
  return s;
}

test("C-728: a card without a registered repository says so instead of an empty worktree", () => {
  const prompt = missingWorktreePrompt(seed("write", {}), project, "A-1");
  expect(prompt).toContain("本卡未登记仓库/起点");
  expect(prompt).toContain("--start-point");
});

test.each([
  ["none", {}],
  ["write", { repo: "/srv/source", base_branch: "main" }],
] as const)(
  "no notice for a %s role or a registered card",
  (worktree, card) => {
    expect(
      missingWorktreePrompt(seed(worktree, card), project, "A-1"),
    ).toBeUndefined();
  },
);

test("C-728: the start/wake prompt names the detached start point", () => {
  expect(
    worktreeBaselinePrompt({
      path: "/w/A-1",
      base_sha: sha,
      start_point: { point: "release/0.4", sha },
    }),
  ).toBe(
    `本卡不合并：worktree 已按起点 release/0.4（${sha}） detached 检出，不挂分支。`,
  );
  expect(
    worktreeBaselinePrompt({
      path: "/w/A-1",
      base_sha: sha,
      start_point: { point: sha, sha },
    }),
  ).toContain(`起点 ${sha} detached`);
});
