import { expect, test } from "vitest";
import { event, snapshot } from "./fixtures.js";
import { routeEvent } from "./route.js";

test("recovery wakes only the original Assignment", () => {
  const result = routeEvent({
    event: event("run_dispatch_recovered", {
      assignment_id: "A-1",
      replacement_run_id: "R-2",
      body: "已自动重排一次",
    }),
    snapshot: snapshot(),
  });
  expect(result.notifications.map((n) => n.recipient)).toEqual([
    { kind: "assignment", assignment_id: "A-1" },
  ]);
});

test("exhausted recovery goes to Ops with actionable text; human fallback uses the HumanAction event", () => {
  const body =
    "C-1 的 A-1 已等待 10 分钟；请执行 cardigan assignment stop A-1 后重新 start";
  const route = (audience: string) =>
    routeEvent({
      event: event("run_dispatch_stalled", {
        assignment_id: "A-1",
        audience,
        body,
      }),
      snapshot: snapshot(),
    });
  expect(route("pm_ops").notifications).toMatchObject([
    { recipient: { kind: "pm_ops" }, summary: body },
  ]);
  expect(route("needs_you").notifications).toEqual([]);
});

test.each(["pm_ops", "needs_you"])(
  "an obsolete C3 successor goes only to %s and never wakes the failed owner",
  (audience) => {
    const result = routeEvent({
      event: event("run_recovery_abandoned", {
        assignment_id: "A-1",
        run_id: "R-2",
        recovery_root_run_id: "R-1",
        audience,
        body: "原目标变化，已取消自动后继",
      }),
      snapshot: snapshot(),
    });
    expect(result.notifications.map((n) => n.recipient)).toEqual([
      { kind: audience },
    ]);
  },
);
