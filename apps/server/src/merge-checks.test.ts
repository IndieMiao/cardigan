import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  latestMergeCheck,
  listNeedsYou,
  prepareMergePlan,
  recheckMerge,
  recordMergeCheck,
} from "@cardigan/domain";
import type { CentralProject, PreparedMerge } from "@cardigan/git-service";
import {
  acquireMergeCheckCapacity,
  type CheckoutInput,
  type CheckoutResult,
  type ProjectMergeGate,
  runCapacitySnapshot,
} from "@cardigan/host";
import { afterEach, expect, test, vi } from "vitest";
import {
  acceptThroughMergeGate,
  type M4Fixture,
  m4Fixture,
  m4Scenario,
  mergeConfirmation,
} from "./m4-fixtures.js";
import { MergeChecks } from "./merge-checks.js";
import { MergeExecutor, startMergeLoop } from "./merge-loop.js";
import { needsYou } from "./web/read.js";

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
      ) => {
        base = candidate.candidate_sha;
        return {
          status: "merged" as const,
          merge_sha: candidate.candidate_sha,
          tree_sha: candidate.tree_sha,
          previous_sha: candidate.previous_sha,
        };
      },
    ),
    distribute: vi.fn(async () => {}),
  };
  const errors = vi.fn();
  const options = {
    store: f.store,
    execution: { mode: "local" as const, dataDir: f.dataDir },
    git,
    run,
    clock: f.clock,
    onError: errors,
    configuration: { errors: [], forProject: () => settings },
  };
  const gate = new MergeChecks(options);
  return {
    gate,
    git,
    run,
    errors,
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
  ).not.toContain(q.id);
  expect(
    needsYou(f.state(), f.clock.now(), "enabled").waiting_merge_checks_count,
  ).toBe(1);
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
    c.run.mockImplementationOnce(async (input) => {
      input.onReady?.();
      return {
        status,
        checks: [{ name: "test", status, exit_code: 1 }],
        cleanup_errors: [],
      };
    });
    await c.gate.tick([f.project_id]);
    expect(check()?.status).toBe(status);
    expect(c.git.publish).not.toHaveBeenCalled();
    f.decide(decision, "request_changes");
    await c.gate.tick([f.project_id]);
    expect(c.run).toHaveBeenCalledTimes(1);
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
      expect(ready.card().status).toBe("awaiting_merge");
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
