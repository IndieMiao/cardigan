/**
 * M3.T1 cross-acceptance for the Dispatcher (M3.4).
 *
 * Oracles: docs/plans/phase-1-m3.md §3.1 and §3.3, development plan §6.6 and
 * §13.9. Only public interfaces: domain commands from a real `createCard` +
 * `assign`, the Store, the Dispatcher, the Router (`routeProjectEvents`) and the
 * RuntimeMonitor. The Runtime is a fake and the clock is manual — no real hc.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Actor,
  Assignment,
  CommandEffect,
  CommandPorts,
  CommandState,
  Run,
  Runtime,
  RuntimeRef,
  RuntimeResult,
} from "@cardigan/domain";
import {
  acknowledgeRun,
  assign,
  createCard,
  dispatchRun,
  finishRun,
  postComment,
  queueRun,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { beginBellAttempt, Store, writeRole } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";
import { routeProjectEvents } from "./dispatch-inbox.js";
import { RuntimeMonitor } from "./dispatch-monitor.js";

const project = "p-m3t1" as never;
const MODEL = "fixture-model";
const CLI = "pi 1.5.0";

interface Harness {
  readonly store: Store;
  /** Acknowledge the newest Run, as its Assignment (first tool call). */
  acknowledge(assignment?: Assignment): Run;
  /** End the newest Run through the domain command, as its Assignment. */
  endRun(assignment?: Assignment, outcome?: "completed" | "failed"): Run;
  readonly dataDir: string;
  readonly clock: { now(): string };
  advance(ms: number): void;
  apply<T>(
    reduce: (
      state: CommandState,
      actor: Actor,
      ports: CommandPorts,
    ) =>
      | { ok: true; value: CommandEffect<T> }
      | { ok: false; error: { message: string } },
    actor?: Actor,
  ): T;
  actor(assignment: Assignment): Actor;
  card: { id: string };
  coder: Assignment;
  reviewer: Assignment;
  route(): number;
  runs(assignment?: Assignment): readonly Run[];
  notes(): readonly {
    readonly id: string;
    readonly status: string;
    readonly kind: string;
    readonly attempts: number;
    readonly next_attempt_at?: string;
    readonly recipient: {
      readonly kind: string;
      readonly assignment_id?: string;
    };
    readonly run_id?: string;
    readonly seq: number;
  }[];
  assignment(id?: Assignment["id"]): Assignment | undefined;
  close(): void;
}

/** A runtime whose answers every test configures explicitly. */
function fakeRuntime(): Runtime & {
  status: ReturnType<typeof vi.fn>;
  wake: ReturnType<typeof vi.fn>;
} {
  return {
    provision: vi.fn(async () => ({
      ok: false as const,
      error: { code: "runtime_unavailable" as const, message: "host callback" },
    })),
    status: vi.fn(async () => ({
      ok: true as const,
      value: {
        process: "alive" as const,
        agent: "idle" as const,
        observed_seq: 1,
      },
    })),
    wake: vi.fn(async () => ({ ok: true as const, value: { sent: true } })),
    interrupt: vi.fn(async () => ({ ok: true as const, value: undefined })),
    release: vi.fn(async () => ({ ok: true as const, value: undefined })),
    resume_or_replace: vi.fn(async () => ({
      ok: false as const,
      error: { code: "runtime_unavailable" as const, message: "unused" },
    })),
    human_entry: vi.fn(async () => ({ ok: true as const, value: "attach" })),
  };
}

function harness(): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), "cardigan-m3t1-"));
  let time = Date.parse("2030-01-01T00:00:00.000Z");
  const clock = { now: () => new Date(time).toISOString() };
  const store = Store.open({ dataDir, clock });
  store.createProject({ id: project, name: "M3.T1" });
  for (const [role, tools, worktree] of [
    [
      "coder",
      [
        "whoami",
        "get_card",
        "get_updates",
        "ack_events",
        "finish_run",
        "submit_delivery",
      ],
      "none",
    ],
    [
      "reviewer",
      [
        "whoami",
        "get_card",
        "get_updates",
        "ack_events",
        "finish_run",
        "submit_review",
      ],
      "none",
    ],
    [
      "pm",
      [
        "whoami",
        "get_card",
        "get_updates",
        "ack_events",
        "finish_run",
        "create_card",
        "assign",
        "record_decision",
      ],
      "none",
    ],
  ] as const)
    store.uow.run((tx) =>
      writeRole(
        tx,
        project,
        {
          role_id: role,
          version: 1,
          display_name: role,
          kind: "work",
          core_prompt: `You are the ${role}.`,
          harness: "pi",
          launch_profile_ref: "fixture",
          allowed_tools: [...tools] as never,
          capabilities: [],
          abilities: [],
          worktree,
          required_machine_tags: [],
        },
        { mode: "add" },
      ),
    );

  const human = (): Actor => ({ kind: "human", project_id: project });
  const apply: Harness["apply"] = (reduce, actor = human()) =>
    store.uow.run((tx) => {
      const effect = unwrap(
        reduce(loadCommandState(tx, project), actor, {
          clock,
          ids: tx.ids,
        }),
      );
      persistEffect(tx, project, effect);
      return effect.data;
    });
  /** The Assignment's token gives it its Role's tools; tests may narrow them. */
  const actor = (
    assignment: Assignment,
    tools: readonly string[] = ["finish_run", "acknowledge_run"],
  ): Actor =>
    ({
      kind: "assignment",
      project_id: project,
      assignment_id: assignment.id,
      role_id: assignment.role_id,
      role_version: assignment.role_version,
      allowed_tools: [...tools],
    }) as never;

  const card = apply((state, who, ports) =>
    createCard(
      state,
      who,
      {
        title: "Dispatch",
        goal: "Route work",
        acceptance_criteria: ["delivered"],
        source: { kind: "quote", text: "fixture" },
        repo: "example/repo",
        base_branch: "main",
      },
      ports,
    ),
  ) as never as { id: string };
  const items = store.uow.read((tx) => tx.work_items.list(project));
  const produce = items.find((item) => item.role_id === "coder");
  const verify = items.find((item) => item.role_id === "reviewer");
  if (!produce || !verify) throw new Error("template items missing");
  const coder = apply((state, who, ports) =>
    assign(state, who, { work_item_id: produce.id, role_id: "coder" }, ports),
  ) as never as Assignment;
  const reviewer = apply((state, who, ports) =>
    assign(state, who, { work_item_id: verify.id, role_id: "reviewer" }, ports),
  ) as never as Assignment;

  const runs = (assignment?: Assignment) =>
    store.uow
      .read((tx) => tx.runs.list(project))
      .filter(
        (run) =>
          assignment === undefined || run.assignment_id === assignment.id,
      );

  const newestRun = (assignment: Assignment) => {
    const run = store.uow
      .read((tx) => tx.runs.list(project))
      .filter((candidate) => candidate.assignment_id === assignment.id)
      .at(-1);
    if (run === undefined) throw new Error("missing run");
    return run;
  };
  const acknowledge = (assignment: Assignment = coder): Run => {
    const run_id = newestRun(assignment).id;
    return apply(
      (state, who, ports) => acknowledgeRun(state, who, { run_id }, ports),
      actor(assignment),
    ) as never as Run;
  };

  /**
   * End the newest Run of `assignment` with the real `finish_run` command, as
   * that Assignment. The command returns `runtime_state` to idle; the Dispatcher
   * still decides terminal liveness from `Runtime.status`.
   */
  const endRun = (
    assignment: Assignment = coder,
    outcome: "completed" | "failed" = "completed",
  ): Run => {
    const run = store.uow
      .read((tx) => tx.runs.list(project))
      .filter((candidate) => candidate.assignment_id === assignment.id)
      .at(-1);
    if (run === undefined) throw new Error("missing run");
    return apply(
      (state, who, ports) =>
        finishRun(
          state,
          who,
          { run_id: run.id, outcome, summary: "fixture finished" },
          ports,
        ),
      actor(assignment),
    ) as never as Run;
  };

  return {
    store,
    dataDir,
    acknowledge,
    endRun,
    clock,
    advance: (ms) => {
      time += ms;
    },
    apply,
    actor,
    card,
    coder,
    reviewer,
    route: () => routeProjectEvents(store, project),
    runs,
    notes: () => store.listNotifications({ project_id: project }) as never,
    assignment: (id = coder.id) =>
      store.uow.read((tx) => tx.assignments.get(project, id)),
    close: () => {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Give the Assignment a live terminal and a Run in `status`. */
function withRun(
  f: Harness,
  assignment: Assignment,
  status: "queued" | "dispatched" | "running",
  ref: RuntimeRef = refFor(assignment),
): Run {
  const run = f.apply((state, who, ports) =>
    queueRun(
      state,
      who,
      {
        assignment_id: assignment.id,
        model: MODEL,
        agent_cli_version: CLI,
      },
      ports,
    ),
  ) as never as Run;
  if (status === "queued") {
    // A queued Run has no runtime history yet, so nothing records a ref for it.
    f.store.uow.run((tx) =>
      tx.assignments.put(project, { ...assignment, runtime_ref: ref } as never),
    );
    return run;
  }
  f.apply((state, who, ports) =>
    dispatchRun(state, who, { run_id: run.id, runtime_ref: ref }, ports),
  );
  if (status === "running")
    f.apply(
      (state, who, ports) =>
        acknowledgeRun(state, who, { run_id: run.id }, ports),
      f.actor(assignment),
    );
  return run;
}

const refFor = (assignment: Assignment): RuntimeRef => ({
  machine_id: "local",
  runtime_machine: "local",
  terminal_ref: `t-${assignment.id}`,
  agent_name: `agt-${assignment.id.toLowerCase()}`,
});

/** A comment on a work item: the simplest event that wakes its Assignment. */
function comment(f: Harness, body = "look here"): void {
  // Read the work item before opening the command transaction.
  const item = f.store.uow
    .read((tx) => tx.work_items.list(project))
    .find((candidate) => candidate.role_id === "coder");
  if (item === undefined) throw new Error("missing coder work item");
  f.apply((state, who, ports) =>
    postComment(
      state,
      who,
      { card_id: f.card.id as never, work_item_id: item.id, body },
      ports,
    ),
  );
}

function dispatcher(
  f: Harness,
  runtime: Runtime,
  options: Partial<DispatcherOptions> = {},
): Dispatcher {
  return new Dispatcher({
    store: f.store,
    runtime,
    clock: f.clock,
    deliveryLeaseMs: 60_000,
    retryBaseMs: 60_000,
    maxRetries: 4,
    inactivityGraceMs: 15 * 60_000,
    snapshot: async () => ({ model: MODEL, agent_cli_version: CLI }),
    startRun: async () => {},
    ...options,
  });
}

let f: Harness;
beforeEach(() => {
  f = harness();
});
afterEach(() => f.close());

const pending = () => f.notes().filter((note) => note.status === "pending");
const alertsFor = (kind: string) =>
  f.notes().filter((note) => note.recipient.kind === kind);

// ---------------------------------------------------------------- §3.1 rows

test("§3.1 an unfinished Run keeps the event in the inbox without a bell", async () => {
  const runtime = fakeRuntime();
  withRun(f, f.coder, "running");
  comment(f);
  f.route();

  await dispatcher(f, runtime).tick();

  expect(runtime.wake).not.toHaveBeenCalled();
  expect(f.runs(f.coder)).toHaveLength(1);
  expect(pending().length).toBeGreaterThan(0);
});

test("§3.1 an idle terminal gets a new Run and then the bell", async () => {
  const runtime = fakeRuntime();
  // A Run that already started, then finished, leaves a live idle terminal.
  withRun(f, f.coder, "running");
  f.endRun();
  comment(f);
  f.route();

  await dispatcher(f, runtime).tick();

  const runs = f.runs(f.coder);
  expect(runs).toHaveLength(2);
  const created = runs.find((run) => run.status !== "completed");
  expect(created?.status).toBe("dispatched");
  expect(runtime.wake).toHaveBeenCalledTimes(1);
  expect((runtime.wake.mock.calls[0] as unknown[])[1]).toContain("[bell]");
  expect(
    f
      .notes()
      .some(
        (note) =>
          note.recipient.assignment_id === f.coder.id &&
          ["belled", "acked"].includes(note.status),
      ),
  ).toBe(true);
});

test("§3.1 a terminal that exited is replaced through the host start callback", async () => {
  const runtime = fakeRuntime();
  runtime.status.mockResolvedValue({
    ok: false,
    error: { code: "runtime_not_found", message: "terminal gone" },
  });
  const started: Array<{ runId: string; bell: string }> = [];
  comment(f);
  f.route();

  const d = dispatcher(f, runtime, {
    startRun: async ({ run, assignment, bell }) => {
      started.push({ runId: run.id, bell });
      // The host starts a session and dispatches THAT Run — never a new one.
      f.apply((state, who, ports) =>
        dispatchRun(
          state,
          who,
          { run_id: run.id, runtime_ref: refFor(assignment) },
          ports,
        ),
      );
    },
  });
  await d.tick();

  expect(started).toHaveLength(1);
  expect(started[0]?.bell).toContain("[bell]");
  expect(f.runs(f.coder)).toHaveLength(1);
  expect(f.runs(f.coder)[0]?.status).toBe("dispatched");
  expect(runtime.wake).not.toHaveBeenCalled();
});

test("§3.1 a released Assignment is not belled and goes to PM Ops", async () => {
  const runtime = fakeRuntime();
  withRun(f, f.coder, "running");
  // The event is routed while the Assignment is still active, then it is
  // released before the dispatcher gets to deliver it.
  comment(f);
  f.route();
  // No domain command reaches `assignment:released` in M3 (the plan only fixes
  // the transition); the Dispatcher must still refuse to bell it.
  const released = { ...(f.assignment() as Assignment), status: "released" };
  f.store.uow.run((tx) => tx.assignments.put(project, released as never));

  await dispatcher(f, runtime).tick();

  expect(runtime.wake).not.toHaveBeenCalled();
  expect(alertsFor("pm_ops").length).toBeGreaterThan(0);
  expect(f.notes().some((note) => note.status === "delivery_failed")).toBe(
    true,
  );
});

// ---------------------------------------------------------------- §3.3 rules

test("§3.3 a bell without an ACK is resent with 1/2/4/8 minute backoff, then escalated", async () => {
  const runtime = fakeRuntime();
  withRun(f, f.coder, "running");
  f.endRun();
  comment(f);
  f.route();
  const d = dispatcher(f, runtime, {
    startRun: async () => {
      throw new Error("not used: the terminal is alive");
    },
  });

  // First bell. The Agent then finishes its Run without ACKing, which is the
  // state §3.3 describes: no unfinished Run, still no ACK.
  await d.tick();
  // The Agent acked its Run and finished it, but never advanced the event
  // cursor — the bell is still unconfirmed.
  f.acknowledge();
  f.endRun();
  const bell = () =>
    f
      .notes()
      .find(
        (note) =>
          note.recipient.assignment_id === f.coder.id && note.attempts > 0,
      );
  expect(bell()?.attempts).toBe(1);
  // No time passed: the retry is not due yet.
  await d.tick();
  expect(bell()?.attempts).toBe(1);
  // The delays double: 1, 2, 4 and 8 minutes after the previous bell. One
  // second before the delay no retry is due, one second later it is — a fixed
  // interval would fail the "just before" half.
  for (const [index, minutes] of [1, 2, 4, 8].entries()) {
    f.advance(minutes * 60_000 - 1000);
    await d.tick();
    expect(bell()?.attempts, `too early for retry ${index + 1}`).toBe(
      index + 1,
    );
    f.advance(1000);
    await d.tick();
    expect(bell()?.attempts, `retry ${index + 1}`).toBe(index + 2);
  }
  // One more tick past the last delay exhausts the retries.
  f.advance(16 * 60_000);
  await d.tick();
  expect(
    f
      .notes()
      .some(
        (note) =>
          note.recipient.assignment_id === f.coder.id &&
          note.status === "needs_attention",
      ),
  ).toBe(true);
  expect(alertsFor("pm_ops").length).toBeGreaterThan(0);
}, 30_000);

test("§3.3 no resend while the Assignment still has an unfinished Run", async () => {
  const runtime = fakeRuntime();
  withRun(f, f.coder, "running");
  comment(f);
  f.route();
  const d = dispatcher(f, runtime);
  await d.tick();
  const commentNote = () => f.notes().find((note) => note.kind === "comment");
  const attempts = commentNote()?.attempts;
  f.advance(30 * 60_000);
  await d.tick();
  // The comment notification was never (re)sent while the Run was unfinished.
  expect(commentNote()?.attempts).toBe(attempts);
  expect(commentNote()?.status).toBe("pending");
  expect(runtime.wake).not.toHaveBeenCalled();
});

test("§3.3 a failed wake is marked delivery_failed, escalated, and never retried", async () => {
  const runtime = fakeRuntime();
  runtime.wake.mockResolvedValue({
    ok: false,
    error: { code: "runtime_unavailable", message: "socket gone" },
  });
  withRun(f, f.coder, "running");
  f.endRun();
  comment(f);
  f.route();
  const d = dispatcher(f, runtime);
  await d.tick();

  expect(runtime.wake).toHaveBeenCalledTimes(1);
  expect(f.notes().some((note) => note.status === "delivery_failed")).toBe(
    true,
  );
  expect(alertsFor("pm_ops").length).toBeGreaterThan(0);
  // Not silently retried, and no second Run was created for it.
  const runsAfterFailure = f.runs(f.coder).length;
  f.advance(30 * 60_000);
  await d.tick();
  expect(runtime.wake).toHaveBeenCalledTimes(1);
  expect(f.runs(f.coder).length).toBe(runsAfterFailure);
  expect(f.notes().some((note) => note.status === "needs_attention")).toBe(
    false,
  );
});

test("§3.3 the watchdog escalates a running Run with no MCP activity for 15 minutes", async () => {
  const runtime = fakeRuntime();
  withRun(f, f.coder, "running");
  const d = dispatcher(f, runtime);

  f.advance(14 * 60_000);
  await d.tick();
  expect(f.notes().some((note) => note.kind === "run_attention")).toBe(false);

  f.advance(2 * 60_000);
  await d.tick();
  expect(
    f
      .notes()
      .some(
        (note) =>
          note.kind === "run_attention" &&
          note.recipient.assignment_id === f.coder.id &&
          note.status === "needs_attention",
      ),
  ).toBe(true);
  expect(alertsFor("pm_ops").length).toBeGreaterThan(0);
});

// ------------------------------------------------------- §3.3 / §13.9 loss

test("§3.3/§13.9 a lost runtime goes unknown, then lost, then Needs You and PM Office", async () => {
  withRun(f, f.coder, "running");
  const monitor = new RuntimeMonitor({
    store: f.store,
    runtime: {
      // One snapshot event that reports the terminal as gone, then silence.
      async *events() {
        yield {
          ok: true as const,
          value: {
            seq: 1,
            type: "terminal:lost",
            terminal_ref: refFor(f.coder).terminal_ref,
            observations: [
              {
                terminal_ref: refFor(f.coder).terminal_ref,
                status: { process: "exited", agent: "idle", observed_seq: 1 },
              },
            ],
          },
        } as RuntimeResult<never>;
      },
    },
    clock: f.clock,
    lossGraceMs: 5 * 60_000,
  });
  monitor.reconcile();
  await new Promise((resolve) => setTimeout(resolve, 50));
  monitor.reconcile();
  expect(f.assignment()?.runtime_state).toBe("unknown");
  expect(f.runs(f.coder)[0]?.status).toBe("unknown");

  f.advance(6 * 60_000);
  monitor.reconcile();
  await monitor.stop();
  expect(f.assignment()?.runtime_state).toBe("lost");
  expect(f.notes().some((note) => note.recipient.kind === "needs_you")).toBe(
    true,
  );
  expect(f.notes().some((note) => note.recipient.kind === "pm_office")).toBe(
    true,
  );
});

// ------------------------------------------------------- crash and restart

test("a delivery interrupted mid-flight is settled once and never duplicated", async () => {
  const runtime = fakeRuntime();
  withRun(f, f.coder, "running");
  f.endRun();
  comment(f);
  f.route();

  // First dispatcher claims the bell and creates the Run...
  const first = dispatcher(f, runtime, { startRun: async () => {} });
  await first.tick();
  const notesAfter = f.notes().map((note) => [note.id, note.status]);
  const runsAfter = f.runs(f.coder).length;

  // ...and the process dies before the attempt is settled. A new dispatcher
  // (same store) picks the leftover attempt up after its lease expires.
  const crashedRun = f.runs(f.coder).at(-1) as Run;
  const crashedNotes = f
    .notes()
    .filter((note) => note.recipient.assignment_id === f.coder.id)
    .slice(0, 1)
    .map((note) => note.id);
  f.store.uow.run(() => {
    beginBellAttempt(f.store.database, {
      id: "crashed-attempt",
      project_id: project,
      assignment_id: f.coder.id,
      run_id: crashedRun.id,
      notification_ids: crashedNotes,
      started_at: f.clock.now(),
      lease_until: new Date(Date.parse(f.clock.now()) + 60_000).toISOString(),
    });
  });
  f.advance(2 * 60_000);
  const second = dispatcher(f, runtime);
  await second.tick();
  await second.tick();

  // The leftover attempt was settled as interrupted, not delivered twice.
  expect(
    f.notes().filter((note) => note.status === "delivery_failed").length,
  ).toBeGreaterThan(0);
  expect(f.runs(f.coder).length).toBe(runsAfter);
  // Every row that existed before the crash is still there, unchanged in id.
  const ids = new Set(f.notes().map((note) => note.id));
  for (const [id] of notesAfter) expect(ids.has(id), id).toBe(true);
}, 30_000);

test("a restarted dispatcher does not ring the same notifications twice", async () => {
  const runtime = fakeRuntime();
  withRun(f, f.coder, "running");
  f.endRun();
  comment(f);
  f.route();

  await dispatcher(f, runtime).tick();
  const wakes = runtime.wake.mock.calls.length;
  const runs = f.runs(f.coder).length;
  // A fresh process (new Dispatcher, same store) must not resend or re-queue.
  await dispatcher(f, runtime).tick();
  expect(runtime.wake.mock.calls.length).toBe(wakes);
  expect(f.runs(f.coder).length).toBe(runs);
});
