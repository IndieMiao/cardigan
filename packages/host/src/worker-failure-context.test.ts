import { expect, test } from "vitest";
import {
  workerFile,
  workerFixture,
  workerIdentity,
  workerRoot,
} from "../test-support/worker-failure.js";
import {
  bindWorkerCheckout,
  verifiedCheckoutContext,
  workerContextMatches,
  workerExitLine,
} from "./worker-failure-context.js";

test("Q-649: identity and membership are snapshots, not mutable caller metadata", () => {
  const f = workerFixture();
  if (!f.context) throw new Error("Missing context");
  const original = { ...f.identity };
  (f.snapshot.files as { path: string; mode: string; type: string }[]).push({
    path: "packages/host/src/generated.test.ts",
    mode: "100644",
    type: "blob",
  });
  (f.identity as { attempt_id: string }).attempt_id = "changed";
  expect(workerContextMatches(f.context, original)).toBe(true);
  expect(workerContextMatches(f.context, f.identity)).toBe(false);
  expect(
    workerExitLine(
      f.context,
      original,
      "Error: Worker exited unexpectedly with exit code 1 during started state while running test file packages/host/src/generated.test.ts",
    ),
  ).toBe(false);
});
test.each(["candidate_sha", "tree_sha"] as const)(
  "Q-649: wrong snapshot %s is not a trusted context",
  (field) => {
    const f = workerFixture();
    expect(
      workerFixture({ snapshot: { ...f.snapshot, [field]: "f".repeat(40) } })
        .context,
    ).toBeUndefined();
  },
);
test("Q-649: roots require the real opaque supervisor receipt and same checkout identity", () => {
  const f = workerFixture();
  if (!f.context) throw new Error("Missing context");
  const receipt = {
    project_id: workerIdentity.project_id,
    attempt_id: workerIdentity.attempt_id,
    candidate_sha: workerIdentity.candidate_sha,
    tree_sha: workerIdentity.tree_sha,
    root: workerRoot,
  };
  expect(
    bindWorkerCheckout(
      f.context,
      JSON.parse(JSON.stringify({ kind: "verified_checkout", ...receipt })),
    ),
  ).toBe(false);
  for (const key of [
    "project_id",
    "attempt_id",
    "candidate_sha",
    "tree_sha",
  ] as const)
    expect(
      bindWorkerCheckout(
        f.context,
        verifiedCheckoutContext({
          ...receipt,
          [key]: key.endsWith("sha") ? "f".repeat(40) : "other",
        }),
      ),
    ).toBe(false);
  expect(bindWorkerCheckout(f.context, verifiedCheckoutContext(receipt))).toBe(
    true,
  );
  expect(
    workerExitLine(
      f.context,
      f.identity,
      `Error: Worker exited unexpectedly with exit code 1 during started state while running test file ${workerRoot}/${workerFile}`,
    ),
  ).toBe(true);
});
