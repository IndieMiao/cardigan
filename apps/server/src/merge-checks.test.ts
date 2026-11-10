import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  latestMergeCheck,
  prepareMergePlan,
  recheckMerge,
  recordMergeCheck,
} from "@cardigan/domain";
import type { CentralProject, PreparedMerge } from "@cardigan/git-service";
import type {
  CheckoutInput,
  CheckoutResult,
  ProjectMergeGate,
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
  f.decide(required(mergeConfirmation(f, scenario.card.id)), "merge");
  await c.gate.tick([f.project_id]);
  expect(f.card().status).toBe("done");
  expect(c.run).not.toHaveBeenCalled();
  expect(c.git.publish).not.toHaveBeenCalled();
  expect(prepareMergePlan(f.state(), scenario.card.id).ok).toBe(false);
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
