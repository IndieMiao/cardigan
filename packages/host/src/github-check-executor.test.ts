import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { fixture, human } from "../../domain/src/commands/test-fixtures.js";
import { type CheckRequest, runCheckExecutor } from "./check-executor.js";
import {
  GithubCheckExecutor,
  githubCheckRunName,
} from "./github-check-executor.js";
import { GithubClient, type GithubRun } from "./github-client.js";
import { GithubDispatchJournal } from "./github-dispatch-journal.js";
import type { GithubMergeGateExecutor } from "./merge-gate-executors.js";

const stores: Store[] = [],
  roots: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const now = Date.parse("2026-11-15T00:00:00Z");
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
function setup(dbPath = ":memory:", seed = true) {
  const store = Store.open({ dbPath });
  stores.push(store);
  if (seed) {
    store.createProject({ id: human.project_id });
    store.uow.run((tx) => tx.cards.put(human.project_id, card));
  }
  const client = {
    token: vi.fn(async () => "ghs_synthetic"),
    dispatch: vi.fn(async (): Promise<number | undefined> => 123),
    run: vi.fn(async () => trusted),
    runs: vi.fn(async () => [trusted]),
  };
  const push = vi.fn(async () => ({ status: "pushed" as const }));
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
test("D3: dispatch pushes only the candidate, binds the trusted baseline run before readiness, and delegates D4 lifecycle", async () => {
  const f = setup();
  const handle = await f.executor.dispatch(f.request);
  expect(f.push).toHaveBeenCalledWith({
    repo: config.repo,
    sha: inputs.sha,
    ref: `refs/heads/ci/${card.id}/D-1/attempt-1`,
    token: "ghs_synthetic",
  });
  expect(f.client.dispatch).toHaveBeenCalledWith("main", inputs);
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
  { display_title: "other-attempt" },
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
  expect(f.client.runs).toHaveBeenCalledWith("main", trusted.created_at);
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
    category: "dispatch_unknown",
  });
  await expect(f.executor.dispatch(f.request)).rejects.toMatchObject({
    category: "dispatch_unknown",
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
  await Promise.all([
    f.executor.dispatch(f.request),
    other.dispatch(g.request),
  ]);
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
