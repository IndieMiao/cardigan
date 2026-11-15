import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  workerFile,
  workerFixture,
  workerLine,
  workerReport,
  workerRoot,
} from "../test-support/worker-failure.js";
import {
  checkInfraFlaky,
  checkTimedOutOnly,
  stepTimeoutOnly,
  TRUNCATED_OUTPUT,
  vitestTimeoutsOnly,
} from "./merge-check-timeout.js";
import { createMergeCheckLog } from "./merge-gate-log.js";

// Shapes taken from real vitest 5.1 output (non-TTY reporter).
const timeoutBlock = (name: string, ms = 5000, kind = "Test") => `
 FAIL  src/a.test.ts > ${name}
Error: ${kind} timed out in ${ms}ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ src/a.test.ts:2:1
      1| import { test } from "vitest";
      2| test("${name}", async () => {});
       | ^

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯
`;
const assertionBlock = `
 FAIL  src/b.test.ts > bad
AssertionError: expected 1 to be 2 // Object.is equality

- Expected
+ Received

 ❯ src/b.test.ts:2:31

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯
`;
const run = (blocks: string, count = 2) => ` RUN  v5.1.0 /repo

 ❯ src/a.test.ts (3 tests | 2 failed) 10207ms
   × slow one 5004ms
     → Test timed out in 5000ms.
   × slow two 5001ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests ${count} ⎯⎯⎯⎯⎯⎯⎯
${blocks}

 Test Files  1 failed (1)
      Tests  ${count} failed | 1 passed (3)
 ELIFECYCLE  Test failed. See above for more details.
`;

// V-431: real vitest 5.1 output for a suite-level beforeAll timeout.
const suiteHookTimeout = ` RUN  v5.1.0 /repo

 ❯ hook.test.ts (1 test | 1 skipped) 45ms

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  hook.test.ts [ hook.test.ts ]
Error: Hook timed out in 30ms.
If this is a long-running hook, pass a timeout value as the last argument or configure it globally with "hookTimeout".
 ❯ hook.test.ts:2:1
      1| import { beforeAll, test } from "vitest";
      2| beforeAll(() => new Promise(() => {}), 30);
       | ^
      3| test("would pass", () => {});
      4|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 skipped (1)
   Start at  12:27:18
   Duration  198ms (tests 62%, transform 22%, import 12%, worker 5%)
`;
// V-431: an assertion failure, after which the command hung until its step timeout.
const assertionThenHang = ` RUN  v5.1.0 /repo

 ❯ assert.test.mjs (1 test | 1 failed) 4ms
   × assertion 3ms
     → expected 1 to be 2 // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  assert.test.mjs > assertion
AssertionError: expected 1 to be 2 // Object.is equality
 ❯ assert.test.mjs:1:59

 Test Files  1 failed (1)
      Tests  1 failed (1)
`;

test("C-116: vitest output with only test or hook timeouts is timeout-only", () => {
  expect(vitestTimeoutsOnly(suiteHookTimeout)).toBe(true);
  expect(
    vitestTimeoutsOnly(
      run(timeoutBlock("slow one") + timeoutBlock("slow two")),
    ),
  ).toBe(true);
  expect(
    vitestTimeoutsOnly(
      run(timeoutBlock("setup", 10000, "Hook") + timeoutBlock("slow")),
    ),
  ).toBe(true);
  // Identical errors grouped under several FAIL headers.
  expect(
    vitestTimeoutsOnly(
      run(
        `\n FAIL  src/a.test.ts > one\n FAIL  src/a.test.ts > two\nError: Test timed out in 5000ms.\n`,
      ),
    ),
  ).toBe(true);
});

test.each([
  [
    "an assertion failure next to timeouts",
    run(timeoutBlock("slow") + assertionBlock),
  ],
  ["only an assertion failure", run(assertionBlock, 1)],
  [
    "a failed suite with an import error",
    `${run(timeoutBlock("slow"))}\n⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯\n\n FAIL  src/c.test.ts [ src/c.test.ts ]\nError: Cannot find module\n`,
  ],
  [
    "an unhandled error",
    `${run(timeoutBlock("slow"))}\n⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯\nError: boom\n`,
  ],
  [
    "an error count in the summary",
    `${run(timeoutBlock("slow"))}\n     Errors  1 error\n`,
  ],
  ["a type check or lint failure", "src/a.ts(1,1): error TS2322: nope\n"],
  // V-431: one command reporting a timeout and a TypeScript error.
  [
    "a timeout next to a TypeScript error",
    "\n FAIL  a.test.ts > slow\nError: Test timed out in 5000ms.\nsrc/a.ts(1,1): error TS2322: Type string is not assignable to type number.\n",
  ],
  [
    "a timeout next to an error the tests logged",
    `stderr | src/a.test.ts > slow\nError: something logged\n${run(timeoutBlock("slow"))}`,
  ],
  [
    "a timeout next to a lint diagnostic",
    `${run(timeoutBlock("slow"))}\nsrc/a.ts:1:1 lint/suspicious/noExplicitAny ━━━━\nFound 1 error.\n`,
  ],
  [
    "a suite hook timeout followed by another error",
    `\n⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯\n\n FAIL  src/c.test.ts [ src/c.test.ts ]\nError: Hook timed out in 30ms.\nSyntaxError: Unexpected token\n`,
  ],
  ["no output", ""],
  [
    "truncated output",
    `${timeoutBlock("slow")}\n${TRUNCATED_OUTPUT}\n${timeoutBlock("slow")}`,
  ],
  [
    "a timeout message that is not the failure's error",
    run(
      `\n FAIL  src/a.test.ts > x\nTypeError: Test timed out in 5000ms is not a function\n`,
    ),
  ],
])("C-116: %s is not timeout-only", (_name, output) => {
  expect(vitestTimeoutsOnly(output)).toBe(false);
});

test("C-116: a step timeout is clean only without other failure signals", () => {
  expect(stepTimeoutOnly("")).toBe(true);
  expect(stepTimeoutOnly("building...\nwaiting for server\n")).toBe(true);
  expect(stepTimeoutOnly(assertionThenHang)).toBe(false);
  expect(stepTimeoutOnly("Error: connect ECONNREFUSED\n")).toBe(false);
  expect(stepTimeoutOnly(`partial\n${TRUNCATED_OUTPUT}\nmore`)).toBe(false);
});

// V-436: real vitest 5.1 verbose output cut off by the step timeout while
// another test hung, before the final report was printed.
const cutOffAfterAssertion = ` RUN  v5.1.0 /repo

 × a.test.ts > value 6ms
   → expected 1 to be 2 // Object.is equality
`;
const cutOffAfterTimeout = ` RUN  v5.1.0 /repo

 × c.test.ts > slow 34ms
   → Test timed out in 30ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
`;

test("V-436: failed progress items need timeout evidence before the step timeout counts", () => {
  expect(stepTimeoutOnly(cutOffAfterAssertion)).toBe(false);
  expect(
    stepTimeoutOnly(
      " RUN  v5.1.0 /repo\n × a.test.mjs > value 4ms\n   → expected 1 to be 2 // Object.is equality\n",
    ),
  ).toBe(false);
  // Default reporter: no reason line under ×, and no report yet.
  expect(
    stepTimeoutOnly(" ❯ a.test.ts (2 tests | 1 failed)\n   × value 6ms\n"),
  ).toBe(false);
  // A report that explains fewer failures than the progress showed.
  expect(
    stepTimeoutOnly(
      `   × value 6ms\n   × other 3ms\n${run(timeoutBlock("value"), 1)}`,
    ),
  ).toBe(false);
  // A timed-out test cut off before the report is still only a timeout.
  expect(stepTimeoutOnly(cutOffAfterTimeout)).toBe(true);
  // The default reporter's × items are explained by the full timeout report.
  expect(
    vitestTimeoutsOnly(
      run(timeoutBlock("slow one") + timeoutBlock("slow two")),
    ),
  ).toBe(true);
});

test("C-116: step timeouts and vitest timeouts combine; anything else does not", () => {
  const outputs: Record<string, string> = {
    lint: "",
    unit: run(timeoutBlock("slow")),
    broken: run(assertionBlock, 1),
    // A step that printed a vitest timeout and then hung is still clean.
    slow: run(timeoutBlock("slow")),
    hung: assertionThenHang,
    typed:
      "src/a.ts(1,1): error TS2322: Type string is not assignable to type number.\n",
  };
  const read = (name: string) => outputs[name] ?? "";
  expect(
    checkTimedOutOnly(
      "timed_out",
      [
        { name: "lint", status: "passed" },
        { name: "e2e", status: "timed_out" },
        { name: "slow", status: "timed_out" },
        { name: "later", status: "not_run" },
      ],
      read,
    ),
  ).toBe(true);
  expect(
    checkTimedOutOnly(
      "failed",
      [
        { name: "lint", status: "passed" },
        { name: "unit", status: "failed" },
      ],
      read,
    ),
  ).toBe(true);
  for (const [status, checks] of [
    ["failed", [{ name: "broken", status: "failed" }]],
    [
      "failed",
      [
        { name: "unit", status: "failed" },
        { name: "broken", status: "failed" },
      ],
    ],
    ["failed", [{ name: "lint", status: "failed" }]],
    ["timed_out", [{ name: "e2e", status: "interrupted" }]],
    // V-431: an assertion or type error before the step timeout is not a timeout.
    ["timed_out", [{ name: "hung", status: "timed_out" }]],
    ["timed_out", [{ name: "typed", status: "timed_out" }]],
    [
      "timed_out",
      [
        { name: "unit", status: "failed" },
        { name: "hung", status: "timed_out" },
      ],
    ],
    ["failed", []],
    ["passed", [{ name: "unit", status: "passed" }]],
    ["interrupted", [{ name: "e2e", status: "timed_out" }]],
  ] as const)
    expect(checkTimedOutOnly(status, checks, read)).toBe(false);
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
test("C-116: the merge check log classifies the retained command output", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cg-gate-timeout-"));
  roots.push(dataDir);
  const finish = async (attempt: string, output: string) => {
    const log = await createMergeCheckLog({ dataDir, project: "p", attempt });
    log.append("test", output);
    return log.finish({
      status: "failed",
      checks: [
        { name: "lint", status: "passed", exit_code: 0 },
        { name: "test", status: "failed", exit_code: 1 },
      ],
      cleanup_errors: [],
    });
  };
  expect(
    await finish("attempt-1", run(timeoutBlock("a") + timeoutBlock("b"))),
  ).toMatchObject({ status: "failed", timeout_only: true });
  expect(
    await finish("attempt-2", run(timeoutBlock("a") + assertionBlock)),
  ).toMatchObject({ status: "failed", timeout_only: false });
  // V-431: the step timed out after an assertion failure.
  const hung = await createMergeCheckLog({
    dataDir,
    project: "p",
    attempt: "attempt-3",
  });
  hung.append("test", assertionThenHang);
  expect(
    await hung.finish({
      status: "timed_out",
      checks: [{ name: "test", status: "timed_out", exit_code: null }],
      cleanup_errors: [],
    }),
  ).toMatchObject({ status: "timed_out", timeout_only: false });
  const clean = await createMergeCheckLog({
    dataDir,
    project: "p",
    attempt: "attempt-4",
  });
  clean.append("test", "waiting for server\n");
  expect(
    await clean.finish({
      status: "timed_out",
      checks: [{ name: "test", status: "timed_out", exit_code: null }],
      cleanup_errors: [],
    }),
  ).toMatchObject({ status: "timed_out", timeout_only: true });
});

test("A3: skipped commands neither hide failure summaries nor disable timeout classification", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cg-scope-log-"));
  roots.push(dataDir);
  const log = await createMergeCheckLog({
    dataDir,
    project: "p",
    attempt: "docs-timeout",
  });
  const result = await log.finish({
    status: "timed_out",
    checks: [
      { name: "test", status: "skipped", reason: "docs_only" },
      { name: "build", status: "timed_out" },
    ],
    cleanup_errors: [],
  });
  expect(result.timeout_only).toBe(true);
  expect(result.summary).toContain("检查 build 未通过");
});

// Q-649: only the approved finite worker rule can produce infra_flaky.
test("Q-649: complete eligible relative/SSH paths match; missing and forged context refuse", () => {
  const f = workerFixture({ root: workerRoot });
  const check = (output: string, options = f.options) =>
    checkInfraFlaky(
      "failed",
      [{ name: "test", status: "failed" }],
      () => output,
      options,
    );
  expect(check(workerReport())).toBe(true);
  expect(check(workerReport([workerLine(`${workerRoot}/${workerFile}`)]))).toBe(
    true,
  );
  expect(check(workerReport(), { ...f.options, rules: [] })).toBe(false);
  expect(
    checkInfraFlaky("failed", [{ name: "test", status: "failed" }], () =>
      workerReport(),
    ),
  ).toBe(false);
  expect(
    check(workerReport(), {
      ...f.options,
      context: JSON.parse(JSON.stringify(f.context)),
    }),
  ).toBe(false);
  for (const message of [
    "[ERR_PNPM_META_FETCH_FAIL] GET https://registry.npmjs.org/p: fetch failed",
    "The runner has lost communication with the server.",
  ])
    expect(check(workerReport([message]))).toBe(false);
});

test.each([
  "project_id",
  "card_id",
  "completion_id",
  "attempt_id",
  "candidate_sha",
  "tree_sha",
] as const)("Q-649: stale %s cannot authorize another check", (key) => {
  const f = workerFixture();
  expect(
    checkInfraFlaky(
      "failed",
      [{ name: "test", status: "failed" }],
      () => workerReport(),
      { ...f.options, identity: { ...f.identity, [key]: "stale" } },
    ),
  ).toBe(false);
});

test.each([
  "../packages/host/src/example.test.ts",
  "packages//host/src/example.test.ts",
  "packages/host/src/../src/example.test.ts",
  "packages/host/src/%65xample.test.ts",
  "packages/host/src/generated.test.ts",
  "packages/host/src/example.ts",
  "/other/packages/host/src/example.test.ts",
  `${workerRoot}-sibling/${workerFile}`,
  `${workerRoot}/../worktree/${workerFile}`,
])("Q-649: path %s is outside the finite trusted membership", (file) => {
  const f = workerFixture({ root: workerRoot });
  expect(
    checkInfraFlaky(
      "failed",
      [{ name: "test", status: "failed" }],
      () => workerReport([workerLine(file)]),
      f.options,
    ),
  ).toBe(false);
});

test.each(["120000", "160000", "040000"])(
  "Q-649: non-regular mode %s cannot qualify",
  (mode) => {
    const f = workerFixture({
      snapshot: {
        ...workerFixture().snapshot,
        files: [
          {
            path: workerFile,
            type: mode === "160000" ? "commit" : "blob",
            mode,
          },
        ],
      },
    });
    expect(
      checkInfraFlaky(
        "failed",
        [{ name: "test", status: "failed" }],
        () => workerReport(),
        f.options,
      ),
    ).toBe(false);
  },
);

test.each([
  { kind: "docs_only" },
  { kind: "affected", packages: ["packages/domain"] },
] as const)("Q-649: scope %j refuses outside files", (scope) => {
  const f = workerFixture({ scope });
  expect(
    checkInfraFlaky(
      "failed",
      [{ name: "test", status: "failed" }],
      () => workerReport(),
      f.options,
    ),
  ).toBe(false);
});

test("Q-649: GitHub relative membership works but no absolute root is trusted", () => {
  const f = workerFixture({ executor: "github", root: workerRoot });
  const check = (file: string) =>
    checkInfraFlaky(
      "failed",
      [{ name: "test", status: "failed" }],
      () => workerReport([workerLine(file)]),
      f.options,
    );
  expect(check(workerFile)).toBe(true);
  expect(check(`${workerRoot}/${workerFile}`)).toBe(false);
});

test.each([
  (s: string) => s.replace("v5.1.0", "v5.2.0"),
  (s: string) => s.replace("started state", "starting state"),
  (s: string) => s.replace("exit code 1", "exit code 2"),
  (s: string) => s.replace("exit code 1", "signal SIGKILL"),
  (s: string) => s.replace("test file ", "test files "),
  (s: string) => s.replace("Errors 1 error", "Errors 2 errors"),
  (s: string) => s.replace("Errors 1 error", ""),
  (s: string) =>
    s.replace("Vitest caught 1 unhandled error during the test run.", ""),
  (s: string) => `${s}\n${TRUNCATED_OUTPUT}`,
  (s: string) => `stdout | packages/host/src/example.test.ts\n${s}`,
  (s: string) => `${s}\nerror TS2322: incompatible`,
])("Q-649: unknown or incomplete report variant %# refuses", (change) => {
  const f = workerFixture();
  expect(
    checkInfraFlaky(
      "failed",
      [{ name: "test", status: "failed" }],
      () => change(workerReport()),
      f.options,
    ),
  ).toBe(false);
});

test("V-1407/Q-649: every error group must be explained, including arbitrary custom names", () => {
  const f = workerFixture();
  const checks = [{ name: "test", status: "failed" }];
  expect(
    checkInfraFlaky(
      "failed",
      checks,
      () => workerReport([workerLine(), "Validation: invalid input"]),
      f.options,
    ),
  ).toBe(false);
  expect(
    checkInfraFlaky(
      "failed",
      checks,
      () => workerReport([workerLine(), workerLine()]),
      f.options,
    ),
  ).toBe(true);
  expect(
    checkInfraFlaky(
      "failed",
      [...checks, { name: "build", status: "failed" }],
      (name) => (name === "test" ? workerReport() : ""),
      f.options,
    ),
  ).toBe(false);
});

test("Q-649: skipped steps cannot conceal unexplained output", () => {
  const f = workerFixture();
  expect(
    checkInfraFlaky(
      "failed",
      [
        { name: "test", status: "failed" },
        { name: "build", status: "not_run" },
      ],
      (name) =>
        name === "test" ? workerReport() : "Validation: invalid input",
      f.options,
    ),
  ).toBe(false);
});

test("Q-649: an executable regular test inside the affected package remains eligible", () => {
  const base = workerFixture();
  const f = workerFixture({
    scope: { kind: "affected", packages: ["packages/host"] },
    snapshot: {
      ...base.snapshot,
      files: [{ path: workerFile, type: "blob", mode: "100755" }],
    },
  });
  expect(
    checkInfraFlaky(
      "failed",
      [{ name: "test", status: "failed" }],
      () => workerReport(),
      f.options,
    ),
  ).toBe(true);
});
