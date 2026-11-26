// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { executionDisplayFixture } from "../testing/execution-display-fixture.js";
import { fakeClient } from "../testing/fixtures.js";
import { ExecutionPage } from "./ExecutionPage.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});
async function show() {
  window.location.hash = "#/p/p-1/execution?view=all";
  const fixture = executionDisplayFixture();
  const data = {
    ...fixture,
    runs: fixture.runs.map((run) => ({
      ...run,
      context_usage: { used_ratio: 0.1354, window_tokens: 828400 },
    })),
  };
  render(
    <ExecutionPage
      projectId="p-1"
      client={fakeClient({ execution: async () => data })}
    />,
  );
  await screen.findByRole("table");
  fireEvent.click(screen.getByRole("button", { name: "卡片" }));
  return screen.getByRole("region", { name: "员工泳道" });
}

test("lane cards share employee identity, show only numeric context and keep details accessible", async () => {
  const lanes = await show();
  const card = within(lanes).getByRole("listitem", { name: "赵云 A-1" });
  expect(card.querySelector(".employee-identity")).toBeNull();
  expect(
    card.querySelector(".execution-task .execution-state")?.textContent,
  ).toContain("运行中");
  expect(within(card).getByText("上下文 13.54%")).toBeTruthy();
  expect(within(lanes).queryByRole("meter")).toBeNull();
  expect(within(lanes).queryByText("用量正常")).toBeNull();
  expect(within(lanes).queryByText("尚未上报")).toBeNull();
  expect(within(lanes).getAllByText("上下文 —").length).toBeGreaterThan(0);
  const more = within(card).getByRole("button", { name: "运行配置与最近执行" });
  expect(
    more.parentElement?.contains(
      within(card).getByRole("button", { name: "查看 A-1 详情" }),
    ),
  ).toBe(true);
  expect(more.getAttribute("aria-expanded")).toBe("false");
  const missingRunCard = within(lanes).getByRole("listitem", {
    name: "coder A-7",
  });
  expect(
    missingRunCard.querySelector(":scope > .execution-card-config-line"),
  ).toBeNull();
  fireEvent.click(
    within(missingRunCard).getByRole("button", { name: "运行配置与最近执行" }),
  );
  expect(within(missingRunCard).getByText("尚无执行记录")).toBeTruthy();
  fireEvent.click(more);
  expect(more.getAttribute("aria-expanded")).toBe("true");
  expect(within(card).getByText("R-1")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(more);
  expect(
    document.getElementById(more.getAttribute("aria-controls") ?? "")?.hidden,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "表格" }));
  // C-504: only list mode adds the meter under each reading.
  expect(
    within(screen.getByRole("table")).getAllByRole("meter", {
      name: "上下文已用 13.54%",
    }).length,
  ).toBeGreaterThan(0);
});

function pointer(
  target: EventTarget,
  type: string,
  clientX = 300,
  pointerType = "mouse",
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: 1,
    clientX,
    clientY: 100,
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: pointerType },
    isPrimary: { value: true },
  });
  fireEvent(target, event);
  return event;
}

test("empty-space pan suppresses its click; cards, links, touch and wheel keep their own behavior", async () => {
  const lanes = await show();
  Object.defineProperties(lanes, {
    clientWidth: { value: 800 },
    scrollWidth: { value: 2400 },
    clientHeight: { value: 600 },
  });
  lanes.setPointerCapture = vi.fn();
  lanes.hasPointerCapture = () => false;
  const card = within(lanes).getByRole("listitem", { name: "赵云 A-1" });
  const blank = card.parentElement;
  if (!blank) throw new Error("Missing list");
  pointer(blank, "pointerdown");
  expect(lanes.classList.contains("board-pan-ready")).toBe(true);
  expect(pointer(window, "pointermove", 200).defaultPrevented).toBe(true);
  expect(lanes.scrollLeft).toBe(100);
  pointer(window, "pointerup", 200);
  expect(lanes.classList.contains("board-pan-ready")).toBe(false);
  expect(fireEvent.click(card, { detail: 1 })).toBe(false);
  expect(screen.queryByRole("dialog")).toBeNull();
  for (const target of [
    card,
    within(card).getByText(/合成任务 1/),
    within(card).getByRole("button", { name: "查看 A-1 详情" }),
    within(card).getByRole("link"),
  ]) {
    pointer(target, "pointerdown");
    expect(pointer(window, "pointermove", 100).defaultPrevented).toBe(false);
    pointer(window, "pointerup", 100);
    expect(lanes.scrollLeft).toBe(100);
  }
  pointer(blank, "pointerdown", 300, "touch");
  expect(pointer(window, "pointermove", 100, "touch").defaultPrevented).toBe(
    false,
  );
  expect(fireEvent.wheel(lanes, { deltaX: 80 })).toBe(true);
  expect(lanes.scrollLeft).toBe(100);
  fireEvent.click(card, { detail: 1 });
  expect(await screen.findByRole("dialog")).toBeTruthy();
});
