// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { card } from "../testing/fixtures.js";
import { CardDependencies } from "./CardDependencies.js";

afterEach(cleanup);
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
  expect(within(region).getByText("已取代")).toBeDefined();
  expect(within(region).getByText("已完成")).toBeDefined();
  const links = within(region).getAllByRole("link");
  expect(links).toHaveLength(3);
  expect(links[0]?.getAttribute("href")).toContain("C-2");
  expect(links[1]?.textContent).toContain("长标题".repeat(50));
  links[2]?.focus();
  expect(document.activeElement).toBe(links[2]);
});
test("no dependency has no new empty section", () => {
  render(<CardDependencies projectId="p-1" card={card} />);
  expect(screen.queryByRole("region", { name: "卡片依赖" })).toBeNull();
});
