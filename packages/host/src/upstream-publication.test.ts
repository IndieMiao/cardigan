import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runtime } from "@cardigan/domain";
import { parseLaunchConfig } from "@cardigan/roles";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import {
  assignment,
  fixture,
  run,
} from "../../domain/src/commands/test-fixtures.js";
import {
  type ConnectionProbe,
  UpstreamHealthMonitor,
} from "./upstream-health.js";

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-publication-state-"));
  const writer = Store.open({ dataDir }),
    reader = Store.open({ dataDir });
  let time = Date.parse("2026-01-01T00:10:00.000Z");
  const clock = { now: () => new Date(time).toISOString() };
  const config = parseLaunchConfig({
    providers: {
      relay: {
        harness: "codex",
        upstream: { group: "relay", probe_url: "https://fixture.invalid" },
      },
    },
    profiles: { agent: { harness: "codex", provider: "relay" } },
    upstream_health: {
      probe: { interval_ms: 1000, timeout_ms: 20, stale_after_ms: 60000 },
    },
  });
  const errors = vi.fn();
  const probe = vi
    .fn<ConnectionProbe>()
    .mockResolvedValue({ status: "reachable" });
  let background = new UpstreamHealthMonitor(
    config,
    {} as Runtime,
    clock,
    probe,
    writer,
    errors,
  );
  const web = new UpstreamHealthMonitor(
    config,
    {} as Runtime,
    clock,
    undefined,
    reader,
  );
  const state = {
    ...fixture(),
    assignments: [assignment(1), assignment(2)],
    runs: [1, 2].map((n) => ({ ...run(n), launch_profile_ref: "agent" })),
  };
  writer.createProject({ id: state.project_id });
  writer.uow.run((tx) => {
    for (const card of state.cards) tx.cards.put(state.project_id, card);
    for (const item of state.work_items)
      tx.work_items.put(state.project_id, item);
    for (const a of state.assignments) tx.assignments.put(state.project_id, a);
    for (const r of state.runs) tx.runs.put(state.project_id, r);
    for (const [type, payload] of [
      [
        "upstream_incident_started",
        {
          group: "relay",
          providers: ["relay"],
          assignment_ids: ["A-1", "A-2"],
        },
      ],
      [
        "run_inactive",
        { assignment_id: "A-1", run_id: "R-1", reason: "mcp_inactivity" },
      ],
    ] as const)
      tx.events.append(state.project_id, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(state.project_id),
        type,
        payload,
        actor: { kind: "system", project_id: state.project_id },
        created_at: "2026-01-01T00:00:00.000Z",
      });
  });
  const activity = {
    "A-1": "idle" as const,
    "A-2": { working_at: "2026-01-01T00:10:01.050Z" },
  };
  const view = (monitor: UpstreamHealthMonitor) => monitor.diagnostics(state);
  const action = (monitor: UpstreamHealthMonitor) =>
    monitor.diagnosis(state, "A-1", undefined, activity).action;
  background.schedule();
  await vi.waitFor(() =>
    expect(view(web).providers[0]?.status).toBe("reachable"),
  );
  return {
    writer,
    reader,
    errors,
    state,
    activity,
    probe,
    web,
    view,
    action,
    clock,
    background: () => background,
    advance() {
      time += 1000;
    },
    async restart() {
      await background.close();
      background = new UpstreamHealthMonitor(
        config,
        {} as Runtime,
        clock,
        probe,
        writer,
        errors,
      );
    },
    async close() {
      await background.close();
      await web.close();
      writer.close();
      reader.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test("unfinished publication blocks both real reconciliation paths from recording false recovery", async () => {
  const f = await setup();
  try {
    f.writer.database.exec(
      "CREATE TEMP TRIGGER reject_completion BEFORE INSERT ON upstream_probe_samples BEGIN SELECT RAISE(FAIL, 'synthetic completion failure'); END",
    );
    f.probe.mockResolvedValue({
      status: "unreachable",
      failure: "connection_error",
    });
    f.advance();
    f.background().schedule();
    await vi.waitFor(() =>
      expect(f.view(f.background()).providers[0]?.status).toBe("unreachable"),
    );
    expect(f.errors).toHaveBeenCalledOnce();
    for (const monitor of [f.background(), f.web]) {
      expect(f.view(monitor).classification_available).toBe(false);
      expect(f.action(monitor)).toBe("wait");
    }
    f.background().reconcile(f.writer, f.state.project_id, f.activity);
    f.web.reconcile(f.reader, f.state.project_id, f.activity);
    expect(
      f.writer
        .getUpdates({ project_id: f.state.project_id })
        .events.some((e) => e.type === "upstream_recovery_ready"),
    ).toBe(false);
    expect(JSON.stringify(f.view(f.web))).not.toContain("publication_id");
  } finally {
    await f.close();
  }
});

test("failure to establish the shared publication fence starts no network probe and blocks background recovery", async () => {
  const f = await setup();
  try {
    f.writer.database.exec(
      "CREATE TEMP TRIGGER reject_begin BEFORE UPDATE ON upstream_probe_samples BEGIN SELECT RAISE(FAIL, 'synthetic begin failure'); END",
    );
    f.probe.mockClear();
    f.advance();
    f.background().schedule();
    await vi.waitFor(() =>
      expect(f.view(f.background()).classification_available).toBe(false),
    );
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.action(f.background())).toBe("wait");
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.writer.database.exec("DROP TRIGGER reject_begin");
    f.probe.mockResolvedValue({
      status: "unreachable",
      failure: "connection_error",
    });
    f.advance();
    f.background().schedule();
    await vi.waitFor(() =>
      expect(f.view(f.web).providers[0]?.status).toBe("unreachable"),
    );
    expect(f.view(f.web).classification_available).toBe(true);
  } finally {
    await f.close();
  }
});

test("graceful cancellation releases its clean in-flight fence without inventing a completed failure", async () => {
  const f = await setup();
  const held = Promise.withResolvers<Awaited<ReturnType<ConnectionProbe>>>();
  try {
    f.probe.mockClear().mockReturnValue(held.promise);
    f.advance();
    f.background().schedule();
    await vi.waitFor(() => expect(f.probe).toHaveBeenCalledOnce());
    expect(f.view(f.web).classification_available).toBe(false);
    const closing = f.background().close();
    held.resolve({ status: "unreachable", failure: "timeout" });
    await closing;
    expect(f.view(f.web).classification_available).toBe(true);
    expect(f.view(f.web).providers[0]).toMatchObject({ status: "reachable" });
    expect(f.view(f.web).providers[0]?.last_failure_at).toBeUndefined();
    await f.restart();
    expect(f.view(f.background()).classification_available).toBe(true);
  } finally {
    held.resolve({ status: "reachable" });
    await f.close();
  }
});

test("lost publication context on restart stays closed; a later reachable sample cannot erase the unconfirmed failure", async () => {
  const f = await setup();
  try {
    f.writer.database.exec(
      "CREATE TEMP TRIGGER reject_completion BEFORE INSERT ON upstream_probe_samples BEGIN SELECT RAISE(FAIL, 'synthetic completion failure'); END",
    );
    f.probe.mockResolvedValue({
      status: "unreachable",
      failure: "connection_error",
    });
    f.advance();
    f.background().schedule();
    await vi.waitFor(() =>
      expect(f.view(f.background()).providers[0]?.status).toBe("unreachable"),
    );
    await f.restart();
    f.writer.database.exec("DROP TRIGGER reject_completion");
    f.probe.mockResolvedValue({ status: "reachable" });
    f.advance();
    f.background().schedule();
    await vi.waitFor(() =>
      expect(f.view(f.web).providers[0]?.checked_at).toBe(f.clock.now()),
    );
    for (const monitor of [f.web, f.background()]) {
      expect(f.view(monitor).classification_available).toBe(false);
      expect(f.action(monitor)).toBe("wait");
    }
    // A newly confirmed failure supplies a real later failure boundary. Merely
    // seeing a successful connection cannot prove a lost failure never happened.
    f.probe.mockResolvedValue({
      status: "unreachable",
      failure: "connection_error",
    });
    f.advance();
    f.background().schedule();
    await vi.waitFor(() =>
      expect(f.view(f.web).providers[0]?.status).toBe("unreachable"),
    );
    const failure = f.view(f.web).providers[0]?.last_failure_at;
    f.probe.mockResolvedValue({ status: "reachable" });
    f.advance();
    f.background().schedule();
    await vi.waitFor(() =>
      expect(f.view(f.web).providers[0]?.status).toBe("reachable"),
    );
    expect(f.view(f.web).classification_available).toBe(true);
    expect(f.view(f.web).providers[0]?.last_failure_at).toBe(failure);
  } finally {
    await f.close();
  }
});
