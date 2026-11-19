import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PushResult } from "@cardigan/git-transport";
import { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { fixture, human } from "../../domain/src/commands/test-fixtures.js";
import { type CheckRequest, runCheckExecutor } from "./check-executor.js";
import { CheckExecutorSuspended } from "./checkout-deadline.js";
import { GithubBudgetJournal } from "./github-budget-journal.js";
import {
  GithubCheckExecutor,
  githubCheckRunName,
} from "./github-check-executor.js";
import { GithubCheckPoller } from "./github-check-poller.js";
import {
  GithubClient,
  GithubExecutorError,
  GithubNotFoundError,
  type GithubRun,
} from "./github-client.js";
import { GithubDispatchJournal } from "./github-dispatch-journal.js";
import { GithubRateLimit, GithubRetryLater } from "./github-rate-limit.js";
import type { GithubMergeGateExecutor } from "./merge-gate-executors.js";

const stores: Store[] = [],
  roots: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const now = Date.parse("2026-11-15T00:00:00Z");
const syntheticToken = `ghs_${"a".repeat(190)}.${"b".repeat(195)}`;
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

test("C-404: queue timeout and rejected cancellation retain the journal until confirmed terminal", async () => {
  const f = setup();
  let time = now;
  let remote = {
    ...trusted,
    display_title: "Cardigan check",
    status: "queued",
    conclusion: null as string | null,
  };
  const client = {
    ...f.client,
    run: vi.fn(async () => remote),
    pollRuns: vi.fn(async () => ({ unchanged: false, runs: [remote] })),
    cancel: vi.fn(async () => {
      throw new Error("409");
    }),
    jobs: vi.fn(async () => []),
    jobLog: vi.fn(async () => ""),
  };
  const lifecycle = new GithubCheckPoller({
    client,
    now: () => time,
    queueWaitMs: 60_000,
  });
  const executor = new GithubCheckExecutor({
    ...f.options,
    client,
    lifecycle,
    now: () => time,
  });
  const handle = await executor.dispatch(f.request);
  const result = executor.poll(handle);
  time += 60_000;
  await lifecycle.tick();
  expect(await result).toMatchObject({
    status: "timed_out",
    reason: "GitHub 长时间未启动 · 已等 1 分钟",
  });
  expect(client.cancel).toHaveBeenCalledWith(123);
  expect(f.journal.unfinished()).toHaveLength(1);
  await expect(
    executor.dispatch({ ...f.request, attempt: "attempt-2" }),
  ).rejects.toMatchObject({ category: "card_busy" });
  remote = { ...remote, status: "completed", conclusion: "cancelled" };
  time += 20_000;
  await lifecycle.tick();
  expect(f.journal.unfinished()).toHaveLength(0);
  expect(f.client.dispatch).toHaveBeenCalledOnce();
});
const unevaluated: GithubRun = {
  ...trusted,
  name: "Cardigan check",
  display_title: "Cardigan check",
};

test("dispatch IDs that are not yet visible keep the original reservation and discovery cadence", async () => {
  const f = setup();
  let time = now;
  const executor = new GithubCheckExecutor({ ...f.options, now: () => time });
  f.client.run.mockRejectedValueOnce(new GithubNotFoundError());
  await expect(executor.dispatch(f.request)).rejects.toMatchObject({
    retryAt: now + 20_000,
  });
  expect(f.onExternalRun).not.toHaveBeenCalled();
  expect(f.request.onReady).not.toHaveBeenCalled();
  expect(f.journal.unfinished()[0]?.dispatchedRunId).toBe(123);
  await expect(executor.dispatch(f.request)).rejects.toMatchObject({
    retryAt: now + 20_000,
  });
  expect(f.client.run).toHaveBeenCalledOnce();
  time += 20_000;
  await executor.dispatch(f.request);
  expect(f.client.run).toHaveBeenCalledTimes(2);
  expect(f.push).toHaveBeenCalledOnce();
  expect(f.client.dispatch).toHaveBeenCalledOnce();
  expect(f.onExternalRun).toHaveBeenCalledOnce();
});

test("an invisible dispatch ID expires without releasing capacity or redispatching", async () => {
  const f = setup();
  let time = now;
  const executor = new GithubCheckExecutor({ ...f.options, now: () => time });
  f.client.run.mockRejectedValue(new GithubNotFoundError());
  const input = { ...f.request, totalTimeoutMs: 1000 };
  await expect(executor.dispatch(input)).rejects.toMatchObject({
    retryAt: now + 20_000,
  });
  time += 20_000;
  await expect(executor.dispatch(input)).rejects.toMatchObject({
    category: "dispatch_unknown",
  });
  expect(f.journal.unfinished()).toHaveLength(1);
  expect(f.client.dispatch).toHaveBeenCalledOnce();
  expect(f.request.onReady).not.toHaveBeenCalled();
});

test("a missing already bound run is an API error rather than new discovery", async () => {
  const f = setup();
  await f.executor.dispatch(f.request);
  f.client.run.mockRejectedValue(new GithubNotFoundError());
  await expect(
    new GithubCheckExecutor(f.options).dispatch(f.request),
  ).rejects.toBeInstanceOf(GithubNotFoundError);
  expect(f.client.dispatch).toHaveBeenCalledOnce();
  expect(f.journal.unfinished()).toHaveLength(1);
});
function setup(dbPath = ":memory:", seed = true) {
  const store = Store.open({ dbPath });
  stores.push(store);
  if (seed) {
    store.createProject({ id: human.project_id });
    store.uow.run((tx) => tx.cards.put(human.project_id, card));
  }
  const client = {
    token: vi.fn(async () => syntheticToken),
    dispatch: vi.fn(async (): Promise<number | undefined> => 123),
    run: vi.fn(async () => trusted),
    runs: vi.fn(async () => [trusted]),
  };
  const push = vi.fn(async (): Promise<PushResult> => ({ status: "pushed" }));
  const isBaselineAncestor = vi.fn(async () => true);
  const onExternalRun = vi.fn();
  const lifecycle = {
    poll: vi.fn(async () => ({
      status: "passed" as const,
      checks: [{ name: "test", status: "passed" as const, exit_code: 0 }],
      cleanup_errors: [],
    })),
    cancel: vi.fn(async () => {}),
    fetchFailureLog: vi.fn(async () => undefined),
  };
  const journal = new GithubDispatchJournal(store);
  const options = {
    config,
    client,
    journal,
    context: () => ({
      card: card.id,
      delivery: "D-1",
      baselineBranch: "main",
      onExternalRun,
    }),
    push,
    isBaselineAncestor,
    lifecycle,
    now: () => now,
  };
  const executor = new GithubCheckExecutor(options);
  const request: CheckRequest = {
    kind: "merge_check",
    project: human.project_id,
    sha: inputs.sha,
    tree: inputs.tree,
    attempt: inputs.attempt,
    checks: [{ name: "test", run: "true" }],
    onReady: vi.fn(),
  };
  const events = () =>
    store.uow.read((tx) => tx.events.listAfter(human.project_id, card.id, 0));
  return {
    store,
    client,
    push,
    isBaselineAncestor,
    onExternalRun,
    lifecycle,
    journal,
    options,
    executor,
    request,
    events,
  };
}
test("hold during candidate publication remains a suspension through diagnostic wrapping and resumes the same attempt", async () => {
  const f = setup();
  f.push.mockImplementationOnce(async () => {
    f.store.uow.run((tx) =>
      tx.cards.put(human.project_id, {
        ...card,
        hold: {
          reason: "Wait for evidence",
          resume_condition: "Evidence checked",
          set_by: "human",
          set_at: new Date(now).toISOString(),
        },
      }),
    );
    return { status: "pushed" };
  });
  await expect(
    runCheckExecutor(f.executor, f.request, vi.fn()),
  ).rejects.toBeInstanceOf(CheckExecutorSuspended);
  expect(f.client.dispatch).not.toHaveBeenCalled();
  expect(f.request.onReady).not.toHaveBeenCalled();
  expect(f.journal.unfinished()).toMatchObject([
    { attempt: f.request.attempt, phase: "reserved" },
  ]);
  f.store.uow.run((tx) => tx.cards.put(human.project_id, card));
  await expect(
    runCheckExecutor(new GithubCheckExecutor(f.options), f.request, vi.fn()),
  ).resolves.toMatchObject({ status: "passed" });
  expect(f.client.dispatch).toHaveBeenCalledOnce();
});
test("D3: dispatch pushes only the candidate, binds the trusted baseline run before readiness, and delegates D4 lifecycle", async () => {
  const f = setup();
  const handle = await f.executor.dispatch(f.request);
  expect(f.push).toHaveBeenCalledWith({
    repo: config.repo,
    sha: inputs.sha,
    ref: `refs/heads/ci/${card.id}/D-1/attempt-1`,
    token: syntheticToken,
  });
  expect(f.client.dispatch).toHaveBeenCalledWith("main", inputs);
  expect(JSON.stringify(f.events())).not.toContain(syntheticToken);
  expect(JSON.stringify(f.journal.all())).not.toContain(syntheticToken);
  expect(f.isBaselineAncestor).toHaveBeenCalledWith(trusted.head_sha, "main");
  expect(f.onExternalRun).toHaveBeenCalledWith({
    provider: "github",
    run_id: 123,
    run_attempt: 1,
    html_url: trusted.html_url,
    workflow_sha: trusted.head_sha,
  });
  expect(f.onExternalRun.mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(f.request.onReady!).mock.invocationCallOrder[0]!,
  );
  expect((await f.executor.poll(handle)).status).toBe("passed");
  await f.executor.cancel(handle);
  await f.executor.fetchFailureLog(handle);
  expect(f.lifecycle.poll).toHaveBeenCalledWith(
    f.onExternalRun.mock.calls[0]![0],
  );
  await expect(f.executor.poll({ id: handle.id })).rejects.toMatchObject({
    category: "api",
  });
  expect(JSON.stringify(f.events())).not.toContain("ghs_synthetic");
});
test.each([
  { path: ".github/workflows/evil.yml" },
  { event: "push" },
  { head_branch: "ci/C-1/D-1/a" },
  { head_sha: "invalid" },
  { actor: { login: "human" } },
  { triggering_actor: { login: "human" } },
  { run_attempt: 2 },
  { id: 124 },
  { html_url: `${trusted.html_url}?token=synthetic` },
  { created_at: "2020-01-01T00:00:00Z" },
  { created_at: "2099-01-01T00:00:00Z" },
  { created_at: "invalid" },
])(
  "D3: rejects unsafe run binding %j without recording readiness or passing",
  async (override) => {
    const f = setup();
    f.client.run.mockResolvedValue({ ...trusted, ...override });
    const onError = vi.fn();
    expect(
      await runCheckExecutor(f.executor, f.request, onError),
    ).toMatchObject({
      status: "executor_unreachable",
      checks: [],
      reason: expect.stringContaining("security"),
    });
    expect(f.onExternalRun).not.toHaveBeenCalled();
    expect(f.request.onReady).not.toHaveBeenCalled();
    expect(f.lifecycle.poll).not.toHaveBeenCalled();
    expect(JSON.stringify(f.events())).not.toContain("externalRun");
    expect(onError).toHaveBeenCalledOnce();
  },
);
test("D3: rejects a run outside central baseline history", async () => {
  const f = setup();
  f.isBaselineAncestor.mockResolvedValue(false);
  await expect(f.executor.dispatch(f.request)).rejects.toMatchObject({
    category: "security",
  });
  expect(f.onExternalRun).not.toHaveBeenCalled();
});
test("D3: a 204 response uses the exact name and time window, ambiguity fails closed", async () => {
  const f = setup();
  f.client.dispatch.mockResolvedValue(undefined);
  await f.executor.dispatch(f.request);
  expect(f.client.runs).toHaveBeenCalledWith(
    "main",
    trusted.created_at,
    undefined,
  );
  const g = setup();
  g.client.dispatch.mockResolvedValue(undefined);
  g.client.runs.mockResolvedValue([trusted, trusted]);
  await expect(g.executor.dispatch(g.request)).rejects.toMatchObject({
    category: "security",
  });
});
test("D3: parallel same-attempt calls dispatch once; another attempt waits and a changed executor is rejected", async () => {
  const f = setup();
  const [a, b] = await Promise.all([
    f.executor.dispatch(f.request),
    f.executor.dispatch(f.request),
  ]);
  expect(a).toBe(b);
  expect(f.client.dispatch).toHaveBeenCalledOnce();
  await expect(
    f.executor.dispatch({ ...f.request, attempt: "attempt-2" }),
  ).rejects.toMatchObject({ category: "card_busy" });
  expect(f.client.dispatch).toHaveBeenCalledOnce();
  const changed = new GithubCheckExecutor({
    ...f.options,
    config: { ...config, name: "other" },
  });
  await expect(changed.dispatch(f.request)).rejects.toMatchObject({
    category: "security",
  });
  await expect(
    f.executor.dispatch({ ...f.request, sha: "d".repeat(40) }),
  ).rejects.toMatchObject({ category: "security" });
});
test("D3: persisted identity survives reopening SQLite; it is revalidated without push or redispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "cg-github-restart-"));
  roots.push(root);
  const db = join(root, "test.sqlite");
  const f = setup(db);
  await f.executor.dispatch(f.request);
  const g = setup(db, false);
  await g.executor.dispatch(g.request);
  expect(g.push).not.toHaveBeenCalled();
  expect(g.client.dispatch).not.toHaveBeenCalled();
  expect(g.client.run).toHaveBeenCalledWith(123);
  await expect(
    g.executor.dispatch({ ...g.request, attempt: "attempt-2" }),
  ).rejects.toMatchObject({ category: "card_busy" });
});
test("D3: a lost dispatch response leaves a durable intent; retry searches, never POSTs twice or exposes raw errors", async () => {
  const f = setup();
  f.client.dispatch.mockRejectedValue(
    new Error("PRIVATE-KEY JWT ghs_synthetic"),
  );
  const result = await runCheckExecutor(f.executor, f.request, () => {});
  expect(result).toMatchObject({ status: "executor_unreachable" });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE-KEY|JWT|ghs_synthetic/u);
  await f.executor.dispatch(f.request);
  expect(f.client.dispatch).toHaveBeenCalledOnce();
  expect(f.push).toHaveBeenCalledOnce();
  expect(f.client.runs).toHaveBeenCalledOnce();
});
test("D3: missing runs retain the reservation; no unsafe branch reaches git", async () => {
  const f = setup();
  f.client.dispatch.mockResolvedValue(undefined);
  f.client.runs.mockResolvedValue([]);
  await expect(f.executor.dispatch(f.request)).rejects.toMatchObject({
    category: "api",
    retryAt: now + 20_000,
  });
  await expect(f.executor.dispatch(f.request)).rejects.toMatchObject({
    category: "api",
    retryAt: now + 20_000,
  });
  expect(f.client.dispatch).toHaveBeenCalledOnce();
  for (const attempt of ["+force", "../../main", "a:refs/heads/main", "a b"])
    await expect(
      f.executor.dispatch({ ...f.request, attempt }),
    ).rejects.toMatchObject({ category: "security" });
  expect(f.push).toHaveBeenCalledOnce();
});

test("D3: cancel and unreachable results retain occupancy until a verified remote terminal result", async () => {
  const f = setup();
  const handle = await f.executor.dispatch(f.request);
  await f.executor.cancel(handle);
  await expect(
    f.executor.dispatch({ ...f.request, attempt: "attempt-2" }),
  ).rejects.toMatchObject({ category: "card_busy" });
  f.lifecycle.poll.mockResolvedValueOnce({
    status: "executor_unreachable",
    checks: [],
    cleanup_errors: [],
  } as never);
  await f.executor.poll(handle);
  await expect(
    f.executor.dispatch({ ...f.request, attempt: "attempt-2" }),
  ).rejects.toMatchObject({ category: "card_busy" });
  await f.executor.poll(handle);
  // The next attempt is now admitted; give it a distinct trusted run identity.
  const nextInputs = { ...inputs, attempt: "attempt-2" };
  f.client.run.mockResolvedValue({
    ...trusted,
    display_title: githubCheckRunName(nextInputs),
  });
  await f.executor.dispatch({ ...f.request, attempt: "attempt-2" });
  expect(f.client.dispatch).toHaveBeenCalledTimes(2);
});

test("D3: failure before the POST boundary can retry preparation without stranding a card", async () => {
  const f = setup();
  f.client.token.mockRejectedValueOnce(
    new Error("synthetic credential failure"),
  );
  await expect(f.executor.dispatch(f.request)).rejects.toMatchObject({
    category: "api",
  });
  expect(f.client.dispatch).not.toHaveBeenCalled();
  await f.executor.dispatch(f.request);
  expect(f.client.dispatch).toHaveBeenCalledOnce();
});

test("D3: two executor instances sharing SQLite cross the dispatch boundary only once", async () => {
  const root = mkdtempSync(join(tmpdir(), "cg-github-race-"));
  roots.push(root);
  const db = join(root, "test.sqlite");
  const f = setup(db),
    g = setup(db, false);
  const other = new GithubCheckExecutor({
    ...g.options,
    client: f.client,
    push: f.push,
  });
  const results = await Promise.allSettled([
    f.executor.dispatch(f.request),
    other.dispatch(g.request),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    results.filter((result) => result.status === "rejected"),
  ).toMatchObject([{ reason: { category: "recovery_incomplete" } }]);
  await other.dispatch(g.request);
  expect(f.client.dispatch).toHaveBeenCalledOnce();
});

test("D3: a late binding retains a cancellable handle without publishing readiness after abort", async () => {
  const f = setup(),
    abort = new AbortController();
  f.client.run.mockImplementation(async () => {
    abort.abort();
    return trusted;
  });
  const handle = await f.executor.dispatch({
    ...f.request,
    signal: abort.signal,
  });
  expect(f.onExternalRun).not.toHaveBeenCalled();
  expect(f.request.onReady).not.toHaveBeenCalled();
  await f.executor.cancel(handle);
  expect(f.lifecycle.cancel).toHaveBeenCalledOnce();
});

test.each(["", "@main"])(
  "D3 rework: binds the exact workflow with GitHub path suffix %j",
  async (suffix) => {
    const f = setup();
    f.client.run.mockResolvedValue({
      ...trusted,
      path: `${config.workflow}${suffix}`,
    });
    await f.executor.dispatch(f.request);
    expect(f.onExternalRun).toHaveBeenCalledOnce();
    expect(f.request.onReady).toHaveBeenCalledOnce();
  },
);
test.each([
  "@other",
  "@refs/tags/main",
  "@main/extra",
  "@main@other",
  "@Main",
  ".extra@main",
])(
  "D3 rework: rejects workflow ref or filename mismatch %s",
  async (suffix) => {
    const f = setup();
    f.client.run.mockResolvedValue({
      ...trusted,
      path: `${config.workflow}${suffix}`,
    });
    await expect(f.executor.dispatch(f.request)).rejects.toMatchObject({
      category: "security",
    });
    expect(f.onExternalRun).not.toHaveBeenCalled();
  },
);

test.each([false, true])(
  "D3 rework: lost dispatch recovery scans every page and rejects cross-page ambiguity=%s",
  async (ambiguous) => {
    const f = setup();
    f.client.dispatch.mockRejectedValue(new Error("synthetic lost response"));
    await expect(f.executor.dispatch(f.request)).rejects.toMatchObject({
      category: "api",
    });
    const visited: string[] = [];
    const target = { ...trusted, path: `${config.workflow}@main` };
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/cancel"))
        return new Response(null, { status: 204 });
      if (url.pathname.endsWith("/runs/123"))
        return new Response(JSON.stringify(target));
      const page = url.searchParams.get("page") ?? "1";
      visited.push(page);
      const next = new URL(url);
      next.searchParams.set("page", "2");
      const first = Array.from({ length: 100 }, (_, i) => ({
        ...trusted,
        id: 1000 + i,
        display_title:
          ambiguous && i === 0 ? trusted.display_title : `other-${i}`,
      }));
      return new Response(
        JSON.stringify({
          total_count: 101,
          workflow_runs: page === "1" ? first : [target],
        }),
        { headers: page === "1" ? { link: `<${next}>; rel="next"` } : {} },
      );
    });
    const client = new GithubClient({
      config,
      dataDir: "/synthetic",
      fetch: fetcher as typeof fetch,
      now: () => now,
    });
    vi.spyOn(client, "token").mockResolvedValue("ghs_synthetic");
    const restored = new GithubCheckExecutor({ ...f.options, client });
    if (ambiguous) {
      await expect(restored.dispatch(f.request)).rejects.toMatchObject({
        category: "security",
      });
      expect(f.onExternalRun).not.toHaveBeenCalled();
    } else {
      await restored.dispatch(f.request);
      expect(f.onExternalRun).toHaveBeenCalledWith(
        expect.objectContaining({ run_id: 123 }),
      );
      await new GithubCheckExecutor({ ...f.options, client }).dispatch(
        f.request,
      );
      expect(fetcher.mock.calls.at(-1)?.[0]).toBe(
        "https://api.github.com/repos/fixture/project/actions/runs/123",
      );
    }
    expect(visited).toEqual(["1", "2"]);
    expect(f.push).toHaveBeenCalledOnce();
    expect(f.client.dispatch).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.events())).not.toContain("ghs_synthetic");
  },
);

// The fake API enforces GitHub's filtered-query ceiling, even if total_count
// reports more. The oldest target is absent from the original first 1000.
function cappedRecoveryClient(
  mode: "unique" | "ambiguous" | "dense" = "unique",
  rate?: GithubRateLimit,
) {
  const end = now + 20_000;
  let time = end;
  const target = { ...trusted, created_at: new Date(now).toISOString() };
  const records = [
    target,
    ...Array.from({ length: 1001 }, (_, i) => ({
      ...trusted,
      id: 1000 + i,
      html_url: `https://github.com/${config.repo}/actions/runs/${1000 + i}`,
      display_title:
        mode === "ambiguous" && i === 1000
          ? trusted.display_title
          : `other-${i}`,
      created_at: new Date(
        mode === "dense" ? now : now + ((i % 20) + 1) * 1000,
      ).toISOString(),
    })),
  ];
  const visited: URL[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    visited.push(url);
    if (url.pathname.endsWith("/runs/123"))
      return new Response(JSON.stringify(target));
    if (!url.searchParams.has("created"))
      return new Response(JSON.stringify({ workflow_runs: [target] }));
    const [from, to] = url.searchParams
      .get("created")!
      .split("..")
      .map(Date.parse);
    const selected = records
      .filter(
        (r) =>
          Date.parse(r.created_at) >= from! && Date.parse(r.created_at) <= to!,
      )
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const page = Number(url.searchParams.get("page"));
    const capped = selected.slice(0, 1000);
    return new Response(
      JSON.stringify({
        total_count: selected.length,
        workflow_runs: capped.slice((page - 1) * 100, page * 100),
      }),
    );
  });
  const client = new GithubClient({
    config,
    dataDir: "/synthetic",
    fetch: fetcher as typeof fetch,
    now: () => time,
    ...(rate ? { rate } : {}),
  });
  vi.spyOn(client, "token").mockResolvedValue("ghs_synthetic");
  return {
    client,
    visited,
    fetcher,
    get end() {
      return time;
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test("C-334: recovers the target outside the original 1000, then restarts without another push or POST", async () => {
  const root = mkdtempSync(join(tmpdir(), "cg-capped-recovery-"));
  roots.push(root);
  const db = join(root, "test.sqlite");
  const f = setup(db);
  f.client.dispatch.mockRejectedValue(new Error("synthetic lost response"));
  await expect(f.executor.dispatch(f.request)).rejects.toMatchObject({
    category: "api",
  });
  const api = cappedRecoveryClient();
  const restored = setup(db, false);
  await new GithubCheckExecutor({
    ...restored.options,
    client: api.client,
    now: () => api.end,
  }).dispatch(restored.request);
  expect(restored.onExternalRun).toHaveBeenCalledWith(
    expect.objectContaining({ run_id: 123 }),
  );
  expect(
    api.visited.some(
      (url) =>
        url.searchParams.get("created") !==
          `${trusted.created_at}..${new Date(api.end).toISOString()}` &&
        url.searchParams.has("created"),
    ),
  ).toBe(true);
  const again = setup(db, false);
  await new GithubCheckExecutor({
    ...again.options,
    client: api.client,
    now: () => api.end,
  }).dispatch(again.request);
  expect(again.push).not.toHaveBeenCalled();
  expect(again.client.dispatch).not.toHaveBeenCalled();
  expect(restored.push).not.toHaveBeenCalled();
  expect(restored.client.dispatch).not.toHaveBeenCalled();
  expect(f.client.dispatch).toHaveBeenCalledOnce();
});

test.each(["ambiguous", "dense"] as const)(
  "C-334: %s recovery keeps the reservation and cannot publish readiness",
  async (mode) => {
    const f = setup();
    f.client.dispatch.mockRejectedValue(new Error("synthetic lost response"));
    await expect(f.executor.dispatch(f.request)).rejects.toMatchObject({
      category: "api",
    });
    const api = cappedRecoveryClient(mode);
    const executor = new GithubCheckExecutor({
      ...f.options,
      client: api.client,
      now: () => api.end,
    });
    for (let i = 0; i < 2; i++) {
      await expect(executor.dispatch(f.request)).rejects.toMatchObject({
        category: mode === "dense" ? "recovery_incomplete" : "security",
      });
      api.advance(20_000);
    }
    expect(f.onExternalRun).not.toHaveBeenCalled();
    expect(f.request.onReady).not.toHaveBeenCalled();
    await expect(
      executor.dispatch({ ...f.request, attempt: "attempt-2" }),
    ).rejects.toMatchObject({ category: "card_busy" });
    expect(f.client.dispatch).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.events())).not.toContain("ghs_synthetic");
  },
);

test.each([
  { run_attempt: 2 },
  { head_sha: "d".repeat(40) },
  { path: `${config.workflow}@other` },
  { actor: { login: "other[bot]" } },
  { id: 124 },
])(
  "C-334: exact-ID reread rejects identity drift after discovery %j",
  async (change) => {
    const f = setup();
    f.client.dispatch.mockResolvedValue(undefined);
    f.client.run.mockResolvedValue({ ...trusted, ...change });
    await expect(f.executor.dispatch(f.request)).rejects.toMatchObject({
      category: "security",
    });
    expect(f.onExternalRun).not.toHaveBeenCalled();
    expect(f.request.onReady).not.toHaveBeenCalled();
    await expect(
      f.executor.dispatch({ ...f.request, attempt: "attempt-2" }),
    ).rejects.toMatchObject({ category: "card_busy" });
  },
);

test.each(["limit", "cancel"] as const)(
  "C-334: %s interrupts a partial scan; restart resumes discovery without redispatch",
  async (mode) => {
    const f = setup();
    f.client.dispatch.mockRejectedValue(new Error("synthetic lost response"));
    await expect(f.executor.dispatch(f.request)).rejects.toMatchObject({
      category: "api",
    });
    const api = cappedRecoveryClient();
    const fetcher = api.fetcher.getMockImplementation()!;
    const controller = new AbortController();
    let calls = 0;
    api.fetcher.mockImplementation(async (input) => {
      if (++calls === 4) {
        if (mode === "limit")
          return new Response("ghs_synthetic secret", {
            status: 429,
            headers: { "Retry-After": "60" },
          });
        controller.abort(new Error("ghs_synthetic cancellation"));
      }
      return fetcher(input);
    });
    const options = { ...f.options, client: api.client, now: () => api.end };
    const executor = new GithubCheckExecutor(options);
    await expect(
      executor.dispatch({ ...f.request, signal: controller.signal }),
    ).rejects.toMatchObject({
      category: mode === "limit" ? "api" : "recovery_incomplete",
    });
    expect(f.onExternalRun).not.toHaveBeenCalled();
    expect(f.request.onReady).not.toHaveBeenCalled();
    await expect(
      executor.dispatch({ ...f.request, attempt: "attempt-2" }),
    ).rejects.toMatchObject({ category: "card_busy" });
    api.fetcher.mockImplementation(fetcher);
    api.advance(mode === "limit" ? 60_000 : 20_000);
    await new GithubCheckExecutor(options).dispatch(f.request);
    expect(f.onExternalRun).toHaveBeenCalledOnce();
    expect(f.push).toHaveBeenCalledOnce();
    expect(f.client.dispatch).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.events())).not.toContain("ghs_synthetic");
  },
);

// Independent security regression, synthetic API/Git only; no production IO.
test.each([
  "stable",
  "parent_ambiguity",
  "parent_identity_drift",
  "parent_title_drift",
] as const)(
  "C-334 review regression: retain saturated parent evidence (%s)",
  async (mode) => {
    const f = setup();
    f.client.dispatch.mockRejectedValue(new Error("synthetic lost response"));
    await expect(f.executor.dispatch(f.request)).rejects.toMatchObject({
      category: "api",
    });
    const end = now + 20_000;
    const target = { ...trusted, created_at: new Date(end).toISOString() };
    const second = {
      ...trusted,
      id: 124,
      html_url: "https://github.com/fixture/project/actions/runs/124",
      created_at: new Date(end - 1000).toISOString(),
      display_title:
        mode === "parent_ambiguity" || mode === "parent_title_drift"
          ? trusted.display_title
          : "other-second",
    };
    const fillers = Array.from({ length: 1000 }, (_, i) => ({
      ...trusted,
      id: 1000 + i,
      html_url: `https://github.com/fixture/project/actions/runs/${1000 + i}`,
      display_title: `other-${i}`,
      created_at: new Date(now + (i % 19) * 1000).toISOString(),
    }));
    const rootRecords = [
      { ...target, run_attempt: mode === "parent_identity_drift" ? 2 : 1 },
      second,
      ...fillers,
    ];
    const leafRecords = [
      target,
      mode === "parent_ambiguity"
        ? {
            ...second,
            id: 2124,
            html_url: "https://github.com/fixture/project/actions/runs/2124",
            display_title: "replacement-visible-after-root",
          }
        : mode === "parent_title_drift"
          ? { ...second, display_title: "other-second" }
          : second,
      ...fillers,
    ];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/runs/123"))
        return new Response(JSON.stringify(target));
      const [from, to] = url.searchParams
        .get("created")!
        .split("..")
        .map(Date.parse);
      const isRoot = from === now && to === end;
      const selected = (isRoot ? rootRecords : leafRecords)
        .filter(
          (r) =>
            Date.parse(r.created_at) >= from! &&
            Date.parse(r.created_at) <= to!,
        )
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      const page = Number(url.searchParams.get("page"));
      const rows = selected.slice(0, 1000).slice((page - 1) * 100, page * 100);
      return new Response(
        JSON.stringify({ total_count: selected.length, workflow_runs: rows }),
      );
    });
    const client = new GithubClient({
      config,
      dataDir: "/synthetic",
      fetch: fetcher as typeof fetch,
      now: () => end,
    });
    vi.spyOn(client, "token").mockResolvedValue("ghs_synthetic");
    const executor = new GithubCheckExecutor({
      ...f.options,
      client,
      now: () => end,
    });
    const result = await executor.dispatch(f.request).then(
      (handle) => ({ resolved: true, handle }),
      (error) => ({ resolved: false, category: error.category }),
    );
    expect(f.client.dispatch).toHaveBeenCalledOnce();
    expect(f.push).toHaveBeenCalledOnce();
    if (mode === "stable") expect(result.resolved).toBe(true);
    else {
      expect(
        result.resolved,
        "known parent ambiguity/identity conflict must fail closed",
      ).toBe(false);
      expect(f.onExternalRun).not.toHaveBeenCalled();
      expect(f.request.onReady).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        category:
          mode === "parent_ambiguity" ? "recovery_incomplete" : "security",
      });
      expect(
        f
          .events()
          .some(
            (e) => e.type === "github_check_dispatch" && e.payload.externalRun,
          ),
      ).toBe(false);
      await expect(
        executor.dispatch({ ...f.request, attempt: "attempt-2" }),
      ).rejects.toMatchObject({ category: "card_busy" });
    }
  },
);
test("D4: durable reservations enforce executor capacity across cards, even after a local unreachable result", async () => {
  const f = setup();
  const handle = await f.executor.dispatch(f.request);
  const pending = f.journal.unfinished()[0]!;
  f.store.uow.run((tx) =>
    tx.cards.put(human.project_id, { ...card, id: "C-999" as never }),
  );
  const another = {
    ...pending,
    card: "C-999",
    attempt: "attempt-other",
    candidate: {
      ...pending.candidate,
      ref: "refs/heads/ci/C-999/D-1/attempt-other",
    },
    key: "other",
    externalRun: undefined,
    identity: undefined,
  };
  const claim = () => f.journal.claim(another as never, 1);
  expect(claim).toThrow("card_busy");
  f.lifecycle.poll.mockResolvedValueOnce({
    status: "executor_unreachable",
    checks: [],
    cleanup_errors: [],
  } as never);
  await f.executor.poll(handle);
  expect(claim).toThrow("card_busy");
  await f.executor.poll(handle);
  expect(claim().fresh).toBe(true);
});

const budgetState = (store: Store) =>
  new GithubBudgetJournal(store, config.name).update((state) => ({ ...state }));
const closeFixtureStore = (store: Store) => {
  store.close();
  stores.splice(stores.indexOf(store), 1);
};
async function loseDispatch(f: ReturnType<typeof setup>) {
  f.client.dispatch.mockRejectedValue(new Error("synthetic lost response"));
  await expect(f.executor.dispatch(f.request)).rejects.toMatchObject({
    category: "api",
  });
}

test("C-334 D4 integration: split pages, exact reads, polling and cancellation debit the same durable budget", async () => {
  const f = setup();
  await loseDispatch(f);
  const rate = new GithubRateLimit(
    2000,
    () => now + 20_000,
    new GithubBudgetJournal(f.store, config.name),
  );
  const api = cappedRecoveryClient("unique", rate);
  const executor = new GithubCheckExecutor({
    ...f.options,
    client: api.client,
    now: () => api.end,
  });
  await executor.dispatch(f.request);
  expect(
    api.visited.filter((url) => url.searchParams.has("created")).length,
  ).toBeGreaterThan(10);
  expect(api.visited.some((url) => url.pathname.endsWith("/runs/123"))).toBe(
    true,
  );
  expect(budgetState(f.store).used).toBe(api.fetcher.mock.calls.length);
  const used = budgetState(f.store).used;
  await api.client.pollRuns();
  await api.client.run(123);
  await api.client.cancel(123);
  expect(budgetState(f.store).used).toBe(used + 3);
  expect(budgetState(f.store).used).toBe(api.fetcher.mock.calls.length);
  expect(f.onExternalRun).toHaveBeenCalledOnce();
  expect(f.client.dispatch).toHaveBeenCalledOnce();
});

test("C-334 D4 integration: partial discovery exhausts durable quota; reopening SQLite cannot obtain a fresh allowance", async () => {
  const root = mkdtempSync(join(tmpdir(), "cg-recovery-budget-"));
  roots.push(root);
  const db = join(root, "state.sqlite");
  const f = setup(db);
  await loseDispatch(f);
  let time = now + 20_000;
  const rateFor = (store: Store) =>
    new GithubRateLimit(
      20,
      () => time,
      new GithubBudgetJournal(store, config.name),
    );
  const rate = rateFor(f.store);
  // Leave four calls for this scan, using a small fixture quota rather than a
  // new production default. Earlier consumers have already spent the rest.
  for (let i = 0; i < 16; i++) rate.reserve();
  const api = cappedRecoveryClient("unique", rate);
  await expect(
    new GithubCheckExecutor({
      ...f.options,
      client: api.client,
      now: () => time,
    }).dispatch(f.request),
  ).rejects.toMatchObject({ category: "api" });
  expect(api.fetcher).toHaveBeenCalledTimes(4);
  expect(budgetState(f.store).used).toBe(20);
  await expect(api.client.run(123)).rejects.toMatchObject({
    category: "api",
    retryAt: time + 3_600_000,
  });
  expect(api.fetcher).toHaveBeenCalledTimes(4);
  expect(f.onExternalRun).not.toHaveBeenCalled();
  expect(f.journal.unfinished()).toMatchObject([{ phase: "dispatching" }]);
  closeFixtureStore(f.store);
  const g = setup(db, false);
  const restored = cappedRecoveryClient("unique", rateFor(g.store));
  const executor = new GithubCheckExecutor({
    ...g.options,
    client: restored.client,
    now: () => time,
  });
  await expect(executor.dispatch(g.request)).rejects.toMatchObject({
    category: "api",
  });
  expect(restored.fetcher).not.toHaveBeenCalled();
  expect(budgetState(g.store).used).toBe(20);
  expect(g.journal.unfinished()).toMatchObject([{ phase: "dispatching" }]);
  time += 3_600_000;
  await executor.dispatch(g.request);
  expect(g.onExternalRun).toHaveBeenCalledOnce();
  expect(g.push).not.toHaveBeenCalled();
  expect(g.client.dispatch).not.toHaveBeenCalled();
  expect(budgetState(g.store).used).toBe(restored.fetcher.mock.calls.length);
  expect(JSON.stringify(g.events())).not.toContain("ghs_synthetic");
});

test.each([403, 429])(
  "C-334 D4 integration: %s during split discovery persists Retry-After across consumers and restart",
  async (status) => {
    const root = mkdtempSync(join(tmpdir(), "cg-recovery-backoff-"));
    roots.push(root);
    const db = join(root, "state.sqlite");
    const f = setup(db);
    await loseDispatch(f);
    let time = now + 20_000;
    const rateFor = (store: Store) =>
      new GithubRateLimit(
        2000,
        () => time,
        new GithubBudgetJournal(store, config.name),
      );
    const api = cappedRecoveryClient("unique", rateFor(f.store));
    const fetcher = api.fetcher.getMockImplementation()!;
    let calls = 0;
    api.fetcher.mockImplementation(async (input) =>
      ++calls === 4
        ? new Response("ghs_synthetic private response", {
            status,
            headers: { "Retry-After": "60" },
          })
        : fetcher(input),
    );
    await expect(
      new GithubCheckExecutor({
        ...f.options,
        client: api.client,
        now: () => time,
      }).dispatch(f.request),
    ).rejects.toMatchObject({ category: "api" });
    expect(api.fetcher).toHaveBeenCalledTimes(4);
    expect(budgetState(f.store)).toMatchObject({
      used: 4,
      blockedUntil: time + 60_000,
    });
    expect(f.onExternalRun).not.toHaveBeenCalled();
    const second = setup(db, false);
    const peer = cappedRecoveryClient("unique", rateFor(second.store));
    await expect(peer.client.pollRuns()).rejects.toMatchObject({
      category: "api",
      retryAt: time + 60_000,
    });
    await expect(peer.client.cancel(123)).rejects.toMatchObject({
      category: "api",
      retryAt: time + 60_000,
    });
    expect(peer.fetcher).not.toHaveBeenCalled();
    closeFixtureStore(f.store);
    closeFixtureStore(second.store);
    const g = setup(db, false);
    const restored = cappedRecoveryClient("unique", rateFor(g.store));
    const executor = new GithubCheckExecutor({
      ...g.options,
      client: restored.client,
      now: () => time,
    });
    await expect(executor.dispatch(g.request)).rejects.toMatchObject({
      category: "api",
    });
    expect(restored.fetcher).not.toHaveBeenCalled();
    expect(g.journal.unfinished()).toMatchObject([{ phase: "dispatching" }]);
    time += 60_000;
    await executor.dispatch(g.request);
    expect(g.onExternalRun).toHaveBeenCalledOnce();
    expect(g.push).not.toHaveBeenCalled();
    expect(g.client.dispatch).not.toHaveBeenCalled();
    expect(budgetState(g.store).used).toBe(
      4 + restored.fetcher.mock.calls.length,
    );
  },
);

test("C-334 D4 integration: cancelled discovery consumes only sent calls and preserves intent for another consumer", async () => {
  const f = setup();
  await loseDispatch(f);
  const rate = new GithubRateLimit(
    2000,
    () => now + 20_000,
    new GithubBudgetJournal(f.store, config.name),
  );
  const api = cappedRecoveryClient("unique", rate);
  const fetcher = api.fetcher.getMockImplementation()!;
  const abort = new AbortController();
  let calls = 0;
  api.fetcher.mockImplementation(async (input) => {
    if (++calls === 4) abort.abort(new Error("ghs_synthetic cancellation"));
    return fetcher(input);
  });
  const options = { ...f.options, client: api.client, now: () => api.end };
  await expect(
    new GithubCheckExecutor(options).dispatch({
      ...f.request,
      signal: abort.signal,
    }),
  ).rejects.toMatchObject({ category: "recovery_incomplete" });
  expect(api.fetcher).toHaveBeenCalledTimes(4);
  expect(budgetState(f.store).used).toBe(4);
  expect(f.onExternalRun).not.toHaveBeenCalled();
  expect(f.journal.unfinished()).toMatchObject([{ phase: "dispatching" }]);
  await api.client.run(123);
  expect(budgetState(f.store).used).toBe(5);
  api.advance(20_000);
  await new GithubCheckExecutor(options).dispatch(f.request);
  expect(f.onExternalRun).toHaveBeenCalledOnce();
  expect(f.client.dispatch).toHaveBeenCalledOnce();
  expect(f.push).toHaveBeenCalledOnce();
  expect(budgetState(f.store).used).toBe(api.fetcher.mock.calls.length);
});

test("D4 rework: a bound recovery preserves RetryLater and retries the same run without dispatch/cancel", async () => {
  const f = setup();
  await f.executor.dispatch(f.request);
  const restored = new GithubCheckExecutor(f.options);
  const limited = new GithubRetryLater(now + 60_000);
  f.client.run.mockRejectedValueOnce(limited);
  await expect(restored.dispatch(f.request)).rejects.toBe(limited);
  expect(f.journal.unfinished()[0]?.externalRun?.run_id).toBe(123);
  expect(f.lifecycle.cancel).not.toHaveBeenCalled();
  await restored.dispatch(f.request);
  expect(f.client.dispatch).toHaveBeenCalledOnce();
  expect(f.push).toHaveBeenCalledOnce();
});

test("C-375: shared-budget deferral preserves unbound identity without reporting an outage", async () => {
  const f = setup();
  f.client.dispatch.mockRejectedValueOnce(new GithubRetryLater(now + 60_000));
  const work = f.executor.dispatch(f.request);
  await expect(work).rejects.toMatchObject({
    category: "api",
    message: "Check executor unavailable: api",
  });
  await expect(work).rejects.toBeInstanceOf(GithubRetryLater);
  expect(f.journal.unfinished()[0]?.externalRun).toBeUndefined();
  expect(f.journal.unfinished()[0]?.phase).toBe("dispatching");
  expect(f.lifecycle.cancel).not.toHaveBeenCalled();
});

test("D5: retention configuration changes preserve a bound dispatch identity", async () => {
  const f = setup();
  await f.executor.dispatch(f.request);
  const restored = new GithubCheckExecutor({
    ...f.options,
    config: { ...config, branchRetentionMs: 86400000 },
  });
  await restored.dispatch(f.request);
  expect(f.client.dispatch).toHaveBeenCalledOnce();
  expect(f.push).toHaveBeenCalledOnce();
  expect(f.client.run).toHaveBeenCalledTimes(2);
});

test.each([false, true])(
  "explicit scopedChecks false preserves the durable dispatch fingerprint (explicit first=%s)",
  async (explicitFirst) => {
    const f = setup();
    const first = new GithubCheckExecutor({
      ...f.options,
      config: explicitFirst ? { ...config, scopedChecks: false } : config,
    });
    await first.dispatch(f.request);
    const before = f.journal.unfinished()[0]?.key;
    const restored = new GithubCheckExecutor({
      ...f.options,
      config: explicitFirst ? config : { ...config, scopedChecks: false },
    });
    await restored.dispatch(f.request);
    expect(f.journal.unfinished()[0]?.key).toBe(before);
    expect(f.client.dispatch).toHaveBeenCalledOnce();
    expect(f.push).toHaveBeenCalledOnce();
    expect(f.client.dispatch).toHaveBeenCalledWith("main", inputs);
  },
);

test("C-375: abandonment while waiting for credentials fences candidate publication and POST", async () => {
  const f = setup();
  let tokenReady: ((token: string) => void) | undefined;
  f.client.token.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        tokenReady = resolve;
      }),
  );
  const work = f.executor.dispatch(f.request);
  const rejected = expect(work).rejects.toMatchObject({ category: "security" });
  await vi.waitFor(() => expect(tokenReady).toBeDefined());
  const intent = f.journal.unfinished()[0];
  if (!intent) throw new Error("Missing intent");
  // Simulate the atomic reconciliation result; journal integration covers its
  // domain eligibility separately, while this test controls the IO race.
  f.store.uow.run((tx) =>
    tx.events.append(human.project_id, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(human.project_id, card.id),
      card_id: card.id,
      actor: { kind: "system", project_id: human.project_id },
      type: "github_check_dispatch",
      payload: JSON.parse(
        JSON.stringify({ ...intent, abandoned: "superseded", finished: true }),
      ),
      created_at: trusted.created_at,
    }),
  );
  tokenReady?.(syntheticToken);
  await rejected;
  expect(f.push).not.toHaveBeenCalled();
  expect(f.client.dispatch).not.toHaveBeenCalled();
  expect(f.onExternalRun).not.toHaveBeenCalled();
});

test("C-375: a late trusted binding to an abandoned dispatch is cancelled without readiness or capacity release", async () => {
  const f = setup();
  f.client.run.mockImplementationOnce(async () => {
    const intent = f.journal.unfinished()[0];
    if (!intent) throw new Error("Missing intent");
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
        created_at: trusted.created_at,
      }),
    );
    return trusted;
  });
  const handle = await f.executor.dispatch(f.request);
  expect(f.lifecycle.cancel).toHaveBeenCalledOnce();
  expect(f.onExternalRun).not.toHaveBeenCalled();
  expect(f.request.onReady).not.toHaveBeenCalled();
  expect(f.journal.unfinished()).toMatchObject([
    { abandoned: "superseded", externalRun: { run_id: 123 } },
  ]);
  await f.executor.poll(handle);
  expect(f.journal.unfinished()).toEqual([]);
});

test.each([false, true])(
  "C-375: publication in flight (abandoned=%s) cannot be cleaned before its writer settles",
  async (abandoned) => {
    const f = setup();
    let published: (() => void) | undefined;
    f.push.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        published = resolve;
      });
      return { status: "pushed" };
    });
    const work = f.executor.dispatch(f.request);
    await vi.waitFor(() => expect(published).toBeDefined());
    expect(f.journal.unfinished()).toMatchObject([{ phase: "publishing" }]);
    const intent = f.journal.unfinished()[0];
    if (!intent) throw new Error("Missing intent");
    expect(f.journal.beginCleanup(intent, () => true)).toBe(false);
    // A concurrent/restarted dispatcher cannot race the unfinished publisher.
    await expect(
      new GithubCheckExecutor(f.options).dispatch(f.request),
    ).rejects.toMatchObject({ category: "recovery_incomplete" });
    if (abandoned)
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
          created_at: trusted.created_at,
        }),
      );
    const result = abandoned
      ? expect(work).rejects.toMatchObject({ category: "dispatch_unknown" })
      : work;
    published?.();
    await result;
    expect(f.push).toHaveBeenCalledOnce();
    expect(f.client.dispatch).toHaveBeenCalledTimes(abandoned ? 0 : 1);
    if (abandoned) {
      expect(f.journal.unfinished()).toEqual([]);
      expect(f.journal.all()[0]).toMatchObject({
        phase: "reserved",
        abandoned: "superseded",
        finished: true,
      });
    }
  },
);

test.each(["failed", "throw", "abort"] as const)(
  "C-375: settled push %s returns to reservation and the same attempt can retry",
  async (mode) => {
    const f = setup();
    const abort = new AbortController();
    f.push.mockImplementationOnce(async () => {
      if (mode === "abort") abort.abort();
      if (mode === "throw") throw new Error("synthetic transport failure");
      return { status: "failed", reason: "other" };
    });
    await expect(
      f.executor.dispatch({ ...f.request, signal: abort.signal }),
    ).rejects.toBeDefined();
    expect(f.client.dispatch).not.toHaveBeenCalled();
    expect(f.journal.unfinished()).toMatchObject([{ phase: "reserved" }]);
    await new GithubCheckExecutor(f.options).dispatch(f.request);
    expect(f.push).toHaveBeenCalledTimes(2);
    expect(f.client.dispatch).toHaveBeenCalledOnce();
  },
);

test.each(["failed", "throw", "abort"] as const)(
  "C-375: abandoned push %s releases both reservations only after its writer settles",
  async (mode) => {
    const f = setup();
    const abort = new AbortController();
    let settle!: () => void;
    f.push.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        settle = resolve;
      });
      if (mode === "abort") abort.abort();
      if (mode === "throw") throw new Error("synthetic abort");
      return { status: "failed", reason: "other" };
    });
    const work = f.executor.dispatch({ ...f.request, signal: abort.signal });
    const rejected = expect(work).rejects.toBeDefined();
    await vi.waitFor(() => expect(settle).toBeDefined());
    const intent = f.journal.unfinished()[0];
    if (!intent) throw new Error("Missing intent");
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
        created_at: trusted.created_at,
      }),
    );
    expect(f.journal.beginCleanup(intent, () => true)).toBe(false);
    await expect(
      new GithubCheckExecutor(f.options).dispatch({
        ...f.request,
        attempt: "attempt-2",
      }),
    ).rejects.toMatchObject({ category: "card_busy" });
    settle();
    await rejected;
    expect(f.journal.unfinished()).toEqual([]);
    expect(f.journal.all()[0]).toMatchObject({
      phase: "reserved",
      abandoned: "superseded",
      finished: true,
    });
    f.client.run.mockResolvedValue({
      ...trusted,
      display_title: githubCheckRunName({ ...inputs, attempt: "attempt-2" }),
    });
    await new GithubCheckExecutor(f.options).dispatch({
      ...f.request,
      attempt: "attempt-2",
    });
    expect(f.client.dispatch).toHaveBeenCalledOnce();
  },
);

test("C-375: a 204 discovery waits at the persisted cadence across restart and keeps its original deadline", async () => {
  const root = mkdtempSync(join(tmpdir(), "cg-discovery-wait-"));
  roots.push(root);
  const db = join(root, "state.db");
  const f = setup(db);
  let time = now;
  const options = {
    ...f.options,
    now: () => time,
    config: { ...config, waitStartMs: 40_000 },
  };
  f.client.dispatch.mockResolvedValue(undefined);
  f.client.runs.mockResolvedValue([]);
  await expect(
    new GithubCheckExecutor(options).dispatch(f.request),
  ).rejects.toMatchObject({ retryAt: now + 20_000 });
  const g = setup(db, false);
  const restored = () =>
    new GithubCheckExecutor({ ...options, journal: g.journal });
  time += 10_000;
  await expect(restored().dispatch(f.request)).rejects.toMatchObject({
    retryAt: now + 20_000,
  });
  expect(f.client.runs).toHaveBeenCalledOnce();
  time += 30_000;
  await expect(restored().dispatch(f.request)).rejects.toMatchObject({
    category: "dispatch_unknown",
  });
  expect(g.journal.unfinished()[0]?.startedAt).toBe(trusted.created_at);
  f.client.runs.mockResolvedValue([trusted]);
  time += 20_000;
  await restored().dispatch(f.request);
  expect(f.client.dispatch).toHaveBeenCalledOnce();
  expect(f.push).toHaveBeenCalledOnce();
  expect(f.onExternalRun).toHaveBeenCalledOnce();
});

test.each([
  "valid",
  "ambiguous",
  "drift",
  "digest",
  "missing",
  "limit",
] as const)(
  "C-375: abandoned unbound recovery (%s) never POSTs and only cancels the exact trusted run",
  async (mode) => {
    const f = setup();
    f.client.dispatch.mockRejectedValueOnce(new Error("lost response"));
    await expect(f.executor.dispatch(f.request)).rejects.toBeDefined();
    const previous = f.journal.unfinished()[0];
    if (!previous) throw new Error("Missing intent");
    const intent = {
      ...previous,
      abandoned: "superseded" as const,
    };
    f.store.uow.run((tx) =>
      tx.events.append(human.project_id, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(human.project_id, card.id),
        card_id: card.id,
        actor: { kind: "system", project_id: human.project_id },
        type: "github_check_dispatch",
        payload: JSON.parse(JSON.stringify(intent)),
        created_at: trusted.created_at,
      }),
    );
    if (mode === "ambiguous")
      f.client.runs.mockResolvedValue([trusted, { ...trusted, id: 124 }]);
    if (mode === "missing") f.client.runs.mockResolvedValue([]);
    if (mode === "limit")
      f.client.runs.mockRejectedValue(new GithubRetryLater(now + 60_000));
    if (mode === "drift")
      f.client.run.mockResolvedValue({
        ...trusted,
        actor: { login: "untrusted" },
      });
    const executor = new GithubCheckExecutor({
      ...f.options,
      ...(mode === "digest"
        ? { config: { ...config, installationId: 99 } }
        : {}),
    });
    const result = executor.recoverAbandoned(f.request, intent);
    if (mode === "valid") {
      const handle = await result;
      if (!handle) throw new Error("Missing recovered run");
      expect(f.lifecycle.cancel).toHaveBeenCalledWith(
        expect.objectContaining({ run_id: 123 }),
      );
      expect(f.journal.unfinished()).toHaveLength(1);
      await executor.poll(handle);
      expect(f.journal.unfinished()).toEqual([]);
    } else {
      await expect(result).rejects.toBeDefined();
      expect(f.lifecycle.cancel).not.toHaveBeenCalled();
      expect(f.journal.unfinished()).toHaveLength(1);
    }
    expect(f.onExternalRun).not.toHaveBeenCalled();
    expect(f.request.onReady).not.toHaveBeenCalled();
    expect(f.push).toHaveBeenCalledOnce();
    expect(f.client.dispatch).toHaveBeenCalledOnce();
    await expect(
      new GithubCheckExecutor(f.options).dispatch(f.request),
    ).rejects.toMatchObject({ category: "security" });
  },
);

test.each([
  "absent",
  "legacy",
  "capacity_changed",
  "workflow_changed",
  "credentials_changed",
  "before_deadline",
  "active",
  "known_id",
  "default_title",
  "incomplete",
  "rate_limit",
  "api_failure",
  "aborted",
  "concurrent_binding",
  "concurrent_id",
  "scan_began_too_early",
] as const)(
  "abandoned dispatch absence (%s) releases only after complete expired discovery",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "cg-absent-dispatch-"));
    roots.push(root);
    const db = join(root, "state.db");
    const f = setup(db);
    await loseDispatch(f);
    const previous = f.journal.unfinished()[0]!;
    const {
      discoveryDeadlineAt: _deadline,
      absenceNotBefore: _visibility,
      ...legacy
    } = previous;
    const intent = {
      ...(mode === "legacy" ? legacy : previous),
      ...(mode === "active" ? {} : { abandoned: "superseded" as const }),
      ...(mode === "known_id" ? { dispatchedRunId: 123 } : {}),
    };
    f.store.uow.run((tx) =>
      tx.events.append(human.project_id, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(human.project_id, card.id),
        card_id: card.id,
        actor: { kind: "system", project_id: human.project_id },
        type: "github_check_dispatch",
        payload: JSON.parse(JSON.stringify(intent)),
        created_at: trusted.created_at,
      }),
    );
    let time =
      now +
      (["before_deadline", "scan_began_too_early"].includes(mode)
        ? 20_000
        : 3_600_000);
    const abort = new AbortController();
    f.client.runs.mockImplementation(async () => {
      if (mode === "scan_began_too_early") time += 3_600_000;
      if (mode === "concurrent_id")
        f.journal.beginDiscovery(intent, time + 20_000, 20_000, 123);
      if (mode === "incomplete")
        throw new GithubExecutorError("recovery_incomplete");
      if (mode === "rate_limit") throw new GithubRetryLater(time + 60_000);
      if (mode === "api_failure") throw new GithubExecutorError("api");
      if (mode === "aborted") abort.abort();
      if (mode === "concurrent_binding")
        f.journal.bind(intent, {
          provider: "github",
          run_id: trusted.id,
          run_attempt: 1,
          html_url: trusted.html_url,
          workflow_sha: trusted.head_sha,
        });
      return mode === "default_title" ? [unevaluated] : [];
    });
    f.client.run.mockRejectedValue(new GithubNotFoundError());
    const executor = new GithubCheckExecutor({
      ...f.options,
      now: () => time,
      config: {
        ...config,
        ...(mode === "capacity_changed" ? { maxConcurrent: 16 } : {}),
        ...(mode === "workflow_changed"
          ? { workflow: ".github/workflows/other.yml" }
          : {}),
        ...(mode === "credentials_changed" ? { installationId: 99 } : {}),
      },
    });
    const request = { ...f.request, signal: abort.signal };
    const recovery =
      mode === "active"
        ? executor.dispatch(request)
        : executor.recoverAbandoned(request, intent);
    const released = ["absent", "legacy", "capacity_changed"].includes(mode);
    if (released) await expect(recovery).resolves.toBeUndefined();
    else await expect(recovery).rejects.toBeDefined();
    expect(f.journal.unfinished()).toHaveLength(released ? 0 : 1);
    expect(f.onExternalRun).not.toHaveBeenCalled();
    expect(f.request.onReady).not.toHaveBeenCalled();
    expect(f.lifecycle.cancel).not.toHaveBeenCalled();
    expect(f.push).toHaveBeenCalledOnce();
    expect(f.client.dispatch).toHaveBeenCalledOnce();
    if (released) {
      const finished = f.journal.all()[0]!;
      expect(finished.undispatched).toEqual({
        reason: "complete_scan_no_match",
        source: "automatic",
        scanStartedAt: new Date(time).toISOString(),
        listed: 0,
      });
      closeFixtureStore(f.store);
      const restored = setup(db, false);
      expect(restored.journal.unfinished()).toEqual([]);
      expect(restored.journal.admitted()).toEqual([]);
      await expect(
        new GithubCheckExecutor(restored.options).dispatch(restored.request),
      ).rejects.toMatchObject({ category: "security" });
      expect(restored.client.dispatch).not.toHaveBeenCalled();
      // The abandoned attempt stays fenced, but the next same-card claim can use the only slot.
      restored.journal.claim(
        {
          project: intent.project,
          card: intent.card,
          startedAt: intent.startedAt,
          executor: config.name,
          phase: "reserved",
          attempt: "next",
          key: "new",
        },
        1,
      );
      expect(restored.journal.admitted().map((i) => i.attempt)).toEqual([
        "next",
      ]);
    }
  },
);

test("C-375: discovery expiry keeps the first host timeout even when restart supplies a larger budget", async () => {
  const f = setup();
  let time = now;
  const options = { ...f.options, now: () => time };
  f.client.dispatch.mockResolvedValue(undefined);
  f.client.runs.mockResolvedValue([]);
  await expect(
    new GithubCheckExecutor(options).dispatch({
      ...f.request,
      totalTimeoutMs: 1000,
    }),
  ).rejects.toBeInstanceOf(GithubRetryLater);
  time += 20_000;
  await expect(
    new GithubCheckExecutor(options).dispatch({
      ...f.request,
      totalTimeoutMs: 60_000,
    }),
  ).rejects.toMatchObject({ category: "dispatch_unknown" });
  expect(f.journal.unfinished()).toHaveLength(1);
  expect(f.client.dispatch).toHaveBeenCalledOnce();
});

test.each(["Cardigan check", "unresolved title"])(
  "C-404: response ID binds without run-name (%s), including after SQLite restart",
  async (display_title) => {
    const root = mkdtempSync(join(tmpdir(), "cg-bound-id-"));
    roots.push(root);
    const db = join(root, "state.db");
    const f = setup(db);
    const register = vi.fn();
    const options = { ...f.options, lifecycle: { ...f.lifecycle, register } };
    f.client.run.mockResolvedValue({
      ...trusted,
      display_title,
      status: "queued",
    });
    await new GithubCheckExecutor(options).dispatch(f.request);
    expect(f.request.onReady).toHaveBeenCalledOnce();
    expect(f.journal.unfinished()[0]).toMatchObject({
      boundByDispatchId: true,
      dispatchedRunId: 123,
      identity: { display_title: githubCheckRunName(inputs) },
      externalRun: { run_id: 123 },
    });
    closeFixtureStore(f.store);
    const g = setup(db, false);
    await new GithubCheckExecutor({
      ...options,
      journal: g.journal,
      config: { ...config, queueWaitMs: 4 * 60 * 60_000 },
      now: () => now + 70 * 60_000,
    }).dispatch(f.request);
    expect(register).toHaveBeenLastCalledWith(
      expect.objectContaining({ run_id: 123 }),
      expect.anything(),
      expect.anything(),
      expect.any(Function),
      true,
    );
    expect(f.client.runs).not.toHaveBeenCalled();
    expect(f.client.dispatch).toHaveBeenCalledOnce();
    expect(f.push).toHaveBeenCalledOnce();
  },
);

test.each([
  { id: 124 },
  { path: ".github/workflows/evil.yml" },
  { event: "push" },
  { head_branch: "ci/C-1/D-1/a" },
  { head_sha: "invalid" },
  { actor: { login: "human" } },
  { triggering_actor: { login: "human" } },
  { run_attempt: 2 },
  { html_url: `${trusted.html_url}?token=synthetic` },
  { created_at: "2020-01-01T00:00:00Z" },
  { created_at: "2099-01-01T00:00:00Z" },
  { created_at: "invalid" },
])(
  "C-375 follow-up: default titles never defer an unsafe identity %j",
  async (override) => {
    const f = setup();
    f.client.run.mockResolvedValue({ ...unevaluated, ...override });
    await expect(f.executor.dispatch(f.request)).rejects.toMatchObject({
      category: "security",
    });
    expect(f.client.run).toHaveBeenCalledOnce();
    expect(f.onExternalRun).not.toHaveBeenCalled();
    expect(f.request.onReady).not.toHaveBeenCalled();
    expect(f.lifecycle.poll).not.toHaveBeenCalled();
    expect(f.journal.unfinished()[0]?.externalRun).toBeUndefined();
  },
);

test("C-375 follow-up: a default title still requires baseline ancestry", async () => {
  const f = setup();
  f.client.run.mockResolvedValue(unevaluated);
  f.isBaselineAncestor.mockResolvedValue(false);
  await expect(f.executor.dispatch(f.request)).rejects.toMatchObject({
    category: "security",
  });
  expect(f.isBaselineAncestor).toHaveBeenCalledWith(trusted.head_sha, "main");
  expect(f.onExternalRun).not.toHaveBeenCalled();
});

test("C-404: invisible response ID preserves discovery cadence and deadline across restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "cg-run-name-"));
  roots.push(root);
  const db = join(root, "state.db");
  const f = setup(db);
  let time = now;
  const options = { ...f.options, now: () => time };
  f.client.run.mockRejectedValue(new GithubNotFoundError());
  await expect(
    new GithubCheckExecutor(options).dispatch({
      ...f.request,
      totalTimeoutMs: 1000,
    }),
  ).rejects.toBeInstanceOf(GithubRetryLater);
  closeFixtureStore(f.store);
  const g = setup(db, false);
  const restored = () =>
    new GithubCheckExecutor({ ...options, journal: g.journal });
  const abort = new AbortController();
  abort.abort();
  await expect(
    restored().dispatch({ ...f.request, signal: abort.signal }),
  ).rejects.toMatchObject({ category: "security" });
  await expect(restored().dispatch(f.request)).rejects.toMatchObject({
    retryAt: now + 20_000,
  });
  expect(f.client.run).toHaveBeenCalledOnce();
  time += 20_000;
  await expect(restored().dispatch(f.request)).rejects.toMatchObject({
    category: "dispatch_unknown",
  });
  expect(g.journal.unfinished()).toMatchObject([
    {
      dispatchedRunId: 123,
      startedAt: trusted.created_at,
      discoveryDeadlineAt: now + 1000,
      nextDiscoveryAt: now + 40_000,
    },
  ]);
  expect(g.journal.unfinished()[0]?.externalRun).toBeUndefined();
  expect(f.onExternalRun).not.toHaveBeenCalled();
  expect(f.request.onReady).not.toHaveBeenCalled();
  expect(f.lifecycle.poll).not.toHaveBeenCalled();
  await expect(
    restored().dispatch({ ...f.request, attempt: "attempt-2" }),
  ).rejects.toMatchObject({ category: "card_busy" });
  f.client.run.mockResolvedValue(trusted);
  time += 20_000;
  await restored().dispatch(f.request);
  expect(f.client.run.mock.calls).toEqual([[123], [123], [123]]);
  expect(f.client.runs).not.toHaveBeenCalled();
  expect(f.client.dispatch).toHaveBeenCalledOnce();
  expect(f.push).toHaveBeenCalledOnce();
});

test("C-375 follow-up: same-ID visibility rereads consume the original shared REST budget", async () => {
  const f = setup();
  let time = now;
  const rateFor = () =>
    new GithubRateLimit(
      2,
      () => time,
      new GithubBudgetJournal(f.store, config.name),
    );
  const fetcher = vi.fn(
    async (_input: string | URL | Request, init?: RequestInit) =>
      new Response(
        JSON.stringify(init?.method === "POST" ? { workflow_run_id: 123 } : {}),
        { status: init?.method === "POST" ? 200 : 404 },
      ),
  );
  const options = (rate: GithubRateLimit) => {
    const client = new GithubClient({
      config,
      dataDir: "/synthetic",
      fetch: fetcher as typeof fetch,
      rate,
      now: () => time,
    });
    vi.spyOn(client, "token").mockResolvedValue(syntheticToken);
    return { ...f.options, client, now: () => time };
  };
  await expect(
    new GithubCheckExecutor(options(rateFor())).dispatch(f.request),
  ).rejects.toMatchObject({ retryAt: now + 20_000 });
  expect(budgetState(f.store).used).toBe(2);
  time += 20_000;
  await expect(
    new GithubCheckExecutor(options(rateFor())).dispatch(f.request),
  ).rejects.toMatchObject({ retryAt: now + 3_600_000 });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(budgetState(f.store).used).toBe(2);
  expect(f.onExternalRun).not.toHaveBeenCalled();
  expect(f.journal.unfinished()[0]?.dispatchedRunId).toBe(123);
});

test.each(["docs_only", "affected", "full"])(
  "optional scoped dispatch inputs support %s",
  async (scope) => {
    const f = setup();
    const executor = new GithubCheckExecutor({
      ...f.options,
      config: { ...config, scopedChecks: true },
    });
    const checks = [
      {
        name: "test",
        run: "true",
        ...(scope === "docs_only"
          ? { skipReason: "docs_only" as const }
          : scope === "affected"
            ? { affectedPaths: ["apps/web"] }
            : {}),
      },
      {
        name: "e2e",
        run: "true",
        ...(scope === "docs_only" ? { skipReason: "docs_only" as const } : {}),
      },
    ];
    await executor.dispatch({ ...f.request, checks });
    expect(f.client.dispatch).toHaveBeenCalledWith("main", {
      ...inputs,
      scope,
      affected_paths: scope === "affected" ? "apps/web" : "",
      skip_checks: scope === "docs_only" ? "test,e2e" : "",
    });
  },
);

test("legacy workflow dispatch omits optional inputs even with narrowed request metadata", async () => {
  const f = setup();
  const register = vi.fn();
  const executor = new GithubCheckExecutor({
    ...f.options,
    lifecycle: { ...f.lifecycle, register },
  });
  await executor.dispatch({
    ...f.request,
    checks: [{ name: "test", run: "true", skipReason: "docs_only" }],
  });
  expect(f.client.dispatch).toHaveBeenCalledWith("main", inputs);
  expect(register.mock.calls[0]?.[1].checks).toEqual([
    { name: "test", run: "true" },
  ]);
});

test("unexpected adapter failures retain their error class and redacted diagnostic in output and result", async () => {
  const f = setup();
  f.push.mockRejectedValueOnce(
    new TypeError(
      "Cannot read properties of undefined (reading 'central') /private/path token=fixture-secret ghs_fixture",
    ),
  );
  const output = vi.fn(),
    report = vi.fn();
  const result = await runCheckExecutor(
    f.executor,
    { ...f.request, env: { SECRET: "fixture-secret" }, onOutput: output },
    report,
  );
  expect(result.reason).toContain(
    "TypeError: Cannot read properties of undefined (reading 'central')",
  );
  const publicData = JSON.stringify({
    result,
    output: output.mock.calls,
    report: report.mock.calls.map(([e]) => e.message),
  });
  expect(publicData).not.toMatch(/fixture-secret|ghs_fixture|\/private\/path/);
  expect(output).toHaveBeenCalled();
  expect(report).toHaveBeenCalled();
  expect(f.client.dispatch).not.toHaveBeenCalled();
  // An unexpected transport error is not proof that the push never started.
  expect(f.journal.admitted()).toMatchObject([{ attempt: f.request.attempt }]);
});

test.each(["before_push", "after_push"])(
  "one-hour hold %s refreshes discovery on restart but never repeats an ambiguous POST",
  async (stage) => {
    const f = setup();
    let time = now;
    const hold = () =>
      f.store.uow.run((tx) =>
        tx.cards.put(human.project_id, {
          ...card,
          hold: {
            reason: "wait",
            resume_condition: "ready",
            set_by: "human",
            set_at: new Date(time).toISOString(),
          },
        }),
      );
    if (stage === "before_push")
      f.client.token.mockImplementationOnce(async () => {
        hold();
        return syntheticToken;
      });
    else
      f.push.mockImplementationOnce(async () => {
        hold();
        return { status: "pushed" };
      });
    const options = { ...f.options, now: () => time };
    await expect(
      new GithubCheckExecutor(options).dispatch(f.request),
    ).rejects.toBeInstanceOf(CheckExecutorSuspended);
    expect(f.client.dispatch).not.toHaveBeenCalled();
    time += 60 * 60_000;
    f.store.uow.run((tx) => tx.cards.put(human.project_id, card));
    f.client.run.mockRejectedValueOnce(new GithubNotFoundError());
    await expect(
      new GithubCheckExecutor(options).dispatch(f.request),
    ).rejects.toMatchObject({ retryAt: time + 20_000 });
    expect(f.client.dispatch).toHaveBeenCalledTimes(1);
    const intent = f.journal.unfinished()[0];
    expect(intent?.discoveryDeadlineAt).toBeGreaterThan(time);
    expect(intent?.startedAt).toBe(new Date(time).toISOString());
    time += 20_000;
    f.client.run.mockResolvedValue({
      ...trusted,
      created_at: new Date(time - 20_000).toISOString(),
    });
    const recovered = new GithubCheckExecutor(options);
    const handle = await recovered.dispatch(f.request);
    expect((await recovered.poll(handle)).status).toBe("passed");
    expect(f.client.dispatch).toHaveBeenCalledTimes(1);
  },
);

test("a late POST response cannot race a negative abandoned scan or lose its returned run ID", async () => {
  const f = setup(),
    post = Promise.withResolvers<number>();
  let time = now;
  const options = { ...f.options, now: () => time };
  f.client.dispatch.mockReturnValueOnce(post.promise);
  const dispatch = new GithubCheckExecutor(options).dispatch(f.request);
  await vi.waitFor(() => expect(f.client.dispatch).toHaveBeenCalledOnce());
  const intent = {
    ...f.journal.unfinished()[0]!,
    abandoned: "attempt_finished" as const,
  };
  f.store.uow.run((tx) =>
    tx.events.append(human.project_id, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(human.project_id, card.id),
      card_id: card.id,
      actor: { kind: "system", project_id: human.project_id },
      type: "github_check_dispatch",
      payload: JSON.parse(JSON.stringify(intent)),
      created_at: trusted.created_at,
    }),
  );
  time += 3_600_000;
  f.client.runs.mockResolvedValue([]);
  await expect(
    new GithubCheckExecutor(options).recoverAbandoned(f.request, intent),
  ).rejects.toBeInstanceOf(GithubRetryLater);
  expect(f.client.runs).not.toHaveBeenCalled();
  expect(f.journal.admitted()).toHaveLength(1);
  f.client.run.mockRejectedValueOnce(new GithubNotFoundError());
  post.resolve(123);
  await expect(dispatch).rejects.toBeDefined();
  expect(f.journal.admitted()).toMatchObject([{ dispatchedRunId: 123 }]);
});
