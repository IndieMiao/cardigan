import type { HarnessActivity, Runtime } from "@cardigan/domain";
import { expect, test, vi } from "vitest";
import { stalledTranscript } from "../test-support/dispatch.js";
import { setup } from "../test-support/dispatch-stalls.js";
import { ClientRecovery } from "./dispatch-client-recovery.js";

test.each(["codex", "claude-code"] as const)(
  "%s disconnect: same running Run, one durable send, then one ops handoff",
  async (harness) => {
    const f = setup(),
      a = f.target.assignment;
    const r = f.session(a, false);
    f.store.uow.run((tx) =>
      tx.runs.put(f.project, { ...tx.runs.get(f.project, r.id)!, harness }),
    );
    f.advance(45000);
    const sample: HarnessActivity = {
      ...stalledTranscript(f.state(), a.id)!,
      error: harness === "codex" ? "stream_disconnected" : "unclassified",
      updated_at: f.clock.now(),
    };
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
