import { queueRun, type Run } from "@cardigan/domain";
import { DEFAULT_DONE_SESSION_RELEASE_MS } from "@cardigan/host";
import { expect, test, vi } from "vitest";
import { setup } from "../test-support/dispatch-stalls.js";
import { Dispatcher } from "./dispatch.js";

// C-759 (sensen SEN-H-100, A-461 on cardigan-ci): the previous turn R-3915
// finished, the CLI reported `done` for 30 minutes and its session never
// exited, while the queued R-3985 (holding the machine's only emulator slot)
// waited for a fresh session. Each time a human ran `assignment stop`. The
// stall patrol now releases such a session itself, like that managed stop.

function idleDone() {
  const f = setup("local");
  f.ownTerminals();
  const original = vi.mocked(f.runtime.status).getMockImplementation()!;
  vi.mocked(f.runtime.status).mockImplementation(async (ref) => {
    const seen = await original(ref);
    return seen.ok &&
      seen.value.process === "alive" &&
      !f.working.has(ref.terminal_ref)
      ? { ok: true, value: { ...seen.value, agent: "done" } }
      : seen;
  });
  const queued = f.apply((s, a, p) =>
    queueRun(
      s,
      a,
      {
        assignment_id: f.target.assignment.id,
        model: "fixture",
        agent_cli_version: "fixture",
      },
      p,
    ),
  ) as Run;
  const events = (type: string) =>
    f.state().events.filter((e) => e.type === type);
  const owner = () =>
    f.state().assignments.find((a) => a.id === f.target.assignment.id)!;
  /** One stall-patrol pass (the poll runs in the background). */
  const pass = async () => {
    await f.service.tick();
    await new Promise((resolve) => setTimeout(resolve, 100));
  };
  return { ...f, queued, events, owner, pass };
}

test("C-759: an ended turn's idle session blocking a queued Run is released after the threshold; the Run starts in a new session", async () => {
  expect(DEFAULT_DONE_SESSION_RELEASE_MS).toBe(600_000);
  const f = idleDone();
  const ref = f.owner().runtime_ref;
  // Inside the window nothing is touched.
  f.advance(DEFAULT_DONE_SESSION_RELEASE_MS - 60_000);
  await f.pass();
  expect(f.runtime.release).not.toHaveBeenCalled();
  f.advance(61_000);
  await f.service.tick();
  await vi.waitFor(() =>
    expect(f.events("session_replaced")).toMatchObject([
      {
        payload: {
          assignment_id: f.owner().id,
          reason: "idle_session_stopped",
          trigger: "turn_done",
          queued_run_id: f.queued.id,
          workspace: "no_worktree",
          idle_basis: "terminal_status",
          cancelled_run_ids: [],
          old_runtime_ref: ref,
        },
      },
    ]),
  );
  expect(f.runtime.release).toHaveBeenCalledExactlyOnceWith(ref, {
    force: true,
  });
  expect(f.owner()).toMatchObject({ runtime_ref: null, status: "active" });
  expect(f.state().runs.find((r) => r.id === f.queued.id)?.status).toBe(
    "queued",
  );
  const dispatcher = new Dispatcher(f.options);
  try {
    await dispatcher.tick();
    await dispatcher.tick();
    expect(f.options.startRun).toHaveBeenCalledOnce();
    expect(f.options.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        run: expect.objectContaining({ id: f.queued.id }),
      }),
    );
  } finally {
    await dispatcher.close();
  }
});

test("C-759: a session whose CLI is not done, or whose Run is in flight, is never released", async () => {
  const f = idleDone();
  f.working.add(f.owner().runtime_ref!.terminal_ref);
  f.advance(DEFAULT_DONE_SESSION_RELEASE_MS + 60_000);
  await f.pass();
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.events("session_replaced")).toEqual([]);
  // The CLI is idle again, but a Run on the session started meanwhile.
  f.working.clear();
  f.store.uow.run((tx) =>
    tx.runs.put(f.project, {
      ...f.queued,
      status: "running",
      started_at: f.clock.now(),
    }),
  );
  f.advance(DEFAULT_DONE_SESSION_RELEASE_MS + 60_000);
  await f.pass();
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.owner().runtime_ref).not.toBeNull();
});

test("C-759: diagnostics single out idle sessions holding a scarce resource, with the tools that release them", async () => {
  const f = idleDone();
  const read = async () =>
    (
      (await f.service.tools.read(f.context)) as {
        idle_scarce_sessions: unknown[];
      }
    ).idle_scarce_sessions;
  // Without a scarce resource the idle session is not listed.
  expect(await read()).toEqual([]);
  f.store.uow.run((tx) => {
    const item = tx.work_items.get(f.project, f.target.item.id)!;
    tx.work_items.put(f.project, {
      ...item,
      requirements: { capabilities: ["android.emulator"] },
    });
  });
  f.advance(30 * 60_000);
  expect(await read()).toEqual([
    {
      assignment_id: f.owner().id,
      machine_id: "local",
      card_id: f.target.card.id,
      resources: ["android.emulator"],
      session_launch_run_id: null,
      queued_run_ids: [f.queued.id],
      last_activity_at: expect.any(String),
      idle_ms: expect.any(Number),
      release: {
        stop_session: "host_ops_stop_assignment",
        cancel_queued: "host_ops_cancel_run",
      },
    },
  ]);
  // A Run in flight on the session: not idle, not listed.
  f.store.uow.run((tx) =>
    tx.runs.put(f.project, {
      ...f.queued,
      status: "running",
      started_at: f.clock.now(),
    }),
  );
  expect(await read()).toEqual([]);
});
