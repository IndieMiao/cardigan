import { dispatchRun, postComment, type Runtime } from "@cardigan/domain";
import * as host from "@cardigan/host";
import { afterEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher } from "./dispatch.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.restoreAllMocks();
});

function setup(roleUpgradePass: "beside" | "default" = "beside") {
  const f = dispatchFixture();
  cleanup.push(() => f.close());
  const target = f.create();
  const runtime: Runtime = {
    status: vi.fn(async () => ({
      ok: true as const,
      value: {
        process: "alive" as const,
        agent: "idle" as const,
        observed_seq: 1,
      },
    })),
    wake: vi.fn(async () => ({ ok: true as const, value: { sent: true } })),
    provision: async () => {
      throw new Error("use host callback");
    },
    release: vi.fn(async () => ({ ok: true as const, value: undefined })),
    interrupt: async () => ({ ok: true as const, value: undefined }),
    resume_or_replace: async () => {
      throw new Error("unused");
    },
    human_entry: async () => ({ ok: true as const, value: "fixture" }),
  };
  const startRun = vi.fn(async ({ run, assignment }) => {
    f.apply((s, a, p) =>
      dispatchRun(
        s,
        a,
        { run_id: run.id, runtime_ref: f.refFor(assignment) },
        p,
      ),
    );
  });
  const dispatcher = new Dispatcher({
    ...(roleUpgradePass === "beside" ? { roleUpgradePass } : {}),
    store: f.store,
    clock: f.clock,
    runtime,
    startRun,
    snapshot: async () => ({ model: "m", agent_cli_version: "1" }),
  });
  cleanup.push(() => void dispatcher.close());
  const comment = () =>
    f.apply((s, a, p) =>
      postComment(
        s,
        a,
        {
          card_id: target.card.id,
          work_item_id: target.item.id,
          body: "Start",
        },
        p,
      ),
    );
  return { f, target, dispatcher, startRun, comment };
}

test("C-788: a slow idle role-upgrade pass runs beside dispatch, not inside its tick", async () => {
  const { f, dispatcher, startRun, comment } = setup();
  let finish!: () => void;
  const pass = vi
    .spyOn(host, "upgradeIdleAssignmentRoles")
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
  comment();
  // The tick returns while the pass is still running (it used to wait).
  await dispatcher.tick();
  expect(pass).toHaveBeenCalledOnce();
  // Its project's work-item session is not started under the running pass.
  expect(startRun).not.toHaveBeenCalled();
  f.advance(1_000);
  await dispatcher.tick();
  expect(startRun).not.toHaveBeenCalled();
  // One pass at a time, at most once a minute per project.
  expect(pass).toHaveBeenCalledOnce();
  finish();
  await dispatcher.roleUpgradesSettled();
  f.advance(1_000);
  await dispatcher.tick();
  expect(startRun).toHaveBeenCalledOnce();
  expect(pass).toHaveBeenCalledOnce();
  f.advance(host.IDLE_ROLE_UPGRADE_INTERVAL_MS);
  await dispatcher.tick();
  await dispatcher.roleUpgradesSettled();
  expect(pass).toHaveBeenCalledTimes(2);
});

test("C-788: close waits for a running role-upgrade pass", async () => {
  const { dispatcher } = setup();
  let finish!: () => void;
  vi.spyOn(host, "upgradeIdleAssignmentRoles").mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await dispatcher.tick();
  let closed = false;
  const closing = dispatcher.close().then(() => {
    closed = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  expect(closed).toBe(false);
  finish();
  await closing;
  expect(closed).toBe(true);
});

test("C-788: by default the pass runs inside routing, before delivery", async () => {
  const { dispatcher, startRun, comment } = setup("default");
  let finish!: () => void;
  const pass = vi
    .spyOn(host, "upgradeIdleAssignmentRoles")
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
  comment();
  let ticked = false;
  const tick = dispatcher.tick().then(() => {
    ticked = true;
  });
  await vi.waitFor(() => expect(pass).toHaveBeenCalledOnce());
  await new Promise((r) => setTimeout(r, 10));
  // The tick waits for the pass; nothing is delivered meanwhile.
  expect(ticked).toBe(false);
  expect(startRun).not.toHaveBeenCalled();
  finish();
  await tick;
  // The same tick delivers once the pass is done.
  expect(startRun).toHaveBeenCalledOnce();
  await dispatcher.roleUpgradesSettled();
});
