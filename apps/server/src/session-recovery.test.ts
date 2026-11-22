import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  acknowledgeRun,
  createHostOpsAssignment,
  dispatchRun,
  HOST_OPS_ROLE_TOOLS,
  type Runtime,
  recordDecision,
  requestDecision,
  stopWorkItemAssignment,
} from "@cardigan/domain";
import { HostOpsService } from "@cardigan/host";
import { authenticate, unwrap } from "@cardigan/mcp-server";
import { parseLaunchConfig } from "@cardigan/roles";
import {
  listBellAttempts,
  PROJECT_EVENT_STREAM,
  Store,
  unfinishedBellAttempts,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { runtimeEvents } from "../test-support/runtime-events.js";
import { Dispatcher } from "./dispatch.js";
import { RuntimeMonitor } from "./dispatch-monitor.js";
import { startQueuedRun } from "./host-start.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

let f: ReturnType<typeof dispatchFixture>;
beforeEach(() => {
  f = dispatchFixture();
});
afterEach(() => f.close());
function scenario() {
  const target = f.create(),
    previous = f.session(target.assignment, false);
  const decision = f.apply((s, a, p) =>
    requestDecision(
      s,
      a,
      {
        card_id: target.card.id,
        category: "general",
        kind: "choose",
        question: "Change behavior?",
        context: "Need direction",
        options: [{ key: "go", description: "Proceed", impact: "Resume" }],
        recommended: "go",
        decider: "human",
        plain_summary: TEST_PLAIN_SUMMARY,
        blocking: true,
        affected_cards: [target.card.id],
        affected_work_items: [target.item.id],
      },
      p,
    ),
  );
  for (const card of [undefined, target.card.id])
    f.store.advanceRouterCursor(
      f.project,
      card ?? PROJECT_EVENT_STREAM,
      f.store.getUpdates({
        project_id: f.project,
        ...(card ? { card_id: card } : {}),
      }).latest_seq,
    );
  f.apply((s, a, p) =>
    recordDecision(
      s,
      a,
      {
        decision_id: decision.id,
        option: "go",
        rationale: "Approved",
        raw_quote: "go",
      },
      p,
    ),
  );
  const run = f.state().runs.find((r) => r.status === "queued");
  if (!run) throw new Error("No resumed Run");
  const runtime: Runtime = {
    status: vi.fn<Runtime["status"]>(async () => ({
      ok: false,
      error: { code: "runtime_unavailable", message: "No core" },
    })),
    observe_retirement: vi.fn(async () => ({
      ok: true as const,
      value: "exited" as const,
    })),
    resume_or_replace: vi.fn(),
    provision: vi.fn<Runtime["provision"]>(
      async (_assignment, _role, _machine, launch) => {
        expect(
          unfinishedBellAttempts(f.store.database, f.project),
        ).toHaveLength(1);
        expect(launch.labels.run).toBe(run.id);
        return {
          ok: true,
          value: { ...f.refFor(target.assignment), terminal_ref: "t9" },
        };
      },
    ),
    wake: vi.fn(),
    release: vi.fn<Runtime["release"]>(async () => ({
      ok: true,
      value: undefined,
    })),
    interrupt: vi.fn(),
    human_entry: vi.fn(),
  };
  const host = {
    store: f.store,
    runtime,
    dataDir: f.dataDir,
    clock: f.clock,
    launch: {
      config: parseLaunchConfig({
        profiles: { fixture: { harness: "pi", model: "session-model" } },
      }),
      secrets: {},
    },
    mcpUrl: "http://localhost/mcp",
  };
  const options = {
    store: f.store,
    runtime,
    clock: f.clock,
    snapshot: async () => ({ model: "unused", agent_cli_version: "unused" }),
    startRun: (input: Parameters<typeof startQueuedRun>[1]) =>
      startQueuedRun(host, input),
  };
  return {
    target,
    previous,
    run,
    runtime,
    host,
    options,
    notes: () =>
      f.store.listNotifications({
        project_id: f.project,
        assignment_id: target.assignment.id,
      }),
  };
}

test.each(["runtime_not_found", "runtime_unavailable"] as const)(
  "M5.6 %s between Runs replaces the Session, commits a handoff and dispatches exactly the queued Run",
  async (code) => {
    const s = scenario();
    // Both snapshot errors still require a separate positive exit observation.
    // Only the old Session is lost; the replacement terminal is starting.
    vi.mocked(s.runtime.status).mockImplementation(async (ref) =>
      ref.terminal_ref === "t9"
        ? {
            ok: true,
            value: { process: "alive", agent: "idle", observed_seq: 1 },
          }
        : { ok: false, error: { code, message: "Lost" } },
    );
    expect(
      f.state().assignments.find((a) => a.id === s.target.assignment.id)
        ?.runtime_state,
    ).toBe("idle");
    await new Dispatcher(s.options).tick();
    await new Dispatcher(s.options).tick();
    expect(s.runtime.provision).toHaveBeenCalledOnce();
    expect(s.runtime.observe_retirement).toHaveBeenCalledOnce();
    expect(s.runtime.resume_or_replace).not.toHaveBeenCalled();
    expect(s.runtime.wake).not.toHaveBeenCalled();
    expect(f.state().runs).toHaveLength(2);
    expect(f.state().runs.find((r) => r.id === s.run.id)).toMatchObject({
      status: "dispatched",
      kind: "decision_resumed",
      model: s.run.model,
    });
    expect(
      f.state().assignments.find((a) => a.id === s.target.assignment.id),
    ).toMatchObject({
      runtime_state: "running",
      runtime_ref: { terminal_ref: "t9" },
    });
    const handoff = f.state().timeline.filter((e) => e.type === "handoff");
    expect(handoff).toHaveLength(1);
    expect(handoff[0]).toMatchObject({ author: "system", run_id: s.run.id });
    for (const word of [code, s.previous.id, "blocked", "get_updates"])
      expect(handoff[0]?.body).toContain(word);
    const first = readFileSync(
      join(f.dataDir, "runs", f.project, s.target.assignment.id, "first.md"),
      "utf8",
    );
    expect(first).toContain(`run=${s.run.id}`);
    expect(s.notes().every((n) => n.status === "belled")).toBe(true);
  },
);

test.each(["runtime_not_found", "runtime_unavailable"] as const)(
  "C-554 queued followup cannot replace a still-live owner on a %s snapshot",
  async (code) => {
    const s = scenario();
    vi.mocked(s.runtime.status).mockResolvedValue({
      ok: false,
      error: { code, message: "missing snapshot" },
    });
    s.runtime.observe_retirement = vi.fn(async () => ({
      ok: true,
      value: "alive",
    }));
    const d = new Dispatcher(s.options);
    try {
      await d.tick();
      expect(s.runtime.observe_retirement).toHaveBeenCalledWith(
        f.refFor(s.target.assignment),
        { project_id: f.project, assignment_id: s.target.assignment.id },
      );
      expect(s.runtime.provision).not.toHaveBeenCalled();
      expect(s.runtime.resume_or_replace).not.toHaveBeenCalled();
      expect(s.runtime.release).not.toHaveBeenCalled();
      expect(f.state().runs.find((r) => r.id === s.run.id)?.status).toBe(
        "queued",
      );
      expect(s.notes().map((n) => n.status)).toContain("pending");
    } finally {
      await d.close();
    }
  },
);
test.each([false, true])(
  "queued system-ended Run with a stopped core requires independent local exit proof (%s)",
  async (gone) => {
    const s = scenario();
    s.runtime.observe_retirement = vi.fn(async () => ({
      ok: false,
      error: { code: "runtime_unavailable", message: "core offline" },
    }));
    s.runtime.confirm_local_exit = vi.fn(async () => ({
      ok: true,
      value: gone,
    }));
    const d = new Dispatcher(s.options);
    try {
      await d.tick();
      expect(s.runtime.confirm_local_exit).toHaveBeenCalledWith(
        f.refFor(s.target.assignment),
        { project_id: f.project, assignment_id: s.target.assignment.id },
      );
      expect(s.runtime.provision).toHaveBeenCalledTimes(gone ? 1 : 0);
      expect(s.runtime.release).not.toHaveBeenCalled();
      expect(s.runtime.resume_or_replace).not.toHaveBeenCalled();
      expect(f.state().runs.find((r) => r.id === s.run.id)?.status).toBe(
        gone ? "dispatched" : "queued",
      );
    } finally {
      await d.close();
    }
  },
);

test.each(["dispatched", "running", "unknown"])(
  "M5.6 an in-flight %s Run prevents automatic replacement",
  async (status) => {
    const s = scenario();
    f.apply((state, a, p) => dispatchRun(state, a, { run_id: s.run.id }, p));
    if (status !== "dispatched")
      f.apply(
        (state, a, p) => acknowledgeRun(state, a, { run_id: s.run.id }, p),
        f.actorFor(s.target.assignment),
      );
    const events = runtimeEvents(),
      monitor = new RuntimeMonitor({
        store: f.store,
        runtime: events.source,
        clock: f.clock,
        lossGraceMs: 10,
      });
    try {
      monitor.reconcile();
      if (status === "unknown") {
        events.send({
          seq: 1,
          type: "lost",
          terminal_ref: f.refFor(s.target.assignment).terminal_ref,
        });
        await expect
          .poll(() => f.state().runs.find((r) => r.id === s.run.id)?.status)
          .toBe("unknown");
        f.advance(11);
        monitor.reconcile();
        expect(
          f.state().assignments.find((a) => a.id === s.target.assignment.id)
            ?.runtime_state,
        ).toBe("lost");
        expect(
          f.store.listNotifications({
            project_id: f.project,
            recipient_kind: "needs_you",
          }),
        ).toHaveLength(1);
        expect(
          f.store.listNotifications({
            project_id: f.project,
            recipient_kind: "pm_office",
          }),
        ).toHaveLength(1);
      }
      await new Dispatcher(s.options).tick();
      expect(s.runtime.resume_or_replace).not.toHaveBeenCalled();
      expect(s.runtime.provision).not.toHaveBeenCalled();
      // Probe unstarted dispatches for recovery and running sessions for idle
      // inbox delivery. An unreachable runtime must not be woken or replaced.
      expect(s.runtime.status).toHaveBeenCalledTimes(
        status === "unknown" ? 0 : 1,
      );
      expect(s.runtime.wake).not.toHaveBeenCalled();
      expect(f.state().runs).toHaveLength(2);
    } finally {
      await monitor.stop();
    }
  },
);

test("M5.6 failed replacement records failure, compensates and escalates once; cancelled Run attention resolves", async () => {
  const s = scenario();
  vi.mocked(s.runtime.provision).mockResolvedValue({
    ok: false,
    error: { code: "runtime_unavailable", message: "Cannot restart" },
  });
  const dispatcher = new Dispatcher(s.options);
  await dispatcher.tick();
  const failed = s.notes();
  expect(failed.length).toBeGreaterThan(0);
  expect(failed.every((n) => n.status === "delivery_failed")).toBe(true);
  const attempts = listBellAttempts(f.store.database, f.project).filter(
    (attempt) => attempt.run_id === s.run.id,
  );
  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toMatchObject({
    outcome: "failed",
    finished_at: f.clock.now(),
  });
  expect(f.state().runs.find((r) => r.id === s.run.id)?.status).toBe(
    "cancelled",
  );
  const tokens = f.store.uow.run((tx) =>
    tx.tokensForAssignment(f.project, s.target.assignment.id),
  );
  expect(tokens.length).toBeGreaterThan(0);
  expect(tokens.every((token) => token.revoked_at !== null)).toBe(true);
  const cursors = f.state().cursors;
  f.advance(3600000);
  await dispatcher.tick();
  // C-56 clears obsolete attention after compensation cancels the Run. It must
  // retain the failed receipt and notification identity, without retrying it.
  expect(s.notes()).toEqual(
    failed.map((note) => ({
      ...note,
      status: "resolved",
      updated_at: f.clock.now(),
    })),
  );
  const reopened = Store.open({ dataDir: f.dataDir, clock: f.clock });
  try {
    await new Dispatcher({ ...s.options, store: reopened }).tick();
    expect(listBellAttempts(reopened.database, f.project)).toEqual(attempts);
  } finally {
    reopened.close();
  }
  expect(f.state().cursors).toEqual(cursors);
  expect(s.runtime.provision).toHaveBeenCalledOnce();
  expect(s.notes().every((n) => n.status === "resolved")).toBe(true);
  expect(unfinishedBellAttempts(f.store.database, f.project)).toEqual([]);
  expect(f.state().runs.find((r) => r.id === s.run.id)?.status).toBe(
    "cancelled",
  );
  expect(f.state().runs).toHaveLength(2);
  expect(
    f.state().events.filter((e) => e.type === "bell_delivery_failed"),
  ).toHaveLength(1);
  expect(
    f
      .state()
      .events.filter((e) =>
        ["run_dispatch_recovered", "run_dispatch_stalled"].includes(e.type),
      ),
  ).toEqual([]);
  expect(f.state().timeline.filter((e) => e.type === "handoff")).toEqual([]);
  expect(
    f.store
      .listNotifications({
        project_id: f.project,
        recipient_kind: "pm_ops",
      })
      .filter(
        (n) =>
          f.state().events.find((e) => e.id === n.event_id)?.type ===
          "bell_delivery_failed",
      ),
  ).toHaveLength(1);
  expect(
    f.store.uow
      .run((tx) => tx.tokensForAssignment(f.project, s.target.assignment.id))
      .every((token) => token.revoked_at !== null),
  ).toBe(true);
});

test.each([
  "clean",
  "local_only",
  "ignored_only",
  "local_only_with_tracked_edit",
  "monitor_refresh",
  "changed_during_refresh",
  "missing_at_launch",
  "replaced_at_launch",
  "changed_access_at_launch",
  "dirty",
  "staged_and_unstaged",
  "shared_at_launch",
  "stopped_at_launch",
  "masked_edit",
  "skipped_edit",
  "replaced_during_backup",
  "backup_failure",
  "lost_proof",
  "live_again",
  "live_during_backup",
  "finished_group_alive",
  "finished_group_gone",
  "missing_after_token",
  "missing_then_replaced_at_launch",
] as const)(
  "M5.6: recover the original queued writer after core exit without waiting or signaling (%s)",
  async (mode) => {
    const keepsMaterial = [
      "local_only",
      "ignored_only",
      "local_only_with_tracked_edit",
    ].includes(mode);
    const trackedEdit = [
      "dirty",
      "staged_and_unstaged",
      "local_only_with_tracked_edit",
      "shared_at_launch",
    ].includes(mode);
    const resumes =
      mode === "clean" ||
      mode === "monitor_refresh" ||
      mode === "finished_group_gone" ||
      keepsMaterial ||
      (trackedEdit && mode !== "shared_at_launch");
    const backedUp =
      resumes || mode.endsWith("_at_launch") || mode === "missing_after_token";
    const s = scenario(),
      a = s.target.assignment,
      branch = "agent/test/writer";
    const workspace = join(f.dataDir, "agent", "worktrees", f.project, a.id);
    mkdirSync(workspace, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", workspace, ...args], {
        encoding: "utf8",
      }).trim();
    git("init", "-q", "-b", branch);
    writeFileSync(join(workspace, "source"), "initial");
    git("add", "--", "source");
    git(
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "base",
      "--allow-empty",
    );
    const sha = git("rev-parse", "HEAD");
    if (mode === "masked_edit" || mode === "skipped_edit") {
      git(
        "update-index",
        mode === "masked_edit" ? "--assume-unchanged" : "--skip-worktree",
        "--",
        "source",
      );
      writeFileSync(join(workspace, "source"), "uncommitted");
    }
    const ref = { ...f.refFor(a), local_process_receipt: "fixture-launch" };
    f.store.uow.run((tx) => {
      const current = tx.assignments.get(f.project, a.id);
      const role = tx.roles.get(f.project, {
        role_id: a.role_id,
        role_version: a.role_version,
      });
      if (!current || !role) throw new Error("Missing writer fixture");
      tx.roles.put(f.project, { ...role, worktree: "write" });
      tx.assignments.put(f.project, {
        ...current,
        runtime_ref: ref,
        worktree_path: workspace,
        branch,
        base_sha: sha,
      });
    });
    const privateName = "local-material-with-newline\n M source";
    if (mode === "ignored_only")
      writeFileSync(
        join(workspace, ".git", "info", "exclude"),
        "local-material*\n",
      );
    if (keepsMaterial)
      writeFileSync(join(workspace, privateName), "retained fixture");
    if (mode === "staged_and_unstaged") {
      writeFileSync(join(workspace, "source"), "staged fixture");
      git("add", "--", "source");
    }
    if (trackedEdit) writeFileSync(join(workspace, "source"), "tracked edit");
    const index = readFileSync(join(workspace, ".git", "index"));
    s.runtime.observe_retirement = vi.fn(async () => ({
      ok: false as const,
      error: { code: "runtime_unavailable" as const, message: "core offline" },
    }));
    let gone = true;
    s.runtime.confirm_local_exit = vi.fn(async () => ({
      ok: true as const,
      value: gone,
    }));
    s.runtime.retire_idle = vi.fn();
    if (mode === "finished_group_alive" || mode === "finished_group_gone") {
      // The terminal manager reports the row finished while the core is up:
      // only a kernel check of the receipt's process group proves exit.
      s.runtime.observe_retirement = vi.fn(async () => ({
        ok: true as const,
        value: "exited" as const,
      }));
      gone = false;
      s.runtime.confirm_local_group_exit = vi.fn(async () => ({
        ok: true as const,
        value: mode === "finished_group_gone",
      }));
    }
    const revive = () => {
      s.runtime.observe_retirement = vi.fn(async () => ({
        ok: true as const,
        value: "alive" as const,
      }));
      vi.mocked(s.runtime.status).mockResolvedValue({
        ok: true,
        value: { process: "alive", agent: "idle", observed_seq: 1 },
      });
    };
    let backupFails = true;
    const backup = vi.fn(async () => {
      if (mode === "monitor_refresh")
        f.store.uow.run((tx) => {
          const current = tx.assignments.get(f.project, a.id);
          if (!current) throw new Error("missing Assignment");
          tx.assignments.put(f.project, {
            ...current,
            session_maintenance: {
              candidate: false,
              reason: "run_busy",
              threshold_minutes: 60,
              evaluated_at: f.clock.now(),
              since: f.clock.now(),
              basis: "observation",
            },
          });
        });
      if (mode === "live_during_backup") revive();
      if (mode === "replaced_during_backup") {
        const original = `${workspace}-original`;
        renameSync(workspace, original);
        execFileSync("git", [
          "clone",
          "--quiet",
          "--local",
          original,
          workspace,
        ]);
      }
      if (mode === "backup_failure" && backupFails)
        throw new Error("unavailable");
      return { sha, ref: "refs/cardigan/stall-backups/test" };
    });
    const service = new HostOpsService({
      ...s.options,
      contextUsage: { execution: { mode: "local", dataDir: f.dataDir } },
      stallBackup: backup,
    });
    /** The fixture's host_ops patrol resumes the original incident. */
    const opsTakeover = async () => {
      f.store.uow.run((tx) =>
        tx.roles.put(f.project, {
          role_id: "host_ops",
          role_version: 1,
          allowed_tools: HOST_OPS_ROLE_TOOLS,
          capabilities: [],
        }),
      );
      const ops = f.apply((st, actor, p) =>
        createHostOpsAssignment(st, actor, {}, p),
      ).assignment;
      const token = f.store.issueToken({
        project_id: f.project,
        assignment_id: ops.id,
        role: { role_version: 1, allowed_tools: HOST_OPS_ROLE_TOOLS },
      });
      const context = {
        identity: unwrap(authenticate(f.store, token.token)),
        store: f.store,
      };
      const cause = f
        .state()
        .events.find((e) => e.type === "bell_turn_recovery_due")?.id as string;
      await service.tools.execute(context, "host_ops_restart_assignment", {
        target_id: a.id,
        reason: "fixture",
        dispatch_stall_id: cause,
        idempotency_key: "ops-takeover",
      });
    };
    const startRun = vi.fn(s.options.startRun);
    const d = new Dispatcher({ ...s.options, startRun });
    const events = (type: string) =>
      f.state().events.filter((e) => e.type === type);
    try {
      await d.tick();
      await d.tick();
      expect(events("bell_turn_recovery_due")).toMatchObject([
        {
          payload: {
            activity_source: "observed_local_exit",
            queued_run_id: s.run.id,
          },
        },
      ]);
      expect(startRun).not.toHaveBeenCalled();
      if (mode === "monitor_refresh" || mode === "changed_during_refresh") {
        let observations = 0;
        s.runtime.confirm_local_exit = vi.fn(async () => {
          if (++observations === 1) {
            f.store.uow.run((tx) => {
              const current = tx.assignments.get(f.project, a.id);
              if (!current) throw new Error("missing Assignment");
              tx.assignments.put(f.project, {
                ...current,
                runtime_state: "unknown",
              });
            });
          }
          return {
            ok: true as const,
            value: observations === 1 || mode === "monitor_refresh",
          };
        });
      }
      if (mode === "lost_proof") gone = false;
      if (mode === "live_again") {
        revive();
      }
      await vi.waitFor(
        async () => {
          await service.tick();
          if (backedUp)
            expect(events("host_ops_action_finished")).toMatchObject([
              { payload: { run_id: s.run.id, backup_sha: sha } },
            ]);
          else if (
            mode === "backup_failure" ||
            mode === "replaced_during_backup"
          )
            expect(events("host_ops_action_finished")).toMatchObject([
              { payload: { reason: "workspace_backup_unconfirmed" } },
            ]);
          else if (
            mode === "live_during_backup" ||
            mode === "finished_group_alive"
          )
            expect(events("host_ops_action_finished")).toMatchObject([
              { payload: { reason: "terminal_exit_unconfirmed" } },
            ]);
          else expect(events("dispatch_stall_attention")).toHaveLength(1);
        },
        { timeout: 10_000 },
      );
      if (
        [
          "backup_failure",
          "replaced_during_backup",
          "live_during_backup",
          "finished_group_alive",
        ].includes(mode)
      ) {
        // A failed automatic attempt is handed to Ops once; it is not pickup.
        await vi.waitFor(async () => {
          f.advance(31_000);
          await service.tick();
          expect(events("dispatch_stall_attention")).toMatchObject([
            { payload: { can_restart: false, assignment_id: a.id } },
          ]);
        });
        expect(events("host_ops_action_taken")).toHaveLength(1);
        f.advance(16 * 60_000);
        await vi.waitFor(async () => {
          f.advance(31_000);
          await service.tick();
          expect(events("dispatch_stall_handoff_overdue")).toHaveLength(1);
        });
        expect(events("dispatch_stall_attention")).toHaveLength(1);
        expect(events("host_ops_action_taken")).toHaveLength(1);
        expect(s.notes().map((n) => n.status)).not.toContain("resolved");
      }
      expect(f.state().runs.find((r) => r.id === s.run.id)).toEqual(s.run);
      const current = f.state().assignments.find((o) => o.id === a.id);
      expect(current?.runtime_ref).toEqual(backedUp ? null : ref);
      expect(s.runtime.retire_idle).not.toHaveBeenCalled();
      expect(s.runtime.release).not.toHaveBeenCalled();
      if (mode === "masked_edit" || mode === "skipped_edit") {
        expect(backup).not.toHaveBeenCalled();
        expect(readFileSync(join(workspace, "source"), "utf8")).toBe(
          "uncommitted",
        );
      }
      expect(f.state().timeline.filter((e) => e.type === "handoff")).toEqual(
        [],
      );
      if (mode === "changed_during_refresh")
        expect(backup).not.toHaveBeenCalled();
      if (resumes) {
        expect(events("dispatch_stall_attention")).toHaveLength(0);
        await d.tick();
        if (keepsMaterial) {
          expect(readFileSync(join(workspace, privateName), "utf8")).toBe(
            "retained fixture",
          );
        }
        if (trackedEdit || keepsMaterial) {
          expect(readFileSync(join(workspace, ".git", "index"))).toEqual(index);
          expect(readFileSync(join(workspace, "source"), "utf8")).toBe(
            trackedEdit ? "tracked edit" : "initial",
          );
          expect(git("show", ":source")).toBe(
            mode === "staged_and_unstaged" ? "staged fixture" : "initial",
          );
          expect(git("rev-parse", "HEAD")).toBe(sha);
          expect(git("ls-tree", "-r", "--name-only", sha)).toBe("source");
          expect(JSON.stringify(f.state().events)).not.toContain(
            "local-material",
          );
        }
        expect(startRun).toHaveBeenCalledOnce();
        expect(s.runtime.provision).toHaveBeenCalledOnce();
        expect(vi.mocked(s.runtime.provision).mock.calls[0]?.[3].cwd).toBe(
          workspace,
        );
        f.apply(
          (state, actor, ports) =>
            acknowledgeRun(state, actor, { run_id: s.run.id }, ports),
          f.actorFor(a),
        );
        expect(f.state().runs.find((r) => r.id === s.run.id)).toHaveProperty(
          "started_at",
        );
        const handoffs = f.state().timeline.filter((e) => e.type === "handoff");
        expect(handoffs).toHaveLength(1);
        for (const detail of [
          "运行时失联",
          JSON.stringify({ terminal_ref: ref.terminal_ref }),
          `最近 Run：${s.previous.id}`,
          "outcome：blocked",
          "get_updates",
        ])
          expect(handoffs[0]?.body).toContain(detail);
        expect(handoffs[0]?.body).not.toContain(workspace);
      } else if (backedUp) {
        const kept = `${workspace}-preserved`;
        if (mode === "stopped_at_launch") {
          f.apply((state, actor, ports) =>
            stopWorkItemAssignment(
              state,
              actor,
              { assignment_id: a.id, reason: "Fixture stop" },
              ports,
            ),
          );
        } else if (mode === "shared_at_launch") {
          const other = f.create().assignment;
          f.store.uow.run((tx) =>
            tx.assignments.put(f.project, {
              ...other,
              machine_id: a.machine_id,
              worktree_path: workspace,
            }),
          );
        } else if (mode === "changed_access_at_launch") {
          // Make the mode differ even on hosts with a nonstandard umask.
          const original = statSync(workspace).mode;
          chmodSync(workspace, original ^ 0o010);
        } else if (mode === "missing_after_token") {
          // The first recheck passes; the checkout disappears once this
          // attempt's token exists, before the final recheck and provision.
          const original = f.store.uow;
          const tokens = () =>
            original.run((tx) => tx.tokensForAssignment(f.project, a.id));
          const before = tokens().length;
          let moved = false;
          vi.spyOn(f.store, "uow", "get").mockReturnValue({
            ...original,
            run: (work) => {
              const result = original.run(work);
              if (!moved && tokens().length > before) {
                moved = true;
                renameSync(workspace, kept);
              }
              return result;
            },
          });
        } else {
          renameSync(workspace, kept);
          if (mode === "replaced_at_launch")
            // The original holds uncommitted work the commit does not have.
            writeFileSync(join(kept, "source"), "uncommitted draft");
          if (mode === "replaced_at_launch")
            execFileSync("git", [
              "clone",
              "--quiet",
              "--local",
              kept,
              workspace,
            ]);
        }
        await d.tick();
        expect(s.runtime.provision).not.toHaveBeenCalled();
        expect(f.state().timeline.filter((e) => e.type === "handoff")).toEqual(
          [],
        );
        if (mode !== "stopped_at_launch") {
          // Refusal keeps the original work: no cancellation, no resolved
          // notice, one refusal and one Ops handoff; repeated ticks hold.
          const queuedRun = () => f.state().runs.find((r) => r.id === s.run.id);
          expect(queuedRun()?.status).toBe("queued");
          expect(events("retained_writer_refused")).toMatchObject([
            { payload: { run_id: s.run.id, assignment_id: a.id } },
          ]);
          await d.tick();
          await d.tick();
          expect(s.runtime.provision).not.toHaveBeenCalled();
          expect(events("retained_writer_refused")).toHaveLength(1);
          expect(queuedRun()?.status).toBe("queued");
          expect(s.notes().map((n) => n.status)).not.toContain("resolved");
          await vi.waitFor(async () => {
            f.advance(31_000);
            await service.tick();
            expect(events("dispatch_stall_attention")).toMatchObject([
              {
                payload: {
                  assignment_id: a.id,
                  can_restart: false,
                  reason: "writer_checkout_refused",
                },
              },
            ]);
          });
          f.advance(16 * 60_000);
          await vi.waitFor(async () => {
            f.advance(31_000);
            await service.tick();
            expect(events("dispatch_stall_handoff_overdue")).toHaveLength(1);
          });
          expect(events("host_ops_action_taken")).toHaveLength(1);
          expect(queuedRun()?.status).toBe("queued");
          // Past every attempt lease: the dispatch and recovery patrols still
          // find the original work intact and start nothing.
          f.advance(2 * 60 * 60_000);
          await d.tick();
          f.advance(31_000);
          await service.tick();
          await d.tick();
          expect(
            unfinishedBellAttempts(f.store.database, f.project, a.id),
          ).toEqual([]);
          expect(queuedRun()?.status).toBe("queued");
          expect(s.notes().map((n) => n.status)).not.toContain("resolved");
          expect(events("run_dispatch_aborted")).toEqual([]);
          expect(s.runtime.provision).not.toHaveBeenCalled();
          // Only the refused attempt itself; no retry after the lease.
          expect(startRun).toHaveBeenCalledOnce();
        }
        const missing = [
          "missing_at_launch",
          "missing_after_token",
          "missing_then_replaced_at_launch",
        ].includes(mode);
        if (missing) expect(existsSync(workspace)).toBe(false);
        if (mode === "missing_after_token")
          // Only this attempt's credentials are withdrawn.
          expect(
            f.store.uow
              .run((tx) => tx.tokensForAssignment(f.project, a.id))
              .filter((t) => t.revoked_at === null),
          ).toHaveLength(0);
        const takeoverResult = (reason: string) =>
          vi.waitFor(
            async () => {
              f.advance(31_000);
              await service.tick();
              expect(
                events("host_ops_action_finished").filter(
                  (e) => (e.payload as { reason?: string }).reason === reason,
                ),
              ).toHaveLength(1);
            },
            { timeout: 10_000 },
          );
        const keptOriginal = async () => {
          await d.tick();
          await d.tick();
          expect(s.runtime.provision).not.toHaveBeenCalled();
          expect(f.state().runs.find((r) => r.id === s.run.id)?.status).toBe(
            "queued",
          );
          expect(s.notes().map((n) => n.status)).not.toContain("resolved");
        };
        if (missing) {
          // The checkout is back. Ops takes over the same incident; the new
          // action must match the incident's first directory identity.
          renameSync(kept, workspace);
          await opsTakeover();
          {
            await vi.waitFor(
              async () => {
                f.advance(31_000);
                await service.tick();
                expect(events("dispatch_stall_backup_verified")).toHaveLength(
                  2,
                );
                expect(
                  events("host_ops_action_finished").filter(
                    (e) =>
                      (e.payload as { run_id?: string }).run_id === s.run.id,
                  ),
                ).toHaveLength(2);
              },
              { timeout: 10_000 },
            );
            const [firstRecord, takeoverRecord] = events(
              "dispatch_stall_backup_verified",
            ).map((e) => e.payload as { workspace_seal?: string });
            expect(takeoverRecord?.workspace_seal).toBe(
              firstRecord?.workspace_seal,
            );
            if (mode === "missing_then_replaced_at_launch") {
              // Swapped for a same-commit copy after the takeover settled:
              // the launch still checks the incident's first identity.
              const swapped = `${workspace}-swapped`;
              renameSync(workspace, swapped);
              execFileSync("git", [
                "clone",
                "--quiet",
                "--local",
                swapped,
                workspace,
              ]);
              await keptOriginal();
              expect(events("retained_writer_refused")).toHaveLength(2);
              expect(
                execFileSync("git", ["-C", swapped, "rev-parse", "HEAD"], {
                  encoding: "utf8",
                }).trim(),
              ).toBe(sha);
            } else {
              await d.tick();
              await d.tick();
              expect(startRun).toHaveBeenCalledTimes(2);
              expect(s.runtime.provision).toHaveBeenCalledOnce();
              expect(
                vi.mocked(s.runtime.provision).mock.calls[0]?.[3].cwd,
              ).toBe(workspace);
              expect(
                f.state().runs.filter((r) => r.assignment_id === a.id),
              ).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    id: s.run.id,
                    status: "dispatched",
                  }),
                ]),
              );
              expect(events("run_dispatch_aborted")).toEqual([]);
            }
          }
        }
        if (mode === "replaced_at_launch") {
          // A same path, branch and commit replacement is not the original:
          // Ops cannot take over with it, and the original draft stays.
          await opsTakeover();
          await takeoverResult("workspace_placement_changed");
          expect(events("dispatch_stall_backup_verified")).toHaveLength(1);
          await keptOriginal();
          expect(readFileSync(join(kept, "source"), "utf8")).toBe(
            "uncommitted draft",
          );
        }
        if (mode === "shared_at_launch")
          expect(readFileSync(join(workspace, "source"), "utf8")).toBe(
            "tracked edit",
          );
        if (
          ![
            "changed_access_at_launch",
            "shared_at_launch",
            "stopped_at_launch",
          ].includes(mode)
        )
          expect(
            execFileSync(
              "git",
              ["-C", existsSync(kept) ? kept : workspace, "rev-parse", "HEAD"],
              { encoding: "utf8" },
            ).trim(),
          ).toBe(sha);
      } else {
        // The refusal belongs to the patrol; a newly live idle terminal has its
        // own wake path and is not a replacement Session.
        if (mode !== "live_again" && mode !== "live_during_backup")
          await d.tick();
        expect(startRun).not.toHaveBeenCalled();
        if (mode === "finished_group_alive") {
          expect(s.runtime.confirm_local_group_exit).toHaveBeenCalled();
          expect(s.runtime.provision).not.toHaveBeenCalled();
        }
        if (mode === "backup_failure") {
          // The system withdrew before any signal. Once the backup recovers,
          // Ops takes over the same incident and the original queue resumes.
          backupFails = false;
          await opsTakeover();
          await vi.waitFor(
            async () => {
              await service.tick();
              expect(
                events("host_ops_action_finished").filter(
                  (e) => (e.payload as { run_id?: string }).run_id === s.run.id,
                ),
              ).toHaveLength(1);
            },
            { timeout: 10_000 },
          );
          expect(events("host_ops_action_taken")).toMatchObject([
            { actor: { kind: "system" } },
            { actor: { kind: "assignment" } },
          ]);
          expect(events("dispatch_stall_backup_verified")).toHaveLength(1);
          await d.tick();
          expect(startRun).toHaveBeenCalledOnce();
          expect(s.runtime.provision).toHaveBeenCalledOnce();
          expect(s.runtime.retire_idle).not.toHaveBeenCalled();
          expect(s.runtime.release).not.toHaveBeenCalled();
        }
      }
    } finally {
      await d.close();
      await service.close();
    }
  },
  15_000,
);
