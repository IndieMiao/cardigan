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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
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
    { kind: "decision", ref: "Q-1", label: "选择发布窗口" },
    { kind: "human_action", ref: "H-1", label: "连接设备" },
    { kind: "decision", ref: "Q-2", label: "确定版本" },
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
    expect(heading?.getAttribute("title")).toBeNull();
    expect(container.querySelector(".card-tile-head")?.textContent).toBe(
      "C-1进行中",
    );
    if (mode === "focus") act(() => link.focus());
    else {
      vi.useFakeTimers();
      fireEvent.pointerMove(link, { pointerType: "mouse" });
      act(() => vi.advanceTimersByTime(1000));
      vi.useRealTimers();
    }
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
  expect(badges).toHaveLength(6);
  for (const badge of badges) {
    const label = badge.getAttribute("aria-label");
    expect(label).toBeTruthy();
    expect(badge.getAttribute("title")).toBeNull();
    expect(badge.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    act(() => badge.focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe(label);
    act(() => badge.blur());
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  }
  // C-660: one corner tag replaces the per-kind waiting icons and the left edge.
  expect(container.querySelectorAll("[data-card-signal]")).toHaveLength(1);
  expect(container.querySelector(".board-card")?.className).not.toMatch(
    /card-tile-(blocked|waiting)/,
  );
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
    // C-531: the hidden runner is named on +N, which itself never spins.
    run_presence: { state: n === 4 ? "running" : "idle" } as const,
  }));
  renderCard({ ...example, participants }, onOpenCard);
  const group = screen.getByRole("group", { name: "参与员工" });
  expect(
    within(group).getAllByRole("button", { name: /，已指派，当前无运行$/ }),
  ).toHaveLength(3);
  const overflow = within(group).getByRole("button", {
    name: "另有 2 位参与员工，其中正在为这张卡运行：员工4",
  });
  expect(overflow.textContent).toBe("+2");
  act(() => overflow.focus());
  expect((await screen.findByRole("tooltip")).textContent).toBe(
    "员工4，正在为这张卡运行；员工5，已指派，当前无运行",
  );
  const employee = within(group).getByRole("button", {
    name: "员工1，已指派，当前无运行",
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
  // C-660: like the left edge it replaces, the corner tag ignores display fields.
  expect(container.querySelector("[data-card-signal]")?.textContent).toBe(
    "阻塞",
  );
  const title = screen.getByRole("link", { name: example.title });
  act(() => title.focus());
  expect((await screen.findByRole("tooltip")).textContent).toBe(example.title);
  act(() => title.blur());
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

test("anonymous participants retain a named role placeholder and hover hint", async () => {
  renderCard({
    ...example,
    participants: [{ employee: null, author_role: "reviewer" }],
  });
  // C-531: without run facts the state is unknown, never idle.
  const placeholder = screen.getByRole("img", {
    name: "未命名的 reviewer，运行状态未知",
  });
  expect(placeholder.getAttribute("title")).toBeNull();
  fireEvent.focus(placeholder);
  expect((await screen.findByRole("tooltip")).textContent).toBe(
    "未命名的 reviewer，运行状态未知",
  );
  expect(placeholder.querySelector(".employee-avatar")?.textContent).toBe("R");
});

test("readable card titles wrap at regular weight and use existing theme tokens", () => {
  const css = readFileSync(
    new NodeURL("../styles.css", import.meta.url),
    "utf8",
  );
  const compact = css.slice(css.indexOf("/* C-210: readable"));
  const title = /\.board-card \.card-title \{([^}]+)\}/.exec(compact)?.[1];
  for (const rule of [
    "display: block",
    "white-space: normal",
    "overflow-wrap: anywhere",
    "font-weight: 400",
    "line-height: 22px",
  ])
    expect(title).toContain(rule);
  // C-256: titles wrap naturally; cards grow with content instead of clipping.
  expect(title).not.toMatch(
    /ellipsis|nowrap|overflow: hidden|(?:^|[\s;])(?:min-|max-)?height/,
  );
  expect(compact).toContain("flex-wrap: wrap");
  expect(compact).toContain("min-width: 0");
  expect(compact).toContain("margin-inline-start: 0");
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
      readFileSync(
        new NodeURL("./ui/theme.css", import.meta.url),
        "utf8",
      ).split("@media (prefers-color-scheme: dark)")[1],
    ).toContain(`--${token}:`);
  }
});

test.each([
  { ahead: 2, label: "排队中（前面还有 2 个）", mode: "hover" },
  { ahead: 2, label: "排队中（前面还有 2 个）", mode: "focus" },
  { ahead: 0, label: "即将开始", mode: "hover" },
  { ahead: 0, label: "即将开始", mode: "focus" },
])(
  "queue badge at $ahead exposes its full label on $mode",
  async ({ ahead, label, mode }) => {
    const onOpenCard = vi.fn();
    const { container } = renderCard(
      {
        ...example,
        queued_runs: [{ run_id: "R-1", assignment_id: "A-1", ahead }],
      },
      onOpenCard,
    );
    const badge = screen.getByRole("link", { name: label });
    expect(badge.closest(".board-card-meta")).toBeTruthy();
    expect(badge.textContent).toBe(String(ahead));
    expect(badge.getAttribute("aria-label")).toBe(label);
    expect(badge.getAttribute("title")).toBeNull();
    const icon = badge.querySelector("svg.status-shape-pending");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.querySelector("circle")).toBeTruthy();
    expect(container.querySelector("p.hint")).toBeNull();
    expect(screen.queryByText(label)).toBeNull();

    if (mode === "focus") act(() => badge.focus());
    else {
      vi.useFakeTimers();
      fireEvent.pointerMove(badge, { pointerType: "mouse" });
      act(() => vi.advanceTimersByTime(1000));
      vi.useRealTimers();
    }
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toBe(label);
    expect(tooltip.closest(".tooltip-content")).toBeTruthy();
    expect(badge.getAttribute("aria-describedby")).toBe(tooltip.id);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    fireEvent.click(badge);
    expect(onOpenCard).toHaveBeenCalledWith(example.id, badge);
  },
);

test("queue badge selects the nearest Run regardless of input order and follows queue updates", () => {
  const queuedRuns = [7, 2, 5].map((ahead) => ({
    run_id: `R-${ahead}`,
    assignment_id: `A-${ahead}`,
    ahead,
  }));
  const { rerender } = renderCard({ ...example, queued_runs: queuedRuns });
  expect(screen.getAllByRole("link", { name: /^排队中/ })).toHaveLength(1);
  expect(
    screen.getByRole("link", { name: "排队中（前面还有 2 个）" }).textContent,
  ).toBe("2");
  expect(queuedRuns.map((run) => run.ahead)).toEqual([7, 2, 5]);
  rerender(
    <BoardCard
      card={{
        ...example,
        queued_runs: [
          ...queuedRuns,
          { run_id: "R-0", assignment_id: "A-0", ahead: 0 },
        ],
      }}
      projectId="p-1"
      display={DEFAULT_CARD_DISPLAY}
    />,
  );
  expect(screen.getAllByRole("link", { name: "即将开始" })).toHaveLength(1);
  expect(screen.getByRole("link", { name: "即将开始" }).textContent).toBe("0");
  expect(screen.queryByRole("link", { name: /^排队中/ })).toBeNull();
  for (const item of [{ ...example, queued_runs: [] }, example]) {
    rerender(
      <BoardCard card={item} projectId="p-1" display={DEFAULT_CARD_DISPLAY} />,
    );
    expect(screen.queryByRole("link", { name: /排队中|即将开始/ })).toBeNull();
  }
});

test("C-370 board names unfinished prerequisites and distinguishes early work from completion readiness", async () => {
  const dependent = {
    ...example,
    dependency: {
      predecessors: [],
      successors: [],
      waiting_on: ["C-2", "C-3"],
      critical_path_length: 1,
    },
  };
  const view = renderCard(dependent);
  expect(screen.queryByText("等 C-2、C-3")).toBeNull();
  act(() => screen.getByRole("button", { name: "进行中" }).focus());
  expect(
    within(await screen.findByRole("tooltip")).getByText("等 C-2、C-3"),
  ).toBeDefined();
  view.unmount();
  renderCard({
    ...dependent,
    early_start: { reason: "Parallel", set_by: "human", set_at: "2026-01-01" },
  });
  act(() => screen.getByRole("button", { name: "进行中" }).focus());
  expect(
    within(await screen.findByRole("tooltip")).getByText(
      "提前开工 · 完成仍等 C-2、C-3",
    ),
  ).toBeDefined();
});

// C-567: the server only sends `checking` while a check is queued or running.
const precheckWait: CardListItem = {
  ...card,
  status: "in_progress",
  waiting_on: [{ kind: "blocked", ref: "W-1", label: "W-1 阻塞" }],
};
const runningPrecheck = (status: "queued" | "running"): CardListItem => ({
  ...precheckWait,
  prechecks: [{ attempt_id: "P-1", head_sha: "a".repeat(40), status }],
  checking: { precheck: { attempt_ids: ["P-1"], waiting_items: ["W-1"] } },
});

test.each(["queued", "running"] as const)(
  "a %s precheck shows 预检中 instead of a red block",
  (status) => {
    const { container } = renderCard(runningPrecheck(status));
    expect(screen.getByRole("link", { name: "预检中" }).textContent).toBe(
      "预检中",
    );
    expect(screen.queryByRole("link", { name: /^阻塞：/ })).toBeNull();
    expect(container.querySelector("[data-card-signal]")).toBeNull();
  },
);

test.each(["passed", "failed"] as const)(
  "after a %s precheck a remaining blocker reads as 阻塞 again",
  (status) => {
    const { container } = renderCard({
      ...precheckWait,
      prechecks: [{ attempt_id: "P-1", head_sha: "a".repeat(40), status }],
    });
    expect(screen.queryByRole("link", { name: "预检中" })).toBeNull();
    const signal = screen.getByRole("link", { name: "阻塞：W-1 阻塞" });
    expect(signal.textContent).toBe("阻塞");
    expect(signal.getAttribute("data-card-signal")).toBe("blocked");
    expect(container.querySelectorAll("[data-card-signal]")).toHaveLength(1);
  },
);

test("a real blocker beside a running precheck stays 阻塞", () => {
  const { container } = renderCard({
    ...runningPrecheck("running"),
    waiting_on: [
      { kind: "blocked", ref: "W-1", label: "W-1 阻塞" },
      { kind: "blocked", ref: "W-2", label: "W-2 阻塞" },
    ],
  });
  expect(screen.getByRole("link", { name: "预检中" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "阻塞：W-2 阻塞" }).textContent).toBe(
    "阻塞",
  );
  expect(container.querySelectorAll("[data-card-signal]")).toHaveLength(1);
});

test("a queued or running merge check shows 合并检查中 and nothing after it ends", () => {
  const merging: CardListItem = {
    ...card,
    status: "awaiting_merge",
    waiting_on: [],
    checking: { merge_check: { attempt_id: "M-1", status: "running" } },
  };
  renderCard(merging);
  expect(screen.getByRole("link", { name: "合并检查中" }).textContent).toBe(
    "合并检查中",
  );
  cleanup();
  const { checking: _done, ...finished } = merging;
  renderCard(finished);
  expect(screen.queryByRole("link", { name: "合并检查中" })).toBeNull();
});

test("check marks follow the waiting-marks display switch", () => {
  render(
    <BoardCard
      card={runningPrecheck("running")}
      projectId="p-1"
      display={{ ...DEFAULT_CARD_DISPLAY, waiting: false }}
    />,
  );
  expect(screen.queryByRole("link", { name: "预检中" })).toBeNull();
});

test.each([
  ["待方案", false],
  ["待确认", false],
  ["待 PM 结案恢复", true],
  ["待你结案恢复", true],
  ["已允许返工但未派发", false],
] as const)(
  "shows %s on the default board without a misleading decision badge",
  (phase, closeout) => {
    const label = `${phase} Q-1`;
    const { container } = renderCard({
      ...example,
      waiting_on: [
        {
          kind: phase === "已允许返工但未派发" ? "review" : "decision",
          ref: "Q-1",
          review_phase: phase,
          label,
        },
      ],
    });
    const signal = container.querySelector("[data-card-signal]");
    if (closeout) {
      // C-660: closeout phases move from the metadata row to the corner tag.
      expect(signal?.textContent).toBe("待结案");
      expect(signal?.getAttribute("aria-label")).toBe(`待结案：${label}`);
      expect(container.querySelector(".review-phase-badge")).toBeNull();
    } else {
      expect(signal).toBeNull();
      expect(screen.getByRole("link", { name: label }).textContent).toContain(
        phase,
      );
    }
    expect(screen.queryByRole("link", { name: /等你拍板|待拍板/ })).toBeNull();
  },
);

test.each([
  [["human_action", "decision"], "decision", "待拍板"],
  [["human_action"], "human_action", "待人工"],
  [["decision", "blocked"], "blocked", "阻塞"],
] as const)(
  "C-660 corner tag for %j shows only the highest-priority reason (%s)",
  async (kinds, kind, text) => {
    const { container } = renderCard({
      ...example,
      waiting_on: kinds.map((k, i) => ({ kind: k, ref: `X-${i}`, label: k })),
    });
    const signals =
      container.querySelectorAll<HTMLElement>("[data-card-signal]");
    expect(signals).toHaveLength(1);
    const signal = signals[0] as HTMLElement;
    expect(signal.getAttribute("data-card-signal")).toBe(kind);
    expect(signal.textContent).toBe(text);
    // Visible text starts the accessible name (label in name).
    expect(signal.getAttribute("aria-label")?.startsWith(`${text}：`)).toBe(
      true,
    );
    expect(signal.getAttribute("href")).toBe("#/p/p-1/cards/C-1");
    expect(
      signal.closest(".board-card-meta")?.lastElementChild?.contains(signal),
    ).toBe(true);
  },
);

test("C-660 corner tag tooltip lists every reason, highest priority first", async () => {
  const onOpenCard = vi.fn();
  const { container } = renderCard(
    {
      ...example,
      waiting_on: [
        ...example.waiting_on,
        {
          kind: "decision",
          ref: "Q-9",
          review_phase: "待 PM 结案恢复",
          label: "待 PM 结案恢复 Q-9",
        },
      ],
    },
    onOpenCard,
  );
  const lines = [
    "阻塞：需要访问权限",
    "待拍板：选择发布窗口；确定版本",
    "待人工：连接设备",
    "待结案：待 PM 结案恢复 Q-9",
  ];
  const signal = screen.getByRole("link", { name: lines.join("。") });
  expect(signal.textContent).toBe("阻塞");
  expect(container.querySelector(".review-phase-badge")).toBeNull();
  act(() => signal.focus());
  const tooltip = await screen.findByRole("tooltip");
  expect(
    [...tooltip.querySelectorAll(".ui-tooltip-details p")].map(
      (p) => p.textContent,
    ),
  ).toEqual(lines);
  fireEvent.keyDown(signal, { key: "Escape" });
  act(() => signal.blur());
  fireEvent.click(signal);
  expect(onOpenCard).toHaveBeenLastCalledWith(example.id, signal);
});

test("C-660 cards without blocked or waiting reasons have no corner tag", () => {
  const { container } = renderCard({
    ...example,
    waiting_on: [{ kind: "review", ref: "W-2", label: "等待审核" }],
    resolution: "superseded",
    superseded_by: "C-8",
    progress: { completed: 3, total: 3 },
  });
  expect(container.querySelector("[data-card-signal]")).toBeNull();
  expect(container.querySelector(".card-superseded")).toBeTruthy();
  expect(container.querySelector(".board-card-complete")).toBeTruthy();
});

test("a precheck and a paused review keep their own badges on the same card", () => {
  const checking = runningPrecheck("running");
  const { container } = renderCard({
    ...checking,
    waiting_on: [
      ...checking.waiting_on,
      {
        kind: "decision",
        ref: "Q-1",
        review_phase: "待确认",
        label: "待确认 Q-1",
      },
    ],
  });
  expect(screen.getByRole("link", { name: "预检中" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "待确认 Q-1" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /等你拍板|^阻塞：/ })).toBeNull();
  expect(container.querySelector("[data-card-signal]")).toBeNull();
});
