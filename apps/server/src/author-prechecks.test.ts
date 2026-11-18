import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  prechecks,
  prepareCheck,
  requestCheck,
  updateCard,
} from "@cardigan/domain";
import {
  PrecheckMergeConflict,
  RepositoryLockTimeoutError,
} from "@cardigan/git-service";
import {
  CHECK_SUMMARY_LIMIT,
  type CheckExecutor,
  CheckRecovery,
  createMergeCheckLog,
  GithubRetryLater,
  type ProjectMergeGate,
} from "@cardigan/host";
import * as mcp from "@cardigan/mcp-server";
import { authenticate, serverTools } from "@cardigan/mcp-server";
import { CheckHandoffs, type Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { value } from "../../../packages/domain/src/commands/test-fixtures.js";
import { AuthorPrechecks } from "./author-prechecks.js";
import { CandidatePushNotStarted } from "./git.js";
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

test("retry deadlines survive pending ticks and are released after terminal settlement", async () => {
  const x = await setup();
  await x.queue();
  const retryAt = Date.parse(x.f.clock.now()) + 60000;
  x.git.preparePrecheck.mockRejectedValueOnce(new GithubRetryLater(retryAt));
  const host = new AuthorPrechecks(x.options);
  const deadlines = Reflect.get(host, "retry") as Map<string, number>;
  await (await host.schedule([x.f.project_id])).done;
  expect(deadlines.get(x.check().attempt_id)).toBe(retryAt);
  await (await host.schedule([x.f.project_id])).done;
  expect(x.git.preparePrecheck).toHaveBeenCalledTimes(1);
  x.advance(60000);
  await (await host.schedule([x.f.project_id])).done;
  expect(x.check().status).toBe("failed");
  await (await host.schedule([x.f.project_id])).done;
  expect(deadlines.size).toBe(0);
  expect(x.run).toHaveBeenCalledTimes(1);
});

test("candidate conflicts retain a structured host reason and baseline without running checks", async () => {
  const x = await setup();
  x.git.preparePrecheck.mockRejectedValue(
    new PrecheckMergeConflict("e".repeat(40)),
  );
  await x.queue();
  const service = new AuthorPrechecks(x.options);
  await (await service.schedule([x.f.project_id])).done;
  expect(x.check()).toMatchObject({
    status: "environment_failed",
    failure_kind: "candidate_conflict",
    base_sha: "e".repeat(40),
  });
  expect(x.check().candidate_sha).toBeUndefined();
  expect(x.run).not.toHaveBeenCalled();
  await (await service.schedule([x.f.project_id])).done;
  expect(x.git.preparePrecheck).toHaveBeenCalledTimes(1);
});
async function setup(shared?: { dataDir: string; project_id: string }) {
  let clockMs = Date.parse("2030-01-01T00:00:00Z");
  const f = m4Fixture({
    ...shared,
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
    advance: (ms = 30000) => {
      clockMs += ms;
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

test("MCP request, host precheck and MCP delivery share the exact author HEAD gate", async () => {
  const x = await setup();
  x.f.startRun(x.s.coder, {
    path: join(x.f.dataDir, "worktree"),
    branch: "agent/author",
  });
  const token = x.f.store.issueToken({
    project_id: x.f.project_id,
    assignment_id: x.s.coder.id,
    role: {
      role_version: 1,
      allowed_tools: ["request_check", "submit_delivery"],
    },
  });
  const context = {
    store: x.f.store,
    identity: value(authenticate(x.f.store, token.token)),
  };
  const verify = vi.fn(async () => ({ ok: true as const, value: [] }));
  const tools = serverTools({
    projectSettings: () => ({
      merge_gate_enabled: x.settings.status === "enabled",
    }),
    checkHead: () => ({ head: x.git.checkHead }),
    deliveryVerifier: () => ({ verify }),
    clock: x.f.clock,
  });
  const request = tools.find((t) => t.name === "request_check");
  const delivery = tools.find((t) => t.name === "submit_delivery");
  if (!request || !delivery) throw new Error("Missing author tools");
  const input = {
    idempotency_key: "delivery-after-precheck",
    work_item_id: x.s.development.id,
    kind: "code",
    summary: "Checked author HEAD",
    subject: { kind: "git_head", value: "a".repeat(40) },
    requested_verifiers: [x.s.codeReview.id],
  };
  const denied = { code: "illegal_transition", message: "请先 request_check" };
  const deliver = () => delivery.handler(input, context);
  await expect(deliver()).rejects.toEqual(denied);
  const queue = (key: string) =>
    request.handler(
      {
        idempotency_key: key,
        work_item_id: x.s.development.id,
      },
      context,
    );
  await queue("failed-precheck");
  await expect(deliver()).rejects.toEqual(denied);
  await (await new AuthorPrechecks(x.options).schedule([x.f.project_id])).done;
  expect(x.check().status).toBe("failed");
  await expect(deliver()).rejects.toEqual(denied);
  x.options.run = vi.fn(async (input) => {
    input.onReady?.();
    expect(x.check().status).toBe("running");
    await expect(deliver()).rejects.toEqual(denied);
    return {
      status: "passed",
      checks: [{ name: "test", status: "passed", exit_code: 0 }],
      cleanup_errors: [],
    };
  });
  await queue("passed-precheck");
  await (await new AuthorPrechecks(x.options).schedule([x.f.project_id])).done;
  expect(x.check()).toMatchObject({
    status: "passed",
    head_sha: input.subject.value,
  });
  expect(verify).not.toHaveBeenCalled();
  await expect(
    delivery.handler(
      {
        ...input,
        subject: { kind: "git_head", value: x.check().candidate_sha },
      },
      context,
    ),
  ).rejects.toEqual(denied);
  // A later baseline does not invalidate the completed author-HEAD check.
  x.f.store.uow.run((tx) => {
    const assignment = tx.assignments.get(x.f.project_id, x.s.coder.id);
    if (!assignment) throw new Error("Missing producer");
    tx.assignments.put(x.f.project_id, {
      ...assignment,
      base_sha: "e".repeat(40),
    });
  });
  expect(await deliver()).toMatchObject({ subject: input.subject });
  expect(verify).toHaveBeenCalledTimes(1);
  expect(x.f.state().deliveries).toHaveLength(1);
  expect(
    x.f.state().events.some((e) => e.type === "merge_check_finished"),
  ).toBe(false);
  expect(x.errors).toEqual([]);
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

test.each([false, true])(
  "GitHub prechecks bind, resume and finish alongside a merge check (parallel=%s)",
  async (parallel) => {
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
      maxConcurrent: parallel ? 2 : 1,
      scopedChecks: true,
    };
    x.settings.executor = config;
    x.settings.checks = GITHUB_CHECK_NAMES.map((name) => ({
      name,
      run: "synthetic",
    }));
    const merge = parallel ? m4Scenario(x.f) : undefined;
    if (merge) await acceptThroughMergeGate(x.f, merge, "e".repeat(40));
    const dispatched = new Map<number, Readonly<Record<string, string>>>();
    let inputs: Readonly<Record<string, string>> = {},
      complete = false,
      started = false;
    const run = (id = 123) => ({
      id,
      run_attempt: 1,
      path: config.workflow,
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: "a".repeat(40),
      actor: { login: config.botLogin },
      display_title:
        started || complete
          ? githubCheckRunName(dispatched.get(id) ?? inputs)
          : "Cardigan check",
      html_url: `https://github.com/fixture/project/actions/runs/${id}`,
      created_at: "2030-01-01T00:00:00.000Z",
      status: complete ? "completed" : started ? "in_progress" : "queued",
      conclusion: complete ? "success" : null,
    });
    const client = {
      token: vi.fn(async () => "ghs_synthetic"),
      dispatch: vi.fn(
        async (_ref: string, p: Readonly<Record<string, string>>) => {
          const id = p.kind === "precheck" ? 123 : 124;
          dispatched.set(id, p);
          if (id === 123) inputs = p;
          return id;
        },
      ),
      run: vi.fn(async (id: number) => run(id)),
      runs: vi.fn(async () => []),
      pollRuns: vi.fn(async () => ({
        unchanged: false,
        runs: [...dispatched.keys()].map((id) => run(id)),
        etag: "fixture",
      })),
      jobs: vi.fn(async (id: number) => [
        {
          id: 456,
          run_id: id,
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
      baseline: async () => "c".repeat(40),
      prepare: async () => ({
        status: "candidate" as const,
        candidate_sha: "f".repeat(40),
        tree_sha: "d".repeat(40),
        previous_sha: "c".repeat(40),
      }),
      publish: async () => ({ status: "stale" as const }),
      changedPaths: async () => [],
      readWorkspace: async () => [],
      merge: async () => {
        throw new Error("No merge");
      },
      pushCheckCandidate: vi.fn(async function (this: { sync: unknown }) {
        expect(this.sync).toBe(git.sync);
        return { status: "pushed" as const };
      }),
      async isBaselineAncestor(this: { sync: unknown }) {
        expect(this.sync).toBe(git.sync);
        return true;
      },
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
    if (!parallel) {
      git.pushCheckCandidate.mockRejectedValueOnce(
        new CandidatePushNotStarted(1),
      );
      await (await first.schedule([x.f.project_id])).done;
      expect(x.check().status).toBe("queued");
      expect(client.dispatch).not.toHaveBeenCalled();
    }
    const scheduled = await first.schedule([x.f.project_id]);
    if (parallel) {
      await vi.waitFor(() => expect(dispatched.has(124)).toBe(true));
      await first.schedule([x.f.project_id]);
    }
    await vi.waitFor(() => expect(x.check().status).toBe("running"));
    expect(inputs.kind).toBe("precheck");
    expect(inputs.scope).toBe("full");
    if (parallel) {
      const { GithubDispatchJournal } = await import("@cardigan/host");
      expect(new GithubDispatchJournal(x.f.store).unfinished()).toHaveLength(2);
      expect(dispatched.get(124)?.kind).toBe("merge_check");
    }
    // A bound remote run retains its journal slot while allowing host deployment.
    const { acquireDeploymentCapacity } = await import("@cardigan/host");
    const deploy = acquireDeploymentCapacity(x.f.store);
    expect(deploy).toBeTypeOf("function");
    deploy?.();
    expect(inputs.delivery).toBe(x.s.coder.id);
    x.advance(70 * 60_000);
    await first.schedule([x.f.project_id]);
    expect(x.check().status).toBe("running");
    const progressFor = () =>
      x.f.store.uow
        .read((tx) => tx.events.listAfter(x.f.project_id, x.s.card.id, 0))
        .filter((event) => event.type === "github_check_progress");
    expect(progressFor().at(-1)?.payload).toMatchObject({
      summary: "等待 GitHub 启动 · 已等 70 分钟",
    });
    expect(
      new Set(
        progressFor().map(
          (event) => (event.payload as { entry: string }).entry,
        ),
      ).size,
    ).toBe(1);
    const visibleProgress = x.f.store.uow
      .read((tx) => tx.timeline.list(x.f.project_id))
      .filter(
        (entry) =>
          entry.card_id === x.s.card.id &&
          entry.body.includes("等待 GitHub 启动"),
      );
    expect(visibleProgress).toHaveLength(1);
    expect(visibleProgress[0]?.body).toContain(
      "等待 GitHub 启动 · 已等 70 分钟",
    );
    if (merge) {
      const progress = x.f.store.uow
        .read((tx) => tx.events.listAfter(x.f.project_id, merge.card.id, 0))
        .filter((event) => event.type === "github_check_progress");
      expect(progress.at(-1)?.payload).toMatchObject({
        summary: "等待 GitHub 启动 · 已等 70 分钟",
      });
    }
    started = true;
    x.advance();
    await first.schedule([x.f.project_id]);
    expect(progressFor().at(-1)?.payload).toMatchObject({
      summary: "GitHub 检查执行中",
    });
    if (parallel) {
      complete = true;
      x.advance();
      await first.schedule([x.f.project_id]);
      await first.idle();
      expect(x.check().status).toBe("passed");
      const { GithubDispatchJournal } = await import("@cardigan/host");
      expect(new GithubDispatchJournal(x.f.store).unfinished()).toEqual([]);
      expect(x.errors).toEqual([]);
      first.stop();
      return;
    }
    first.stop();
    await scheduled.done;
    await first.idle();
    expect(x.check().status).toBe("running");
    const resumed = new MergeChecks(options);
    // Bound remote work survives a busy repository during restart HEAD proof.
    git.checkHead.mockRejectedValueOnce(new RepositoryLockTimeoutError(1));
    await (await resumed.schedule([x.f.project_id])).done;
    expect(x.check()).toMatchObject({
      status: "running",
      external_run: { run_id: 123 },
    });
    const next = await resumed.schedule([x.f.project_id]);
    await vi.waitFor(() =>
      expect(client.run.mock.calls.length).toBeGreaterThan(1),
    );
    complete = true;
    git.checkHead.mockRejectedValueOnce(new RepositoryLockTimeoutError(1));
    x.advance();
    await resumed.schedule([x.f.project_id]);
    await next.done;
    await (await resumed.schedule([x.f.project_id])).done;
    expect(x.check()).toMatchObject({
      status: "passed",
      external_run: { run_id: 123, run_attempt: 1 },
    });
    expect(client.dispatch).toHaveBeenCalledTimes(parallel ? 2 : 1);
    expect(git.pushCheckCandidate).toHaveBeenCalledTimes(2);
    expect(client.cancel).not.toHaveBeenCalled();
    expect(x.run).not.toHaveBeenCalled();
    expect(x.errors).toEqual([]);
    resumed.stop();
  },
);

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

const unusualPathErrors = [
  "fatal: '/' is outside repository",
  'rsync: change_dir "/" failed',
  "at /<anonymous>",
  String.raw`failed at C:\"`,
];
test.each(
  unusualPathErrors.flatMap((message) =>
    ["prepare", "dispatch", "double"].map((stage) => ({ message, stage })),
  ),
)(
  "path-shaped $stage error $message reaches one terminal across three ticks and releases the author mutex",
  async ({ message, stage }) => {
    const x = await setup();
    await x.queue();
    const error = Object.assign(new Error(message), { code: "EACCES" });
    const dispatch = vi.fn(async () => {
      throw error;
    });
    const finish = vi.fn();
    if (stage === "prepare") x.git.preparePrecheck.mockRejectedValue(error);
    const host = new AuthorPrechecks({
      ...x.options,
      ...(stage !== "prepare"
        ? {
            executor: {
              dispatch,
              poll: vi.fn(),
              cancel: vi.fn(),
              fetchFailureLog: vi.fn(),
            },
          }
        : {}),
      createLog: async (input) => {
        const log = await createMergeCheckLog(input);
        finish.mockImplementation(async (result) => {
          await log.finish(result);
          if (stage === "double")
            throw Object.assign(new Error(message), { code: "ENOSPC" });
          return {
            ...result,
            summary: "failed",
            log_ref: `${input.attempt}.log`,
          };
        });
        return { ...log, finish };
      },
    });
    for (let tick = 0; tick < 3; tick++)
      await (await host.schedule([x.f.project_id])).done;
    expect(x.check().status).toBe("environment_failed");
    expect(x.git.preparePrecheck).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(stage === "prepare" ? 0 : 1);
    expect(finish).toHaveBeenCalledTimes(stage === "prepare" ? 0 : 1);
    expect(
      x.f.state().events.filter((e) => e.type === "precheck_finished"),
    ).toHaveLength(1);
    expect(x.check().summary).toContain("[EACCES]");
    if (stage === "double") expect(x.check().summary).toContain("[ENOSPC]");
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
    expect(x.check().summary).not.toContain(message);
    const prior = x.check().attempt_id;
    await x.queue();
    expect(x.check().status).toBe("queued");
    expect(x.check().attempt_id).not.toBe(prior);
  },
);

test("a refused failure projection falls back to a fixed domain-validated terminal without repeating execution or log finish", async () => {
  const x = await setup();
  await x.queue();
  x.git.preparePrecheck.mockRejectedValue(
    new Error("synthetic candidate failure"),
  );
  const host = new AuthorPrechecks(x.options);
  const target = host as unknown as {
    update(
      project: typeof x.f.project_id,
      check: ReturnType<typeof x.check>,
    ): void;
  };
  const update = target.update.bind(host);
  let rejected = false;
  const writes = vi
    .spyOn(target, "update")
    .mockImplementation((project, check) => {
      if (check.status === "environment_failed" && !rejected) {
        rejected = true;
        update(project, { ...check, summary: "at /<anonymous>" });
      } else update(project, check);
    });
  for (let tick = 0; tick < 3; tick++)
    await (await host.schedule([x.f.project_id])).done;
  expect(x.check()).toMatchObject({
    status: "environment_failed",
    summary: expect.stringContaining("固定"),
  });
  expect(x.git.preparePrecheck).toHaveBeenCalledTimes(1);
  expect(
    x.f.state().events.filter((e) => e.type === "precheck_finished"),
  ).toHaveLength(1);
  expect(writes).toHaveBeenCalledTimes(2);
  expect((x.errors as Error[]).map((e) => e.message).join("\n")).toContain(
    "固定安全摘要",
  );
  await x.queue();
  expect(x.check().status).toBe("queued");
});

test("when terminal and fixed fallback writes fail, a durable settlement intent fences execution across ticks and controller restart", async () => {
  const x = await setup();
  await x.queue();
  x.git.preparePrecheck.mockRejectedValue(
    new Error("synthetic candidate failure"),
  );
  const host = new AuthorPrechecks(x.options);
  const target = host as unknown as {
    update(
      project: typeof x.f.project_id,
      check: ReturnType<typeof x.check>,
    ): void;
  };
  const update = target.update.bind(host);
  vi.spyOn(target, "update").mockImplementation((project, check) => {
    if (check.status === "environment_failed")
      throw new Error("synthetic terminal storage failure");
    update(project, check);
  });
  for (let tick = 0; tick < 3; tick++)
    await (await host.schedule([x.f.project_id])).done;
  expect(x.git.preparePrecheck).toHaveBeenCalledTimes(1);
  expect(x.reserve).toHaveBeenCalledTimes(1);
  expect(x.check().status).toBe("queued");
  expect(
    x.f.state().events.filter((e) => e.type === "precheck_settlement_pending"),
  ).toHaveLength(1);
  expect((x.errors as Error[]).map((e) => e.message).join("\n")).toContain(
    "后续仅补记终态",
  );
  expect(
    Number(
      x.f.store.database
        .prepare("SELECT COUNT(*) AS n FROM merge_check_capacity")
        .get()?.n ?? 0,
    ),
  ).toBe(0);
  const restarted = new AuthorPrechecks(x.options);
  await (await restarted.schedule([x.f.project_id])).done;
  expect(x.check().status).toBe("environment_failed");
  expect(x.git.preparePrecheck).toHaveBeenCalledTimes(1);
  expect(
    x.f.state().events.filter((e) => e.type === "precheck_finished"),
  ).toHaveLength(1);
  await x.queue();
  expect(x.check().status).toBe("queued");
});

function withReadFault(store: Store, beforeRead: () => void): Store {
  const uow = store.uow;
  const read: typeof uow.read = (operation) => {
    beforeRead();
    return uow.read(operation);
  };
  return new Proxy(store, {
    get(target, property) {
      return property === "uow"
        ? { ...uow, read }
        : Reflect.get(target, property, target);
    },
  });
}

test.each(
  ["once", "after every execution"].flatMap((mode) =>
    ["prepare", "dispatch"].map((stage) => ({ mode, stage })),
  ),
)(
  "an owner read fault $mode after $stage never repeats execution",
  async ({ mode, stage }) => {
    const x = await setup();
    await x.queue();
    let armed = false;
    let readFaults = 0;
    const store = withReadFault(x.f.store, () => {
      if (!armed) return;
      armed = false;
      readFaults++;
      throw new Error("synthetic SQLITE_BUSY");
    });
    const fail = async () => {
      armed = mode !== "once" || readFaults === 0;
      throw new Error("synthetic candidate failure");
    };
    if (stage === "prepare") x.git.preparePrecheck.mockImplementation(fail);
    const dispatch = vi.fn(fail);
    const finish = vi.fn();
    const host = new AuthorPrechecks({
      ...x.options,
      store,
      executor: {
        dispatch,
        poll: vi.fn(),
        cancel: vi.fn(),
        fetchFailureLog: vi.fn(),
      },
      createLog: async (input) => {
        const log = await createMergeCheckLog(input);
        finish.mockImplementation(log.finish);
        return { ...log, finish };
      },
    });
    for (let tick = 0; tick < 3; tick++)
      await (await host.schedule([x.f.project_id])).done;
    expect(readFaults).toBe(1);
    expect(x.git.checkHead).toHaveBeenCalledTimes(1);
    expect(x.git.preparePrecheck).toHaveBeenCalledTimes(1);
    expect(x.run).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(stage === "prepare" ? 0 : 1);
    expect(finish).toHaveBeenCalledTimes(stage === "prepare" ? 0 : 1);
    expect(x.reserve).toHaveBeenCalledTimes(1);
    expect(
      (await x.reserve.mock.results[0]?.value)?.release,
    ).toHaveBeenCalledTimes(1);
    expect(x.check().status).toBe("environment_failed");
    expect(
      x.f.state().events.filter((e) => e.type === "precheck_finished"),
    ).toHaveLength(1);
    expect(
      x.f.store.database
        .prepare("SELECT COUNT(*) AS n FROM merge_check_capacity")
        .get()?.n,
    ).toBe(0);
    await x.queue();
    expect(x.check().status).toBe("queued");
  },
);

test("unreadable settlement state persists an intent before any read and a new controller only settles the attempt", async () => {
  const x = await setup();
  await x.queue();
  let unreadable = false;
  let allowOneRead = false;
  let readFaults = 0;
  const store = withReadFault(x.f.store, () => {
    if (allowOneRead) {
      allowOneRead = false;
      return;
    }
    if (!unreadable) return;
    readFaults++;
    throw new Error("synthetic SQLITE_BUSY");
  });
  x.git.preparePrecheck.mockImplementation(async () => {
    unreadable = true;
    throw new Error("synthetic candidate failure");
  });
  const host = new AuthorPrechecks({ ...x.options, store });
  await (await host.schedule([x.f.project_id])).done;
  expect(readFaults).toBeGreaterThan(0);
  expect(x.check().status).toBe("queued");
  expect(
    x.f.state().events.filter((e) => e.type === "precheck_settlement_pending"),
  ).toHaveLength(1);
  expect((x.errors as Error[]).map((e) => e.message).join("\n")).toContain(
    "收尾状态暂不可读",
  );
  expect(
    (await x.reserve.mock.results[0]?.value)?.release,
  ).toHaveBeenCalledTimes(1);
  expect(
    x.f.store.database
      .prepare("SELECT COUNT(*) AS n FROM merge_check_capacity")
      .get()?.n,
  ).toBe(0);
  // Let each tick list the queue; settlement state remains unreadable.
  for (let tick = 0; tick < 3; tick++) {
    allowOneRead = true;
    await (await host.schedule([x.f.project_id])).done;
    expect(x.check().status).toBe("queued");
  }
  expect(readFaults).toBeGreaterThanOrEqual(5);
  unreadable = false;
  const restarted = new AuthorPrechecks({ ...x.options, store });
  for (let tick = 0; tick < 3; tick++)
    await (await restarted.schedule([x.f.project_id])).done;
  expect(x.git.checkHead).toHaveBeenCalledTimes(1);
  expect(x.git.preparePrecheck).toHaveBeenCalledTimes(1);
  expect(x.reserve).toHaveBeenCalledTimes(1);
  expect(x.run).not.toHaveBeenCalled();
  expect(x.check().status).toBe("environment_failed");
  expect(
    x.f.state().events.filter((e) => e.type === "precheck_finished"),
  ).toHaveLength(1);
  await x.queue();
  expect(x.check().status).toBe("queued");
});

test("card hold defers author checks across restart and asynchronous distribution, preserving the queued attempt", async () => {
  const x = await setup();
  const queued = await x.queue();
  const hold = { reason: "wait", resume_condition: "ready" };
  const set = (value: typeof hold | null) =>
    x.f.apply((s, a, p) =>
      updateCard(s, a, { card_id: x.s.card.id, hold: value }, p),
    );
  set(hold);
  const loads = vi.spyOn(mcp, "loadCommandState");
  try {
    await (await new AuthorPrechecks(x.options).schedule([x.f.project_id]))
      .done;
    // One project queue projection, no full-state reads for settlement or hold.
    expect(loads).toHaveBeenCalledTimes(1);
  } finally {
    loads.mockRestore();
  }
  expect(x.run).not.toHaveBeenCalled();
  expect(x.check().attempt_id).toBe(queued.attempt_id);
  set(null);
  x.git.distribute.mockImplementationOnce(async () => {
    set(hold);
  });
  await (await new AuthorPrechecks(x.options).schedule([x.f.project_id])).done;
  expect(x.run).not.toHaveBeenCalled();
  expect(x.check().status).toBe("queued");
  expect(x.errors).toEqual([]);
  set(null);
  x.run.mockImplementationOnce(async (input) => {
    input.onReady?.();
    set(hold);
    return {
      status: "passed",
      checks: [{ name: "test", status: "passed", exit_code: 0 }],
      cleanup_errors: [],
    };
  });
  await (await new AuthorPrechecks(x.options).schedule([x.f.project_id])).done;
  expect(x.check()).toMatchObject({
    attempt_id: queued.attempt_id,
    status: "passed",
  });
  expect(x.f.card().hold).toBeDefined();
});

test("a queued HEAD lock timeout retries the same attempt; a changed HEAD after execution cannot pass", async () => {
  const x = await setup();
  await x.queue();
  const host = new AuthorPrechecks(x.options),
    attempt = x.check().attempt_id;
  x.git.checkHead.mockRejectedValueOnce(new RepositoryLockTimeoutError(1));
  await (await host.schedule([x.f.project_id])).done;
  expect(x.check()).toMatchObject({ attempt_id: attempt, status: "queued" });
  expect(x.run).not.toHaveBeenCalled();
  x.git.checkHead
    .mockResolvedValueOnce(x.check().head_sha)
    .mockRejectedValueOnce(new RepositoryLockTimeoutError(1))
    .mockResolvedValueOnce("e".repeat(40));
  await (await host.schedule([x.f.project_id])).done;
  expect(x.check().status).toBe("running");
  await (await host.schedule([x.f.project_id])).done;
  expect(x.run).toHaveBeenCalledOnce();
  expect(x.git.preparePrecheck).toHaveBeenCalledOnce();
  expect(x.check()).toMatchObject({
    attempt_id: attempt,
    status: "interrupted",
  });
});

test.each([true, false])(
  "a completed SSH result survives restart during HEAD proof (ready=%s) without holding another project's only slot",
  async (ready) => {
    const a = await setup(),
      b = await setup({ dataDir: a.f.dataDir, project_id: "p-second" });
    const requested = await a.queue();
    const bp = b.f.project_id,
      ap = a.f.project_id;
    const checkedHead = a.check().head_sha;
    let busy = false;
    const git = {
      ...a.git,
      projectOf: (project_id: typeof ap) => ({
        ...a.git.projectOf(),
        project_id,
      }),
      checkHead: vi.fn(async (project: typeof ap) => {
        if (busy && project === ap) throw new RepositoryLockTimeoutError(1);
        return checkedHead;
      }),
      changedPaths: vi.fn(),
      readWorkspace: vi.fn(),
      sync: vi.fn(),
      baseline: vi.fn(),
      prepare: vi.fn(),
      publish: vi.fn(),
      merge: vi.fn(),
    };
    const dispatched: string[] = [];
    const executor: CheckExecutor = {
      dispatch: async (r) => {
        dispatched.push(r.project);
        if (ready || r.project === bp) r.onReady?.();
        return { id: r.project };
      },
      poll: async (h) => {
        if (h.id === ap) busy = true;
        return !ready && h.id === ap
          ? { status: "executor_unreachable", checks: [], cleanup_errors: [] }
          : {
              status: "passed",
              checks: [{ name: "test", status: "passed", exit_code: 0 }],
              cleanup_errors: [],
            };
      },
      cancel: vi.fn(),
      fetchFailureLog: async () => undefined,
    };
    const options = {
      ...a.options,
      git,
      checkExecutor: executor,
      sweep: async () => {},
    };
    const first = new MergeChecks(options);
    await first.tick([ap]);
    await first.idle(); // Startup orphan sweep shares the target slot.
    await first.tick([ap]);
    expect(a.check()).toMatchObject({
      attempt_id: requested.attempt_id,
      status: ready ? "running" : "queued",
    });
    expect(a.check().checks).toBeUndefined();
    expect(
      a.f.store.database
        .prepare("SELECT count(*) AS n FROM merge_check_capacity")
        .get()?.n,
    ).toBe(0);
    await b.queue();
    await first.tick([ap, bp]);
    expect(b.check().status).toBe("passed");
    first.stop();
    await first.idle();
    busy = false;
    const resumed = new MergeChecks({ ...options, store: b.f.store });
    await resumed.tick([ap, bp]);
    await resumed.tick([ap]);
    expect(dispatched).toEqual([ap, bp]);
    expect(a.check()).toMatchObject({
      attempt_id: requested.attempt_id,
      status: ready ? "passed" : "executor_unreachable",
      checks: ready ? [{ name: "test", status: "passed", exit_code: 0 }] : [],
    });
    expect(
      a.f.store.database
        .prepare("SELECT count(*) AS n FROM precheck_head_proofs")
        .get()?.n,
    ).toBe(0);
    expect(a.errors).toEqual([]);
    resumed.stop();
  },
);

test("a restored proof cannot pass after its owner changes during the HEAD read", async () => {
  const x = await setup();
  await x.queue();
  const head = x.check().head_sha;
  x.run.mockImplementationOnce(async (input) => {
    input.onReady?.();
    return {
      status: "passed",
      checks: [{ name: "test", status: "passed", exit_code: 0 }],
      cleanup_errors: [],
    };
  });
  x.git.checkHead
    .mockResolvedValueOnce(head)
    .mockRejectedValueOnce(new RepositoryLockTimeoutError(1));
  await (await new AuthorPrechecks(x.options).schedule([x.f.project_id])).done;
  expect(x.check().status).toBe("running");
  x.git.checkHead.mockImplementationOnce(async () => {
    x.f.store.uow.run((tx) =>
      tx.assignments.put(x.f.project_id, { ...x.s.coder, status: "released" }),
    );
    return head;
  });
  await (await new AuthorPrechecks(x.options).schedule([x.f.project_id])).done;
  expect(x.run).toHaveBeenCalledOnce();
  expect(x.check().status).toBe("interrupted");
  expect(x.errors).toEqual([]);
});
