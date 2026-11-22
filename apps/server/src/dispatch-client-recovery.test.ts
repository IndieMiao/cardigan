import type { HarnessActivity, Runtime } from "@cardigan/domain";
import { expect, test, vi } from "vitest";
import { stalledTranscript } from "../test-support/dispatch.js";
import { setup } from "../test-support/dispatch-stalls.js";
import { ClientRecovery } from "./dispatch-client-recovery.js";

function disconnected(harness: "codex" | "claude-code") {
  const f = setup(),
    a = f.target.assignment;
  const r = f.session(a, false);
  f.store.uow.run((tx) => {
    tx.runs.put(f.project, { ...tx.runs.get(f.project, r.id)!, harness });
    tx.assignments.put(f.project, {
      ...tx.assignments.get(f.project, a.id)!,
      session_ref: "fixture-session",
    });
  });
  f.advance(45000);
  const original: HarnessActivity = {
    ...stalledTranscript(f.state(), a.id)!,
    error: harness === "codex" ? "stream_disconnected" : "unclassified",
    updated_at: f.clock.now(),
  };
  let sample: HarnessActivity | undefined = original;
  const runtime = {
    ...f.runtime,
    observe_prompt: vi.fn(async () => ({ ok: true as const, value: true })),
    wake: vi.fn<Runtime["wake"]>(async (_ref, _msg, guard) => {
      expect(guard?.before_send?.()).toBe(true);
      return { ok: true, value: { sent: true } };
    }),
  };
  const service = () =>
    new ClientRecovery(
      { ...f.options, runtime, harnessActivity: () => sample },
      f.clock,
      () => false,
    );
  const events = (type: string) =>
    f.state().events.filter((e) => e.type === type);
  return {
    f,
    a,
    r,
    original,
    runtime,
    service,
    events,
    setSample(s: HarnessActivity | undefined) {
      sample = s;
    },
  };
}

test.each(["codex", "claude-code"] as const)(
  "%s disconnect: same running Run, one durable send, then one ops handoff",
  async (harness) => {
    const { f, a, r, runtime, service, events } = disconnected(harness);
    await service().tick(f.state());
    expect(runtime.wake).toHaveBeenCalledTimes(1);
    expect(runtime.observe_prompt).toHaveBeenCalledWith(f.refFor(a), {
      project_id: f.project,
      assignment_id: a.id,
      harness,
      ...(harness === "claude-code" ? { require_disconnect: true } : {}),
    });
    expect(events("client_resume_sent")).toHaveLength(1);
    await service().tick(f.state()); // Service restart cannot mint another send budget.
    f.advance(60000);
    await service().tick(f.state());
    await service().tick(f.state());
    expect(runtime.wake).toHaveBeenCalledTimes(1);
    expect(events("client_resume_attention")).toHaveLength(1);
    expect(
      f.store
        .listNotifications({ project_id: f.project, assignment_id: f.ops.id })
        .some((n) => n.event_id === events("client_resume_attention")[0]?.id),
    ).toBe(true);
    expect(f.latest()).toMatchObject({ id: r.id, status: "running" });
    expect(runtime.release).not.toHaveBeenCalled();
  },
);

test.each(["mcp", "waiting", "settled", "session"])(
  "%s change before the send slot withdraws the continuation",
  async (race) => {
    const f = setup(),
      { assignment: a, item } = f.target,
      r = f.session(a, false);
    f.store.uow.run((tx) =>
      tx.runs.put(f.project, {
        ...tx.runs.get(f.project, r.id)!,
        harness: "codex",
      }),
    );
    f.advance(1000);
    const sample = {
      ...stalledTranscript(f.state(), a.id)!,
      error: "stream_disconnected" as const,
      updated_at: f.clock.now(),
    };
    const runtime = {
      ...f.runtime,
      observe_prompt: vi.fn(async () => ({ ok: true as const, value: true })),
      wake: vi.fn<Runtime["wake"]>(async (_ref, _msg, guard) => {
        f.store.uow.run((tx) => {
          const owner = tx.assignments.get(f.project, a.id)!;
          if (race === "waiting")
            tx.work_items.put(f.project, {
              ...tx.work_items.get(f.project, item.id)!,
              status: "waiting_decision",
            });
          if (race === "mcp")
            tx.assignments.put(f.project, {
              ...owner,
              last_mcp_activity_at: f.clock.now(),
            });
          if (race === "settled")
            tx.runs.put(f.project, {
              ...tx.runs.get(f.project, r.id)!,
              status: "completed",
            });
          if (race === "session")
            tx.assignments.put(f.project, { ...owner, session_ref: "other" });
        });
        expect(guard?.before_send?.()).toBe(false);
        return { ok: true, value: { sent: false, withdrawn: true } };
      }),
    };
    await new ClientRecovery(
      { ...f.options, runtime, harnessActivity: () => sample },
      f.clock,
      () => false,
    ).tick(f.state());
    expect(runtime.wake).toHaveBeenCalledOnce();
    expect(
      f.state().events.some((e) => e.type === "client_resume_claimed"),
    ).toBe(false);
  },
);

test.each(["screen", "metadata", "foreign_progress", "expired"])(
  "%s unavailable after a durable claim: one handoff even after restart",
  async (mode) => {
    const { f, original, service, runtime, events, setSample } =
      disconnected("claude-code");
    await service().tick(f.state());
    runtime.observe_prompt.mockRejectedValue(new Error("unavailable"));
    f.advance(60_000);
    if (mode === "metadata") setSample(undefined);
    if (mode === "expired") setSample({ ...original, stale_after_ms: 0 });
    if (mode === "foreign_progress") {
      const { error: _, ...progress } = original;
      setSample({
        ...progress,
        session_id: "different",
        updated_at: f.clock.now(),
      });
    }
    for (let i = 0; i < 5; i++) {
      await service().tick(f.state());
      f.advance(60_000);
    }
    expect(runtime.wake).toHaveBeenCalledOnce();
    expect(events("client_resume_sent")).toHaveLength(1);
    expect(events("client_resume_progressed")).toHaveLength(0);
    expect(events("client_resume_attention")).toHaveLength(1);
    expect(
      f.store
        .listNotifications({ project_id: f.project, assignment_id: f.ops.id })
        .filter((n) => n.event_id === events("client_resume_attention")[0]?.id),
    ).toHaveLength(1);
  },
);

test.each(["mcp", "model"])(
  "attributable %s progress closes the watch durably, but never replenishes the budget",
  async (mode) => {
    const { f, a, original, service, runtime, events, setSample } =
      disconnected("claude-code");
    await service().tick(f.state());
    f.advance(60_000);
    if (mode === "mcp")
      f.store.uow.run((tx) =>
        tx.assignments.put(f.project, {
          ...tx.assignments.get(f.project, a.id)!,
          last_mcp_activity_at: f.clock.now(),
        }),
      );
    else {
      const { error: _, ...progress } = original;
      setSample({ ...progress, updated_at: f.clock.now() });
    }
    await service().tick(f.state());
    setSample(undefined);
    f.advance(120_000);
    await service().tick(f.state());
    expect(events("client_resume_progressed")).toHaveLength(1);
    expect(events("client_resume_attention")).toHaveLength(0);
    // Fresh, attributed disconnect with the confirmed terminal screen in the same Run.
    setSample({ ...original, updated_at: f.clock.now() });
    await service().tick(f.state());
    expect(runtime.wake).toHaveBeenCalledOnce();
    expect(events("client_resume_attention")).toHaveLength(1);
  },
);

test("new progress followed by another error between patrols is not a second send budget", async () => {
  const { f, original, service, runtime, events, setSample } =
    disconnected("codex");
  await service().tick(f.state());
  f.advance(15000);
  const latestProgress = f.clock.now();
  f.advance(15000);
  setSample({
    ...original,
    last_progress_at: latestProgress,
    updated_at: f.clock.now(),
  });
  f.advance(30000);
  await service().tick(f.state());
  expect(events("client_resume_progressed")[0]?.payload).toMatchObject({
    progress_at: latestProgress,
  });
  f.advance(60000);
  await service().tick(f.state());
  expect(runtime.wake).toHaveBeenCalledOnce();
  expect(events("client_resume_attention")).toHaveLength(1);
});
