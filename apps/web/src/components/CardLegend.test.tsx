// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { CARD_DISPLAY_FIELDS, DEFAULT_CARD_DISPLAY } from "../card-display.js";
import { BOARD_STATUSES } from "../status.js";
import { HelpPage } from "../views/HelpPage.js";
import { BoardCard } from "./BoardCard.js";
import {
  CARD_GUIDE_SLUG,
  CARD_LEGEND_GROUPS,
  cardGuideExample,
} from "./CardLegend.js";
import { PRIORITY_LEVELS } from "./Priority.js";

const rows = CARD_LEGEND_GROUPS.flatMap((group) => group.rows);
const selectors = rows.flatMap((row) => row.selectors ?? []);
const source = (path: string) =>
  readFileSync(new NodeURL(path, import.meta.url), "utf8");
afterEach(() => {
  cleanup();
  window.location.hash = "";
});

test("the help directory opens the real annotated card without linking example data to live records", async () => {
  render(<HelpPage projectId="p-1" />);
  fireEvent.click(screen.getByRole("link", { name: "看懂卡片" }));
  const article = await screen.findByRole("article", { name: "看懂卡片" });
  expect(window.location.hash).toContain(CARD_GUIDE_SLUG);
  expect(within(article).getAllByRole("table")).toHaveLength(
    CARD_LEGEND_GROUPS.length,
  );
  const preview = article.querySelector(".card-guide-preview[inert]");
  expect(preview?.querySelector(".board-card.card-tile-waiting")).toBeTruthy();
  expect(preview?.querySelector(".board-progress")).toBeTruthy();
  expect(within(article).queryByRole("link", { name: /示例/ })).toBeNull();
  expect(article.querySelectorAll("figcaption li")).toHaveLength(12);
  expect(article.querySelector("figcaption li:last-child")?.textContent).toBe(
    "模板标记",
  );
  expect(source("./CardLegend.css")).toMatch(
    /\.template-marker::before\s*\{\s*content: "12"/,
  );
  for (const row of rows) {
    const entry = article.querySelector(`[data-legend-signal="${row.id}"]`);
    expect(entry?.textContent).toContain(row.meaning);
    expect(entry?.querySelectorAll("td[data-label]")).toHaveLength(2);
  }
});

test("all card statuses, priorities, display settings and state classes have legend entries", () => {
  for (const status of BOARD_STATUSES)
    expect(rows.some((row) => row.id === `status-${status}`)).toBe(true);
  for (const level of PRIORITY_LEVELS)
    expect(rows.some((row) => row.id === `priority-${level.name}`)).toBe(true);
  for (const { key } of CARD_DISPLAY_FIELDS) {
    const ids =
      key === "waiting"
        ? ["decision", "human_action", "blocked"]
        : key === "progress"
          ? [
              "progress-empty",
              "progress-zero",
              "progress-partial",
              "progress-complete",
            ]
          : [key];
    for (const id of ids) expect(rows.some((row) => row.id === id)).toBe(true);
  }
  // Layout classes are not signals; new BoardCard state classes must be documented.
  const structural = new Set([
    "card-tile-head",
    "card-tile-link",
    "board-card-meta",
    "board-card-time-attachments",
    "board-card-badge",
  ]);
  const classes =
    source("./BoardCard.tsx").match(/\b(?:card-tile-|board-card-)[a-z-]+\b/g) ??
    [];
  const styles = source("../styles.css");
  for (const name of new Set(classes)) {
    expect(styles).toContain(`.${name}`);
    if (!structural.has(name)) expect(selectors).toContain(`.${name}`);
  }
  expect(selectors).toContain(".card-superseded");
});

test("every rendered card signal and metadata badge is explained across normal, waiting, blocked, held and superseded cards", () => {
  const base = cardGuideExample(0);
  const variants = [
    base,
    {
      ...base,
      progress: { completed: 3, total: 3 },
      queued_runs: [{ run_id: "R-1", assignment_id: "A-1", ahead: 2 }],
      waiting_on: [
        { kind: "decision" as const, ref: "Q-1", label: "确认方案" },
        { kind: "human_action" as const, ref: "H-1", label: "连接设备" },
        { kind: "blocked" as const, ref: "W-1", label: "缺少环境" },
      ],
    },
    {
      ...base,
      title: "【暂停】示例",
      hold: {
        reason: "等待条件",
        resume_condition: "条件满足",
        set_by: "human" as const,
        set_at: base.created_at,
      },
    },
    {
      ...base,
      status: "cancelled" as const,
      resolution: "superseded" as const,
      superseded_by: "C-2",
    },
  ];
  const { container } = render(
    variants.map((card) => (
      <BoardCard
        key={`${card.status}-${card.waiting_on.length}-${Boolean(card.hold)}`}
        card={card}
        projectId="p-1"
        display={{ ...DEFAULT_CARD_DISPLAY, reason: true }}
      />
    )),
  );
  const signals = container.querySelectorAll(
    ".card-id, .status, .card-title, .card-review-reason, .card-hold-details, .priority-glyph, .board-card-badge, .employee-owners, .template-marker",
  );
  expect(signals.length).toBeGreaterThan(40);
  for (const signal of signals)
    expect(
      selectors.some((selector) => signal.matches(selector)),
      signal.outerHTML,
    ).toBe(true);
  expect(
    container.querySelector(".card-tile-blocked.card-tile-waiting"),
  ).toBeNull();
  expect(
    container
      .querySelector(".card-hold-details")
      ?.parentElement?.querySelector(".card-review-reason"),
  ).toBeNull();
});

test("color descriptions are reviewed whenever the semantic palette changes", () => {
  const css = source("../styles.css");
  // Intentionally pins only the palette described in this guide, for both themes.
  // A theme change should update the color words and this contract together.
  const tokens = [
    "text-muted",
    "status-wait",
    "danger",
    "status-backlog",
    "status-pending",
    "status-progress",
    "status-review",
    "status-merge",
    "status-done",
    "status-cancelled",
    "priority-low",
    "priority-medium",
    "priority-high",
    "priority-urgent",
  ];
  expect(
    Object.fromEntries(
      tokens.map((token) => [
        token,
        [...css.matchAll(new RegExp(`--${token}: ([^;]+);`, "g"))].map(
          (match) => match[1],
        ),
      ]),
    ),
  ).toMatchInlineSnapshot(`
    {
      "danger": [
        "#b42318",
        "#ff9c91",
      ],
      "priority-high": [
        "#bf560c",
        "#f9a15d",
      ],
      "priority-low": [
        "#236bb5",
        "#6daef5",
      ],
      "priority-medium": [
        "#9a7600",
        "#eac74a",
      ],
      "priority-urgent": [
        "#c93135",
        "#ff7b80",
      ],
      "status-backlog": [
        "#64716b",
        "#a4a4a4",
      ],
      "status-cancelled": [
        "#78645e",
        "#d1b4a6",
      ],
      "status-done": [
        "#2e7d4f",
        "#91cda5",
      ],
      "status-merge": [
        "#0f766e",
        "#6dd9b7",
      ],
      "status-pending": [
        "#2563a8",
        "#94bde9",
      ],
      "status-progress": [
        "#087e8b",
        "#65d3e0",
      ],
      "status-review": [
        "#6b4fb3",
        "#c5b0f1",
      ],
      "status-wait": [
        "#b45309",
        "#edb96d",
      ],
      "text-muted": [
        "#5a6661",
        "#a4a4a4",
      ],
    }
  `);
});
