// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { ExecutionAssignment } from "../api.js";
import { CardWorkItems } from "../components/CardSidebar.js";
import { cardDetail, fakeClient } from "../testing/fixtures.js";
import { ExecutionPage } from "./ExecutionPage.js";

afterEach(cleanup);
const missing = (): never => {
  throw new Error("Missing fixture");
};

test.each(["等待新交付", "待审核 · 手动派活", "待审核", "正在审核"])(
  "card work item shows %s instead of a legacy in-progress state",
  (label) => {
    const detail = cardDetail();
    const work_items = detail.work_items.map((w) =>
      w.kind === "verify"
        ? {
            ...w,
            status: "in_progress",
            assignment_id: "A-2",
            verification_activity: { status: "waiting_delivery", label },
          }
        : w,
    );
    render(
      <CardWorkItems
        detail={{ ...detail, work_items }}
        projectId="p-1"
        cardId="C-1"
      />,
    );
    const row = screen.getByText("代码审核").closest("li") ?? missing();
    const status = within(row).getByText(label);
    expect(status.closest("summary")?.textContent).not.toContain("进行中");
    expect(screen.getByText("A-2")).toBeTruthy();
  },
);

test.each(["等待新交付", "待审核 · 手动派活", "正在审核"])(
  "execution page keeps %s separate from runtime and history",
  async (label) => {
    const assignment: ExecutionAssignment = {
      id: "A-2",
      role_id: "reviewer",
      role_version: 1,
      status: "active",
      runtime_state: "idle",
      machine_id: "local",
      standing_mode: null,
      card_id: "C-1",
      card_status: "in_progress",
      work_item_id: "W-2",
      worktree_path: null,
      branch: null,
      session_ref: null,
      runtime_ref: null,
      last_mcp_activity_at: null,
      cursors: [],
      verification_activity: { status: "waiting_delivery", label },
    };
    render(
      <ExecutionPage
        client={fakeClient({
          execution: async () => ({
            assignments: [assignment],
            runs: [],
            machines: [],
          }),
        })}
        projectId="p-1"
      />,
    );
    fireEvent.change(screen.getByLabelText("筛选"), {
      target: { value: "all" },
    });
    expect(await screen.findByText(label)).toBeTruthy();
    expect(screen.getByText("空闲")).toBeTruthy();
  },
);
