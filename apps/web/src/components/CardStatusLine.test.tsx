// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { AuthorPrecheck } from "../api.js";
import { card, cardDetail } from "../testing/fixtures.js";
import { CardStatusLine } from "./CardStatusLine.js";

afterEach(cleanup);

const blocked = {
  ...card,
  status: "in_progress" as const,
  waiting_on: [{ kind: "blocked" as const, ref: "W-1", label: "W-1 阻塞" }],
};
const check = (status: AuthorPrecheck["status"]): AuthorPrecheck => ({
  attempt_id: "P-1",
  head_sha: "a".repeat(40),
  status,
  log_ref: "P-1.log",
});

test("a precheck wait reads 预检中 with its log, not a red blocker (C-567)", () => {
  render(
    <CardStatusLine
      projectId="p 1"
      detail={cardDetail({
        card: {
          ...blocked,
          prechecks: [check("running")],
          checking: {
            precheck: { attempt_ids: ["P-1"], waiting_items: ["W-1"] },
          },
        },
      })}
    />,
  );
  const line = screen.getByRole("region", { name: "卡片状态" });
  expect(
    screen.getByRole("link", { name: "预检中" }).getAttribute("href"),
  ).toBe("/api/projects/p%201/prechecks/P-1");
  expect(line.textContent).not.toContain("W-1 阻塞");
  expect(line.textContent).not.toContain("解除阻塞");
  expect(document.querySelector(".merge-exception")).toBeNull();
});

test("a queued precheck without a log shows plain 预检中", () => {
  render(
    <CardStatusLine
      projectId="p-1"
      detail={cardDetail({
        card: {
          ...blocked,
          prechecks: [{ ...check("queued"), log_ref: undefined }],
          checking: {
            precheck: { attempt_ids: ["P-1"], waiting_items: ["W-1"] },
          },
        },
      })}
    />,
  );
  expect(screen.queryByRole("link", { name: "预检中" })).toBeNull();
  expect(
    screen.getByRole("region", { name: "卡片状态" }).textContent,
  ).toContain("预检中");
});

test("after the precheck fails the blocker shows as before", () => {
  render(
    <CardStatusLine
      detail={cardDetail({
        card: { ...blocked, prechecks: [check("failed")] },
      })}
    />,
  );
  const line = screen.getByRole("region", { name: "卡片状态" });
  expect(line.textContent).not.toContain("预检中");
  expect(line.textContent).toContain("W-1 阻塞");
  expect(line.textContent).toContain("下一步：解除阻塞");
  expect(document.querySelector(".merge-exception")?.textContent).toBe(
    "W-1 阻塞",
  );
});

test("a running merge check reads 合并检查中", () => {
  render(
    <CardStatusLine
      detail={cardDetail({
        card: {
          ...card,
          status: "awaiting_merge",
          waiting_on: [],
          checking: { merge_check: { attempt_id: "M-1", status: "queued" } },
        },
      })}
    />,
  );
  expect(
    screen.getByRole("region", { name: "卡片状态" }).textContent,
  ).toContain("合并检查中");
});
