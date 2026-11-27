import { expect, test } from "vitest";
import type { Assignment, Run, RuntimeRef } from "../entities.js";
import type { CommandState } from "./core.js";
import {
  releaseUnresponsiveSession,
  type UnresponsiveRelease,
} from "./idle-session-retirement.js";
import { releaseAssignment, unfinishedRunsReleaseRefusal } from "./release.js";
import { fixture, human, ports, value } from "./test-fixtures.js";

// C-838 (sensen SEN-C-182, A-639 on mac-mini, Claude Code): the previous turn
// ended, but hc reports no activity for Claude Code (`unknown`), so neither
// the C-759 stop nor the `turn_done` patrol could release the idle session
// that blocked the Assignment's own queued Run; release_assignment only told
// PM Ops to run the host CLI.

const system = { kind: "system" as const, project_id: human.project_id };

function setup() {
  const s = fixture();
  const [first] = s.runs;
  const [owner] = s.assignments;
  if (!first || !owner) throw new Error("fixture");
  const ref: RuntimeRef = {
    machine_id: "local",
    runtime_machine: "fixture",
    terminal_ref: "t1",
    agent_name: "fixture",
    launch_generation: { run_id: first.id, generation: "g1" },
  };
  const ended = {
    ...first,
    status: "completed",
    outcome: "completed",
    harness: "claude-code",
    started_at: "2030-01-01T00:00:00Z",
    finished_at: "2030-01-01T00:10:00Z",
  } as Run;
  const queued = {
    ...first,
    id: "R-9" as Run["id"],
    status: "queued",
    outcome: null,
    started_at: undefined,
    finished_at: undefined,
    queue_entered_at: "2030-01-01T00:20:00Z",
  } as unknown as Run;
  const state: CommandState = {
    ...s,
    assignments: [{ ...owner, runtime_ref: ref }],
    runs: [ended, queued],
  };
  return { state, ref, ended, queued, owner: state.assignments[0]! };
}

test("turn_done on the bound empty editor records that basis; an unknown basis is refused", () => {
  const { state, ref, queued, owner } = setup();
  const request: UnresponsiveRelease = {
    trigger: "turn_done",
    queued_run_id: queued.id,
    waited_ms: 12 * 60_000,
    workspace: "clean",
    idle_basis: "bound_idle_prompt",
  };
  const settled = value(
    releaseUnresponsiveSession(state, system, owner.id, ref, request, ports()),
  );
  expect(settled.data).toMatchObject({ runtime_ref: null });
  // The queued Run stays for the new session.
  expect(settled.changes.filter((c) => c.collection === "runs")).toEqual([]);
  expect(settled.events.at(-1)).toMatchObject({
    type: "session_replaced",
    payload: {
      reason: "idle_session_stopped",
      trigger: "turn_done",
      queued_run_id: queued.id,
      idle_basis: "bound_idle_prompt",
    },
  });
  expect(settled.timeline[0]?.body).toContain("会话空闲（停在空输入框）");
  expect(
    releaseUnresponsiveSession(
      state,
      system,
      owner.id,
      ref,
      { ...request, idle_basis: "screen_guess" as never },
      ports(),
    ).ok,
  ).toBe(false);
});

test("release_assignment with unfinished Runs names what PM or host operations can do, not only the host CLI", () => {
  const { state, ended, queued, owner } = setup();
  const release = (runs: Run[]) => {
    const result = releaseAssignment(
      { ...state, runs },
      human,
      { assignment_id: owner.id },
      ports(),
    );
    expect(result.ok).toBe(false);
    return result.ok ? "" : result.error.message;
  };
  // Only a never-started queued Run: stop the idle session or cancel it.
  const idle = release([ended, queued]);
  expect(idle).toContain("未结束的 Run");
  expect(idle).toContain(`${queued.id} 排队未开始`);
  expect(idle).toContain("host_ops_stop_assignment");
  expect(idle).toContain("host_ops_cancel_run");
  expect(idle).toContain("停滞巡检也会自动释放");
  expect(idle.indexOf("host_ops_stop_assignment")).toBeLessThan(
    idle.indexOf("cardigan assignment stop"),
  );
  // A Run in flight: wait for it, or host operations cancel it.
  const running = {
    ...queued,
    status: "running",
    started_at: "2030-01-01T00:21:00Z",
  } as Run;
  const busy = release([ended, running]);
  expect(busy).toContain(`${running.id} 已开始或正在启动、停止：等它结束`);
  expect(busy).toContain("host_ops_cancel_run");
  expect(busy).not.toContain("排队未开始");
  // Both at once list both.
  const later = {
    ...queued,
    id: "R-10" as Run["id"],
  } as Run;
  const both = unfinishedRunsReleaseRefusal(owner as Assignment, [
    running,
    later,
  ]);
  expect(both).toContain(`${running.id} 已开始`);
  expect(both).toContain(`${later.id} 排队未开始`);
  // Released only once nothing is unfinished.
  expect(
    releaseAssignment(
      { ...state, runs: [ended] },
      human,
      { assignment_id: owner.id },
      ports(),
    ).ok,
  ).toBe(true);
});
