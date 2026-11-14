// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { DeliveryPrecheck } from "../api.js";
import { DeliveryPrechecks } from "./DeliveryPrechecks.js";

afterEach(cleanup);
const check: DeliveryPrecheck = {
  delivery_id: "D-7",
  work_item_id: "W-1",
  subject: { kind: "git_head", value: "a".repeat(40) },
  status: "queued",
  checks: [],
  updated_at: "2030-01-01",
};
test.each([
  ["queued", "排队等待"],
  ["running", "运行中"],
  ["passed", "预检查通过"],
  ["failed", "测试失败"],
  ["timed_out", "超时，等待重查"],
  ["executor_unreachable", "执行器不可达，等待重试"],
  ["environment_failed", "检查环境未就绪"],
  ["interrupted", "执行中断"],
] as const)(
  "precheck %s has an explicit label and does not claim final approval",
  (status, label) => {
    render(
      <DeliveryPrechecks projectId="test" checks={[{ ...check, status }]} />,
    );
    expect(screen.getByRole("region", { name: "交付预检查" })).toBeTruthy();
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText(/仍需正式复核和最终合并检查/u)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  },
);
test("empty and changed delivery views do not retain an old passed result", () => {
  const view = render(
    <DeliveryPrechecks
      projectId="test"
      checks={[{ ...check, status: "passed" }]}
    />,
  );
  view.rerender(
    <DeliveryPrechecks
      projectId="test"
      checks={[{ ...check, delivery_id: "D-8" }]}
    />,
  );
  expect(screen.queryByText("D-7")).toBeNull();
  expect(screen.queryByText("预检查通过")).toBeNull();
  view.rerender(<DeliveryPrechecks projectId="test" checks={[]} />);
  expect(screen.getByText("尚无交付预检查")).toBeTruthy();
});
test("logs link to the authenticated project endpoint only for a matching attempt", () => {
  const attempt = "e42de008-2c67-49e2-a59d-077a0f7936de";
  render(
    <DeliveryPrechecks
      projectId="fixture"
      checks={[
        {
          ...check,
          attempt_id: attempt,
          log_ref: `${attempt}.log`,
          summary: "FAIL test.ts > long invariant",
        },
      ]}
    />,
  );
  expect(
    screen.getByRole("link", { name: "查看预检查日志" }).getAttribute("href"),
  ).toBe(`/api/projects/fixture/merge-checks/${attempt}`);
  expect(screen.getByText("FAIL test.ts > long invariant")).toBeTruthy();
});
