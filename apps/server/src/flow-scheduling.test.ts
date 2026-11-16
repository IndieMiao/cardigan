/** C1: real SQLite, commands, dispatcher and merge controller; synthetic IO only. */
import {
  type Assignment,
  acknowledgeRun,
  assign,
  builtinCardTemplates,
  createCard,
  dispatchRun,
  type Employee,
  prepareDelivery,
  type Runtime,
  setCardSensitive,
  setProjectPreferences,
  submitDelivery,
  submitReview,
} from "@cardigan/domain";
import type { CheckExecutor, ProjectMergeGate } from "@cardigan/host";
import { unwrap } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { pathEvidence } from "../../../packages/domain/src/commands/system-merge/test-fixtures.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";
import { type M4Fixture, m4Fixture } from "./m4-fixtures.js";
import { MergeExecutor } from "./merge-loop.js";
import { needsYou } from "./web/read.js";

const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
};
const fixtures: M4Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
const dev2 = builtinCardTemplates.find(
  (t) => t.id === "dev" && t.version === 2,
);

async function setup(templateVersion = 1, qualified = true, reviewMax = 5) {
  let time = Date.parse("2030-01-01T00:00:00Z");
  const f = m4Fixture({ clock: { now: () => new Date(time).toISOString() } });
  fixtures.push(f);
  f.apply((s, a, p) =>
    setProjectPreferences(s, a, { review_max_rounds: reviewMax }, p),
  );
  // Use the exact built-in template. Never construct an imitation of dev@2.
  const template = required(
    builtinCardTemplates.find(
      (t) => t.id === "dev" && t.version === templateVersion,
    ),
  );
  const card = f.apply((s, a, p) =>
    createCard(
      s,
      a,
      {
        title: "Synthetic scheduling contract",
        goal: "Delivery through merge",
        acceptance_criteria: ["Reviewed and merged"],
        repo: "synthetic/repo",
        base_branch: "main",
        source: { kind: "quote", text: "Synthetic scheduling contract" },
      },
      { ...p, templates: [template] },
    ),
  );
  // Level 5 is not released. Seed only the future version/authorization facts
  // in this isolated database; all workflow transitions below use commands.
  const policy = { role_rule_paths: ["AGENTS.md"], release_paths: [] };
  f.store.uow.run((tx) => {
    tx.cards.put(f.project_id, { ...card, flow_version: 5 });
    tx.project_preferences.put(f.project_id, {
      id: f.project_id,
      auto_merge_after_minutes: null,
      flow_version: 5,
      system_auto_assign_verifiers: false,
      review_max_rounds: reviewMax,
      system_merge_shadow_policy: policy,
    });
    for (const [preference, new_value] of [
      ["flow_version", 5],
      ["system_merge_shadow_policy", policy],
    ] as const)
      tx.events.append(f.project_id, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(f.project_id),
        actor: f.human,
        type: "project_preferences_updated",
        created_at: f.clock.now(),
        payload: { preference, new_value },
      });
    for (const [n, role_id] of [
      [1, "coder"],
      [2, "reviewer"],
      [3, "pm"],
    ] as const) {
      if (!qualified && role_id === "reviewer") continue;
      tx.employees.put({
        id: `E-${n}`,
        name: `Synthetic ${n}`,
        title: role_id,
        bio: "",
        avatar: null,
        role_id,
        launch_profile_ref: null,
        status: "active",
        created_at: f.clock.now(),
        updated_at: f.clock.now(),
      } as Employee);
    }
  });
  const produce = required(
    f.state().work_items.find((w) => w.kind === "produce"),
  );
  const verify = required(
    f.state().work_items.find((w) => w.target_work_item_id === produce.id),
  );
  const coder = f.apply((s, a, p) =>
    assign(
      s,
      a,
      {
        work_item_id: produce.id,
        role_id: "coder",
        employee_id: "E-1" as Employee["id"],
      },
      p,
    ),
  );
  const ops: Assignment = f.store.uow.run((tx) => {
    const owner: Assignment = {
      id: tx.ids.next(f.project_id, "assignment"),
      scope: "standing",
      standing_mode: "ops",
      role_id: "pm",
      role_version: 1,
      status: "active",
      runtime_state: "not_provisioned",
      machine_id: "local",
      runtime_ref: null,
      mcp_token_id: "synthetic-ops",
      created_at: f.clock.now(),
    };
    tx.assignments.put(f.project_id, owner);
    return owner;
  });
  const runtime: Runtime = {
    status: vi.fn<Runtime["status"]>(async () => ({
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    })),
    wake: vi.fn<Runtime["wake"]>(async () => ({
      ok: true,
      value: { sent: true },
    })),
    provision: vi.fn(),
    release: vi.fn(),
    interrupt: vi.fn(),
    resume_or_replace: vi.fn(),
    human_entry: vi.fn(),
  };
  const startRun: DispatcherOptions["startRun"] = vi.fn(
    async ({ run, assignment }) => {
      f.apply((s, a, p) =>
        dispatchRun(
          s,
          a,
          {
            run_id: run.id,
            runtime_ref: {
              machine_id: "local",
              runtime_machine: "local",
              terminal_ref: assignment.id,
              agent_name: assignment.id,
            },
          },
          p,
        ),
      );
      f.apply(
        (s, a, p) => acknowledgeRun(s, a, { run_id: run.id }, p),
        f.actorFor(assignment),
      );
    },
  );
  const options: DispatcherOptions = {
    store: f.store,
    runtime,
    clock: f.clock,
    standing: (_project, kind) => (kind === "pm_ops" ? ops.id : undefined),
    snapshot: async () => ({
      model: "synthetic",
      agent_cli_version: "synthetic",
    }),
    startRun,
  };
  let dispatcher = new Dispatcher(options);
  const ack = (a: Assignment) =>
    f.store.ackEvents({
      project_id: f.project_id,
      assignment_id: a.id,
      card_id: card.id,
      up_to_seq: f.store.getUpdates({
        project_id: f.project_id,
        card_id: card.id,
      }).latest_seq,
    });
  const finish = (a: Assignment) => {
    ack(a);
    f.endRun(a);
  };
  // Planning really reaches a live Ops before the measured delivery interval.
  await dispatcher.tick();
  expect(f.state().runs.some((r) => r.assignment_id === ops.id)).toBe(true);
  finish(ops);
  await dispatcher.tick();
  const priorRuns = new Set(f.state().runs.map((r) => r.id));
  const fromSeq =
    f.store.getUpdates({ project_id: f.project_id, card_id: card.id })
      .latest_seq + 1;
  f.startRun(coder);
  const deliver = async (paths?: string[]) => {
    const params = {
      work_item_id: produce.id,
      kind: "code" as const,
      summary: "Synthetic change",
      subject: { kind: "git_head" as const, value: "a".repeat(40) },
      requested_verifiers: [verify.id],
      plain_summary: {
        changed: "更新测试内容",
        impact: "保持既有使用方式",
        risk: "无",
      },
    };
    const proof = unwrap(
      await prepareDelivery(f.state(), f.actorFor(coder), params, {
        verify: async () => ({ ok: true, value: pathEvidence(paths) }),
      }),
    );
    return f.apply(
      (s, a, p) => submitDelivery(s, a, params, proof, p),
      f.actorFor(coder),
    );
  };
  const owner = (id: string) =>
    required(f.state().assignments.find((a) => a.id === id));
  const tick = () => dispatcher.tick();
  const replay = async () => {
    // A second SQLite connection plus a new dispatcher exercises durable
    // cursors and notifications, not the first instance's in-memory caches.
    const reopened = Store.open({ dataDir: f.dataDir });
    try {
      await new Dispatcher({ ...options, store: reopened }).tick();
    } finally {
      reopened.close();
    }
    dispatcher = new Dispatcher(options);
    await dispatcher.tick();
  };
  const opsNotes = () =>
    f.store
      .listNotifications({ project_id: f.project_id })
      .filter(
        (n) =>
          n.card_id === card.id &&
          n.seq >= fromSeq &&
          (n.recipient.kind === "pm_ops" ||
            (n.recipient.kind === "assignment" &&
              n.recipient.assignment_id === ops.id)),
      );
  const opsRuns = () =>
    f
      .state()
      .runs.filter((r) => r.assignment_id === ops.id && !priorRuns.has(r.id));
  const pass = async (product: Awaited<ReturnType<typeof deliver>>) => {
    const reviewer = owner(required(f.item(verify.id).assignment_id));
    expect(
      f
        .state()
        .runs.some(
          (r) => r.assignment_id === reviewer.id && r.status === "running",
        ),
    ).toBe(true);
    f.review(reviewer, product);
    finish(reviewer);
    await tick();
    const completion = required(
      f.state().deliveries.find((v) => v.kind === "card_completion"),
    );
    expect(completion.system_completion).toBeDefined();
    for (const verifier of completion.requested_verifiers) {
      const a = owner(required(f.item(verifier).assignment_id));
      f.review(a, completion);
      finish(a);
    }
    await tick();
    return completion;
  };
  return {
    f,
    card,
    produce,
    verify,
    coder,
    ops,
    deliver,
    finish,
    ack,
    tick,
    replay,
    owner,
    pass,
    opsNotes,
    opsRuns,
    advance: (ms: number) => {
      time += ms;
    },
    startRun,
  };
}

function mergeController(
  s: Awaited<ReturnType<typeof setup>>,
  unreachable = false,
) {
  const { f } = s;
  let baseline = "b".repeat(40);
  const checkExecutor: CheckExecutor = {
    dispatch: vi.fn(async (request) => {
      request.onReady?.();
      return { id: "synthetic-check" };
    }),
    poll: vi.fn<CheckExecutor["poll"]>(async () => ({
      status: unreachable ? "executor_unreachable" : "passed",
      checks: unreachable
        ? []
        : [{ name: "test", status: "passed", exit_code: 0 }],
      cleanup_errors: [],
    })),
    cancel: vi.fn(async () => {}),
    fetchFailureLog: vi.fn(async () => ""),
  };
  const published = vi.fn();
  const errors = vi.fn();
  const settings: ProjectMergeGate = {
    status: "enabled",
    checks: [{ name: "test", run: "synthetic" }],
    env: {},
    totalTimeoutMs: 1000,
    executor: {
      name: "synthetic-ci",
      host: "synthetic",
      port: 22,
      user: "synthetic",
      hostKeyAlias: "synthetic",
      identityFile: "/synthetic/key",
      knownHostsFile: "/synthetic/hosts",
      agentRoot: "/synthetic",
      maxConcurrent: 1,
    },
  };
  const loop = new MergeExecutor({
    store: f.store,
    clock: f.clock,
    onError: errors,
    git: {
      projectOf: () => ({
        project_id: f.project_id,
        source_repo: "synthetic",
        base_branch: "main",
      }),
      sync: async () => "up_to_date",
      merge: async () => {
        throw new Error("Expected guarded publication");
      },
      baseline: async () => baseline,
      prepare: async () => ({
        status: "candidate",
        candidate_sha: "d".repeat(40),
        tree_sha: "c".repeat(40),
        previous_sha: baseline,
      }),
      publish: async (_p, _completion, candidate, guard) =>
        guard(() => {
          published();
          baseline = candidate.candidate_sha;
        })
          ? {
              status: "merged",
              merge_sha: candidate.candidate_sha,
              previous_sha: candidate.previous_sha,
              tree_sha: candidate.tree_sha,
            }
          : { status: "stale" },
      distribute: async () => {},
      changedPaths: async () => [],
    },
    gate: {
      configuration: { errors: [], forProject: () => settings },
      execution: { mode: "local", dataDir: f.dataDir },
      checkExecutor,
      sweep: async () => {},
      recover: async (_execution, request) => {
        request.confirmAbsence();
        return { status: "cleaned", reason: "complete", processes: [] };
      },
    },
  });
  return { loop, published, errors, checkExecutor };
}

async function normal(templateVersion: number, enabled: boolean) {
  const s = await setup(templateVersion);
  s.f.apply((state, a, p) =>
    setProjectPreferences(
      state,
      a,
      { system_auto_assign_verifiers: enabled },
      p,
    ),
  );
  const product = await s.deliver();
  s.finish(s.coder);
  await Promise.all([s.tick(), s.tick()]);
  const completion = await s.pass(product);
  expect(
    s.f
      .state()
      .work_items.filter((w) => w.required && w.kind === "verify")
      .every((w) => w.status === "passed"),
  ).toBe(true);
  const merge = mergeController(s);
  await merge.loop.tick();
  await merge.loop.tick();
  await s.replay();
  expect(merge.errors).not.toHaveBeenCalled();
  expect(merge.published).toHaveBeenCalledTimes(1);
  expect(s.f.card().status).toBe("done");
  expect(
    s.f.state().events.filter((e) => e.type === "card_merged"),
  ).toHaveLength(1);
  expect(
    s.f
      .state()
      .timeline.some(
        (t) =>
          t.event_seq ===
          s.f.state().events.find((e) => e.type === "card_merged")?.seq,
      ),
  ).toBe(true);
  expect(
    s.f.state().decisions.find((q) => q.trigger === "merge_confirmation"),
  ).toMatchObject({
    decider: "system",
    status: "resolved",
    resolution: { resolved_by: "system" },
  });
  expect(s.opsNotes()).toEqual([]);
  expect(s.opsRuns()).toEqual([]);
  expect(
    s.f.state().deliveries.filter((v) => v.kind === "card_completion"),
  ).toHaveLength(1);
  expect(completion.system_completion?.products).toMatchObject([
    { delivery_id: product.id },
  ]);
}

test.each([false, true])(
  "C1 dev@1 future-flow integration has zero Ops Runs from delivery to guarded merge (switch=%s)",
  async (enabled) => normal(1, enabled),
);
// C-359 is an explicit dependency: report this skip until its real built-in ships.
test.skipIf(!dev2).each([false, true])(
  "C1 official dev@2 delivery-to-merge has zero Ops Runs (switch=%s)",
  async (enabled) => normal(2, enabled),
);

test.each([
  "no employee",
  "D6 missing review",
  "review limit",
  "inactive producer",
  "unreachable executor",
] as const)(
  "C1 %s creates one durable exception notification, including replay",
  async (failure) => {
    const s = await setup(
      1,
      failure !== "no employee",
      failure === "review limit" ? 1 : 5,
    );
    const product = await s.deliver(
      failure === "D6 missing review"
        ? [".github/workflows/check.yml"]
        : undefined,
    );
    if (failure !== "inactive producer") s.finish(s.coder);
    await s.tick();
    if (failure === "review limit") {
      const reviewer = s.owner(required(s.f.item(s.verify.id).assignment_id));
      s.f.apply(
        (state, a, p) =>
          submitReview(
            state,
            a,
            {
              delivery_id: product.id,
              target_sha: product.subject.value,
              kind: "code",
              issues: [
                {
                  severity: "major",
                  description: "Synthetic fix",
                  must_fix: true,
                  pre_existing: false,
                },
              ],
            },
            p,
          ),
        s.f.actorFor(reviewer),
      );
      s.ack(reviewer);
      await s.tick();
    }
    if (failure === "inactive producer") {
      // Only the producer remains active: finish the actual reviewer first.
      await s.pass(product);
      s.advance(15 * 60_000);
      await s.tick();
    }
    if (failure === "unreachable executor") {
      await s.pass(product);
      const merge = mergeController(s, true);
      await merge.loop.tick();
      expect(merge.published).not.toHaveBeenCalled();
      await s.tick();
    }
    await s.replay();
    expect(s.opsNotes()).toHaveLength(1);
    const note = required(s.opsNotes()[0]);
    const source = required(
      s.f.state().events.find((e) => e.id === note.event_id),
    );
    expect(source.card_id).toBe(s.card.id);
    expect(source.type).toBe(
      {
        "no employee": "system_assignment_deferred",
        "D6 missing review": "auto_risk_tags_applied",
        "review limit": "review_limit_auto_raise_exhausted",
        "inactive producer": "run_inactive",
        "unreachable executor": "merge_check_finished",
      }[failure],
    );
    if (failure !== "unreachable executor")
      expect(source.payload).toMatchObject({
        delivery_id: product.id,
        work_item_id:
          failure === "no employee" || failure === "review limit"
            ? s.verify.id
            : s.produce.id,
      });
    expect(s.opsRuns()).toHaveLength(1);
  },
);

test.each(["paused", "sensitive"] as const)(
  "C1 zero mechanical Ops work preserves the %s merge gate",
  async (hold) => {
    const s = await setup();
    if (hold === "paused")
      s.f.apply((state, a, p) =>
        setProjectPreferences(state, a, { auto_merge_paused: true }, p),
      );
    else
      s.f.apply((state, a, p) =>
        setCardSensitive(state, a, { card_id: s.card.id, sensitive: true }, p),
      );
    const product = await s.deliver();
    s.finish(s.coder);
    await s.tick();
    await s.pass(product);
    const merge = mergeController(s);
    await merge.loop.tick();
    await merge.loop.tick();
    await s.replay();
    expect(merge.published).not.toHaveBeenCalled();
    expect(s.f.card().status).toBe("awaiting_merge");
    if (hold === "sensitive")
      expect(needsYou(s.f.state(), s.f.clock.now()).decisions).toHaveLength(1);
    expect(s.opsRuns()).toEqual([]);
  },
);
