// C-669: the host_ops patrol's own automatic restart (standing_backlog) was
// withdrawn before any signal (identity_changed) and nobody resumed it, even
// though neither its terminal nor its processes were left: only a human start
// helped. The patrol now re-judges the incident on later rounds and resumes it
// once the old session is kernel-proven gone; a live one is left untouched.
import type { RuntimeRef } from "@cardigan/domain";
import { expect, test, vi } from "vitest";
import { setup } from "../test-support/dispatch-stalls.js";

const RETRY_MS = 60_000;

async function withdrawnPatrol() {
  const f = setup();
  f.ownTerminals();
  const a = f.ops;
  const ref: RuntimeRef = { ...f.refFor(a), local_process_receipt: "receipt" };
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, {
      ...a,
      runtime_ref: ref,
      runtime_state: "idle",
      session_ref: "old",
    }),
  );
  // Kernel view of the launch receipt's process group; alive until it exits.
  let groupGone = false;
  f.runtime.confirm_local_group_exit = vi.fn(async () => ({
    ok: true as const,
    value: groupGone,
  }));
  const retire = vi.mocked(
    f.runtime.retire_idle as NonNullable<typeof f.runtime.retire_idle>,
  );
  retire.mockResolvedValueOnce({
    ok: true,
    value: {
      outcome: "withdrawn",
      evidence: { stage: "get", reason: "identity_changed" },
    },
  });
  f.event("host_ops_patrol_due", { assignment_id: a.id }, a);
  f.advance(11 * 60_000);
  const events = (type: string) =>
    f.state().events.filter((e) => e.type === type);
  await f.service.tick();
  await vi.waitFor(async () => {
    await f.service.tick();
    expect(events("host_ops_action_finished")).toMatchObject([
      {
        payload: {
          result: "withdrawn_stall_changed",
          reason: "identity_changed",
        },
      },
    ]);
  });
  expect(retire).toHaveBeenCalledOnce();
  /** The terminal is no longer listed; its processes as the kernel says. */
  const vanish = (processes: "gone" | "alive") => {
    groupGone = processes === "gone";
    const missing = {
      ok: false as const,
      error: { code: "runtime_not_found" as const, message: "gone" },
    };
    vi.mocked(f.runtime.status).mockResolvedValue(missing);
    f.runtime.observe_retirement = vi.fn(async () => missing);
  };
  const queued = () =>
    f
      .state()
      .runs.filter((r) => r.assignment_id === a.id && r.status === "queued");
  /** Several patrol rounds past the retry interval. */
  const rounds = async () => {
    for (let i = 0; i < 3; i++) {
      f.advance(RETRY_MS);
      await f.service.tick();
      await f.service.tick();
    }
  };
  return { f, a, ref, retire, events, vanish, queued, rounds };
}

test("C-669: after a withdrawn restart, a patrol whose terminal and processes are gone is resumed on a later round", async () => {
  const { f, a, retire, events, vanish, queued } = await withdrawnPatrol();
  vanish("gone");
  // Not before the retry interval: the withdrawal is still fresh.
  await f.service.tick();
  expect(events("host_ops_action_taken")).toHaveLength(1);
  f.advance(RETRY_MS);
  await f.service.tick();
  await vi.waitFor(async () => {
    await f.service.tick();
    expect(queued()).toHaveLength(1);
  });
  expect(events("host_ops_action_taken")).toHaveLength(2);
  expect(events("host_ops_action_taken")[1]?.actor.kind).toBe("system");
  // Settled from the kernel proof: no second stop, nothing released by address.
  expect(retire).toHaveBeenCalledOnce();
  expect(f.runtime.release).not.toHaveBeenCalled();
  const owner = f.state().assignments.find((v) => v.id === a.id);
  expect(owner?.runtime_ref).toBeNull();
  expect(owner?.session_ref).toBeUndefined();
  // Once resumed, the incident is not retried again.
  f.advance(RETRY_MS);
  await f.service.tick();
  await f.service.tick();
  expect(events("host_ops_action_taken")).toHaveLength(2);
  expect(queued()).toHaveLength(1);
});

test("C-669: an old session that is still alive keeps the withdrawal; diagnostics give the reason and the next step", async () => {
  const { f, a, ref, retire, events, queued, rounds } = await withdrawnPatrol();
  const [row] = (await f.view()).dispatch_stalls.filter(
    (s) => s.assignment_id === a.id,
  );
  expect(row).toMatchObject({
    kind: "standing_backlog",
    withdrawn_reason: "identity_changed",
    next_step: expect.stringContaining("identity_changed"),
  });
  expect((row as { next_step?: string }).next_step).toContain("主机运维");
  await rounds();
  expect(events("host_ops_action_taken")).toHaveLength(1);
  expect(retire).toHaveBeenCalledOnce();
  // C-680: never stopped again; only a Run is queued for the same session.
  expect(queued()).toMatchObject([{ kind: "initial" }]);
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.state().assignments.find((v) => v.id === a.id)?.runtime_ref).toEqual(
    ref,
  );
});

test("C-669: a listed-gone terminal whose process group the kernel still sees is not resumed", async () => {
  const { f, a, ref, retire, events, vanish, queued, rounds } =
    await withdrawnPatrol();
  vanish("alive");
  await rounds();
  expect(events("host_ops_action_taken")).toHaveLength(1);
  expect(retire).toHaveBeenCalledOnce();
  expect(queued()).toEqual([]);
  expect(f.state().assignments.find((v) => v.id === a.id)?.runtime_ref).toEqual(
    ref,
  );
});

test("C-669: a human stop is never resumed by the patrol, even once the session is gone", async () => {
  const { f, a, retire, events, vanish, queued, rounds } =
    await withdrawnPatrol();
  f.event("assignment_stopped", { assignment_id: a.id, hold: true });
  vanish("gone");
  await rounds();
  expect(events("host_ops_action_taken")).toHaveLength(1);
  expect(retire).toHaveBeenCalledOnce();
  expect(queued()).toEqual([]);
  expect(f.options.startRun).not.toHaveBeenCalled();
});
