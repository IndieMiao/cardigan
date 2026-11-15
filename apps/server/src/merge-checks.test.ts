import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitPublicationGuard } from "@cardigan/domain";
import {
  completeHumanAction,
  latestMergeCheck,
  listNeedsYou,
  prepareMergePlan,
  prepareRecheck,
  recheckMerge,
  recordMergeCheck,
  requestHumanAction,
  requestRecheck,
} from "@cardigan/domain";
import type { CentralProject, PreparedMerge } from "@cardigan/git-service";
import {
  acquireMergeCheckCapacity,
  CHECKOUT_LIMITS,
  type CheckExecutor,
  type CheckHandle,
  type CheckoutInput,
  type CheckoutResult,
  CheckRecovery,
  type CheckRequest,
  ExecutorPreparationError,
  loadMergeGateConfig,
  type ProjectMergeGate,
  runCapacitySnapshot,
  type sweepCheckoutOrphans,
} from "@cardigan/host";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import { routeEvent } from "@cardigan/router";
import type { recoverCheckDirectory } from "@cardigan/runtime-herdr";
import { CheckHandoffs } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { recheckVerifier } from "../../../packages/domain/src/commands/request-recheck/test-fixtures.js";
import { value } from "../../../packages/domain/src/commands/test-fixtures.js";
import { seedReturnedRecheck } from "../../../packages/mcp-server/test-support/request-recheck.js";
import {
  acceptThroughMergeGate,
  type M4Fixture,
  m4Fixture,
  m4Scenario,
  mergeConfirmation,
} from "./m4-fixtures.js";
import { MergeChecks } from "./merge-checks.js";
import { MergeExecutor, startMergeLoop } from "./merge-loop.js";
import { cardDetail, needsYou } from "./web/read.js";

const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
};
const fixtures: M4Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.reverse()) f.close();
  fixtures.length = 0;
});
const passed: CheckoutResult = {
  status: "passed",
  checks: [{ name: "test", status: "passed", exit_code: 0 }],
  cleanup_errors: [],
};
async function fixture(
  policy: "auto" | "confirm" = "confirm",
  options: Parameters<typeof m4Fixture>[0] = {},
) {
  const f = m4Fixture(options);
  fixtures.push(f);
  const scenario = m4Scenario(f, policy);
  const { completion } = await acceptThroughMergeGate(
    f,
    scenario,
    "a".repeat(40),
  );
  const check = () =>
    latestMergeCheck(f.state().events, scenario.card.id, completion.id);
  return { f, scenario, completion, check };
}
function controller(f: M4Fixture) {
  let base = "a".repeat(40),
    tree = "c".repeat(40),
    sha = "b".repeat(40);
  let settings: ProjectMergeGate = {
    status: "enabled",
    checks: [{ name: "test", run: "true" }],
    env: { SECRET: "fixture-secret" },
    totalTimeoutMs: 1000,
  };
  const run = vi.fn(async (input: CheckoutInput) => {
    input.onReady?.();
    return passed;
  });
  const git = {
    projectOf: (id: string) => ({
      project_id: id,
      source_repo: "fixture",
      base_branch: "main",
    }),
    sync: vi.fn(async () => "up_to_date" as const),
    merge: vi.fn(async () => {
      throw new Error("Legacy merge must not be used");
    }),
    baseline: vi.fn(async () => base),
    prepare: vi.fn(
      async (): Promise<PreparedMerge> => ({
        status: "candidate",
        candidate_sha: sha,
        tree_sha: tree,
        previous_sha: base,
      }),
    ),
    publish: vi.fn(
      async (
        _project: CentralProject,
        _completion: string,
        candidate: Extract<PreparedMerge, { status: "candidate" }>,
        guard: GitPublicationGuard,
      ) => {
        if (
          !guard(() => {
            base = candidate.candidate_sha;
          })
        )
          return { status: "stale" as const };
        return {
          status: "merged" as const,
          merge_sha: candidate.candidate_sha,
          tree_sha: candidate.tree_sha,
          previous_sha: candidate.previous_sha,
        };
      },
    ),
    distribute: vi.fn(async () => {}),
    changedPaths: vi.fn(
      async (): Promise<readonly string[]> => ["docs/guide.md"],
    ),
    readWorkspace: vi.fn(async () => [
      { dir: "packages/store", name: "@cardigan/store", dependencies: [] },
      {
        dir: "apps/server",
        name: "@cardigan/server",
        dependencies: ["@cardigan/store"],
      },
      { dir: "apps/web", name: "@cardigan/web", dependencies: [] },
      {
        dir: "apps/bad;exit",
        name: "@cardigan/bad",
        dependencies: ["@cardigan/store"],
      },
    ]),
  };
  const errors = vi.fn();
  const notices = vi.fn();
  const options = {
    recoveryInspectionIntervalMs: 60_000,
    sweep: vi.fn<typeof sweepCheckoutOrphans>(async () => {}),
    recover: vi.fn<typeof recoverCheckDirectory>(
      async (_execution, request) => {
        request.confirmAbsence();
        return { status: "cleaned", reason: "complete", processes: [] };
      },
    ),
    store: f.store,
    execution: { mode: "local" as const, dataDir: f.dataDir },
    git,
    run,
    clock: f.clock,
    onError: errors,
    report: notices,
    configuration: { errors: [], forProject: () => settings },
  };
  const gate = new MergeChecks(options);
  return {
    gate,
    git,
    run,
    errors,
    notices,
    options,
    setConfig: (value: ProjectMergeGate) => {
      settings = value;
    },
    advance: (differentTree = false) => {
      base = "d".repeat(40);
      sha = "e".repeat(40);
      if (differentTree) tree = "f".repeat(40);
    },
  };
}

test("checks precede confirmation; a passed tree publishes only after human approval", async () => {
  const { f, check, scenario } = await fixture();
  const c = controller(f);
  await c.gate.tick([f.project_id]);
  expect(check()?.status).toBe("passed");
  expect(check()).not.toHaveProperty("scope");
  expect(c.git.changedPaths).not.toHaveBeenCalled();
  expect(c.git.readWorkspace).not.toHaveBeenCalled();
  expect(c.git.publish).not.toHaveBeenCalled();
  await c.gate.tick([f.project_id]);
  expect(c.run).toHaveBeenCalledTimes(1);
  expect(c.git.prepare).toHaveBeenCalledTimes(1);
  f.decide(required(mergeConfirmation(f, scenario.card.id)), "merge");
  await c.gate.tick([f.project_id]);
  expect(f.card().status).toBe("done");
  expect(c.git.publish).toHaveBeenCalledTimes(1);
  expect(c.errors).not.toHaveBeenCalled();
});

test("C-112: a read-only human action leaves the check running; a merge-blocking one is logged once with its id", async () => {
  const { f, check, scenario } = await fixture();
  const ask = (blocks_merge: boolean) =>
    f.apply((s, a, p) =>
      requestHumanAction(
        s,
        a,
        {
          card_id: scenario.card.id,
          instructions: "请查看主机日志",
          why_human: "只有主机能看",
          expected_return: "日志摘要",
          blocked_work_items: [],
          ...(blocks_merge ? { blocks_merge } : {}),
        },
        p,
      ),
    );
  ask(false);
  const c = controller(f);
  await c.gate.tick([f.project_id]);
  expect(check()?.status).toBe("passed");
  expect(c.errors).not.toHaveBeenCalled();
  const blocking = ask(true);
  await c.gate.tick([f.project_id]);
  await c.gate.tick([f.project_id]);
  const messages = c.notices.mock.calls
    .map((call) => String(call[0]))
    .filter((m) => m.includes("merge checks skipped"));
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain(
    `merge checks skipped ${f.project_id}/${scenario.card.id}`,
  );
  expect(messages[0]).toContain(blocking.id);
});

test("C-112: a passed check whose publication is held logs the confirmed plan's reason once", async () => {
  const { f, check, scenario } = await fixture();
  const c = controller(f);
  f.decide(required(mergeConfirmation(f, scenario.card.id)), "hold");
  await c.gate.tick([f.project_id]);
  expect(check()?.status).toBe("passed");
  await c.gate.tick([f.project_id]);
  await c.gate.tick([f.project_id]);
  expect(c.git.publish).not.toHaveBeenCalled();
  expect(
    f.state().events.filter((e) => e.type === "merge_check_blocked"),
  ).toEqual([]);
  const messages = c.notices.mock.calls.map((call) => String(call[0]));
  expect(messages).toEqual([
    `[${f.clock.now()}] merge checks publish skipped ${f.project_id}/${scenario.card.id}: illegal_transition: Merge confirmation has not been granted for this completion`,
  ]);
});

test("C-178: blocked checks persist one timeline entry across executor restart, then one release", async () => {
  const { f, scenario, check } = await fixture();
  const h = f.apply((s, a, p) =>
    requestHumanAction(
      s,
      a,
      {
        card_id: scenario.card.id,
        instructions: "轮换合并凭据",
        why_human: "需人执行",
        expected_return: "完成",
        blocked_work_items: [],
        blocks_merge: true,
      },
      p,
    ),
  );
  const c = controller(f);
  await c.gate.tick([f.project_id]);
  await c.gate.tick([f.project_id]);
  const restarted = new MergeChecks(c.options);
  await restarted.tick([f.project_id]);
  expect(check()).toBeUndefined();
  expect(c.run).not.toHaveBeenCalled();
  const blocked = f
    .state()
    .events.filter((e) => e.type === "merge_check_blocked");
  expect(blocked).toHaveLength(1);
  const detail = cardDetail(f.state(), scenario.card.id);
  expect(detail?.card.merge_check_blockers).toMatchObject([
    { label: h.id, detail: "轮换合并凭据", started_at: f.clock.now() },
  ]);
  expect(
    detail?.timeline.find((t) => t.event_type === "merge_check_blocked"),
  ).toMatchObject({
    type: "system",
    merge_check_blocker: { label: h.id },
  });
  f.apply((s, a, p) =>
    completeHumanAction(s, a, { human_action_id: h.id, text: "完成" }, p),
  );
  await restarted.tick([f.project_id]);
  await restarted.tick([f.project_id]);
  expect(check()?.status).toBe("passed");
  expect(
    f.state().events.filter((e) => e.type === "merge_check_unblocked"),
  ).toHaveLength(1);
  expect(
    cardDetail(f.state(), scenario.card.id)?.card.merge_check_blockers,
  ).toBeUndefined();
});

test("C-178: invalid configuration has a safe persistent reason until repaired", async () => {
  const { f, scenario } = await fixture();
  const c = controller(f);
  c.setConfig({
    status: "invalid",
    reason: "private configuration diagnostic",
  });
  await c.gate.tick([f.project_id]);
  await c.gate.tick([f.project_id]);
  const detail = cardDetail(f.state(), scenario.card.id);
  expect(detail?.card.merge_check_blockers).toMatchObject([
    { label: "合并闸门配置" },
  ]);
  expect(JSON.stringify(detail)).not.toContain(
    "private configuration diagnostic",
  );
  expect(
    f.state().events.filter((e) => e.type === "merge_check_blocked"),
  ).toHaveLength(1);
  expect(c.run).not.toHaveBeenCalled();
  c.setConfig({
    status: "enabled",
    checks: [{ name: "test", run: "true" }],
    env: {},
    totalTimeoutMs: 1000,
  });
  await c.gate.tick([f.project_id]);
  expect(
    f.state().events.filter((e) => e.type === "merge_check_unblocked"),
  ).toHaveLength(1);
  expect(c.run).toHaveBeenCalledTimes(1);
});

test("failure holds the baseline, redacts output and waits for explicit recheck", async () => {
  const { f, check, scenario } = await fixture("auto");
  const c = controller(f);
  c.run.mockImplementationOnce(async (input) => {
    input.onReady?.();
    input.onOutput?.("test", "FAIL fixture-secret\n");
    return {
      status: "failed",
      checks: [{ name: "test", status: "failed", exit_code: 1 }],
      cleanup_errors: [],
    };
  });
  await c.gate.tick([f.project_id]);
  const failed = required(check());
  expect(failed.status).toBe("failed");
  expect(failed.summary).toContain("[REDACTED]");
  expect(
    await readFile(
      join(
        f.dataDir,
        "merge-gate",
        "logs",
        f.project_id,
        required(failed.log_ref),
      ),
      "utf8",
    ),
  ).not.toContain("fixture-secret");
  await c.gate.tick([f.project_id]);
  expect(c.run).toHaveBeenCalledTimes(1);
  expect(c.git.publish).not.toHaveBeenCalled();
  f.apply((s, a, p) =>
    recheckMerge(
      { ...s, project_settings: { merge_gate_enabled: true } },
      a,
      { card_id: scenario.card.id },
      p,
    ),
  );
  await c.gate.tick([f.project_id]);
  expect(check()?.attempt_id).not.toBe(failed.attempt_id);
  expect(f.card().status).toBe("done");
  expect(c.run).toHaveBeenCalledTimes(2);
});

test.each([false, true])(
  "baseline changes reuse only the same tree (different=%s)",
  async (different) => {
    const { f, scenario } = await fixture();
    const c = controller(f);
    await c.gate.tick([f.project_id]);
    c.advance(different);
    f.decide(required(mergeConfirmation(f, scenario.card.id)), "merge");
    await c.gate.tick([f.project_id]);
    expect(c.run).toHaveBeenCalledTimes(different ? 2 : 1);
    expect(c.git.publish.mock.calls[0]?.[2]).toMatchObject({
      candidate_sha: "e".repeat(40),
      tree_sha: (different ? "f" : "c").repeat(40),
    });
    expect(f.card().status).toBe("done");
  },
);

test("the whole cross-project queue is persisted and ordered by completion-review time", async () => {
  const { f: later } = await fixture("auto", {
    project_id: "a-later",
    clock: { now: () => "2030-01-02T00:00:00.000Z" },
  });
  const { f: earlier } = await fixture("auto", {
    project_id: "z-earlier",
    dataDir: later.dataDir,
  });
  const c = controller(later),
    order: string[] = [];
  c.run.mockImplementation(async (input) => {
    order.push(input.project);
    if (order.length === 1)
      expect(
        later.state().events.some((e) => e.type === "merge_check_queued"),
      ).toBe(true);
    input.onReady?.();
    return passed;
  });
  await c.gate.tick([later.project_id, earlier.project_id]);
  expect(order).toEqual([earlier.project_id, later.project_id]);
  expect(c.run.mock.calls.every(([input]) => input.serialize)).toBe(true);
});

test("shutdown interrupts the active check; restart queues a new attempt without publishing twice", async () => {
  const { f, check } = await fixture("auto");
  const c = controller(f);
  const started = Promise.withResolvers<void>();
  c.run.mockImplementationOnce(
    (input) =>
      new Promise((resolve) => {
        input.onReady?.();
        started.resolve();
        input.signal?.addEventListener(
          "abort",
          () =>
            resolve({ status: "interrupted", checks: [], cleanup_errors: [] }),
          { once: true },
        );
      }),
  );
  const running = c.gate.tick([f.project_id]);
  await started.promise;
  const old = check()?.attempt_id;
  c.gate.stop();
  await running;
  expect(check()?.status).toBe("interrupted");
  expect(c.git.publish).not.toHaveBeenCalled();
  const restarted = new MergeChecks(c.options);
  await restarted.tick([f.project_id]);
  await restarted.tick([f.project_id]);
  expect(check()?.attempt_id).not.toBe(old);
  expect(f.card().status).toBe("done");
  expect(c.git.publish).toHaveBeenCalledTimes(1);
});

test.each(["queued", "running"] as const)(
  "restart recovers persisted %s without waiting forever",
  async (status) => {
    const { f, scenario, completion, check } = await fixture("auto");
    const c = controller(f);
    const identity = {
      card_id: scenario.card.id,
      completion_id: completion.id,
      attempt_id: "orphan-attempt",
      candidate_sha: "b".repeat(40),
      tree_sha: "c".repeat(40),
    };
    for (const next of status === "running"
      ? (["queued", "running"] as const)
      : (["queued"] as const))
      f.apply(
        (s, a, p) =>
          recordMergeCheck(
            { ...s, project_settings: { merge_gate_enabled: true } },
            a,
            { ...identity, status: next },
            p,
          ),
        { kind: "system", project_id: f.project_id },
      );
    await c.gate.tick([f.project_id]);
    expect(check()?.status).toBe("passed");
    expect(check()?.attempt_id).not.toBe(identity.attempt_id);
    expect(
      f
        .state()
        .events.some(
          (e) =>
            e.type === "merge_check_finished" &&
            (e.payload as { status: string }).status === "interrupted",
        ),
    ).toBe(true);
  },
);

test("a distribution failure is recorded without pretending any check ran or retrying automatically", async () => {
  const { f, check } = await fixture("auto");
  const c = controller(f);
  c.git.distribute.mockRejectedValue(new Error("fixture-secret"));
  await c.gate.tick([f.project_id]);
  await c.gate.tick([f.project_id]);
  expect(check()).toMatchObject({ status: "failed", checks: [] });
  expect(f.state().events.some((e) => e.type === "merge_check_started")).toBe(
    false,
  );
  expect(c.git.distribute).toHaveBeenCalledTimes(1);
  expect(c.run).not.toHaveBeenCalled();
  expect(c.git.publish).not.toHaveBeenCalled();
});

test("invalid config never falls back, and verified noop still requires confirmation", async () => {
  const { f, scenario } = await fixture();
  const c = controller(f);
  c.setConfig({ status: "invalid", reason: "bad" });
  expect(c.gate.configured(f.project_id)).toBe(true);
  await c.gate.tick([f.project_id]);
  expect(c.git.prepare).not.toHaveBeenCalled();
  c.setConfig({
    status: "enabled",
    checks: [{ name: "test", run: "true" }],
    env: {},
    totalTimeoutMs: 1000,
  });
  c.git.prepare.mockResolvedValue({
    status: "noop",
    branch_sha: "a".repeat(40),
  });
  await c.gate.tick([f.project_id]);
  expect(f.card().status).toBe("awaiting_merge");
  const visible = () =>
    listNeedsYou(
      { ...f.state(), project_settings: { merge_gate_enabled: true } },
      { kind: "human", project_id: f.project_id },
    );
  const before = visible();
  expect(before.ok && before.value.data.decisions.map((q) => q.id)).toContain(
    required(mergeConfirmation(f, scenario.card.id)).id,
  );
  expect(before.ok && before.value.data.waiting_merge_checks_count).toBe(0);
  expect(
    needsYou(f.state(), f.clock.now(), "enabled").decisions,
  ).toContainEqual(
    expect.objectContaining({
      merge_confirmation: expect.objectContaining({
        merge_noop: true,
        merge_check: null,
      }),
    }),
  );
  await c.gate.tick([f.project_id]);
  const restarted = new MergeChecks(c.options);
  await restarted.tick([f.project_id]);
  expect(
    f.state().events.filter((e) => e.type === "merge_preparation_recorded"),
  ).toHaveLength(1);
  expect(
    f.state().events.filter((e) => e.type === "merge_check_finished"),
  ).toHaveLength(0);
  expect(f.card().status).toBe("awaiting_merge");
  f.decide(required(mergeConfirmation(f, scenario.card.id)), "merge");
  await c.gate.tick([f.project_id]);
  expect(f.card().status).toBe("done");
  expect(c.run).not.toHaveBeenCalled();
  expect(c.git.publish).not.toHaveBeenCalled();
  expect(prepareMergePlan(f.state(), scenario.card.id).ok).toBe(false);
});

test("C-115: a noop confirmation returns to waiting when the baseline requires checks again", async () => {
  const { f, scenario } = await fixture();
  const c = controller(f);
  c.git.prepare.mockResolvedValueOnce({
    status: "noop",
    branch_sha: "a".repeat(40),
  });
  await c.gate.tick([f.project_id]);
  const q = required(mergeConfirmation(f, scenario.card.id));
  expect(
    needsYou(f.state(), f.clock.now(), "enabled").decisions.map((q) => q.id),
  ).toContain(q.id);
  c.advance(true);
  c.run.mockResolvedValue({
    ...passed,
    status: "failed",
    checks: [{ name: "test", status: "failed", exit_code: 1 }],
  });
  await c.gate.tick([f.project_id]);
  expect(
    needsYou(f.state(), f.clock.now(), "enabled").decisions.map((q) => q.id),
  ).toContain(q.id);
  expect(
    needsYou(f.state(), f.clock.now(), "enabled").waiting_merge_checks_count,
  ).toBe(0);
  expect(
    needsYou(f.state(), f.clock.now(), "enabled").decisions.find(
      (d) => d.id === q.id,
    )?.merge_confirmation?.blockers?.length,
  ).toBeGreaterThan(0);
  expect(f.card().status).toBe("awaiting_merge");
  expect(c.git.publish).not.toHaveBeenCalled();
});

test.each(["failed", "timed_out"] as const)(
  "returning a confirmed %s completion prevents later merge-loop publication",
  async (status) => {
    const { f, scenario, check, completion } = await fixture();
    const c = controller(f);
    const decision = required(mergeConfirmation(f, scenario.card.id));
    f.decide(decision, "merge");
    c.run.mockImplementation(async (input) => {
      input.onReady?.();
      return {
        status,
        checks: [{ name: "test", status, exit_code: 1 }],
        cleanup_errors: [],
      };
    });
    await c.gate.tick([f.project_id]);
    // C-116: a step timeout is rerun automatically once before PM sees it.
    const runs = status === "timed_out" ? 2 : 1;
    if (status === "timed_out") await c.gate.tick([f.project_id]);
    expect(check()?.status).toBe(status);
    expect(c.run).toHaveBeenCalledTimes(runs);
    expect(c.git.publish).not.toHaveBeenCalled();
    f.decide(decision, "request_changes");
    await c.gate.tick([f.project_id]);
    expect(c.run).toHaveBeenCalledTimes(runs);
    expect(c.git.publish).not.toHaveBeenCalled();
    expect(c.errors).not.toHaveBeenCalled();
    expect(f.card().status).toBe("in_progress");
    expect(
      f.state().deliveries.find((d) => d.id === completion.id)?.status,
    ).toBe("superseded");
    expect(f.state().decisions.find((q) => q.id === decision.id)?.status).toBe(
      "superseded",
    );
  },
);

const vitestTimeout = ` RUN  v5.1.0 /repo

 ❯ src/a.test.ts (2 tests | 1 failed) 5012ms
   × slow 5004ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/a.test.ts > slow
Error: Test timed out in 5000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".

 Test Files  1 failed (1)
`;
const vitestAssertion = vitestTimeout.replace(
  "Error: Test timed out in 5000ms.",
  "AssertionError: expected 1 to be 2",
);
const vitestFailure =
  (output: string) =>
  async (input: CheckoutInput): Promise<CheckoutResult> => {
    input.onReady?.();
    input.onOutput?.("test", output);
    return {
      status: "failed",
      checks: [{ name: "test", status: "failed", exit_code: 1 }],
      cleanup_errors: [],
    };
  };
const autoReruns = (f: M4Fixture) =>
  f
    .state()
    .events.filter(
      (e) =>
        e.type === "merge_check_requeued" &&
        (e.payload as { via?: string }).via === "timeout_auto_rerun",
    );

test("C-116: a vitest timeout failure is requeued automatically once and then passes", async () => {
  const { f, check } = await fixture("auto");
  const c = controller(f);
  c.run.mockImplementationOnce(vitestFailure(vitestTimeout));
  await c.gate.tick([f.project_id]);
  // The rerun is already queued as a fresh attempt for the same tree.
  expect(check()?.status).toBe("queued");
  expect(autoReruns(f)).toHaveLength(1);
  expect(f.state().timeline.map((t) => t.body)).toContain("因超时自动重跑");
  expect(
    f.state().events.find((e) => e.type === "merge_check_finished")?.payload,
  ).toMatchObject({ status: "failed", timeout_only: true, auto_rerun: true });
  await c.gate.tick([f.project_id]);
  expect(c.run).toHaveBeenCalledTimes(2);
  expect(check()?.status).toBe("passed");
  expect(f.card().status).toBe("done");
  expect(c.errors).not.toHaveBeenCalled();
});

test("C-116: a second timeout failure for the same completion waits for PM", async () => {
  const { f, check } = await fixture("auto");
  const c = controller(f);
  c.run.mockImplementation(vitestFailure(vitestTimeout));
  await c.gate.tick([f.project_id]);
  await c.gate.tick([f.project_id]);
  expect(check()).toMatchObject({ status: "failed", timeout_only: true });
  await c.gate.tick([f.project_id]);
  expect(c.run).toHaveBeenCalledTimes(2);
  expect(autoReruns(f)).toHaveLength(1);
  expect(c.git.publish).not.toHaveBeenCalled();
  expect(f.card().status).toBe("awaiting_merge");
});

test("C-116: an assertion failure is not requeued automatically", async () => {
  const { f, check } = await fixture("auto");
  const c = controller(f);
  c.run.mockImplementationOnce(vitestFailure(vitestAssertion));
  await c.gate.tick([f.project_id]);
  await c.gate.tick([f.project_id]);
  expect(check()?.status).toBe("failed");
  expect(check()?.timeout_only).toBeUndefined();
  expect(c.run).toHaveBeenCalledTimes(1);
  expect(autoReruns(f)).toHaveLength(0);
});

test.each([
  ["with a full report", vitestAssertion],
  // V-436: cut off before vitest printed its report.
  [
    "cut off before the report",
    " RUN  v5.1.0 /repo\n\n × a.test.ts > value 6ms\n   → expected 1 to be 2 // Object.is equality\n",
  ],
])(
  "C-116: a step timeout after an assertion failure is not requeued automatically (%s)",
  async (_name, output) => {
    const { f, check } = await fixture("auto");
    const c = controller(f);
    c.run.mockImplementationOnce(async (input) => {
      input.onReady?.();
      input.onOutput?.("test", output);
      return {
        status: "timed_out",
        checks: [{ name: "test", status: "timed_out", exit_code: null }],
        cleanup_errors: [],
      };
    });
    await c.gate.tick([f.project_id]);
    await c.gate.tick([f.project_id]);
    expect(check()).toMatchObject({ status: "timed_out" });
    expect(check()?.timeout_only).toBeUndefined();
    expect(c.run).toHaveBeenCalledTimes(1);
    expect(autoReruns(f)).toHaveLength(0);
  },
);

test("fake host_ops MCP recheck retries a failed check and the existing merge gate passes it", async () => {
  const { f, scenario, check } = await fixture();
  const c = controller(f);
  c.run.mockImplementationOnce(async (input) => {
    input.onReady?.();
    return {
      status: "failed",
      checks: [{ name: "test", status: "failed", exit_code: 1 }],
      cleanup_errors: [],
    };
  });
  await c.gate.tick([f.project_id]);
  expect(check()?.status).toBe("failed");
  const { createHostOpsAssignment, HOST_OPS_ROLE_TOOLS } = await import(
    "@cardigan/domain"
  );
  const { HostOpsService } = await import("@cardigan/host");
  const { authenticate, hostOpsTools, unwrap } = await import(
    "@cardigan/mcp-server"
  );
  f.store.uow.run((tx) =>
    tx.roles.put(f.project_id, {
      role_id: "host_ops",
      role_version: 1,
      allowed_tools: HOST_OPS_ROLE_TOOLS,
      capabilities: [],
    }),
  );
  const ops = f.apply((s, a, p) =>
    createHostOpsAssignment(s, a, {}, p),
  ).assignment;
  const issued = f.store.issueToken({
    project_id: f.project_id,
    assignment_id: ops.id,
    role: { role_version: 1, allowed_tools: HOST_OPS_ROLE_TOOLS },
  });
  const host = new HostOpsService({
    store: f.store,
    runtime: {} as never,
    snapshot: async () => {
      throw new Error("Recheck must not launch terminals");
    },
    settings: () => ({ merge_gate_enabled: true }),
    clock: f.clock,
  });
  const tool = required(
    hostOpsTools({ hostOps: host.tools }).find(
      (t) => t.name === "host_ops_recheck_merge",
    ),
  );
  await tool.handler(
    { card_id: scenario.card.id, idempotency_key: "retry-check" },
    { store: f.store, identity: unwrap(authenticate(f.store, issued.token)) },
  );
  expect(check()?.status).toBe("queued");
  expect(
    f.state().events.find((e) => e.type === "host_ops_action_taken"),
  ).toMatchObject({
    actor: { assignment_id: ops.id },
    payload: { tool: "host_ops_recheck_merge", target_id: scenario.card.id },
  });
  await c.gate.tick([f.project_id]);
  expect(check()?.status).toBe("passed");
  expect(c.git.publish).not.toHaveBeenCalled();
  expect(c.errors).not.toHaveBeenCalled();
});

test.each(["checks", "executor"] as const)(
  "a passed, confirmed card publishes while another card's check is still running, exactly once (%s)",
  async (via) => {
    const { f: blocked, check: blockedCheck } = await fixture("auto", {
      project_id: "a-blocked",
    });
    const {
      f: ready,
      scenario,
      check: readyCheck,
    } = await fixture("confirm", {
      project_id: "z-ready",
      dataDir: blocked.dataDir,
      clock: { now: () => "2030-01-02T00:00:00.000Z" },
    });
    const c = controller(blocked);
    const executor = new MergeExecutor({
      store: c.options.store,
      git: c.git,
      clock: c.options.clock,
      onError: c.errors,
      gate: {
        configuration: c.options.configuration,
        execution: c.options.execution,
        run: c.run,
      },
    });
    const projects = [blocked.project_id, ready.project_id];
    // The executor's own background round must not hold up its next pass.
    const tick = () =>
      via === "checks" ? c.gate.tick(projects) : executor.tick();
    // The ready card passes its checks first, then the human confirms it.
    await c.gate.tick([ready.project_id]);
    expect(readyCheck()?.status).toBe("passed");
    ready.decide(required(mergeConfirmation(ready, scenario.card.id)), "merge");

    const started = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();
    c.run.mockImplementationOnce(async (input) => {
      input.onReady?.();
      started.resolve();
      await finish.promise;
      return passed;
    });
    const round = tick();
    try {
      await started.promise;
      expect(blockedCheck()?.status).toBe("running");
      // P2a-12 D: the other project's lane no longer waits behind this check,
      // so the ready card may already be published here.
      // Two overlapping passes while the other card's check is running.
      await Promise.all([tick(), tick()]);
      expect(ready.card().status).toBe("done");
      expect(blockedCheck()?.status).toBe("running");
      expect(c.git.publish).toHaveBeenCalledTimes(1);
      expect(c.git.publish.mock.calls[0]?.[0]).toMatchObject({
        project_id: ready.project_id,
      });
    } finally {
      finish.resolve();
      await round;
    }
    await tick();
    expect(blocked.card().status).toBe("done");
    expect(
      c.git.publish.mock.calls.map(([project]) => project.project_id).sort(),
    ).toEqual([blocked.project_id, ready.project_id]);
    expect(c.run).toHaveBeenCalledTimes(2);
    expect(c.errors).not.toHaveBeenCalled();
  },
);

test("a background round that throws is reported, frees the slot and never rejects unhandled", async () => {
  const { f, check } = await fixture("auto");
  const c = controller(f);
  const projectOf = c.git.projectOf;
  c.git.projectOf = () => {
    throw new Error("fixture-boom");
  };
  const { done } = await c.gate.schedule([f.project_id]);
  await expect(done).resolves.toBeUndefined();
  expect(c.errors).toHaveBeenCalledWith(new Error("fixture-boom"));
  c.git.projectOf = projectOf;
  await c.gate.tick([f.project_id]);
  expect(check()?.status).toBe("passed");
  expect(f.card().status).toBe("done");
});

test("a background round whose error reporter also throws never rejects unhandled", async () => {
  const { f } = await fixture("auto");
  const c = controller(f);
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  const reported = Promise.withResolvers<void>();
  let calls = 0;
  const git = {
    ...c.git,
    // confirmDue skips the project; the background round then throws.
    projectOf: (id: string) => {
      calls += 1;
      if (calls === 1) return undefined;
      throw new Error(`background-round-error ${id}`);
    },
  };
  const loop = startMergeLoop({
    store: f.store,
    git,
    clock: f.clock,
    intervalMs: 60_000,
    onError: () => {
      reported.resolve();
      throw new Error("error-reporter-threw");
    },
    gate: {
      configuration: c.options.configuration,
      execution: c.options.execution,
      run: c.run,
    },
  });
  try {
    await reported.promise;
    await new Promise((resolve) => setImmediate(resolve));
    await loop.executor.idle();
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  } finally {
    await loop.loop.stop();
    process.off("unhandledRejection", record);
  }
  await expect(loop.loop.done).resolves.toBeUndefined();
  expect(c.run).not.toHaveBeenCalled();
});

test("without a project executor, candidates and checks use the default execution (regression)", async () => {
  const { f, check } = await fixture("auto");
  const c = controller(f);
  await c.gate.tick([f.project_id]);
  expect(check()?.status).toBe("passed");
  expect(c.git.distribute).toHaveBeenCalledTimes(1);
  expect(c.git.distribute.mock.calls[0]).toEqual([
    expect.objectContaining({ project_id: f.project_id }),
    c.options.execution,
  ]);
  expect(c.run.mock.calls[0]?.[0].execution).toBe(c.options.execution);
});

test("a project executor receives the candidates and runs the checks; logs stay in the host data directory", async () => {
  const { f, check } = await fixture("auto");
  const c = controller(f);
  const executor = {
    name: "cardigan-ci",
    host: "cardigan-ci",
    port: 2222,
    user: "agent",
    hostKeyAlias: "cardigan-ci",
    identityFile: "/data/ssh/ci.key",
    knownHostsFile: "/data/ssh/ci.known_hosts",
    agentRoot: "/srv/cardigan-agent",
    maxConcurrent: 1,
  };
  c.setConfig({
    status: "enabled",
    checks: [{ name: "test", run: "true" }],
    env: {},
    totalTimeoutMs: 1000,
    executor,
  });
  await c.gate.tick([f.project_id]);
  expect(check()?.status).toBe("passed");
  const target = {
    mode: "agent-ssh",
    dataDir: f.dataDir,
    agentRoot: "/srv/cardigan-agent",
    machine: "cardigan-ci",
    identityFile: "/data/ssh/ci.key",
    knownHostsFile: "/data/ssh/ci.known_hosts",
    host: "cardigan-ci",
    port: 2222,
    user: "agent",
    hostKeyAlias: "cardigan-ci",
  };
  expect(c.git.distribute.mock.calls[0]?.[1]).toMatchObject(target);
  expect(c.run.mock.calls[0]?.[0].execution).toMatchObject(target);
  // Same target object for distribution and execution: no silent fallback.
  expect(c.run.mock.calls[0]?.[0].execution).toEqual(
    c.git.distribute.mock.calls[0]?.[1],
  );
  await expect(
    readFile(
      join(
        f.dataDir,
        "merge-gate",
        "logs",
        f.project_id,
        required(check()?.log_ref),
      ),
      "utf8",
    ),
  ).resolves.toBeTypeOf("string");
});

test("Q-208: an executor shared by two projects blocks the check entirely: no remote run, no local fallback", async () => {
  const { f, check } = await fixture("auto");
  const c = controller(f);
  const root = await mkdtemp(join(tmpdir(), "cg-shared-executor-"));
  try {
    const dataDir = join(root, "data"),
      configDir = join(root, "config");
    for (const path of [dataDir, join(dataDir, "ssh"), configDir])
      await mkdir(path, { mode: 0o700 });
    for (const name of ["ci.key", "ci.known_hosts"])
      await writeFile(join(dataDir, "ssh", name), "fictional-not-a-key", {
        mode: 0o600,
      });
    const gate = { checks: [{ name: "test", run: "true" }], executor: "ci" };
    await writeFile(
      join(configDir, "merge-gate.yaml"),
      JSON.stringify({
        executors: {
          ci: {
            host: "cardigan-ci",
            identity_file: "ssh/ci.key",
            known_hosts_file: "ssh/ci.known_hosts",
            agent_root: "/srv/cardigan-agent",
          },
        },
        projects: { [f.project_id]: gate, "p-other": gate },
      }),
      { mode: 0o600 },
    );
    const configuration = await loadMergeGateConfig({
      configDir,
      dataDir,
      projectIds: [f.project_id, "p-other"],
    });
    expect(configuration.forProject(f.project_id)).toMatchObject({
      status: "invalid",
      reason: expect.stringContaining("执行目标 ci 被 2 个项目引用"),
    });
    c.options.configuration.forProject = configuration.forProject;
    expect(c.gate.configured(f.project_id)).toBe(true);
    await c.gate.tick([f.project_id]);
    expect(c.git.prepare).not.toHaveBeenCalled();
    expect(c.git.distribute).not.toHaveBeenCalled();
    expect(c.run).not.toHaveBeenCalled();
    expect(c.git.publish).not.toHaveBeenCalled();
    expect(check()?.status).not.toBe("passed");
    expect(f.state().events.some((e) => e.type === "merge_check_started")).toBe(
      false,
    );
    expect(f.card().status).toBe("awaiting_merge");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  [undefined, "候选同步或检查执行入口失败，请检查执行环境"],
  [3, "根目录缺失、为链接或无法进入"],
  [9, "准备目录为链接或无法进入"],
  [10, "准备目录的真实路径、属主或身份不符"],
  [255, "SSH 通道失败"],
  [0, "完成标记缺失或无效"],
  [42, "命令返回未知错误"],
  [null, "命令未正常结束"],
] as const)(
  "executor preparation exit %s records a distinct start failure without retry or fallback",
  async (code, reason) => {
    const { f, check } = await fixture("auto");
    const c = controller(f);
    c.setConfig({
      status: "enabled",
      checks: [{ name: "test", run: "true" }],
      env: {},
      totalTimeoutMs: 1000,
      executor: ciExecutor(1),
    });
    c.run.mockRejectedValueOnce(
      code === undefined
        ? new Error("Executor checkout preparation failed")
        : new ExecutorPreparationError(code),
    );
    await c.gate.tick([f.project_id]);
    expect(check()?.status).toBe("failed");
    expect(check()?.checks).toEqual([]);
    expect(
      f
        .state()
        .events.some(
          (e) =>
            e.type === "merge_check_started" ||
            e.type === "merge_executor_unreachable",
        ),
    ).toBe(false);
    expect(f.state().human_actions).toEqual([]);
    await c.gate.tick([f.project_id]);
    expect(check()?.summary).not.toContain("preparation");
    expect(check()?.summary).toContain(reason);
    expect(c.run).toHaveBeenCalledTimes(1);
    expect(c.run.mock.calls[0]?.[0].execution).toMatchObject({
      mode: "agent-ssh",
      host: "cardigan-ci",
    });
    expect(c.git.publish).not.toHaveBeenCalled();
  },
);

const ciExecutor = (maxConcurrent: number) => ({
  name: "cardigan-ci",
  host: "cardigan-ci",
  port: 22,
  user: "agent",
  hostKeyAlias: "cardigan-ci",
  identityFile: "/data/ssh/ci.key",
  knownHostsFile: "/data/ssh/ci.known_hosts",
  agentRoot: "/srv/cardigan-agent",
  maxConcurrent,
});
const otherProject = (f: M4Fixture) => {
  const id = "p-other" as typeof f.project_id;
  if (!f.store.listProjects().some((p) => p.id === id))
    f.store.createProject({ id, name: "Other project" });
  return id;
};
const capacity = (f: M4Fixture) =>
  f.store.uow.read((tx) => {
    const s = runCapacitySnapshot(f.store, tx);
    return {
      local: s.occupied.get("local"),
      checks: Object.fromEntries(s.mergeChecks),
    };
  });

test("P2a-12 D: a full executor (max_concurrent) leaves the check queued; it runs once a slot frees", async () => {
  const { f, check } = await fixture("auto");
  const c = controller(f);
  c.setConfig({
    status: "enabled",
    checks: [{ name: "test", run: "true" }],
    env: {},
    totalTimeoutMs: 1000,
    executor: ciExecutor(1),
  });
  // Another project's check already holds the executor's only slot.
  const busy = acquireMergeCheckCapacity(
    f.store,
    otherProject(f),
    "busy",
    undefined,
    "cardigan-ci",
  );
  try {
    await c.gate.tick([f.project_id]);
    expect(c.run).not.toHaveBeenCalled();
    expect(c.git.distribute).not.toHaveBeenCalled();
    expect(check()?.status).toBe("queued");
  } finally {
    busy();
  }
  const seen: ReturnType<typeof capacity>[] = [];
  c.run.mockImplementation(async (input: CheckoutInput) => {
    input.onReady?.();
    seen.push(capacity(f));
    return passed;
  });
  await c.gate.tick([f.project_id]);
  expect(c.run).toHaveBeenCalledOnce();
  expect(check()?.status).toBe("passed");
  // Charged to the executor's bucket, not the host's local Run slots.
  expect(seen).toEqual([{ local: 0, checks: { "cardigan-ci": 1 } }]);
  expect(capacity(f)).toEqual({ local: 0, checks: {} });
});

test("P2a-12 D: max_concurrent above the running count admits the check", async () => {
  const { f, check } = await fixture("auto");
  const c = controller(f);
  c.setConfig({
    status: "enabled",
    checks: [{ name: "test", run: "true" }],
    env: {},
    totalTimeoutMs: 1000,
    executor: ciExecutor(2),
  });
  const busy = acquireMergeCheckCapacity(
    f.store,
    otherProject(f),
    "busy",
    undefined,
    "cardigan-ci",
  );
  try {
    await c.gate.tick([f.project_id]);
    expect(c.run).toHaveBeenCalledOnce();
    expect(check()?.status).toBe("passed");
  } finally {
    busy();
  }
});

test("P2a-12 D: without an executor, checks are charged to local and never gated (regression)", async () => {
  const { f, check } = await fixture("auto");
  const c = controller(f);
  const busy = acquireMergeCheckCapacity(f.store, otherProject(f), "busy");
  const seen: ReturnType<typeof capacity>[] = [];
  c.run.mockImplementation(async (input: CheckoutInput) => {
    input.onReady?.();
    seen.push(capacity(f));
    return passed;
  });
  try {
    await c.gate.tick([f.project_id]);
  } finally {
    busy();
  }
  expect(check()?.status).toBe("passed");
  expect(seen).toEqual([{ local: 4, checks: { local: 2 } }]);
});

/** Two projects in one Store; each check blocks until released. */
async function overlapping(
  executorOf: (project: string) => ProjectMergeGate & { status: "enabled" },
) {
  const { f: a, check: checkA } = await fixture("auto", {
    project_id: "a-first",
  });
  const { f: b, check: checkB } = await fixture("auto", {
    project_id: "b-second",
    dataDir: a.dataDir,
  });
  const c = controller(a);
  c.options.configuration.forProject = (id: string) => executorOf(id);
  const running: { project: string; slot: number | undefined }[] = [];
  const gates = new Map<string, PromiseWithResolvers<void>>();
  const startedOne = Promise.withResolvers<void>();
  c.run.mockImplementation(async (input: CheckoutInput) => {
    input.onReady?.();
    running.push({ project: input.project, slot: input.lockSlot });
    startedOne.resolve();
    const gate = Promise.withResolvers<void>();
    gates.set(input.project, gate);
    await gate.promise;
    running.splice(
      running.findIndex((r) => r.project === input.project),
      1,
    );
    return passed;
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return {
    a,
    b,
    c,
    checkA,
    checkB,
    running,
    startedOne: startedOne.promise,
    settle,
    finish: async (project: string) => {
      for (let i = 0; i < 50 && !gates.has(project); i++) await settle();
      required(gates.get(project)).resolve();
    },
  };
}
const gateWith = (executor?: ReturnType<typeof ciExecutor>) =>
  ({
    status: "enabled",
    checks: [{ name: "test", run: "true" }],
    env: {},
    totalTimeoutMs: 1000,
    ...(executor ? { executor } : {}),
  }) as ProjectMergeGate & { status: "enabled" };

test("P2a-12 D: max_concurrent 2 lets two projects' checks overlap on one executor, on separate lock slots", async () => {
  const o = await overlapping(() => gateWith(ciExecutor(2)));
  const round = o.c.gate.tick([o.a.project_id, o.b.project_id]);
  await o.startedOne;
  await o.settle();
  expect(o.running.map((r) => r.project).sort()).toEqual([
    "a-first",
    "b-second",
  ]);
  expect(o.running.map((r) => r.slot).sort()).toEqual([0, 1]);
  expect(capacity(o.a)).toEqual({ local: 0, checks: { "cardigan-ci": 2 } });
  await o.finish("a-first");
  await o.finish("b-second");
  await round;
  expect(o.checkA()?.status).toBe("passed");
  expect(o.checkB()?.status).toBe("passed");
  expect(o.c.errors).not.toHaveBeenCalled();
});

test("P2a-12 D: different executors do not wait for each other", async () => {
  const o = await overlapping((id) =>
    gateWith(
      id === "a-first"
        ? ciExecutor(1)
        : { ...ciExecutor(1), name: "build-2", host: "build-2" },
    ),
  );
  const round = o.c.gate.tick([o.a.project_id, o.b.project_id]);
  await o.startedOne;
  await o.settle();
  expect(o.running).toEqual(
    expect.arrayContaining([
      { project: "a-first", slot: 0 },
      { project: "b-second", slot: 0 },
    ]),
  );
  expect(capacity(o.a).checks).toEqual({ "cardigan-ci": 1, "build-2": 1 });
  await o.finish("a-first");
  await o.finish("b-second");
  await round;
  expect(o.checkB()?.status).toBe("passed");
});

test.each([
  ["a full executor (max_concurrent 1)", ciExecutor(1)],
  ["local without an executor (regression)", undefined],
] as const)(
  "P2a-12 D: %s runs one check at a time; the other stays queued until the slot frees",
  async (_name, executor) => {
    const o = await overlapping(() => gateWith(executor));
    const round = o.c.gate.tick([o.a.project_id, o.b.project_id]);
    await o.startedOne;
    await o.settle();
    expect(o.running).toEqual([{ project: "a-first", slot: 0 }]);
    expect(o.checkB()?.status).toBe("queued");
    // A further pass while the slot is held neither starts nor fails it.
    await o.c.gate.schedule([o.a.project_id, o.b.project_id]);
    await o.settle();
    expect(o.running).toEqual([{ project: "a-first", slot: 0 }]);
    await o.finish("a-first");
    await o.finish("b-second");
    await round;
    expect(o.checkA()?.status).toBe("passed");
    expect(o.checkB()?.status).toBe("passed");
    expect(o.c.run).toHaveBeenCalledTimes(2);
    expect(o.c.errors).not.toHaveBeenCalled();
  },
);

test("P2a-12 D: shutdown releases a check waiting for a slot without running it", async () => {
  const o = await overlapping(() => gateWith(ciExecutor(1)));
  const round = o.c.gate.tick([o.a.project_id, o.b.project_id]);
  await o.startedOne;
  await o.settle();
  o.c.gate.stop();
  await o.finish("a-first");
  await round;
  await o.c.gate.idle();
  expect(o.c.run).toHaveBeenCalledOnce();
  expect(o.checkB()?.status).toBe("queued");
});

const remoteSettings = (): ProjectMergeGate => ({
  status: "enabled",
  checks: [{ name: "test", run: "true" }],
  env: {},
  totalTimeoutMs: 1000,
  executor: ciExecutor(1),
});

test("C-164: a stuck running check times out, frees the project lane and rejects late callbacks", async () => {
  const { f, check } = await fixture("auto");
  const later = m4Scenario(f, "auto");
  const { completion } = await acceptThroughMergeGate(f, later, "a".repeat(40));
  const c = controller(f);
  const started = Promise.withResolvers<CheckoutInput>();
  const stuck = Promise.withResolvers<CheckoutResult>();
  c.run.mockImplementationOnce((input) => {
    input.onReady?.();
    started.resolve(input);
    return stuck.promise;
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const round = c.gate.tick([f.project_id]);
    const input = await started.promise;
    expect(check()?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(1000 + CHECKOUT_LIMITS.graceMs - 1);
    expect(check()?.status).toBe("running");
    expect(c.run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(input.signal?.aborted).toBe(true);
    // An executor that ignores abort cannot reclaim the released slot or write to the closed log.
    input.onReady?.();
    input.onOutput?.("test", "late output");
    stuck.resolve(passed);
    await round;
    await c.gate.idle();
    expect(check()?.status).toBe("timed_out");
    expect(
      latestMergeCheck(f.state().events, later.card.id, completion.id)?.status,
    ).toBe("passed");
    expect(capacity(f).checks).toEqual({});
    expect(c.run).toHaveBeenCalledTimes(2);
    expect(c.git.publish).toHaveBeenCalledOnce();
    expect(c.errors).not.toHaveBeenCalled();
  } finally {
    stuck.resolve(passed);
    c.gate.stop();
    vi.useRealTimers();
  }
});

test("C-164: shutdown finishes within the grace period even if the executor ignores cancellation", async () => {
  const { f, check } = await fixture("auto");
  const c = controller(f);
  const started = Promise.withResolvers<void>();
  c.run.mockImplementationOnce((input) => {
    input.onReady?.();
    started.resolve();
    return new Promise(() => {});
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const round = c.gate.tick([f.project_id]);
    await started.promise;
    c.gate.stop();
    await vi.advanceTimersByTimeAsync(CHECKOUT_LIMITS.graceMs);
    await round;
    await c.gate.idle();
    expect(check()?.status).toBe("interrupted");
    expect(capacity(f).checks).toEqual({});
    expect(c.git.publish).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("C-164: an executor stuck before ready is requeued as unreachable without acquiring capacity", async () => {
  const { f, check } = await fixture("auto");
  const c = controller(f);
  c.setConfig(remoteSettings());
  const started = Promise.withResolvers<CheckoutInput>();
  c.run.mockImplementationOnce((input) => {
    started.resolve(input);
    return new Promise(() => {});
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const round = c.gate.tick([f.project_id]);
    const input = await started.promise;
    await vi.advanceTimersByTimeAsync(1000 + CHECKOUT_LIMITS.graceMs);
    await round;
    input.onReady?.();
    expect(input.signal?.aborted).toBe(true);
    expect(check()?.status).toBe("queued");
    expect(
      f
        .state()
        .events.filter((e) => e.type === "merge_check_finished")
        .at(-1)?.payload,
    ).toMatchObject({ status: "executor_unreachable" });
    expect(capacity(f).checks).toEqual({});
    expect(c.errors).not.toHaveBeenCalled();
  } finally {
    c.gate.stop();
    vi.useRealTimers();
  }
});

test("C-164: remote orphan sweeps run at startup and periodically even with no waiting cards", async () => {
  let now = Date.parse("2030-01-01T00:00:00.000Z");
  const { f } = await fixture("auto", {
    clock: { now: () => new Date(now).toISOString() },
  });
  const c = controller(f);
  c.setConfig(remoteSettings());
  c.options.sweep.mockImplementationOnce(async (_execution, audit) => {
    audit("orphan 10 100 SIGTERM sent");
  });
  await c.gate.tick([f.project_id]);
  await c.gate.idle();
  expect(c.options.sweep).toHaveBeenCalledOnce();
  expect(c.errors).toHaveBeenCalledWith(
    new Error("远程检查孤儿清理 cardigan-ci: orphan 10 100 SIGTERM sent"),
  );
  await c.gate.tick([f.project_id]);
  expect(c.options.sweep).toHaveBeenCalledOnce();
  now += CHECKOUT_LIMITS.sweepIntervalMs;
  await c.gate.tick([f.project_id]);
  await c.gate.idle();
  expect(c.options.sweep).toHaveBeenCalledTimes(2);
  expect(c.options.sweep.mock.calls[0]?.[0]).toMatchObject({
    mode: "agent-ssh",
    host: "cardigan-ci",
  });
  expect(c.run).toHaveBeenCalledOnce();
});

test("C-165: binds the authenticated checkout and recovers it on a later patrol after it ends", async () => {
  let time = Date.parse("2030-01-01T00:00:00.000Z");
  const { f } = await fixture("auto", {
    clock: { now: () => new Date(time).toISOString() },
  });
  const c = controller(f);
  c.setConfig(remoteSettings());
  c.run.mockImplementationOnce(async (input) => {
    input.onReady?.();
    input.onRegistered?.({
      git_layout: "bare",
      registration_name: "worktree",
      container: { device: "1", inode: "11", uid: 1234 },
      worktree: { device: "1", inode: "12", uid: 1234 },
      repository: { device: "1", inode: "13", uid: 1234 },
      registration: { device: "1", inode: "14", uid: 1234 },
    });
    return {
      ...passed,
      status: "failed",
      cleanup_errors: ["preserve checkout"],
    };
  });
  await c.gate.tick([f.project_id]);
  await c.gate.idle();
  expect(
    f.state().events.some((e) => e.type === "merge_check_checkout_registered"),
  ).toBe(true);
  time += CHECKOUT_LIMITS.sweepIntervalMs;
  await c.gate.tick([f.project_id]);
  await c.gate.idle();
  expect(c.options.recover).toHaveBeenCalledOnce();
  expect(c.options.recover.mock.calls[0]?.[1]).toMatchObject({
    project: f.project_id,
    slots: 1,
  });
  expect(f.state().events.at(-1)?.type).toBe("merge_check_recovery_finished");
  expect(c.errors).not.toHaveBeenCalled();
  const count = f
    .state()
    .events.filter((e) => e.type.startsWith("merge_check_recovery_")).length;
  time += CHECKOUT_LIMITS.sweepIntervalMs;
  await c.gate.tick([f.project_id]);
  await c.gate.idle();
  expect(c.options.recover.mock.calls.at(-1)?.[1].observeOnly).toBe(true);
  expect(
    f.state().events.filter((e) => e.type.startsWith("merge_check_recovery_"))
      .length,
  ).toBe(count);
});

test.each([false, true])(
  "C-165: each shared-executor project is inspected even if the first fails (%s)",
  async (failFirst) => {
    let time = Date.parse("2030-01-01T00:00:00.000Z");
    const { f } = await fixture("auto", {
      clock: { now: () => new Date(time).toISOString() },
    });
    const other = otherProject(f);
    const c = controller(f);
    c.setConfig(remoteSettings());
    const recovery = vi
      .spyOn(CheckRecovery.prototype, "sweep")
      .mockImplementation(async (project) => {
        if (failFirst && project === f.project_id)
          throw new Error("fixture inspection failure");
      });
    try {
      await c.gate.tick([f.project_id, other]);
      await c.gate.idle();
      time += CHECKOUT_LIMITS.sweepIntervalMs + 1;
      await c.gate.tick([f.project_id, other]);
      await c.gate.idle();
      expect(c.options.sweep).toHaveBeenCalledTimes(2);
      expect(recovery.mock.calls.map(([project]) => project)).toEqual([
        f.project_id,
        other,
        f.project_id,
        other,
      ]);
    } finally {
      recovery.mockRestore();
      c.gate.stop();
    }
  },
);

test("remote outage survives restart, retains FIFO, escalates after 30 minutes and resumes automatically", async () => {
  const epoch = Date.parse("2030-01-01T00:00:00.000Z");
  let time = epoch;
  const { f, check, scenario } = await fixture("auto", {
    clock: { now: () => new Date(time).toISOString() },
  });
  const later = m4Scenario(f, "auto");
  await acceptThroughMergeGate(f, later, "a".repeat(40));
  const c = controller(f);
  c.setConfig(remoteSettings());
  c.git.distribute.mockRejectedValue(
    new Error("ssh: connect to host private-host port 22: Connection refused"),
  );
  const originalItems = f.state().work_items;
  for (const minute of [0, 1, 3, 7, 15]) {
    time = epoch + minute * 60_000;
    await c.gate.tick([f.project_id]);
    expect(check()?.status).toBe("queued");
    expect(capacity(f).checks).toEqual({});
  }
  expect(c.git.distribute).toHaveBeenCalledTimes(5);
  expect(c.run).not.toHaveBeenCalled();
  expect(c.git.publish).not.toHaveBeenCalled();
  expect(
    f.state().events.filter((e) => e.type === "merge_check_finished"),
  ).toHaveLength(5);
  expect(
    f
      .state()
      .events.filter((e) => e.type === "merge_check_finished")
      .every(
        (e) =>
          (e.payload as { status: string }).status === "executor_unreachable",
      ),
  ).toBe(true);
  expect(f.state().human_actions).toEqual([]);
  const restarted = new MergeChecks(c.options);
  time = epoch + 30 * 60_000;
  await restarted.tick([f.project_id]);
  expect(f.state().human_actions).toEqual([]);
  time++;
  await restarted.tick([f.project_id]);
  await restarted.tick([f.project_id]);
  expect(c.git.distribute).toHaveBeenCalledTimes(5);
  expect(f.state().human_actions).toHaveLength(1);
  expect(f.state().human_actions[0]).toMatchObject({
    status: "open",
    blocked_work_items: [],
  });
  expect(f.state().work_items).toEqual(originalItems);
  const needs = listNeedsYou(f.state(), f.human);
  expect(needs.ok && needs.value.data.human_actions).toHaveLength(1);
  expect(JSON.stringify(f.state().events)).not.toContain("private-host");
  c.git.distribute.mockResolvedValue();
  // Same tree, new candidate SHA after baseline movement must still run.
  c.advance();
  time = epoch + 31 * 60_000;
  await restarted.tick([f.project_id]);
  expect(check()?.status).toBe("passed");
  expect(c.run).toHaveBeenCalledTimes(2);
  expect(
    c.run.mock.calls.every(([input]) => input.execution.mode === "agent-ssh"),
  ).toBe(true);
  expect(
    f
      .state()
      .cards.filter((card) =>
        [scenario.card.id, later.card.id].includes(card.id),
      )
      .every((card) => card.status === "done"),
  ).toBe(true);
  expect(f.state().human_actions[0]?.status).toBe("cancelled");
  expect(
    f.state().events.filter((e) => e.type === "merge_executor_recovered"),
  ).toHaveLength(1);
  expect(c.errors).not.toHaveBeenCalled();
});

test.each([
  "ssh: Could not resolve hostname private-host: Name or service not known",
  "Host key verification failed.",
  "kex_exchange_identification: Connection closed by remote host",
  "agent@private-host: Permission denied (publickey).",
])("SSH failure queues a retry without fallback (%s)", async (diagnostic) => {
  const { f, check } = await fixture("auto");
  const c = controller(f);
  c.setConfig(remoteSettings());
  c.git.distribute.mockRejectedValue(
    Object.assign(new Error("Git failed"), { stderr: diagnostic }),
  );
  await c.gate.tick([f.project_id]);
  await c.gate.tick([f.project_id]);
  expect(check()?.status).toBe("queued");
  expect(c.git.distribute).toHaveBeenCalledTimes(1);
  expect(c.run).not.toHaveBeenCalled();
  expect(c.git.publish).not.toHaveBeenCalled();
});

test("missing remote base clone is an environment failure, not a retryable network outage", async () => {
  const { f, check } = await fixture("auto");
  const c = controller(f);
  c.setConfig(remoteSettings());
  c.git.distribute.mockRejectedValue(
    new Error("fatal: '/private/repo' does not appear to be a git repository"),
  );
  await c.gate.tick([f.project_id]);
  await c.gate.tick([f.project_id]);
  expect(check()?.status).toBe("failed");
  expect(check()?.summary).toContain("基础仓库缺失或无效");
  expect(check()?.summary).not.toContain("/private/repo");
  expect(
    f.state().events.some((e) => e.type === "merge_executor_unreachable"),
  ).toBe(false);
  expect(c.git.distribute).toHaveBeenCalledTimes(1);
  expect(c.run).not.toHaveBeenCalled();
});

test.each([false, true])(
  "SSH checkout entry failure retries only configured remote executors (remote=%s)",
  async (remote) => {
    let time = Date.parse("2030-01-01T00:00:00.000Z");
    const { f, check } = await fixture("auto", {
      clock: { now: () => new Date(time).toISOString() },
    });
    const c = controller(f);
    if (remote) c.setConfig(remoteSettings());
    c.run.mockImplementationOnce(async () => ({
      status: "executor_unreachable",
      checks: [],
      cleanup_errors: [],
      reason: "远程检查机 SSH 连接失败，合并检查排队等待重试",
    }));
    await c.gate.tick([f.project_id]);
    expect(check()?.status).toBe(remote ? "queued" : "failed");
    time += 60_000;
    await c.gate.tick([f.project_id]);
    expect(c.run).toHaveBeenCalledTimes(remote ? 2 : 1);
    expect(check()?.status).toBe(remote ? "passed" : "failed");
    if (!remote) {
      expect(check()?.summary).toContain("修复执行环境后重新检查");
      expect(check()?.summary).not.toContain("排队等待重试");
    }
    expect(c.errors).not.toHaveBeenCalled();
  },
);

test("a previously passed card awaiting confirmation does not block a later outage retry", async () => {
  let time = Date.parse("2030-01-01T00:00:00.000Z");
  const { f, check } = await fixture("confirm", {
    clock: { now: () => new Date(time).toISOString() },
  });
  const c = controller(f);
  c.setConfig(remoteSettings());
  await c.gate.tick([f.project_id]);
  expect(check()?.status).toBe("passed");
  const later = m4Scenario(f, "auto");
  await acceptThroughMergeGate(f, later, "a".repeat(40));
  c.git.distribute.mockRejectedValueOnce(
    new Error("ssh: connect to host: Connection refused"),
  );
  await c.gate.tick([f.project_id]);
  expect(c.git.distribute).toHaveBeenCalledTimes(2);
  time += 60_000;
  await c.gate.tick([f.project_id]);
  expect(c.git.distribute).toHaveBeenCalledTimes(3);
  expect(
    f.state().cards.find((card) => card.id === later.card.id)?.status,
  ).toBe("done");
  expect(c.errors).not.toHaveBeenCalled();
});

test.each([false, true])(
  "an earlier outage does not block confirmed passed candidates; changed trees still wait (changed=%s)",
  async (changed) => {
    let time = Date.parse("2030-01-01T00:00:00.000Z");
    const {
      f,
      scenario: first,
      check,
    } = await fixture("confirm", {
      clock: { now: () => new Date(time).toISOString() },
    });
    const second = m4Scenario(f, "confirm");
    const { completion: secondCompletion } = await acceptThroughMergeGate(
      f,
      second,
      "a".repeat(40),
    );
    const secondCheck = () =>
      latestMergeCheck(f.state().events, second.card.id, secondCompletion.id);
    const c = controller(f);
    c.setConfig(remoteSettings());
    c.run.mockImplementationOnce(async (input) => {
      input.onReady?.();
      return {
        status: "failed",
        checks: [{ name: "test", status: "failed", exit_code: 1 }],
        cleanup_errors: [],
      };
    });
    await c.gate.tick([f.project_id]);
    expect(check()?.status).toBe("failed");
    expect(secondCheck()?.status).toBe("passed");
    f.apply((s, a, p) =>
      recheckMerge(
        { ...s, project_settings: { merge_gate_enabled: true } },
        a,
        { card_id: first.card.id },
        p,
      ),
    );
    c.git.distribute.mockRejectedValue(
      new Error("ssh: connect to host: Connection refused"),
    );
    await c.gate.tick([f.project_id]);
    expect(check()?.status).toBe("queued");
    expect(c.git.publish).not.toHaveBeenCalled();
    const third = m4Scenario(f, "auto");
    const { completion: thirdCompletion } = await acceptThroughMergeGate(
      f,
      third,
      "a".repeat(40),
    );
    f.decide(required(mergeConfirmation(f, second.card.id)), "merge");
    if (changed) c.advance(true);
    await c.gate.tick([f.project_id]);
    await c.gate.tick([f.project_id]);
    expect(
      f.state().cards.find((card) => card.id === second.card.id)?.status,
    ).toBe(changed ? "awaiting_merge" : "done");
    expect(secondCheck()?.status).toBe(changed ? "queued" : "passed");
    expect(c.git.publish).toHaveBeenCalledTimes(changed ? 0 : 1);
    expect(c.git.distribute).toHaveBeenCalledTimes(3);
    expect(c.run).toHaveBeenCalledTimes(2);
    expect(check()?.status).toBe("queued");
    expect(
      latestMergeCheck(f.state().events, third.card.id, thirdCompletion.id)
        ?.status,
    ).toBe("queued");
    // Publication can pass the waiting queue, but remote checks retain FIFO.
    const order: (string | undefined)[] = [];
    c.run.mockImplementation(async (input) => {
      order.push(
        f
          .state()
          .events.find(
            (e) =>
              e.type === "merge_check_queued" &&
              (e.payload as { attempt_id?: string }).attempt_id ===
                input.attempt,
          )?.card_id,
      );
      input.onReady?.();
      return passed;
    });
    c.git.distribute.mockResolvedValue();
    time += 60_000;
    await c.gate.tick([f.project_id]);
    expect(order).toEqual(
      changed
        ? [first.card.id, second.card.id, third.card.id]
        : [first.card.id, third.card.id],
    );
    expect(c.errors).not.toHaveBeenCalled();
  },
);

const scopedSettings: ProjectMergeGate = {
  status: "enabled",
  env: {},
  totalTimeoutMs: 1000,
  checks: [
    { name: "build", run: "true" },
    { name: "test", run: "true", scope: "affected", skipDocsOnly: true },
    { name: "e2e", run: "true", tiers: ["batch"], skipDocsOnly: true },
  ],
  affected: { extraDependents: { "packages/store": ["apps/web"] } },
};
function scopedRunner(input: CheckoutInput): Promise<CheckoutResult> {
  input.onReady?.();
  return Promise.resolve({
    status: "passed",
    cleanup_errors: [],
    checks: input.checks.map((step) =>
      step.skipReason
        ? { name: step.name, status: "skipped", reason: step.skipReason }
        : { name: step.name, status: "passed", exit_code: 0 },
    ),
  });
}

test.each([
  { paths: ["docs/guide.md"], kind: "docs_only", packages: undefined },
  {
    paths: ["packages/store/src/index.ts"],
    kind: "affected",
    packages: ["apps/server", "apps/web", "packages/store"],
  },
  {
    paths: ["packages/domain/src/index.ts"],
    kind: "full",
    packages: undefined,
  },
  { paths: ["apps/unknown/file.ts"], kind: "full", packages: undefined },
] as const)(
  "A3: $kind scopes the candidate and records executed or skipped steps",
  async ({ paths, kind, packages }) => {
    const { f, check, completion } = await fixture("auto");
    const c = controller(f);
    c.setConfig(scopedSettings);
    c.git.changedPaths.mockResolvedValue(paths);
    c.run.mockImplementation(scopedRunner);
    await c.gate.tick([f.project_id]);
    expect(c.errors).not.toHaveBeenCalled();
    expect(check()).toMatchObject({
      status: "passed",
      scope: { kind, ...(packages ? { packages } : {}) },
    });
    expect(c.git.changedPaths).toHaveBeenCalledWith(
      expect.anything(),
      "a".repeat(40),
      "b".repeat(40),
    );
    const input = required(c.run.mock.calls[0]?.[0]);
    expect(input.checks[0]).not.toHaveProperty("affectedPaths");
    expect(input.checks[1]?.affectedPaths).toEqual(packages ?? []);
    expect(input.env).not.toHaveProperty("CARDIGAN_AFFECTED_PATHS");
    expect(check()?.checks.map((s) => s.status)).toEqual(
      kind === "docs_only"
        ? ["passed", "skipped", "skipped"]
        : ["passed", "passed", "passed"],
    );
    for (const e of f
      .state()
      .events.filter((e) =>
        [
          "merge_check_queued",
          "merge_check_started",
          "merge_check_finished",
        ].includes(e.type),
      ))
      expect(e.payload).toMatchObject({
        completion_id: completion.id,
        tree_sha: "c".repeat(40),
        scope: { kind },
      });
    expect(f.card().status).toBe("done");
  },
);

test("A3: legacy and tiers-only checks retain their events and execute every step", async () => {
  const { f } = await fixture();
  const c = controller(f);
  c.setConfig({
    status: "enabled",
    env: {},
    totalTimeoutMs: 1000,
    checks: [{ name: "e2e", run: "true", tiers: ["batch"] }],
  });
  c.run.mockImplementation(scopedRunner);
  await c.gate.tick([f.project_id]);
  expect(c.git.changedPaths).not.toHaveBeenCalled();
  expect(c.git.readWorkspace).not.toHaveBeenCalled();
  expect(c.run.mock.calls[0]?.[0].checks).toEqual([
    { name: "e2e", run: "true" },
  ]);
  for (const e of f
    .state()
    .events.filter((e) => e.type.startsWith("merge_check_"))) {
    expect(e.payload).not.toHaveProperty("scope");
    expect(e.payload).not.toHaveProperty("level");
  }
});

test("A3: a new candidate recomputes scope; workspace read failures cannot authorize merging", async () => {
  const { f, check } = await fixture();
  const c = controller(f);
  c.setConfig(scopedSettings);
  c.run.mockImplementation(scopedRunner);
  await c.gate.tick([f.project_id]);
  expect(check()?.scope?.kind).toBe("docs_only");
  c.advance(true);
  c.git.changedPaths.mockResolvedValue(["apps/web/src/index.ts"]);
  c.git.readWorkspace.mockRejectedValue(
    new Error("unreadable candidate workspace"),
  );
  await c.gate.tick([f.project_id]);
  expect(c.git.publish).not.toHaveBeenCalled();
  expect(c.errors).toHaveBeenCalled();
  expect(c.run).toHaveBeenCalledTimes(1);
  c.git.readWorkspace.mockResolvedValue([
    { dir: "apps/web", name: "@cardigan/web", dependencies: [] },
  ]);
  await c.gate.tick([f.project_id]);
  expect(check()).toMatchObject({
    status: "passed",
    scope: { kind: "affected", packages: ["apps/web"] },
  });
  expect(c.git.readWorkspace).toHaveBeenCalledWith(
    expect.anything(),
    "e".repeat(40),
  );
});

function setPriority(
  f: M4Fixture,
  priority: 0 | 1 | 2 | 3 | 4,
  cardId = f.card().id,
) {
  f.store.uow.run((tx) => {
    const card = tx.cards.get(f.project_id, cardId);
    if (!card) throw new Error("Missing card");
    tx.cards.put(f.project_id, { ...card, priority });
  });
}

test("higher card priority wins cross-project merge checks, then equal tiers keep completion FIFO", async () => {
  const { f: older } = await fixture("auto", { project_id: "older" });
  const { f: newer } = await fixture("auto", {
    project_id: "newer",
    dataDir: older.dataDir,
    clock: { now: () => "2030-01-02T00:00:00.000Z" },
  });
  setPriority(older, 1);
  setPriority(newer, 4);
  const c = controller(older);
  await c.gate.tick([older.project_id, newer.project_id]);
  expect(c.run.mock.calls.map(([input]) => input.project)).toEqual([
    newer.project_id,
    older.project_id,
  ]);
  expect(c.errors).not.toHaveBeenCalled();
});

test("queued merge priorities refresh while a check runs, including another card in the same project", async () => {
  const o = await overlapping(() => gateWith(ciExecutor(1)));
  const third = await fixture("auto", {
    project_id: "c-third",
    dataDir: o.a.dataDir,
  });
  setPriority(o.a, 4);
  setPriority(o.b, 2);
  setPriority(third.f, 1);
  const second = m4Scenario(o.b, "auto");
  await acceptThroughMergeGate(o.b, second, "a".repeat(40));
  setPriority(o.b, 0, second.card.id);
  const round = o.c.gate.tick([
    o.a.project_id,
    o.b.project_id,
    third.f.project_id,
  ]);
  await o.startedOne;
  await o.settle();
  setPriority(third.f, 4);
  setPriority(o.b, 3, second.card.id);
  await o.c.gate.schedule([o.a.project_id, o.b.project_id, third.f.project_id]);
  expect(o.running.map((r) => r.project)).toEqual([o.a.project_id]);
  await o.finish(o.a.project_id);
  await vi.waitFor(() =>
    expect(o.running.map((r) => r.project)).toEqual([third.f.project_id]),
  );
  await o.finish(third.f.project_id);
  await vi.waitFor(() =>
    expect(o.running.map((r) => r.project)).toEqual([o.b.project_id]),
  );
  const call = o.c.run.mock.calls.at(-1)?.[0];
  expect(
    o.b
      .state()
      .events.find(
        (e) =>
          (e.payload as { attempt_id?: string }).attempt_id === call?.attempt,
      )?.card_id,
  ).toBe(second.card.id);
  await o.finish(o.b.project_id);
  await vi.waitFor(() => expect(o.c.run).toHaveBeenCalledTimes(4));
  await o.finish(o.b.project_id);
  await round;
  expect(o.c.errors).not.toHaveBeenCalled();
});

test("a high-priority executor backoff never blocks a healthy lower-priority project", async () => {
  const { f: high, check } = await fixture("auto", { project_id: "high" });
  const { f: low } = await fixture("auto", {
    project_id: "low",
    dataDir: high.dataDir,
  });
  setPriority(high, 4);
  setPriority(low, 1);
  const c = controller(high);
  c.options.configuration.forProject = () => gateWith(ciExecutor(1));
  c.git.distribute.mockImplementation(async (project) => {
    if (project.project_id === high.project_id)
      throw new Error("ssh: connect to host: Connection refused");
  });
  await c.gate.tick([high.project_id]);
  expect(check()?.status).toBe("queued");
  await c.gate.tick([high.project_id, low.project_id]);
  expect(c.run.mock.calls.map(([input]) => input.project)).toEqual([
    low.project_id,
  ]);
  expect(check()?.status).toBe("queued");
});

test("the next high-priority card in a running project's lane competes before a waiting lower tier", async () => {
  const o = await overlapping(() => gateWith(ciExecutor(1)));
  setPriority(o.a, 4);
  setPriority(o.b, 1);
  const next = m4Scenario(o.a, "auto");
  await acceptThroughMergeGate(o.a, next, "a".repeat(40));
  setPriority(o.a, 3, next.card.id);
  const round = o.c.gate.tick([o.a.project_id, o.b.project_id]);
  await o.startedOne;
  await o.settle();
  await o.finish(o.a.project_id);
  await vi.waitFor(() => expect(o.c.run).toHaveBeenCalledTimes(2));
  expect(o.running.map((r) => r.project)).toEqual([o.a.project_id]);
  await o.finish(o.a.project_id);
  await vi.waitFor(() =>
    expect(o.running.map((r) => r.project)).toEqual([o.b.project_id]),
  );
  await o.finish(o.b.project_id);
  await round;
  expect(o.c.errors).not.toHaveBeenCalled();
});

test("a durable fence preserves queued facts across restart and resumes the ordinary serial pipeline only explicitly", async () => {
  const { f, check } = await fixture("auto");
  const c = controller(f);
  c.setConfig(gateWith(ciExecutor(1)));
  const occupied = acquireMergeCheckCapacity(
    f.store,
    f.project_id,
    "existing",
    undefined,
    ciExecutor(1).name,
  );
  await c.gate.tick([f.project_id]);
  const queued = check();
  expect(queued?.status).toBe("queued");
  const facts = new CheckHandoffs(f.store, "handoff");
  facts.begin(f.project_id, ciExecutor(1).name, "approved");
  occupied();
  const restarted = new MergeChecks(c.options);
  const sweepsBefore = c.options.sweep.mock.calls.length;
  const recoveriesBefore = c.options.recover.mock.calls.length;
  await restarted.tick([f.project_id]);
  expect(check()).toEqual(queued);
  expect(c.options.sweep).toHaveBeenCalledTimes(sweepsBefore);
  expect(c.options.recover).toHaveBeenCalledTimes(recoveriesBefore);
  expect(c.run).not.toHaveBeenCalled();
  expect(c.git.publish).not.toHaveBeenCalled();
  facts.resume(f.project_id, ciExecutor(1).name, 1, "fixture exact exit");
  await restarted.tick([f.project_id]);
  expect(c.run).toHaveBeenCalledTimes(1);
  expect(c.git.publish).toHaveBeenCalledTimes(1);
});

test("a check already running finishes normally, while a fence closes the final publication CAS", async () => {
  const { f, check } = await fixture("auto");
  const c = controller(f);
  let finish: () => void = () => {};
  let ready: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  c.run.mockImplementation(async (input) => {
    input.onReady?.();
    ready();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    expect(input.signal?.aborted).toBe(false);
    return passed;
  });
  const round = c.gate.tick([f.project_id]);
  await started;
  new CheckHandoffs(f.store, "handoff").begin(
    f.project_id,
    "local",
    "approved",
  );
  finish();
  await round;
  expect(check()?.status).toBe("passed");
  expect(c.git.publish).not.toHaveBeenCalled();
  expect(c.errors).not.toHaveBeenCalled();
});

test("a fence racing with asynchronous publish preparation is rechecked inside the final transaction", async () => {
  const { f } = await fixture("auto");
  const c = controller(f);
  const original = c.git.publish.getMockImplementation();
  if (!original) throw new Error("fixture publish");
  let enter: () => void = () => {},
    finish: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  c.git.publish.mockImplementation(async (...args) => {
    enter();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return original(...args);
  });
  const round = c.gate.tick([f.project_id]);
  await entered;
  new CheckHandoffs(f.store, "handoff").begin(
    f.project_id,
    "local",
    "approved",
  );
  finish();
  await round;
  expect(c.git.publish).toHaveBeenCalledTimes(1);
  expect(
    f.state().events.filter((e) => e.type === "merge_succeeded"),
  ).toHaveLength(0);
  expect(c.errors).not.toHaveBeenCalled();
});

test.each([
  "passed",
  "failed",
  "timed_out",
  "interrupted",
  "executor_unreachable",
] as const)(
  "D1: injected executor drives queued/running/%s through the real controller",
  async (status) => {
    const { f, scenario, check } = await fixture();
    const c = controller(f);
    // A named executor preserves the existing unreachable/requeue semantics.
    c.setConfig({
      status: "enabled",
      checks: [{ name: "test", run: "true" }],
      env: {},
      totalTimeoutMs: 1000,
      executor: {
        name: "ci",
        host: "synthetic",
        port: 22,
        user: "agent",
        hostKeyAlias: "synthetic",
        identityFile: "/synthetic/key",
        knownHostsFile: "/synthetic/hosts",
        agentRoot: "/synthetic",
        maxConcurrent: 1,
      },
    });
    let request: CheckRequest | undefined;
    const handle: CheckHandle = { id: "synthetic" };
    const executor: CheckExecutor = {
      dispatch: vi.fn(async (input) => {
        expect(check()?.status).toBe("queued");
        expect(input.kind).toBe("merge_check");
        expect(input.sha).toBe("b".repeat(40));
        expect(input.tree).toBe("c".repeat(40));
        request = input;
        input.onReady?.();
        expect(check()?.status).toBe("running");
        return handle;
      }),
      poll: vi.fn(async (received) => {
        expect(received).toBe(handle);
        return {
          status,
          checks:
            status === "passed"
              ? passed.checks
              : status === "executor_unreachable"
                ? []
                : [{ name: "test", status, exit_code: 1 }],
          cleanup_errors: [],
        };
      }),
      cancel: vi.fn(async () => {}),
      fetchFailureLog: vi.fn(
        async () => "FAIL synthetic token=synthetic-secret",
      ),
    };
    const gate = new MergeChecks({ ...c.options, checkExecutor: executor });
    await gate.tick([f.project_id]);
    const finished = f
      .state()
      .events.filter(
        (event) =>
          event.type === "merge_check_finished" &&
          event.card_id === scenario.card.id,
      )
      .at(-1);
    expect(finished?.payload).toMatchObject({
      status,
      candidate_sha: "b".repeat(40),
      tree_sha: "c".repeat(40),
    });
    expect(c.run).not.toHaveBeenCalled();
    expect(c.git.distribute).not.toHaveBeenCalled();
    expect(c.errors).not.toHaveBeenCalled();
    expect(request).toBeDefined();
    if (status === "executor_unreachable")
      expect(check()?.status).toBe("queued");
    if (status === "failed") {
      expect(check()?.summary).toContain("FAIL synthetic token=[REDACTED]");
      const contents = await readFile(
        join(
          f.dataDir,
          "merge-gate",
          "logs",
          f.project_id,
          required(check()?.log_ref),
        ),
        "utf8",
      );
      expect(contents).not.toContain("synthetic-secret");
    }
    gate.stop();
    await gate.idle();
  },
);

test.each([
  "failed",
  "timed_out",
  "interrupted",
  "executor_unreachable",
] as const)(
  "D1 rework: failure-log errors preserve %s results and cleanup evidence",
  async (status) => {
    const { f, scenario } = await fixture();
    const c = controller(f);
    c.setConfig(remoteSettings());
    const terminal: CheckoutResult = {
      status,
      checks:
        status === "executor_unreachable"
          ? []
          : [{ name: "test", status, exit_code: null }],
      cleanup_errors: ["synthetic cleanup not confirmed"],
    };
    const executor: CheckExecutor = {
      dispatch: async (input) => {
        input.onReady?.();
        return { id: "fixture" };
      },
      poll: async () => terminal,
      cancel: async () => {},
      fetchFailureLog: async () => {
        throw new Error("token=synthetic-provider-secret");
      },
    };
    const gate = new MergeChecks({ ...c.options, checkExecutor: executor });
    try {
      await gate.tick([f.project_id]);
      const finished = f
        .state()
        .events.filter(
          (e) =>
            e.card_id === scenario.card.id && e.type === "merge_check_finished",
        )
        .at(-1);
      expect(finished?.payload).toMatchObject({
        status,
        checks: terminal.checks,
      });
      const result = finished?.payload as { log_ref: string };
      const contents = await readFile(
        join(f.dataDir, "merge-gate", "logs", f.project_id, result.log_ref),
        "utf8",
      );
      expect(contents).toContain("synthetic cleanup not confirmed");
      expect(contents).toContain("检查失败日志获取失败");
      expect(contents).not.toContain("synthetic-provider-secret");
      expect(c.errors).toHaveBeenCalledOnce();
      expect(c.errors.mock.calls[0]?.[0]).toMatchObject({
        message: "检查失败日志获取失败，保留原执行结果与清理提示",
      });
      expect(capacity(f).checks).toEqual({});
      if (status === "executor_unreachable") {
        expect(
          latestMergeCheck(
            f.state().events,
            scenario.card.id,
            (required(finished).payload as { completion_id: string })
              .completion_id as never,
          )?.status,
        ).toBe("queued");
      }
    } finally {
      gate.stop();
      await gate.idle();
    }
  },
);

test.each(["timed_out", "executor_unreachable"] as const)(
  "D1 rework: a stuck failure-log download keeps %s and ignores late output",
  async (status) => {
    const { f, scenario } = await fixture();
    const c = controller(f);
    c.setConfig(remoteSettings());
    const started = Promise.withResolvers<CheckRequest>();
    const download = Promise.withResolvers<string>();
    let input: CheckRequest | undefined;
    const terminal: CheckoutResult = {
      status,
      checks:
        status === "timed_out"
          ? [{ name: "test", status, exit_code: null }]
          : [],
      cleanup_errors: ["synthetic cleanup not confirmed"],
    };
    const executor: CheckExecutor = {
      dispatch: async (request) => {
        input = request;
        request.onReady?.();
        return { id: "fixture" };
      },
      poll: async () => terminal,
      cancel: vi.fn(async () => {}),
      fetchFailureLog: () => {
        started.resolve(required(input));
        return download.promise;
      },
    };
    const gate = new MergeChecks({ ...c.options, checkExecutor: executor });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const round = gate.tick([f.project_id]);
      const request = await started.promise;
      const beforeCallbacks = f.state().events.length;
      request.onReady?.();
      request.onRegistered?.({} as never);
      request.onOutput?.("test", "late output before log download ends");
      expect(f.state().events).toHaveLength(beforeCallbacks);
      await vi.advanceTimersByTimeAsync(1000 + CHECKOUT_LIMITS.graceMs);
      await round;
      await gate.idle();
      expect(executor.cancel).toHaveBeenCalledOnce();
      expect(capacity(f).checks).toEqual({});
      const finished = f
        .state()
        .events.filter(
          (e) =>
            e.card_id === scenario.card.id && e.type === "merge_check_finished",
        )
        .at(-1);
      expect(finished?.payload).toMatchObject({
        status,
        checks: terminal.checks,
      });
      const log_ref = (required(finished).payload as { log_ref: string })
        .log_ref;
      const before = await readFile(
        join(f.dataDir, "merge-gate", "logs", f.project_id, log_ref),
        "utf8",
      );
      expect(before).toContain("synthetic cleanup not confirmed");
      expect(before).toContain("检查失败日志获取超时或取消");
      expect(c.errors).toHaveBeenCalledOnce();
      request.onReady?.();
      request.onOutput?.("test", "late output");
      download.resolve("FAIL late downloaded output");
      await vi.advanceTimersByTimeAsync(0);
      expect(
        await readFile(
          join(f.dataDir, "merge-gate", "logs", f.project_id, log_ref),
          "utf8",
        ),
      ).toBe(before);
      expect(capacity(f).checks).toEqual({});
    } finally {
      download.resolve("late output");
      gate.stop();
      vi.useRealTimers();
    }
  },
);

test.each(["running", "before_ready", "dispatch", "shutdown"] as const)(
  "D1 rework: injected executor stuck at %s respects deadline, capacity and late callback fences",
  async (mode) => {
    const { f, check, scenario } = await fixture("auto");
    const following = mode === "running" ? m4Scenario(f, "auto") : undefined;
    const followingCompletion = following
      ? (await acceptThroughMergeGate(f, following, "a".repeat(40))).completion
      : undefined;
    const c = controller(f);
    c.setConfig(remoteSettings());
    const started = Promise.withResolvers<CheckRequest>();
    const dispatch = Promise.withResolvers<CheckHandle>();
    const poll = Promise.withResolvers<CheckoutResult>();
    let dispatches = 0;
    const executor: CheckExecutor = {
      dispatch: (input) => {
        if (++dispatches > 1) {
          input.onReady?.();
          return Promise.resolve({ id: "following" });
        }
        if (mode !== "before_ready" && mode !== "dispatch") input.onReady?.();
        started.resolve(input);
        return mode === "dispatch"
          ? dispatch.promise
          : Promise.resolve({ id: "fixture" });
      },
      poll: vi.fn((handle) =>
        handle.id === "following" ? Promise.resolve(passed) : poll.promise,
      ),
      // Even an executor ignoring cancellation cannot hold the controller open.
      cancel: vi.fn(() => new Promise(() => {})),
      fetchFailureLog: vi.fn(async () => undefined),
    };
    const gate = new MergeChecks({ ...c.options, checkExecutor: executor });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const round = gate.tick([f.project_id]);
      const request = await started.promise;
      expect(capacity(f).checks).not.toEqual({});
      if (mode === "shutdown") gate.stop();
      const duration =
        (mode === "shutdown" ? 0 : 1000) + CHECKOUT_LIMITS.graceMs;
      await vi.advanceTimersByTimeAsync(duration - 1);
      expect(check()?.status).toBe(
        mode === "before_ready" || mode === "dispatch" ? "queued" : "running",
      );
      await vi.advanceTimersByTimeAsync(1);
      await round;
      await gate.idle();
      expect(request.signal?.aborted).toBe(true);
      expect(capacity(f).checks).toEqual({});
      const finished = f
        .state()
        .events.filter(
          (e) =>
            e.card_id === scenario.card.id && e.type === "merge_check_finished",
        )
        .at(-1);
      expect(finished?.payload).toMatchObject({
        status:
          mode === "shutdown"
            ? "interrupted"
            : mode === "running"
              ? "timed_out"
              : "executor_unreachable",
      });
      if (following && followingCompletion) {
        expect(
          latestMergeCheck(
            f.state().events,
            following.card.id,
            followingCompletion.id,
          )?.status,
        ).toBe("passed");
        expect(dispatches).toBe(2);
        expect(c.git.publish).toHaveBeenCalledOnce();
      } else expect(c.git.publish).not.toHaveBeenCalled();
      const events = f.state().events.length;
      request.onReady?.();
      request.onOutput?.("test", "late output");
      // A malformed binding would throw if the late callback crossed the fence.
      request.onRegistered?.({} as never);
      dispatch.resolve({ id: "fixture" });
      poll.resolve(passed);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.state().events).toHaveLength(events);
      expect(capacity(f).checks).toEqual({});
      expect(executor.cancel).toHaveBeenCalledOnce();
      if (mode === "dispatch") expect(executor.poll).not.toHaveBeenCalled();
      expect(executor.fetchFailureLog).not.toHaveBeenCalled();
      expect(c.errors).not.toHaveBeenCalled();
    } finally {
      dispatch.resolve({ id: "fixture" });
      poll.resolve(passed);
      gate.stop();
      vi.useRealTimers();
    }
  },
);

test("A1a: a returned version 2 completion never prepares checks after baseline advances", async () => {
  const { f, scenario, completion, check } = await fixture();
  // Synthetic v2 fixture: the public version ceiling remains 1.
  const version2 = { ...f.card(), flow_version: 2 };
  f.store.uow.run((tx) => tx.cards.put(f.project_id, version2));
  const c = controller(f);
  c.run.mockImplementation(async (input) => {
    input.onReady?.();
    return {
      status: "failed",
      checks: [{ name: "test", status: "failed", exit_code: 1 }],
      cleanup_errors: [],
    };
  });
  await c.gate.tick([f.project_id]);
  expect(check()?.status).toBe("failed");
  expect(f.card().status).toBe("in_progress");
  expect(f.state().deliveries.find((d) => d.id === completion.id)?.status).toBe(
    "superseded",
  );
  expect(f.item(scenario.development.id).status).toBe("changes_requested");
  expect(cardDetail(f.state(), scenario.card.id)?.card.status).toBe(
    "in_progress",
  );
  const preparations = c.git.prepare.mock.calls.length;
  const recorded = f
    .state()
    .events.filter((e) => e.type === "merge_preparation_recorded").length;
  c.advance(true);
  await c.gate.tick([f.project_id]);
  await c.gate.tick([f.project_id]);
  expect(c.run).toHaveBeenCalledTimes(1);
  expect(c.git.prepare).toHaveBeenCalledTimes(preparations);
  expect(
    f.state().events.filter((e) => e.type === "merge_preparation_recorded"),
  ).toHaveLength(recorded);
  expect(c.git.publish).not.toHaveBeenCalled();
  expect(c.errors).not.toHaveBeenCalled();
});

test("A1a: competing completion callbacks commit only one system return in fresh storage transactions", async () => {
  const { f, scenario, completion } = await fixture();
  const version2 = { ...f.card(), flow_version: 2 };
  f.store.uow.run((tx) => tx.cards.put(f.project_id, version2));
  const system = { kind: "system" as const, project_id: f.project_id };
  const identity = {
    card_id: scenario.card.id,
    completion_id: completion.id,
    attempt_id: "competing",
    candidate_sha: "b".repeat(40),
    tree_sha: "c".repeat(40),
  };
  const record = (update: Parameters<typeof recordMergeCheck>[2]) =>
    f.apply(
      (s, a, p) =>
        recordMergeCheck(
          { ...s, project_settings: { merge_gate_enabled: true } },
          a,
          update,
          p,
        ),
      system,
    );
  record({ ...identity, status: "queued" });
  record({ ...identity, status: "running" });
  const failure = {
    ...identity,
    status: "failed" as const,
    checks: [{ name: "test", status: "failed" as const, exit_code: 1 }],
    summary: "failed",
    failure_excerpt: "FAIL contract",
    log_ref: "competing.log",
  };
  const c = controller(f);
  c.advance(true);
  c.git.prepare.mockImplementationOnce(async () => {
    // A baseline refresh captured the accepted completion, but two old
    // executor callbacks arrive before its asynchronous preparation ends.
    const results = await Promise.allSettled([
      Promise.resolve().then(() => record(failure)),
      Promise.resolve().then(() => record(failure)),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    return {
      status: "candidate",
      candidate_sha: "e".repeat(40),
      tree_sha: "f".repeat(40),
      previous_sha: "d".repeat(40),
    };
  });
  await c.gate.tick([f.project_id]);
  expect(c.git.prepare).toHaveBeenCalledTimes(1);
  expect(c.run).not.toHaveBeenCalled();
  expect(c.errors).not.toHaveBeenCalled();
  expect(
    f.state().events.filter((e) => e.type === "merge_preparation_recorded"),
  ).toHaveLength(0);
  const events = f.state().events;
  expect(events.filter((e) => e.type === "merge_check_finished")).toHaveLength(
    1,
  );
  expect(
    events.filter((e) => e.type === "merge_changes_requested"),
  ).toHaveLength(1);
  expect(f.card().status).toBe("in_progress");
  expect(f.state().deliveries.find((d) => d.id === completion.id)?.status).toBe(
    "superseded",
  );
});

test("D3: a parsed GitHub target waits for D4 without SSH sweep, recovery, local run or publication", async () => {
  const { f, scenario, check } = await fixture();
  const c = controller(f);
  c.setConfig({
    status: "enabled",
    checks: [{ name: "test", run: "true" }],
    env: {},
    totalTimeoutMs: 1000,
    executor: {
      name: "github",
      type: "github",
      repo: "fixture/project",
      workflow: ".github/workflows/check.yml",
      appId: 1,
      installationId: 2,
      privateKeyFile: "/synthetic/app.pem",
      botLogin: "fixture[bot]",
      maxConcurrent: 1,
    },
  });
  await c.gate.tick([f.project_id]);
  await c.gate.tick([f.project_id]);
  expect(c.run).not.toHaveBeenCalled();
  expect(c.git.distribute).not.toHaveBeenCalled();
  expect(c.git.publish).not.toHaveBeenCalled();
  expect(c.options.sweep).not.toHaveBeenCalled();
  expect(c.options.recover).not.toHaveBeenCalled();
  expect(c.errors).not.toHaveBeenCalled();
  expect(check()).toBeUndefined();
  expect(
    cardDetail(f.state(), scenario.card.id)?.card.merge_check_blockers,
  ).toMatchObject([{ label: "合并闸门配置" }]);
  expect(JSON.stringify(f.state().events)).not.toContain("/synthetic/app.pem");
});

test.each(["passed", "failed", "restart", "restartFinished", "invalidated"])(
  "D4: GitHub %s uses the shared lifecycle and records bound, redacted results without SSH",
  async (mode) => {
    const status = mode === "failed" ? "failed" : "passed";
    let now = Date.parse("2030-01-01T00:00:00Z");
    const { f, completion, scenario, check } = await fixture("confirm", {
      clock: { now: () => new Date(now).toISOString() },
    });
    const c = controller(f);
    const { GITHUB_CHECK_NAMES, GITHUB_WORKFLOW_STEPS, githubCheckRunName } =
      await import("@cardigan/host");
    const config = {
      name: "github",
      type: "github" as const,
      repo: "fixture/project",
      workflow: ".github/workflows/check.yml",
      appId: 1,
      installationId: 2,
      privateKeyFile: "/synthetic/app.pem",
      botLogin: "fixture[bot]",
      maxConcurrent: 1,
    };
    c.setConfig({
      status: "enabled",
      executor: config,
      checks: GITHUB_CHECK_NAMES.map((name) => ({ name, run: "true" })),
      env: { SECRET: "synthetic-private-value" },
      totalTimeoutMs: 3600_000,
    });
    let inputs: Readonly<Record<string, string>> = {};
    const run = () => ({
      id: 123,
      run_attempt: 1,
      path: config.workflow,
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: "a".repeat(40),
      actor: { login: config.botLogin },
      display_title: githubCheckRunName(inputs),
      html_url: "https://github.com/fixture/project/actions/runs/123",
      created_at: "2030-01-01T00:00:00.000Z",
      status: "completed",
      conclusion:
        mode === "invalidated"
          ? "cancelled"
          : status === "passed"
            ? "success"
            : "failure",
    });
    const client = {
      token: vi.fn(async () => "ghs_synthetic"),
      dispatch: vi.fn(
        async (_ref: string, value: Readonly<Record<string, string>>) => {
          inputs = value;
          return 123;
        },
      ),
      run: vi.fn(async () => run()),
      runs: vi.fn(async () => []),
      pollRuns: vi.fn(async () => ({
        unchanged: false,
        runs: [run()],
        etag: "x",
      })),
      jobs: vi.fn(async () => [
        {
          id: 456,
          run_id: 123,
          run_attempt: 1,
          head_sha: "a".repeat(40),
          name: "check",
          status: "completed",
          conclusion: status === "passed" ? "success" : "failure",
          steps: GITHUB_WORKFLOW_STEPS.map((name, index) => ({
            name,
            number: index + 1,
            status: "completed",
            conclusion:
              status === "failed" && name === "test" ? "failure" : "success",
          })),
        },
      ]),
      cancel: vi.fn(async () => {}),
      jobLog: vi.fn(
        async () =>
          "FAIL first synthetic-private-value token=ghp_synthetic123456\nError expected true\n",
      ),
    };
    const pushCheckCandidate = vi.fn(async () => ({
      status: "pushed" as const,
    }));
    const git = {
      ...c.git,
      pushCheckCandidate,
      deleteCheckCandidate: vi.fn(async () => true),
      isBaselineAncestor: vi.fn(async () => true),
    };
    if (mode.startsWith("restart")) {
      const {
        GithubCheckExecutor,
        GithubDispatchJournal,
        createMergeCheckLog,
      } = await import("@cardigan/host");
      const journal = new GithubDispatchJournal(f.store);
      const identity = {
        card_id: scenario.card.id,
        completion_id: completion.id,
        attempt_id: "restarted-attempt",
        candidate_sha: "b".repeat(40),
        tree_sha: "c".repeat(40),
        executor: { name: "github", type: "github" as const },
      };
      const system = { kind: "system" as const, project_id: f.project_id };
      f.apply(
        (s, a, p) =>
          recordMergeCheck(
            { ...s, project_settings: { merge_gate_enabled: true } },
            a,
            { ...identity, status: "queued" },
            p,
          ),
        system,
      );
      const previous = new GithubCheckExecutor({
        config,
        client,
        journal,
        context: () => ({
          card: scenario.card.id,
          delivery: completion.id,
          baselineBranch: "main",
          onExternalRun: (external_run) => {
            f.apply(
              (s, a, p) =>
                recordMergeCheck(
                  { ...s, project_settings: { merge_gate_enabled: true } },
                  a,
                  { ...identity, external_run, status: "running" },
                  p,
                ),
              system,
            );
          },
        }),
        push: pushCheckCandidate,
        isBaselineAncestor: async () => true,
        now: () => now,
        lifecycle: {
          poll: async () => passed,
          cancel: async () => {},
          fetchFailureLog: async () => undefined,
        },
      });
      await previous.dispatch({
        kind: "merge_check",
        project: f.project_id,
        attempt: identity.attempt_id,
        sha: identity.candidate_sha,
        tree: identity.tree_sha,
        checks: GITHUB_CHECK_NAMES.map((name) => ({ name, run: "true" })),
      });
      await createMergeCheckLog({
        dataDir: f.dataDir,
        project: f.project_id,
        attempt: identity.attempt_id,
      });
      if (mode === "restartFinished") journal.finish(journal.unfinished()[0]!);
    }
    const gate = new MergeChecks({
      ...c.options,
      git,
      githubClient: () => client as never,
    });
    const round = await gate.schedule([f.project_id]);
    await vi.waitFor(() => {
      expect(check()?.status).toBe("running");
      expect(client.run).toHaveBeenCalledTimes(
        mode.startsWith("restart") ? 2 : 1,
      );
    });
    const first = check()!;
    expect(first.executor).toEqual({ name: "github", type: "github" });
    expect(first.external_run?.run_id).toBe(123);
    if (mode === "invalidated") {
      const { updateCard } = await import("@cardigan/domain");
      f.apply((s, a, p) =>
        updateCard(s, a, { card_id: scenario.card.id, status: "cancelled" }, p),
      );
    }
    now += 20_000;
    await gate.schedule([f.project_id]);
    await round.done;
    if (mode === "invalidated") {
      const { GithubDispatchJournal } = await import("@cardigan/host");
      expect(client.cancel).toHaveBeenCalledWith(123);
      expect(new GithubDispatchJournal(f.store).unfinished()).toEqual([]);
      expect(check()?.status).not.toBe("passed");
      expect(c.git.publish).not.toHaveBeenCalled();
      expect(c.errors).not.toHaveBeenCalled();
      gate.stop();
      return;
    }
    expect(check()?.status).toBe(status);
    expect(client.dispatch).toHaveBeenCalledOnce();
    expect(pushCheckCandidate).toHaveBeenCalledOnce();
    expect(client.pollRuns).toHaveBeenCalledOnce();
    expect(c.run).not.toHaveBeenCalled();
    expect(c.options.sweep).not.toHaveBeenCalled();
    expect(c.git.distribute).not.toHaveBeenCalled();
    expect(c.errors).not.toHaveBeenCalled();
    expect(check()?.completion_id).toBe(completion.id);
    if (status === "failed") {
      expect(check()?.failure_excerpt).toContain("FAIL first [REDACTED]");
      const log = await readFile(
        join(f.dataDir, "merge-gate/logs", f.project_id, check()!.log_ref!),
        "utf8",
      );
      expect(log).toContain("[REDACTED]");
      expect(log + JSON.stringify(f.state().events)).not.toContain(
        "synthetic-private-value",
      );
      expect(log + JSON.stringify(f.state().events)).not.toContain(
        "ghp_synthetic123456",
      );
    }
    expect(
      f.state().cards.find((card) => card.id === scenario.card.id)?.status,
    ).toBe("awaiting_merge");
    if (mode === "passed") {
      const { updateCard } = await import("@cardigan/domain");
      git.deleteCheckCandidate.mockResolvedValueOnce(false);
      f.apply((s, a, p) =>
        updateCard(s, a, { card_id: scenario.card.id, status: "cancelled" }, p),
      );
      now += 20_000;
      await expect(gate.schedule([f.project_id])).resolves.toBeDefined();
      await vi.waitFor(() =>
        expect(git.deleteCheckCandidate).toHaveBeenCalledOnce(),
      );
      await vi.waitFor(() => expect(c.errors).toHaveBeenCalledOnce());
      const cleanup = Promise.withResolvers<boolean>();
      git.deleteCheckCandidate.mockImplementationOnce(() => cleanup.promise);
      now += 20_000;
      // Even a pending remote deletion cannot hold up the scheduling pass.
      await gate.schedule([f.project_id]);
      await vi.waitFor(() =>
        expect(git.deleteCheckCandidate).toHaveBeenCalledTimes(2),
      );
      cleanup.resolve(true);
      const { GithubDispatchJournal } = await import("@cardigan/host");
      await vi.waitFor(() =>
        expect(new GithubDispatchJournal(f.store).all()[0]?.deleted).toBe(true),
      );
      expect(client.dispatch).toHaveBeenCalledOnce();
    }
    gate.stop();
  },
);

test.each([
  "recover",
  "security",
  "invalidated",
  "host_stop",
  "late_invalidated",
  "completion_changed",
] as const)(
  "C-334: lost dispatch keeps original recovery identity (%s)",
  async (mode) => {
    const start = Date.parse("2030-01-01T00:00:00Z");
    let time = start;
    const { f, check, completion } = await fixture("confirm", {
      clock: { now: () => new Date(time).toISOString() },
    });
    const c = controller(f);
    const {
      GithubClient,
      GithubRateLimit,
      GithubBudgetJournal,
      GITHUB_CHECK_NAMES,
      GITHUB_WORKFLOW_STEPS,
      githubCheckRunName,
      GithubDispatchJournal,
    } = await import("@cardigan/host");
    const { mergeExecutorOutage } = await import("@cardigan/domain");
    const config = {
      name: "github",
      type: "github" as const,
      repo: "fixture/project",
      workflow: ".github/workflows/check.yml",
      appId: 1,
      installationId: 2,
      privateKeyFile: "/synthetic/app.pem",
      botLogin: "fixture[bot]",
      maxConcurrent: 1,
    };
    c.setConfig({
      status: "enabled",
      executor: config,
      checks: GITHUB_CHECK_NAMES.map((name) => ({ name, run: "true" })),
      env: {},
      totalTimeoutMs: 3_600_000,
    });
    let inputs: Readonly<Record<string, string>> = {};
    const target = () => ({
      id: 123,
      run_attempt: 1,
      path: config.workflow,
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: "a".repeat(40),
      actor: { login: mode === "security" ? "other[bot]" : config.botLogin },
      display_title: githubCheckRunName(inputs),
      html_url: `https://github.com/${config.repo}/actions/runs/123`,
      created_at: new Date(start).toISOString(),
      status: "completed",
      conclusion: "success",
    });
    let invalidatedDuringQuery = false;
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/dispatches")) {
          inputs = JSON.parse(String(init?.body)).inputs;
          throw new Error("ghs_synthetic response lost");
        }
        if (url.pathname.endsWith("/jobs"))
          return new Response(
            JSON.stringify({
              total_count: 1,
              jobs: [
                {
                  id: 456,
                  run_id: 123,
                  run_attempt: 1,
                  head_sha: "a".repeat(40),
                  name: "check",
                  status: "completed",
                  conclusion: "success",
                  steps: GITHUB_WORKFLOW_STEPS.map((name, i) => ({
                    name,
                    number: i + 1,
                    status: "completed",
                    conclusion: "success",
                  })),
                },
              ],
            }),
          );
        if (url.pathname.endsWith("/runs/123"))
          return new Response(JSON.stringify(target()));
        if (url.searchParams.has("created")) {
          if (mode === "host_stop") restarted.stop();
          if (mode === "completion_changed" && !invalidatedDuringQuery) {
            invalidatedDuringQuery = true;
            f.decide(
              required(mergeConfirmation(f, inputs.card!)),
              "request_changes",
            );
          }
          if (mode === "late_invalidated" && !invalidatedDuringQuery) {
            invalidatedDuringQuery = true;
            const { updateCard } = await import("@cardigan/domain");
            f.apply((s, a, p) =>
              updateCard(
                s,
                a,
                { card_id: inputs.card as never, status: "cancelled" },
                p,
              ),
            );
          }
          const [from, to] = url.searchParams
            .get("created")!
            .split("..")
            .map(Date.parse);
          const records = [
            target(),
            ...Array.from({ length: 1001 }, (_, i) => ({
              ...target(),
              id: 1000 + i,
              display_title: `other-${i}`,
              html_url: `https://github.com/${config.repo}/actions/runs/${1000 + i}`,
              created_at: new Date(start + ((i % 20) + 1) * 1000).toISOString(),
            })),
          ]
            .filter(
              (run) =>
                Date.parse(run.created_at) >= from! &&
                Date.parse(run.created_at) <= to!,
            )
            .sort(
              (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
            );
          const page = Number(url.searchParams.get("page"));
          return new Response(
            JSON.stringify({
              total_count: records.length,
              workflow_runs: records
                .slice(0, 1000)
                .slice((page - 1) * 100, page * 100),
            }),
          );
        }
        return new Response(JSON.stringify({ workflow_runs: [target()] }));
      },
    );
    const clientFactory = vi.fn(() => {
      const client = new GithubClient({
        config,
        dataDir: f.dataDir,
        now: () => time,
        fetch: fetcher as typeof fetch,
        rate: new GithubRateLimit(
          undefined,
          () => time,
          new GithubBudgetJournal(f.store, config.name),
        ),
      });
      vi.spyOn(client, "token").mockResolvedValue("ghs_synthetic");
      return client;
    });
    const push = vi.fn(async () => ({ status: "pushed" as const }));
    const options = {
      ...c.options,
      git: {
        ...c.git,
        pushCheckCandidate: push,
        isBaselineAncestor: vi.fn(async () => true),
      },
      githubClient: clientFactory,
    };
    const first = new MergeChecks(options);
    const restarted = new MergeChecks(options);
    try {
      await first.tick([f.project_id]);
      expect(check()?.status).toBe("queued");
      const attempt = check()?.attempt_id;
      expect(new GithubDispatchJournal(f.store).unfinished()).toMatchObject([
        { attempt, phase: "dispatching" },
      ]);
      first.stop();
      time = Date.parse(
        mergeExecutorOutage(f.state(), config.name)!.next_retry_at,
      );
      if (mode === "invalidated") {
        const { updateCard } = await import("@cardigan/domain");
        f.apply((s, a, p) =>
          updateCard(
            s,
            a,
            { card_id: inputs.card as never, status: "cancelled" },
            p,
          ),
        );
        const sent = fetcher.mock.calls.length;
        await restarted.tick([f.project_id]);
        expect(fetcher).toHaveBeenCalledTimes(sent);
        expect(new GithubDispatchJournal(f.store).unfinished()).toMatchObject([
          { attempt, phase: "dispatching" },
        ]);
        return;
      }
      const round = await restarted.schedule([f.project_id]);
      if (mode === "late_invalidated" || mode === "completion_changed") {
        await vi.waitFor(() =>
          expect(
            new GithubDispatchJournal(f.store).unfinished()[0]?.externalRun
              ?.run_id,
          ).toBe(123),
        );
        expect(check()?.external_run).toBeUndefined();
        time += 20_000;
        await restarted.schedule([f.project_id]);
        await round.done;
        expect(
          f.state().cards.find((card) => card.id === inputs.card)?.status,
        ).toBe(mode === "completion_changed" ? "in_progress" : "cancelled");
        if (mode === "completion_changed")
          expect(
            f.state().deliveries.find((d) => d.id === completion.id)?.status,
          ).toBe("superseded");
        expect(check()?.status).toBe("queued");
        expect(check()?.external_run).toBeUndefined();
        expect(
          f.state().events.some((e) => e.type === "merge_check_started"),
        ).toBe(false);
        expect(push).toHaveBeenCalledOnce();
        expect(
          fetcher.mock.calls.filter(([url]) =>
            String(url).endsWith("/dispatches"),
          ),
        ).toHaveLength(1);
        return;
      }
      if (mode === "host_stop") {
        await round.done;
        // Host stop detaches supervision. A late discovery may persist its
        // trusted identity, but cannot publish readiness or cancel the run.
        await vi.waitFor(() =>
          expect(
            new GithubDispatchJournal(f.store).unfinished()[0]?.externalRun
              ?.run_id,
          ).toBe(123),
        );
        expect(check()?.status).toBe("queued");
        expect(check()?.external_run).toBeUndefined();
        const sent = fetcher.mock.calls.length;
        await restarted.tick([f.project_id]);
        expect(fetcher).toHaveBeenCalledTimes(sent);
        expect(
          fetcher.mock.calls.some(([url]) => String(url).endsWith("/cancel")),
        ).toBe(false);
        const successor = new MergeChecks(options);
        try {
          const resumed = await successor.schedule([f.project_id]);
          await vi.waitFor(() => expect(check()?.status).toBe("running"));
          time += 20_000;
          await successor.schedule([f.project_id]);
          await resumed.done;
          expect(check()?.status).toBe("passed");
          expect(check()?.attempt_id).toBe(attempt);
          expect(push).toHaveBeenCalledOnce();
          expect(
            fetcher.mock.calls.filter(([url]) =>
              String(url).endsWith("/dispatches"),
            ),
          ).toHaveLength(1);
          expect(
            fetcher.mock.calls.some(([url]) => String(url).endsWith("/cancel")),
          ).toBe(false);
        } finally {
          successor.stop();
        }
        return;
      }
      if (mode === "security") {
        await round.done;
        expect(check()?.status).toBe("executor_unreachable");
        expect(check()?.external_run).toBeUndefined();
        expect(check()?.attempt_id).toBe(attempt);
        if (mode === "security") expect(check()?.summary).toContain("security");
        expect(new GithubDispatchJournal(f.store).unfinished()).toMatchObject([
          { attempt, phase: "dispatching" },
        ]);
        const sent = fetcher.mock.calls.length;
        time += 20_000;
        await restarted.tick([f.project_id]);
        expect(fetcher).toHaveBeenCalledTimes(sent);
        expect(push).toHaveBeenCalledOnce();
        expect(
          fetcher.mock.calls.filter(([url]) =>
            String(url).endsWith("/dispatches"),
          ),
        ).toHaveLength(1);
        return;
      }
      await vi.waitFor(() => expect(check()?.status).toBe("running"));
      expect(check()?.attempt_id).toBe(attempt);
      expect(check()?.external_run?.run_id).toBe(123);
      time += 20_000;
      await restarted.schedule([f.project_id]);
      await round.done;
      expect(check()?.status).toBe("passed");
      expect(check()?.attempt_id).toBe(attempt);
      expect(push).toHaveBeenCalledOnce();
      expect(
        fetcher.mock.calls.filter(([url]) =>
          String(url).endsWith("/dispatches"),
        ),
      ).toHaveLength(1);
      expect(clientFactory).toHaveBeenCalledTimes(2); // One shared client per controller generation.
      expect(
        new GithubBudgetJournal(f.store, config.name).update(
          (state) => state.used,
        ),
      ).toBe(fetcher.mock.calls.length);
      expect(new GithubDispatchJournal(f.store).unfinished()).toEqual([]);
      expect(c.run).not.toHaveBeenCalled();
      expect(c.git.distribute).not.toHaveBeenCalled();
      expect(JSON.stringify(f.state().events)).not.toContain("ghs_synthetic");
    } finally {
      first.stop();
      restarted.stop();
    }
  },
);

test.each([1, 2])(
  "A1a: host failure diagnostics reach the version %s author's fix notification after redaction",
  async (flow_version) => {
    const { f, scenario, check } = await fixture();
    const card = { ...f.card(), flow_version };
    f.store.uow.run((tx) => tx.cards.put(f.project_id, card));
    const c = controller(f);
    c.run.mockImplementation(async (input) => {
      input.onReady?.();
      input.onOutput?.(
        "test",
        "FAIL src/a.test.ts > expected fixture-secret\nError: assertion failed\n",
      );
      return {
        status: "failed",
        checks: [{ name: "test", status: "failed", exit_code: 1 }],
        cleanup_errors: [],
      };
    });
    await c.gate.tick([f.project_id]);
    expect(check()?.failure_excerpt).toBeUndefined();
    const diagnostic = "FAIL src/a.test.ts > expected [REDACTED]";
    expect(check()?.summary).toContain(diagnostic);
    const returned = f
      .state()
      .events.find((e) => e.type === "merge_changes_requested");
    if (flow_version === 1) {
      expect(returned).toBeUndefined();
      expect(f.card().status).toBe("awaiting_merge");
    } else {
      if (!returned) throw new Error("Missing system return");
      expect(returned.payload).toMatchObject({
        reason: expect.stringContaining("合并检查 failed：test"),
      });
      expect(returned.payload).toMatchObject({
        reason: expect.stringContaining(diagnostic),
      });
      expect(
        routeEvent({ event: returned, snapshot: f.state() }).notifications,
      ).toMatchObject([
        {
          recipient: { kind: "assignment", assignment_id: scenario.coder.id },
          run_kind: "fix",
          summary: expect.stringContaining(diagnostic),
        },
      ]);
    }
    expect(JSON.stringify(f.state().events)).not.toContain("fixture-secret");
    expect(c.errors).not.toHaveBeenCalled();
  },
);

test("A1a: an entry failure with no executed steps retains the safe host diagnosis in the fix notification", async () => {
  const { f, check } = await fixture();
  const card = { ...f.card(), flow_version: 2 };
  f.store.uow.run((tx) => tx.cards.put(f.project_id, card));
  const c = controller(f);
  c.git.distribute.mockRejectedValue(new Error("fixture-secret"));
  await c.gate.tick([f.project_id]);
  expect(check()).toMatchObject({ status: "failed", checks: [] });
  const diagnostic = "候选同步或检查执行入口失败，请检查执行环境";
  expect(check()?.summary).toContain(diagnostic);
  const returned = f
    .state()
    .events.find((e) => e.type === "merge_changes_requested");
  if (!returned) throw new Error("Missing system return");
  expect(
    routeEvent({ event: returned, snapshot: f.state() }).notifications,
  ).toMatchObject([
    { run_kind: "fix", summary: expect.stringContaining(diagnostic) },
  ]);
  expect(JSON.stringify(f.state().events)).not.toContain("fixture-secret");
  expect(c.run).not.toHaveBeenCalled();
});

async function reworkGithubFixture(
  options: { log?: string; excerptBytes?: number } = {},
) {
  let now = Date.parse("2030-01-01T00:00:00Z");
  let conclusion: "success" | "failure" | undefined;
  const state = await fixture("confirm", {
    clock: { now: () => new Date(now).toISOString() },
  });
  const { f } = state;
  const c = controller(f);
  const { GITHUB_CHECK_NAMES, GITHUB_WORKFLOW_STEPS, githubCheckRunName } =
    await import("@cardigan/host");
  const config = {
    name: "github",
    type: "github" as const,
    repo: "fixture/project",
    workflow: ".github/workflows/check.yml",
    appId: 1,
    installationId: 2,
    privateKeyFile: "/synthetic/app.pem",
    botLogin: "fixture[bot]",
    maxConcurrent: 1,
    ...(options.excerptBytes
      ? { failureExcerptBytes: options.excerptBytes }
      : {}),
  };
  c.setConfig({
    status: "enabled",
    executor: config,
    checks: GITHUB_CHECK_NAMES.map((name) => ({ name, run: "true" })),
    env: { SECRET: "synthetic-private-value" },
    totalTimeoutMs: 3600_000,
  });
  let inputs: Readonly<Record<string, string>> = {};
  const run = () => ({
    id: 123,
    run_attempt: 1,
    path: config.workflow,
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: "a".repeat(40),
    actor: { login: config.botLogin },
    display_title: githubCheckRunName(inputs),
    html_url: "https://github.com/fixture/project/actions/runs/123",
    created_at: "2030-01-01T00:00:00.000Z",
    status: conclusion ? "completed" : "in_progress",
    conclusion: conclusion ?? null,
  });
  const client = {
    token: vi.fn(async () => "ghs_synthetic"),
    dispatch: vi.fn(
      async (_ref: string, value: Readonly<Record<string, string>>) => {
        inputs = value;
        return 123;
      },
    ),
    run: vi.fn(async () => run()),
    runs: vi.fn(async () => []),
    pollRuns: vi.fn(async () => ({
      unchanged: false,
      runs: [run()],
      etag: "x",
    })),
    jobs: vi.fn(async () => [
      {
        id: 456,
        run_id: 123,
        run_attempt: 1,
        head_sha: "a".repeat(40),
        name: "check",
        status: "completed",
        conclusion: conclusion ?? "success",
        steps: GITHUB_WORKFLOW_STEPS.map((name, index) => ({
          name,
          number: index + 1,
          status: "completed",
          conclusion:
            conclusion === "failure" && name === "test" ? "failure" : "success",
        })),
      },
    ]),
    cancel: vi.fn(async () => {}),
    jobLog: vi.fn(async () => options.log ?? "FAIL synthetic\n"),
  };
  const git = {
    ...c.git,
    pushCheckCandidate: vi.fn(async () => ({ status: "pushed" as const })),
    isBaselineAncestor: vi.fn(async () => true),
  };
  const create = () =>
    new MergeChecks({ ...c.options, git, githubClient: () => client as never });
  return {
    ...state,
    c,
    client,
    git,
    create,
    advance: (ms = 20_000) => {
      now += ms;
    },
    complete: (status: "success" | "failure") => {
      conclusion = status;
    },
    now: () => now,
  };
}

test.each(["sk-learn", "ghp_x", "-----END RSA PRIVATE KEY-----"])(
  "D4 rework: SSH failure containing %s records once without an excerpt or repeated execution",
  async (marker) => {
    const { f, check } = await fixture();
    const c = controller(f);
    c.run.mockImplementation(async (input) => {
      input.onReady?.();
      input.onOutput?.("test", `FAIL uses ${marker} ids\n`);
      return {
        status: "failed",
        checks: [{ name: "test", status: "failed", exit_code: 1 }],
        cleanup_errors: [],
      };
    });
    for (let pass = 0; pass < 3; pass++) await c.gate.tick([f.project_id]);
    expect(check()?.status).toBe("failed");
    expect(check()?.failure_excerpt).toBeUndefined();
    expect(c.run).toHaveBeenCalledOnce();
    expect(c.errors).not.toHaveBeenCalled();
  },
);

test.each(["markers", "controls", "clipped"])(
  "D4 rework: GitHub %s diagnostics cannot strand a trusted failed attempt",
  async (mode) => {
    const prefix = "FAIL authorization: bearer ";
    const log =
      mode === "markers"
        ? "FAIL uses sk-learn ghp_x -----END RSA PRIVATE KEY-----\n"
        : mode === "controls"
          ? "FAIL leak synth\u200betic-private-value synth\u0000etic-private-value ghp_\u200bsynthetic123456\n"
          : `${prefix}ghs_synthetic\n`;
    const h = await reworkGithubFixture({
      log,
      ...(mode === "clipped"
        ? { excerptBytes: Buffer.byteLength(prefix) + 4 }
        : {}),
    });
    const gate = h.create();
    const round = await gate.schedule([h.f.project_id]);
    await vi.waitFor(() => expect(h.check()?.status).toBe("running"));
    const attempt = h.check()?.attempt_id;
    h.complete("failure");
    h.advance();
    await gate.schedule([h.f.project_id]);
    await round.done;
    expect(h.check()?.status).toBe("failed");
    expect(h.check()?.attempt_id).toBe(attempt);
    if (mode === "clipped") expect(h.check()?.failure_excerpt).toBeUndefined();
    else expect(h.check()?.failure_excerpt).toContain("[REDACTED]");
    const contents = await readFile(
      join(h.f.dataDir, "merge-gate/logs", h.f.project_id, h.check()!.log_ref!),
      "utf8",
    );
    expect(contents + JSON.stringify(h.f.state().events)).not.toContain(
      "synthetic-private-value",
    );
    expect(contents + JSON.stringify(h.f.state().events)).not.toContain(
      "ghp_synthetic123456",
    );
    for (let pass = 0; pass < 3; pass++) {
      h.advance();
      await gate.tick([h.f.project_id]);
    }
    expect(h.client.dispatch).toHaveBeenCalledOnce();
    expect(h.client.jobs).toHaveBeenCalledOnce();
    expect(h.client.jobLog).toHaveBeenCalledOnce();
    expect(h.c.errors).not.toHaveBeenCalled();
    gate.stop();
    await gate.idle();
  },
);

test.each([false, true])(
  "D4 rework: normal stop/start preserves bound run and attempt (recovery limited=%s)",
  async (limited) => {
    const h = await reworkGithubFixture();
    const first = h.create();
    const initial = await first.schedule([h.f.project_id]);
    await vi.waitFor(() => expect(h.check()?.status).toBe("running"));
    const original = h.check()!;
    first.stop();
    await first.idle();
    await initial.done;
    expect(h.client.cancel).not.toHaveBeenCalled();
    expect(h.check()?.status).toBe("running");
    const second = h.create();
    if (limited) {
      const { GithubRetryLater } = await import("@cardigan/host");
      h.client.run.mockRejectedValueOnce(
        new GithubRetryLater(h.now() + 60_000),
      );
      await second.tick([h.f.project_id]);
      expect(h.check()?.status).toBe("running");
      expect(h.check()?.attempt_id).toBe(original.attempt_id);
      expect(h.client.cancel).not.toHaveBeenCalled();
      h.advance();
      await second.tick([h.f.project_id]);
      expect(h.client.run).toHaveBeenCalledTimes(2);
      h.advance(40_000);
    }
    const resumed = await second.schedule([h.f.project_id]);
    await vi.waitFor(() =>
      expect(h.client.run).toHaveBeenCalledTimes(limited ? 3 : 2),
    );
    h.complete("success");
    h.advance();
    await second.schedule([h.f.project_id]);
    await resumed.done;
    expect(h.check()?.status).toBe("passed");
    expect(h.check()?.attempt_id).toBe(original.attempt_id);
    expect(h.check()?.external_run).toEqual(original.external_run);
    expect(h.client.cancel).not.toHaveBeenCalled();
    expect(h.client.dispatch).toHaveBeenCalledOnce();
    expect(h.git.pushCheckCandidate).toHaveBeenCalledOnce();
    expect(h.c.errors).not.toHaveBeenCalled();
    second.stop();
    await second.idle();
  },
);

test("A1d: a fresh rechecked completion prepares on the advanced baseline and ignores its old failed target", async () => {
  const f = m4Fixture();
  fixtures.push(f);
  const seeded = await seedReturnedRecheck(f.store);
  const params = {
    card_id: seeded.f.card.id,
    reason: "Unrelated synthetic failure",
  };
  const actor = seeded.f.actor(seeded.f.coder);
  const read = () =>
    f.store.uow.read((tx) => loadCommandState(tx, seeded.project));
  const proof = value(
    await prepareRecheck(read(), actor, params, recheckVerifier()),
  );
  const result = f.store.uow.run((tx) => {
    const e = value(
      requestRecheck(
        loadCommandState(tx, seeded.project),
        actor,
        params,
        proof,
        { clock: f.clock, ids: tx.ids },
      ),
    );
    persistEffect(tx, seeded.project, e);
    return e.data;
  });
  // Synthetic fixture helpers leave their verification Runs open; finish them
  // before requesting the host's normal two-slot check allocation.
  f.store.uow.run((tx) => {
    for (const r of tx.runs.list(seeded.project))
      if (r.assignment_id !== seeded.f.coder.id && r.status === "running")
        tx.runs.put(seeded.project, {
          ...r,
          status: "completed",
          outcome: "completed",
          summary: "Reviewed",
          finished_at: f.clock.now(),
        });
  });
  const c = controller(f);
  c.advance(true);
  await c.gate.tick([seeded.project]);
  expect(c.errors).not.toHaveBeenCalled();
  const state = read();
  expect(
    latestMergeCheck(state.events, seeded.f.card.id, result.completion.id),
  ).toMatchObject({ status: "passed" });
  expect(
    latestMergeCheck(state.events, seeded.f.card.id, seeded.completion.id),
  ).toMatchObject({ status: "failed" });
  expect(c.git.prepare).toHaveBeenCalledTimes(1);
  expect(c.git.prepare.mock.calls[0]?.[1]).toMatchObject({
    completion_id: result.completion.id,
    deliveries: [{ delivery_id: result.product.id }],
  });
  expect(c.run).toHaveBeenCalledTimes(1);
  expect(c.git.publish).not.toHaveBeenCalled();
  expect(c.errors).not.toHaveBeenCalled();
  expect(state.reviews).toEqual(seeded.f.state.reviews);
});
