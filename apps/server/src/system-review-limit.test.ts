import {
  type Assignment,
  beginSystemReviewLimitRaise,
  finishSystemReviewLimitRaise,
  type Runtime,
  type SystemReviewLimitCandidate,
  type SystemReviewLimitProof,
  setProjectPreferences,
  updateWorkItem,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { getRoleVersion, Store, writeRole } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { m3Fixture } from "../test-support/m3-acceptance.js";
import { Dispatcher } from "./dispatch.js";
import { routeProjectEvents } from "./dispatch-inbox.js";
import { runSystemReviewLimits } from "./system-rules.js";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}

let f: ReturnType<typeof m3Fixture>;
let ops: Assignment;
beforeEach(async () => {
  f = m3Fixture();
  ops = f.store.uow.run((tx) => {
    const role = required(getRoleVersion(tx, f.id, "pm"));
    const updated = writeRole(
      tx,
      f.id,
      {
        ...role,
        kind: "standing",
        allowed_tools: [...role.allowed_tools, "update_work_item"],
      },
      { mode: "update" },
    ).role;
    const { work_item_id: _work, ...a } = f.pm;
    const result: Assignment = {
      ...a,
      id: tx.ids.next(f.id, "assignment"),
      role_version: updated.version,
      scope: "standing",
      standing_mode: "ops",
    };
    tx.assignments.put(f.id, result);
    tx.work_items.put(f.id, {
      ...required(tx.work_items.get(f.id, f.verify.id)),
      kind: "verify",
      max_review_rounds: 1,
    });
    return result;
  });
  f.apply((s, a, p) =>
    setProjectPreferences(
      s,
      a,
      {
        system_review_limit_raise: true,
        system_review_limit_max_raises: 1,
        role_rule_paths: ["AGENTS.md"],
      },
      p,
    ),
  );
  f.start(f.coder);
  const first = (await f.delivery()).data;
  f.start(f.reviewer);
  f.review(first.id);
  f.finish(f.coder);
  f.start(f.coder);
  const next = (await f.delivery()).data;
  f.store.uow.run((tx) =>
    tx.deliveries.put(f.id, {
      ...next,
      subject: { kind: "git_head", value: "b".repeat(40) },
    }),
  );
});
afterEach(() => f.close());
const system = () => ({ kind: "system" as const, project_id: f.id });
const decision = () =>
  required(f.state().decisions.find((q) => q.trigger === "review_limit"));
const proof = (
  candidate: SystemReviewLimitCandidate,
): SystemReviewLimitProof => ({
  candidate,
  base_sha: "c".repeat(40),
  merged_tree: "d".repeat(40),
  delivery_tree: "d".repeat(40),
  changed_paths: ["app.ts"],
});
const cycle = (
  prove = async (_project: string, candidate: SystemReviewLimitCandidate) =>
    proof(candidate),
  store = f.store,
) => runSystemReviewLimits(store, f.id, f.clock, prove);

test("concurrent scans and a reopened SQLite connection add only once; routing resumes the reviewer", async () => {
  const prove = vi.fn(async (_project: string, c: SystemReviewLimitCandidate) =>
    proof(c),
  );
  const reopened = Store.open({ dataDir: required(f.dataDir) });
  try {
    await Promise.all([cycle(prove), cycle(prove, reopened)]);
    await cycle(prove, reopened);
  } finally {
    reopened.close();
  }
  expect(prove).toHaveBeenCalledTimes(1);
  expect(decision()).toMatchObject({
    status: "resolved",
    resolution: { resolved_by: "system" },
  });
  expect(f.state().work_items.find((w) => w.id === f.verify.id)).toMatchObject({
    status: "ready",
    max_review_rounds: 2,
  });
  routeProjectEvents(f.store, f.id, { clock: f.clock });
  const notes = f.store.listNotifications({ project_id: f.id });
  const requested = required(
    f.state().events.find((e) => e.type === "decision_requested"),
  );
  expect(
    notes.some(
      (n) => n.event_id === requested.id && n.recipient.kind === "pm_ops",
    ),
  ).toBe(false);
  expect(
    notes.some(
      (n) =>
        n.recipient.kind === "assignment" &&
        n.recipient.assignment_id === f.reviewer.id &&
        n.kind === "decision",
    ),
  ).toBe(true);
});
test("PM pause committed while Git is pending wins, including after restart", async () => {
  const decisionId = decision().id;
  await cycle(async (_p, c) => {
    f.apply(
      (s, a, p) =>
        updateWorkItem(
          s,
          a,
          {
            work_item_id: f.verify.id,
            review_limit_decision: {
              decision_id: decisionId,
              option: "pause",
              rationale: "先暂停",
            },
          },
          p,
        ),
      f.actor(ops),
    );
    return proof(c);
  });
  const restarted = Store.open({ dataDir: required(f.dataDir) });
  const prove = vi.fn(async (_p: string, c: SystemReviewLimitCandidate) =>
    proof(c),
  );
  try {
    await cycle(prove, restarted);
  } finally {
    restarted.close();
  }
  expect(prove).not.toHaveBeenCalled();
  expect(decision().status).toBe("provisional");
  expect(f.state().work_items.find((w) => w.id === f.verify.id)).toMatchObject({
    status: "waiting_decision",
    max_review_rounds: 1,
  });
});
test("a crash after claim does not retry Git; round, resolution, audit and resumption roll back together", async () => {
  const decisionId = decision().id;
  const claim = required(
    f.apply(
      (s, a, p) =>
        beginSystemReviewLimitRaise(s, a, { decision_id: decisionId }, p),
      system(),
    ).data,
  );
  const before = f.state();
  expect(() =>
    f.store.uow.run((tx) => {
      const effect = unwrap(
        finishSystemReviewLimitRaise(
          loadCommandState(tx, f.id),
          system(),
          { attempt_id: claim.attempt_id, proof: proof(claim.candidate) },
          { clock: f.clock, ids: tx.ids },
        ),
      );
      persistEffect(tx, f.id, effect);
      throw new Error("audit persistence failed");
    }),
  ).toThrow("audit persistence failed");
  expect(f.state()).toEqual(before);
  const restarted = Store.open({ dataDir: required(f.dataDir) });
  const prove = vi.fn(async (_p: string, c: SystemReviewLimitCandidate) =>
    proof(c),
  );
  try {
    await cycle(prove, restarted);
  } finally {
    restarted.close();
  }
  expect(prove).not.toHaveBeenCalled();
  expect(decision().status).toBe("open");
});
test("Dispatcher invokes proof before routing, and leaves the normal PM path when disabled", async () => {
  const prove = vi.fn(async (_p: string, c: SystemReviewLimitCandidate) =>
    proof(c),
  );
  const runtime: Runtime = {
    status: vi.fn(async () => ({
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    })),
    wake: vi.fn(async () => ({ ok: true, value: { sent: true } })),
    provision: vi.fn(),
    release: vi.fn(),
    interrupt: vi.fn(),
    resume_or_replace: vi.fn(),
    human_entry: vi.fn(),
  };
  f.apply((s, a, p) =>
    setProjectPreferences(s, a, { system_review_limit_raise: false }, p),
  );
  const dispatcher = new Dispatcher({
    store: f.store,
    clock: f.clock,
    runtime,
    proveReviewLimit: prove,
    snapshot: async () => ({ model: "fixture", agent_cli_version: "1" }),
    startRun: async () => {},
  });
  await dispatcher.tick();
  expect(prove).not.toHaveBeenCalled();
  expect(decision().status).toBe("open");
  f.apply((s, a, p) =>
    setProjectPreferences(s, a, { system_review_limit_raise: true }, p),
  );
  await dispatcher.tick();
  expect(prove).toHaveBeenCalledTimes(1);
  expect(decision().status).toBe("resolved");
});
