// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { MergeCheckView } from "../api.js";
import { timelineEntry } from "../testing/fixtures.js";
import { MergeCheck } from "./MergeCheck.js";
import { Timeline } from "./Timeline.js";

afterEach(cleanup);
const check: MergeCheckView = {
  status: "failed",
  attempt_id: "e42de008-2c67-49e2-a59d-077a0f7936de",
  completion_id: "D-1",
  checks: [{ name: "Web", status: "failed", duration_ms: 1200 }],
  updated_at: "2026-01-01T00:00:00.000Z",
  summary: "Error: check failed",
  log_ref: "e42de008-2c67-49e2-a59d-077a0f7936de.log",
};

const checkStates = [
  ["queued", "排队中", "pending"],
  ["running", "运行中", "progress"],
  ["passed", "已通过", "success"],
  ["failed", "失败", "error"],
  ["timed_out", "超时", "error"],
  ["interrupted", "已中断", "paused"],
] as const;

function expectBadge(badge: Element, label: string, shape: string) {
  expect(badge.textContent).toBe(label);
  const icon = badge.querySelector(`svg.status-shape-${shape}`);
  expect(icon?.querySelector("circle, path")).toBeTruthy();
  // The text names the status; the adjacent SVG must not repeat it to a reader.
  expect(icon?.getAttribute("aria-hidden")).toBe("true");
  expect(icon?.getAttribute("aria-label")).toBeNull();
}

test.each(checkStates)(
  "overall %s check shares its shape, label and accessible text",
  (status, label, shape) => {
    render(
      <MergeCheck projectId="p-1" check={{ ...check, status, checks: [] }} />,
    );
    const group = within(screen.getByRole("region", { name: "合并检查" }));
    expectBadge(group.getByText(label), label, shape);
    expect(group.queryByRole("list", { name: "单项检查" })).toBeNull();
  },
);

const itemStates = [
  ["passed", "已通过", "success"],
  ["failed", "失败", "error"],
  ["timed_out", "超时", "error"],
  ["interrupted", "已中断", "paused"],
  ["not_run", "未运行", "cancelled"],
] as const;

test.each(itemStates)(
  "individual %s check keeps its name, shared shape and accessible label",
  (status, label, shape) => {
    render(
      <MergeCheck
        projectId="p-1"
        check={{ ...check, checks: [{ name: "Web", status }] }}
      />,
    );
    const items = within(screen.getByRole("list", { name: "单项检查" }));
    expect(items.getByText("Web")).toBeTruthy();
    expectBadge(items.getByText(label), label, shape);
  },
);

test.each(checkStates)(
  "timeline %s check uses its own shared badge and not_run item",
  (status, label, shape) => {
    render(
      <Timeline
        projectId="p-1"
        cardId="C-1"
        attachments={[]}
        entries={[
          timelineEntry({
            type: "status_change",
            event_type: "merge_check_finished",
            body: "raw check event",
            merge_check: {
              ...check,
              status,
              checks: [{ name: "Later check", status: "not_run" }],
            },
          }),
        ]}
      />,
    );
    const group = within(screen.getByRole("region", { name: "合并检查" }));
    expectBadge(group.getByText(label), label, shape);
    const items = within(group.getByRole("list", { name: "单项检查" }));
    expectBadge(items.getByText("未运行"), "未运行", "cancelled");
    expect(screen.queryByText("raw check event")).toBeNull();
  },
);

test("timeline check events render badges and their own result instead of the raw system body", () => {
  render(
    <Timeline
      projectId="p-1"
      cardId="C-1"
      attachments={[]}
      entries={[
        {
          id: "C-1#1",
          card_id: "C-1",
          event_seq: 1,
          type: "status_change",
          event_type: "merge_check_finished",
          author: "system",
          created_at: check.updated_at,
          body: "合并检查 failed：原始文字",
          refs: [],
          mentions: [],
          retracted: false,
          merge_check: check,
        },
        {
          id: "C-1#2",
          card_id: "C-1",
          event_seq: 2,
          type: "status_change",
          event_type: "merge_check_requeued",
          author: "human",
          created_at: check.updated_at,
          body: "已请求重新检查合并候选",
          refs: [],
          mentions: [],
          retracted: false,
          merge_check: { ...check, status: "queued", checks: [] },
        },
      ]}
    />,
  );
  const groups = screen.getAllByRole("region", { name: "合并检查" });
  expect(groups).toHaveLength(2);
  expectBadge(
    within(document.getElementById("entry-C-1#1") as HTMLElement).getByText(
      "失败",
      {
        selector: ".action-row > .status",
      },
    ),
    "失败",
    "error",
  );
  expectBadge(
    within(document.getElementById("entry-C-1#2") as HTMLElement).getByText(
      "排队中",
    ),
    "排队中",
    "pending",
  );
  expect(screen.getAllByText("Error: check failed")).toHaveLength(1);
  expect(screen.queryByText(/原始文字/)).toBeNull();
  expect(screen.getByText("用时：1 秒")).toBeTruthy();
});

test("unsafe or mismatching log references cannot become links", () => {
  const { rerender } = render(
    <MergeCheck
      projectId="p-1"
      check={{ ...check, attempt_id: "../../secret" }}
    />,
  );
  expect(screen.queryByRole("link")).toBeNull();
  rerender(
    <MergeCheck
      projectId="p-1"
      check={{ ...check, log_ref: "../../secret" }}
    />,
  );
  expect(screen.queryByRole("link")).toBeNull();
});

test.each([
  "E42DE008-2C67-49E2-A59D-077A0F7936DE",
  "E42de008-2c67-49e2-a59d-077a0f7936de",
])("uppercase UUIDs cannot become log links: %s", (attempt) => {
  const { rerender } = render(
    <MergeCheck
      projectId="p-1"
      check={{ ...check, attempt_id: attempt, log_ref: `${attempt}.log` }}
    />,
  );
  expect(screen.queryByRole("link", { name: "查看日志" })).toBeNull();
  rerender(<MergeCheck projectId="p-1" check={check} />);
  expect(
    screen.getByRole("link", { name: "查看日志" }).getAttribute("href"),
  ).toBe(`/api/projects/p-1/merge-checks/${check.attempt_id}`);
});

test.each([
  [{ kind: "docs_only" }, "检查范围：仅文档"],
  [{ kind: "full" }, "检查范围：全量"],
  [
    { kind: "affected", packages: ["packages/store", "apps/server"] },
    "检查范围：受影响包（packages/store、apps/server）",
  ],
] as const)("shows recorded scope %j", (scope, label) => {
  render(<MergeCheck projectId="p-1" check={{ ...check, scope }} />);
  expect(screen.getByText(label)).toBeTruthy();
});

test("docs-only results distinguish skipped steps and explain why; legacy scope stays absent", () => {
  const { rerender } = render(
    <MergeCheck
      projectId="p-1"
      check={{
        ...check,
        status: "passed",
        scope: { kind: "docs_only" },
        checks: [
          { name: "test", status: "skipped", reason: "docs_only" },
          { name: "e2e", status: "skipped", reason: "docs_only" },
        ],
      }}
    />,
  );
  for (const badge of screen.getAllByText("已跳过"))
    expectBadge(badge, "已跳过", "cancelled");
  expect(screen.getAllByText("仅文档变更")).toHaveLength(2);
  rerender(<MergeCheck projectId="p-1" check={check} />);
  expect(screen.queryByText(/检查范围/)).toBeNull();
});
