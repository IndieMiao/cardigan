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
import {
  type ActivityData,
  type ActivityFilter,
  HttpCardiganClient,
} from "../api.js";
import { fakeClient } from "../testing/fixtures.js";
import { ActivityPage } from "./ActivityPage.js";

const event: ActivityData["events"][number] = {
  id: "event-new",
  card_id: "C-1",
  card_title: "准备发布",
  seq: 3,
  type: "instruction_issued",
  role: "pm",
  created_at: "2026-01-01T01:00:00Z",
  payload: { reason: "先完成必要检查", text: '<img src=x onerror="alert(1)">' },
  actor: { kind: "assignment", assignment_id: "A-1" },
};
const cards = [{ id: "C-1", title: "准备发布" }];
const data: ActivityData = {
  cards,
  events: [event],
  next_before: "event-new",
  counts: { returned: 1, matched: 2 },
};
const empty: ActivityData = {
  cards,
  events: [],
  next_before: null,
  counts: { returned: 0, matched: 0 },
};
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

test("explicit read audits show only supplied target and tool without changing pagination or raw payload", async () => {
  window.location.hash = "#/p/p-1/activity?type=cross_card_read";
  const payload = { card_id: "C-14", tool: "get_card" };
  const activity = vi.fn(async () => ({
    ...data,
    cards: [{ id: "C-14", title: "Do not enrich audit rows from card titles" }],
    events: [
      {
        ...event,
        type: "cross_card_read",
        card_id: null,
        card_title: null,
        payload,
      },
    ],
  }));
  render(<ActivityPage client={fakeClient({ activity })} projectId="p-1" />);
  await screen.findByText("工具：get_card");
  const summary = document.querySelector("summary");
  if (!summary) throw new Error("Missing audit summary");
  expect(
    within(summary)
      .getByRole("link", { name: "C-14 目标卡片" })
      .getAttribute("href"),
  ).toBe("#/p/p-1/cards/C-14");
  expect(summary.textContent).not.toContain("Do not enrich");
  expect(JSON.parse(document.querySelector("pre")?.textContent ?? "")).toEqual(
    payload,
  );
  expect(document.querySelector("details")?.open).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "更早的事件" }));
  await waitFor(() =>
    expect(activity).toHaveBeenLastCalledWith("p-1", {
      type: "cross_card_read",
      before: "event-new",
    }),
  );
});

test.each([
  null,
  {},
  { card_id: null },
  { card_id: "", tool: 3 },
  { card_id: { id: "C-1" } },
  { card_id: "<img src=x>", tool: "<script>alert(1)</script>" },
])(
  "read audits retain the project fallback for missing or malformed fields: %j",
  async (payload) => {
    const { container } = render(
      <ActivityPage
        client={fakeClient({
          activity: async () => ({
            ...data,
            events: [
              {
                ...event,
                type: "cross_card_read",
                card_id: null,
                card_title: null,
                payload,
              },
            ],
          }),
        })}
        projectId="p-1"
      />,
    );
    await screen.findByText("读取了其它卡片");
    const summary = container.querySelector("summary");
    expect(summary?.textContent).toContain("项目级事项");
    expect(summary?.querySelector("a, img, script")).toBeNull();
  },
);

test("activity is collapsed, describes time/actor/action/card and escapes the payload", async () => {
  const { container } = render(
    <ActivityPage
      client={fakeClient({ activity: async () => data })}
      projectId="p-1"
    />,
  );
  await screen.findByText("下达了指令");
  expect(document.querySelector("summary")?.textContent).toContain(
    "未命名的 pm",
  );
  expect(document.querySelector("summary")?.textContent).toContain("准备发布");
  expect(container.querySelector(".activity-list")).toBeTruthy();
  expect(container.querySelector("details")?.open).toBe(false);
  expect(container.querySelector("pre")?.textContent).toContain(
    "先完成必要检查",
  );
  expect(container.querySelector("img")).toBeNull();
  expect(
    screen.getByRole("link", { name: /C-1 准备发布/u }).getAttribute("href"),
  ).toBe("#/p/p-1/cards/C-1");
});

test("filters by card, speaker and category; paging preserves filters and a filter resets the cursor", async () => {
  const activity = vi
    .fn<(p: string, f: ActivityFilter) => Promise<ActivityData>>()
    .mockResolvedValue(data);
  render(<ActivityPage client={fakeClient({ activity })} projectId="p-1" />);
  await screen.findByText(/最新事件/);
  for (const [label, value] of [
    ["卡片", "C-1"],
    ["发言方", "pm"],
    ["事件类别", "comment"],
    ["时间范围", "7d"],
  ])
    fireEvent.change(screen.getByLabelText(label as string), {
      target: { value },
    });
  const filters = {
    card_id: "C-1",
    actor: "pm",
    category: "comment",
    range: "7d",
  };
  await waitFor(() =>
    expect(activity).toHaveBeenLastCalledWith("p-1", filters),
  );
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "更早的事件" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "更早的事件" }));
  await waitFor(() =>
    expect(activity).toHaveBeenLastCalledWith("p-1", {
      ...filters,
      before: "event-new",
    }),
  );
  await screen.findByRole("button", { name: "返回最新" });
  fireEvent.click(screen.getByRole("button", { name: "返回最新" }));
  await waitFor(() =>
    expect(activity).toHaveBeenLastCalledWith("p-1", filters),
  );
  fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  await waitFor(() => expect(activity).toHaveBeenLastCalledWith("p-1", {}));
});

test("groups by day and folds adjacent system events of the same type", async () => {
  const system = (id: string, seq: number): ActivityData["events"][number] => ({
    ...event,
    id,
    seq,
    type: "run_started",
    role: "system",
    created_at: "2026-01-01T00:30:00Z",
    payload: { run_id: id },
    actor: { kind: "system" },
  });
  const response: ActivityData = {
    cards,
    events: [
      system("event-2", 2),
      system("event-1", 1),
      {
        ...event,
        id: "event-4",
        seq: 4,
        type: "assignment_released",
        role: "system",
        created_at: "2026-01-01T00:40:00Z",
        payload: { assignment_id: "A-1" },
        actor: { kind: "system" },
      },
      {
        ...event,
        id: "event-3",
        seq: 3,
        created_at: "2026-01-02T00:00:00Z",
      },
    ],
    next_before: null,
    counts: { returned: 4, matched: 4 },
  };
  render(
    <ActivityPage
      client={fakeClient({ activity: async () => response })}
      projectId="p-1"
    />,
  );
  await screen.findByText("开始 2 次 Run");
  expect(screen.getByText("释放了 Assignment")).toBeTruthy();
  expect(screen.queryByText(/1 条/u)).toBeNull();
  expect(screen.getAllByRole("region", { name: /月.*日/u })).toHaveLength(2);
  const folded = screen.getByText("开始 2 次 Run").closest("details");
  expect(folded?.querySelector("pre")?.textContent).toContain("event-2");
  expect(folded?.querySelector("pre")?.textContent).toContain("event-1");
});

test("the last activity page shows an end hint, hides paging and keeps return-to-latest", async () => {
  const activity = vi.fn(async (_project: string, filters: ActivityFilter) =>
    filters.before ? { ...data, next_before: null } : data,
  );
  render(<ActivityPage client={fakeClient({ activity })} projectId="p-1" />);
  await screen.findByText(/最新事件/);
  expect(screen.queryByText("已经到底了")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "更早的事件" }));
  await screen.findByText("已经到底了");
  expect(screen.queryByRole("button", { name: "更早的事件" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "返回最新" }));
  await screen.findByRole("button", { name: "更早的事件" });
  expect(screen.queryByText("已经到底了")).toBeNull();
});

test("activity shows loading and errors, retries, and handles empty results", async () => {
  const activity = vi
    .fn()
    .mockRejectedValueOnce(new Error("事件读取失败"))
    .mockResolvedValue(empty);
  render(<ActivityPage client={fakeClient({ activity })} projectId="p-1" />);
  expect(screen.queryByText("正在加载…")).toBeNull();
  await screen.findByText("事件读取失败");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByText("没有符合条件的事件。调整筛选，或等待新的项目动态。");
  expect(screen.queryByRole("button", { name: "更早的事件" })).toBeNull();
  expect(screen.queryByText("已经到底了")).toBeNull();
});

test("activity client encodes speaker, category, range and paging without mutating Agent cursors", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify(empty)));
  await new HttpCardiganClient(fetcher).activity("p/a", {
    card_id: "C-1",
    actor: "pm",
    category: "run",
    range: "30d",
    type: "instruction_issued",
    before: "event/1",
  });
  const [url, init] = fetcher.mock.calls[0] ?? [];
  const parsed = new URL(String(url), "https://workbench.invalid");
  expect(parsed.pathname).toBe("/api/projects/p%2Fa/activity");
  expect(Object.fromEntries(parsed.searchParams)).toEqual({
    card_id: "C-1",
    actor: "pm",
    category: "run",
    range: "30d",
    type: "instruction_issued",
    before: "event/1",
  });
  expect(init).toMatchObject({ method: "GET", credentials: "same-origin" });
  expect(init?.body).toBeUndefined();
});
