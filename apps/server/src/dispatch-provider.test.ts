import {
  type AssignmentId,
  acknowledgeRun,
  dispatchRecoveryUsed,
  postComment,
  providerAdmission,
} from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { Dispatcher } from "./dispatch.js";
import { needsYou } from "./web/read.js";

test("C-499: repeated silent 503s do not start work; only one real launch probes after cooldown, even across restart", async () => {
  const f = recoveryFixture();
  const profile = "relay";
  const options = {
    ...f.options,
    dispatchTimeoutMs: 100,
    providerCooldownMs: 500,
    snapshot: async () => ({
      model: "session-model",
      agent_cli_version: "session-cli",
      launch_profile_ref: profile,
    }),
    inspectHarnessActivity: async (_p: string, id?: AssignmentId) => {
      const state = f.state(),
        owner = state.assignments.find((a) => a.id === id),
        run = state.runs.findLast((r) => r.assignment_id === id);
      if (!owner?.runtime_ref || !run) return new Map();
      return new Map([
        [
          owner.id,
          {
            status: "fresh" as const,
            activity: {
              assignment_id: owner.id,
              run_id: run.id,
              session_id: owner.session_ref ?? "session",
              runtime_key: JSON.stringify(owner.runtime_ref),
              source: "codex:session_metadata",
              updated_at: f.clock.now(),
              stale_after_ms: 60000,
              model_silent_since: 0,
              error: "server_error" as const,
            },
          },
        ],
      ]);
    },
  };
  const d = new Dispatcher(options);
  try {
    // This assignment has a prior session; the two new cards have never started.
    const assignments = [f.create(), f.create()];
    for (const t of assignments)
      f.apply((s, a, p) =>
        postComment(
          s,
          a,
          { card_id: t.card.id, work_item_id: t.item.id, body: "Start" },
          p,
        ),
      );
    const latest = (id: AssignmentId) =>
      f.state().runs.findLast((r) => r.assignment_id === id);
    await d.tick();
    const initial = assignments.map((t) => latest(t.assignment.id));
    expect(initial.map((r) => r?.status)).toEqual(["dispatched", "dispatched"]);
    f.advance(100);
    await d.tick();
    for (const t of assignments) {
      expect(
        f
          .state()
          .runs.find((r) => r.id === initial[assignments.indexOf(t)]?.id),
      ).toMatchObject({
        failure_reason: "provider_unavailable",
        summary: expect.stringContaining("模型服务不可用"),
      });
      expect(latest(t.assignment.id)).toMatchObject({
        status: "queued",
        queue_reason: "provider_unavailable",
      });
      expect(f.state().work_items.find((w) => w.id === t.item.id)?.status).toBe(
        t.item.status,
      );
      expect(dispatchRecoveryUsed(f.state().events, t.assignment.id)).toBe(
        false,
      );
    }
    expect(f.state().reviews).toEqual([]);
    expect(
      f
        .state()
        .events.filter(
          (e) =>
            e.type === "provider_start_failed" &&
            !!(e.payload as { notice?: string }).notice,
        ),
    ).toHaveLength(1);
    expect(
      f.store
        .listNotifications({ project_id: f.project })
        .filter(
          (n) =>
            n.recipient.kind === "pm_ops" &&
            f
              .state()
              .events.some(
                (e) =>
                  e.id === n.event_id && e.type === "provider_start_failed",
              ),
        ),
    ).toHaveLength(1);
    expect(needsYou(f.state(), f.clock.now()).provider_incidents).toEqual([
      { profile, paused: true },
    ]);
    expect(
      providerAdmission(
        f.state(),
        "independent-profile",
        f.clock.now(),
        () => true,
      ),
    ).toBeUndefined();
    const reopened = Store.open({ dataDir: f.dataDir });
    try {
      const other = new Dispatcher({ ...options, store: reopened });
      f.advance(499);
      await other.tick();
      expect(assignments.map((t) => latest(t.assignment.id)?.status)).toEqual([
        "queued",
        "queued",
      ]);
      f.advance(1);
      await Promise.all([d.tick(), other.tick()]);
      const probes = assignments
        .map((t) => latest(t.assignment.id))
        .filter((r) => r?.status === "dispatched");
      expect(probes).toHaveLength(1);
      const probe = probes[0];
      if (!probe) throw new Error("missing recovery probe");
      expect(probe.provider_probe).toBeDefined();
      const owner = assignments.find(
        (t) => t.assignment.id === probe.assignment_id,
      );
      if (!owner) throw new Error("missing owner");
      f.apply(
        (s, a, p) => acknowledgeRun(s, a, { run_id: probe.id }, p),
        f.actorFor(owner.assignment),
      );
      expect(
        needsYou(f.state(), f.clock.now()).provider_incidents,
      ).toBeUndefined();
      await other.tick();
      expect(
        assignments.map((t) => latest(t.assignment.id)?.status).sort(),
      ).toEqual(["dispatched", "running"]);
      expect(f.state().events.some((e) => e.type === "run_inactive")).toBe(
        false,
      );
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});
