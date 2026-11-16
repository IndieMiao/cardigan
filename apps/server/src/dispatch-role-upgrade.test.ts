import {
  dispatchRun,
  postComment,
  stopWorkItemAssignment,
} from "@cardigan/domain";
import * as host from "@cardigan/host";
import { defaultRoleDefinition } from "@cardigan/roles";
import { PROJECT_EVENT_STREAM, writeRole } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";

const fixtures: ReturnType<typeof dispatchFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) f.close();
});
function setup(upgrade = true) {
  const f = dispatchFixture();
  fixtures.push(f);
  const target = f.create();
  f.session(target.assignment);
  for (const stream of [undefined, target.card.id])
    f.store.advanceRouterCursor(
      f.project,
      stream ?? PROJECT_EVENT_STREAM,
      f.store.getUpdates({
        project_id: f.project,
        ...(stream ? { card_id: stream } : {}),
      }).latest_seq,
    );
  if (upgrade)
    f.store.uow.run((tx) =>
      writeRole(
        tx,
        f.project,
        {
          ...defaultRoleDefinition("coder", {
            harness: "pi",
            launch_profile_ref: "fixture",
          }),
          version: 2,
        },
        { mode: "update" },
      ),
    );
  let busy = false,
    failRelease = true;
  const runtime: DispatcherOptions["runtime"] = {
    status: vi.fn(async () => ({
      ok: true,
      value: {
        process: "alive",
        agent: busy ? "working" : "idle",
        observed_seq: 1,
      },
    })),
    release: vi.fn(async (_ref, options) => {
      expect(options.force).toBe(false);
      return failRelease
        ? {
            ok: false,
            error: { code: "runtime_conflict", message: "synthetic busy" },
          }
        : { ok: true, value: undefined };
    }),
    wake: vi.fn(async () => ({ ok: true, value: { sent: true } })),
    provision: vi.fn(),
    interrupt: vi.fn(),
    resume_or_replace: vi.fn(),
    human_entry: vi.fn(),
  };
  const startRun = vi.fn(
    async ({
      run,
      assignment,
    }: Parameters<NonNullable<DispatcherOptions["startRun"]>>[0]) => {
      f.apply((s, a, p) =>
        dispatchRun(
          s,
          a,
          { run_id: run.id, runtime_ref: f.refFor(assignment) },
          p,
        ),
      );
    },
  );
  const onError = vi.fn();
  const dispatcher = new Dispatcher({
    store: f.store,
    clock: f.clock,
    runtime,
    startRun,
    onError,
    snapshot: async () => ({ model: "fixture", agent_cli_version: "1" }),
  });
  const comment = () =>
    f.apply((s, a, p) =>
      postComment(
        s,
        a,
        {
          card_id: target.card.id,
          work_item_id: target.item.id,
          body: "Continue",
        },
        p,
      ),
    );
  const owner = () =>
    f.state().assignments.find((a) => a.id === target.assignment.id)!;
  return {
    ...f,
    target,
    runtime,
    dispatcher,
    startRun,
    onError,
    comment,
    owner,
    setBusy: (value: boolean) => {
      busy = value;
    },
    setReleaseFailure: (value: boolean) => {
      failRelease = value;
    },
  };
}

test("upgrade fences keep bells pending; human stop clears the old reference and start can resume after settlement", async () => {
  const f = setup();
  f.comment();
  await f.dispatcher.tick([f.project]);
  expect(f.owner().role_upgrade).toBeDefined();
  expect(
    f.store.listNotifications({
      project_id: f.project,
      assignment_id: f.target.assignment.id,
      status: "pending",
    }),
  ).toHaveLength(1);
  expect(
    f.state().events.filter((e) => e.type === "dispatch_rejected"),
  ).toEqual([]);
  expect(f.startRun).not.toHaveBeenCalled();
  // A retry before the backoff expires must not touch the old terminal again.
  f.advance(59_000);
  await f.dispatcher.tick([f.project]);
  expect(f.runtime.release).toHaveBeenCalledOnce();
  const ref = f.owner().runtime_ref!;
  const human = { kind: "human" as const, project_id: f.project };
  f.apply(
    (s, a, p) =>
      stopWorkItemAssignment(
        s,
        a,
        { assignment_id: f.target.assignment.id, reason: "Human stopped" },
        p,
      ),
    human,
  );
  f.apply(
    (s, a, p) =>
      stopWorkItemAssignment(
        s,
        a,
        {
          assignment_id: f.target.assignment.id,
          reason: "Human stopped",
          released_runtime_ref: ref,
        },
        p,
      ),
    human,
  );
  f.advance(1_000);
  await f.dispatcher.tick([f.project]);
  expect(f.owner()).toMatchObject({
    role_version: 2,
    runtime_ref: null,
    runtime_state: "idle",
  });
  expect(f.owner().role_upgrade).toBeUndefined();
  expect(f.runtime.release).toHaveBeenCalledOnce();
  expect(f.startRun).not.toHaveBeenCalled(); // A human stop remains a stop.
  const queued = f.apply(
    (s, a, p) =>
      hostQueue(
        s,
        a,
        {
          assignment_id: f.target.assignment.id,
          kind: "initial",
          model: "fixture",
          agent_cli_version: "1",
        },
        p,
      ),
    human,
  );
  // Human CLI start queues and dispatches directly; it does not wait for an automatic bell.
  const replacementRef = f.refFor(f.owner());
  const started = f.apply(
    (s, a, p) =>
      dispatchRun(s, a, { run_id: queued.id, runtime_ref: replacementRef }, p),
    human,
  );
  expect(started.role_version).toBe(2);
  await f.dispatcher.tick([f.project]);
  expect(f.state().runs.find((r) => r.id === queued.id)?.status).toBe(
    "dispatched",
  );
  expect(
    f.state().events.filter((e) => e.type === "dispatch_rejected"),
  ).toEqual([]);
});

test("repeated release failures back off and notify only PM once after fifteen minutes", async () => {
  const f = setup();
  f.comment();
  await f.dispatcher.tick([f.project]);
  for (let i = 0; i < 6; i++) await f.dispatcher.tick([f.project]);
  expect(f.runtime.release).toHaveBeenCalledOnce();
  for (let i = 0; i < 6; i++) {
    f.advance(300_000);
    await f.dispatcher.tick([f.project]);
  }
  const alerts = f
    .state()
    .events.filter((e) => e.type === "assignment_role_upgrade_delayed");
  expect(alerts).toHaveLength(1);
  const notices = f.store
    .listNotifications({ project_id: f.project })
    .filter((n) => n.event_id === alerts[0]!.id);
  expect(notices).toMatchObject([{ recipient: { kind: "pm_ops" } }]);
  expect(notices).toHaveLength(1);
  expect(f.state().human_actions).toEqual([]);
  expect(
    f.state().events.filter((e) => e.type === "dispatch_rejected"),
  ).toEqual([]);
});

test("a terminal still working outside its completed Run keeps its role and token", async () => {
  const f = setup();
  f.setBusy(true);
  const token = f.store.issueToken({
    project_id: f.project,
    assignment_id: f.target.assignment.id,
    role: { role_version: 1, allowed_tools: ["get_card"] },
  });
  await f.dispatcher.tick([f.project]);
  expect(f.owner().role_upgrade).toBeUndefined();
  expect(f.owner().role_version).toBe(1);
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.store.verifyToken(token.token)).toBeTruthy();
});

test("maintenance failures are isolated and the scan is throttled for sixty seconds", async () => {
  const f = setup(false);
  const scan = vi
    .spyOn(host, "upgradeIdleAssignmentRoles")
    .mockRejectedValueOnce(new Error("synthetic role read failure"));
  f.comment();
  await f.dispatcher.tick([f.project]);
  expect(f.runtime.wake).toHaveBeenCalledOnce();
  expect(f.onError).toHaveBeenCalledOnce();
  for (let i = 0; i < 4; i++) {
    f.advance(1_000);
    await f.dispatcher.tick([f.project]);
  }
  expect(scan).toHaveBeenCalledOnce();
  f.advance(56_000);
  await f.dispatcher.tick([f.project]);
  expect(scan).toHaveBeenCalledTimes(2);
});

import { queueRun as hostQueue } from "@cardigan/domain";
