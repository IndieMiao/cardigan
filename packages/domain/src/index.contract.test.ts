import { expect, expectTypeOf, test } from "vitest";
import {
  type Assignment,
  type Attachment,
  type Card,
  type CardId,
  type DecisionId,
  type Delivery,
  developmentCardTemplate,
  type GitWorktreePort,
  type IdAllocator,
  type Repositories,
  type Review,
  type RoleReference,
  type Run,
  type TimelineEntryId,
  type WorkItem,
  type WorkItemId,
} from "./index.js";

test("invariants 5, 9: Git port supports local worktree reuse without exposing push or deletion", () => {
  expectTypeOf<GitWorktreePort>().not.toHaveProperty("push");
  expectTypeOf<GitWorktreePort>().not.toHaveProperty("removeWorktree");
  expectTypeOf<GitWorktreePort["resolveCommit"]>().returns.toEqualTypeOf<
    Promise<string>
  >();
});

test("invariant 1: roles contain capabilities and permissions, not runtime ownership", () => {
  expectTypeOf<keyof RoleReference>().toEqualTypeOf<
    "role_id" | "role_version" | "allowed_tools" | "capabilities"
  >();
  expectTypeOf<RoleReference>().not.toHaveProperty("session_ref");
  expectTypeOf<RoleReference>().not.toHaveProperty("worktree_path");
});

test("invariant 5: session replacement remains within an assignment", () => {
  expectTypeOf<Assignment>()
    .toHaveProperty("session_ref")
    .toEqualTypeOf<string | undefined>();
  expectTypeOf<Run>()
    .toHaveProperty("assignment_id")
    .toEqualTypeOf<Assignment["id"]>();
  expectTypeOf<Run>().not.toHaveProperty("session_ref");
  expectTypeOf<Extract<Assignment, { scope: "work_item" }>>().toMatchTypeOf<{
    work_item_id: WorkItemId;
  }>();
  expectTypeOf<
    Extract<Assignment, { scope: "standing" }>["work_item_id"]
  >().toEqualTypeOf<undefined>();
});

test("invariant 12: run snapshots require role, model and CLI versions", () => {
  expectTypeOf<Run>().toMatchTypeOf<{
    role_version: number;
    model: string;
    agent_cli_version: string;
  }>();
});

test("invariant 14: artifacts require a decision basis and reviews bind to a version", () => {
  expectTypeOf<Extract<Attachment, { kind: "artifact" }>>().toMatchTypeOf<{
    basis: DecisionId;
  }>();
  expectTypeOf<
    Extract<Attachment, { kind: "evidence" }>["basis"]
  >().toEqualTypeOf<DecisionId | undefined>();
  expectTypeOf<Delivery>().toHaveProperty("subject");
  expectTypeOf<Review>().toMatchTypeOf<{
    target_sha: string;
    delivery_id: Delivery["id"];
  }>();
});

test("typed IDs, work item kinds and storage views stay distinct", () => {
  expectTypeOf<CardId>().not.toMatchTypeOf<WorkItemId>();
  expectTypeOf<TimelineEntryId>().not.toMatchTypeOf<CardId>();
  expectTypeOf<Extract<WorkItem, { kind: "produce" }>["status"]>()
    .extract<"accepted">()
    .toEqualTypeOf<"accepted">();
  expectTypeOf<Extract<WorkItem, { kind: "verify" }>["status"]>()
    .extract<"accepted">()
    .toEqualTypeOf<never>();
  expectTypeOf<Repositories["cards"]["put"]>()
    .parameter(0)
    .toEqualTypeOf<string>();
  expectTypeOf<Card>().not.toHaveProperty("review_matrix");
  expectTypeOf<Review>().not.toHaveProperty("stale");
  expectTypeOf<Attachment>().not.toHaveProperty("approval_status");
  expectTypeOf<IdAllocator["nextTimelineEntryId"]>()
    .parameter(1)
    .toEqualTypeOf<CardId>();
});

test("D4 and invariant 13: the development template requires human-facing completion review", () => {
  const template = developmentCardTemplate;
  expect(template.id).toBe("dev");
  expect(template.require_acceptance_criteria).toBe(true);
  expect(template.completion_reviewer).toBe("role:pm");
  expect(template.work_items).toEqual([
    {
      key: "development",
      title: "开发",
      kind: "produce",
      role_id: "coder",
      required: true,
    },
    {
      key: "code_review",
      title: "代码审核",
      kind: "verify",
      role_id: "reviewer",
      required: true,
      target_work_item_key: template.primary_work_item_key,
    },
    {
      key: "pm_acceptance",
      title: "PM 验收",
      kind: "verify",
      role_id: "pm",
      required: true,
    },
  ]);
});
