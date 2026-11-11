// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { ExecutionAssignment, RunView } from "../api.js";
import { fakeClient } from "../testing/fixtures.js";
import {
  contextUsage,
  ExecutionPage,
  runHarness,
  runModelEffort,
} from "./ExecutionPage.js";

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
  standing_mode: "backstage",
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
    harness: at("harness"),
    model: at("model"),
    context: at("context"),
  };
};

test("C-106: formatting shows recorded values and '—' for anything unknown", () => {
  expect(runHarness(run)).toBe("claude");
  expect(runHarness({ ...run, harness: "codex" })).toBe("codex");
  expect(runHarness({ ...run, harness: "pi" })).toBe("pi");
  expect(runHarness(legacyRun)).toBe("—");
  expect(runHarness(undefined)).toBe("—");
  expect(runModelEffort(run)).toBe("opus-5.5 / xhigh");
  expect(runModelEffort(legacyRun)).toBe("fixture-model / —");
  expect(runModelEffort(undefined)).toBe("—");
  expect(contextUsage(run)).toBe("90%（1M）");
  expect(
    contextUsage({
      ...run,
      context_usage: { used_ratio: 0.423, window_tokens: 200_000 },
    }),
  ).toBe("42%（200K）");
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

test("C-106: employee and Assignment are separate columns, with the new Harness, model/effort and context columns", async () => {
  renderPage();
  await screen.findByRole("button", { name: "查看 A-1 详情" });
  const headers = screen
    .getAllByRole("columnheader")
    .map((header) => header.textContent?.replace(/[↑↓]/gu, "").trim());
  expect(headers).toEqual([
    "员工",
    "Assignment",
    "卡片和工作项",
    "运行状态",
    "Harness",
    "模型和 effort",
    "上下文用量",
    "最近 Run",
    "最近活动",
  ]);

  const coder = cells("A-1");
  const [employeeCell, assignmentCell] = [...coder.row.cells];
  expect(employeeCell?.textContent).toContain("孙悟空");
  expect(employeeCell?.textContent).not.toContain("A-1");
  expect(assignmentCell?.textContent).toContain("A-1");
  expect(assignmentCell?.textContent).toContain("coder");
  expect(assignmentCell?.textContent).not.toContain("孙悟空");
  // With recorded values.
  expect(coder).toMatchObject({
    harness: "claude",
    model: "opus-5.5 / xhigh",
    context: "90%（1M）",
  });

  // Recorded Run without launch profile data or context usage.
  const backstage = cells("A-7");
  expect(backstage.row.cells[1]?.textContent).toContain("PM 后台");
  expect(backstage).toMatchObject({
    harness: "—",
    model: "fixture-model / —",
    context: "—",
  });

  // The external Assignment has no Run: every new column is "—".
  const outside = cells("A-9");
  expect(outside.row.cells[0]?.textContent).toContain("张良");
  expect(outside.row.cells[1]?.textContent).toContain("PM 前台");
  expect(outside).toMatchObject({ harness: "—", model: "—", context: "—" });

  // C-73: newest activity first is unchanged.
  expect(
    [...document.querySelectorAll(".execution-table tbody tr")].map(
      (row) => row.querySelector(".execution-open")?.textContent,
    ),
  ).toEqual(["A-1", "A-7", "A-9"]);
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
  expect(await screen.findByRole("dialog", { name: "A-7 详情" })).toBeTruthy();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");

  // A plain cell of another row opens that row's drawer instead.
  const coder = cells("A-1");
  fireEvent.click(
    coder.row.querySelector('td[data-column="model"]') as Element,
  );
  expect(await screen.findByRole("dialog", { name: "A-1 详情" })).toBeTruthy();
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
});

test("C-106: a link inside the row keeps its own behaviour and does not open the drawer", async () => {
  renderPage();
  await screen.findByRole("button", { name: "查看 A-1 详情" });
  const link = cells("A-1").row.querySelector("a") as HTMLAnchorElement;
  expect(link).not.toBeNull();
  fireEvent.click(link);
  expect(screen.queryByRole("dialog", { name: /详情$/ })).toBeNull();
});

test("C-106: the wide table scrolls sideways inside its own container on narrow screens", async () => {
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
  expect(css).toMatch(/\.execution-table-scroll\s*\{[^}]*overflow-x:\s*auto/u);
});
