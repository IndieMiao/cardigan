import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Actor,
  Assignment,
  Card,
  CommandEffect,
  CommandPorts,
  CommandState,
  ProjectId,
  Role,
  TransactionContext,
  WorkItem,
} from "@cardigan/domain";
import { assign, createCard, dispatchRun, queueRun } from "@cardigan/domain";
import { Store, writeRole } from "@cardigan/store";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Identity } from "./auth.js";
import { loadCommandState, persistEffect } from "./commands/execute.js";
import {
  ACTIVITY_WAKE_DELAY_MS,
  DEFAULT_ACTIVITY_WRITE_INTERVAL_MS,
  ToolCallBookkeeping,
  type ToolCallTimers,
} from "./tool-call-bookkeeping.js";

const project_id = "p-bookkeeping" as ProjectId;
const NOW = "2026-01-01T00:00:00.000Z";
const T0 = Date.parse(NOW);
const INTERVAL = DEFAULT_ACTIVITY_WRITE_INTERVAL_MS;
const WAKE = ACTIVITY_WAKE_DELAY_MS;
const SESSION_KEY_DIGEST = "d".repeat(64);
const human: Actor = { kind: "human", project_id };

const role: Role = {
  role_id: "coder" as never,
  version: 1,
  display_name: "Coder",
  kind: "work",
  core_prompt: "Fictional core prompt.",
  harness: "pi",
  launch_profile_ref: "pi-agent",
  allowed_tools: ["whoami", "get_updates"],
  capabilities: [],
  abilities: [],
  worktree: "none",
  required_machine_tags: [],
};

let dataDir: string;
let store: Store;
/** Write transactions committed or attempted through the store. */
let writes: number;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-bookkeeping-"));
  store = Store.open({ dataDir });
  store.createProject({ id: project_id, name: "Bookkeeping" });
  store.uow.run((tx) => writeRole(tx, project_id, role, { mode: "add" }));
  writes = 0;
  store.observe({ transaction: (kind) => kind === "run" && writes++ });
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** A deterministic clock whose timers fire as it advances. */
function fakeTime(start = T0) {
  let now = start;
  let next = 0;
  const queue = new Map<number, { at: number; run: () => void }>();
  const timers: ToolCallTimers = {
    set: (run, ms) => {
      const id = ++next;
      queue.set(id, { at: now + ms, run });
      return id;
    },
    clear: (id) => queue.delete(id as number),
  };
  return {
    now: () => now,
    timers,
    get armed() {
      return queue.size;
    },
    /** Fire every timer due up to `to`, in order, then stop at `to`. */
    advanceTo(to: number) {
      for (;;) {
        let due: [number, { at: number; run: () => void }] | undefined;
        for (const entry of queue)
          if (entry[1].at <= to && (!due || entry[1].at < due[1].at))
            due = entry;
        if (!due) break;
        queue.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].run();
      }
      now = Math.max(now, to);
    },
  };
}

function apply<T>(
  reduce: (
    state: CommandState,
    actor: Actor,
    ports: CommandPorts,
  ) =>
    | { ok: true; value: CommandEffect<T> }
    | { ok: false; error: { message: string } },
): CommandEffect<T> {
  return store.uow.run((tx) => {
    const effect = reduce(loadCommandState(tx, project_id), human, ports(tx));
    if (!effect.ok) throw new Error(effect.error.message);
    persistEffect(tx, project_id, effect.value);
    return effect.value;
  });
}

function ports(tx: TransactionContext): CommandPorts {
  return { clock: { now: () => NOW }, ids: tx.ids };
}

/** A coder Assignment whose Run is dispatched, optionally as a verified session. */
function dispatchedRun(options: { readonly verify?: string } = {}) {
  store.uow.run((tx) => {
    for (const role_id of ["pm", "reviewer"])
      tx.roles.put(project_id, {
        role_id,
        role_version: 1,
        allowed_tools: ["submit_review"],
        capabilities: [],
      });
  });
  const card = apply((state, actor, p) =>
    createCard(
      state,
      actor,
      {
        title: "Fictional card",
        goal: "Bookkeeping",
        acceptance_criteria: ["the run advances"],
        source: { kind: "quote", text: "fictional" },
        repo: "example/repo",
        base_branch: "main",
      },
      p,
    ),
  ).changes.find((change) => change.collection === "cards")?.entity as Card;
  const item = store.uow.read((tx) =>
    tx.work_items.list(project_id).find((w) => w.card_id === card.id),
  ) as WorkItem;
  const assignment = apply((state, actor, p) =>
    assign(state, actor, { work_item_id: item.id, role_id: "coder" }, p),
  ).changes.find((change) => change.collection === "assignments")
    ?.entity as Assignment;
  const run = apply((state, actor, p) =>
    queueRun(
      state,
      actor,
      {
        assignment_id: assignment.id,
        model: "fictional-model",
        agent_cli_version: "pi 1.5.0",
      },
      p,
    ),
  ).changes.find((change) => change.collection === "runs")?.entity as {
    id: string;
  };
  apply((state, actor, p) =>
    dispatchRun(
      state,
      actor,
      {
        run_id: run.id as never,
        runtime_ref: {
          machine_id: "local",
          runtime_machine: "local",
          terminal_ref: "t1",
          agent_name: "coder-abcdef12-c-1-w-1-a-1",
        },
        ...(options.verify
          ? {
              verify_mcp_session: {
                key_sha256: SESSION_KEY_DIGEST,
                token_id: options.verify,
              },
            }
          : {}),
      },
      p,
    ),
  );
  if (options.verify)
    store.uow.run((tx) => {
      const a = tx.assignments.get(project_id, assignment.id);
      if (a)
        tx.assignments.put(project_id, {
          ...a,
          mcp_session_token_id: options.verify,
        });
    });
  return { assignment, run_id: run.id };
}

/** A bare active Assignment (no Run) for activity-only scenarios. */
function activeAssignment(id: string, overrides: Partial<Assignment> = {}) {
  const a = {
    id,
    scope: "work_item",
    work_item_id: "W-0",
    role_id: "coder",
    role_version: 1,
    status: "active",
    runtime_state: "not_running",
    machine_id: "local",
    runtime_ref: null,
    mcp_token_id: `tok-${id}`,
    created_at: NOW,
    ...overrides,
  } as unknown as Assignment;
  store.uow.run((tx) => tx.assignments.put(project_id, a));
  return a;
}

function identity(assignment: Assignment, token = "tok-1"): Identity {
  return {
    actor: {
      kind: "assignment",
      project_id,
      assignment_id: assignment.id,
      role_id: assignment.role_id,
      role_version: assignment.role_version,
    },
    token: { id: token } as never,
    assignment,
    role: {
      role_id: assignment.role_id,
      role_version: assignment.role_version,
    },
  } as Identity;
}

const stored = (id: Assignment["id"]) =>
  store.uow.read((tx) => tx.assignments.get(project_id, id));
const activityAt = (id: Assignment["id"]) =>
  Date.parse(stored(id)?.last_mcp_activity_at ?? "");
const runStatus = (id: string) =>
  store.uow.read((tx) => tx.runs.get(project_id, id as never))?.status;

/** Another process (the background loops) holding the database's write lock. */
function holdWriteLock() {
  const other = new DatabaseSync(join(dataDir, "cardigan.db"));
  other.exec("BEGIN IMMEDIATE");
  return () => {
    other.exec("ROLLBACK");
    other.close();
  };
}

describe("C-635 activity writes", () => {
  test("a burst costs one write per interval; the last call's time lands at stored time + interval", () => {
    const time = fakeTime();
    const { assignment, run_id } = dispatchedRun();
    const bk = new ToolCallBookkeeping({
      store,
      now: time.now,
      timers: time.timers,
    });
    const who = identity(assignment);
    writes = 0;
    // The first call of the Run: the acknowledgement carries the activity.
    expect(bk.toolCalled(who)).toBe(1);
    expect(writes).toBe(1);
    expect(activityAt(assignment.id)).toBe(T0);
    expect(runStatus(run_id)).toBe("running");
    for (const s of [1, 2, 5, 10]) {
      time.advanceTo(T0 + s * 1000);
      expect(bk.toolCalled(who)).toBe(0);
    }
    expect(writes).toBe(1);
    expect(activityAt(assignment.id)).toBe(T0);
    time.advanceTo(T0 + INTERVAL - 1);
    expect(activityAt(assignment.id)).toBe(T0);
    time.advanceTo(T0 + INTERVAL);
    expect(writes).toBe(2);
    expect(activityAt(assignment.id)).toBe(T0 + 10_000);
    // Within the next interval of the stored time: deferred again.
    time.advanceTo(T0 + 35_000);
    expect(bk.toolCalled(who)).toBe(0);
    time.advanceTo(T0 + 10_000 + INTERVAL);
    expect(activityAt(assignment.id)).toBe(T0 + 35_000);
    expect(writes).toBe(3);
    // An idle session's call is written within the wake delay.
    time.advanceTo(T0 + 300_000);
    expect(bk.toolCalled(who)).toBe(0);
    time.advanceTo(T0 + 300_000 + WAKE);
    expect(activityAt(assignment.id)).toBe(T0 + 300_000);
    expect(writes).toBe(4);
    expect(time.armed).toBe(0);
    expect(bk.pending).toBe(0);
  });

  test("any write of the process carries deferred activity; no write of its own follows", () => {
    const time = fakeTime();
    const a = activeAssignment("A-61", { last_mcp_activity_at: NOW });
    const bk = new ToolCallBookkeeping({
      store,
      acknowledgeRuns: false,
      now: time.now,
      timers: time.timers,
    });
    writes = 0;
    time.advanceTo(T0 + 5_000);
    expect(bk.toolCalled(identity(a, a.mcp_token_id))).toBe(0);
    // e.g. the call's own handler (ack_events, heartbeat, a comment …).
    store.uow.run(() => undefined);
    expect(activityAt(a.id)).toBe(T0 + 5_000);
    time.advanceTo(T0 + 10 * INTERVAL);
    expect(writes).toBe(1);
    expect(time.armed).toBe(0);
    // A woken session's first call rides along the same way.
    time.advanceTo(T0 + 20 * INTERVAL);
    bk.toolCalled(identity(a, a.mcp_token_id));
    store.uow.run(() => undefined);
    expect(activityAt(a.id)).toBe(T0 + 20 * INTERVAL);
    time.advanceTo(T0 + 30 * INTERVAL);
    expect(writes).toBe(2);
  });

  test("pending sessions are written together in one transaction", () => {
    const time = fakeTime();
    const a = activeAssignment("A-71", { last_mcp_activity_at: NOW });
    const b = activeAssignment("A-72", {
      last_mcp_activity_at: new Date(T0 + 5_000).toISOString(),
    });
    const bk = new ToolCallBookkeeping({
      store,
      acknowledgeRuns: false,
      now: time.now,
      timers: time.timers,
    });
    writes = 0;
    time.advanceTo(T0 + 20_000);
    bk.toolCalled(identity(a, a.mcp_token_id));
    bk.toolCalled(identity(b, b.mcp_token_id));
    time.advanceTo(T0 + INTERVAL);
    expect(writes).toBe(1);
    expect(activityAt(a.id)).toBe(T0 + 20_000);
    expect(activityAt(b.id)).toBe(T0 + 20_000);
  });

  test("a deferred write still obeys C-600: neither a replaced session nor a released Assignment counts", () => {
    const time = fakeTime();
    const a = activeAssignment("A-81", {
      last_mcp_activity_at: NOW,
      mcp_session_token_id: "tok-old",
    });
    const b = activeAssignment("A-82", { last_mcp_activity_at: NOW });
    const bk = new ToolCallBookkeeping({
      store,
      acknowledgeRuns: false,
      now: time.now,
      timers: time.timers,
    });
    time.advanceTo(T0 + 1_000);
    // A call on another launch's Token is not even deferred.
    expect(bk.toolCalled(identity(a, "tok-other"))).toBe(0);
    expect(bk.pending).toBe(0);
    bk.toolCalled(identity(a, "tok-old"));
    bk.toolCalled(identity(b, b.mcp_token_id));
    expect(bk.pending).toBe(2);
    // Before the slot, the host replaces A-81's session and releases A-82.
    const replaced = stored(a.id) as Assignment;
    const released = stored(b.id) as Assignment;
    store.uow.run((tx) => {
      tx.assignments.put(project_id, {
        ...replaced,
        mcp_session_token_id: "tok-new",
      });
      tx.assignments.put(project_id, { ...released, status: "released" });
    });
    time.advanceTo(T0 + INTERVAL);
    expect(activityAt(a.id)).toBe(T0);
    expect(activityAt(b.id)).toBe(T0);
    expect(bk.pending).toBe(0);
  });

  test("replay: 'silent for at least T' decisions with T ≥ the interval are unchanged, except within the wake delay of a woken session", () => {
    const time = fakeTime();
    const a = activeAssignment("A-91");
    const bk = new ToolCallBookkeeping({
      store,
      acknowledgeRuns: false,
      now: time.now,
      timers: time.timers,
    });
    const who = identity(a, a.mcp_token_id);
    // A seeded trace: bursts of calls 1–20 s apart, pauses up to 40 min;
    // 40% of the calls write in their handler.
    let seed = 7;
    const random = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    const calls: [number, boolean][] = [];
    for (let t = T0 + 1_000; t < T0 + 4 * 3_600_000; ) {
      calls.push([t, random() < 0.4]);
      t +=
        random() < 0.8
          ? 1_000 + Math.floor(random() * 19_000)
          : 60_000 + Math.floor(random() * 2_340_000);
    }
    const thresholds = [INTERVAL, 60_000, 15 * 60_000, 60 * 60_000];
    const made: number[] = [];
    let next = 0;
    let decisions = 0;
    let skipped = 0;
    for (let x = T0; x <= T0 + 4 * 3_600_000 + 120_000; x += 500) {
      while (next < calls.length && (calls[next]?.[0] as number) <= x) {
        const [at, handlerWrites] = calls[next++] as [number, boolean];
        time.advanceTo(at);
        bk.toolCalled(who);
        if (handlerWrites) store.uow.run(() => undefined);
        made.push(at);
      }
      time.advanceTo(x);
      const recorded = activityAt(a.id);
      const real = made.at(-1);
      if (real === undefined) {
        expect(recorded).toBeNaN();
        continue;
      }
      // Never ahead of reality.
      expect(recorded).toBeLessThanOrEqual(real);
      const unrecorded = made.find((at) => at > recorded);
      if (unrecorded !== undefined && x - unrecorded < WAKE) {
        skipped++;
        continue;
      }
      // Otherwise never an interval or more behind.
      expect(real - recorded).toBeLessThan(INTERVAL);
      for (const threshold of thresholds) {
        expect(x - recorded >= threshold).toBe(x - real >= threshold);
        decisions++;
      }
    }
    expect(decisions).toBeGreaterThan(100_000);
    expect(skipped).toBeLessThan(decisions / 100);
    // Once quiet, the recorded time is exactly the last call.
    expect(activityAt(a.id)).toBe(made.at(-1));
  });

  test("a synthetic multi-session day stays under 0.3 bookkeeping write transactions per call", () => {
    const time = fakeTime();
    const sessions = Array.from({ length: 6 }, (_, i) =>
      activeAssignment(`A-6${i}`),
    );
    const bk = new ToolCallBookkeeping({
      store,
      acknowledgeRuns: false,
      now: time.now,
      timers: time.timers,
    });
    let seed = 11;
    const random = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    // Each Run: 8–40 calls, mostly 2–15 s apart (tool chains), a quarter
    // after a 30 s–4 min pause (editing, tests); 5–30 min between Runs.
    // 40% of the calls write in their handler (cursor, heartbeat, comment,
    // delivery, finish), as in a Run's protocol.
    const calls: [number, Assignment, boolean][] = [];
    for (const a of sessions) {
      let t = T0 + Math.floor(random() * 600_000);
      while (t < T0 + 4 * 3_600_000) {
        const n = 8 + Math.floor(random() * 33);
        for (let i = 0; i < n; i++) {
          calls.push([t, a, random() < 0.4]);
          t +=
            random() < 0.75
              ? 2_000 + Math.floor(random() * 13_000)
              : 30_000 + Math.floor(random() * 210_000);
        }
        t += 300_000 + Math.floor(random() * 1_500_000);
      }
    }
    calls.sort((x, y) => x[0] - y[0]);
    writes = 0;
    let handlerWrites = 0;
    for (const [at, a, handlerWrites_] of calls) {
      time.advanceTo(at);
      bk.toolCalled(identity(a, a.mcp_token_id));
      if (handlerWrites_) {
        store.uow.run(() => undefined);
        handlerWrites++;
      }
    }
    time.advanceTo(T0 + 5 * 3_600_000);
    expect(bk.pending).toBe(0);
    expect(calls.length).toBeGreaterThan(500);
    expect((writes - handlerWrites) / calls.length).toBeLessThan(0.3);
  }, 60_000);
});

describe("C-635 a busy database never holds up the tool call", () => {
  test("handshake, activity and acknowledgement are decided at once and written in order once the lock is free", () => {
    const time = fakeTime();
    const { assignment, run_id } = dispatchedRun({ verify: "tok-launch" });
    const bk = new ToolCallBookkeeping({
      store,
      now: time.now,
      timers: time.timers,
    });
    const who = identity(assignment, "tok-launch");
    expect(stored(assignment.id)?.mcp_handshake).toBe("pending");
    const release = holdWriteLock();
    let released = false;
    try {
      const started = performance.now();
      // The store waits up to 5 s for a lock; none of this may.
      expect(bk.handshake(who, SESSION_KEY_DIGEST)).toBe("listed");
      bk.toolCalled(who);
      expect(performance.now() - started).toBeLessThan(200);
      expect(stored(assignment.id)?.mcp_handshake).toBe("pending");
      expect(stored(assignment.id)?.last_mcp_activity_at).toBeUndefined();
      expect(runStatus(run_id)).toBe("dispatched");
      expect(bk.pending).toBe(3);
      // Retries back off while the other process keeps the lock.
      time.advanceTo(T0 + 2_000);
      expect(bk.pending).toBe(3);
      release();
      released = true;
      time.advanceTo(T0 + 4_000);
    } finally {
      if (!released) release();
    }
    expect(bk.pending).toBe(0);
    expect(stored(assignment.id)?.mcp_handshake).toBe("listed");
    // The deferred activity keeps the call's own time.
    expect(activityAt(assignment.id)).toBe(T0);
    // The acknowledgement waited for the handshake it depends on.
    expect(runStatus(run_id)).toBe("running");
    expect(time.armed).toBe(0);
  });

  test("a refused wrapper call is refused at once even while busy; the refusal is persisted later", () => {
    const time = fakeTime();
    const { assignment, run_id } = dispatchedRun({ verify: "tok-launch" });
    const bk = new ToolCallBookkeeping({
      store,
      now: time.now,
      timers: time.timers,
    });
    const release = holdWriteLock();
    try {
      expect(bk.handshake(identity(assignment, "tok-launch"), undefined)).toBe(
        "missing",
      );
    } finally {
      release();
    }
    time.advanceTo(T0 + 1_000);
    expect(stored(assignment.id)?.mcp_handshake).toBe("missing");
    expect(runStatus(run_id)).toBe("dispatched");
  });

  test("close makes one last attempt at deferred writes", () => {
    const time = fakeTime();
    const a = activeAssignment("A-51", { last_mcp_activity_at: NOW });
    const bk = new ToolCallBookkeeping({
      store,
      acknowledgeRuns: false,
      now: time.now,
      timers: time.timers,
    });
    time.advanceTo(T0 + 3_000);
    bk.toolCalled(identity(a, a.mcp_token_id));
    bk.close();
    expect(activityAt(a.id)).toBe(T0 + 3_000);
    expect(time.armed).toBe(0);
  });
});
