import {
  type Assignment,
  type CardId,
  createHostOpsAssignment,
  dispatchRun,
  HOST_OPS_ROLE_TOOLS,
  queueRun,
} from "@cardigan/domain";
import { PROJECT_EVENT_STREAM, Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { runtimeEvents } from "../test-support/runtime-events.js";
import { standingResolver } from "./assembly.js";
import { Dispatcher } from "./dispatch.js";
import { alertAudience } from "./dispatch-alert.js";
import { RuntimeMonitor } from "./dispatch-monitor.js";

let f: ReturnType<typeof recoveryFixture>;
let hostOps: Assignment;
beforeEach(() => {
  f = recoveryFixture();
  f.store.uow.run((tx) =>
    tx.roles.put(f.project, {
      role_id: "host_ops",
      role_version: 1,
      allowed_tools: HOST_OPS_ROLE_TOOLS,
      capabilities: [],
    }),
  );
  hostOps = f.apply((s, a, p) =>
    createHostOpsAssignment(s, a, {}, p),
  ).assignment;
  f.session(hostOps);
});
afterEach(() => f.close());

function pm(mode: "ops" | "office") {
  const a = { ...f.pm(), standing_mode: mode };
  f.store.uow.run((tx) => tx.assignments.put(f.project, a));
  return a;
}
const options = () => ({
  ...f.options,
  standing: standingResolver(f.store),
  inactivityGraceMs: 100,
  inactiveCancelAfterMs: null,
  dispatchTimeoutMs: 100,
});
const hostNotes = () =>
  f.store.listNotifications({
    project_id: f.project,
    assignment_id: hostOps.id,
  });
const hostBells = () =>
  vi
    .mocked(f.runtime.wake)
    .mock.calls.filter(
      ([ref]) => ref.terminal_ref === f.refFor(hostOps).terminal_ref,
    );

async function trigger(
  owner: Assignment,
  cause: "inactive" | "lost" | "timeout" | "stop_unconfirmed",
) {
  if (cause === "timeout" || cause === "stop_unconfirmed") {
    const run = f.apply((s, a, p) =>
      queueRun(
        s,
        a,
        {
          assignment_id: owner.id,
          model: "fixture",
          agent_cli_version: "fixture",
        },
        p,
      ),
    );
    f.apply((s, a, p) =>
      dispatchRun(s, a, { run_id: run.id, runtime_ref: f.refFor(owner) }, p),
    );
    f.skipEvents();
    if (cause === "stop_unconfirmed")
      vi.mocked(f.runtime.release).mockResolvedValue({
        ok: true,
        value: undefined,
      });
    f.advance(100);
    await new Dispatcher(options()).tick();
    if (cause === "timeout") {
      // The first timeout uses the existing automatic recovery budget.
      expect(hostNotes()).toEqual([]);
      f.advance(100);
    }
  } else {
    f.session(owner, false);
    f.skipEvents();
    if (cause === "lost") {
      const events = runtimeEvents();
      const monitor = new RuntimeMonitor({
        store: f.store,
        runtime: events.source,
        clock: f.clock,
        standing: standingResolver(f.store),
        lossGraceMs: 100,
      });
      try {
        monitor.reconcile();
        events.send({
          seq: 1,
          type: "lost",
          terminal_ref: f.refFor(owner).terminal_ref,
        });
        await expect
          .poll(
            () =>
              f.state().assignments.find((a) => a.id === owner.id)
                ?.runtime_state,
          )
          .toBe("unknown");
        f.advance(100);
        monitor.reconcile();
      } finally {
        await monitor.stop();
      }
    } else {
      f.advance(100);
    }
  }
  await new Dispatcher(options()).tick();
  const type =
    cause === "inactive"
      ? "run_inactive"
      : cause === "lost"
        ? "runtime_lost"
        : "run_dispatch_stalled";
  const event = f.state().events.find((e) => e.type === type);
  if (!event) throw new Error(`Missing ${type}`);
  return event;
}

test.each(
  (["ops", "office"] as const).flatMap((mode) =>
    (["inactive", "lost", "timeout", "stop_unconfirmed"] as const).map(
      (cause) => ({ mode, cause }),
    ),
  ),
)(
  "C-220 standing PM $mode $cause alerts and bells host_ops once, then ACK closes its notice",
  async ({ mode, cause }) => {
    const owner = pm(mode);
    const event = await trigger(owner, cause);
    expect(hostNotes()).toMatchObject([
      { event_id: event.id, kind: "run_attention", status: "belled" },
    ]);
    expect(hostBells()).toHaveLength(1);
    expect(hostBells()[0]?.[1]).toContain("[bell]");
    expect(hostBells()[0]?.[1]).toContain(`seq=${event.seq}..${event.seq}`);
    if (cause === "inactive" || cause === "lost")
      expect(
        f.store
          .listNotifications({ project_id: f.project })
          .filter(
            (n) => n.event_id === event.id && n.recipient.kind !== "assignment",
          )
          .map((n) => n.recipient.kind)
          .sort(),
      ).toEqual(mode === "ops" ? ["needs_you", "pm_office"] : ["needs_you"]);

    const reopened = Store.open({ dataDir: f.dataDir });
    try {
      await new Dispatcher({ ...options(), store: reopened }).tick();
      expect(hostNotes()).toHaveLength(1);
      expect(hostBells()).toHaveLength(1);
      reopened.ackEvents({
        project_id: f.project,
        assignment_id: hostOps.id,
        card_id: (event.card_id ?? PROJECT_EVENT_STREAM) as CardId,
        up_to_seq: event.seq,
      });
      await new Dispatcher({ ...options(), store: reopened }).tick();
      expect(hostNotes()[0]?.status).toBe("acked");
      expect(hostBells()).toHaveLength(1);
    } finally {
      reopened.close();
    }
  },
);

test.each(["inactive", "lost"] as const)(
  "C-220 host_ops %s alerts human and Office without a self bell",
  async (cause) => {
    const event = await trigger(hostOps, cause);
    expect(
      f.store
        .listNotifications({ project_id: f.project })
        .filter(
          (n) => n.event_id === event.id && n.recipient.kind !== "assignment",
        )
        .map((n) => n.recipient.kind)
        .sort(),
    ).toEqual(["needs_you", "pm_office"]);
    // The subject's diagnostic marker is not a pending recovery notification.
    expect(hostNotes().every((n) => n.status === "needs_attention")).toBe(true);
    expect(hostBells()).toHaveLength(0);
  },
);

test.each(["inactive", "lost", "timeout"] as const)(
  "C-220 ordinary Assignment %s retains its existing recipients",
  async (cause) => {
    const event = await trigger(f.target.assignment, cause);
    expect(hostNotes()).toEqual([]);
    expect(hostBells()).toHaveLength(0);
    if (cause !== "timeout")
      expect(
        f.store
          .listNotifications({ project_id: f.project })
          .filter(
            (n) => n.event_id === event.id && n.recipient.kind !== "assignment",
          )
          .map((n) => n.recipient.kind)
          .sort(),
      ).toEqual(cause === "inactive" ? ["pm_ops"] : ["needs_you", "pm_office"]);
    else expect(f.state().human_actions).toHaveLength(1);
  },
);

test.each(["suspended", "released"] as const)(
  "C-220 a %s host_ops is not a recovery recipient",
  async (status) => {
    f.store.uow.run((tx) =>
      tx.assignments.put(f.project, { ...hostOps, status }),
    );
    await trigger(pm("ops"), "inactive");
    expect(hostNotes()).toEqual([]);
    expect(hostBells()).toHaveLength(0);
  },
);

test("C-220 busy host_ops keeps recovery work pending for the existing Run", async () => {
  const owner = pm("ops");
  f.session(owner, false);
  const run = f.session(hostOps, false);
  f.skipEvents();
  f.advance(100);
  f.store.touchAssignmentActivity(f.project, hostOps.id, f.clock.now());
  await new Dispatcher(options()).tick();
  expect(hostNotes()).toMatchObject([{ status: "pending" }]);
  expect(hostBells()).toHaveLength(0);
  expect(
    f
      .state()
      .runs.filter((r) => r.assignment_id === hostOps.id)
      .at(-1)?.id,
  ).toBe(run.id);
});

test("C-220 audience recognizes standing roles without a logical-recipient resolver", () => {
  expect(alertAudience(pm("ops"), f.state())).toBe("human");
  expect(alertAudience(pm("office"), f.state())).toBe("human_only");
  expect(alertAudience(hostOps, f.state())).toBe("human");
  expect(alertAudience(f.target.assignment, f.state())).toBe("ops");
});
