import {
  isEscalatedNotification,
  isTerminalNotification,
  type NotificationEvent,
  type NotificationStatus,
  nextNotificationStatus,
  queueRun,
  type RunKind,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { afterEach, beforeEach, expect, test } from "vitest";
import { m3Fixture } from "../test-support/m3-acceptance.js";

let f: ReturnType<typeof m3Fixture>;
beforeEach(() => {
  f = m3Fixture();
});
afterEach(() => f.close());
// Independently transcribed from development plan §4.4, never read from transitionTables.
const allowed: Record<
  NotificationStatus,
  Partial<Record<NotificationEvent, NotificationStatus>>
> = {
  pending: {
    bell: "belled",
    ack: "acked",
    deliver_failed: "delivery_failed",
    needs_attention: "needs_attention",
    resolve: "resolved",
  },
  belled: {
    ack: "acked",
    retry: "pending",
    deliver_failed: "delivery_failed",
    needs_attention: "needs_attention",
    resolve: "resolved",
  },
  delivery_failed: {
    ack: "acked",
    retry: "pending",
    bell: "belled",
    deliver_failed: "delivery_failed",
    needs_attention: "needs_attention",
    resolve: "resolved",
  },
  acked: {},
  needs_attention: { resolve: "resolved" },
  resolved: {},
};
const events: NotificationEvent[] = [
  "bell",
  "ack",
  "retry",
  "deliver_failed",
  "needs_attention",
  "resolve",
];
let number = 0;
const cases = (Object.keys(allowed) as NotificationStatus[]).flatMap((from) =>
  events.map((event) => ({
    id: `N${String(++number).padStart(2, "0")}`,
    from,
    event,
    to: allowed[from][event],
  })),
);
test.each(cases)(
  "[$id] §4.4 notification $from + $event",
  ({ from, event, to }) => {
    const result = nextNotificationStatus(from, event);
    if (to) expect(result).toEqual({ ok: true, value: to });
    else expect(result.ok).toBe(false);
  },
);
test.each(
  (Object.keys(allowed) as NotificationStatus[]).map((status, i) => ({
    id: `N${26 + i}`,
    status,
  })),
)("[$id] §4.4 terminal/escalated classification of $status", ({ status }) => {
  expect(isTerminalNotification(status)).toBe(
    ["acked", "needs_attention", "resolved"].includes(status),
  );
  expect(isEscalatedNotification(status)).toBe(
    ["delivery_failed", "needs_attention"].includes(status),
  );
});
const kinds: RunKind[] = [
  "initial",
  "rework",
  "decision_resumed",
  "followup",
  "fix",
];
test.each(kinds.map((kind, i) => ({ id: `N${31 + i}`, kind })))(
  "[$id] M3.2 invariant 12: $kind Run preserves trigger and reproducible snapshot",
  ({ kind }) => {
    const trigger = f.comment();
    const run = f.apply((s, a, p) =>
      queueRun(
        s,
        a,
        {
          assignment_id: f.coder.id,
          kind,
          trigger_event_id: trigger.id,
          model: "model-A",
          agent_cli_version: "cli-A",
        },
        p,
      ),
    ).data;
    expect(f.state().runs).toEqual([run]);
    expect(run).toMatchObject({
      kind,
      trigger_event_id: trigger.id,
      role_version: f.coder.role_version,
      model: "model-A",
      agent_cli_version: "cli-A",
      status: "queued",
    });
  },
);
test("[N36] M3.2 repeated bells cannot create a duplicate Run even after the first Run completes", () => {
  const trigger = f.comment(),
    params = {
      assignment_id: f.coder.id,
      kind: "followup" as const,
      trigger_event_id: trigger.id,
      model: "m",
      agent_cli_version: "c",
    };
  f.apply((s, a, p) => queueRun(s, a, params, p));
  f.start(f.coder);
  f.finish(f.coder);
  const result = f.store.uow.run((tx) =>
    queueRun(loadCommandState(tx, f.id), f.human, params, {
      clock: f.clock,
      ids: tx.ids,
    }),
  );
  expect(result.ok).toBe(false);
  expect(f.state().runs).toHaveLength(1);
  const other = f.apply((s, a, p) =>
    queueRun(s, a, { ...params, assignment_id: f.reviewer.id }, p),
  ).data;
  expect(other.assignment_id).toBe(f.reviewer.id);
  expect(f.state().runs).toHaveLength(2);
});
test("[N37] M3.2 invariant 5: a later Run reuses the existing Session without provision metadata", () => {
  f.start(f.coder);
  f.finish(f.coder);
  const before = f
    .state()
    .assignments.find((a) => a.id === f.coder.id)?.runtime_ref;
  const trigger = f.comment();
  f.apply((s, a, p) =>
    queueRun(
      s,
      a,
      {
        assignment_id: f.coder.id,
        kind: "rework",
        trigger_event_id: trigger.id,
        model: "m",
        agent_cli_version: "c",
      },
      p,
    ),
  );
  const run = f.start(f.coder);
  expect(run.status).toBe("running");
  expect(
    f.state().assignments.find((a) => a.id === f.coder.id)?.runtime_ref,
  ).toEqual(before);
  expect(f.state().runs).toHaveLength(2);
});
