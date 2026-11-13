// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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
test("legacy unnamed authors show their role; human attribution falls back to owner", () => {
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
  expect(screen.getByText("所有者")).toBeTruthy();
});

test("human authors keep name and avatar inline and show their title in the member profile", () => {
  const { container, rerender } = render(
    <TimelineActor
      entry={timelineEntry({
        author: "human",
        author_display: "邵杰",
        member: {
          id: "M-1",
          name: "邵杰",
          title: "所有者",
          avatar: "/avatars/v1/liu-bei/head-64.webp",
        },
      })}
    />,
  );
  expect(screen.getByText("邵杰")).toBeTruthy();
  const person = screen.getByRole("button", { name: "邵杰的成员卡片" });
  expect(within(person).queryByText("所有者")).toBeNull();
  expect(container.querySelector("img")?.getAttribute("src")).toBe(
    "/avatars/v1/liu-bei/head-64.webp",
  );
  expect(screen.queryByText(/^(你|人)$/)).toBeNull();
  fireEvent.click(person);
  const profile = screen.getByRole("dialog", { name: "邵杰的成员卡片" });
  expect(within(profile).getByText("所有者")).toBeTruthy();
  fireEvent.click(person);
  expect(screen.queryByRole("dialog")).toBeNull();
  rerender(<TimelineActor entry={timelineEntry({ author: "human" })} />);
  expect(screen.getByText("所有者")).toBeTruthy();
});
