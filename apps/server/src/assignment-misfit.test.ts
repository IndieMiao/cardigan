import { ASSIGNMENT_MISFIT_REASONS } from "@cardigan/domain";
import {
  dispatchHandoffs,
  dispatchStallCauses,
  readonlyWorktreeTarget,
} from "@cardigan/host";
import { afterEach, beforeEach, expect, test } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { standingResolver } from "./assembly.js";
import { Dispatcher } from "./dispatch.js";

// C-836: an Assignment left over from before assign refused these
// combinations is never started, and its stall says why and what to change.
let f: ReturnType<typeof recoveryFixture>;
beforeEach(() => {
  f = recoveryFixture();
});
afterEach(() => f.close());

const legacy = {
  readonly_producer: () =>
    f.store.uow.run((tx) => {
      const role = tx.roles.get(f.project, {
        role_id: "coder",
        role_version: f.target.assignment.role_version,
      });
      if (!role) throw new Error("Missing role");
      tx.roles.put(f.project, { ...role, worktree: "readonly" });
    }),
  untargeted_verifier: () =>
    f.store.uow.run((tx) => {
      const { template_key: _key, ...item } = f.target.item;
      tx.work_items.put(f.project, {
        ...item,
        kind: "verify",
        max_review_rounds: 3,
        status: "todo",
        assignment_id: f.target.assignment.id,
      });
    }),
} as const;

const stalls = () => {
  const state = f.state();
  return dispatchStallCauses(
    state,
    f.notes(),
    dispatchHandoffs(state),
    f.clock.now(),
    standingResolver(f.store),
  ).filter((s) => s.assignment_id === f.target.assignment.id);
};

test.each(["readonly_producer", "untargeted_verifier"] as const)(
  "a stored %s Assignment is not started and its stall names the reason",
  async (misfit) => {
    legacy[misfit]();
    const before = f.latest().id;
    f.comment();
    await new Dispatcher({
      ...f.options,
      standing: standingResolver(f.store),
    }).tick();
    expect(f.latest().id).toBe(before);
    expect(f.options.startRun).not.toHaveBeenCalled();
    expect(f.runtime.wake).not.toHaveBeenCalled();
    f.advance(600_000);
    expect(stalls()).toEqual([
      expect.objectContaining({
        kind: "notification_backlog",
        restart_blocked: misfit,
        restart_blocked_reason: ASSIGNMENT_MISFIT_REASONS[misfit],
      }),
    ]);
  },
);

test("an ordinary producer is still woken and its stall carries no misfit reason", async () => {
  f.comment();
  await new Dispatcher({
    ...f.options,
    standing: standingResolver(f.store),
  }).tick();
  expect(f.runtime.wake).toHaveBeenCalled();
  for (const s of stalls())
    expect(s).not.toHaveProperty("restart_blocked_reason");
});

test("a stored readonly producer's checkout error names the reason and the fix", () => {
  legacy.readonly_producer();
  expect(() =>
    readonlyWorktreeTarget(f.store, f.project, f.target.assignment),
  ).toThrow(ASSIGNMENT_MISFIT_REASONS.readonly_producer);
});
