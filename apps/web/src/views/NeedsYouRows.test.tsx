// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { CardiganClient, NeedsDecision, NeedsPage } from "../api.js";
import { changeControl } from "../testing/controls.js";
import { fakeClient } from "../testing/fixtures.js";
import { NeedsYouPage } from "./NeedsYouPage.js";

afterEach(cleanup);

const decision = (o: Partial<NeedsDecision> = {}): NeedsDecision => ({
  id: "Q-1",
  question: "选择发布方式",
  context: "背景",
  why: "等待拍板",
  status: "open",
  blocking: true,
  decider: "human",
  card_id: "C-1",
  affected_cards: ["C-1"],
  options: [
    { key: "a", description: "灰度发布", impact: "先开放一半" },
    { key: "b", description: "直接发布", impact: "全部生效" },
  ],
  recommended: "a",
  waited_ms: 120_000,
  trigger: null,
  category: "general",
  assignment_id: null,
  related_cards: [{ id: "C-1", title: "发布卡" }],
  merge_confirmation: null,
  ...o,
});
const data: NeedsPage = {
  decisions: [
    decision(),
    decision({
      id: "Q-3",
      question: "确认合并",
      trigger: "merge_confirmation",
      card_id: "C-2",
      related_cards: [{ id: "C-2", title: "合并卡" }],
      plain_summary: { changed: "统一列表行", impact: "无", risk: "无" },
      merge_confirmation: {
        blockers: [],
        deliveries: [],
        reviews: [],
        known_gaps: [],
      },
    } as Partial<NeedsDecision>),
  ],
  human_actions: [
    {
      id: "H-1",
      card_id: "C-3",
      why: "创建测试账号",
      instructions: "登录后台创建账号。",
      expected_return: "账号已创建",
      due: null,
      waited_ms: 60_000,
      blocked_work_items: [],
    },
  ],
  incidents: [],
  later: [
    {
      kind: "human_action",
      id: "H-2",
      card_id: "C-3",
      title: "合并后核对页面",
      waiting_for: "等 C-3 合并",
    },
  ],
  notices: [
    {
      id: "N-1",
      kind: "merge",
      source: "auto_merge",
      card_id: "C-4",
      decision_id: "Q-7",
      question: "示例已自动合并",
      option: "merge",
      resolved_by: "system",
      body: "系统已合并。",
      proxy_authority: null,
      at: "2026-01-01T00:00:00.000Z",
      read: false,
    },
  ],
  notices_next_cursor: null,
};
const tabs = [
  ["待拍板", "拍板 Q-1"],
  ["合并确认", "合并确认 Q-3"],
  ["待你执行", "执行 H-1"],
  ["稍后", "稍后 H-2"],
  ["知会", "知会 Q-7"],
] as const;

async function openTab(label: string) {
  const tab = await screen.findByRole("tab", { name: new RegExp(`^${label}`) });
  await waitFor(() => expect(tab.hasAttribute("disabled")).toBe(false));
  fireEvent.click(tab);
  return within(
    await screen.findByRole("tabpanel", { name: new RegExp(`^${label}`) }),
  );
}

test.each(tabs)(
  "C-459: the %s tab uses the shared row: ids and title left, primary action last on the right",
  async (label, row) => {
    render(
      <NeedsYouPage
        projectId="p-1"
        client={fakeClient({ needsYou: async () => data })}
      />,
    );
    const panel = await openTab(label);
    const article = await panel.findByRole("article", { name: row });
    expect(article.hasAttribute("data-needs-row")).toBe(true);
    // Same group frame for every tab: a section with a heading bar.
    const group = article.closest("section.needs-group");
    expect(group?.querySelector("header > h2")).toBeTruthy();
    // Left: the card reference first, then the typed item id.
    const ids = article.querySelector("[data-needs-row-ids]") as HTMLElement;
    const tags = [...ids.querySelectorAll(".id-tag")].map((e) =>
      e.textContent?.replace(/\s+/g, ""),
    );
    expect(tags[0]).toMatch(/^C-\d/);
    expect(tags[1]).toMatch(/^[QHN]-\d/);
    expect(article.querySelector("[data-needs-row-title]")).toBeTruthy();
    // Right: the primary action, a shared button, is the trailing control.
    const action = article.querySelector("[data-needs-row-action]");
    const button = action?.querySelector("button");
    expect(button?.getAttribute("data-ui")).toBe("button");
    expect(action?.nextElementSibling).toBeNull();
  },
);

test("C-459: details fold under one disclosure and 处理 opens them at the first control", async () => {
  const recordDecision = vi.fn<CardiganClient["recordDecision"]>(
    async () => undefined,
  );
  render(
    <NeedsYouPage
      projectId="p-1"
      client={fakeClient({ needsYou: async () => data, recordDecision })}
    />,
  );
  const panel = await openTab("待拍板");
  const article = within(
    await panel.findByRole("article", { name: "拍板 Q-1" }),
  );
  const toggle = article.getByRole("button", { name: "详情 拍板 Q-1" });
  const body = toggle
    .closest("article")
    ?.querySelector("[data-needs-row-body]") as HTMLElement;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.getAttribute("aria-controls")).toBe(body.id);
  expect(body.hasAttribute("data-open")).toBe(false);
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(body.hasAttribute("data-open")).toBe(true);
  fireEvent.click(toggle);
  expect(body.hasAttribute("data-open")).toBe(false);
  fireEvent.click(article.getByRole("button", { name: "处理 Q-1" }));
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  await waitFor(() => expect(body.contains(document.activeElement)).toBe(true));
  // The write itself is unchanged: same option, quote and decision id.
  fireEvent.click(article.getByRole("radio", { name: /灰度发布/ }));
  changeControl(article.getByLabelText("Q-1 原话或补充说明"), {
    target: { value: "先灰度" },
  });
  fireEvent.click(article.getByRole("button", { name: "按所选拍板" }));
  await waitFor(() => expect(recordDecision).toHaveBeenCalledTimes(1));
  expect(recordDecision.mock.calls[0]?.slice(0, 4)).toEqual([
    "p-1",
    "Q-1",
    "a",
    "先灰度",
  ]);
});

test("C-459: merge, action, later and notice writes keep their calls behind the shared row", async () => {
  const recordDecision = vi.fn<CardiganClient["recordDecision"]>(
    async () => undefined,
  );
  const completeAction = vi.fn<CardiganClient["completeAction"]>(
    async () => undefined,
  );
  const cancelAction = vi.fn<CardiganClient["cancelAction"]>(
    async () => undefined,
  );
  const markNoticesRead = vi.fn<CardiganClient["markNoticesRead"]>(
    async () => undefined,
  );
  render(
    <NeedsYouPage
      projectId="p-1"
      client={fakeClient({
        needsYou: async () => data,
        recordDecision,
        completeAction,
        cancelAction,
        markNoticesRead,
      })}
    />,
  );
  let panel = await openTab("合并确认");
  let row = within(await panel.findByRole("article", { name: "合并确认 Q-3" }));
  expect(row.getByText("可合并")).toBeTruthy();
  fireEvent.click(row.getByRole("button", { name: "处理 Q-3" }));
  fireEvent.click(row.getByRole("button", { name: "确认合并", exact: true }));
  await waitFor(() => expect(recordDecision).toHaveBeenCalledTimes(1));
  expect(recordDecision.mock.calls[0]?.slice(0, 3)).toEqual([
    "p-1",
    "Q-3",
    "merge",
  ]);

  panel = await openTab("待你执行");
  row = within(await panel.findByRole("article", { name: "执行 H-1" }));
  fireEvent.click(row.getByRole("button", { name: "处理 H-1" }));
  changeControl(row.getByLabelText("H-1 执行结果"), {
    target: { value: "已创建" },
  });
  fireEvent.click(row.getByRole("button", { name: "确认已完成" }));
  await waitFor(() => expect(completeAction).toHaveBeenCalledTimes(1));
  expect(completeAction.mock.calls[0]?.slice(0, 3)).toEqual([
    "p-1",
    "H-1",
    "已创建",
  ]);

  panel = await openTab("稍后");
  row = within(await panel.findByRole("article", { name: "稍后 H-2" }));
  fireEvent.click(row.getByRole("button", { name: "关闭 H-2（不再需要）" }));
  const dialog = within(screen.getByRole("dialog"));
  changeControl(dialog.getByLabelText("关闭理由（必填）"), {
    target: { value: "不再需要" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "确认关闭" }));
  await waitFor(() => expect(cancelAction).toHaveBeenCalledTimes(1));
  expect(cancelAction.mock.calls[0]?.slice(0, 3)).toEqual([
    "p-1",
    "H-2",
    "不再需要",
  ]);

  panel = await openTab("知会");
  row = within(await panel.findByRole("article", { name: "知会 Q-7" }));
  fireEvent.click(row.getByRole("button", { name: "标为已读" }));
  await waitFor(() =>
    expect(markNoticesRead).toHaveBeenCalledWith("p-1", ["N-1"]),
  );
});

test("C-459: an empty tab shows only the shortest fact", async () => {
  render(
    <NeedsYouPage
      projectId="p-1"
      client={fakeClient({
        needsYou: async () => ({
          decisions: [],
          human_actions: [],
          incidents: [],
        }),
      })}
    />,
  );
  const panel = await openTab("待拍板");
  expect(await panel.findByText("没有需要你处理的事")).toBeTruthy();
  expect(panel.queryByText(/会出现在这里/)).toBeNull();
});
