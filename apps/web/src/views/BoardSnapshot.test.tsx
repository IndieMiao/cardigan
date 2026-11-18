// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { App } from "../App.js";
import type { CardListItem, SnapshotData } from "../api.js";
import { parseRoute } from "../route.js";
import { card, fakeClient } from "../testing/fixtures.js";
import { CardListPage } from "./CardListPage.js";
import { SnapshotPage } from "./SnapshotPage.js";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});
const active: CardListItem = {
  ...card,
  roles: ["coder", "reviewer"],
  progress: { completed: 2, total: 5 },
  updated_at: "2026-11-08T00:00:00Z",
  waiting_on: [{ kind: "blocked", ref: "W-1", label: "等待权限" }],
  next_owners: [
    { kind: "human", ref: "human" },
    { kind: "role", ref: "coder" },
  ],
};
const cardsPage = (cards: readonly CardListItem[]) => ({
  project_id: "p-1",
  filter: "all" as const,
  cards,
  counts: { total: cards.length, needs_me: 0, agent: 0 },
});

test("U4b empty columns default to narrow strips; a lane the human expanded stays expanded after remounting", async () => {
  window.location.hash = "#/p/p-1/cards?view=board&q=C-1";
  let saved: Record<string, boolean> = {};
  const client = fakeClient({
    cards: async () => cardsPage([active]),
    preferences: async () => ({
      auto_merge_after_minutes: null,
      merge_gate_enabled: false,
      board_collapsed_lanes: saved,
    }),
    setBoardLane: async (_project, lane, collapsed) => {
      saved = { ...saved, [lane]: collapsed };
    },
  });
  const page = render(
    <CardListPage client={client} projectId="p-1" view="board" />,
  );
  const button = await screen.findByRole("button", { name: "展开已完成列" });
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(button.closest("section")?.className).toContain(
    "board-column-collapsed",
  );
  fireEvent.click(button, { detail: 1 });
  expect(
    screen
      .getByRole("button", { name: "折叠已完成列" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  // Filters stay in the route; the lane setting lives in project preferences.
  expect(parseRoute(window.location.hash)).toMatchObject({
    kind: "cards",
    filters: { view: "board", q: "C-1" },
  });
  await waitFor(() => expect(saved).toEqual({ done: false }));
  page.unmount();
  render(<CardListPage client={client} projectId="p-1" view="board" />);
  await screen.findByRole("button", { name: "折叠已完成列" });
});

test("U4b cards show role, progress, update and a textual blocker; newly occupied columns open on refresh", async () => {
  let cards: readonly CardListItem[] = [active];
  const client = fakeClient({ cards: async () => cardsPage(cards) });
  const page = render(
    <CardListPage client={client} projectId="p-1" view="board" />,
  );
  const link = await screen.findByRole("link", { name: /准备发布/ });
  const tile = link.closest(".card-tile");
  if (!tile) throw new Error("Missing card tile");
  expect(
    within(tile as HTMLElement).getByRole("link", {
      name: "负责角色：coder、reviewer",
    }),
  ).toBeTruthy();
  expect(
    within(tile as HTMLElement).getByRole("link", { name: "进度：2/5" }),
  ).toBeTruthy();
  expect(
    within(tile as HTMLElement).getByRole("link", { name: "阻塞：等待权限" })
      .className,
  ).toContain("board-card-blocked");
  expect(tile.querySelector("time")?.getAttribute("datetime")).toBe(
    active.updated_at,
  );
  cards = [
    active,
    { ...active, id: "C-2", title: "Finished", status: "done", waiting_on: [] },
  ];
  page.rerender(
    <CardListPage client={client} projectId="p-1" view="board" revision={1} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
  const done = await screen.findByRole("link", { name: /Finished/ });
  expect(done.closest(".board-column")?.className).not.toContain("collapsed");
  expect(done.querySelector(".status-blocked")).toBeNull();
});

const review: CardListItem = {
  ...active,
  id: "C-2",
  title: "审核卡片",
  status: "review",
  next_owners: [{ kind: "role", ref: "reviewer" }],
  waiting_on: [{ kind: "review", ref: "W-2", label: "等待审核" }],
};
const done: CardListItem = {
  ...active,
  id: "C-3",
  title: "完成卡片",
  status: "done",
  waiting_on: [],
  next_owners: [],
};
const snapshot: SnapshotData = {
  cards: [active, review, done],
  in_progress: [active],
  in_review: [review],
  waiting: { human: [active.id], agent: [active.id, review.id] },
  blocked: [
    { card_id: active.id, work_item_id: "W-1", label: "权限" },
    { card_id: active.id, work_item_id: "W-3", label: "另一个阻塞" },
    { card_id: review.id, work_item_id: "W-2", label: "等待审核" },
  ],
  recent_deliveries: [
    {
      id: "D-1",
      card_id: active.id,
      work_item_id: "W-1",
      work_item_title: "实现",
      submitted_at: active.updated_at,
      status: "accepted",
      summary: `<img src=x onerror="alert(1)"> ${"很长的摘要".repeat(40)}`,
    },
  ],
};

test.each([
  ["human", "等你处理", ["C-1"]],
  ["agent", "等 Agent 处理", ["C-1", "C-2"]],
  ["progress", "进行中", ["C-1"]],
  ["review", "审核与待合并", ["C-2"]],
  ["blocked", "阻塞", ["C-1", "C-2"]],
] as const)(
  "U4b %s overview count links to the exact matching cards, including overlapping owners",
  async (group, label, ids) => {
    window.location.hash = "#/p/p-1/snapshot";
    render(
      <App
        client={fakeClient({
          snapshot: async () => snapshot,
          cards: async () => cardsPage([active, review, done]),
        })}
      />,
    );
    const nav = await screen.findByRole("navigation", { name: "项目概览" });
    const link = within(nav).getByRole("link", {
      name: `${label} ${ids.length}`,
    });
    expect(link.getAttribute("href")).toBe(
      `#/p/p-1/cards?view=list&overview=${group}`,
    );
    fireEvent.click(link);
    await screen.findByRole("heading", { level: 1, name: /卡片/u });
    const table = await screen.findByRole("table");
    await waitFor(() =>
      expect(
        [...table.querySelectorAll("tbody tr")].map(
          (r) => r.querySelector("td .id-tag > span")?.textContent,
        ),
      ).toEqual(expect.arrayContaining(ids)),
    );
    expect(table.querySelectorAll("tbody tr")).toHaveLength(ids.length);
    expect(screen.getByRole("button", { name: "移除概览筛选" })).toBeTruthy();
  },
);

test("U4b recent deliveries are a five-column table with the full safe summary text", async () => {
  const { container } = render(
    <SnapshotPage
      client={fakeClient({ snapshot: async () => snapshot })}
      projectId="p-1"
    />,
  );
  const region = await screen.findByRole("region", { name: "最近交付" });
  for (const name of ["卡片", "工作项", "状态", "提交时间", "摘要"])
    expect(within(region).getByRole("columnheader", { name })).toBeTruthy();
  expect(
    within(region).getByRole("link", { name: "W-1 实现" }).getAttribute("href"),
  ).toBe("#/p/p-1/cards/C-1?at=work-item-W-1");
  expect(region.querySelector("time")?.getAttribute("datetime")).toBe(
    active.updated_at,
  );
  // C-458: the summary wraps in full instead of an ellipsis with a title.
  // The first body row is the group heading.
  const summary = region
    .querySelectorAll("tbody tr")[1]
    ?.querySelector("td:last-child");
  expect(summary?.textContent).toContain(
    snapshot.recent_deliveries[0]?.summary,
  );
  expect(container.querySelector("img")).toBeNull();
});

test.each([
  { kinds: ["decision"], labels: ["等你拍板"], tone: "waiting" },
  { kinds: ["human_action"], labels: ["待你执行"], tone: "waiting" },
  { kinds: ["blocked"], labels: ["阻塞"], tone: "blocked" },
  { kinds: ["review"], labels: [], tone: undefined },
  { kinds: [], labels: [], tone: undefined },
  {
    kinds: ["decision", "human_action", "blocked", "decision", "review"],
    labels: ["等你拍板", "待你执行", "阻塞"],
    tone: "blocked",
  },
] as const)(
  "U4b board labels waiting reasons independently ($kinds)",
  async ({ kinds, labels, tone }) => {
    const item: CardListItem = {
      ...active,
      waiting_on: kinds.map((kind) => ({ kind, ref: "fixture", label: kind })),
    };
    render(
      <CardListPage
        client={fakeClient({ cards: async () => cardsPage([item]) })}
        projectId="p-1"
        view="board"
      />,
    );
    const link = await screen.findByRole("link", { name: /准备发布/ });
    const tile = link.closest<HTMLElement>(".card-tile");
    if (!tile) throw new Error("Missing card tile");
    expect(
      [
        ...tile.querySelectorAll(".board-card-waiting, .board-card-blocked"),
      ].map((tag) => tag.textContent),
    ).toEqual(labels);
    expect(
      tile.closest(".card-tile")?.classList.contains("card-tile-blocked"),
    ).toBe(tone === "blocked");
    expect(
      tile.closest(".card-tile")?.classList.contains("card-tile-waiting"),
    ).toBe(tone === "waiting");
    for (const label of ["等你拍板", "待你执行"]) {
      const badge = within(tile).queryByText(label, { exact: true });
      if (badge)
        expect(
          badge
            .closest(".board-card-badge")
            ?.classList.contains("board-card-waiting"),
        ).toBe(true);
    }
  },
);
