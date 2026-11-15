import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { prechecks, prepareCheck, requestCheck } from "@cardigan/domain";
import {
  CHECK_SUMMARY_LIMIT,
  type CheckExecutor,
  CheckRecovery,
  createMergeCheckLog,
  type ProjectMergeGate,
} from "@cardigan/host";
import { CheckHandoffs } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { value } from "../../../packages/domain/src/commands/test-fixtures.js";
import { AuthorPrechecks } from "./author-prechecks.js";
import {
  acceptThroughMergeGate,
  type M4Fixture,
  m4Fixture,
  m4Scenario,
} from "./m4-fixtures.js";
import { MergeChecks } from "./merge-checks.js";

const fixtures: M4Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
async function setup() {
  let clockMs = Date.parse("2030-01-01T00:00:00Z");
  const f = m4Fixture({
    clock: { now: () => new Date(clockMs).toISOString() },
  });
  fixtures.push(f);
  const s = m4Scenario(f);
  f.store.uow.run((tx) => {
    tx.cards.put(f.project_id, { ...s.card, flow_version: 3 });
    tx.assignments.put(f.project_id, {
      ...s.coder,
      branch: "agent/author",
      worktree_path: join(f.dataDir, "worktree"),
    });
    const role = tx.roles.get(f.project_id, {
      role_id: "coder",
      role_version: 1,
    })!;
    tx.roles.put(f.project_id, {
      ...role,
      allowed_tools: [...role.allowed_tools, "request_check"],
    });
  });
  const settings: Extract<ProjectMergeGate, { status: "enabled" }> = {
    status: "enabled",
    checks: [{ name: "test", run: "synthetic-command" }],
    env: { SECRET: "synthetic-secret-value" },
    totalTimeoutMs: 20000,
    executor: {
      name: "ci",
      host: "example.invalid",
      port: 22,
      user: "fixture",
      hostKeyAlias: "fixture",
      identityFile: "/synthetic/id",
      knownHostsFile: "/synthetic/hosts",
      agentRoot: "/synthetic/agent",
      maxConcurrent: 1,
    },
  };
  const configuration = { forProject: () => settings };
  let head = "a".repeat(40);
  const project = {
    project_id: f.project_id,
    source_repo: "fixture",
    base_branch: "main",
  };
  const git = {
    projectOf: () => project,
    checkHead: vi.fn(async () => head),
    preparePrecheck: vi.fn(async () => ({
      candidate_sha: "b".repeat(40),
      base_sha: "c".repeat(40),
      tree_sha: "d".repeat(40),
    })),
    distribute: vi.fn(async () => {}),
  };
  const errors: unknown[] = [];
  const signal = new AbortController();
  const reserve = vi.fn(async () => ({ index: 0, release: vi.fn() }));
  const run = vi.fn(
    async (
      input: Parameters<
        NonNullable<ConstructorParameters<typeof AuthorPrechecks>[0]["run"]>
      >[0],
    ) => {
      input.onReady?.();
      input.onOutput?.(
        "test",
        "FAIL src/example.test.ts > case\n/secret/private/path token=synthetic-secret-value",
      );
      return {
        status: "failed" as const,
        checks: [{ name: "test", status: "failed" as const, exit_code: 1 }],
        cleanup_errors: [],
      };
    },
  );
  const recovery = new CheckRecovery({
    store: f.store,
    clock: f.clock,
    execution: { mode: "local" as const, dataDir: f.dataDir },
    executor: () => settings.executor,
  });
  const options = {
    store: f.store,
    clock: f.clock,
    execution: { mode: "local" as const, dataDir: f.dataDir },
    configuration,
    git,
    signal: signal.signal,
    onError: (e: unknown) => errors.push(e),
    reserve,
    github: () => {
      throw new Error("Unexpected GitHub");
    },
    run,
    recovery,
  };
  const queue = async () => {
    const p = { work_item_id: s.development.id };
    const actor = f.actorFor(s.coder, ["request_check"]);
    const proof = value(
      await prepareCheck(f.state(), actor, p, { head: async () => head }),
    );
    return f.apply(
      (state, a, ports) => requestCheck(state, a, p, proof, ports),
      actor,
    );
  };
  const check = () => prechecks(f.state().events).at(-1)!;
  return {
    f,
    s,
    settings,
    options,
    git,
    run,
    errors,
    queue,
    check,
    reserve,
    advance: () => {
      clockMs += 30000;
    },
    setHead: (value: string) => {
      head = value;
    },
  };
}
test("author request runs the full configured checks through D1, persists redacted failure, notifies only its owner and never reexecutes a terminal attempt", async () => {
  const x = await setup();
  await x.queue();
  const host = new AuthorPrechecks(x.options);
  await (await host.schedule([x.f.project_id])).done;
  expect(x.run).toHaveBeenCalledTimes(1);
  expect(x.run.mock.calls[0]?.[0].checks).toEqual([
    { name: "test", run: "synthetic-command" },
  ]);
  expect(x.check()).toMatchObject({
    status: "failed",
    head_sha: "a".repeat(40),
    candidate_sha: "b".repeat(40),
  });
  const log = await readFile(
    join(x.f.dataDir, "merge-gate", "logs", x.f.project_id, x.check().log_ref!),
    "utf8",
  );
  expect(log).toContain("src/example.test.ts");
  expect(log).not.toContain("synthetic-secret-value");
  expect(log).not.toContain("/secret/private/path");
  expect(
    Number(
      x.f.store.database
        .prepare("SELECT COUNT(*) AS n FROM merge_check_capacity")
        .get()?.n ?? 0,
    ),
  ).toBe(0);
  await (await new AuthorPrechecks(x.options).schedule([x.f.project_id])).done;
  expect(x.run).toHaveBeenCalledTimes(1);
});
test.each(["head", "release"])(
  "%s changes while running invalidate late success",
  async (change) => {
    const x = await setup();
    await x.queue();
    x.options.run = vi.fn(async (input) => {
      input.onReady?.();
      if (change === "head") x.setHead("e".repeat(40));
      else
        x.f.store.uow.run((tx) =>
          tx.assignments.put(x.f.project_id, {
            ...tx.assignments.get(x.f.project_id, x.s.coder.id)!,
            status: "released",
          }),
        );
      return {
        status: "passed" as const,
        checks: [{ name: "test", status: "passed" as const, exit_code: 0 }],
        cleanup_errors: [],
      };
    });
    await (await new AuthorPrechecks(x.options).schedule([x.f.project_id]))
      .done;
    expect(x.check().status).toBe("interrupted");
  },
);
test("the durable project fence blocks new work, clearing it resumes the original queued attempt", async () => {
  const x = await setup();
  await x.queue();
  const fences = new CheckHandoffs(x.f.store, "test-controller");
  const row = fences.begin(x.f.project_id, "ci", "binding");
  const host = new AuthorPrechecks(x.options);
  await (await host.schedule([x.f.project_id])).done;
  expect(x.run).not.toHaveBeenCalled();
  expect(x.check().status).toBe("queued");
  fences.resume(x.f.project_id, "ci", row.generation, "exited");
  await (await host.schedule([x.f.project_id])).done;
  expect(x.run).toHaveBeenCalledTimes(1);
});
test("log finish failure persists one explicit terminal, releases capacity, and only an explicit new author request runs again", async () => {
  const x = await setup();
  await x.queue();
  const host = new AuthorPrechecks({
    ...x.options,
    createLog: async (input) => {
      const log = await createMergeCheckLog(input);
      return {
        ...log,
        finish: async (result) => {
          await log.finish(result);
          throw new Error("synthetic log finish failure");
        },
      };
    },
  });
  await (await host.schedule([x.f.project_id])).done;
  expect(x.check().status).toBe("environment_failed");
  expect(x.errors).toHaveLength(1);
  await (await host.schedule([x.f.project_id])).done;
  expect(x.run).toHaveBeenCalledTimes(1);
  expect(
    Number(
      x.f.store.database
        .prepare("SELECT COUNT(*) AS n FROM merge_check_capacity")
        .get()?.n ?? 0,
    ),
  ).toBe(0);
  await x.queue();
  await (await new AuthorPrechecks(x.options).schedule([x.f.project_id])).done;
  expect(x.run).toHaveBeenCalledTimes(2);
});
test("old HEAD is refused before execution and a Git failure preserves a safe failure stage", async () => {
  const x = await setup();
  await x.queue();
  x.setHead("e".repeat(40));
  await (await new AuthorPrechecks(x.options).schedule([x.f.project_id])).done;
  expect(x.check().status).toBe("interrupted");
  expect(x.run).not.toHaveBeenCalled();
  await x.queue();
  x.git.preparePrecheck.mockRejectedValue(
    new Error("private /credential/path token=secret"),
  );
  await (await new AuthorPrechecks(x.options).schedule([x.f.project_id])).done;
  expect(x.check()).toMatchObject({
    status: "environment_failed",
    summary: expect.stringContaining("准备候选"),
  });
  expect(JSON.stringify(x.errors)).not.toContain("credential");
});
test("the merge scheduler starts executable merges before author work and does not preempt running author work", async () => {
  const x = await setup();
  await x.queue();
  const merge = m4Scenario(x.f);
  await acceptThroughMergeGate(x.f, merge, "e".repeat(40));
  const order: string[] = [];
  const git = {
    ...x.git,
    sync: async () => "up_to_date" as const,
    baseline: async () => "c".repeat(40),
    prepare: async () => ({
      status: "candidate" as const,
      candidate_sha: "f".repeat(40),
      tree_sha: "d".repeat(40),
      previous_sha: "c".repeat(40),
    }),
    merge: async () => {
      throw new Error("No legacy merge");
    },
    publish: async () => ({ status: "stale" as const }),
    changedPaths: async () => [],
    readWorkspace: async () => [],
  };
  const executor: CheckExecutor = {
    dispatch: async (r) => {
      order.push(r.kind);
      r.onReady?.();
      return { id: r.kind };
    },
    poll: async () => ({
      status: "passed",
      checks: [{ name: "test", status: "passed", exit_code: 0 }],
      cleanup_errors: [],
    }),
    cancel: async () => {},
    fetchFailureLog: async () => undefined,
  };
  const controller = new MergeChecks({
    store: x.f.store,
    clock: x.f.clock,
    execution: x.options.execution,
    configuration: x.options.configuration,
    git,
    checkExecutor: executor,
    onError: (e) => x.errors.push(e),
    sweep: async () => {},
    recover: async () => ({ status: "cleaned", processes: [] }),
  });
  await controller.tick([x.f.project_id]);
  await controller.tick([x.f.project_id]);
  expect(order).toEqual(["merge_check", "precheck"]);
  expect(x.check().status).toBe("passed");
});

test("GitHub author prechecks dispatch kind=precheck and resume the original bound run after host shutdown", async () => {
  const x = await setup();
  await x.queue();
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
  x.settings.executor = config;
  x.settings.checks = GITHUB_CHECK_NAMES.map((name) => ({
    name,
    run: "synthetic",
  }));
  let inputs: Readonly<Record<string, string>> = {},
    complete = false;
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
    status: complete ? "completed" : "in_progress",
    conclusion: complete ? "success" : null,
  });
  const client = {
    token: vi.fn(async () => "ghs_synthetic"),
    dispatch: vi.fn(
      async (_ref: string, p: Readonly<Record<string, string>>) => {
        inputs = p;
        return 123;
      },
    ),
    run: vi.fn(async () => run()),
    runs: vi.fn(async () => []),
    pollRuns: vi.fn(async () => ({
      unchanged: false,
      runs: [run()],
      etag: "fixture",
    })),
    jobs: vi.fn(async () => [
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
    ]),
    cancel: vi.fn(async () => {}),
    jobLog: vi.fn(async () => ""),
  };
  const git = {
    ...x.git,
    sync: async () => "up_to_date" as const,
    merge: async () => {
      throw new Error("No merge");
    },
    pushCheckCandidate: vi.fn(async () => ({ status: "pushed" as const })),
    isBaselineAncestor: async () => true,
  };
  const options = {
    store: x.f.store,
    clock: x.f.clock,
    execution: x.options.execution,
    configuration: x.options.configuration,
    git,
    githubClient: () => client as never,
    onError: (e: unknown) => x.errors.push(e),
  };
  const first = new MergeChecks(options);
  const scheduled = await first.schedule([x.f.project_id]);
  await vi.waitFor(() => expect(x.check().status).toBe("running"));
  expect(inputs.kind).toBe("precheck");
  expect(inputs.delivery).toBe(x.s.coder.id);
  first.stop();
  await scheduled.done;
  await first.idle();
  expect(x.check().status).toBe("running");
  const resumed = new MergeChecks(options);
  const next = await resumed.schedule([x.f.project_id]);
  await vi.waitFor(() =>
    expect(client.run.mock.calls.length).toBeGreaterThan(1),
  );
  complete = true;
  x.advance();
  await resumed.schedule([x.f.project_id]);
  await next.done;
  expect(x.check()).toMatchObject({
    status: "passed",
    external_run: { run_id: 123, run_attempt: 1 },
  });
  expect(client.dispatch).toHaveBeenCalledTimes(1);
  expect(git.pushCheckCandidate).toHaveBeenCalledTimes(1);
  expect(client.cancel).not.toHaveBeenCalled();
  expect(x.run).not.toHaveBeenCalled();
  expect(x.errors).toEqual([]);
  resumed.stop();
});

test("two control processes cannot execute the same queued attempt even when the target has multiple free slots", async () => {
  const x = await setup();
  await x.queue();
  if (!x.settings.executor) throw new Error("Missing target");
  x.settings.executor = { ...x.settings.executor, maxConcurrent: 2 };
  const first = new AuthorPrechecks(x.options),
    second = new AuthorPrechecks(x.options);
  const batches = await Promise.all([
    first.schedule([x.f.project_id]),
    second.schedule([x.f.project_id]),
  ]);
  await Promise.all(batches.map((b) => b.done));
  expect(x.run).toHaveBeenCalledTimes(1);
  expect(x.check().status).toBe("failed");
  expect(x.errors).toEqual([]);
});

test("a later merge waits for a running precheck's execution and cleanup, then takes the shared slot first", async () => {
  const x = await setup();
  await x.queue();
  let finish!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const order: string[] = [];
  const git = {
    ...x.git,
    sync: async () => "up_to_date" as const,
    baseline: async () => "c".repeat(40),
    prepare: async () => ({
      status: "candidate" as const,
      candidate_sha: "f".repeat(40),
      tree_sha: "d".repeat(40),
      previous_sha: "c".repeat(40),
    }),
    merge: async () => {
      throw new Error("No legacy merge");
    },
    publish: async () => ({ status: "stale" as const }),
    changedPaths: async () => [],
    readWorkspace: async () => [],
  };
  const executor: CheckExecutor = {
    dispatch: async (r) => {
      order.push(r.kind);
      r.onReady?.();
      return { id: r.kind };
    },
    poll: async (h) => {
      if (h.id === "precheck") await cleanup;
      return {
        status: "passed",
        checks: [{ name: "test", status: "passed", exit_code: 0 }],
        cleanup_errors: [],
      };
    },
    cancel: vi.fn(async () => {}),
    fetchFailureLog: async () => undefined,
  };
  const host = new MergeChecks({
    store: x.f.store,
    clock: x.f.clock,
    execution: x.options.execution,
    configuration: x.options.configuration,
    git,
    checkExecutor: executor,
    onError: (e) => x.errors.push(e),
    sweep: async () => {},
  });
  let first = await host.schedule([x.f.project_id]);
  await vi.waitFor(async () => {
    if (x.check().status === "queued")
      first = await host.schedule([x.f.project_id]);
    expect(x.check().status).toBe("running");
  });
  const merge = m4Scenario(x.f);
  await acceptThroughMergeGate(x.f, merge, "e".repeat(40));
  const later = await host.schedule([x.f.project_id]);
  await vi.waitFor(() =>
    expect(
      x.f
        .state()
        .events.some(
          (e) => e.type === "merge_check_queued" && e.card_id === merge.card.id,
        ),
    ).toBe(true),
  );
  expect(order).toEqual(["precheck"]);
  expect(executor.cancel).not.toHaveBeenCalled();
  finish();
  await first.done;
  await later.done;
  expect(order).toEqual(["precheck", "merge_check"]);
  expect(x.check().status).toBe("passed");
  host.stop();
});

test.each(["EACCES", "ENOSPC"])(
  "candidate %s retains its safe category without leaking error context and remains terminal across ticks",
  async (code) => {
    const x = await setup();
    await x.queue();
    x.git.preparePrecheck.mockRejectedValue(
      Object.assign(
        new Error(
          "synthetic failure /private/candidate token=synthetic-secret-value\nraw second line",
        ),
        {
          code,
          cause: new Error("private cause /private/cause"),
        },
      ),
    );
    const host = new AuthorPrechecks(x.options);
    await (await host.schedule([x.f.project_id])).done;
    await (await host.schedule([x.f.project_id])).done;
    expect(x.git.preparePrecheck).toHaveBeenCalledTimes(1);
    expect(x.run).not.toHaveBeenCalled();
    expect(x.check()).toMatchObject({
      status: "environment_failed",
      summary: expect.stringContaining(`[${code}]`),
    });
    expect(x.check().summary).toContain("准备候选");
    expect(x.errors).toHaveLength(1);
    const reported = x.errors[0] as Error;
    expect(reported.message).toContain(`[${code}]`);
    expect(reported.stack).toBe(reported.message);
    expect(reported.cause).toBeUndefined();
    const publicText = `${x.check().summary}\n${reported.stack}`;
    for (const secret of [
      "/private/candidate",
      "synthetic-secret-value",
      "raw second line",
      "private cause",
    ])
      expect(publicText).not.toContain(secret);
    expect(x.reserve.mock.results[0]?.value).toBeDefined();
    const lease = await x.reserve.mock.results[0]!.value;
    expect(lease.release).toHaveBeenCalledTimes(1);
    expect(
      Number(
        x.f.store.database
          .prepare("SELECT COUNT(*) AS n FROM merge_check_capacity")
          .get()?.n ?? 0,
      ),
    ).toBe(0);
  },
);

test("dispatch failure plus log finish failure reports both safe diagnostics once and persists one terminal result", async () => {
  const x = await setup();
  await x.queue();
  const dispatch = vi.fn(async () => {
    throw Object.assign(
      new Error(
        "dispatch /private/dispatch token=synthetic-secret-value " +
          "界".repeat(CHECK_SUMMARY_LIMIT),
      ),
      { code: "ECONNREFUSED" },
    );
  });
  const executor: CheckExecutor = {
    dispatch,
    poll: vi.fn(),
    cancel: vi.fn(),
    fetchFailureLog: vi.fn(),
  };
  const finish = vi.fn(async () => {
    throw Object.assign(
      new Error(
        "log /private/log secret=synthetic-secret-value " +
          "界".repeat(CHECK_SUMMARY_LIMIT),
      ),
      { code: "ENOSPC" },
    );
  });
  const host = new AuthorPrechecks({
    ...x.options,
    executor,
    createLog: async (input) => ({
      ...(await createMergeCheckLog(input)),
      finish,
    }),
  });
  await (await host.schedule([x.f.project_id])).done;
  await (await host.schedule([x.f.project_id])).done;
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(finish).toHaveBeenCalledTimes(1);
  expect(x.check().status).toBe("environment_failed");
  expect(Buffer.byteLength(x.check().summary ?? "")).toBeLessThanOrEqual(
    CHECK_SUMMARY_LIMIT,
  );
  expect(x.check().summary).not.toContain("�");
  expect(x.check().summary).toContain("执行检查");
  expect(x.check().summary).toContain("[ECONNREFUSED]");
  expect(x.check().summary).toContain("保存日志");
  expect(x.check().summary).toContain("[ENOSPC]");
  expect(x.errors).toHaveLength(2);
  expect((x.errors[0] as Error).message).toContain("[ECONNREFUSED]");
  expect((x.errors[1] as Error).message).toContain("[ENOSPC]");
  for (const error of x.errors as Error[]) {
    expect(error.stack).toBe(error.message);
    expect(error.cause).toBeUndefined();
  }
  const projected = JSON.stringify({
    summary: x.check().summary,
    errors: (x.errors as Error[]).map((e) => ({
      message: e.message,
      stack: e.stack,
    })),
  });
  for (const secret of [
    "/private/dispatch",
    "/private/log",
    "synthetic-secret-value",
  ])
    expect(projected).not.toContain(secret);
  expect(
    x.f.state().events.filter((e) => e.type === "precheck_finished"),
  ).toHaveLength(1);
  expect(
    (await x.reserve.mock.results[0]!.value).release,
  ).toHaveBeenCalledTimes(1);
  expect(
    Number(
      x.f.store.database
        .prepare("SELECT COUNT(*) AS n FROM merge_check_capacity")
        .get()?.n ?? 0,
    ),
  ).toBe(0);
});
