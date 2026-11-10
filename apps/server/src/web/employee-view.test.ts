import {
  type Employee,
  postComment,
  prepareDelivery,
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
import { activity, cardDetail, executionView } from "./read.js";

test("read views resolve employees through original author identities, retaining inactive names and legacy fallback", async () => {
  const employee: Employee = {
    id: id("employee", 1),
    name: "Alice",
    title: "工程师",
    avatar: "avatar:one",
    bio: "private",
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
  const detail = cardDetail(state, id("card", 1));
  const expected = {
    employee: {
      id: "E-1",
      name: "Alice",
      title: "工程师",
      avatar: "avatar:one",
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
  expect(detail?.deliveries[0]?.employee).not.toHaveProperty("bio");
});
