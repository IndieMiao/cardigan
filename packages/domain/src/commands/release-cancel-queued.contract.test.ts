/**
 * C-624 contract: `cardigan assignment release --cancel-queued-run` names the
 * condition that refused the cancel and the command the operator can run next,
 * instead of one catch-all "启动占用" sentence. The permitted case is unchanged.
 */
import { expect, test } from "vitest";
import type { Assignment, Event, Run } from "../entities.js";
import type { CommandState } from "./core.js";
import { releaseAssignment } from "./release.js";
import { fixture, human, id, ports, run } from "./test-fixtures.js";

const A1 = id("assignment", 1);
const queued: Run = { ...run(1), status: "queued" };
function state(
  a: Partial<Assignment> = {},
  extra: { runs?: Run[]; events?: Event[] } = {},
): CommandState {
  const s = fixture();
  return {
    ...s,
    assignments: s.assignments.map((x) =>
      x.id === A1
        ? ({
            ...x,
            runtime_state: "not_provisioned",
            session_ref: null,
            ...a,
          } as Assignment)
        : x,
    ),
    runs: [queued, ...(extra.runs ?? [])],
    events: extra.events ?? [],
  };
}
const release = (s: CommandState, unreserved = true) =>
  releaseAssignment(
    s,
    human,
    { assignment_id: A1, cancel_queued_run_id: queued.id },
    { ...ports(), unreservedAssignment: () => unreserved },
  );
const refusal = (s: CommandState, unreserved = true) => {
  const result = release(s, unreserved);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.error.message;
};

test("a never-dispatched, unreserved queue is still cancelled and released", () => {
  const result = release(state());
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(
    result.value.changes.find(
      (c) => c.collection === "runs" && c.entity.id === queued.id,
    )?.entity,
  ).toMatchObject({ status: "cancelled" });
});

test("an Assignment that already had a session points to stop, release or start", () => {
  const dispatched: Event = {
    id: "1".repeat(26) as never,
    seq: 1,
    type: "run_dispatched",
    actor: human,
    payload: { assignment_id: A1, run_id: id("run", 7) },
    created_at: "2026-01-01T00:00:00.000Z",
  };
  for (const s of [
    state({ worktree_path: "/work/A-1", branch: "agent/C-1/W-1" }),
    state({}, { events: [dispatched] }),
  ]) {
    const message = refusal(s);
    expect(message).toContain("已有会话、工作区或派发记录");
    expect(message).toContain(`cardigan assignment stop ${A1}`);
    expect(message).toContain(`cardigan assignment release ${A1}`);
    expect(message).toContain(`cardigan assignment start ${A1}`);
    expect(message).not.toContain("启动占用");
  }
});

test("a live launch reservation says to retry after the launch ends", () => {
  const message = refusal(state(), false);
  expect(message).toContain("正在启动");
  expect(message).toContain("重试");
});

test("a Run that is not this Assignment's queue is named as such", () => {
  const s = state();
  const message = refusal({
    ...s,
    runs: s.runs.map((r) =>
      r.id === queued.id ? { ...r, status: "running" } : r,
    ),
  });
  expect(message).toContain(`${queued.id} 不是 ${A1} 的排队 Run`);
  expect(message).toContain("running");
});
