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
import {
  ApiError,
  type CardDetail,
  type CardListItem,
  type CardStatus,
} from "../api.js";
import { guardLeave } from "../leave-guard.js";
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
const listPage = (cards: CardListItem[]) => ({
  project_id: "p-1",
  filter: "all" as const,
  cards,
  counts: { total: cards.length, needs_me: 0, agent: 0 },
});
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

test("a story overview lists the request, each child and each question, with no empty sections and no write controls", async () => {
  const cards = vi.fn(async () => listPage(rows));
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
  expect(screen.queryByRole("region", { name: "验收标准" })).toBeNull();
  expect(screen.queryByText(/验收标准/)).toBeNull();
  // C-699: attachments live in their own tab, not in the request.
  expect(within(request).queryByText(/附件/)).toBeNull();
  expect(screen.queryByRole("region", { name: "目标" })).toBeNull();
  // The children follow the request directly, then the questions.
  expect(request.nextElementSibling?.getAttribute("aria-label")).toBe(
    "子卡进度",
  );
  expect(
    request.nextElementSibling?.nextElementSibling?.getAttribute("aria-label"),
  ).toBe("问题清单");

  // C-771 (design §4.2): one row per child: id, title and status.
  const progress = screen.getByRole("region", { name: "子卡进度" });
  const list = within(progress).getByRole("list", { name: "子卡" });
  const items = within(list).getAllByRole("listitem");
  expect(items.map((item) => item.textContent)).toEqual([
    "C-2数据模型已完成",
    "C-3接口进行中",
    "C-4界面待开始",
  ]);
  expect(
    within(items[2] as HTMLElement)
      .getByRole("link", { name: /C-4/ })
      .getAttribute("href"),
  ).toBe(routeHash({ kind: "card", projectId: "p-1", cardId: "C-4" }));
  // The list is the story's own record: no graph and no extra list read.
  expect(
    within(progress).queryByRole("list", { name: "子卡进度图" }),
  ).toBeNull();
  expect(cards).not.toHaveBeenCalled();

  // C-771: every question, numbered; open ones show the default, answered
  // ones the answer. No discussion summary or 查看讨论 button.
  const questions = screen.getByRole("region", { name: "问题清单" });
  const asked = within(questions).getByRole("list", { name: "问题" });
  expect(asked.tagName).toBe("OL");
  expect(
    within(asked)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["格式？建议：CSV", "范围？已回答：全部"]);
  expect(screen.queryByRole("region", { name: "讨论" })).toBeNull();
  expect(screen.queryByRole("button", { name: "查看讨论" })).toBeNull();

  // C-699: without a plan or a summary there is no section for them.
  expect(screen.queryByRole("region", { name: "拆解方案" })).toBeNull();
  expect(screen.queryByRole("region", { name: "对照总结" })).toBeNull();
  expect(screen.queryByText(/没有拆解方案|没有总结|没有附件/u)).toBeNull();
  // Nothing on the overview submits a plan, creates children, writes change
  // requests, answers questions or confirms completion.
  const overview = screen.getByRole("tabpanel", { name: /概览/ });
  for (const name of [/确认/, /开卡/, /提交/, /修改意见/, /标记完成/, /按默认/])
    expect(within(overview).queryByRole("button", { name })).toBeNull();
  expect(within(overview).queryByRole("textbox")).toBeNull();
});

test("several checklists list their questions apart, each numbered from 1", async () => {
  render(
    <CardDetailPage
      client={fakeClient({
        card: async () =>
          storyDetail({
            story: {
              discussion_rounds: 2,
              question_groups: [
                {
                  id: "C-1#3",
                  questions: [
                    {
                      question: "格式？",
                      recommended: "CSV",
                      impact: "依赖",
                      resolution: {
                        source: "accepted_default",
                        value: "CSV",
                        entry_id: "C-1#5",
                      },
                    },
                  ],
                },
                { id: "C-1#6", questions: [] },
                {
                  id: "C-1#7",
                  questions: [
                    { question: "要表头吗？", recommended: "要", impact: "" },
                    {
                      question: "文件名？",
                      recommended: "按日期",
                      impact: "",
                      resolution: {
                        source: "proposal_default",
                        value: "按日期",
                        entry_id: "C-1#8",
                      },
                    },
                  ],
                },
              ],
            },
          }),
      })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const questions = await screen.findByRole("region", { name: "问题清单" });
  // An empty checklist adds no list.
  const lists = within(questions).getAllByRole("list");
  expect(lists.map((l) => l.getAttribute("aria-label"))).toEqual([
    "问题清单 C-1#3",
    "问题清单 C-1#7",
  ]);
  expect(
    lists.map((l) =>
      within(l)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ),
  ).toEqual([
    ["格式？已接受默认：CSV"],
    ["要表头吗？建议：要", "文件名？未答，方案按默认：按日期"],
  ]);
});

test("a story without children or questions shows no empty sections and makes no list read", async () => {
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
  await screen.findByRole("region", { name: "原始需求" });
  for (const name of ["子卡进度", "问题清单", "拆解方案", "对照总结"])
    expect(screen.queryByRole("region", { name })).toBeNull();
  expect(screen.queryByText(/没有子卡|没有问题清单/u)).toBeNull();
  expect(cards).not.toHaveBeenCalled();
});

test("the summary shows its text and author; the overview reads no attachments panel", async () => {
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
  // C-699: attachments are listed once, in their tab.
  const request = screen.getByRole("region", { name: "原始需求" });
  expect(request.querySelector("#attachment-F-1")).toBeNull();
  expect(cardPanel).not.toHaveBeenCalledWith("p-1", "C-1", "attachments");
  expect(screen.getByRole("tab", { name: /附件/ })).toBeTruthy();
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
  await screen.findByRole("region", { name: "目标" });
  for (const name of ["原始需求", "子卡进度", "拆解方案", "对照总结", "讨论"])
    expect(screen.queryByRole("region", { name })).toBeNull();
  expect(cards).not.toHaveBeenCalled();
});

const rowText = (id: string) =>
  [...document.querySelectorAll('section[aria-label="子卡进度"] li')].find(
    (row) => row.textContent?.startsWith(id),
  )?.textContent ?? "";

test("a child's own event refreshes the open story; an unrelated card's does not", async () => {
  let status: CardStatus = "in_progress";
  let events: string[] = [];
  const card = vi.fn(async () =>
    storyDetail({
      children: children.map((c) => (c.id === "C-3" ? { ...c, status } : c)),
    }),
  );
  const client = fakeClient({ card, cards: async () => listPage(rows) });
  // Like useProjectStream: count the events of the card or any related card.
  const props = () => ({
    client,
    projectId: "p-1",
    cardId: "C-1",
    cardRevision: (id: string, related: readonly string[]) =>
      events.filter((e) => e === id || related.includes(e)).length,
  });
  const { rerender } = render(<CardDetailPage {...props()} />);
  await waitFor(() => expect(rowText("C-3")).toContain("进行中"));
  expect(card).toHaveBeenCalledTimes(1);

  events = ["C-99"];
  rerender(<CardDetailPage {...props()} />);
  await new Promise((r) => setTimeout(r, 20));
  expect(card).toHaveBeenCalledTimes(1);

  status = "review";
  events = ["C-99", "C-3"];
  rerender(<CardDetailPage {...props()} />);
  await waitFor(() => expect(rowText("C-3")).toContain("审核中"));
  expect(card).toHaveBeenCalledTimes(2);
});

test("a summary outside the loaded timeline is read by its anchor alone", async () => {
  const head = storyDetail(
    { story: { discussion_rounds: 0, summary_entry_id: "C-1#9" } },
    {
      timeline: [timelineEntry({ id: "C-1#99", event_seq: 99 })],
      counts: { timeline: 99, deliveries: 0, reviews: 0, open_decisions: 0 },
    },
  );
  const card = vi.fn(
    async (_p: string, _id: string, options?: { at?: string }) =>
      options?.at === "entry-C-1#9"
        ? {
            ...head,
            timeline: [
              timelineEntry({
                id: "C-1#9",
                event_seq: 9,
                author_display: "林黛玉",
                body: "子卡都已结束，与原话一致。",
              }),
            ],
          }
        : head,
  );
  render(
    <CardDetailPage
      client={fakeClient({ card, cards: async () => listPage(rows) })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const summary = await screen.findByRole("region", { name: "对照总结" });
  await within(summary).findByText("子卡都已结束，与原话一致。");
  expect(within(summary).getByText("林黛玉")).toBeTruthy();
  expect(card).toHaveBeenCalledWith("p-1", "C-1", {
    at: "entry-C-1#9",
    limit: 1,
  });
  // The page's own timeline read keeps its window; the reader is not moved.
  expect(card.mock.calls[0]?.[2]).toEqual({ limit: 20 });
  expect(window.location.hash).toBe("");
});

test("a failed summary read says so and retries", async () => {
  let fail = true;
  const head = storyDetail(
    { story: { discussion_rounds: 0, summary_entry_id: "C-1#9" } },
    { timeline: [] },
  );
  const card = vi.fn(
    async (_p: string, _id: string, options?: { at?: string }) => {
      if (!options?.at) return head;
      if (fail) throw new Error("网络断开");
      return {
        ...head,
        timeline: [
          timelineEntry({ id: "C-1#9", event_seq: 9, body: "总结正文" }),
        ],
      };
    },
  );
  render(
    <CardDetailPage
      client={fakeClient({ card, cards: async () => listPage(rows) })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const summary = await screen.findByRole("region", { name: "对照总结" });
  expect((await within(summary).findByRole("alert")).textContent).toContain(
    "读取总结失败",
  );
  fail = false;
  fireEvent.click(within(summary).getByRole("button", { name: "重试" }));
  await within(summary).findByText("总结正文");
  expect(within(summary).queryByRole("alert")).toBeNull();
});

test("the child list leaves out the story itself and lists a repeated child once", async () => {
  const kids = [
    { id: "C-1", title: "需求：导出报表", status: "done" as const },
    ...children,
    { id: "C-3", title: "接口", status: "in_progress" as const },
  ];
  render(
    <CardDetailPage
      client={fakeClient({ card: async () => storyDetail({ children: kids }) })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const list = await screen.findByRole("list", { name: "子卡" });
  expect(
    within(list)
      .getAllByRole("listitem")
      .map((item) => item.textContent?.slice(0, 3)),
  ).toEqual(["C-2", "C-3", "C-4"]);
});

const proposal = (
  version: number,
  confirmed?: readonly string[],
): NonNullable<
  NonNullable<CardDetail["card"]["story"]>["proposals"]
>[number] => ({
  version,
  entry_id: `C-1#${10 + version}`,
  submitted_at: "2026-01-01T00:00:00.000Z",
  children: [
    {
      title: "导出接口",
      template_id: "dev",
      goal: "提供 CSV 导出。",
      acceptance_criteria: ["返回 CSV"],
      depends_on: [],
      priority: 3,
      owner_role: "coder",
    },
    {
      title: "导出按钮",
      template_id: "ui",
      goal: "在看板放导出按钮。",
      acceptance_criteria: ["按钮遵守界面规范"],
      depends_on: [1],
      depends_on_cards: ["C-9"],
      priority: 2,
      owner_role: "frontend_engineer",
    },
  ],
  ...(confirmed
    ? {
        confirmed: {
          at: "2026-01-01T00:00:00.000Z",
          entry_id: "C-1#20",
          card_ids: confirmed,
        },
      }
    : {}),
});
const proposalDetail = (
  proposals: ReturnType<typeof proposal>[],
  extra: Partial<CardDetail> = {},
) =>
  storyDetail(
    { children: [], story: { discussion_rounds: 0, proposals } },
    extra,
  );

test("the current proposal lists each child, folds its goal and confirms the version seen with one click", async () => {
  const confirm = vi.fn(async () => ({
    card_id: "C-1",
    version: 2,
    card_ids: ["C-5", "C-6"],
    replayed: false,
  }));
  let detail = proposalDetail([proposal(1), proposal(2)]);
  const card = vi.fn(async () => detail);
  render(
    <CardDetailPage
      client={fakeClient({ card, confirmStoryProposal: confirm })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const plan = await screen.findByRole("region", { name: "拆解方案" });
  // Only the newest version is shown and can be confirmed.
  expect(within(plan).getByText(/第 2 版/)).toBeTruthy();
  expect(within(plan).queryByText(/第 1 版/)).toBeNull();
  expect(within(plan).getByText("待确认")).toBeTruthy();
  expect(
    within(plan).getByText("模板 dev · 负责 coder · 优先级 高"),
  ).toBeTruthy();
  expect(
    within(plan).getByText(
      "模板 ui · 负责 frontend_engineer · 优先级 中 · 依赖 第 1 张、C-9",
    ),
  ).toBeTruthy();
  const folds = plan.querySelectorAll("details");
  expect(folds).toHaveLength(2);
  expect(folds[0]?.open).toBe(false);
  expect(within(folds[0] as HTMLElement).getByText("返回 CSV")).toBeTruthy();

  detail = proposalDetail([proposal(1), proposal(2, ["C-5", "C-6"])]);
  const before = card.mock.calls.length;
  fireEvent.click(
    within(plan).getByRole("button", { name: "确认开卡：拆解方案第 2 版" }),
  );
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  expect(confirm).toHaveBeenCalledWith("p-1", "C-1", 2, expect.any(String));
  // Success rereads the story: the children appear as links, no more buttons.
  await waitFor(() => expect(card.mock.calls.length).toBeGreaterThan(before));
  const after = await screen.findByRole("region", { name: "拆解方案" });
  await within(after).findByText("已开卡");
  expect(
    within(after).getByRole("link", { name: /C-6/ }).getAttribute("href"),
  ).toBe(routeHash({ kind: "card", projectId: "p-1", cardId: "C-6" }));
  expect(within(after).queryByRole("button", { name: /确认开卡/ })).toBeNull();
  expect(
    within(after).queryByRole("button", { name: "提修改意见" }),
  ).toBeNull();
});

test("a stale version says to refresh in place; other refusals keep the reason and the same key", async () => {
  let fail: Error = new ApiError(409, "stale_target", "已更新");
  const confirm = vi.fn(async () => {
    throw fail;
  });
  const card = vi.fn(async () => proposalDetail([proposal(1)]));
  render(
    <CardDetailPage
      client={fakeClient({ card, confirmStoryProposal: confirm })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const plan = await screen.findByRole("region", { name: "拆解方案" });
  const button = within(plan).getByRole("button", { name: /确认开卡/ });
  fireEvent.click(button);
  const alert = await within(plan).findByRole("alert");
  expect(alert.textContent).toContain("拆解方案已更新，请刷新后再确认");
  const reads = card.mock.calls.length;
  fireEvent.click(within(alert).getByRole("button", { name: "刷新" }));
  await waitFor(() => expect(card.mock.calls.length).toBeGreaterThan(reads));

  fail = new ApiError(
    400,
    "validation_failed",
    "第 2 张子卡「导出按钮」无法开出：缺少 repo",
  );
  fireEvent.click(
    within(await screen.findByRole("region", { name: "拆解方案" })).getByRole(
      "button",
      { name: /确认开卡/ },
    ),
  );
  const refused = await within(
    screen.getByRole("region", { name: "拆解方案" }),
  ).findByText(/开卡失败：.*第 2 张子卡「导出按钮」无法开出/);
  expect(refused).toBeTruthy();
  const keys = confirm.mock.calls.map((call) => (call as unknown[])[3]);
  expect(new Set(keys).size).toBe(1);
});

test("a change request replies to the proposal; leaving a written draft asks first", async () => {
  const addComment = vi.fn(async () => ({}) as never);
  render(
    <CardDetailPage
      client={fakeClient({
        card: async () => proposalDetail([proposal(3)]),
        addComment,
      })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const plan = await screen.findByRole("region", { name: "拆解方案" });
  fireEvent.click(within(plan).getByRole("button", { name: "提修改意见" }));
  const form = await screen.findByRole("form", {
    name: "对拆解方案第 3 版提修改意见",
  });
  const field = within(form).getByRole("textbox", { name: "修改意见" });
  // An empty draft closes without asking.
  fireEvent.click(within(form).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("form", { name: /提修改意见/ })).toBeNull();

  fireEvent.click(within(plan).getByRole("button", { name: "提修改意见" }));
  const again = await screen.findByRole("form", { name: /提修改意见/ });
  fireEvent.change(within(again).getByRole("textbox", { name: "修改意见" }), {
    target: { value: "导出按钮先不做" },
  });
  expect(field).toBeTruthy();
  // Following a link to another page asks; keeping the draft stays here.
  const away = document.createElement("a");
  away.href = routeHash({ kind: "cards", projectId: "p-1" });
  away.textContent = "看板";
  document.body.append(away);
  fireEvent.click(away);
  const ask = await screen.findByRole("dialog", {
    name: "放弃未发送的修改意见？",
  });
  fireEvent.click(within(ask).getByRole("button", { name: "继续编辑" }));
  expect(window.location.hash).not.toBe(away.getAttribute("href"));
  away.remove();

  fireEvent.click(within(again).getByRole("button", { name: "取消" }));
  const discard = await screen.findByRole("dialog", {
    name: "放弃未发送的修改意见？",
  });
  fireEvent.click(within(discard).getByRole("button", { name: "继续编辑" }));
  fireEvent.click(within(again).getByRole("button", { name: "发送意见" }));
  await waitFor(() => expect(addComment).toHaveBeenCalledTimes(1));
  expect(addComment).toHaveBeenCalledWith(
    "p-1",
    "C-1",
    {
      body: "对拆解方案第 3 版的修改意见：\n\n导出按钮先不做",
      reply_to: "C-1#13",
    },
    expect.any(String),
  );
  await waitFor(() =>
    expect(screen.queryByRole("form", { name: /提修改意见/ })).toBeNull(),
  );
});

test("after every child ended and the summary arrived, the person confirms the story done", async () => {
  const markCardDone = vi.fn(async () => {});
  const ended = children.map((c) => ({ ...c, status: "done" as const }));
  render(
    <CardDetailPage
      client={fakeClient({
        card: async () =>
          storyDetail(
            { children: ended, summary: true },
            { mark_done: { allowed: true, reason: null } },
          ),
        cards: async () => ({
          project_id: "p-1",
          filter: "all" as const,
          cards: rows,
          counts: { total: rows.length, needs_me: 0, agent: 0 },
        }),
        markCardDone,
      })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const summary = await screen.findByRole("region", { name: "对照总结" });
  fireEvent.click(within(summary).getByRole("button", { name: "确认完成" }));
  await waitFor(() => expect(markCardDone).toHaveBeenCalledTimes(1));
  expect(markCardDone).toHaveBeenCalledWith(
    "p-1",
    "C-1",
    "已对照总结 C-1#9 确认需求完成",
    [],
    expect.any(String),
    // V-2625: the server checks the summary the person saw is still current.
    "C-1#9",
  );
});

test("V-2625: no completion button until the summary text itself is read", async () => {
  const ended = children.map((c) => ({ ...c, status: "done" as const }));
  const detail = storyDetail(
    { children: ended, summary: true },
    { mark_done: { allowed: true, reason: null } },
  );
  render(
    <CardDetailPage
      client={fakeClient({
        // The summary sits outside the loaded window and its read never ends.
        card: async (_p, _c, options) =>
          options?.at ? new Promise(() => {}) : { ...detail, timeline: [] },
      })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const summary = await screen.findByRole("region", { name: "对照总结" });
  expect(
    within(summary).queryByRole("button", { name: "确认完成" }),
  ).toBeNull();
});

test("V-2625: a stale version disables confirmation and focus moves to 刷新", async () => {
  const confirm = vi.fn(async () => {
    throw new ApiError(409, "stale_target", "已更新");
  });
  render(
    <CardDetailPage
      client={fakeClient({
        card: async () => proposalDetail([proposal(1)]),
        confirmStoryProposal: confirm,
      })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const plan = await screen.findByRole("region", { name: "拆解方案" });
  const button = within(plan).getByRole("button", { name: /确认开卡/ });
  button.focus();
  fireEvent.click(button);
  const refresh = await within(plan).findByRole("button", { name: "刷新" });
  await waitFor(() => expect(document.activeElement).toBe(refresh));
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(confirm).toHaveBeenCalledTimes(1);
});

test("V-2625: a paused or unscheduled story offers change requests but no confirmation", async () => {
  for (const extra of [
    { status: "backlog" as const },
    {
      hold: {
        reason: "x",
        resume_condition: "y",
        set_by: "human",
        set_at: "2026-01-01T00:00:00.000Z",
      },
    },
  ]) {
    const detail = proposalDetail([proposal(1)]);
    render(
      <CardDetailPage
        client={fakeClient({
          card: async () =>
            ({ ...detail, card: { ...detail.card, ...extra } }) as CardDetail,
        })}
        projectId="p-1"
        cardId="C-1"
      />,
    );
    const plan = await screen.findByRole("region", { name: "拆解方案" });
    expect(within(plan).queryByRole("button", { name: /确认开卡/ })).toBeNull();
    expect(
      within(plan).getByRole("button", { name: "提修改意见" }),
    ).toBeTruthy();
    cleanup();
  }
});

test("V-2625: a draft survives a new version and closing the drawer asks first", async () => {
  let detail = proposalDetail([proposal(1)]);
  const view = render(
    <CardDetailPage
      client={fakeClient({ card: async () => detail })}
      projectId="p-1"
      cardId="C-1"
      revision={0}
    />,
  );
  const plan = await screen.findByRole("region", { name: "拆解方案" });
  fireEvent.click(within(plan).getByRole("button", { name: "提修改意见" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "修改意见" }), {
    target: { value: "先做接口" },
  });
  // The Office revises while the person is writing.
  detail = proposalDetail([proposal(1), proposal(2)]);
  view.rerender(
    <CardDetailPage
      client={fakeClient({ card: async () => detail })}
      projectId="p-1"
      cardId="C-1"
      revision={1}
    />,
  );
  await screen.findByRole("form", { name: "对拆解方案第 2 版提修改意见" });
  expect(
    (screen.getByRole("textbox", { name: "修改意见" }) as HTMLTextAreaElement)
      .value,
  ).toBe("先做接口");
  // The drawer's close path goes through the shared guard.
  const close = vi.fn();
  act(() => guardLeave(close));
  const ask = await screen.findByRole("dialog", {
    name: "放弃未发送的修改意见？",
  });
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(within(ask).getByRole("button", { name: "放弃修改" }));
  expect(close).toHaveBeenCalledTimes(1);
  // Discarded: the drawer is gone and the draft does not come back.
  view.unmount();
  render(
    <CardDetailPage
      client={fakeClient({ card: async () => detail })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const again = await screen.findByRole("region", { name: "拆解方案" });
  expect(
    within(again).getByRole("button", { name: "提修改意见" }),
  ).toBeTruthy();
  expect(screen.queryByRole("form", { name: /提修改意见/ })).toBeNull();
});

test("no completion button while a child is still open", async () => {
  render(
    <CardDetailPage
      client={fakeClient({
        card: async () =>
          storyDetail(
            { summary: true },
            { mark_done: { allowed: true, reason: null } },
          ),
      })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const summary = await screen.findByRole("region", { name: "对照总结" });
  expect(
    within(summary).queryByRole("button", { name: "确认完成" }),
  ).toBeNull();
});

test("V-2637: after a stale summary is refused, the refreshed summary can be confirmed with a new key", async () => {
  const ended = children.map((c) => ({ ...c, status: "done" as const }));
  let number = 9;
  const detail = () =>
    storyDetail(
      {
        children: ended,
        story: { discussion_rounds: 0, summary_entry_id: `C-1#${number}` },
      },
      {
        mark_done: { allowed: true, reason: null },
        timeline: [
          timelineEntry({
            id: `C-1#${number}`,
            event_seq: number,
            body: `Summary ${number}`,
          }),
        ],
      },
    );
  const markCardDone = vi.fn(async () => {
    if (number === 9) {
      number = 10;
      throw new ApiError(409, "stale_target", "已更新");
    }
  });
  render(
    <CardDetailPage
      client={fakeClient({ card: async () => detail(), markCardDone })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const area = await screen.findByRole("region", { name: "对照总结" });
  fireEvent.click(within(area).getByRole("button", { name: "确认完成" }));
  fireEvent.click(await within(area).findByRole("button", { name: "刷新" }));
  await within(area).findByText("Summary 10");
  const button = within(area).getByRole("button", { name: "确认完成" });
  expect(button.getAttribute("aria-disabled")).toBeNull();
  fireEvent.click(button);
  await waitFor(() => expect(markCardDone).toHaveBeenCalledTimes(2));
  const calls = markCardDone.mock.calls as unknown as unknown[][];
  expect(calls[0]?.[5]).toBe("C-1#9");
  expect(calls[1]?.[5]).toBe("C-1#10");
  // A different summary is a different confirmation: a new idempotency key.
  expect(calls[1]?.[4]).not.toBe(calls[0]?.[4]);
});

test("V-2637: a story waiting on unmet prerequisites offers no confirmation unless started early", async () => {
  const waiting = {
    predecessors: [],
    successors: [],
    waiting_on: ["C-9"],
    critical_path_length: 1,
  };
  for (const [extra, offered] of [
    [{ dependency: waiting }, false],
    [
      {
        dependency: waiting,
        early_start: {
          reason: "先拆",
          set_by: "human",
          set_at: "2026-01-01T00:00:00.000Z",
        },
      },
      true,
    ],
  ] as const) {
    const detail = proposalDetail([proposal(1)]);
    render(
      <CardDetailPage
        client={fakeClient({
          card: async () =>
            ({ ...detail, card: { ...detail.card, ...extra } }) as CardDetail,
        })}
        projectId="p-1"
        cardId="C-1"
      />,
    );
    const plan = await screen.findByRole("region", { name: "拆解方案" });
    expect(!!within(plan).queryByRole("button", { name: /确认开卡/ })).toBe(
      offered,
    );
    cleanup();
  }
});
