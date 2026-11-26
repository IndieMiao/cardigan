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
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ExecutionAssignment, RunView } from "../api.js";
import { fakeClient } from "../testing/fixtures.js";
import {
  contextReading,
  contextUsage,
  ExecutionPage,
  runConfig,
  runHarness,
  runModelEffort,
  standingLabel,
} from "./ExecutionPage.js";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

const base: ExecutionAssignment = {
  id: "A-1",
  role_id: "coder",
  role_version: 2,
  status: "active",
  runtime_state: "idle",
  machine_id: "local",
  standing_mode: null,
  card_id: "C-1",
  card_status: "in_progress",
  work_item_id: "W-1",
  worktree_path: null,
  branch: null,
  session_ref: null,
  runtime_ref: { terminal_ref: "t", runtime_machine: "local" },
  last_mcp_activity_at: "2026-11-11T01:00:00Z",
  cursors: [],
  employee: {
    id: "E-2",
    name: "孙悟空",
    title: "开发工程师",
    avatar: null,
  },
  author: "assignment:A-1",
  author_role: "coder",
  author_display: "孙悟空",
};
const run: RunView = {
  id: "R-1",
  assignment_id: "A-1",
  status: "running",
  kind: "initial",
  model: "opus-5.5",
  role_version: 2,
  agent_cli_version: "2.0 (Claude Code)",
  started_at: "2026-11-11T00:00:00Z",
  summary: "",
  harness: "claude-code",
  effort: "xhigh",
  context_usage: { used_ratio: 0.9, window_tokens: 1_000_000 },
};
const pm: ExecutionAssignment = {
  ...base,
  id: "A-7",
  role_id: "pm",
  standing_mode: "ops",
  work_item_id: null,
  card_id: null,
  last_mcp_activity_at: "2026-11-11T00:30:00Z",
};
/** The external Assignment (张良) has no Run at all. */
const external: ExecutionAssignment = {
  ...base,
  id: "A-9",
  role_id: "pm",
  external: true,
  runtime_ref: null,
  standing_mode: "office",
  work_item_id: null,
  card_id: null,
  last_mcp_activity_at: "2026-11-10T00:00:00Z",
  employee: { id: "E-5", name: "张良", title: "平台负责人", avatar: null },
  author_display: "张良",
};
const legacyRun: RunView = {
  ...run,
  id: "R-2",
  assignment_id: "A-7",
  model: "fixture-model",
  harness: null,
  effort: null,
  context_usage: null,
};

const renderPage = () =>
  render(
    <ExecutionPage
      client={fakeClient({
        execution: async () => ({
          assignments: [external, pm, base],
          runs: [run, legacyRun],
          machines: [],
        }),
        executionRuns: async () => ({ runs: [], total: 0, next_cursor: null }),
      })}
      projectId="p-1"
    />,
  );
const cells = (assignmentId: string) => {
  const row = screen
    .getByRole("button", { name: `查看 ${assignmentId} 详情` })
    .closest("tr") as HTMLTableRowElement;
  const at = (column: string) =>
    row.querySelector(`td[data-column="${column}"]`)?.textContent;
  return {
    row,
    employee: at("employee"),
    task: at("task"),
    state: at("state"),
    config: at("config"),
    context: at("context"),
  };
};
const withUsage = (used_ratio: number, window_tokens = 200_000): RunView => ({
  ...run,
  context_usage: { used_ratio, window_tokens },
});

test("C-106/C-207: formatting shows recorded values and '—' for anything unknown", () => {
  expect(runHarness(run)).toBe("claude");
  expect(runHarness({ ...run, harness: "codex" })).toBe("codex");
  expect(runHarness({ ...run, harness: "pi" })).toBe("pi");
  expect(runHarness(legacyRun)).toBe("—");
  expect(runHarness(undefined)).toBe("—");
  expect(runModelEffort(run)).toBe("opus-5.5 / 推理强度 xhigh");
  expect(runModelEffort(legacyRun)).toBe("fixture-model / 推理强度 —");
  expect(runModelEffort(undefined)).toBe("—");
  expect(runConfig(run)).toBe("claude / opus-5.5 / 推理强度 xhigh");
  expect(runConfig(legacyRun)).toBe("— / fixture-model / 推理强度 —");
  expect(runConfig(undefined)).toBe("—");
  expect(contextUsage(run)).toBe("已用 90.00%，剩余 10.00%（1M）");
  expect(contextUsage(withUsage(0.6234))).toBe(
    "已用 62.34%，剩余 37.66%（200K）",
  );
  expect(contextUsage(legacyRun)).toBe("—");
  expect(contextUsage({ ...run, context_usage: undefined })).toBe("—");
  expect(
    contextUsage({
      ...run,
      context_usage: { used_ratio: Number.NaN, window_tokens: 1 },
    }),
  ).toBe("—");
  expect(
    contextUsage({
      ...run,
      context_usage: { used_ratio: 0.5, window_tokens: 0 },
    }),
  ).toBe("—");
  expect(contextUsage(undefined)).toBe("—");
});

test("C-207: context levels follow the host's 20% remind and 15% change-session thresholds", () => {
  expect(contextReading(withUsage(0.6234))?.level).toBe("normal");
  expect(contextReading(withUsage(0.79))?.level).toBe("normal");
  // Both boundaries belong to the stricter level, as on the host.
  expect(contextReading(withUsage(0.8))?.level).toBe("handoff");
  expect(contextReading(withUsage(0.849))?.level).toBe("handoff");
  expect(contextReading(withUsage(0.85))?.level).toBe("restart");
  expect(contextReading(withUsage(0.97))?.level).toBe("restart");
  // Shown with two decimals; the level follows the host's 0.1 rounding of
  // what is left, never the displayed value.
  expect(contextReading(withUsage(0.79949))).toMatchObject({
    used: "79.95",
    remaining: "20.05",
    level: "normal",
  });
  expect(contextReading(withUsage(0.79951))?.level).toBe("handoff");
  expect(contextReading(withUsage(0.5))).toMatchObject({
    window: "200K",
    usedTokens: 100_000,
    windowTokens: 200_000,
    meter: 50,
  });
  expect(contextReading(withUsage(1.2))?.meter).toBe(100);
  expect(contextReading(withUsage(1.2))?.remaining).toBe("0.00");
});

test("C-232: the server's level (project thresholds) wins over the local defaults", () => {
  // 25% left is normal under the 20%/15% defaults, a reminder at 30%.
  expect(
    contextReading({
      ...run,
      context_usage: {
        used_ratio: 0.75,
        window_tokens: 200_000,
        level: "handoff",
      },
    })?.level,
  ).toBe("handoff");
  // The server says no level: stay normal even past the local 15% default.
  expect(
    contextReading({
      ...run,
      context_usage: { used_ratio: 0.9, window_tokens: 200_000, level: null },
    })?.level,
  ).toBe("normal");
  // Exact token count from the server is shown as is.
  expect(
    contextReading({
      ...run,
      context_usage: {
        used_ratio: 0.6234,
        window_tokens: 200_000,
        used_tokens: 124_681,
      },
    })?.usedTokens,
  ).toBe(124_681);
});

test("C-232: the task cell shows the full Card title after its id using shared title styling", async () => {
  const title = "执行视图读取接口补上卡片标题和上下文用量（C-207 遗留）".repeat(
    3,
  );
  render(
    <ExecutionPage
      client={fakeClient({
        execution: async () => ({
          assignments: [{ ...base, card_title: title }, pm],
          runs: [run, legacyRun],
          machines: [],
        }),
        executionRuns: async () => ({ runs: [], total: 0, next_cursor: null }),
      })}
      projectId="p-1"
    />,
  );
  await screen.findByRole("button", { name: "查看 A-1 详情" });
  const coder = cells("A-1");
  expect(coder.task).toContain("C-1");
  expect(coder.task).toContain(title);
  expect(coder.task?.indexOf("C-1")).toBeLessThan(
    coder.task?.indexOf(title) ?? -1,
  );
  const titleNode = coder.row.querySelector(".execution-task-title");
  expect(titleNode?.textContent).toBe(title);
  // A standing PM has no Card and so no title line.
  expect(cells("A-7").row.querySelector(".execution-task-title")).toBeNull();
  expect(titleNode?.classList.contains("card-table-title")).toBe(true);
  expect(titleNode?.classList.contains("ui-data-title")).toBe(true);
});

test("C-436: seven columns put employee, task, state and context first and fold Harness/model/effort into one line", async () => {
  renderPage();
  await screen.findByRole("button", { name: "查看 A-1 详情" });
  const headers = screen
    .getAllByRole("columnheader")
    .map((header) => header.textContent?.replace(/[↑↓↕]/gu, "").trim());
  expect(headers).toEqual([
    "员工",
    "正在做什么",
    "运行状态",
    "机器",
    "上下文用量",
    "运行配置",
    "最近活动",
  ]);

  const coder = cells("A-1");
  // The Assignment id shares the employee's line.
  expect(coder.employee).toContain("孙悟空");
  expect(coder.employee).toContain("A-1");
  expect(coder.task).toContain("C-1");
  expect(coder.task).toContain("W-1");
  expect(coder.state).toContain("空闲");
  expect(coder.state).not.toContain("有效");
  expect(coder.config).toBe("claude / opus-5.5 / 推理强度 xhigh");
  expect(coder.context).toBe("90.00%");
  expect(
    coder.row.querySelector(".execution-context")?.getAttribute("data-level"),
  ).toBe("restart");
  // C-504: the list puts a meter under a recorded reading only.
  expect(
    within(coder.row).getByRole("meter", { name: "上下文已用 90.00%" }),
  ).toBeTruthy();

  // Recorded Run without launch profile data or context usage.
  const backstage = cells("A-7");
  expect(backstage.task).toBe("常驻 PM · 后台");
  expect(backstage.config).toBe("— / fixture-model / 推理强度 —");
  expect(backstage.context).toBe("—");
  expect(within(backstage.row).queryByRole("meter")).toBeNull();

  // The external Assignment has no Run.
  const outside = cells("A-9");
  expect(outside.employee).toContain("张良");
  expect(outside.task).toBe("常驻 PM · 前台");
  expect(outside.state).toContain("外接身份");
  expect(outside.config).toBe("—");
  expect(outside.context).toBe("—");
  expect(within(outside.row).queryByRole("meter")).toBeNull();

  // C-73: newest activity first is unchanged.
  expect(
    [...document.querySelectorAll(".execution-table tbody tr")].map(
      (row) => row.querySelector(".execution-open")?.textContent,
    ),
  ).toEqual(["A-1", "A-7", "A-9"]);
});

test("C-504: the list meter follows the reading's length and level; no reading has no meter", async () => {
  window.location.hash = "#/p/p-1/execution?view=all";
  const rows = [
    ["A-1", 0.6875],
    ["A-2", 0.82],
    ["A-3", 0.9],
    ["A-4", 1.2],
  ] as const;
  render(
    <ExecutionPage
      client={fakeClient({
        execution: async () => ({
          assignments: [...rows.map(([id]) => ({ ...base, id })), pm],
          runs: [
            ...rows.map(([id, used_ratio]) => ({
              ...withUsage(used_ratio),
              id: `R-${id}`,
              assignment_id: id,
            })),
            legacyRun,
          ],
          machines: [],
        }),
        executionRuns: async () => ({ runs: [], total: 0, next_cursor: null }),
      })}
      projectId="p-1"
    />,
  );
  await screen.findByRole("button", { name: "查看 A-1 详情" });
  const meterOf = (id: string) => within(cells(id).row).getByRole("meter");
  const expected = [
    ["A-1", "68.75", "68.75", "neutral"],
    ["A-2", "82.00", "82", "warning"],
    ["A-3", "90.00", "90", "danger"],
    // Over the window: the text keeps the reading, the bar stops at full.
    ["A-4", "120.00", "100", "danger"],
  ] as const;
  for (const [id, used, width, tone] of expected) {
    const meter = meterOf(id);
    expect(meter.getAttribute("aria-label")).toBe(`上下文已用 ${used}%`);
    expect((meter as HTMLMeterElement).value).toBe(Number(width));
    expect(meter.closest("[data-ui=meter]")?.getAttribute("data-tone")).toBe(
      tone,
    );
    expect(cells(id).context).toBe(`${used}%`);
  }
  expect(cells("A-7").context).toBe("—");
  expect(within(cells("A-7").row).queryByRole("meter")).toBeNull();
  // C-702: the drawer shows the same reading with the meter and its level.
  fireEvent.click(screen.getByRole("button", { name: "查看 A-2 详情" }));
  const drawer = await screen.findByRole("dialog", { name: /^A-2 / });
  const meter = within(drawer).getByRole("meter");
  expect(meter.getAttribute("aria-label")).toBe("上下文已用 82.00%");
  expect(meter.closest("[data-ui=meter]")?.getAttribute("data-tone")).toBe(
    "warning",
  );
  expect(meter.closest("dd")?.textContent).toBe("82% 164K / 200K");
});

test("C-207: abnormal Assignment status and a bad Run outcome stay in the row", async () => {
  window.location.hash = "#/p/p-1/execution?view=all";
  render(
    <ExecutionPage
      client={fakeClient({
        execution: async () => ({
          assignments: [{ ...base, status: "suspended" }],
          runs: [{ ...run, status: "completed", outcome: "failed" }],
          machines: [],
        }),
      })}
      projectId="p-1"
    />,
  );
  await screen.findByRole("button", { name: "查看 A-1 详情" });
  const state = cells("A-1").state;
  expect(state).toContain("已暂停");
  expect(state).toContain("失败");
  expect(state).not.toContain("最近执行：失败");
  fireEvent.focus(screen.getByRole("button", { name: "A-1 状态详情" }));
  expect((await screen.findByRole("tooltip")).textContent).toContain(
    "最近执行：失败",
  );
});

test("C-106: clicking the row or the Assignment id opens the drawer; the id is a keyboard-focusable button", async () => {
  renderPage();
  const trigger = await screen.findByRole("button", { name: "查看 A-7 详情" });
  expect(trigger.tagName).toBe("BUTTON");
  expect(trigger.textContent).toBe("A-7");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  trigger.focus();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  expect(await screen.findByRole("dialog", { name: /^A-7 / })).toBeTruthy();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");

  // A plain cell of another row opens that row's drawer instead.
  const coder = cells("A-1");
  fireEvent.click(
    coder.row.querySelector('td[data-column="config"]') as Element,
  );
  const drawer = await screen.findByRole("dialog", { name: /^A-1 / });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  // C-207: the folded details live in the drawer (C-702: model and
  // reasoning effort share one field, the context shows its tokens).
  expect(drawer.textContent).toContain("opus-5.5推理强度 xhigh");
  expect(drawer.textContent).toContain("900K / 1M");
});

test("C-106: a link inside the row keeps its own behaviour and does not open the drawer", async () => {
  renderPage();
  await screen.findByRole("button", { name: "查看 A-1 详情" });
  const link = cells("A-1").row.querySelector("a") as HTMLAnchorElement;
  expect(link).not.toBeNull();
  fireEvent.click(link);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("C-106: the wide table scrolls sideways inside its own container", async () => {
  renderPage();
  await screen.findByRole("button", { name: "查看 A-1 详情" });
  const table = document.querySelector(".execution-table");
  expect(
    table?.parentElement?.classList.contains("execution-table-scroll"),
  ).toBe(true);
  const css = readFileSync(
    new NodeURL("../styles.css", import.meta.url),
    "utf8",
  );
  expect(css).toMatch(/\.card-table-scroll\s*\{[^}]*overflow-x:\s*auto/u);
  expect(table?.classList.contains("ui-table")).toBe(true);
  expect(table?.parentElement?.classList.contains("card-table-scroll")).toBe(
    true,
  );
  expect(table?.querySelectorAll('[data-ui="table-head"]')).toHaveLength(7);
});

test("C-207: below 760px the same Assignments render as cards only, in reading order", async () => {
  const listeners: ((event: MediaQueryListEvent) => void)[] = [];
  const matchMedia = vi.fn((query: string) => ({
    matches: query === "(max-width: 760px)",
    media: query,
    addEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) =>
      listeners.push(fn),
    removeEventListener: () => {},
  }));
  vi.stubGlobal("matchMedia", matchMedia);
  try {
    renderPage();
    const trigger = await screen.findByRole("button", {
      name: "查看 A-1 详情",
    });
    expect(document.querySelector(".execution-table")).toBeNull();
    const list = screen.getByRole("list", { name: "执行列表" });
    const cards = [...list.querySelectorAll(":scope > li")];
    expect(cards).toHaveLength(3);
    const card = trigger.closest("li") as HTMLElement;
    const text = card.textContent ?? "";
    // Person and state, then task, then context, then id and activity.
    const order = [
      "孙悟空",
      "空闲",
      "C-1",
      "90.00%",
      "A-1",
      "运行配置与最近执行",
    ];
    const positions = order.map((part) => text.indexOf(part));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    // C-504: narrow list mode keeps the meter under the percentage only.
    expect(
      within(card)
        .getByRole("meter", { name: "上下文已用 90.00%" })
        .closest("[data-ui=meter]")?.textContent,
    ).toBe("90.00%");
    // The configuration is folded.
    const details = within(card)
      .getByText("运行配置与最近执行")
      .closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("claude / opus-5.5 / 推理强度 xhigh");
    // Sorting remains available in the shared toolbar on narrow screens.
    expect(screen.getByRole("combobox", { name: "排序：全部" })).toBeTruthy();
    // A plain card area opens the drawer.
    fireEvent.click(card.querySelector(".execution-card-context") as Element);
    expect(await screen.findByRole("dialog", { name: /^A-1 / })).toBeTruthy();
  } finally {
    vi.unstubAllGlobals();
  }
});

test("C-294: execution has no duplicate capacity panel or jump button", async () => {
  renderPage();
  await screen.findByRole("button", { name: "查看 A-1 详情" });
  expect(document.querySelector(".execution-table")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "机器并发" })).toBeNull();
  expect(screen.queryByRole("button", { name: /机器并发/u })).toBeNull();
});

const standing = (
  id: string,
  role_id: string,
  standing_mode: string | null,
  name: string,
): ExecutionAssignment => ({
  ...pm,
  id,
  role_id,
  standing_mode,
  author_role: role_id,
  author_display: name,
  employee: { id: `E-${id}`, name, title: "", avatar: null },
});
const roleSummary = (role_id: string, display_name: string) => ({
  role_id,
  display_name,
  kind: "standing" as const,
  status: "active" as const,
  version: 1,
  harness: "pi",
  launch_profile_ref: "default",
});

test("C-262: a standing Assignment is labelled by role_id and standing_mode, not by name", async () => {
  const roles = vi.fn(async (project_id: string) => ({
    project_id,
    roles: [roleSummary("librarian", "资料管理员")],
    default_roles: [],
    harnesses: [],
    allowlists: { produce: [], verify: [], standing: [] },
  }));
  render(
    <ExecutionPage
      client={fakeClient({
        execution: async () => ({
          assignments: [
            // The employee names are deliberately swapped around: the label
            // must follow the role, never the person.
            standing("A-20", "host_ops", null, "王熙凤"),
            standing("A-21", "pm", "ops", "大乔"),
            standing("A-22", "pm", "office", "大乔"),
            standing("A-23", "librarian", null, "张良"),
          ],
          runs: [],
          machines: [],
        }),
        roles,
      })}
      projectId="p-1"
    />,
  );
  await screen.findByRole("button", { name: "查看 A-20 详情" });
  expect(cells("A-20").task).toBe("主机运维（常驻）");
  expect(cells("A-21").task).toBe("常驻 PM · 后台");
  expect(cells("A-22").task).toBe("常驻 PM · 前台");
  // An unknown standing role uses its display name once the roles arrive.
  await screen.findByText("常驻（资料管理员）");
  expect(cells("A-23").task).toBe("常驻（资料管理员）");
  for (const id of ["A-20", "A-23"]) expect(cells(id).task).not.toContain("PM");
  expect(roles).toHaveBeenCalledWith("p-1");
});

test("C-262: an unknown standing role falls back to its role_id when no display name is known", async () => {
  render(
    <ExecutionPage
      client={fakeClient({
        execution: async () => ({
          assignments: [standing("A-23", "librarian", null, "张良")],
          runs: [],
          machines: [],
        }),
        roles: async () => {
          throw new Error("roles unavailable");
        },
      })}
      projectId="p-1"
    />,
  );
  await screen.findByRole("button", { name: "查看 A-23 详情" });
  expect(cells("A-23").task).toBe("常驻（librarian）");
});

test("C-262: only an unlabelled standing role reads the role list", async () => {
  const roles = vi.fn();
  render(
    <ExecutionPage
      client={fakeClient({
        execution: async () => ({
          assignments: [base, standing("A-20", "host_ops", null, "大乔")],
          runs: [],
          machines: [],
        }),
        roles,
      })}
      projectId="p-1"
    />,
  );
  await screen.findByRole("button", { name: "查看 A-20 详情" });
  expect(roles).not.toHaveBeenCalled();
});

test("C-262: standingLabel keeps the old project-level wording for a PM without a mode", () => {
  expect(standingLabel({ role_id: "pm", standing_mode: null })).toBe(
    "常驻 PM（项目级）",
  );
  expect(standingLabel({ role_id: "host_ops", standing_mode: "ops" })).toBe(
    "主机运维（常驻）",
  );
  expect(
    standingLabel({ role_id: "librarian", standing_mode: null }, " "),
  ).toBe("常驻（librarian）");
  expect(
    standingLabel({ role_id: "librarian", standing_mode: null }, "资料管理员"),
  ).toBe("常驻（资料管理员）");
});
