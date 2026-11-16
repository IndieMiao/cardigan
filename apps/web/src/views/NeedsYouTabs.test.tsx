// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "../App.js";
import {
  HttpCardiganClient,
  type NeedsCounts,
  type NeedsDecision,
  type NeedsPage,
  type NeedsTab,
  type NoticeView,
} from "../api.js";
import { fakeClient } from "../testing/fixtures.js";
import { NeedsYouPage } from "./NeedsYouPage.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});
const empty: NeedsPage = { decisions: [], human_actions: [], incidents: [] };
const blankCounts: NeedsCounts = {
  total_pending: 0,
  tabs: {
    decisions: { count: 0, attention: 0 },
    merges: { count: 0, attention: 0 },
    actions: { count: 0, attention: 0 },
    later: { count: 0, attention: 0 },
    notices: { count: 0, attention: 0 },
  },
};
const counts: NeedsCounts = {
  ...blankCounts,
  total_pending: 1,
  tabs: {
    ...blankCounts.tabs,
    decisions: { count: 1, attention: 1 },
    actions: { count: 1, attention: 1 },
  },
};
const decision: NeedsDecision = {
  id: "Q-1",
  card_id: null,
  affected_cards: [],
  related_cards: [],
  question: "选择方案",
  context: "合成正文",
  why: "待决定",
  status: "open",
  decider: "human",
  blocking: true,
  category: "general",
  trigger: null,
  assignment_id: null,
  waited_ms: 0,
  merge_confirmation: null,
  options: [{ key: "go", description: "继续", impact: "继续执行" }],
  recommended: "go",
};
const decisionPage = { ...empty, decisions: [decision] };
const actionPage: NeedsPage = {
  ...empty,
  human_actions: [
    {
      id: "H-1",
      card_id: null,
      why: "需要操作",
      instructions: "连接设备",
      expected_return: "结果",
      due: null,
      waited_ms: 0,
      blocked_work_items: [],
    },
  ],
};
const tab = (name: string) =>
  screen.getByRole("tab", { name: new RegExp(`^${name}`) });

test("the App loads only counts outside Needs You and then only the selected tab", async () => {
  const needsYou = vi
    .fn()
    .mockRejectedValue(new Error("Full page must not load"));
  const needsYouCounts = vi.fn().mockResolvedValue(counts);
  const needsYouSection = vi.fn().mockResolvedValue(decisionPage);
  window.location.hash = "#/p/p-1/cards";
  render(
    <App client={fakeClient({ needsYou, needsYouCounts, needsYouSection })} />,
  );
  await waitFor(() => expect(needsYouCounts).toHaveBeenCalledTimes(1));
  expect(needsYouSection).not.toHaveBeenCalled();
  act(() => {
    window.location.hash = "#/p/p-1/needs-you";
  });
  await screen.findByRole("article", { name: "拍板 Q-1" });
  expect(needsYouSection).toHaveBeenCalledTimes(1);
  expect(needsYouSection).toHaveBeenLastCalledWith(
    "p-1",
    "decisions",
    expect.any(String),
  );
  expect(needsYou).not.toHaveBeenCalled();
  expect(screen.getAllByRole("tab")).toHaveLength(5);
});

test("tabs load on selection, preserve drafts and refresh only the active panel", async () => {
  const needsYouSection = vi.fn(async (_p: string, section: NeedsTab) =>
    section === "actions" ? actionPage : decisionPage,
  );
  const client = fakeClient({
    needsYouCounts: async () => counts,
    needsYouSection,
  });
  const view = render(<NeedsYouPage client={client} projectId="p-1" />);
  const quote = await screen.findByLabelText("Q-1 原话或补充说明");
  fireEvent.change(quote, { target: { value: "保留这段草稿" } });
  expect(tab("待拍板").classList.contains("has-attention")).toBe(true);
  fireEvent.click(tab("待你执行"));
  await screen.findByText("连接设备");
  expect(screen.queryByRole("article", { name: "拍板 Q-1" })).toBeNull();
  view.rerender(<NeedsYouPage client={client} projectId="p-1" revision={1} />);
  await waitFor(() => expect(needsYouSection).toHaveBeenCalledTimes(3));
  expect(needsYouSection.mock.calls.map((c) => c[1])).toEqual([
    "decisions",
    "actions",
    "actions",
  ]);
  fireEvent.click(tab("待拍板"));
  await waitFor(() => expect(needsYouSection).toHaveBeenCalledTimes(4));
  expect(
    (screen.getByLabelText("Q-1 原话或补充说明") as HTMLTextAreaElement).value,
  ).toBe("保留这段草稿");
  fireEvent.keyDown(tab("待拍板"), { key: "End" });
  expect(document.activeElement).toBe(tab("知会"));
  expect(tab("知会").getAttribute("aria-selected")).toBe("true");
});

test("counts pick the first nonempty tab, and empty tabs stay selectable after count changes", async () => {
  let summary = {
    ...blankCounts,
    tabs: { ...blankCounts.tabs, later: { count: 1, attention: 0 } },
  };
  const needsYouSection = vi.fn().mockResolvedValue(empty);
  const client = fakeClient({
    needsYouCounts: async () => summary,
    needsYouSection,
  });
  const view = render(<NeedsYouPage client={client} projectId="p-1" />);
  await screen.findByRole("tabpanel", { name: /^稍后/ });
  expect(needsYouSection).toHaveBeenCalledWith("p-1", "later", undefined);
  fireEvent.click(tab("合并确认"));
  await screen.findByText(/没有需要你处理的事/);
  summary = {
    ...counts,
    tabs: { ...counts.tabs, later: { count: 0, attention: 0 } },
  };
  view.rerender(<NeedsYouPage client={client} projectId="p-1" revision={1} />);
  await waitFor(() => expect(tab("待拍板").textContent).toContain("1"));
  expect(tab("合并确认").getAttribute("aria-selected")).toBe("true");
});

test("late section responses cannot replace another tab or another project", async () => {
  let finish: (page: NeedsPage) => void = () => {};
  const client = fakeClient({
    needsYouCounts: async () => counts,
    needsYouSection: async (project, section) =>
      project === "p-1" && section === "decisions"
        ? new Promise<NeedsPage>((resolve) => {
            finish = resolve;
          })
        : { ...decisionPage, decisions: [{ ...decision, question: "新项目" }] },
  });
  const view = render(<NeedsYouPage client={client} projectId="p-1" />);
  await screen.findByRole("tab", { name: /^待你执行/ });
  fireEvent.click(tab("待你执行"));
  await screen.findByText("新项目");
  await act(async () => finish(decisionPage));
  expect(screen.queryByRole("heading", { name: "选择方案" })).toBeNull();
  fireEvent.click(tab("待拍板"));
  view.rerender(<NeedsYouPage client={client} projectId="p-2" />);
  await screen.findByText("新项目");
  await act(async () => finish(decisionPage));
  expect(screen.queryByRole("heading", { name: "选择方案" })).toBeNull();
});

test("count failures do not fetch details and panel failures can be retried without a full read", async () => {
  const needsYouCounts = vi
    .fn()
    .mockRejectedValueOnce(new Error("计数离线"))
    .mockResolvedValue(blankCounts);
  const needsYouSection = vi
    .fn()
    .mockRejectedValueOnce(new Error("内容离线"))
    .mockResolvedValue(empty);
  render(
    <NeedsYouPage
      client={fakeClient({ needsYouCounts, needsYouSection })}
      projectId="p-1"
    />,
  );
  await screen.findByText("计数离线");
  expect(needsYouSection).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByText("内容离线");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByText(/没有需要你处理的事/);
  expect(needsYouSection).toHaveBeenCalledTimes(2);
});

test("the HTTP client uses separate count and section URLs", async () => {
  const fetcher = vi.fn(
    async (url: RequestInfo | URL) =>
      new Response(
        JSON.stringify(String(url).endsWith("/counts") ? blankCounts : empty),
      ),
  );
  render(
    <NeedsYouPage
      client={new HttpCardiganClient(fetcher as typeof fetch)}
      projectId="p/a"
    />,
  );
  await screen.findByText(/没有需要你处理的事/);
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "/api/projects/p%2Fa/needs-you/counts",
    "/api/projects/p%2Fa/needs-you?section=decisions",
  ]);
});

test.each([
  ["auto_merge", "merge", "自动合并（auto_merge）"],
  ["timed_merge", "merge", "超时自动合并"],
  ["system", "decision", "系统"],
  ["system_merge", "merge", "系统自动合并"],
  ["pm", "decision", "PM 代拍"],
] as const)(
  "notice source %s uses the correct label",
  async (source, kind, label) => {
    const notice: NoticeView = {
      id: "n-1",
      kind,
      source,
      resolved_by: source === "pm" ? "pm" : "system",
      card_id: null,
      decision_id: null,
      question: "",
      body: "合成知会",
      option: "merge",
      proxy_authority: null,
      at: "2026-01-01T00:00:00Z",
      read: false,
    };
    render(
      <NeedsYouPage
        client={fakeClient({
          needsYou: async () => ({ ...empty, notices: [notice] }),
        })}
        projectId="p-1"
      />,
    );
    const panel = await screen.findByRole("tabpanel", { name: /^知会/ });
    expect(await within(panel).findByText(label)).toBeTruthy();
    if (source !== "timed_merge")
      expect(within(panel).queryByText("超时自动合并")).toBeNull();
    if (source !== "pm")
      expect(within(panel).queryByText("PM 代拍")).toBeNull();
  },
);
