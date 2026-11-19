// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { routeHash } from "../route.js";
import { card } from "../testing/fixtures.js";
import { CardDependencies } from "./CardDependencies.js";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

afterEach(() => {
  cleanup();
  window.location.hash = "";
});
test("dependency links retain full titles, textual terminal states and distinguish early completion waits", () => {
  render(
    <CardDependencies
      projectId="p-1"
      card={{
        ...card,
        early_start: {
          reason: "Parallel",
          set_by: "human",
          set_at: "2026-01-01",
        },
        dependency: {
          predecessors: [
            { id: "C-2", title: "已完成前置", status: "done", satisfied: true },
            {
              id: "C-3333333333",
              title: "长标题".repeat(50),
              status: "cancelled",
              resolution: "superseded",
              satisfied: false,
            },
          ],
          successors: [
            { id: "C-4", title: "后续", status: "backlog", satisfied: false },
          ],
          waiting_on: ["C-3333333333"],
          critical_path_length: 2,
        },
      }}
    />,
  );
  const region = screen.getByRole("region", { name: "卡片依赖" });
  expect(
    within(region).getByText("提前开工 · 完成仍等 C-3333333333"),
  ).toBeDefined();
  expect(within(region).getByText("最长未完成链：2 张")).toBeDefined();
  expect(within(region).getByText("已取代")).toBeDefined();
  expect(within(region).getByText("已完成")).toBeDefined();
  const links = within(region).getAllByRole("link");
  expect(links).toHaveLength(3);
  expect(links[0]?.getAttribute("href")).toContain("C-2");
  expect(links[1]?.textContent).toContain("长标题".repeat(50));
  links[2]?.focus();
  expect(document.activeElement).toBe(links[2]);
  // The open card is the highlighted node, not a link to itself.
  const current = region.querySelector('[aria-current="page"]');
  expect(current?.textContent).toContain(card.id);
  expect(current?.closest("a")).toBeNull();
  expect(region.querySelectorAll("[data-edge]")).toHaveLength(3);
});

test("no dependency has no new empty section", () => {
  render(<CardDependencies projectId="p-1" card={card} />);
  expect(screen.queryByRole("region", { name: "卡片依赖" })).toBeNull();
});

test("the detail graph shows the whole chain, marks 待核 and jumps on click", async () => {
  render(
    <CardDependencies
      projectId="p-1"
      card={{
        ...card,
        dependency: {
          predecessors: [
            { id: "C-2", title: "直接前置", status: "done", satisfied: false },
          ],
          successors: [
            { id: "C-4", title: "直接后续", status: "todo", satisfied: false },
          ],
          waiting_on: ["C-2"],
          critical_path_length: 3,
          graph: {
            nodes: [
              { id: "C-0", title: "源头", status: "done", satisfied: true },
              {
                id: "C-2",
                title: "直接前置",
                status: "done",
                satisfied: false,
              },
              { ...card, satisfied: false },
              {
                id: "C-4",
                title: "直接后续",
                status: "todo",
                satisfied: false,
              },
              { id: "C-5", title: "末端", status: "backlog", satisfied: false },
            ],
            edges: [
              { from: "C-0", to: "C-2" },
              { from: "C-2", to: card.id },
              { from: card.id, to: "C-4" },
              { from: "C-4", to: "C-5" },
            ],
          },
        },
      }}
    />,
  );
  const region = screen.getByRole("region", { name: "卡片依赖" });
  expect(within(region).getByText("等 C-2")).toBeDefined();
  expect(within(region).getByText("最长未完成链：3 张")).toBeDefined();
  const graph = within(region).getByRole("list", { name: "依赖关系图" });
  expect(within(graph).getAllByRole("listitem")).toHaveLength(5);
  expect(within(graph).getByText("已完成（待核）")).toBeDefined();
  expect(
    [...region.querySelectorAll("[data-edge]")].map((edge) =>
      edge.getAttribute("data-edge"),
    ),
  ).toEqual(["C-0>C-2", "C-2>C-1", "C-1>C-4", "C-4>C-5"]);
  const far = within(graph).getByRole("link", { name: /C-5.*末端/ });
  fireEvent.click(far);
  await waitFor(() =>
    expect(window.location.hash).toBe(
      routeHash({ kind: "card", projectId: "p-1", cardId: "C-5" }),
    ),
  );
});
