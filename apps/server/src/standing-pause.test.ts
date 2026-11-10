import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  attentionCommand,
  type CliIo,
  runAssignmentCommand,
  runWorkflowCommand,
  startAssignment,
  stopAssignment,
} from "@cardigan/cli";
import {
  type Assignment,
  acknowledgeRun,
  createCard,
  finishRun,
  postComment,
  type Runtime,
  requestDecision,
} from "@cardigan/domain";
import { parseLaunchConfig } from "@cardigan/roles";
import { HerdrRuntime } from "@cardigan/runtime-herdr";
import { Store, writeRole } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { standingResolver } from "./assembly.js";
import { Dispatcher } from "./dispatch.js";
import { routeProjectEvents } from "./dispatch-inbox.js";

let f: ReturnType<typeof dispatchFixture>,
  io: CliIo,
  output: string[],
  runtime: Runtime;
beforeEach(() => {
  f = dispatchFixture();
  output = [];
  f.store.uow.run((tx) =>
    writeRole(
      tx,
      f.project,
      {
        role_id: "pm",
        version: 1,
        display_name: "PM",
        kind: "standing",
        harness: "pi",
        launch_profile_ref: "fixture",
        core_prompt: "Fixture",
        allowed_tools: [
          "whoami",
          "get_card",
          "get_updates",
          "ack_events",
          "finish_run",
          "record_decision",
        ],
        capabilities: [],
        abilities: [],
        worktree: "none",
        required_machine_tags: [],
      },
      { mode: "add" },
    ),
  );
  io = {
    env: { CARDIGAN_DATA_DIR: f.dataDir },
    cwd: f.dataDir,
    platform: "linux",
    stdout: (s) => output.push(s),
    stderr: () => {},
    signals: { on() {}, off() {} },
    spawnInherit() {
      throw new Error("unused");
    },
    captureCommand: async () => ({ code: 0, stdout: "pi fixture", stderr: "" }),
  };
  runtime = {
    provision: vi.fn(async (_a, _r, _m, launch) => ({
      ok: true,
      value: {
        machine_id: "local",
        runtime_machine: "local",
        terminal_ref: "t-new",
        agent_name: launch.agent_name,
      },
    })),
    release: vi.fn(async () => ({ ok: true, value: undefined })),
    status: vi.fn(async () => ({
      ok: false,
      error: { code: "runtime_not_found", message: "stopped" },
    })),
    wake: vi.fn(),
    resume_or_replace: vi.fn(),
    interrupt: vi.fn(),
    human_entry: vi.fn(),
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  f.close();
});
const current = (a: Assignment) =>
  f.state().assignments.find((x) => x.id === a.id) ?? a;
async function setup(mode: "office" | "ops") {
  await runWorkflowCommand(["pm", "create", `--${mode}`], io, {});
  const pm = f.state().assignments.find((a) => a.scope === "standing");
  if (!pm) throw new Error("No PM");
  f.session(pm, false);
  const card = f.apply((s, a, p) =>
    createCard(
      s,
      a,
      {
        title: "Task",
        goal: "Work",
        acceptance_criteria: ["pass"],
        source: { kind: "quote", text: "fixture" },
        repo: "fixture",
        base_branch: "main",
      },
      p,
    ),
  );
  return { pm, card };
}
const start = (pm: Assignment) =>
  startAssignment({
    store: f.store,
    io,
    project_id: f.project,
    assignment_id: pm.id,
    runtime,
    dataDir: f.dataDir,
    mcpUrl: "http://localhost/mcp",
    launch: {
      config: parseLaunchConfig({
        profiles: { fixture: { harness: "pi", model: "fixture" } },
      }),
      secrets: {},
    },
  });

test("Ops resume omits acknowledged and resolved project findings but keeps unread ones", async () => {
  const { pm } = await setup("ops");
  const run = f.state().runs.find((r) => r.assignment_id === pm.id);
  if (!run) throw new Error("Missing PM Run");
  const findings = ["read", "resolved", "unread"].map((name) => ({
    kind: "orphan_worktree",
    path: `/fixture/${name}`,
    detail: name,
  }));
  f.store.recordReconcileFindings(f.project, findings);
  const events = f.store.uow.run((tx) =>
    findings.map((finding) => {
      const event = {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(f.project),
        type: "reconcile_finding",
        actor: { kind: "system" as const, project_id: f.project },
        payload: { ...finding, first_seen_at: f.clock.now() },
        created_at: f.clock.now(),
      };
      tx.events.append(f.project, event);
      return event;
    }),
  );
  const [read, resolved, unread] = events;
  if (!read || !resolved || !unread) throw new Error("Missing findings");
  routeProjectEvents(f.store, f.project);
  const notes = f.store
    .listNotifications({ project_id: f.project })
    .filter((n) => events.some((e) => e.id === n.event_id));
  for (const note of notes)
    f.store.moveNotification({
      project_id: f.project,
      id: note.id,
      event: "bell",
      patch: { run_id: run.id },
    });
  expect(
    f.store.ackEvents({
      project_id: f.project,
      assignment_id: pm.id,
      card_id: "",
      up_to_seq: read.seq,
    }).ok,
  ).toBe(true);
  f.store.recordReconcileFindings(
    f.project,
    findings.filter((finding) => finding.detail !== "resolved"),
  );
  await stopAssignment({
    store: f.store,
    project_id: f.project,
    assignment_id: pm.id,
    runtime,
  });
  await start(pm);
  const prompt = readFileSync(
    join(f.dataDir, "runs", f.project, pm.id, "first.md"),
    "utf8",
  );
  expect(prompt).not.toContain(`seq=${read.seq}\n`);
  expect(prompt).not.toContain(`seq=${resolved.seq}\n`);
  expect(prompt).toContain(`seq=${unread.seq}\n`);
  const rows = f.store.listNotifications({ project_id: f.project });
  expect(
    notes.map((note) => rows.find((row) => row.id === note.id)?.status),
  ).toEqual(["acked", "acked", "belled"]);
});

test.each(["office", "ops"] as const)(
  "S24 stopped %s stays paused across dispatcher restarts; explicit start reads queued bells",
  async (mode) => {
    const { pm, card } = await setup(mode);
    await stopAssignment({
      store: f.store,
      project_id: f.project,
      assignment_id: pm.id,
      runtime,
    });
    expect(current(pm).status).toBe("suspended");
    expect(
      f
        .state()
        .runs.filter((r) => r.assignment_id === pm.id)
        .every((r) => r.status === "cancelled"),
    ).toBe(true);
    const db = Store.open({ dataDir: f.dataDir });
    try {
      expect(
        db.uow.read((tx) => tx.assignments.get(f.project, pm.id))?.status,
      ).toBe("suspended");
    } finally {
      db.close();
    }
    const event =
      mode === "ops"
        ? f.apply((s, a, p) =>
            postComment(
              s,
              a,
              { card_id: card.id, body: "Please follow up" },
              p,
            ),
          )
        : f.apply((s, a, p) =>
            requestDecision(
              s,
              a,
              {
                card_id: card.id,
                category: "general",
                kind: "choose",
                question: "Choose?",
                context: "Fixture",
                options: [
                  { key: "yes", description: "Go", impact: "Continue" },
                ],
                recommended: "yes",
                decider: "human",
                blocking: false,
                affected_cards: [card.id],
                affected_work_items: [],
              },
              p,
            ),
          );
    expect(event).toBeDefined();
    const options = {
      store: f.store,
      runtime,
      clock: f.clock,
      standing: standingResolver(f.store),
      snapshot: vi.fn(),
      startRun: vi.fn(),
    };
    for (let n = 0; n < 2; n++) {
      f.advance(60 * 60 * 1000);
      await new Dispatcher(options).tick();
    }
    expect(runtime.status).not.toHaveBeenCalled();
    expect(runtime.provision).not.toHaveBeenCalled();
    expect(runtime.resume_or_replace).not.toHaveBeenCalled();
    expect(runtime.wake).not.toHaveBeenCalled();
    const pending = f.store
      .listNotifications({ project_id: f.project })
      .filter((n) => n.recipient.kind === `pm_${mode}`);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((n) => n.status === "pending")).toBe(true);
    attentionCommand([], io);
    expect(output.join("\n")).toContain("已暂停");
    expect(output.join("\n")).toContain(pm.id);
    if (mode === "office") await start(pm);
    else
      await runWorkflowCommand(["pm", "start", "--ops"], io, {
        start: async () => {
          await start(pm);
          return 0;
        },
      });
    expect(current(pm).status).toBe("active");
    expect(runtime.provision).toHaveBeenCalledOnce();
    const prompt = readFileSync(
      join(f.dataDir, "runs", f.project, pm.id, "first.md"),
      "utf8",
    );
    expect(prompt).toContain(`card=${card.id}`);
    for (const note of pending) expect(prompt).toContain(`seq=${note.seq}`);
    const running = f
      .state()
      .runs.find((r) => r.assignment_id === pm.id && r.status === "dispatched");
    if (!running) throw new Error("Missing resumed Run");
    f.apply(
      (s, a, p) => acknowledgeRun(s, a, { run_id: running.id }, p),
      f.actorFor(pm),
    );
    const ack = f.store.ackEvents({
      project_id: f.project,
      assignment_id: pm.id,
      card_id: card.id,
      up_to_seq: Math.max(...pending.map((n) => n.seq)),
    });
    expect(ack.ok).toBe(true);
    f.apply(
      (s, a, p) =>
        finishRun(
          s,
          a,
          { run_id: running.id, outcome: "completed", summary: "Read backlog" },
          p,
        ),
      f.actorFor(pm),
    );
    await new Dispatcher(options).tick();
    expect(
      f.store
        .listNotifications({ project_id: f.project })
        .filter((n) => pending.some((p) => p.id === n.id))
        .every((n) => n.status === "acked"),
    ).toBe(true);
    expect(runtime.resume_or_replace).not.toHaveBeenCalled();
  },
);

test("S24 a failed terminal stop still persists the pause and revokes its token", async () => {
  const { pm } = await setup("ops");
  vi.mocked(runtime.release).mockResolvedValue({
    ok: false,
    error: { code: "runtime_unavailable", message: "retry" },
  });
  await expect(
    stopAssignment({
      store: f.store,
      project_id: f.project,
      assignment_id: pm.id,
      runtime,
    }),
  ).rejects.toThrow();
  expect(current(pm).status).toBe("suspended");
  expect(
    f.store.uow
      .run((tx) => tx.tokensForAssignment(f.project, pm.id))
      .every((t) => t.revoked_at !== null),
  ).toBe(true);
});

test("S24 the CLI persists pause even when the runtime cannot initialize", async () => {
  const { pm } = await setup("office");
  vi.spyOn(HerdrRuntime, "create").mockResolvedValue({
    ok: false,
    error: { code: "runtime_unavailable", message: "offline" },
  });
  await expect(runAssignmentCommand(["stop", pm.id], io)).rejects.toThrow(
    "runtime_unavailable",
  );
  expect(current(pm).status).toBe("suspended");
});

test("S24 failed explicit restart leaves the PM paused", async () => {
  const { pm } = await setup("ops");
  await stopAssignment({
    store: f.store,
    project_id: f.project,
    assignment_id: pm.id,
    runtime,
  });
  vi.mocked(runtime.provision).mockResolvedValue({
    ok: false,
    error: { code: "runtime_unavailable", message: "offline" },
  });
  await expect(start(pm)).rejects.toThrow();
  expect(current(pm).status).toBe("suspended");
  expect(f.state().runs.every((r) => r.status === "cancelled")).toBe(true);
});

test("S24 a late wake result cannot escalate an intentional pause", async () => {
  const { pm, card } = await setup("ops");
  const run = f.state().runs.find((r) => r.assignment_id === pm.id);
  if (!run) throw new Error("No Run");
  f.apply(
    (s, a, p) =>
      finishRun(
        s,
        a,
        { run_id: run.id, outcome: "completed", summary: "idle" },
        p,
      ),
    f.actorFor(pm),
  );
  f.apply((s, a, p) =>
    postComment(s, a, { card_id: card.id, body: "Follow up" }, p),
  );
  vi.mocked(runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "alive", agent: "idle", observed_seq: 1 },
  });
  let finish!: () => void, entered!: () => void;
  const called = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.mocked(runtime.wake).mockImplementation(async () => {
    entered();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { ok: true, value: { sent: true } };
  });
  const dispatcher = new Dispatcher({
    store: f.store,
    runtime,
    clock: f.clock,
    standing: standingResolver(f.store),
    snapshot: vi.fn(),
    startRun: vi.fn(),
  });
  const tick = dispatcher.tick();
  await called;
  await stopAssignment({
    store: f.store,
    project_id: f.project,
    assignment_id: pm.id,
    runtime,
  });
  finish();
  await tick;
  f.advance(86_400_000);
  await dispatcher.tick();
  expect(current(pm).status).toBe("suspended");
  const notes = f.store
    .listNotifications({ project_id: f.project })
    .filter((n) => n.recipient.kind === "pm_ops");
  expect(notes.length).toBeGreaterThan(0);
  expect(notes.every((n) => n.status === "pending")).toBe(true);
  expect(f.state().events.some((e) => e.type === "bell_delivery_failed")).toBe(
    false,
  );
});
