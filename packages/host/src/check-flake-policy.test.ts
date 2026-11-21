import { resolve } from "node:path";
import { expect, type RunnerTestCase, test } from "vitest";
import {
  caseReceipts,
  matchesFailure,
} from "../../../test-support/check-flake-evidence.js";
import { configureCaseRetry } from "../../../test-support/check-flake-runner.js";
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

test("the coordinator ties recovery to exact identity, first signature and indexed attempts, not worker metadata", () => {
  const attempts = [
    { state: "failed", retryIndex: 0, repeatIndex: 0, errors: [download] },
    { state: "passed", retryIndex: 1, repeatIndex: 0 },
  ] as const;
  const row = { ...checkFlakeCases.corepack, state: "passed", attempts };
  expect(caseReceipts(["corepack"], [row])).toEqual({
    recovered: ["corepack"],
    complete: true,
  });
  expect(
    caseReceipts(
      ["corepack"],
      [
        {
          ...row,
          attempts: [{ state: "passed", retryIndex: 0, repeatIndex: 0 }],
        },
      ],
    ),
  ).toEqual({ recovered: [], complete: true });
  for (const rows of [
    [],
    [row, row],
    [{ ...row, name: "other" }],
    [{ ...row, file: "other" }],
    [{ ...row, state: "failed" }],
    [
      {
        ...row,
        attempts: [
          { ...attempts[0], errors: [new Error("assertion")] },
          attempts[1],
        ],
      },
    ],
    [{ ...row, attempts: [attempts[0], { ...attempts[1], state: "skipped" }] }],
  ])
    expect(caseReceipts(["corepack"], rows)).toEqual({
      recovered: [],
      complete: false,
    });
  expect(caseReceipts([], [row])).toEqual({ recovered: [], complete: true });
  // Missing or failed evidence for B cannot erase A, or permit the partition to pass.
  for (const other of [
    [],
    [{ ...row, ...checkFlakeCases.ssh_local, state: "failed" }],
  ])
    expect(caseReceipts(["ssh_local", "corepack"], [...other, row])).toEqual({
      recovered: ["corepack"],
      complete: false,
    });
});
