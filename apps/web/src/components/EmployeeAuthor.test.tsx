// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { timelineEntry } from "../testing/fixtures.js";
import { TimelineActor } from "./TimelineHeader.js";

afterEach(cleanup);
test("existing author display shows the employee name as text and keeps role styling", () => {
  const { container } = render(
    <TimelineActor
      entry={timelineEntry({
        author: "assignment:A-1",
        author_role: "coder",
        employee: {
          id: "E-1",
          name: "Alice <script>",
          title: "开发",
          avatar: "avatar:one",
        },
      })}
    />,
  );
  expect(screen.getByText("Alice <script>")).toBeTruthy();
  expect(screen.getByText("A-1")).toBeTruthy();
  expect(container.querySelector(".actor-coder")).toBeTruthy();
  expect(container.querySelector("script")).toBeNull();
});
test("legacy unnamed authors show their role; human attribution stays unchanged", () => {
  const { rerender } = render(
    <TimelineActor
      entry={timelineEntry({
        author: "assignment:A-1",
        author_role: "reviewer",
      })}
    />,
  );
  expect(screen.getByText("未命名的 reviewer")).toBeTruthy();
  rerender(<TimelineActor entry={timelineEntry({ author: "human" })} />);
  expect(screen.getByText("你")).toBeTruthy();
});
