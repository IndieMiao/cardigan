import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Assignment,
  createHostOpsAssignment,
  HOST_OPS_ROLE_TOOLS,
} from "@cardigan/domain";
import { HostOpsService } from "@cardigan/host";
import { authenticate, unwrap } from "@cardigan/mcp-server";
import { recordNotification } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { Dispatcher } from "./dispatch.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function setup() {
  const f = recoveryFixture();
  const { store, project, clock } = f;
  store.uow.run((tx) =>
    tx.roles.put(project, {
      role_id: "host_ops",
      role_version: 1,
      allowed_tools: HOST_OPS_ROLE_TOOLS,
      capabilities: [],
    }),
  );
  const ops = f.apply((s, a, p) =>
    createHostOpsAssignment(s, a, {}, p),
  ).assignment;
  const token = store.issueToken({
    project_id: project,
    assignment_id: ops.id,
    role: { role_version: 1, allowed_tools: HOST_OPS_ROLE_TOOLS },
  });
  const context = { identity: unwrap(authenticate(store, token.token)), store };
  const service = new HostOpsService({
    ...f.options,
    contextUsage: { execution: { mode: "local", dataDir: f.dataDir } },
  });
  cleanup.push(async () => {
    await service.close();
    f.close();
  });
  const view = async () =>
    (await service.tools.read(context)) as {
      dispatch_stalls: Array<{
        kind: string;
        cause_id: string;
        can_restart: boolean;
        assignment_id: string;
        workspace: string;
      }>;
    };
  function event(
    type: string,
    payload: Record<string, string>,
    recipient?: "pm_ops" | "pm_office" | Assignment,
  ) {
    return store.uow.run((tx) => {
      const a = typeof recipient === "object" ? recipient : undefined;
      const e = {
        type,
        payload,
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project),
        created_at: clock.now(),
        actor: { kind: "system" as const, project_id: project },
      };
      tx.events.append(project, e);
      if (recipient)
        recordNotification(store.database, {
          project_id: project,
          event_id: e.id,
          seq: e.seq,
          at: e.created_at,
          kind: "assignment",
          recipient: a
            ? { kind: "assignment", assignment_id: a.id }
            : { kind: recipient as "pm_ops" | "pm_office" },
        });
      return e;
    });
  }
  const restart = (target: Assignment, cause: string) =>
    service.tools.execute(
      context,
      target.role_id === "pm"
        ? "host_ops_restart_standing_pm"
        : "host_ops_restart_assignment",
      {
        target_id: target.id,
        reason: "fixture",
        dispatch_stall_id: cause,
        idempotency_key: `recover:${cause}`,
      },
    );
  return { ...f, ops, service, context, view, event, restart };
}

test("guard refusal logs its state once; resume without queue and pending notification become actionable at the threshold", async () => {
  vi.stubEnv("CARDIGAN_DISPATCH_STALL_MS", "600000");
  const f = setup();
  const a = f.target.assignment;
  f.advance(1);
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  vi.mocked(f.runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "alive", agent: "blocked", observed_seq: 1 },
  });
  f.event(
    "work_item_resume_requested",
    { assignment_id: a.id, work_item_id: f.target.item.id },
    a,
  );
  const dispatcher = new Dispatcher(f.options);
  await dispatcher.tick();
  await dispatcher.tick();
  expect(
    info.mock.calls.filter(([s]) => String(s).includes("wake_guard:blocked")),
  ).toHaveLength(1);
  f.advance(599999);
  expect((await f.view()).dispatch_stalls).toEqual([]);
  f.advance(1);
  const rows = (await f.view()).dispatch_stalls;
  expect(rows).toEqual(
    expect.arrayContaining(
      ["resume_not_dispatched", "notification_backlog"].map((kind) =>
        expect.objectContaining({
          kind,
          assignment_id: a.id,
          card_id: f.target.card.id,
          age_ms: 600000,
          terminal_state: "blocked",
          can_restart: true,
        }),
      ),
    ),
  );
  const cause = rows[0]?.cause_id as string;
  await f.restart(a, cause);
  await f.restart(a, cause);
  expect(
    f.state().events.filter((e) => e.type === "host_ops_action_taken"),
  ).toHaveLength(1);
  await dispatcher.close();
});

test("a lost instruction bell remains visible with no notification; dirty files and missing evidence cannot authorize a restart", async () => {
  const f = setup();
  f.advance(1);
  const a = f.target.assignment;
  const e = f.event("instruction_issued", { work_item_id: f.target.item.id });
  f.advance(610000);
  const path = join(f.dataDir, "agent", "worktrees", f.project, a.id);
  const owner = f.state().assignments.find((v) => v.id === a.id) as Assignment;
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, { ...owner, worktree_path: path }),
  );
  expect((await f.view()).dispatch_stalls).toEqual([
    expect.objectContaining({
      cause_id: e.id,
      workspace: "unknown",
      can_restart: false,
    }),
  ]);
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", path]);
  writeFileSync(join(path, "private-name"), "untracked");
  const view = await f.view();
  expect(view.dispatch_stalls).toEqual([
    expect.objectContaining({
      cause_id: e.id,
      workspace: "dirty",
      can_restart: false,
    }),
  ]);
  expect(JSON.stringify(view.dispatch_stalls)).not.toContain("private-name");
  await expect(f.restart(a, e.id)).rejects.toThrow();
  expect(f.runtime.release).not.toHaveBeenCalled();
});

test.each(["ops", "office"] as const)(
  "stopped managed standing PM %s receives the right restart; a new Run clears attention",
  async (mode) => {
    const f = setup();
    const a = { ...f.pm(), standing_mode: mode };
    f.store.uow.run((tx) => tx.assignments.put(f.project, a));
    f.event("fixture", {}, mode === "ops" ? "pm_ops" : "pm_office");
    f.advance(65 * 60_000);
    const [row] = (await f.view()).dispatch_stalls;
    expect(row).toMatchObject({
      kind: "standing_backlog",
      assignment_id: a.id,
      card_id: null,
      age_ms: 65 * 60_000,
      workspace: "no_worktree",
      can_restart: true,
    });
    await f.restart(a, row?.cause_id as string);
    await f.service.tick();
    await vi.waitFor(() =>
      expect(
        f
          .state()
          .runs.some((r) => r.assignment_id === a.id && r.status === "queued"),
      ).toBe(true),
    );
    expect(
      (await f.view()).dispatch_stalls.filter((s) => s.assignment_id === a.id),
    ).toEqual([]);
  },
);

test("patrol supervisor sees its own old pending bell without a host ops Run; once only, PM Office is notified", async () => {
  const f = setup();
  const a = f.ops;
  const ref = f.refFor(a);
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, {
      ...a,
      runtime_ref: ref,
      runtime_state: "idle",
      session_ref: "old",
    }),
  );
  f.event("host_ops_patrol_due", { assignment_id: a.id }, a);
  f.advance(11 * 60000);
  await f.service.tick();
  await vi.waitFor(() =>
    expect(
      f.state().events.some((e) => e.type === "host_ops_action_taken"),
    ).toBe(true),
  );
  await f.service.tick();
  await vi.waitFor(() =>
    expect(
      f
        .state()
        .runs.some((r) => r.assignment_id === a.id && r.status === "queued"),
    ).toBe(true),
  );
  expect(f.runtime.release).toHaveBeenCalledOnce();
  expect(
    f.state().assignments.find((v) => v.id === a.id)?.session_ref,
  ).toBeUndefined();
  await f.service.tick();
  expect(
    f.state().events.filter((e) => e.type === "dispatch_stall_attention"),
  ).toHaveLength(1);
  expect(
    f.state().events.filter((e) => e.type === "host_ops_action_taken"),
  ).toHaveLength(1);
  expect(
    f.store.listNotifications({
      project_id: f.project,
      recipient_kind: "pm_office",
    }),
  ).toHaveLength(1);
});

test("unconfirmed plan feedback points at the author, without guessing from words or requiring a bell", async () => {
  const f = setup();
  const { assignment: a, item, card } = f.target;
  f.advance(1);
  f.store.uow.run((tx) => {
    const v = tx.work_items
      .list(f.project)
      .find((w) => w.card_id === card.id && w.kind === "verify");
    if (v?.kind !== "verify") throw new Error("Missing verifier");
    const reviewer = tx.ids.next(f.project, "assignment");
    const q = tx.ids.next(f.project, "decision");
    const proposal = tx.ids.nextTimelineEntryId(f.project, card.id);
    const reply = tx.ids.nextTimelineEntryId(f.project, card.id);
    tx.work_items.put(f.project, {
      ...v,
      assignment_id: reviewer,
      review_plan_target: q,
    });
    tx.decisions.put(f.project, {
      id: q,
      key: q,
      kind: "choose",
      card_id: card.id,
      trigger: "review_limit",
      status: "resolved",
      raised_by: "system",
      decider: "role:pm",
      category: "general",
      question: "方向",
      context: "fixture",
      doc_refs: [],
      options: [],
      recommended: "change_approach",
      blocking: false,
      affected_cards: [card.id],
      affected_work_items: [v.id],
      review_intervention: {
        producer_id: item.id,
        proposal,
        review_id: tx.ids.next(f.project, "review"),
      },
      resolution: {
        option: "change_approach",
        rationale: "fixture",
        resolved_by: "system",
        via: "system_rule",
        raw_quote: "fixture",
        via_chain: [],
        at: f.clock.now(),
      },
    });
    tx.timeline.put(f.project, {
      id: reply,
      short_id: reply,
      card_id: card.id,
      type: "comment",
      author: `assignment:${reviewer}`,
      reply_to: proposal,
      event_seq: 13,
      refs: [],
      mentions: [],
      retracted: false,
      body: "这处需要调整",
      created_at: f.clock.now(),
    });
  });
  f.advance(10 * 60 * 60_000);
  const [row] = (await f.view()).dispatch_stalls;
  expect(row).toMatchObject({
    kind: "owner_not_woken",
    assignment_id: a.id,
    card_id: card.id,
    age_ms: 10 * 60 * 60_000,
  });
  f.store.uow.run((tx) => {
    const q = tx.decisions.list(f.project)[0];
    if (q?.review_intervention)
      tx.decisions.put(f.project, {
        ...q,
        review_intervention: {
          ...q.review_intervention,
          confirmation: tx.ids.nextTimelineEntryId(f.project, card.id),
        },
      });
  });
  expect((await f.view()).dispatch_stalls).toEqual([]);
});

test("worktree dirtied after an accepted request withdraws it before release, without a stuck fence", async () => {
  const f = setup();
  const a = f
    .state()
    .assignments.find((a) => a.id === f.target.assignment.id) as Assignment;
  const path = join(f.dataDir, "agent", "worktrees", f.project, a.id);
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", path]);
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, { ...a, worktree_path: path }),
  );
  f.advance(1);
  const e = f.event("instruction_issued", { work_item_id: f.target.item.id });
  f.advance(610000);
  await f.restart(a, e.id);
  writeFileSync(join(path, "new"), "uncommitted");
  await f.service.tick();
  await vi.waitFor(() =>
    expect(
      f.state().events.find((ev) => ev.type === "host_ops_action_finished")
        ?.payload,
    ).toMatchObject({ result: "withdrawn_stall_changed" }),
  );
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.state().human_actions).toHaveLength(0);
});
