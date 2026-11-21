import { resolve } from "node:path";
import { expect, type RunnerTestCase, test } from "vitest";
import {
  configureCaseRetry,
  matchesFailure,
} from "../../../test-support/check-flake-runner.js";
import { recoveredOnRetry } from "../../../test-support/ci-reporters.js";
import { type CheckFlakeId, checkFlakeCases } from "./check-flake-cases.js";

const timeout = new Error(
  'Test timed out in 5000ms.\nIf this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".',
);
const download = new Error(
  "Command failed: pnpm test\n! Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-12.21.0.tgz\nDownloading the pnpm 12.21.0 binary for linux-x64...\n",
);
const loopback = new TypeError("fetch failed", {
  cause: new AggregateError([
    { syscall: "connect", code: "ECONNREFUSED", address: "127.0.0.1" },
    { syscall: "connect", code: "ETIMEDOUT", address: "::1" },
  ]),
});
function policy(
  id: CheckFlakeId,
  eligible: CheckFlakeId[],
  errors: Error[],
  name: string = checkFlakeCases[id].name,
) {
  const task = {
    type: "test",
    fullTestName: name,
    file: { filepath: resolve(checkFlakeCases[id].file) },
    result: { errors },
    meta: {},
  } as unknown as RunnerTestCase;
  configureCaseRetry(task, eligible);
  // The condition inspects all task errors, not only Vitest's last-error argument.
  return typeof task.retry === "object" &&
    typeof task.retry.condition === "function" &&
    task.retry.condition({ message: "last" })
    ? task.retry.count
    : 0;
}
test("only one retry, tied to exact case, scope and a single matching environment error", () => {
  expect(policy("corepack", ["corepack"], [download])).toBe(1);
  expect(policy("corepack", [], [download])).toBe(0);
  expect(policy("corepack", ["corepack"], [download], "a different case")).toBe(
    0,
  );
  expect(
    policy(
      "corepack",
      ["corepack"],
      [new Error(`${download.message}AssertionError: guard failed`)],
    ),
  ).toBe(0);
  expect(policy("ssh_remote", ["ssh_remote"], [timeout])).toBe(1);
  expect(policy("ssh_remote", ["corepack"], [timeout])).toBe(0);
  expect(
    policy(
      "ssh_remote",
      ["ssh_remote"],
      [new Error("assertion failed"), timeout],
    ),
  ).toBe(0);
  expect(policy("loopback", ["loopback"], [loopback])).toBe(1);
  expect(policy("loopback", [], [loopback])).toBe(0);
  expect(matchesFailure("loopback", new TypeError("fetch failed"))).toBe(false);
  expect(
    matchesFailure(
      "loopback",
      new TypeError("fetch failed", {
        cause: {
          code: "ECONNREFUSED",
          address: "example.invalid",
          syscall: "connect",
        },
      }),
    ),
  ).toBe(false);
  expect(
    matchesFailure("ssh_remote", new Error('Unable to find role="tabpanel"')),
  ).toBe(false);
});

test("only fail then pass is recorded; a second failure, skip or missing attempt is not a pass", () => {
  const attempts = (states: string[]) => states.map((state) => ({ state }));
  expect(recoveredOnRetry("passed", attempts(["failed", "passed"]))).toBe(true);
  expect(recoveredOnRetry("failed", attempts(["failed", "failed"]))).toBe(
    false,
  );
  expect(() =>
    recoveredOnRetry("skipped", attempts(["failed", "skipped"])),
  ).toThrow();
  expect(() => recoveredOnRetry("passed", attempts(["passed"]))).toThrow();
});
