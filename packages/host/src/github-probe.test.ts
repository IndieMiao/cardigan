import { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { fixture, human, id } from "../../domain/src/commands/test-fixtures.js";
import { githubCheckRunName } from "./github-check-executor.js";
import { GITHUB_WORKFLOW_STEPS } from "./github-check-poller.js";
import type { GithubClient, GithubRun } from "./github-client.js";
import { GithubDispatchJournal } from "./github-dispatch-journal.js";
import { GithubProbe } from "./github-probe.js";
import type { GithubRateLimit } from "./github-rate-limit.js";
import type { GithubMergeGateExecutor } from "./merge-gate-executors.js";
import type { ProbeJob } from "./probe-service.js";

const stores: Store[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const s of stores.splice(0)) s.close();
});
const config: GithubMergeGateExecutor = {
  name: "github",
  type: "github",
  repo: "fixture/project",
  workflow: ".github/workflows/check.yml",
  appId: 1,
  installationId: 2,
  privateKeyFile: "/synthetic/app.pem",
  botLogin: "fixture[bot]",
  maxConcurrent: 1,
  pollIntervalMs: 1,
};
function setup() {
  const store = Store.open({ dbPath: ":memory:" });
  stores.push(store);
  store.createProject({ id: human.project_id });
  const card = fixture().cards[0];
  if (!card) throw new Error("Missing fixture card");
  store.uow.run((tx) => tx.cards.put(human.project_id, card));
  let job: ProbeJob = {
    project_id: human.project_id,
    card_id: id("card", 1),
    work_item_id: id("work_item", 1),
    assignment_id: id("assignment", 1),
    id: "1".repeat(32),
    probe: "github",
    head_sha: "a".repeat(40),
    status: "running",
    cleanup: "pending",
    created_at: new Date().toISOString(),
    profile: {
      operations: ["smoke", "cancel", "cleanup", "status"],
      timeout_ms: 900000,
      executor: "github",
      rest_budget_per_hour: 120,
    },
  };
  let run: GithubRun = {
    id: 123,
    run_attempt: 1,
    path: config.workflow,
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: "b".repeat(40),
    actor: { login: config.botLogin },
    triggering_actor: { login: config.botLogin },
    display_title: "",
    html_url: "https://github.com/fixture/project/actions/runs/123",
    created_at: job.created_at,
    status: "completed",
    conclusion: "success",
  };
  const client = {
    token: vi.fn(async () => "synthetic-secret"),
    dispatch: vi.fn(async (_ref, inputs): Promise<number | undefined> => {
      run = {
        ...run,
        created_at: new Date().toISOString(),
        display_title: githubCheckRunName(inputs),
      };
      return run.id;
    }),
    run: vi.fn(async () => run),
    runs: vi.fn(async () => [run]),
    pollRuns: vi.fn(async () => ({ unchanged: false, runs: [run] })),
    jobs: vi.fn(async () => [
      {
        id: 456,
        run_id: run.id,
        run_attempt: 1,
        head_sha: run.head_sha,
        name: "check",
        status: "completed",
        conclusion: "success",
        steps: [
          "Set up job",
          ...GITHUB_WORKFLOW_STEPS,
          "Post Setup Node",
          "Post Checkout candidate",
          "Complete job",
        ].map((name, index) => ({
          name,
          number: index + 1,
          status: "completed",
          conclusion: "success",
        })),
      },
    ]),
    cancel: vi.fn(async () => {}),
    jobLog: vi.fn(async () => "must never export raw provider output"),
  };
  let budget: GithubRateLimit | undefined;
  const options = {
    store,
    dataDir: "/synthetic/private",
    config: () => config,
    prepare: vi.fn(async () => ({
      sha: "c".repeat(40),
      tree: "d".repeat(40),
      baseline: "main",
    })),
    push: vi.fn(async () => ({ status: "pushed" as const })),
    remove: vi.fn(async () => true),
    isBaselineAncestor: vi.fn(async () => true),
    client: (_config: GithubMergeGateExecutor, rate: GithubRateLimit) => {
      budget = rate;
      return client as unknown as GithubClient;
    },
  };
  let adapter = new GithubProbe(options);
  return {
    store,
    client,
    options,
    get job() {
      return job;
    },
    setJob: (j: ProbeJob) => {
      job = j;
    },
    budget: () => {
      if (!budget) throw new Error("Budget not initialized");
      return budget;
    },
    restart: () => {
      adapter = new GithubProbe(options);
    },
    changeRun: (patch: Partial<GithubRun>) => {
      run = { ...run, ...patch };
    },
    step: async () => {
      job = await adapter.advance(job, (j) => {
        job = j;
      });
      return job;
    },
  };
}

test("only a probe ref and precheck are published; verified terminal result is cleaned with an exact lease", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const f = setup();
  // Preparation may span a clock second before the provider receives dispatch.
  vi.setSystemTime(Date.now() + 2000);
  await f.step();
  if (f.job.cleanup !== "complete") await f.step();
  expect(f.job).toMatchObject({
    status: "passed",
    cleanup: "complete",
    tested_sha: "c".repeat(40),
  });
  expect(f.options.push).toHaveBeenCalledWith(
    human.project_id,
    expect.objectContaining({
      ref: `refs/heads/ci/probe/${human.project_id}-C-1-A-1/${f.job.id}`,
      sha: "c".repeat(40),
    }),
  );
  expect(f.client.dispatch).toHaveBeenCalledWith(
    "main",
    expect.objectContaining({
      card: "probe",
      kind: "precheck",
      sha: "c".repeat(40),
    }),
  );
  expect(f.options.remove).toHaveBeenCalledWith(
    human.project_id,
    expect.objectContaining({
      sha: "c".repeat(40),
      ref: expect.stringContaining("ci/probe/"),
    }),
  );
  expect(JSON.stringify(f.job)).not.toContain("synthetic-secret");
  expect(new GithubDispatchJournal(f.store).all()).toEqual([]);
  expect(
    new GithubDispatchJournal(f.store, f.job.card_id).all()[0],
  ).toMatchObject({ finished: true, deleted: true });
  f.restart();
  await f.step();
  expect(f.client.dispatch).toHaveBeenCalledOnce();
  expect(f.options.remove).toHaveBeenCalledOnce();
});

test("a crash after ambiguous dispatch recovers by identity without publishing or POSTing again", async () => {
  const f = setup();
  f.client.run.mockRejectedValueOnce(new Error("lost response"));
  await f.step();
  expect(f.job.cleanup).toBe("held");
  f.restart();
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 30000);
  await f.step();
  if (f.job.cleanup !== "complete") await f.step();
  expect(f.client.dispatch).toHaveBeenCalledOnce();
  expect(f.options.push).toHaveBeenCalledOnce();
  expect(f.job.cleanup).toBe("complete");
});

test("foreign identity never binds, cancels or deletes; reruns cannot inherit cancellation authority", async () => {
  const f = setup();
  f.changeRun({ actor: { login: "other" } });
  await f.step();
  expect(f.job.cleanup).toBe("held");
  expect(f.options.remove).not.toHaveBeenCalled();
  expect(f.client.cancel).not.toHaveBeenCalled();
  const g = setup();
  g.changeRun({ status: "in_progress", conclusion: null });
  await g.step();
  g.changeRun({ run_attempt: 2, triggering_actor: { login: "other" } });
  g.setJob({ ...g.job, cancel_requested: true });
  await expect(g.step()).rejects.toThrow();
  expect(g.client.cancel).not.toHaveBeenCalled();
  expect(g.options.remove).not.toHaveBeenCalled();
});

test("cancellation waits for observed terminal state before deleting and survives restart", async () => {
  const f = setup();
  f.changeRun({ status: "in_progress", conclusion: null });
  await f.step();
  f.setJob({ ...f.job, cancel_requested: true });
  f.restart();
  await f.step();
  expect(f.client.cancel).toHaveBeenCalledWith(123);
  expect(f.options.remove).not.toHaveBeenCalled();
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 30000);
  f.changeRun({ status: "completed", conclusion: "cancelled" });
  await f.step();
  if (f.job.cleanup !== "complete") await f.step();
  expect(f.job).toMatchObject({ status: "cancelled", cleanup: "complete" });
});

test.each([
  { restart: false, timeout: false },
  { restart: true, timeout: false },
  { restart: false, timeout: true },
  { restart: true, timeout: true },
])(
  "queued response-ID probes attempt cancellation before title resolution (restart=$restart, timeout=$timeout)",
  async ({ restart, timeout }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = setup();
    f.options.config = () => ({ ...config, queueWaitMs: 60_000 });
    f.changeRun({ status: "queued", conclusion: null });
    f.client.dispatch.mockImplementationOnce(async () => {
      f.changeRun({
        display_title: "Cardigan check",
        created_at: new Date().toISOString(),
      });
      return 123;
    });
    vi.setSystemTime(Date.now() + 2000);
    await f.step();
    const journal = new GithubDispatchJournal(f.store, f.job.card_id);
    expect(journal.all()[0]).toMatchObject({
      boundByDispatchId: true,
      dispatchedRunId: 123,
      externalRun: { run_id: 123 },
    });
    if (restart) f.restart();
    if (timeout) vi.setSystemTime(Date.now() + 60_000);
    else f.setJob({ ...f.job, cancel_requested: true });
    await f.step();
    expect(f.client.cancel).toHaveBeenCalledExactlyOnceWith(123);
    expect(journal.all()[0]?.finished).not.toBe(true);
    expect(f.options.remove).not.toHaveBeenCalled();
    f.changeRun({ status: "completed", conclusion: "cancelled" });
    vi.setSystemTime(Date.now() + 30_000);
    await f.step();
    if (f.job.cleanup !== "complete") await f.step();
    expect(f.job).toMatchObject({
      status: timeout ? "failed" : "cancelled",
      cleanup: "complete",
    });
    expect(f.client.dispatch).toHaveBeenCalledOnce();
    expect(f.options.push).toHaveBeenCalledOnce();
  },
);

test.each([false, true])(
  "a default-title probe already cancelled remotely is released without sending cancellation (restart=%s)",
  async (restart) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = setup();
    f.changeRun({ status: "queued", conclusion: null });
    f.client.dispatch.mockImplementationOnce(async () => {
      f.changeRun({
        display_title: "Cardigan check",
        created_at: new Date().toISOString(),
      });
      return 123;
    });
    await f.step();
    f.changeRun({ status: "completed", conclusion: "cancelled" });
    f.setJob({ ...f.job, cancel_requested: true });
    if (restart) f.restart();
    vi.setSystemTime(Date.now() + 30_000);
    await f.step();
    if (f.job.cleanup !== "complete") await f.step();
    expect(f.job).toMatchObject({ status: "cancelled", cleanup: "complete" });
    expect(f.client.cancel).not.toHaveBeenCalled();
    expect(f.options.remove).toHaveBeenCalledOnce();
    expect(f.client.dispatch).toHaveBeenCalledOnce();
    expect(
      new GithubDispatchJournal(f.store, f.job.card_id).all()[0],
    ).toMatchObject({ finished: true, deleted: true });
  },
);

test.each([
  { id: 124 },
  { run_attempt: 2 },
  { path: ".github/workflows/other.yml" },
  { event: "push" },
  { head_branch: "other" },
  { head_sha: "e".repeat(40) },
  { actor: { login: "other" } },
  { triggering_actor: { login: "other" } },
  { html_url: "https://github.com/foreign/project/actions/runs/123" },
  { created_at: "2000-01-01T00:00:00Z" },
])(
  "queued response-ID cancellation still rejects identity drift %j",
  async (patch) => {
    const f = setup();
    f.changeRun({ status: "queued", conclusion: null });
    f.client.dispatch.mockImplementationOnce(async () => {
      f.changeRun({
        display_title: "Cardigan check",
        created_at: new Date().toISOString(),
      });
      return 123;
    });
    await f.step();
    f.changeRun(patch);
    f.setJob({ ...f.job, cancel_requested: true });
    await expect(f.step()).rejects.toThrow();
    expect(f.client.cancel).not.toHaveBeenCalled();
    expect(f.options.remove).not.toHaveBeenCalled();
    expect(
      new GithubDispatchJournal(f.store, f.job.card_id).all()[0]?.finished,
    ).not.toBe(true);
  },
);

test("name-discovered probes still require the bound title before cancellation", async () => {
  const f = setup();
  f.changeRun({ status: "queued", conclusion: null });
  const dispatch = f.client.dispatch.getMockImplementation();
  f.client.dispatch.mockImplementationOnce(async (ref, inputs) => {
    await dispatch?.(ref, inputs);
    return undefined;
  });
  await f.step();
  expect(
    new GithubDispatchJournal(f.store, f.job.card_id).all()[0]
      ?.boundByDispatchId,
  ).toBeUndefined();
  f.changeRun({ display_title: "Cardigan check" });
  f.setJob({ ...f.job, cancel_requested: true });
  await expect(f.step()).rejects.toThrow();
  expect(f.client.cancel).not.toHaveBeenCalled();
  expect(f.options.remove).not.toHaveBeenCalled();
});

test("cleanup failures retain the intent and retry without another remote run", async () => {
  const f = setup();
  f.options.remove.mockResolvedValueOnce(false);
  await f.step();
  await f.step();
  if (f.job.cleanup !== "complete") {
    f.restart();
    await f.step();
  }
  expect(f.job.cleanup).toBe("complete");
  expect(f.client.dispatch).toHaveBeenCalledOnce();
});

test("REST probe quota persists across restarts and also consumes the existing executor quota", async () => {
  const f = setup();
  f.setJob({
    ...f.job,
    profile: { ...f.job.profile, rest_budget_per_hour: 2 },
  });
  await f.step();
  f.budget().reserve();
  f.budget().reserve();
  expect(() => f.budget().reserve()).toThrow();
  f.restart();
  await f.step();
  expect(() => f.budget().reserve()).toThrow();
  const rows = f.store.database
    .prepare("SELECT doc FROM global_events WHERE type = 'github_rest_budget'")
    .all();
  expect(rows.map((r) => JSON.parse(String(r.doc)).payload.executor)).toContain(
    config.name,
  );
});

test("probe and ordinary checks share the configured executor concurrency budget", async () => {
  const f = setup();
  f.changeRun({ status: "in_progress", conclusion: null });
  await f.step();
  expect(() =>
    new GithubDispatchJournal(f.store).claim(
      {
        project: human.project_id,
        card: "C-1",
        attempt: "ordinary",
        key: "ordinary-key",
        phase: "reserved",
        executor: config.name,
        startedAt: new Date().toISOString(),
      },
      1,
    ),
  ).toThrow("card_busy");
});

test("cancellation during publication fences dispatch and cleanup uses the original candidate only", async () => {
  const f = setup();
  let cancelled = false;
  f.options.push.mockImplementationOnce(async () => {
    cancelled = true;
    return { status: "pushed" };
  });
  const adapter = new GithubProbe(f.options);
  const result = await adapter.advance(f.job, f.setJob, () => cancelled);
  expect(result.cleanup).toBe("held");
  expect(f.client.dispatch).not.toHaveBeenCalled();
  f.setJob({ ...f.job, cancel_requested: true });
  await f.step();
  expect(f.job).toMatchObject({ status: "cancelled", cleanup: "complete" });
  expect(f.options.remove).toHaveBeenCalledOnce();
});
