// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { AuthorPrechecks } from "./AuthorPrechecks.js";

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
