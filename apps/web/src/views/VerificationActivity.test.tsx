// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { mergeFixture } from "../../../../packages/domain/src/commands/merge/test-fixtures.js";
import {
  submitReview,
  verificationActivity,
} from "../../../../packages/domain/src/index.js";
import type { ExecutionAssignment } from "../api.js";
import { CardWorkItems } from "../components/CardSidebar.js";
import { CardStatusLine } from "../components/CardStatusLine.js";
import { changeControl } from "../testing/controls.js";
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
    changeControl(screen.getByRole("combobox", { name: /^筛选：/ }), {
      target: { value: "" },
    });
    expect(await screen.findByText(label)).toBeTruthy();
    expect(screen.getByText("空闲")).toBeTruthy();
  },
);

test("conditional same-version recheck renders as reviewing on both card and execution views", async () => {
  const f = mergeFixture();
  const product = await f.deliver();
  f.start(f.reviewer);
  f.commit(
    submitReview(
      f.state,
      f.actor(f.reviewer),
      {
        delivery_id: product.id,
        target_sha: product.subject.value,
        kind: "code",
        issues: [],
        recheck_required: true,
      },
      f.io,
    ),
  );
  f.start(f.reviewer);
  const item =
    f.state.work_items.find((w) => w.id === f.reviewer.work_item_id) ??
    missing();
  const activity = verificationActivity(item, f.state) ?? missing();
  const detail = cardDetail({
    work_items: [{ ...item, verification_activity: activity }],
    deliveries: [],
  });
  const assignment: ExecutionAssignment = {
    id: f.reviewer.id,
    role_id: "reviewer",
    role_version: 1,
    status: "active",
    runtime_state: "running",
    machine_id: "local",
    standing_mode: null,
    card_id: f.card.id,
    card_status: "in_progress",
    work_item_id: item.id,
    worktree_path: null,
    branch: null,
    session_ref: null,
    runtime_ref: null,
    last_mcp_activity_at: null,
    cursors: [],
    verification_activity: activity,
  };
  render(
    <>
      <CardWorkItems detail={detail} projectId="p-1" cardId={f.card.id} />
      <ExecutionPage
        client={fakeClient({
          execution: async () => ({
            assignments: [assignment],
            runs: [],
            machines: [],
          }),
        })}
        projectId="p-1"
      />
    </>,
  );
  changeControl(screen.getByRole("combobox", { name: /^筛选：/ }), {
    target: { value: "" },
  });
  await waitFor(() => expect(screen.getAllByText("正在审核")).toHaveLength(2));
  expect(screen.queryByText("等待新交付")).toBeNull();
  const pass = f.commit(
    submitReview(
      f.state,
      f.actor(f.reviewer),
      {
        delivery_id: product.id,
        target_sha: product.subject.value,
        kind: "code",
        issues: [],
      },
      f.io,
    ),
  );
  expect(pass.verdict).toBe("pass");
});

test("a not-yet-started verifier keeps its original status before the first target", () => {
  const f = mergeFixture();
  const item =
    f.state.work_items.find((w) => w.id === f.pm.work_item_id) ?? missing();
  expect(item.status).toBe("todo");
  expect(verificationActivity(item, f.state)).toBeUndefined();
  const detail = cardDetail({ work_items: [item], deliveries: [] });
  render(<CardWorkItems detail={detail} projectId="p-1" cardId={f.card.id} />);
  expect(screen.getByText("待开始")).toBeTruthy();
  expect(screen.queryByText("等待新交付")).toBeNull();
});

test.each([true, false])(
  "card next step distinguishes waiting for a delivery from actual review (%s)",
  (waiting) => {
    const base = cardDetail();
    const item = base.work_items.find((w) => w.kind === "verify") ?? missing();
    const detail = {
      ...base,
      card: {
        ...base.card,
        waiting_on: [
          {
            kind: "review" as const,
            ref: item.id,
            label: waiting ? "等待新交付" : "等待代码审核",
          },
        ],
      },
      work_items: [
        {
          ...item,
          status: "in_progress",
          verification_activity: {
            status: waiting ? "waiting_delivery" : "running",
            label: waiting ? "等待新交付" : "正在审核",
          },
        },
      ],
    };
    render(<CardStatusLine detail={detail} />);
    const line = screen.getByRole("region", { name: "卡片状态" });
    expect(line.textContent).toContain(
      waiting ? "下一步：提交新交付" : "下一步：完成审核",
    );
    if (waiting) expect(line.textContent).not.toContain("完成审核");
  },
);
