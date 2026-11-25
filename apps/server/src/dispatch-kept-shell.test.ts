import {
  dispatchRun,
  issueInstruction,
  postComment,
  stopWorkItemAssignment,
} from "@cardigan/domain";
import * as host from "@cardigan/host";
import { defaultRoleDefinition } from "@cardigan/roles";
import { PROJECT_EVENT_STREAM, writeRole } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";

// C-667: a session replaced before C-667 ran under hc --keep. When its CLI
// exits the terminal stays live with a shell; bells, retirement and upgrades
// all read it as a live session, so nothing resumed until a human stop/start.

const fixtures: ReturnType<typeof dispatchFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) f.close();
});

function setup({ upgrade = false } = {}) {
  const f = dispatchFixture("worker", "none", "darwin");
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
          instructions: "Project coder rules",
          version: 2,
        },
        { mode: "update" },
      ),
    );
  let shell = true;
  let closed = false;
  const runtime: DispatcherOptions["runtime"] = {
    status: vi.fn(async () =>
      closed
        ? {
            ok: false as const,
            error: { code: "runtime_not_found" as const, message: "gone" },
          }
        : {
            ok: true as const,
            value: {
              process: "alive" as const,
              agent: "unknown" as const,
              observed_seq: 1,
              kept: true as const,
            },
          },
    ),
    observe_agent_exit: vi.fn(async () => ({
      ok: true as const,
      value: shell,
    })),
    release: vi.fn(async () => {
      closed = true;
      return { ok: true as const, value: undefined };
    }),
    wake: vi.fn(async () => ({ ok: true as const, value: { sent: true } })),
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
  const snapshot = vi.fn(async () => ({
    model: "fixture",
    agent_cli_version: "1",
    launch_profile_ref: "current-profile",
    harness: "pi" as const,
    effort: "high",
  }));
  const dispatcher = new Dispatcher({
    store: f.store,
    clock: f.clock,
    runtime,
    startRun,
    onError,
    snapshot,
  });
  const owner = () =>
    f.state().assignments.find((a) => a.id === target.assignment.id)!;
  return {
    ...f,
    target,
    runtime,
    dispatcher,
    startRun,
    onError,
    snapshot,
    owner,
    cliAlive: () => {
      shell = false;
    },
    comment: () =>
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
      ),
    instruct: () =>
      f.apply((s, a, p) =>
        issueInstruction(
          s,
          a,
          {
            card_id: target.card.id,
            work_item_id: target.item.id,
            body: "Sync the baseline and deliver again",
          },
          p,
        ),
      ),
  };
}
const replaced = (f: ReturnType<typeof setup>) =>
  f
    .state()
    .events.filter((e) => e.type === "session_replaced")
    .map((e) => e.payload);

test("an instruction to an idle owner whose CLI left a kept shell starts a fresh session instead of typing into the shell", async () => {
  const f = setup();
  const old = f.owner().runtime_ref;
  f.instruct();
  await f.dispatcher.tick([f.project]);
  // The bell waits (never typed into the shell) until the next maintenance
  // pass, at most one interval later.
  expect(f.runtime.wake).not.toHaveBeenCalled();
  expect(f.startRun).not.toHaveBeenCalled();
  f.advance(host.IDLE_ROLE_UPGRADE_INTERVAL_MS);
  await f.dispatcher.tick([f.project]);
  await f.dispatcher.tick([f.project]);
  expect(f.runtime.wake).not.toHaveBeenCalled();
  expect(f.runtime.release).toHaveBeenCalledExactlyOnceWith(old, {
    force: true,
  });
  expect(replaced(f)).toMatchObject([
    { reason: "agent_exited", old_runtime_ref: old },
  ]);
  expect(f.startRun).toHaveBeenCalledOnce();
  expect(f.state().runs.filter((r) => r.status === "dispatched")).toMatchObject(
    [{ assignment_id: f.owner().id, kind: "followup" }],
  );
  expect(f.onError).not.toHaveBeenCalled();
});

test("a retirement handoff (retained_for_dispatch) no longer swallows a notification once the CLI is proven gone", async () => {
  const f = setup();
  const a = f.owner();
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
        evidence: { stage: "probe", reason: "kept_terminal" },
      },
    }),
  );
  f.comment();
  await f.dispatcher.tick([f.project]);
  await f.dispatcher.tick([f.project]);
  expect(f.owner().idle_retirement).toBeUndefined();
  expect(replaced(f)).toMatchObject([{ reason: "agent_exited" }]);
  expect(f.runtime.wake).not.toHaveBeenCalled();
  expect(f.startRun).toHaveBeenCalledOnce();
});

test("an old-version owner whose CLI exited is upgraded and its pending bell starts on the latest role version", async () => {
  const f = setup({ upgrade: true });
  expect(f.owner().role_version).toBe(1);
  f.comment();
  await f.dispatcher.tick([f.project]);
  await f.dispatcher.tick([f.project]);
  expect(replaced(f)).toMatchObject([
    { reason: "agent_exited" },
    { reason: "default_role_upgraded", from_version: 1, to_version: 2 },
  ]);
  expect(f.owner().role_version).toBe(2);
  expect(f.runtime.wake).not.toHaveBeenCalled();
  expect(f.startRun).toHaveBeenCalledOnce();
  expect(f.snapshot).toHaveBeenCalledWith(
    expect.objectContaining({ id: f.owner().id, role_version: 2 }),
    f.project,
  );
  expect(f.state().runs.filter((r) => r.status === "dispatched")).toMatchObject(
    [{ assignment_id: f.owner().id, role_version: 2 }],
  );
});

test("a kept terminal whose CLI is still running is woken as before and never closed", async () => {
  const f = setup();
  f.cliAlive();
  f.comment();
  await f.dispatcher.tick([f.project]);
  await f.dispatcher.tick([f.project]);
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(replaced(f)).toEqual([]);
  expect(f.runtime.wake).toHaveBeenCalledOnce();
});

test("a human stop keeps the kept shell and its bell for the human start", async () => {
  const f = setup();
  const a = f.owner();
  f.apply(
    (s, actor, p) =>
      stopWorkItemAssignment(s, actor, { assignment_id: a.id }, p),
    { kind: "human", project_id: f.project },
  );
  f.comment();
  await host.upgradeIdleAssignmentRoles(f.store, f.project, f.runtime, f.clock);
  await f.dispatcher.tick([f.project]);
  expect(f.runtime.observe_agent_exit).not.toHaveBeenCalled();
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.owner().runtime_ref).toEqual(a.runtime_ref);
  expect(f.startRun).not.toHaveBeenCalled();
});
