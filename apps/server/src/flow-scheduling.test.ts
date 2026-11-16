/** C1: real SQLite, commands, dispatcher and merge controller; synthetic IO only. */
import {
  type Assignment,
  acknowledgeRun,
  assign,
  builtinCardTemplateVersions,
  dispatchRun,
  type Employee,
  latestMergeCheck,
  prepareDelivery,
  type Runtime,
  setCardSensitive,
  setProjectPreferences,
  submitDelivery,
  submitReview,
} from "@cardigan/domain";
import type { CheckExecutor, ProjectMergeGate } from "@cardigan/host";
import { unwrap } from "@cardigan/mcp-server";
import { listBellAttempts, Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { createCard } from "../../../packages/domain/src/commands/pm.js";
import { pathEvidence } from "../../../packages/domain/src/commands/system-merge/test-fixtures.js";
import * as flow from "../../../packages/domain/src/flow.js";
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
async function setup(templateVersion = 1, qualified = true, reviewMax = 5) {
  let time = Date.parse("2030-01-01T00:00:00Z");
  const f = m4Fixture({ clock: { now: () => new Date(time).toISOString() } });
  fixtures.push(f);
  f.apply((s, a, p) =>
    setProjectPreferences(s, a, { review_max_rounds: reviewMax }, p),
  );
  // Use the exact built-in template. Never construct an imitation of dev@2.
  const template = required(
    builtinCardTemplateVersions.find(
      (t) => t.id === "dev" && t.version === templateVersion,
    ),
  );
  // Level 5 is not released. Seed its authorization facts only in this
  // isolated database; production registration and preferences stay unchanged.
  const policy = { role_rule_paths: ["AGENTS.md"], release_paths: [] };
  f.store.uow.run((tx) => {
    const pm = required(
      tx.roles.get(f.project_id, { role_id: "pm", role_version: 1 }),
    );
    tx.roles.put(f.project_id, {
      ...pm,
      allowed_tools: [...pm.allowed_tools, "update_work_item"],
    });
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
  // Follow B3b's future-release fixture: relax only the version cap while
  // the real createCard command instantiates the exact immutable template.
  // Restore it before delivery, assignment, review, completion or publication.
  const card = (() => {
    const valid = flow.validFlowVersion;
    const released = vi
      .spyOn(flow, "validFlowVersion")
      .mockImplementation((version) => version === 5 || valid(version));
    try {
      return f.apply((s, a, p) =>
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
    } finally {
      released.mockRestore();
    }
  })();
  expect(card).toMatchObject({
    template: "dev",
    template_version: templateVersion,
    flow_version: 5,
  });
  if (templateVersion === 2) {
    expect(f.state().work_items).toHaveLength(2);
    expect(
      f
        .state()
        .work_items.some(
          (w) => w.role_id === "pm" || w.template_key === "pm_acceptance",
        ),
    ).toBe(false);
  }
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
  let priorRuns: Set<string> | undefined;
  let priorBells: Set<string> | undefined;
  let fromSeq: number | undefined;
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
    priorRuns = new Set(f.state().runs.map((r) => r.id));
    priorBells = new Set(
      listBellAttempts(f.store.database, f.project_id).map((b) => b.id),
    );
    const product = f.apply(
      (s, a, p) => submitDelivery(s, a, params, proof, p),
      f.actorFor(coder),
    );
    fromSeq = required(
      f
        .state()
        .events.find(
          (e) =>
            e.type === "delivery_submitted" &&
            (e.payload as { delivery_id?: string }).delivery_id === product.id,
        ),
    ).seq;
    return product;
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
          n.seq >= required(fromSeq) &&
          (n.recipient.kind === "pm_ops" ||
            (n.recipient.kind === "assignment" &&
              n.recipient.assignment_id === ops.id)),
      );
  const opsRuns = () =>
    f
      .state()
      .runs.filter(
        (r) => r.assignment_id === ops.id && !required(priorRuns).has(r.id),
      );
  const opsBells = () =>
    listBellAttempts(f.store.database, f.project_id).filter(
      (b) => b.assignment_id === ops.id && !required(priorBells).has(b.id),
    );
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
    opsBells,
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
  const reviewer = s.owner(required(s.f.item(s.verify.id).assignment_id));
  expect(reviewer).toMatchObject({
    role_id: "reviewer",
    employee_id: "E-2",
    work_item_id: s.verify.id,
  });
  expect(
    s.f
      .state()
      .events.filter(
        (e) =>
          e.type === "work_item_assigned" &&
          (e.payload as { work_item_id?: string }).work_item_id === s.verify.id,
      ),
  ).toMatchObject([
    {
      actor: { kind: "system" },
      payload: { delivery_id: product.id, assignment_id: reviewer.id },
    },
  ]);
  const merge = mergeController(s);
  await merge.loop.tick();
  expect(merge.checkExecutor.dispatch).not.toHaveBeenCalled();
  expect(s.f.state().deliveries.some((d) => d.kind === "card_completion")).toBe(
    false,
  );
  const completion = await s.pass(product);
  expect(
    s.f
      .state()
      .work_items.filter((w) => w.required && w.kind === "verify")
      .every((w) => w.status === "passed"),
  ).toBe(true);
  expect(
    s.f.state().reviews.filter((r) => r.delivery_id === product.id),
  ).toMatchObject([
    {
      verdict: "pass",
      work_item_id: s.verify.id,
      target_sha: product.subject.value,
    },
  ]);
  if (templateVersion === 2) {
    expect(completion.requested_verifiers).toEqual([]);
    expect(
      s.f.state().reviews.filter((r) => r.delivery_id === completion.id),
    ).toEqual([]);
    expect(
      s.f
        .state()
        .events.find(
          (e) =>
            e.type === "delivery_submitted" &&
            (e.payload as { delivery_id?: string }).delivery_id ===
              completion.id,
        ),
    ).toMatchObject({ actor: { kind: "system" } });
  }
  await merge.loop.tick();
  await merge.loop.tick();
  await s.replay();
  expect(merge.errors).not.toHaveBeenCalled();
  expect(merge.checkExecutor.dispatch).toHaveBeenCalledTimes(1);
  expect(
    latestMergeCheck(s.f.state().events, s.card.id, completion.id),
  ).toMatchObject({ status: "passed" });
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
  expect(s.opsBells()).toEqual([]);
  expect(
    s.f.state().runs.filter((r) => r.assignment_id === reviewer.id),
  ).toHaveLength(1);
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
test.each([false, true])(
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
      2,
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
      const historicalRun = required(
        s.f.state().runs.findLast((r) => r.assignment_id === reviewer.id),
      );
      s.f.store.uow.run((tx) => {
        const item = required(tx.work_items.get(s.f.project_id, s.verify.id));
        tx.work_items.put(s.f.project_id, {
          ...item,
          max_review_rounds: 4,
        } as never);
        for (let n = 0; n < 3; n++) {
          const deliveryId = tx.ids.next(s.f.project_id, "delivery");
          tx.deliveries.put(s.f.project_id, {
            ...product,
            id: deliveryId,
            status: "superseded",
          });
          const historyRunId = tx.ids.next(s.f.project_id, "run");
          const trigger = tx.ids.nextEventId();
          tx.events.append(s.f.project_id, {
            id: trigger,
            seq: tx.ids.nextEventSequence(s.f.project_id, s.card.id),
            card_id: s.card.id,
            type: "historical_review_imported",
            actor: { kind: "system", project_id: s.f.project_id },
            payload: {},
            created_at: s.f.clock.now(),
          });
          tx.runs.put(s.f.project_id, {
            ...historicalRun,
            id: historyRunId,
            trigger_event_id: trigger,
            status: "completed",
            outcome: "completed",
            finished_at: s.f.clock.now(),
          });
          tx.reviews.put(s.f.project_id, {
            id: tx.ids.next(s.f.project_id, "review"),
            delivery_id: deliveryId,
            target_sha: product.subject.value,
            work_item_id: item.id,
            run_id: historyRunId,
            kind: "code",
            verdict: "reject",
            blocking: true,
            recheck_required: false,
            issues: [
              {
                severity: "major",
                description: "Synthetic fix",
                must_fix: true,
                pre_existing: false,
              },
            ],
            attachments: [],
          });
        }
      });
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
        "review limit": "decision_requested",
        "inactive producer": "run_inactive",
        "unreachable executor": "merge_check_finished",
      }[failure],
    );
    if (failure !== "unreachable executor" && failure !== "review limit")
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
    const s = await setup(2);
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
