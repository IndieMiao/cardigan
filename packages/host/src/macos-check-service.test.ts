import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Delivery } from "@cardigan/domain";
import { PrecheckMergeConflict } from "@cardigan/git-service";
import { authenticate, type ToolContext } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import {
  assignments,
  card_id,
  project_id,
  seedProject,
  workItems,
} from "../../mcp-server/src/test-support.js";
import type { GithubClient, GithubRun } from "./github-client.js";
import { githubCheckRunName } from "./github-dispatch-discovery.js";
import type { MacosCheckProfiles } from "./macos-check-config.js";
import { MACOS_RESULT_MARKER } from "./macos-check-result.js";
import {
  type MacosCheckJob,
  MacosCheckService,
} from "./macos-check-service.js";
import type { GithubMergeGateExecutor } from "./merge-gate-executors.js";

const roots: string[] = [],
  stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const FILES = [
  "packages/runtime-herdr/src/darwin-retirement.test.ts",
  "packages/runtime-herdr/src/darwin-idle-owner.test.ts",
];
// The manifest is the only place an hc release is named.
const HC = `hc ${
  JSON.parse(
    readFileSync(
      new URL("../../../deploy/hc-version.json", import.meta.url),
      "utf8",
    ),
  ).version
}`;
const HEAD = "a".repeat(40),
  CANDIDATE = "c".repeat(40);
const base: GithubMergeGateExecutor = {
  name: "github",
  type: "github",
  repo: "fixture/project",
  workflow: ".github/workflows/cardigan-check.yml",
  appId: 1,
  installationId: 2,
  privateKeyFile: "/synthetic/app.pem",
  botLogin: "fixture[bot]",
  maxConcurrent: 1,
  pollIntervalMs: 1,
};
const summary = (patch: Record<string, unknown> = {}) => ({
  version: 1,
  candidate_sha: CANDIDATE,
  candidate_tree: "d".repeat(40),
  macos: "15.5 (24F74)",
  arch: "arm64",
  hc: HC,
  test_step: "success",
  exit_code: 0,
  files: FILES.map((file) => ({
    file,
    status: "passed",
    passed: 2,
    failed: 0,
    skipped: 0,
  })),
  real_hc_cases: [
    {
      file: FILES[1],
      title: "real hc: stops",
      status: "passed",
      duration_ms: 900,
    },
  ],
  timeouts: [],
  ...patch,
});
const line = (value: unknown) =>
  `2026-11-23T03:00:00.0000000Z ${MACOS_RESULT_MARKER} ${Buffer.from(JSON.stringify(value)).toString("base64")}`;

function setup(profiles: MacosCheckProfiles = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "macos-check-"));
  roots.push(dataDir);
  const store = Store.open({ dataDir });
  stores.push(store);
  store.createProject({ id: project_id });
  seedProject(store, { allowed_tools: ["request_macos_check"] });
  const delivery: Delivery = {
    id: "D-1" as never,
    work_item_id: workItems.id,
    run_id: "R-1" as never,
    kind: "code",
    summary: "Ship",
    subject: { kind: "git_head", value: HEAD },
    evidence: [],
    attachments: [],
    known_gaps: [],
    requested_verifiers: [],
    status: "submitted",
  };
  store.uow.run((tx) => {
    tx.deliveries.put(project_id, delivery);
    const card = tx.cards.get(project_id, card_id);
    if (!card) throw new Error("fixture card");
    tx.cards.put(project_id, { ...card, status: "in_progress" });
  });
  const token = store.issueToken({
    project_id,
    assignment_id: assignments.id,
    role: { role_version: 1, allowed_tools: ["request_macos_check"] },
  });
  const auth = authenticate(store, token.token);
  if (!auth.ok) throw new Error("fixture auth");
  const context: ToolContext = { store, identity: auth.value };
  let now = Date.parse("2030-01-01T00:00:00Z");
  let run: GithubRun = {
    id: 123,
    run_attempt: 1,
    path: ".github/workflows/cardigan-macos-check.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: "b".repeat(40),
    actor: { login: base.botLogin },
    triggering_actor: { login: base.botLogin },
    display_title: "",
    html_url: "https://github.com/fixture/project/actions/runs/123",
    created_at: new Date(now).toISOString(),
    status: "in_progress",
    conclusion: null,
  };
  let log = line(summary());
  let jobConclusion = "success";
  const client = {
    repository: vi.fn(async () => ({ private: false })),
    token: vi.fn(async () => "synthetic-secret"),
    dispatch: vi.fn(async (_ref: string, inputs: Record<string, string>) => {
      run = {
        ...run,
        created_at: new Date(now).toISOString(),
        display_title: githubCheckRunName(inputs),
      };
      return run.id;
    }),
    run: vi.fn(async () => run),
    runs: vi.fn(async (): Promise<GithubRun[]> => [run]),
    jobs: vi.fn(async () => [
      {
        id: 456,
        run_id: run.id,
        run_attempt: 1,
        head_sha: run.head_sha,
        name: "macos",
        status: "completed",
        conclusion: jobConclusion,
        steps: [
          ["install", "success", 40],
          ["test", jobConclusion, 300],
          ["Summarize", "success", 1],
        ].map(([name, conclusion, seconds], index) => ({
          name: name as string,
          number: index + 1,
          status: "completed",
          conclusion: conclusion as string,
          started_at: "2030-01-01T00:00:00Z",
          completed_at: new Date(
            Date.parse("2030-01-01T00:00:00Z") + (seconds as number) * 1000,
          ).toISOString(),
        })),
      },
    ]),
    jobLog: vi.fn(
      async (_id: number, open: () => (text: string) => void) =>
        void open()(`2026-11-23T02:59:00.0000000Z candidate output\n${log}\n`),
    ),
    cancel: vi.fn(async () => {}),
  };
  const options = {
    store,
    dataDir,
    profiles: () => profiles,
    executor: vi.fn((): GithubMergeGateExecutor | undefined => base),
    prepare: vi.fn(async () => ({
      sha: CANDIDATE,
      tree: "d".repeat(40),
      baseline: "main",
    })),
    push: vi.fn(async () => ({ status: "pushed" as const })),
    remove: vi.fn(async () => true),
    isBaselineAncestor: vi.fn(async () => true),
    client: () => client as unknown as GithubClient,
    now: () => now,
  };
  const service = new MacosCheckService(options);
  const request = (key: string, test_files = FILES) =>
    service.execute(context, { test_files, idempotency_key: key }) as Promise<
      Record<string, unknown>
    >;
  const jobs = (): MacosCheckJob[] => store.uow.read(() => service.jobs());
  const timeline = () =>
    store.uow.read((tx) =>
      tx.timeline
        .list(project_id)
        .filter((e) => e.author === "system")
        .map((e) => e.body),
    );
  return {
    store,
    service,
    client,
    options,
    request,
    jobs,
    timeline,
    finish: (conclusion: string, nextLog = log, job = conclusion) => {
      run = { ...run, status: "completed", conclusion };
      log = nextLog;
      jobConclusion = job;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("an author request runs the current delivery's candidate, writes the result back once and cleans up", async () => {
  const x = setup();
  const queued = await x.request("k1");
  expect(queued).toMatchObject({
    card_id,
    delivery_id: "D-1",
    head_sha: HEAD,
    files: FILES,
    run_number: 1,
    max_runs_per_candidate: 3,
    status: "queued",
  });
  expect(await x.request("k1")).toEqual(queued);
  expect(x.timeline().at(-1)).toContain("macOS 检查已排队（第 1/3 次）");

  await x.service.tick();
  const [job] = x.jobs();
  expect(job).toMatchObject({
    status: "running",
    billing: "public",
    tested_sha: CANDIDATE,
  });
  expect(x.options.prepare).toHaveBeenCalledTimes(1);
  expect(x.options.push).toHaveBeenCalledWith(
    project_id,
    expect.objectContaining({
      sha: CANDIDATE,
      ref: `refs/heads/ci/${card_id}/D-1/${queued.macos_check_id}`,
    }),
  );
  expect(x.client.dispatch).toHaveBeenCalledWith(
    "main",
    expect.objectContaining({ files: FILES.join(" "), sha: CANDIDATE }),
  );

  x.finish("success");
  await x.service.tick();
  const done = x.jobs()[0];
  expect(done).toMatchObject({
    status: "passed",
    cleanup: "complete",
    reported: true,
    run: { run_id: 123 },
  });
  expect(done?.report?.real_hc_cases[0]?.status).toBe("passed");
  expect(x.options.remove).toHaveBeenCalledTimes(1);
  const body = x.timeline().at(-1) ?? "";
  expect(body).toContain("macOS 检查结束：passed");
  expect(body).toContain(`macOS 15.5 (24F74)，arm64，${HC}`);
  expect(body).toContain(`${FILES[0]}：通过 2，失败 0，跳过 0`);
  expect(body).toContain("真实 hc 用例：real hc: stops = passed");
  expect(body).toContain("退出码 0");
  const attachments = x.store.uow.read((tx) => tx.attachments.list(project_id));
  expect(attachments).toHaveLength(1);
  expect(attachments[0]).toMatchObject({
    id: done?.attachment_id,
    kind: "evidence",
    uploaded_by: "system",
  });

  await x.service.tick();
  expect(x.client.dispatch).toHaveBeenCalledTimes(1);
  expect(x.timeline().filter((b) => b.includes("检查结束"))).toHaveLength(1);
});

test("identical active requests join; reruns are allowed up to the configured limit", async () => {
  const x = setup({ [project_id]: { max_runs_per_candidate: 2 } });
  const first = await x.request("k1");
  expect(await x.request("k2")).toEqual({ ...first, joined: true });
  // The same set of files in another order is the same check.
  expect(await x.request("k2r", [...FILES].reverse())).toEqual({
    ...first,
    joined: true,
  });
  const second = await x.request("k3", [FILES[0] as string]);
  expect(second).toMatchObject({ run_number: 2, max_runs_per_candidate: 2 });
  await expect(x.request("k4", [FILES[1] as string])).rejects.toMatchObject({
    code: "illegal_transition",
    message: expect.stringContaining("达到主机上限 2 次"),
  });
});

test("a private repository runs only under the spending delegation and never creates a human action", async () => {
  const x = setup();
  x.client.repository.mockResolvedValue({ private: true });
  await x.request("k1");
  await x.service.tick();
  expect(x.jobs()[0]).toMatchObject({ status: "not_run", reported: true });
  expect(x.client.dispatch).not.toHaveBeenCalled();
  expect(x.timeline().at(-1)).toContain("未开启花钱类常驻授权，未运行");
  expect(x.store.uow.read((tx) => tx.human_actions.list(project_id))).toEqual(
    [],
  );

  x.store.uow.run((tx) =>
    tx.project_preferences.put(project_id, {
      id: project_id,
      auto_merge_after_minutes: null,
      decision_delegation: { spending: true },
    } as never),
  );
  await x.request("k2");
  await x.service.tick();
  expect(x.jobs()[1]).toMatchObject({
    status: "running",
    billing: "private_delegated",
  });
});

test("a timed-out case is reported with its own phase timings, its file's timings and the job's step timings", async () => {
  const x = setup();
  await x.request("k1");
  await x.service.tick();
  x.finish(
    "failure",
    line(
      summary({
        test_step: "failure",
        exit_code: 1,
        timeouts: [
          {
            file: FILES[1],
            title: "real hc: stops",
            status: "failed",
            duration_ms: 30000,
            phases: [
              { name: "fixture ready", at_ms: 1200 },
              { name: "signed stop sent", at_ms: 7300 },
            ],
            file_cases: [
              { title: "c", status: "passed", duration_ms: 12 },
              { title: "real hc: stops", status: "failed", duration_ms: 30000 },
            ],
          },
        ],
      }),
    ),
    "failure",
  );
  await x.service.tick();
  expect(x.jobs()[0]?.status).toBe("timed_out");
  const body = x.timeline().at(-1) ?? "";
  expect(body).toContain(
    `超时：${FILES[1]} › real hc: stops（30.0s）；分步计时：fixture ready 6.1s → signed stop sent（最后到达，停留 22.7s）；同文件用例耗时：c passed 0.0s；real hc: stops failed 30.0s`,
  );
  expect(body).toContain("步骤计时：install success 40s；test failure 300s");
});

test("a forged or foreign summary never passes", async () => {
  const x = setup();
  await x.request("k1");
  await x.service.tick();
  x.finish("success", line(summary({ candidate_sha: "e".repeat(40) })));
  await x.service.tick();
  expect(x.jobs()[0]).toMatchObject({
    status: "failed",
    reason: "汇总中的候选与本次检查不一致，结果不作通过",
  });
  const y = setup();
  await y.request("k1");
  await y.service.tick();
  y.finish("success", "no marker");
  await y.service.tick();
  expect(y.jobs()[0]).toMatchObject({
    status: "failed",
    reason: "未取得测试汇总，结果不作通过",
  });
});

test("supervision timeout cancels the remote run; invalid files and missing executors are refused", async () => {
  const x = setup({ [project_id]: { timeout_ms: 600_000 } });
  await x.request("k1");
  await x.service.tick();
  x.advance(600_000);
  await x.service.tick();
  expect(x.client.cancel).toHaveBeenCalledWith(123);
  x.finish("cancelled");
  await x.service.tick();
  expect(x.jobs()[0]).toMatchObject({
    status: "timed_out",
    reason: "超过主机监督时限",
    cleanup: "complete",
  });

  await expect(x.request("bad", ["--reporter=x"])).rejects.toMatchObject({
    code: "validation_failed",
  });
  x.options.executor.mockReturnValue(undefined);
  await expect(x.request("none")).rejects.toMatchObject({
    code: "illegal_transition",
  });
  const disabled = setup({ [project_id]: { enabled: false } });
  await expect(disabled.request("k")).rejects.toMatchObject({
    code: "illegal_transition",
  });
});

test("a restarted host rebinds the durable dispatch instead of posting a second run", async () => {
  const x = setup();
  await x.request("k1");
  await x.service.tick();
  expect(x.client.dispatch).toHaveBeenCalledTimes(1);
  const restarted = new MacosCheckService(x.options);
  x.finish("success");
  await restarted.tick();
  expect(x.client.dispatch).toHaveBeenCalledTimes(1);
  expect(x.jobs()[0]).toMatchObject({ status: "passed", cleanup: "complete" });
});

test("a delivery that conflicts with the baseline is reported as not run", async () => {
  const x = setup();
  x.options.prepare.mockRejectedValue(
    new PrecheckMergeConflict("e".repeat(40)),
  );
  await x.request("k1");
  await x.service.tick();
  expect(x.jobs()[0]).toMatchObject({
    status: "failed",
    reason: "当前交付与基线冲突，未运行",
    reported: true,
  });
  expect(x.client.dispatch).not.toHaveBeenCalled();
});

const delegate = (store: Store, spending: boolean) =>
  store.uow.run((tx) =>
    tx.project_preferences.put(project_id, {
      id: project_id,
      auto_merge_after_minutes: null,
      decision_delegation: { spending },
    } as never),
  );

test("billing is decided again right before publication: a revoked delegation or a newly private repository does not run", async () => {
  const x = setup();
  x.client.repository.mockResolvedValue({ private: true });
  delegate(x.store, true);
  await x.request("k1");
  await x.service.tick();
  expect(x.client.dispatch).toHaveBeenCalledTimes(1);
  // A second file set waits behind the first run on the same card.
  await x.request("k2", [FILES[0] as string]);
  await x.service.tick();
  expect(x.jobs()[1]).toMatchObject({
    status: "running",
    billing: "private_delegated",
  });
  expect(x.client.dispatch).toHaveBeenCalledTimes(1);
  delegate(x.store, false);
  x.finish("success");
  await x.service.tick();
  await x.service.tick();
  expect(x.jobs()[0]?.status).toBe("passed");
  expect(x.jobs()[1]).toMatchObject({
    status: "not_run",
    cleanup: "complete",
    reported: true,
    reason: expect.stringContaining("未开启花钱类常驻授权"),
  });
  expect(x.client.dispatch).toHaveBeenCalledTimes(1);
  expect(x.options.push).toHaveBeenCalledTimes(1);
  expect(x.store.uow.read((tx) => tx.human_actions.list(project_id))).toEqual(
    [],
  );

  // A repository first read as public is read again before its dispatch.
  const y = setup();
  await y.request("k1");
  await y.service.tick();
  await y.request("k2", [FILES[0] as string]);
  await y.service.tick();
  expect(y.jobs()[1]).toMatchObject({ status: "running", billing: "public" });
  y.client.repository.mockResolvedValue({ private: true });
  y.finish("success");
  await y.service.tick();
  await y.service.tick();
  expect(y.jobs()[1]?.status).toBe("not_run");
  expect(y.client.dispatch).toHaveBeenCalledTimes(1);
});

test("an unconfirmed dispatch is reported at the deadline, its slot is released once absence is proven, and the next request really dispatches", async () => {
  const x = setup({ [project_id]: { timeout_ms: 600_000, max_concurrent: 1 } });
  x.client.dispatch.mockRejectedValueOnce(new Error("HTTP 404"));
  x.client.runs.mockResolvedValue([]);
  await x.request("k1");
  await x.service.tick();
  expect(x.jobs()[0]).toMatchObject({ status: "running", cleanup: "held" });
  x.advance(600_000);
  await x.service.tick();
  expect(x.jobs()[0]).toMatchObject({
    status: "timed_out",
    reason: "超过主机监督时限；远程运行未能确认",
    reported: true,
  });
  await x.request("k2", [FILES[0] as string]);
  expect(x.client.dispatch).toHaveBeenCalledTimes(1);
  // Absence counts only after the discovery window following the POST.
  let minutes = 0;
  while (x.client.dispatch.mock.calls.length < 2 && minutes < 30) {
    x.advance(60_000);
    minutes++;
    await x.service.tick();
  }
  expect(minutes).toBeLessThan(30);
  expect(x.jobs()[0]?.cleanup).toBe("complete");
  expect(x.client.dispatch).toHaveBeenCalledTimes(2);
  expect(x.jobs()[1]).toMatchObject({ status: "running" });
  expect(x.client.cancel).not.toHaveBeenCalled();
});

test("a late-found original run is bound and cancelled, never dispatched again", async () => {
  const x = setup({ [project_id]: { timeout_ms: 600_000 } });
  let posted: Record<string, string> | undefined;
  x.client.dispatch.mockImplementationOnce(async (_ref, inputs) => {
    posted = inputs;
    throw new Error("HTTP 502");
  });
  x.client.runs.mockResolvedValue([]);
  await x.request("k1");
  await x.service.tick();
  x.advance(600_000);
  await x.service.tick();
  expect(x.jobs()[0]?.status).toBe("timed_out");
  // The POST had in fact created the run; discovery now sees it.
  const original = (await x.client.run()) as GithubRun;
  const late = {
    ...original,
    id: 777,
    display_title: githubCheckRunName(posted ?? {}),
    created_at: new Date(Date.parse("2030-01-01T00:00:00Z")).toISOString(),
    html_url: "https://github.com/fixture/project/actions/runs/777",
  };
  x.client.runs.mockResolvedValue([late]);
  x.client.run.mockResolvedValue(late);
  for (let i = 0; i < 5; i++) {
    x.advance(30_000);
    await x.service.tick();
  }
  expect(x.client.cancel).toHaveBeenCalledWith(777);
  expect(x.client.dispatch).toHaveBeenCalledTimes(1);
  x.client.run.mockResolvedValue({
    ...late,
    status: "completed",
    conclusion: "cancelled",
  });
  x.advance(30_000);
  await x.service.tick();
  expect(x.jobs()[0]).toMatchObject({
    status: "timed_out",
    cleanup: "complete",
  });
  expect(x.timeline().filter((b) => b.includes("macOS 检查结束"))).toHaveLength(
    1,
  );
});

test("a log that cannot be read yet is read again from the same run; nothing is redispatched", async () => {
  const x = setup();
  await x.request("k1");
  await x.service.tick();
  x.finish("success");
  x.client.jobLog.mockRejectedValueOnce(new Error("HTTP 503"));
  await x.service.tick();
  expect(x.jobs()[0]).toMatchObject({ status: "running" });
  expect(x.jobs()[0]?.reported).toBeUndefined();
  await x.service.tick();
  expect(x.jobs()[0]).toMatchObject({ status: "passed", reported: true });
  expect(x.client.jobLog).toHaveBeenCalledTimes(2);
  expect(x.client.dispatch).toHaveBeenCalledTimes(1);
  expect(x.jobs()[0]?.run_number).toBe(1);

  // Past the supervision deadline the result says why it has no evidence.
  const y = setup({ [project_id]: { timeout_ms: 600_000 } });
  await y.request("k1");
  await y.service.tick();
  y.finish("success");
  y.client.jobLog.mockRejectedValue(new Error("HTTP 503"));
  await y.service.tick();
  y.advance(600_000);
  await y.service.tick();
  expect(y.jobs()[0]).toMatchObject({
    status: "failed",
    reason: "主机监督时限内未能读取运行日志，结果不作通过",
    reported: true,
  });
});

test("only a report naming the candidate commit and tree and covering every requested file passes", async () => {
  const cases: [Record<string, unknown>, string][] = [
    [
      { files: summary().files.slice(0, 1) },
      "汇总未覆盖全部请求的测试文件，结果不作通过",
    ],
    [{ files: [] }, "汇总未覆盖全部请求的测试文件，结果不作通过"],
    [
      { candidate_tree: "e".repeat(40) },
      "汇总中的候选与本次检查不一致，结果不作通过",
    ],
  ];
  for (const [patch, reason] of cases) {
    const x = setup();
    await x.request("k1");
    await x.service.tick();
    x.finish("success", line(summary(patch)));
    await x.service.tick();
    expect(x.jobs()[0]).toMatchObject({ status: "failed", reason });
  }
  // A passing verdict cannot contradict the test step or failure counts.
  for (const patch of [
    { test_step: "failure" },
    {
      files: summary().files.map((f) => ({ ...f, failed: 1 })),
    },
  ]) {
    const x = setup();
    await x.request("k1");
    await x.service.tick();
    x.finish("success", line(summary(patch)));
    await x.service.tick();
    expect(x.jobs()[0]?.status).toBe("failed");
  }
});
