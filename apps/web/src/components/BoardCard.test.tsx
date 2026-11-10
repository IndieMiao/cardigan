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
import type { CardListItem } from "../api.js";
import { DEFAULT_CARD_DISPLAY } from "../card-display.js";
import { card } from "../testing/fixtures.js";
import { BoardCard } from "./BoardCard.js";

afterEach(cleanup);
if (!globalThis.ResizeObserver)
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
if (!globalThis.PointerEvent)
  Object.defineProperty(globalThis, "PointerEvent", {
    configurable: true,
    value: MouseEvent,
  });

const example: CardListItem = {
  ...card,
  title: "完整的中文标题".repeat(12),
  progress: { completed: 2, total: 3 },
  work_items: [
    { id: "W-1", title: "实现", status: "accepted" },
    { id: "W-2", title: "审核", status: "passed" },
    { id: "W-3", title: "验收", status: "waiting_decision" },
  ],
  attachment_count: 4,
  waiting_on: [
    { kind: "blocked", ref: "W-3", label: "需要访问权限" },
    { kind: "decision", ref: "q(1)", label: "选择发布窗口" },
    { kind: "human_action", ref: "h(1)", label: "连接设备" },
    { kind: "decision", ref: "q(2)", label: "确定版本" },
  ],
};
const renderCard = (item = example, onOpenCard = vi.fn()) =>
  render(
    <BoardCard
      card={item}
      projectId="p-1"
      display={DEFAULT_CARD_DISPLAY}
      onOpenCard={onOpenCard}
    />,
  );

test.each(["hover", "focus"])(
  "%s exposes only the full title and preserves the accessible link name",
  async (mode) => {
    const { container } = renderCard();
    const link = screen.getByRole("link", { name: new RegExp(example.title) });
    const heading = container.querySelector(".card-title");
    expect(heading?.getAttribute("title")).toBe(example.title);
    expect(container.querySelector(".card-tile-head")?.textContent).toBe(
      "C-1进行中",
    );
    if (mode === "focus") act(() => link.focus());
    else fireEvent.pointerMove(link, { pointerType: "mouse" });
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toBe(example.title);
    expect(link.getAttribute("aria-describedby")).toBe(tooltip.id);
    expect(screen.getByRole("link", { name: new RegExp(example.title) })).toBe(
      link,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  },
);

test.each([
  { completed: 0, total: 0, sector: null, complete: false },
  { completed: 0, total: 3, sector: null, complete: false },
  {
    completed: 1,
    total: 4,
    sector: "M10 10 L10 2 A8 8 0 0 1 18 10 Z",
    complete: false,
  },
  {
    completed: 1,
    total: 2,
    sector: "M10 10 L10 2 A8 8 0 0 1 10.000000000000002 18 Z",
    complete: false,
  },
  {
    completed: 2,
    total: 3,
    sector: "M10 10 L10 2 A8 8 0 1 1",
    complete: false,
  },
  { completed: 3, total: 3, sector: null, complete: true },
])(
  "progress $completed/$total draws its sector and only completed nonempty work uses the completion color",
  ({ completed, total, sector, complete }) => {
    renderCard({ ...example, progress: { completed, total } });
    const badge = screen.getByRole("link", {
      name: `进度：${completed}/${total}${complete ? "，全部完成" : ""}`,
    });
    expect(badge.textContent).toBe(`${completed}/${total}`);
    const path = badge.querySelector("svg path")?.getAttribute("d");
    if (sector) expect(path).toContain(sector);
    else expect(path).toBeUndefined();
    expect(badge.querySelectorAll('circle[fill="currentColor"]')).toHaveLength(
      complete ? 1 : 0,
    );
    expect(badge.classList.contains("board-card-complete")).toBe(complete);
  },
);

test("every icon label has an accessible name and its own keyboard tooltip; waiting kinds are deduplicated", async () => {
  const { container } = renderCard({
    ...example,
    resolution: "superseded",
    superseded_by: "C-8",
  });
  const badges = [
    ...container.querySelectorAll<HTMLAnchorElement>(".board-card-badge"),
  ];
  expect(badges).toHaveLength(9);
  for (const badge of badges) {
    const label = badge.getAttribute("aria-label");
    expect(label).toBeTruthy();
    expect(badge.getAttribute("title")).toBe(label);
    expect(badge.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    act(() => badge.focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe(label);
    act(() => badge.blur());
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  }
  expect(screen.getAllByRole("link", { name: /^等你拍板：/ })).toHaveLength(1);
  expect(screen.getByRole("link", { name: "附件：4 个" }).textContent).toBe(
    "4",
  );
  expect(container.querySelector("time")?.dateTime).toBe(example.updated_at);
});

test("three participant avatars plus overflow preserve employee navigation independently of card links", async () => {
  const onOpenCard = vi.fn();
  const participants = [1, 2, 3, 4, 5].map((n) => ({
    employee: {
      id: `E-${n}`,
      name: `员工${n}`,
      title: "工程师",
      avatar: null,
      bio: "公开简介",
    },
  }));
  renderCard({ ...example, participants }, onOpenCard);
  const group = screen.getByRole("group", { name: "参与员工" });
  expect(
    within(group).getAllByRole("button", { name: /的员工卡片$/ }),
  ).toHaveLength(3);
  const overflow = within(group).getByRole("button", {
    name: "另有 2 位参与员工",
  });
  expect(overflow.textContent).toBe("+2");
  act(() => overflow.focus());
  expect((await screen.findByRole("tooltip")).textContent).toBe("员工4、员工5");
  const employee = within(group).getByRole("button", {
    name: "员工1的员工卡片",
  });
  expect(employee.closest("a")).toBeNull();
  fireEvent.click(employee);
  expect((await screen.findByRole("dialog")).textContent).toContain("公开简介");
  expect(onOpenCard).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: "Escape" });
  const link = screen.getByRole("link", { name: new RegExp(example.title) });
  fireEvent.click(link);
  expect(onOpenCard).toHaveBeenLastCalledWith(example.id, link);
  const progress = screen.getByRole("link", { name: "进度：2/3" });
  fireEvent.click(progress);
  expect(onOpenCard).toHaveBeenLastCalledWith(example.id, progress);
  onOpenCard.mockClear();
  for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"])
    fireEvent.click(link, { [modifier]: true });
  expect(onOpenCard).not.toHaveBeenCalled();
  expect(link.getAttribute("href")).toBe("#/p/p-1/cards/C-1");
});

test("display preferences hide tags while keyboard tooltip retains the full title; empty cards do not invent metadata", async () => {
  const { container, rerender } = render(
    <BoardCard
      card={{ ...example, attachment_count: 0 }}
      projectId="p-1"
      display={{
        number: false,
        roles: false,
        progress: false,
        next: false,
        updated: false,
        waiting: false,
        reason: false,
      }}
    />,
  );
  expect(container.querySelectorAll(".board-card-badge")).toHaveLength(0);
  expect(container.querySelector(".card-id")).toBeNull();
  act(() => screen.getByRole("link").focus());
  expect((await screen.findByRole("tooltip")).textContent).toBe(example.title);
  act(() => screen.getByRole("link").blur());
  rerender(
    <BoardCard
      card={{
        ...card,
        work_items: [],
        roles: [],
        waiting_on: [],
        next_owners: [],
        progress: { completed: 0, total: 0 },
      }}
      projectId="p-1"
      display={DEFAULT_CARD_DISPLAY}
    />,
  );
  expect(screen.getByRole("link", { name: "下一步：无人" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "负责角色：尚未配置" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /^附件：/ })).toBeNull();
});

test("anonymous participants retain a named role placeholder and hover hint", () => {
  renderCard({
    ...example,
    participants: [{ employee: null, author_role: "reviewer" }],
  });
  const placeholder = screen.getByRole("img", { name: "未命名的 reviewer" });
  expect(placeholder.getAttribute("title")).toBe("未命名的 reviewer");
  expect(placeholder.querySelector(".employee-avatar")?.textContent).toBe("R");
});

test("compact styles clamp two readable lines, wrap metadata and use existing theme tokens", () => {
  const css = readFileSync(
    new NodeURL("../styles.css", import.meta.url),
    "utf8",
  );
  const compact = css.slice(css.indexOf("/* C-31:"));
  const title = /\.board-card \.card-title \{([^}]+)\}/.exec(compact)?.[1];
  for (const rule of [
    "display: -webkit-box",
    "-webkit-box-orient: vertical",
    "-webkit-line-clamp: 2",
    "overflow: hidden",
    "overflow-wrap: anywhere",
    "line-height: 1.65",
  ])
    expect(title).toContain(rule);
  expect(compact).toContain("flex-wrap: wrap");
  expect(compact).toContain("min-width: 0");
  expect(compact).toContain("margin-inline-start: calc(var(--gap) / -2)");
  expect(compact).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  for (const token of [
    "status-done",
    "status-wait",
    "danger",
    "text-muted",
    "surface",
  ]) {
    expect(compact).toContain(`var(--${token})`);
    expect(
      css.slice(css.indexOf("@media (prefers-color-scheme: dark)")),
    ).toContain(`--${token}:`);
  }
});
