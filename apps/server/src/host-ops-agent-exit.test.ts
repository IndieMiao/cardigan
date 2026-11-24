import type { Assignment, IdleRetirement } from "@cardigan/domain";
import { stopWorkItemAssignment } from "@cardigan/domain";
import { expect, test, vi } from "vitest";
import { setup } from "../test-support/dispatch-stalls.js";
import { Dispatcher } from "./dispatch.js";

// C-672: the macOS worker proves the Agent CLI is gone while its terminal
// stays live. Host Ops restarts it through the managed path: no stop, the
// terminal is closed, the session settles and dispatch starts a new one.

function darwin(exited = true) {
  const f = setup("worker");
  f.store.uow.run((tx) => {
    const machine = tx.machines.get(f.project, "worker");
    if (!machine) throw new Error("missing worker");
    tx.machines.put(f.project, { ...machine, os: "darwin" });
  });
  f.runtime.observe_agent_exit = vi.fn(async () => ({
    ok: true as const,
    value: exited,
  }));
  const owner = () =>
    f.state().assignments.find((a) => a.id === f.target.assignment.id)!;
  const retain = () => {
    const a = owner();
    f.store.uow.run((tx) =>
      tx.assignments.put(f.project, {
        ...a,
        idle_retirement: {
          phase: "waiting",
          runtime_ref: a.runtime_ref!,
          started_at: f.clock.now(),
          threshold_minutes: 60,
          failures: 3,
          handoff: true,
          evidence: { stage: "probe", reason: "terminal_busy" },
        } as IdleRetirement,
      } as Assignment),
    );
  };
  return { ...f, owner, retain };
}

test("Host Ops restart settles an exited Agent held by session maintenance and the notification resumes", async () => {
  const f = darwin();
  const old = f.owner().runtime_ref;
  f.retain();
  f.comment();
  const result = await f.restart(f.owner(), "fixture-cause");
  expect(result).toMatchObject({
    assignment_id: f.owner().id,
    result: "agent_exited",
  });
  expect(f.runtime.release).toHaveBeenCalledExactlyOnceWith(old, {
    force: true,
  });
  expect(f.runtime.retire_idle).toBeUndefined();
  expect(f.owner()).toMatchObject({ runtime_ref: null });
  expect(f.owner().idle_retirement).toBeUndefined();
  expect(
    f
      .state()
      .events.filter((e) => e.type === "session_replaced")
      .map((e) => e.payload),
  ).toMatchObject([{ reason: "agent_exited", old_runtime_ref: old }]);
  // The same request is idempotent.
  expect(await f.restart(f.owner(), "fixture-cause")).toEqual(result);
  expect(f.runtime.release).toHaveBeenCalledOnce();
  await new Dispatcher(f.options).tick([f.project]);
  expect(f.options.startRun).toHaveBeenCalledOnce();
});

test("Host Ops restart of a running CLI or a human-stopped owner never closes its terminal", async () => {
  const alive = darwin(false);
  alive.comment();
  await alive.restart(alive.owner(), "fixture-cause").catch(() => undefined);
  expect(alive.runtime.release).not.toHaveBeenCalled();
  expect(alive.owner().runtime_ref).not.toBeNull();

  const held = darwin();
  const a = held.owner();
  held.apply(
    (s, actor, p) =>
      stopWorkItemAssignment(s, actor, { assignment_id: a.id }, p),
    { kind: "human", project_id: held.project },
  );
  held.comment();
  await held.restart(a, "fixture-cause").catch(() => undefined);
  expect(held.runtime.observe_agent_exit).not.toHaveBeenCalled();
  expect(held.runtime.release).not.toHaveBeenCalled();
  expect(held.owner().runtime_ref).toEqual(a.runtime_ref);
});
