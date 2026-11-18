// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
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
import { eventLabel } from "../events.js";
import { parseRoute, routeHash } from "../route.js";
import { changeControl } from "../testing/controls.js";
import { cardDetail, fakeClient } from "../testing/fixtures.js";
import { ActivityPage } from "../views/ActivityPage.js";
import { CardListPage } from "../views/CardListPage.js";
import { ExecutionPage } from "../views/ExecutionPage.js";
import { NeedsYouPage } from "../views/NeedsYouPage.js";
import { SnapshotPage } from "../views/SnapshotPage.js";
import {
  EmptyState,
  formatTime,
  IdTag,
  LongContent,
  PageTitle,
  StatusTag,
  Time,
} from "./Foundation.js";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

test("U1 time uses relative minutes/hours, local dates and years, with a full timezone tooltip", () => {
  const now = new Date(2026, 10, 8, 12, 30).getTime();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const ago = new Date(now - 180000).toISOString();
  expect(formatTime(ago, now)).toBe("3 分钟前");
  expect(formatTime(new Date(now - 23 * 3600000).toISOString(), now)).toBe(
    "23 小时前",
  );
  expect(formatTime(new Date(2026, 10, 7, 11, 40).toISOString(), now)).toBe(
    "11-07 11:40",
  );
  expect(formatTime(new Date(2025, 11, 31, 23, 40).toISOString(), now)).toBe(
    "2025-12-31 23:40",
  );
  expect(formatTime("broken", now)).toBe("时间未知");
  render(<Time value={ago} />);
  const time = screen.getByText("3 分钟前");
  expect(time.getAttribute("datetime")).toBe(ago);
  expect(time.title).toMatch(/2026.*11.*08/);
  expect(time.title).toContain("12:27:00");
  expect(time.title).toContain("GMT");
  act(() => vi.advanceTimersByTime(60000));
  expect(screen.getByText("4 分钟前")).toBeTruthy();
});

test.each([
  [new Date(2026, 10, 15, 7, 47, 30), 0, "刚刚"],
  [new Date(2026, 10, 15, 7, 47, 30), 5000, "刚刚"],
  [new Date(2026, 10, 15, 7, 47, 0), 59999, "刚刚"],
  [new Date(2026, 10, 15, 7, 47, 59), 1000, "11-15 07:48"],
  [new Date(2026, 10, 15, 7, 47, 30), -59000, "刚刚"],
  [new Date(2026, 10, 15, 7, 47, 30), -60000, "1 分钟前"],
  [new Date(2026, 10, 15, 7, 47, 30), -61000, "1 分钟前"],
  [new Date(2026, 10, 15, 23, 59, 59), 1000, "11-16 00:00"],
  [new Date(2026, 10, 16, 0, 0, 1), -59000, "刚刚"],
  [new Date(2026, 11, 31, 23, 59, 59), 1000, "2027-01-01 00:00"],
  [new Date(2027, 0, 1, 0, 0, 1), -59000, "刚刚"],
  [new Date(2027, 0, 1, 0, 0, 1), -61000, "1 分钟前"],
])("C-314 local minute boundary at %s, offset %i", (now, offset, expected) => {
  expect(
    formatTime(new Date(now.getTime() + offset).toISOString(), now.getTime()),
  ).toBe(expected);
});

test("C-314 shared Time keeps the exact timestamp and timezone tooltip for clock skew", () => {
  vi.useFakeTimers();
  const now = new Date(2026, 10, 15, 7, 47, 30).getTime();
  vi.setSystemTime(now);
  const value = new Date(now + 5000).toISOString();
  render(<Time value={value} relative />);
  const time = screen.getByText("刚刚");
  expect(time.getAttribute("datetime")).toBe(value);
  expect(time.title).toContain("07:47:35");
  expect(time.title).toContain("GMT");
  act(() => vi.advanceTimersByTime(120000));
  expect(screen.getByText("1 分钟前")).toBeTruthy();
});

test.each([
  ["America/New_York", "2026-11-01T06:30:30.250Z", 300, "11-01 01:31"],
  ["Europe/Berlin", "2026-10-25T01:30:30.250Z", -60, "10-25 02:31"],
  ["Australia/Lord_Howe", "2026-04-04T15:15:30.250Z", -630, "04-05 01:46"],
])(
  "C-314 clock skew stays in the repeated local minute in %s",
  (zone, instant, offset, nextMinute) => {
    vi.stubEnv("TZ", zone);
    try {
      const now = Date.parse(instant);
      expect(new Date(now).getTimezoneOffset()).toBe(offset);
      expect(formatTime(new Date(now + 5000).toISOString(), now)).toBe("刚刚");
      expect(formatTime(new Date(now + 29749).toISOString(), now)).toBe("刚刚");
      expect(formatTime(new Date(now + 29750).toISOString(), now)).toBe(
        nextMinute,
      );
      expect(formatTime(new Date(now - 59000).toISOString(), now)).toBe("刚刚");
      expect(formatTime(new Date(now - 60000).toISOString(), now)).toBe(
        "1 分钟前",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

test("U1 ID tags include explanations, safe targets and S23 route anchors", async () => {
  const href = routeHash({
    kind: "card",
    projectId: "p/a",
    cardId: "C-1",
    anchor: "decision-Q-4",
  });
  render(
    <>
      <IdTag id="Q-4" label="拍板" detail="选择发布方式" href={href} />
      <IdTag id="W-12" label="代码审核" />
      <IdTag
        id="D-3"
        label="交付"
        href={["javascript", "alert(1)"].join(":")}
      />
    </>,
  );
  const link = screen.getByRole("link", { name: "Q-4 拍板" });
  expect(link.title).toBe("");
  fireEvent.focus(link);
  expect((await screen.findByRole("tooltip")).textContent).toBe("选择发布方式");
  expect(link.getAttribute("href")).toBe("#/p/p%2Fa/cards/C-1?at=decision-Q-4");
  expect(parseRoute(href)).toMatchObject({
    projectId: "p/a",
    cardId: "C-1",
    anchor: "decision-Q-4",
  });
  expect(screen.getByText("代码审核")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "D-3 交付" })).toBeNull();
});

test("U1 shared vocabulary gives states text and translates internal events", () => {
  render(
    <>
      <StatusTag status="failed" />
      <StatusTag status="open" />
      <StatusTag status="resolved" />
      <StatusTag status="accepted" />
    </>,
  );
  for (const word of ["失败", "待拍板", "已拍板", "已接受"])
    expect(screen.getByText(word).className).toContain("status-");
  expect(eventLabel("assignment_released")).toBe("释放了 Assignment");
  expect(eventLabel("run_started")).toBe("开始一次 Run");
  expect(eventLabel("future_internal_event")).toBe("记录了系统事件");
});

test("U1 page title, action and empty guidance have separate accessible content", () => {
  render(
    <>
      <PageTitle
        title="测试页"
        actions={<button type="button">执行操作</button>}
      />
      <EmptyState>没有事项。新事项会出现在这里。</EmptyState>
    </>,
  );
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("测试页");
  expect(screen.queryByText("查看状态。")).toBeNull();
  expect(screen.getByRole("button", { name: "执行操作" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "刷新" })).toBeNull();
  expect(screen.getByText(/新事项会出现在这里/)).toBeTruthy();
});

test("U1 rendered content beyond six lines folds, expands and responds to resize", () => {
  let height = 120;
  const style = window.getComputedStyle(document.body);
  style.lineHeight = "20px";
  vi.spyOn(window, "getComputedStyle").mockReturnValue(style);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    () => height,
  );
  const page = render(
    <LongContent>
      <p>六行内容</p>
    </LongContent>,
  );
  expect(screen.queryByRole("button", { name: "展开全文" })).toBeNull();
  height = 200;
  fireEvent(window, new Event("resize"));
  const button = screen.getByRole("button", { name: "展开全文" });
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(
    document.getElementById(button.getAttribute("aria-controls") ?? "")
      ?.className,
  ).toContain("collapsed");
  fireEvent.click(button);
  expect(
    screen
      .getByRole("button", { name: "收起全文" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(page.container.querySelector(".collapsed")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "收起全文" }));
  expect(page.container.querySelector(".collapsed")).toBeTruthy();
});

test("U1/C-209 shell orders Needs You first with its count, then 卡片, 观察 and tools", async () => {
  const needs = await fakeClient().needsYou("p-1");
  const withIncident = {
    ...needs,
    incidents: [
      {
        id: "A-4",
        role_id: "pm",
        runtime_state: "lost",
        card_id: null,
        waited_ms: 1000,
      },
    ],
  };
  const client = fakeClient({ needsYou: async () => withIncident });
  render(<App client={client} />);
  const sidebar = await screen.findByRole("complementary", {
    name: "Workbench 导航",
  });
  const needsLink = await screen.findByRole("link", { name: "Needs You 1" });
  fireEvent.focus(needsLink);
  expect((await screen.findByRole("tooltip")).textContent).toBe("1 件待处理");
  fireEvent.blur(needsLink);
  expect(
    within(sidebar)
      .getAllByRole("link")
      .map((a) => a.textContent?.trim()),
  ).toEqual([
    "Needs You 1",
    "卡片",
    "执行视图",
    "项目动态",
    "拍板记录",
    "项目快照",
    "设置",
    "帮助",
  ]);
  // C-209: Needs You and 卡片 sit above the only heading, 观察; the tools
  // (设置, 帮助, 登出) form their own unlabelled group at the bottom.
  expect(
    within(sidebar)
      .getAllByRole("heading")
      .map((h) => h.textContent),
  ).toEqual(["观察"]);
  const tools = within(sidebar).getByRole("navigation", { name: "工具" });
  expect(
    within(tools)
      .getAllByRole("link")
      .map((a) => a.textContent),
  ).toEqual(["设置", "帮助"]);
  expect(within(tools).getByRole("button", { name: "登出" })).toBeTruthy();
  expect(needsLink.className).toContain("needs-link");
  expect(sidebar.querySelectorAll("a svg.nav-icon")).toHaveLength(8);
  expect(await screen.findByRole("heading", { name: /卡片/u })).toBeTruthy();
});

test("U1 list filters survive a copied route, dropdown clearing, back navigation and remount", async () => {
  window.location.hash =
    "#/p/p-1/cards?view=list&status=in_progress&next=human&q=%E5%87%86%E5%A4%87";
  const cards = vi.fn(fakeClient().cards),
    client = fakeClient({ cards });
  const page = render(
    <CardListPage client={client} projectId="p-1" view="list" />,
  );
  await screen.findByText("准备发布");
  expect(cards).toHaveBeenLastCalledWith(
    "p-1",
    "all",
    expect.objectContaining({
      mode: "list",
      status: "in_progress",
      next: "human",
      q: "准备",
    }),
    expect.any(AbortSignal),
  );
  expect(
    (screen.getByLabelText("搜索标题或编号") as HTMLInputElement).value,
  ).toBe("准备");
  fireEvent.click(screen.getByRole("button", { name: "状态：进行中" }));
  expect(
    screen
      .getByRole("checkbox", { name: "进行中" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  fireEvent.keyDown(document, { key: "Escape" });
  changeControl(screen.getByRole("combobox", { name: "下一步：所有者" }), {
    target: { value: "" },
  });
  expect(parseRoute(window.location.hash)).toMatchObject({
    kind: "cards",
    filters: { view: "list", status: "in_progress", q: "准备" },
  });
  act(() => {
    window.location.hash = "#/p/p-1/cards?view=board&status=done&next=none";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  fireEvent.click(screen.getByRole("button", { name: "状态：已完成" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("checkbox", { name: "已完成" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
  page.unmount();
  render(<CardListPage client={client} projectId="p-1" view="list" />);
  expect(screen.getByRole("combobox", { name: "下一步：无人" })).toBeTruthy();
});

test("U1 activity restores filters and pagination without losing project identity", async () => {
  window.location.hash =
    "#/p/p-1/activity?actor=pm&category=run&card_id=C-1&before=e%2F2";
  const activity = vi.fn(fakeClient().activity);
  render(<ActivityPage client={fakeClient({ activity })} projectId="p-1" />);
  await waitFor(() =>
    expect(activity).toHaveBeenLastCalledWith("p-1", {
      actor: "pm",
      category: "run",
      card_id: "C-1",
      before: "e/2",
    }),
  );
  changeControl(screen.getByRole("combobox", { name: "发言方" }), {
    target: { value: "" },
  });
  expect(parseRoute(window.location.hash)).toEqual({
    kind: "activity",
    projectId: "p-1",
    filters: { category: "run", card_id: "C-1" },
  });
});

test.each([
  ["项目快照", SnapshotPage],
  ["执行视图", ExecutionPage],
  ["项目动态", ActivityPage],
  ["Needs You", NeedsYouPage],
] as const)(
  "U1 %s uses shared title and helpful empty state with no refresh button or empty groups",
  async (title, Component) => {
    const { container } = render(
      <Component client={fakeClient()} projectId="p-1" />,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(title);
    await waitFor(() => expect(container.querySelector(".empty")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "刷新" })).toBeNull();
    expect(container.querySelectorAll("h2").length).toBe(0);
  },
);

test("U1 card uses shared tags and time without changing comment or attachment controls", async () => {
  window.location.hash = "#/p/p-1/cards/C-1";
  render(<App client={fakeClient({ card: async () => cardDetail() })} />);
  const card = await screen.findByRole("article", { name: "卡片 C-1" });
  expect(card.querySelector(".page-title h1")?.textContent).toContain(
    "准备发布",
  );
  expect(within(card).getByText("代码审核").closest(".id-tag")).toBeTruthy();
  expect(card.querySelector("time")?.title).toMatch(/GMT/);
  expect(card.querySelector(".comment-box")).toBeTruthy();
  expect(card.querySelector(".attachment")).toBeTruthy();
});

test("U1 shell fixes the sidebar to the viewport and maps pass to the done colour", () => {
  const css = readFileSync(
    new NodeURL("../styles.css", import.meta.url),
    "utf8",
  );
  const sidebarStart = css.indexOf(".sidebar {"),
    sidebar = css.slice(sidebarStart, css.indexOf("}", sidebarStart) + 1);
  expect(sidebar).toContain("position: fixed;");
  expect(sidebar).toContain("inset: 0 auto 0 0;");
  expect(sidebar).not.toContain("position: sticky;");
  expect(
    css.slice(
      css.indexOf(".content {"),
      css.indexOf("}", css.indexOf(".content {")),
    ),
  ).toContain("grid-column: 2;");
  expect(
    readFileSync(new NodeURL("./ui/theme.css", import.meta.url), "utf8"),
  ).toContain("--status-done: #515151;");
  const multiStart = css.indexOf(".filter-multi {"),
    multi = css.slice(multiStart, css.indexOf("}", multiStart) + 1);
  expect(multi).toContain("display: grid;");
  expect(css).toContain(".filter-multi-options {");
  expect(
    readFileSync(
      new NodeURL("./layout/DataTableLayout.module.css", import.meta.url),
      "utf8",
    ),
  ).toContain(".records td[data-label]::before {");
  expect(css).toContain(".status-shape-success");
  expect(css).not.toMatch(/\.status[^{}]*::before/);
});

test("U1 base text wrapping protects card header panels from unbroken commit SHAs", async () => {
  const sheet = document.createElement("style");
  sheet.textContent = readFileSync(
    new NodeURL("../styles.css", import.meta.url),
    "utf8",
  );
  document.head.append(sheet);
  try {
    const sha = `c6f87cbb${"a".repeat(32)}`;
    const detail = cardDetail();
    window.location.hash = "#/p/p-1/cards/C-1";
    render(
      <App
        client={fakeClient({
          card: async () => ({
            ...detail,
            card: {
              ...detail.card,
              title: `等待确认 ${sha}`,
              waiting_on: [{ kind: "review", ref: "D-1", label: sha }],
            },
          }),
        })}
      />,
    );
    const card = await screen.findByRole("article", { name: "卡片 C-1" });
    expect(card.querySelector(".page-title h1")?.textContent).toContain(sha);
    expect(
      within(card).getByText("被什么阻塞").nextElementSibling?.textContent,
    ).toBe(sha);
    // jsdom does not lay out text. Assert the inherited base policy from the real
    // stylesheet; a separate Chromium probe measures both viewport sizes.
    expect(window.getComputedStyle(document.body).overflowWrap).toBe(
      "anywhere",
    );
  } finally {
    sheet.remove();
  }
});

test("U3 comments can fold at four rendered lines without changing the six-line default", () => {
  const style = window.getComputedStyle(document.body);
  style.lineHeight = "20px";
  vi.spyOn(window, "getComputedStyle").mockReturnValue(style);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(100);
  const view = render(
    <LongContent lines={4}>
      <p>Five lines</p>
    </LongContent>,
  );
  expect(screen.getByRole("button", { name: "展开全文" })).toBeTruthy();
  view.rerender(
    <LongContent>
      <p>Five lines</p>
    </LongContent>,
  );
  expect(screen.queryByRole("button", { name: "展开全文" })).toBeNull();
});

test("PageTitle exposes decision counts next to the title without a description row", () => {
  render(<PageTitle title="Needs You" count="3 件事等你处理" />);
  const title = screen.getByRole("heading", { name: "Needs You" }),
    count = screen.getByText("3 件事等你处理");
  expect(title.parentElement).toBe(count.parentElement);
  expect(
    count.closest("header")?.querySelector(".page-description"),
  ).toBeNull();
});
