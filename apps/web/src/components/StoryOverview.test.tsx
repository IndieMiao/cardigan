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
import type { CardDetail, CardListItem, CardStatus } from "../api.js";
import { routeHash } from "../route.js";
import {
  attachment,
  card,
  cardDetail,
  fakeClient,
  timelineEntry,
} from "../testing/fixtures.js";
import { CardDetailPage } from "../views/CardDetailPage.js";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);
afterEach(() => {
  cleanup();
  window.location.hash = "";
});

const counts = (children: { status: CardStatus }[]) => {
  const result: Record<CardStatus, number> = {
    backlog: 0,
    todo: 0,
    in_progress: 0,
    review: 0,
    awaiting_merge: 0,
    done: 0,
    cancelled: 0,
  };
  for (const child of children) result[child.status]++;
  return result;
};
const children: { id: string; title: string; status: CardStatus }[] = [
  { id: "C-2", title: "数据模型", status: "done" },
  { id: "C-3", title: "接口", status: "in_progress" },
  { id: "C-4", title: "界面", status: "todo" },
];
const rows: CardListItem[] = children.map((child) => ({
  ...card,
  ...child,
  ...(child.id === "C-4"
    ? {
        dependency: {
          predecessors: [
            {
              id: "C-3",
              title: "接口",
              status: "in_progress",
              satisfied: false,
            },
            // Outside the story: belongs to C-4's own graph, not this one.
            { id: "C-9", title: "外部", status: "todo", satisfied: false },
          ],
          successors: [],
          waiting_on: ["C-3", "C-9"],
          critical_path_length: 2,
        },
      }
    : {}),
}));
function storyDetail(
  overrides: {
    children?: typeof children;
    summary?: boolean;
    story?: NonNullable<CardDetail["card"]["story"]>;
  } = {},
  extra: Partial<CardDetail> = {},
): CardDetail {
  const kids = overrides.children ?? children;
  return cardDetail({
    card: {
      ...card,
      title: "需求：导出报表",
      goal: "希望能把看板导出成表格。",
      acceptance_criteria: [],
      story: overrides.story ?? {
        discussion_rounds: 1,
        ...(overrides.summary ? { summary_entry_id: "C-1#9" } : {}),
        question_groups: [
          {
            id: "C-1#3",
            questions: [
              { question: "格式？", recommended: "CSV", impact: "决定依赖" },
              {
                question: "范围？",
                recommended: "当前筛选",
                impact: "数据量",
                resolution: {
                  source: "answer",
                  value: "全部",
                  entry_id: "C-1#4",
                },
              },
            ],
          },
        ],
      },
      story_progress: {
        children: kids,
        counts: counts(kids),
        finished: kids.filter((c) => ["done", "cancelled"].includes(c.status))
          .length,
        total: kids.length,
      },
    },
    work_items: [],
    deliveries: [],
    review_matrix: [],
    attachments: [],
    ...(overrides.summary
      ? {
          timeline: [
            timelineEntry({
              id: "C-1#9",
              event_seq: 9,
              author_display: "林黛玉",
              body: "三张子卡都已结束，导出功能与原话一致。",
            }),
          ],
        }
      : {}),
    ...extra,
  });
}

test("a story overview shows the request, a child graph, empty plan and summary places, and no write controls", async () => {
  const cards = vi.fn(async () => ({
    project_id: "p-1",
    filter: "all" as const,
    cards: rows,
    counts: { total: rows.length, needs_me: 0, agent: 0 },
  }));
  render(
    <CardDetailPage
      client={fakeClient({ card: async () => storyDetail(), cards })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const request = await screen.findByRole("region", { name: "原始需求" });
  expect(within(request).getByText("希望能把看板导出成表格。")).toBeTruthy();
  // No acceptance criteria were written: no empty heading for them.
  expect(within(request).queryByText(/验收标准/)).toBeNull();
  expect(within(request).getByText("没有附件")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "目标和验收标准" })).toBeNull();

  const progress = screen.getByRole("region", { name: "子卡进度" });
  expect(within(progress).getByText("已结束 1/3")).toBeTruthy();
  expect(within(progress).getByText("进行中 1")).toBeTruthy();
  const graph = await within(progress).findByRole("list", {
    name: "子卡进度图",
  });
  // The children were read once through the shared, scope-checked list.
  expect(cards).toHaveBeenCalledWith("p-1", "all", { ids: "C-2,C-3,C-4" });
  await waitFor(() =>
    expect(
      graph.parentElement?.querySelector('[data-edge="C-3>C-4"]'),
    ).not.toBeNull(),
  );
  const svg = graph.parentElement as HTMLElement;
  expect(
    [...svg.querySelectorAll("[data-edge]")].map((p) => [
      p.getAttribute("data-edge"),
      p.getAttribute("data-edge-kind"),
      p.hasAttribute("marker-end"),
    ]),
  ).toEqual([
    ["C-1>C-2", "parent", false],
    ["C-1>C-3", "parent", false],
    ["C-3>C-4", "dependency", true],
  ]);
  // C-9 is outside the story and stays out of this graph.
  expect(graph.querySelector('[data-node="C-9"]')).toBeNull();
  const current = graph.querySelector('[aria-current="page"]');
  expect(current?.textContent).toContain("C-1");
  expect(graph.textContent).toContain("父卡 C-1；前置 C-3");
  expect(graph.textContent).toContain("子卡 C-2、C-3、C-4");

  // A child opens its peek; only the peek's action leaves the page.
  const node = within(graph).getByRole("button", { name: /C-4/ });
  fireEvent.click(node);
  const peek = await screen.findByRole("dialog", { name: "卡片 C-4" });
  expect(within(peek).getByText("子卡 · 前置 C-3")).toBeTruthy();
  expect(
    within(peek).getByRole("link", { name: "打开卡片" }).getAttribute("href"),
  ).toBe(routeHash({ kind: "card", projectId: "p-1", cardId: "C-4" }));

  const plan = screen.getByRole("region", { name: "拆解方案" });
  expect(within(plan).getByText("没有拆解方案")).toBeTruthy();
  expect(within(plan).queryAllByRole("button")).toHaveLength(0);
  const summary = screen.getByRole("region", { name: "对照总结" });
  expect(within(summary).getByText("没有总结")).toBeTruthy();
  const discussion = screen.getByRole("region", { name: "讨论" });
  expect(within(discussion).getByText("需求澄清 1 轮")).toBeTruthy();
  expect(within(discussion).getByText("1 题待答")).toBeTruthy();
  // Nothing on the overview submits a plan, creates children, writes change
  // requests or confirms completion.
  for (const name of [/确认/, /开卡/, /提交/, /修改意见/, /标记完成/])
    expect(
      within(screen.getByRole("tabpanel", { name: /概览/ })).queryByRole(
        "button",
        { name },
      ),
    ).toBeNull();
  fireEvent.click(within(discussion).getByRole("button", { name: "查看讨论" }));
  expect(
    screen.getByRole("tab", { name: /时间线/ }).getAttribute("aria-selected"),
  ).toBe("true");
});

test("a story without children shows the empty state and makes no list read", async () => {
  const cards = vi.fn();
  render(
    <CardDetailPage
      client={fakeClient({
        card: async () =>
          storyDetail({ children: [], story: { discussion_rounds: 0 } }),
        cards,
      })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const progress = await screen.findByRole("region", { name: "子卡进度" });
  expect(within(progress).getByText("没有子卡")).toBeTruthy();
  expect(within(progress).queryByRole("list")).toBeNull();
  expect(cards).not.toHaveBeenCalled();
  expect(
    within(screen.getByRole("region", { name: "讨论" })).getByText(
      "没有问题清单",
    ),
  ).toBeTruthy();
});

test("a failed child read keeps the parent lines and offers a retry", async () => {
  let fail = true;
  const cards = vi.fn(async () => {
    if (fail) throw new Error("网络断开");
    return {
      project_id: "p-1",
      filter: "all" as const,
      cards: rows,
      counts: { total: rows.length, needs_me: 0, agent: 0 },
    };
  });
  render(
    <CardDetailPage
      client={fakeClient({ card: async () => storyDetail(), cards })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const progress = await screen.findByRole("region", { name: "子卡进度" });
  expect((await within(progress).findByRole("alert")).textContent).toContain(
    "读取子卡依赖失败",
  );
  const graph = within(progress).getByRole("list", { name: "子卡进度图" });
  expect(graph.querySelectorAll("[data-node]")).toHaveLength(4);
  fail = false;
  fireEvent.click(within(progress).getByRole("button", { name: "重试" }));
  await waitFor(() => expect(within(progress).queryByRole("alert")).toBeNull());
  await waitFor(() =>
    expect(
      within(progress)
        .getByRole("list", { name: "子卡进度图" })
        .parentElement?.querySelector('[data-edge="C-3>C-4"]'),
    ).not.toBeNull(),
  );
});

test("the summary shows its text and author, and the overview reads the attachments panel", async () => {
  const detail = storyDetail({ summary: true });
  const cardPanel = vi.fn(async () => ({ attachments: [attachment({})] }));
  render(
    <CardDetailPage
      client={fakeClient({
        card: async () => ({
          ...detail,
          overview: {
            work_count: 0,
            completed_work_count: 0,
            verifiers: [],
            attachment_count: 1,
            waiting_delivery: [],
            conclusion_reviews: [],
          },
        }),
        cardPanel,
        cards: async () => ({
          project_id: "p-1",
          filter: "all" as const,
          cards: rows,
          counts: { total: rows.length, needs_me: 0, agent: 0 },
        }),
      })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const summary = await screen.findByRole("region", { name: "对照总结" });
  expect(
    within(summary).getByText("三张子卡都已结束，导出功能与原话一致。"),
  ).toBeTruthy();
  expect(within(summary).getByText("林黛玉")).toBeTruthy();
  expect(
    within(summary).getByRole("link", { name: /C-1#9/ }).getAttribute("href"),
  ).toBe(
    routeHash({
      kind: "card",
      projectId: "p-1",
      cardId: "C-1",
      anchor: "entry-C-1#9",
    }),
  );
  const request = screen.getByRole("region", { name: "原始需求" });
  expect(
    within(request).getByRole("heading", { name: "附件（1）" }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(request.querySelector("#attachment-F-1")).not.toBeNull(),
  );
  expect(cardPanel).toHaveBeenCalledWith("p-1", "C-1", "attachments");
});

test("an ordinary card keeps its goal section and shows no story frame", async () => {
  const cards = vi.fn();
  render(
    <CardDetailPage
      client={fakeClient({ card: async () => cardDetail(), cards })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  await screen.findByRole("region", { name: "目标和验收标准" });
  for (const name of ["原始需求", "子卡进度", "拆解方案", "对照总结", "讨论"])
    expect(screen.queryByRole("region", { name })).toBeNull();
  expect(cards).not.toHaveBeenCalled();
});
