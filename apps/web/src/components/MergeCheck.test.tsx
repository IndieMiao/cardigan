// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { MergeCheckView } from "../api.js";
import { MergeCheck } from "./MergeCheck.js";
import { Timeline } from "./Timeline.js";

afterEach(cleanup);
const check: MergeCheckView = {
  status: "failed",
  attempt_id: "e42de008-2c67-49e2-a59d-077a0f7936de",
  completion_id: "D-1",
  checks: [{ duration_ms: 1200 }],
  updated_at: "2026-01-01T00:00:00.000Z",
  summary: "Error: check failed",
  log_ref: "e42de008-2c67-49e2-a59d-077a0f7936de.log",
};

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
  expect(screen.getByText("失败").className).toContain("status-failed");
  expect(screen.getByText("排队").className).toContain("status-queued");
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
