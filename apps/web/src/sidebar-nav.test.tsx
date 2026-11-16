// @vitest-environment jsdom
/**
 * C-209 sidebar navigation (design D-700 structure, D-709 dark palette).
 *
 * Wide screens get one sidebar: Needs You first with its pending count, 卡片
 * next, the 观察 group, then the tools (设置, 登出). Below 760px the sidebar
 * becomes a modal drawer behind a menu button, with a Needs You shortcut in the
 * top bar. Routes and the entry set are unchanged.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App.js";
import type { CardiganClient, NeedsPage, ProjectSummary } from "./api.js";
import { fakeClient as baseClient, loggedIn } from "./testing/fixtures.js";

const project: ProjectSummary = {
  id: "p-1",
  name: "Cardigan 自己",
  created_at: "2026-01-01T00:00:00.000Z",
};

function client(needs = 0): CardiganClient {
  return baseClient({
    session: loggedIn,
    projects: async () => [project],
    needsYou: async () =>
      ({
        decisions: Array.from({ length: needs }, (_, i) => ({ id: `Q-${i}` })),
        human_actions: [],
        incidents: [],
      }) as unknown as NeedsPage,
  });
}

function stubViewport(narrow: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    matches: narrow,
    media: "(max-width: 760px)",
    addEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) =>
      listeners.add(fn),
    removeEventListener: (
      _: string,
      fn: (event: MediaQueryListEvent) => void,
    ) => listeners.delete(fn),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => query),
  );
  return {
    resize(next: boolean) {
      query.matches = next;
      for (const fn of listeners) fn({ matches: next } as MediaQueryListEvent);
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

test("wide sidebar: Needs You first with its count, then 卡片, 观察 and tools", async () => {
  render(<App client={client(3)} />);
  const sidebar = await screen.findByRole("complementary", {
    name: "Workbench 导航",
  });
  const views = await within(sidebar).findByRole("navigation", {
    name: "视图",
  });
  await waitFor(() =>
    expect(within(views).getByRole("link", { name: /Needs You/ })).toBeTruthy(),
  );
  const links = within(views).getAllByRole("link");
  expect(links.map((link) => link.textContent?.trim())).toEqual([
    "Needs You 3",
    "卡片",
    "执行视图",
    "项目动态",
    "拍板记录",
    "项目快照",
  ]);
  // Every entry carries one decorative line icon next to its label.
  for (const link of links) {
    const icons = link.querySelectorAll("svg.nav-icon");
    expect(icons.length).toBe(1);
    expect(icons[0]?.getAttribute("aria-hidden")).toBe("true");
  }
  // Only the middle group has a heading; single-entry groups are gone.
  const headings = within(sidebar).getAllByRole("heading");
  expect(headings.map((heading) => heading.textContent)).toEqual(["观察"]);
  const group = headings[0]?.closest(".nav-group") as HTMLElement;
  expect(within(group).getAllByRole("link")).toHaveLength(4);

  const tools = within(sidebar).getByRole("navigation", { name: "工具" });
  expect(within(tools).getByRole("link", { name: "设置" })).toBeTruthy();
  const logout = within(tools).getByRole("button", { name: "登出" });
  expect(logout.querySelector("svg.nav-icon")).toBeTruthy();
  // No drawer chrome on wide screens.
  expect(screen.queryByRole("button", { name: "打开导航" })).toBeNull();
});

test("the current entry is marked and routes keep their hashes", async () => {
  window.location.hash = "#/p/p-1/activity";
  render(<App client={client()} />);
  const sidebar = await screen.findByRole("complementary", {
    name: "Workbench 导航",
  });
  const activity = await within(sidebar).findByRole("link", {
    name: "项目动态",
  });
  expect(activity.getAttribute("aria-current")).toBe("page");
  expect(activity.getAttribute("href")).toBe("#/p/p-1/activity");
  expect(
    within(sidebar).getByRole("link", { name: "卡片" }).getAttribute("href"),
  ).toBe("#/p/p-1/cards");
  expect(
    within(sidebar)
      .getByRole("link", { name: "卡片" })
      .getAttribute("aria-current"),
  ).toBeNull();
  // Zero pending hides the count.
  const needs = within(sidebar).getByRole("link", { name: "Needs You" });
  expect(needs.querySelector(".nav-count")).toBeNull();
  expect(needs.getAttribute("href")).toBe("#/p/p-1/needs-you");
});

test("narrow screens: menu opens a modal drawer that closes on choice or Escape", async () => {
  stubViewport(true);
  render(<App client={client(2)} />);
  const shortcut = await screen.findByRole("link", {
    name: "Needs You，2 件待处理",
  });
  expect(shortcut.getAttribute("href")).toBe("#/p/p-1/needs-you");

  const menu = screen.getByRole("button", { name: "打开导航" });
  fireEvent.click(menu);
  const drawer = await screen.findByRole("dialog", { name: "项目导航" });
  const close = within(drawer).getByRole("button", { name: "关闭导航" });
  await waitFor(() => expect(document.activeElement).toBe(close));
  expect(menu.getAttribute("aria-expanded")).toBe("true");

  fireEvent.keyDown(drawer, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "项目导航" })).toBeNull(),
  );
  expect(menu.getAttribute("aria-expanded")).toBe("false");

  fireEvent.click(menu);
  const reopened = await screen.findByRole("dialog", { name: "项目导航" });
  fireEvent.click(within(reopened).getByRole("link", { name: "帮助" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "项目导航" })).toBeNull(),
  );
  await screen.findByRole("article", { name: "编号和标记" });
});

test("widening the viewport closes the drawer and drops the top bar", async () => {
  const viewport = stubViewport(true);
  render(<App client={client()} />);
  fireEvent.click(await screen.findByRole("button", { name: "打开导航" }));
  await screen.findByRole("dialog", { name: "项目导航" });
  viewport.resize(false);
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "项目导航" })).toBeNull(),
  );
  expect(screen.queryByRole("button", { name: "打开导航" })).toBeNull();
});
