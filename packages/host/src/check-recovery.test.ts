import type { Actor, Event, ProjectId } from "@cardigan/domain";
import type {
  CheckRecoveryBinding,
  recoverCheckDirectory,
} from "@cardigan/runtime-herdr";
import { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import {
  fixture,
  human,
  id,
  now,
} from "../../domain/src/commands/test-fixtures.js";
import { CheckRecovery } from "./check-recovery.js";
import { withCheckoutDeadline } from "./checkout-deadline.js";
import { CHECKOUT_LIMITS } from "./checkout-limits.js";
import type { MergeGateExecutor } from "./merge-gate-executors.js";
import type { CheckoutInput } from "./temporary-checkout.js";

const stores: Store[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
});

test("rejects registration if the executor changed while the check was starting", () => {
  const f = setup();
  f.check("running");
  f.changeExecutor();
  expect(f.register).toThrow("Unverified check recovery registration");
});

test("a late registration callback cannot bind an already timed-out checkout", async () => {
  vi.useFakeTimers();
  const registered = vi.fn();
  let captured: CheckoutInput | undefined;
  const result = withCheckoutDeadline(
    {
      execution: { mode: "local", dataDir: "/fixture" },
      project: "p",
      sha: "a".repeat(40),
      tree: "b".repeat(40),
      checks: [{ name: "fixture", run: "true" }],
      totalTimeoutMs: 1,
      onRegistered: registered,
    },
    (input) => {
      captured = input;
      return new Promise(() => {});
    },
  );
  await vi.advanceTimersByTimeAsync(1 + CHECKOUT_LIMITS.graceMs);
  await result;
  captured?.onRegistered?.(binding);
  expect(registered).not.toHaveBeenCalled();
});
const binding: CheckRecoveryBinding = {
  git_layout: "bare",
  registration_name: "worktree",
  container: { device: "1", inode: "11", uid: 1234 },
  worktree: { device: "1", inode: "12", uid: 1234 },
  repository: { device: "1", inode: "13", uid: 1234 },
  registration: { device: "1", inode: "14", uid: 1234 },
};
function setup() {
  const store = Store.open({ dbPath: ":memory:" });
  stores.push(store);
  const project = human.project_id,
    card = id("card", 1),
    sha = "a".repeat(40);
  store.createProject({ id: project });
  store.uow.run((tx) => {
    for (const c of fixture().cards) tx.cards.put(project, c);
  });
  let executor: MergeGateExecutor = {
    name: "fixture",
    host: "fixture.invalid",
    port: 22,
    user: "agent",
    hostKeyAlias: "fixture",
    identityFile: "/fixture/key",
    knownHostsFile: "/fixture/known-hosts",
    agentRoot: "/agent",
    maxConcurrent: 1,
  };
  const events = () =>
    store.uow.read((tx) => tx.events.listAfter(project, card, 0));
  const append = (
    type: string,
    payload: Event["payload"],
    actor: Actor = { kind: "system", project_id: project },
  ) =>
    store.uow.run((tx) =>
      tx.events.append(project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project, card),
        card_id: card,
        type,
        payload,
        actor,
        created_at: now,
      }),
    );
  const check = (status: string, actor?: Actor) =>
    append(
      status === "running"
        ? "merge_check_started"
        : status === "queued"
          ? "merge_check_queued"
          : "merge_check_finished",
      { attempt_id: "attempt", candidate_sha: sha, status },
      actor,
    );
  const recover = vi.fn<typeof recoverCheckDirectory>(
    async (_execution, request) => {
      request.authorize();
      return { status: "cleaned", reason: "complete", processes: [] };
    },
  );
  const options = {
    store,
    clock: { now: () => now },
    execution: { mode: "local" as const, dataDir: "/fixture" },
    executor: () => executor,
    recover,
  };
  const service = new CheckRecovery(options);
  const executedOn = executor;
  const register = () =>
    service.register(project, card, "attempt", sha, binding, executedOn);
  return {
    service,
    register,
    check,
    events,
    append,
    recover,
    options,
    project,
    card,
    changeExecutor: () => {
      executor = { ...executor, host: "different.invalid" };
    },
  };
}

test("only an authenticated running check can bind directory instances once", () => {
  const f = setup();
  expect(f.register).toThrow();
  f.check("queued");
  expect(f.register).toThrow();
  f.check("running", human);
  expect(f.register).toThrow();
  f.check("running");
  f.register();
  expect(f.register).toThrow();
  expect(
    f.events().filter((e) => e.type === "merge_check_checkout_registered"),
  ).toHaveLength(1);
});

test("unknown directories and active attempts are never recovery candidates", async () => {
  const f = setup();
  f.check("failed");
  await f.service.sweep(f.project);
  f.check("running");
  f.register();
  await f.service.sweep(f.project);
  f.check("queued");
  await f.service.sweep(f.project);
  expect(f.recover).not.toHaveBeenCalled();
});

test("journals before deletion and does not repeat successful cleanup after a restart", async () => {
  const f = setup();
  f.check("running");
  f.register();
  f.check("failed");
  f.recover.mockImplementation(async (_execution, request) => {
    expect(f.events().at(-1)?.type).toBe("merge_check_recovery_requested");
    request.authorize();
    expect(f.events().at(-1)?.type).toBe("merge_check_recovery_deleting");
    return { status: "cleaned", reason: "complete", processes: [] };
  });
  await f.service.sweep(f.project);
  await new CheckRecovery(f.options).sweep(f.project);
  expect(f.recover).toHaveBeenCalledOnce();
  expect(f.events().at(-1)?.payload).toMatchObject({
    status: "cleaned",
    attempt_id: "attempt",
  });
});

test("occupied evidence is durable; a later retry can recover when the process has gone", async () => {
  const f = setup();
  f.check("running");
  f.register();
  f.check("timed_out");
  f.recover.mockResolvedValueOnce({
    status: "manual_attention",
    reason: "occupied",
    processes: [{ pid: 12, state: "D", wchan: "exit_mm" }],
  });
  await f.service.sweep(f.project);
  expect(f.events().at(-1)?.payload).toMatchObject({
    status: "manual_attention",
    processes: [{ pid: 12, state: "D", wchan: "exit_mm" }],
  });
  await f.service.sweep(f.project);
  expect(f.recover.mock.calls[1]?.[1].resume).toBe(false);
  expect(f.events().at(-1)?.payload).toMatchObject({ status: "cleaned" });
});

test("a lost transport after authorization resumes from the durable deletion phase", async () => {
  const f = setup();
  f.check("running");
  f.register();
  f.check("interrupted");
  f.recover.mockImplementationOnce(async (_execution, request) => {
    request.authorize();
    throw new Error("private remote diagnostic");
  });
  await f.service.sweep(f.project);
  await new CheckRecovery(f.options).sweep(f.project);
  expect(f.recover.mock.calls[1]?.[1].resume).toBe(true);
  expect(JSON.stringify(f.events())).not.toContain("private remote diagnostic");
});

test.each(["executor", "status"])(
  "rechecks %s in a fresh transaction before authorizing",
  async (change) => {
    const f = setup();
    f.check("running");
    f.register();
    f.check("failed");
    f.recover.mockImplementationOnce(async (_execution, request) => {
      if (change === "executor") f.changeExecutor();
      else f.check("running");
      request.authorize();
      throw new Error("should not reach deletion");
    });
    await f.service.sweep(f.project);
    expect(
      f.events().some((e) => e.type === "merge_check_recovery_deleting"),
    ).toBe(false);
    expect(f.events().at(-1)?.payload).toMatchObject({
      status: "manual_attention",
    });
  },
);

test("ignores a forged terminal event and never switches a persisted attempt to another executor", async () => {
  const f = setup();
  f.check("running");
  f.register();
  f.check("failed", human);
  await f.service.sweep(f.project);
  expect(f.recover).not.toHaveBeenCalled();
  f.check("failed");
  f.changeExecutor();
  await f.service.sweep(f.project);
  expect(f.recover).not.toHaveBeenCalled();
  await f.service.sweep("another-project" as ProjectId);
  expect(f.recover).not.toHaveBeenCalled();
});
