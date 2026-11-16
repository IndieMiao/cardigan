// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { AuthorPrechecks } from "./AuthorPrechecks.js";

afterEach(cleanup);

test("renders author states, fixed merge disclaimer, no obsolete delivery evidence, and no unscoped log entry", () => {
  const check = {
    attempt_id: "attempt-1",
    head_sha: "a".repeat(40),
    status: "failed" as const,
    summary: "FAIL long.test.ts > failure",
    log_ref: "attempt-1.log",
  };
  const view = render(<AuthorPrechecks checks={[check]} />);
  expect(screen.getByText("预检查失败")).toBeTruthy();
  expect(screen.getByText(/仍需正式审核和最终合并检查/)).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
  view.rerender(<AuthorPrechecks checks={[]} />);
  expect(screen.getByText("尚无作者预检查")).toBeTruthy();
  expect(screen.queryByText("FAIL long.test.ts > failure")).toBeNull();
});

test("a completed pass is scoped to its checked commit and never claims current branch applicability", () => {
  const checked = "a".repeat(40);
  render(
    <AuthorPrechecks
      checks={[{ attempt_id: "old-pass", head_sha: checked, status: "passed" }]}
    />,
  );
  const record = screen.getByRole("listitem");
  expect(within(record).getByText("所列提交预检查通过")).toBeTruthy();
  expect(within(record).getByText("被检提交")).toBeTruthy();
  expect(within(record).getByText(checked.slice(0, 12)).title).toBe(checked);
  expect(within(record).getByText("当前版本适用性未核。")).toBeTruthy();
  expect(screen.getByText(/结果仅适用于所列被检提交/)).toBeTruthy();
  expect(record.textContent).not.toMatch(/当前版本通过|已过时|已失效/);
});

test("later check records and their order never stand in for a trusted current branch HEAD", () => {
  const prior = {
    attempt_id: "old-pass",
    head_sha: "a".repeat(40),
    status: "passed" as const,
  };
  const later = {
    attempt_id: "new-pass",
    head_sha: "b".repeat(40),
    status: "passed" as const,
  };
  const view = render(<AuthorPrechecks checks={[prior]} />);
  view.rerender(<AuthorPrechecks checks={[later, prior]} />);
  for (const record of screen.getAllByRole("listitem")) {
    expect(within(record).getByText("所列提交预检查通过")).toBeTruthy();
    expect(within(record).getByText("当前版本适用性未核。")).toBeTruthy();
    expect(record.textContent).not.toMatch(/当前版本通过|已过时|已失效/);
  }
  view.rerender(
    <AuthorPrechecks checks={[prior, { ...later, status: "running" }]} />,
  );
  expect(screen.getByText("运行中")).toBeTruthy();
  expect(screen.getAllByText("当前版本适用性未核。")).toHaveLength(2);
});
