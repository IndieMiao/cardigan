import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  checkTimedOutOnly,
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

test("C-116: vitest output with only test or hook timeouts is timeout-only", () => {
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
    "a failed suite",
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

test("C-116: step timeouts and vitest timeouts combine; anything else does not", () => {
  const outputs: Record<string, string> = {
    lint: "",
    unit: run(timeoutBlock("slow")),
    broken: run(assertionBlock, 1),
  };
  const read = (name: string) => outputs[name] ?? "";
  expect(
    checkTimedOutOnly(
      "timed_out",
      [
        { name: "lint", status: "passed" },
        { name: "e2e", status: "timed_out" },
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
});
