// @vitest-environment jsdom
import { sessionMaintenanceReasons } from "@cardigan/domain";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { writeExecutionDisplay } from "../execution-display.js";
import { helpDocuments } from "../help-content.js";
import { fakeClient } from "../testing/fixtures.js";
import { sessionMaintenanceFixture } from "../testing/session-maintenance-fixture.js";
import { ExecutionPage } from "./ExecutionPage.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.location.hash = "";
});
function show(data = sessionMaintenanceFixture()) {
  window.location.hash = "#/p/p-1/execution?view=all";
  return render(
    <ExecutionPage
      projectId="p-1"
      client={fakeClient({
        execution: async () => data,
        executionRuns: async (_project, id) => ({
          runs: data.runs.filter((r) => r.assignment_id === id),
          total: data.runs.filter((r) => r.assignment_id === id).length,
          next_cursor: null,
        }),
      })}
    />,
  );
}

test.each(["table", "cards", "narrow"] as const)(
  "%s shows attention reasons without repeating routine state",
  async (layout) => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: layout === "narrow",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    writeExecutionDisplay("p-1", {
      mode: layout === "cards" ? "cards" : "table",
      grouped: false,
    });
    const data = sessionMaintenanceFixture();
    show(data);
    await screen.findByRole("button", { name: "查看 A-1 详情" });
    for (const a of data.assignments) {
      const reason = a.session_maintenance!.reason;
      if (["run_busy", "recent_activity", "no_session"].includes(reason))
        expect(
          screen.queryByText(sessionMaintenanceReasons[reason]),
        ).toBeNull();
      else
        expect(
          screen.getByText(sessionMaintenanceReasons[reason]),
        ).toBeTruthy();
    }
    const busy = screen
      .getByRole("button", { name: "查看 A-1 详情" })
      .closest("tr,li")!;
    expect(
      busy.querySelector(".execution-state .status-running")?.textContent,
    ).toBe("运行中");
    expect(busy.querySelector(".execution-maintenance")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看 A-3 详情" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("当前运行时不支持会话回收")).toBeTruthy();
    expect(within(dialog).getByText("最近评估")).toBeTruthy();
    expect(within(dialog).getByText("60 分钟")).toBeTruthy();
    expect(within(dialog).getByText("空闲候选")).toBeTruthy();
    expect(dialog.textContent).not.toContain("已回收");
  },
);

test.each([
  "standing",
  "external",
  "inactive",
  "closed",
  "stopped",
  "held",
  "run_busy",
  "no_session",
  "recent_activity",
] as const)("%s is still available in details", async (reason) => {
  const data = sessionMaintenanceFixture();
  const a = data.assignments[0]!;
  show({
    ...data,
    assignments: [
      {
        ...a,
        session_maintenance: {
          ...a.session_maintenance!,
          reason,
          candidate: false,
        },
      },
    ],
  });
  const trigger = await screen.findByRole("button", { name: "查看 A-1 详情" });
  expect(screen.queryByText(sessionMaintenanceReasons[reason])).toBeNull();
  fireEvent.click(trigger);
  expect(
    within(await screen.findByRole("dialog")).getByText(
      sessionMaintenanceReasons[reason],
    ),
  ).toBeTruthy();
});

test("candidate help is reachable from the row and drawer and explains native activity risk", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  show();
  const link = await screen.findByRole("link", {
    name: "等待核验并回收空闲会话",
  });
  const href = "#/p/p-1/help?doc=04-session-maintenance";
  expect(link.getAttribute("href")).toBe(href);
  fireEvent.focus(link);
  expect((await screen.findByRole("tooltip")).textContent).toContain(
    "自动回收可能打断这些交互",
  );
  fireEvent.blur(link);
  fireEvent.click(screen.getByRole("button", { name: "查看 A-11 详情" }));
  expect(
    within(await screen.findByRole("dialog"))
      .getByRole("link", { name: "等待核验并回收空闲会话" })
      .getAttribute("href"),
  ).toBe(href);
  const help = helpDocuments.find(
    (doc) => doc.slug === "04-session-maintenance",
  )!;
  expect(help.source).toContain(
    "原生 hc attach、桌面接入以及终端输入输出目前无法完整观测",
  );
  expect(help.source).toContain("自动回收仍可能打断");
});
