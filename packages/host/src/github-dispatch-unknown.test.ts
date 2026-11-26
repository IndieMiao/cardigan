import type { CandidatePushResult } from "@cardigan/git-transport";
import { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { fixture, human } from "../../domain/src/commands/test-fixtures.js";
import {
  type CheckExecutor,
  type CheckRequest,
  runCheckExecutor,
} from "./check-executor.js";
import {
  type ExecutorHttpObservation,
  formatDispatchUnknown,
  GithubHttpTrace,
  githubHttpTrace,
  recordGithubHttp,
  redactProviderText,
  summarizeProviderBody,
} from "./executor-diagnostics.js";
import {
  CANDIDATE_PUSH_RETRY_DELAYS_MS,
  GithubCheckExecutor,
  githubCheckRunName,
} from "./github-check-executor.js";
import {
  GithubClient,
  GithubExecutorError,
  type GithubRun,
} from "./github-client.js";
import { GithubDispatchJournal } from "./github-dispatch-journal.js";
import type { GithubMergeGateExecutor } from "./merge-gate-executors.js";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const now = Date.parse("2026-11-15T00:00:00Z");
const syntheticToken = `ghs_${"a".repeat(36)}`;
const privateKey =
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";
const config: GithubMergeGateExecutor = {
  name: "github",
  type: "github",
  repo: "fixture/project",
  workflow: ".github/workflows/check.yml",
  appId: 1,
  installationId: 2,
  privateKeyFile: "/synthetic/app.pem",
  botLogin: "fixture[bot]",
  maxConcurrent: 2,
};
const card = fixture().cards[0]!;
const inputs = {
  kind: "merge_check",
  card: card.id,
  delivery: "D-1",
  attempt: "attempt-1",
  sha: "a".repeat(40),
  tree: "b".repeat(40),
};
const trusted: GithubRun = {
  id: 123,
  run_attempt: 1,
  path: config.workflow,
  event: "workflow_dispatch",
  head_branch: "main",
  head_sha: "c".repeat(40),
  actor: { login: config.botLogin },
  triggering_actor: { login: config.botLogin },
  display_title: githubCheckRunName(inputs),
  html_url: "https://github.com/fixture/project/actions/runs/123",
  created_at: new Date(now).toISOString(),
};
const tokenExchange: ExecutorHttpObservation = {
  operation: "token",
  method: "POST",
  status: 201,
  requestId: "0400:1111:AAAA",
  summary: "正文已省略",
};
const post: ExecutorHttpObservation = {
  operation: "dispatch",
  method: "POST",
  status: 204,
  requestId: "0400:2222:BBBB",
  summary: "无正文",
};
const listing: ExecutorHttpObservation = {
  operation: "runs",
  method: "GET",
  status: 200,
  requestId: "0400:3333:CCCC",
  summary: "total_count=0 workflow_runs=0",
};

function setup() {
  const store = Store.open({ dbPath: ":memory:" });
  stores.push(store);
  store.createProject({ id: human.project_id });
  store.uow.run((tx) => tx.cards.put(human.project_id, card));
  // Fake transport records what the real client records for each request.
  const client = {
    token: vi.fn(async () => {
      recordGithubHttp(tokenExchange);
      return syntheticToken;
    }),
    dispatch: vi.fn(async (): Promise<number | undefined> => {
      recordGithubHttp(post);
      return undefined;
    }),
    run: vi.fn(async () => trusted),
    runs: vi.fn(async (): Promise<readonly GithubRun[]> => {
      recordGithubHttp(listing);
      return [];
    }),
  };
  const push = vi.fn(
    async (): Promise<CandidatePushResult | { status: "not_started" }> => ({
      status: "pushed",
    }),
  );
  const journal = new GithubDispatchJournal(store);
  const options = {
    config,
    client,
    journal,
    context: () => ({ card: card.id, delivery: "D-1", baselineBranch: "main" }),
    push,
    isBaselineAncestor: vi.fn(async () => true),
    lifecycle: {
      poll: vi.fn(),
      cancel: vi.fn(async () => {}),
      fetchFailureLog: vi.fn(async () => undefined),
    },
    now: () => now,
    pushRetryDelaysMs: [0, 0],
  };
  const request: CheckRequest = {
    kind: "merge_check",
    project: human.project_id,
    sha: inputs.sha,
    tree: inputs.tree,
    attempt: inputs.attempt,
    checks: [{ name: "test", run: "true" }],
    onReady: vi.fn(),
  };
  return { store, client, push, journal, options, request };
}
/** Reasons and diagnostics must not carry credentials or raw headers. */
function expectRedacted(text: string) {
  expect(text).not.toContain(syntheticToken);
  expect(text).not.toMatch(/ghs_|github_pat_|eyJ|BEGIN|PRIVATE KEY/u);
  expect(text).not.toMatch(/authorization|bearer/iu);
  expect(text).not.toContain("sig=");
}
async function unknown(executor: GithubCheckExecutor, request: CheckRequest) {
  const error = await executor.dispatch(request).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(GithubExecutorError);
  expect(error).toMatchObject({ category: "dispatch_unknown" });
  return error as GithubExecutorError;
}

test("C-681: an abort before push records not_sent with no POST evidence", async () => {
  const f = setup();
  const abort = new AbortController();
  const journal = Object.create(f.journal) as GithubDispatchJournal;
  journal.claim = (...args) => {
    const claimed = f.journal.claim(...args);
    abort.abort();
    return claimed;
  };
  const error = await unknown(
    new GithubCheckExecutor({ ...f.options, journal }),
    { ...f.request, signal: abort.signal },
  );
  expect(error.dispatch).toEqual({ stage: "not_sent" });
  expect(f.push).not.toHaveBeenCalled();
  expect(f.client.dispatch).not.toHaveBeenCalled();
  expect(formatDispatchUnknown(error.dispatch!)).toBe(
    "分类：未发出；最近一次 GitHub 请求：无",
  );
});

test("C-681/C-758: a persistently unreachable push records push_unreachable and the latest request", async () => {
  const f = setup();
  f.push.mockResolvedValue({
    status: "failed",
    reason: "network",
    exit_code: 128,
  });
  const error = await unknown(new GithubCheckExecutor(f.options), f.request);
  expect(error.dispatch).toEqual({
    stage: "push_unreachable",
    pushFailure: "network",
    pushExitCode: 128,
    pushAttempts: 3,
    pushDurationMs: expect.any(Number),
    last: tokenExchange,
  });
  expect(Number.isSafeInteger(error.dispatch?.pushDurationMs)).toBe(true);
  // Two bounded retries inside the same publication fence, then the real cause.
  expect(f.push).toHaveBeenCalledTimes(3);
  expect(f.client.dispatch).not.toHaveBeenCalled();
  expect(f.journal.unfinished()).toMatchObject([{ phase: "reserved" }]);
  const text = formatDispatchUnknown({
    ...error.dispatch!,
    pushDurationMs: 20_140,
  });
  expect(text).toBe(
    "分类：候选推送连不上 GitHub；推送结果：网络连接失败，退出码 128；推送 3 次，用时 20.1 秒；最近一次 GitHub 请求：POST 安装令牌，HTTP 201，请求 id 0400:1111:AAAA，响应：正文已省略",
  );
  expectRedacted(text);
});

test.each([
  ["timeout", "push_timeout", 1, "候选推送超时；推送结果：超过传输时限"],
  [
    "rejected",
    "push_rejected",
    1,
    "GitHub 拒绝或报错候选推送；推送结果：引用更新被拒",
  ],
  [
    "auth",
    "push_rejected",
    3,
    "GitHub 拒绝或报错候选推送；推送结果：认证或权限被拒",
  ],
  [
    "github_error",
    "push_rejected",
    3,
    "GitHub 拒绝或报错候选推送；推送结果：GitHub 服务端错误",
  ],
  [
    "local",
    "push_failed",
    1,
    "候选推送在本机失败；推送结果：传输前本机校验失败",
  ],
  ["other", "push_failed", 3, "候选推送在本机失败；推送结果：未识别的推送错误"],
] as const)(
  "C-758: a failed push (%s) is classified as %s, not as an unreachable executor",
  async (reason, stage, pushes, label) => {
    const f = setup();
    f.push.mockResolvedValue({ status: "failed", reason });
    const error = await unknown(new GithubCheckExecutor(f.options), f.request);
    expect(error.dispatch).toMatchObject({ stage, pushFailure: reason });
    expect(f.push).toHaveBeenCalledTimes(pushes);
    expect(f.client.dispatch).not.toHaveBeenCalled();
    expect(f.journal.unfinished()).toMatchObject([{ phase: "reserved" }]);
    expect(formatDispatchUnknown(error.dispatch!)).toContain(`分类：${label}`);
    // The same attempt is retried later through the unchanged recovery path.
    f.push.mockResolvedValue({ status: "pushed" });
    // This fixture's POST returns no run id: discovery waits for the run.
    await expect(
      new GithubCheckExecutor(f.options).dispatch(f.request),
    ).rejects.toMatchObject({ scope: "attempt" });
    expect(f.client.dispatch).toHaveBeenCalledOnce();
  },
);

test.each([1, 2])(
  "C-758: a transient push failure (fresh token not yet accepted) succeeds on in-fence retry %i",
  async (failures) => {
    const f = setup();
    for (let i = 0; i < failures; i++)
      f.push.mockResolvedValueOnce({ status: "failed", reason: "auth" });
    await expect(
      new GithubCheckExecutor(f.options).dispatch(f.request),
    ).rejects.toMatchObject({ scope: "attempt" });
    expect(f.push).toHaveBeenCalledTimes(failures + 1);
    expect(f.push.mock.calls.at(-1)).toEqual(f.push.mock.calls[0]);
    expect(f.client.dispatch).toHaveBeenCalledOnce();
  },
);

test("C-758: the default in-fence retry waits are bounded", () => {
  expect(CANDIDATE_PUSH_RETRY_DELAYS_MS).toEqual([5_000, 15_000]);
});

test("C-758: a retry that cannot take the repository lock keeps the first failure, never not_started", async () => {
  const f = setup();
  f.push
    .mockResolvedValueOnce({ status: "failed", reason: "network" })
    .mockResolvedValueOnce({ status: "not_started" });
  const error = await unknown(new GithubCheckExecutor(f.options), f.request);
  expect(error.dispatch).toMatchObject({
    stage: "push_unreachable",
    pushFailure: "network",
  });
  // A busy lock ends the retries; it is not a proven unstarted publication.
  expect(f.push).toHaveBeenCalledTimes(2);
  expect(f.journal.unfinished()[0]).not.toHaveProperty("admission_suspended");
});

test.each([
  "during push",
  "during retry wait",
  "before POST",
  "transport",
] as const)(
  "C-758: a local abort %s is push_cancelled and never retried",
  async (when) => {
    const f = setup();
    const abort = new AbortController();
    const options = {
      ...f.options,
      pushRetryDelaysMs: when === "during retry wait" ? [60_000, 0] : [0, 0],
    };
    f.push.mockImplementationOnce(async () => {
      if (when === "during push") abort.abort();
      if (when === "during retry wait") setTimeout(() => abort.abort(), 1);
      if (when === "before POST") return { status: "pushed" };
      return {
        status: "failed",
        reason: when === "transport" ? "cancelled" : "network",
      };
    });
    const request = {
      ...f.request,
      signal: abort.signal,
      ...(when === "before POST"
        ? { beforeDispatch: () => abort.abort() }
        : {}),
    };
    const error = await unknown(new GithubCheckExecutor(options), request);
    expect(error.dispatch?.stage).toBe("push_cancelled");
    expect(error.dispatch?.pushFailure).toBe(
      when === "transport" ? "cancelled" : undefined,
    );
    expect(error.dispatch?.pushAttempts).toBe(1);
    expect(f.push).toHaveBeenCalledOnce();
    expect(f.client.dispatch).not.toHaveBeenCalled();
    expect(formatDispatchUnknown(error.dispatch!)).toContain(
      "分类：候选推送被本地取消或中止",
    );
  },
);

test("C-758: a pushed candidate whose fence was taken by abandonment is push_cancelled", async () => {
  const f = setup();
  f.push.mockImplementationOnce(async () => {
    const intent = f.journal.unfinished()[0]!;
    f.store.uow.run((tx) =>
      tx.events.append(human.project_id, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(human.project_id, card.id),
        card_id: card.id,
        actor: { kind: "system", project_id: human.project_id },
        type: "github_check_dispatch",
        payload: JSON.parse(
          JSON.stringify({ ...intent, abandoned: "superseded" }),
        ),
        created_at: new Date(now).toISOString(),
      }),
    );
    return { status: "pushed" };
  });
  const error = await unknown(new GithubCheckExecutor(f.options), f.request);
  expect(error.dispatch?.stage).toBe("push_cancelled");
  expect(error.dispatch).not.toHaveProperty("pushFailure");
  expect(f.client.dispatch).not.toHaveBeenCalled();
  expect(f.journal.unfinished()).toEqual([]);
});

test("C-681: a dispatched run that never appears records run_not_found with the persisted POST response", async () => {
  const f = setup();
  let time = now;
  const options = { ...f.options, now: () => time };
  await expect(
    new GithubCheckExecutor(options).dispatch({
      ...f.request,
      totalTimeoutMs: 1000,
    }),
  ).rejects.toMatchObject({ retryAt: now + 20_000 });
  // The POST response is durable: a later pass (or restart) has no POST of its own.
  expect(f.journal.unfinished()[0]?.dispatchResponse).toEqual(post);
  time += 20_000;
  const error = await unknown(new GithubCheckExecutor(options), {
    ...f.request,
    totalTimeoutMs: 1000,
  });
  expect(f.client.dispatch).toHaveBeenCalledOnce();
  expect(error.dispatch).toEqual({
    stage: "run_not_found",
    last: listing,
    post,
  });
  expect(formatDispatchUnknown(error.dispatch!)).toBe(
    "分类：已发出但超时找不到运行；最近一次 GitHub 请求：GET 运行列表，HTTP 200，请求 id 0400:3333:CCCC，响应：total_count=0 workflow_runs=0；派发请求：POST 工作流派发，HTTP 204，请求 id 0400:2222:BBBB，响应：无正文",
  );
});

test("C-681: a rejected POST is kept as dispatch evidence for the later timeout", async () => {
  const f = setup();
  let time = now;
  const options = { ...f.options, now: () => time };
  const timed = { ...f.request, totalTimeoutMs: 1000 };
  const rejected: ExecutorHttpObservation = {
    operation: "dispatch",
    method: "POST",
    status: 422,
    requestId: "0400:4444:DDDD",
    summary: "Unexpected inputs provided",
  };
  f.client.dispatch.mockImplementationOnce(async () => {
    recordGithubHttp(rejected);
    const error = new GithubExecutorError("api");
    error.diagnostic = "HTTP 422";
    throw error;
  });
  await expect(
    new GithubCheckExecutor(options).dispatch(timed),
  ).rejects.toMatchObject({ category: "api" });
  expect(f.journal.unfinished()[0]?.dispatchResponse).toEqual(rejected);
  time += 20_000;
  const error = await unknown(new GithubCheckExecutor(options), timed);
  expect(error.dispatch).toMatchObject({
    stage: "run_not_found",
    post: rejected,
  });
  expect(formatDispatchUnknown(error.dispatch!)).toContain(
    "派发请求：POST 工作流派发，HTTP 422，请求 id 0400:4444:DDDD，响应：Unexpected inputs provided",
  );
});

test("C-681: the check reason and structured failure name the branch and the latest HTTP status", async () => {
  const error = new GithubExecutorError("dispatch_unknown");
  error.dispatch = { stage: "run_not_found", last: listing, post };
  const executor: CheckExecutor = {
    dispatch: vi.fn(async () => {
      throw error;
    }),
    poll: vi.fn(),
    cancel: vi.fn(),
    fetchFailureLog: vi.fn(),
  };
  const output: string[] = [];
  const reported: string[] = [];
  const result = await runCheckExecutor(
    executor,
    {
      kind: "merge_check",
      project: "project",
      sha: inputs.sha,
      tree: inputs.tree,
      attempt: "attempt",
      checks: [],
      onOutput: (_name, text) => output.push(text),
    },
    (e) => reported.push(e.message),
  );
  expect(result).toMatchObject({
    status: "executor_unreachable",
    executorFailure: {
      category: "dispatch_unknown",
      stage: "run_not_found",
      httpStatus: 200,
      requestId: "0400:3333:CCCC",
    },
  });
  expect(result.reason).toMatch(
    /^检查执行器不可用：dispatch_unknown（分类：已发出但超时找不到运行；最近一次 GitHub 请求：GET 运行列表，HTTP 200/u,
  );
  expect(output).toEqual([result.reason]);
  expect(reported).toEqual([result.reason]);
});

test("C-681: other executor failures keep their exact reason", async () => {
  const executor: CheckExecutor = {
    dispatch: vi.fn(async () => {
      throw new GithubExecutorError("recovery_incomplete");
    }),
    poll: vi.fn(),
    cancel: vi.fn(),
    fetchFailureLog: vi.fn(),
  };
  const result = await runCheckExecutor(
    executor,
    {
      kind: "merge_check",
      project: "project",
      sha: inputs.sha,
      tree: inputs.tree,
      attempt: "attempt",
      checks: [],
    },
    () => {},
  );
  expect(result.reason).toBe("检查执行器不可用：recovery_incomplete");
  expect(result.executorFailure).toEqual({ category: "recovery_incomplete" });
});

test("C-681: the real client records status, request id and a redacted body, never credentials", async () => {
  const fetcher = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          message: `Bad ${syntheticToken} Bearer ${syntheticToken} Authorization: token ${syntheticToken} https://x.example/log?sig=secret ${privateKey}`,
          documentation_url: "https://docs.github.com/rest",
        }),
        {
          status: 422,
          headers: { "x-github-request-id": "0400:5555:EEEE" },
        },
      ),
  );
  const client = new GithubClient({
    config,
    dataDir: "/synthetic",
    fetch: fetcher as typeof fetch,
    now: () => now,
  });
  vi.spyOn(client, "token").mockResolvedValue(syntheticToken);
  const trace = new GithubHttpTrace();
  await expect(
    githubHttpTrace.run(trace, () => client.dispatch("main", { a: "b" })),
  ).rejects.toMatchObject({ category: "api", diagnostic: "HTTP 422" });
  expect(trace.dispatch).toBe(trace.last);
  expect(trace.last).toMatchObject({
    operation: "dispatch",
    method: "POST",
    status: 422,
    requestId: "0400:5555:EEEE",
  });
  const text = formatDispatchUnknown({
    stage: "run_not_found",
    last: trace.last!,
  });
  expect(text).toContain("HTTP 422，请求 id 0400:5555:EEEE，响应：Bad");
  expectRedacted(text);
  expectRedacted(JSON.stringify(trace.last));
  // The request did carry the credential; the observation must not.
  const headers = fetcher.mock.calls[0]![1]!.headers as Record<string, string>;
  expect(headers.Authorization).toBe(`Bearer ${syntheticToken}`);
});

test("C-681: successful bodies keep only allow-listed scalar fields and transport failures keep a fixed code", async () => {
  expect(
    summarizeProviderBody({
      token: syntheticToken,
      expires_at: "2026-11-15T01:00:00Z",
    }),
  ).toBe("正文已省略");
  expect(
    summarizeProviderBody({ total_count: 2, workflow_runs: [{}, {}] }),
  ).toBe("total_count=2 workflow_runs=2");
  expect(
    redactProviderText(`x-access-token:${syntheticToken}@github`),
  ).not.toContain("ghs_");
  const failure = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(`connect to ${syntheticToken}`), {
      code: "ECONNRESET",
    }),
  });
  const client = new GithubClient({
    config,
    dataDir: "/synthetic",
    fetch: vi.fn(async () => {
      throw failure;
    }) as typeof fetch,
    now: () => now,
  });
  vi.spyOn(client, "token").mockResolvedValue(syntheticToken);
  const trace = new GithubHttpTrace();
  await expect(
    githubHttpTrace.run(trace, () => client.run(123)),
  ).rejects.toBeInstanceOf(GithubExecutorError);
  expect(trace.last).toEqual({
    operation: "run",
    method: "GET",
    summary: "ECONNRESET",
  });
});
