import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HarnessActivity, Runtime } from "@cardigan/domain";
import { readSessionContexts } from "@cardigan/host";
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
    observe_prompt: vi.fn<NonNullable<Runtime["observe_prompt"]>>(async () => ({
      ok: true as const,
      value: true,
    })),
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
  "attention",
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
        if (race === "attention")
          f.event("client_resume_attention", { run_id: r.id });
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

test.each(["screen", "metadata", "foreign_progress", "rebound", "expired"])(
  "%s unavailable after a durable claim: one handoff even after restart",
  async (mode) => {
    const { f, original, service, runtime, events, setSample } =
      disconnected("claude-code");
    await service().tick(f.state());
    runtime.observe_prompt.mockRejectedValue(new Error("unavailable"));
    f.advance(60_000);
    if (mode === "metadata") setSample(undefined);
    if (mode === "rebound") {
      f.store.uow.run((tx) =>
        tx.assignments.put(f.project, {
          ...tx.assignments.get(f.project, original.assignment_id)!,
          session_ref: "replacement",
          last_mcp_activity_at: f.clock.now(),
        }),
      );
    }
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

test("attributable MCP progress closes the watch durably, but never replenishes the budget", async () => {
  const { f, a, original, service, runtime, events, setSample } =
    disconnected("claude-code");
  await service().tick(f.state());
  f.advance(60_000);
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, {
      ...tx.assignments.get(f.project, a.id)!,
      last_mcp_activity_at: f.clock.now(),
    }),
  );
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
});

test("new progress followed by another error between patrols is not a second send budget", async () => {
  const { f, original, service, runtime, events, setSample } =
    disconnected("codex");
  await service().tick(f.state());
  f.advance(15000);
  const latestProgress = f.clock.now();
  f.advance(15000);
  setSample({
    ...original,
    model_output_at: latestProgress,
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

test.each(["codex", "claude-code"] as const)(
  "%s transcript replay: distinguish the echoed resume from verified model output",
  async (harness) => {
    for (const resumed of [false, true]) {
      const { f, a, r, runtime, service, setSample, events } =
        disconnected(harness);
      const root = join(f.dataDir, "runs", f.project, a.id);
      const cwd = a.worktree_path ?? root;
      const codex = harness === "codex";
      const file = codex
        ? join(root, "codex/sessions/rollout-2026-01-01.jsonl")
        : join(root, "claude/projects/fixture/fixture-session.jsonl");
      await mkdir(dirname(file), { recursive: true });
      const record = (data: object) =>
        appendFile(
          file,
          `${JSON.stringify({ timestamp: f.clock.now(), ...(!codex ? { sessionId: "fixture-session", cwd } : {}), ...data })}\n`,
        );
      const patrol = async () => {
        const diagnostics = await readSessionContexts(
          f.state(),
          { execution: { mode: "local", dataDir: f.dataDir } },
          f.clock.now(),
        );
        const sample = diagnostics.find(
          (v) => v.assignment_id === a.id,
        )?.activity;
        expect(sample).toMatchObject({
          run_id: r.id,
          session_id: "fixture-session",
        });
        setSample(sample);
        await service().tick(f.state());
      };
      if (codex)
        await record({
          type: "session_meta",
          payload: { id: "fixture-session", cwd },
        });
      const fault = () =>
        record(
          codex
            ? {
                type: "event_msg",
                payload: {
                  type: "error",
                  codex_error_info: "stream_disconnected",
                },
              }
            : { type: "system", subtype: "api_error" },
        );
      await fault();
      await patrol();
      expect(runtime.wake).toHaveBeenCalledOnce();
      f.advance(1000);
      await record(
        codex
          ? {
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: `请继续当前 ${r.id} 未完成的工作。`,
                  },
                ],
              },
            }
          : { type: "user", message: { content: "continue" } },
      );
      if (codex) {
        await record({ type: "event_msg", payload: { type: "task_started" } });
        await record({
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "tool-1",
            output: "fixture",
          },
        });
        await record({
          type: "event_msg",
          payload: { type: "token_count", info: {} },
        });
      }
      const at = f.clock.now();
      if (resumed) {
        await record(
          codex
            ? {
                type: "response_item",
                payload: {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "Working" }],
                },
              }
            : {
                type: "assistant",
                message: { content: [{ type: "text", text: "Working" }] },
              },
        );
        f.advance(1000);
        await record(
          codex
            ? { type: "event_msg", payload: { type: "task_started" } }
            : { type: "user", message: { content: "continue" } },
        );
      }
      f.advance(60000);
      await patrol();
      expect(events("client_resume_progressed")).toHaveLength(resumed ? 1 : 0);
      expect(events("client_resume_attention")).toHaveLength(resumed ? 0 : 1);
      if (resumed) {
        expect(events("client_resume_progressed")[0]?.payload).toMatchObject({
          progress_at: at,
        });
        await fault();
      }
      for (let i = 0; i < 3; i++) {
        f.advance(60000);
        await patrol();
      }
      expect(runtime.wake).toHaveBeenCalledOnce();
      expect(events("client_resume_attention")).toHaveLength(1);
      expect(
        f.store
          .listNotifications({ project_id: f.project, assignment_id: f.ops.id })
          .filter(
            (n) => n.event_id === events("client_resume_attention")[0]?.id,
          ),
      ).toHaveLength(1);
    }
  },
);

test.each(["clear", "still disconnected", "unreadable", "draft", "rebound"])(
  "screen-only worker after MCP progress: %s",
  async (mode) => {
    const { f, a, r, runtime, service, events, setSample } =
      disconnected("codex");
    setSample(undefined);
    f.store.uow.run((tx) =>
      tx.runs.put(f.project, {
        ...tx.runs.get(f.project, r.id)!,
        bell_delivery: {
          run_id: r.id,
          runtime_ref: f.refFor(a),
          session_ref: "fixture-session",
          sent_at: f.clock.now(),
          received_at: f.clock.now(),
        },
      }),
    );
    let screen = "disconnected";
    runtime.observe_prompt.mockImplementation(async (_ref, binding) => {
      if (screen === "unreadable") throw Error("unavailable");
      return {
        ok: true,
        value:
          binding.require_disconnect === true
            ? screen === "disconnected"
            : binding.require_disconnect === false && screen === "clear",
      };
    });
    f.advance(61000);
    await service().tick(f.state());
    expect(runtime.wake).toHaveBeenCalledOnce();
    f.advance(60000);
    f.store.uow.run((tx) =>
      tx.assignments.put(f.project, {
        ...tx.assignments.get(f.project, a.id)!,
        last_mcp_activity_at: f.clock.now(),
      }),
    );
    screen =
      mode === "still disconnected"
        ? "disconnected"
        : mode === "rebound"
          ? "clear"
          : mode;
    await service().tick(f.state());
    expect(events("client_resume_progressed")).toHaveLength(1);
    expect(events("client_resume_screen_cleared")).toHaveLength(
      mode === "clear" || mode === "rebound" ? 1 : 0,
    );
    if (mode === "rebound")
      f.store.uow.run((tx) =>
        tx.assignments.put(f.project, {
          ...tx.assignments.get(f.project, a.id)!,
          session_ref: "replacement",
        }),
      );
    f.advance(61000);
    await service().tick(f.state());
    expect(events("client_resume_attention")).toHaveLength(0);
    screen = "disconnected";
    for (let i = 0; i < 5; i++) {
      f.advance(60000);
      await service().tick(f.state());
    }
    expect(runtime.wake).toHaveBeenCalledOnce();
    const alerts = events("client_resume_attention");
    expect(alerts).toHaveLength(mode === "clear" ? 1 : 0);
    if (mode === "clear")
      expect(
        f.store
          .listNotifications({ project_id: f.project, assignment_id: f.ops.id })
          .filter((n) => n.event_id === alerts[0]?.id),
      ).toHaveLength(1);
  },
);
