import type { HarnessActivity, Runtime } from "@cardigan/domain";
import { beginBellAttempt } from "@cardigan/store";
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

test.each([
  "mcp",
  "waiting",
  "settled",
  "session",
  "hold",
  "stopping",
  "role_upgrade",
  "bell",
  "dependency",
])(
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
    const dependency = race === "dependency" ? f.create().card : undefined;
    const notice =
      race === "bell"
        ? f.event("fixture_bell", {}, a, item.card_id)
        : undefined;
    const runtime = {
      ...f.runtime,
      observe_prompt: vi.fn(async () => ({ ok: true as const, value: true })),
      wake: vi.fn<Runtime["wake"]>(async (_ref, _msg, guard) => {
        f.store.uow.run((tx) => {
          const owner = tx.assignments.get(f.project, a.id)!;
          if (race === "hold" || race === "dependency") {
            const card = tx.cards.get(f.project, item.card_id)!;
            tx.cards.put(
              f.project,
              race === "hold"
                ? {
                    ...card,
                    hold: {
                      reason: "fixture",
                      resume_condition: "review",
                      set_by: "human",
                      set_at: f.clock.now(),
                    },
                  }
                : { ...card, depends_on_cards: [dependency!.id] },
            );
          }
          if (race === "stopping")
            tx.assignments.put(f.project, {
              ...owner,
              idle_retirement: {
                phase: "stopping",
                runtime_ref: owner.runtime_ref!,
                started_at: f.clock.now(),
                threshold_minutes: 60,
                failures: 0,
              },
            });
          if (race === "role_upgrade")
            tx.assignments.put(f.project, {
              ...owner,
              role_upgrade: {
                role_version: owner.role_version + 1,
                previous_runtime_ref: owner.runtime_ref,
              },
            });
          if (notice) {
            const note = f.store
              .listNotifications({ project_id: f.project, assignment_id: a.id })
              .find((n) => n.event_id === notice.id)!;
            beginBellAttempt(f.store.database, {
              project_id: f.project,
              id: "in-flight",
              assignment_id: a.id,
              run_id: r.id,
              notification_ids: [note.id],
              started_at: f.clock.now(),
              lease_until: new Date(
                Date.parse(f.clock.now()) + 60000,
              ).toISOString(),
            });
          }
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

test("two observers of the same unclaimed Run compete at the durable send boundary", async () => {
  const { f, runtime, service, events } = disconnected("codex");
  // Delay the second observation's response until after the first writer has
  // released the host lock. Both patrols used the same pre-claim snapshot.
  const observed = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const snapshot = f.state();
  runtime.observe_prompt.mockImplementationOnce(async () => {
    observed.resolve();
    await release.promise;
    return { ok: true, value: true };
  });
  const decisions: boolean[] = [];
  const typed = vi.fn();
  runtime.wake.mockImplementation(async (_ref, text, guard) => {
    const allowed = guard?.before_send?.() === true;
    decisions.push(allowed);
    if (allowed) typed(text);
    return {
      ok: true,
      value: allowed ? { sent: true } : { sent: false, withdrawn: true },
    };
  });
  const delayed = service().tick(snapshot);
  try {
    await observed.promise;
    await service().tick(snapshot);
  } finally {
    release.resolve();
    await delayed;
  }
  expect(runtime.observe_prompt).toHaveBeenCalledTimes(2);
  expect(decisions).toEqual([true, false]);
  expect(typed).toHaveBeenCalledTimes(1);
  expect(events("client_resume_claimed")).toHaveLength(1);
  expect(events("client_resume_sent")).toHaveLength(1);
});
