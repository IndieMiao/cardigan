import type { MergeCheckView } from "@cardigan/domain";
import {
  bindWorkerCheckout,
  type CandidateTestSnapshot,
  createWorkerFailureContext,
  verifiedCheckoutContext,
  WORKER_EXIT_RULE,
  type WorkerFailureIdentity,
} from "../src/worker-failure-context.js";
export const workerFile = "packages/host/src/example.test.ts";
export const workerRoot = "/fixture/checks/p/attempt-1/worktree";
export const workerIdentity: WorkerFailureIdentity = {
  project_id: "p",
  card_id: "C-1",
  completion_id: "D-1",
  attempt_id: "attempt-1",
  candidate_sha: "a".repeat(40),
  tree_sha: "b".repeat(40),
};
export const workerLine = (file = workerFile) =>
  `Error: Worker exited unexpectedly with exit code 1 during started state while running test file ${file}`;
export const workerReport = (roots = [workerLine()]) =>
  [
    " RUN  v5.1.0 /fixture",
    "⎯⎯⎯ Unhandled Errors ⎯⎯⎯",
    `Vitest caught ${roots.length} unhandled error${roots.length === 1 ? "" : "s"} during the test run.`,
    ...roots.flatMap((line) => ["⎯⎯⎯ Unhandled Error ⎯⎯⎯", line]),
    `Errors ${roots.length} error${roots.length === 1 ? "" : "s"}`,
  ].join("\n");
export function workerFixture(
  options: {
    identity?: WorkerFailureIdentity;
    snapshot?: CandidateTestSnapshot;
    executor?: "ssh" | "github";
    scope?: MergeCheckView["scope"];
    root?: string;
  } = {},
) {
  const identity = options.identity ?? { ...workerIdentity };
  const snapshot = options.snapshot ?? {
    candidate_sha: identity.candidate_sha,
    tree_sha: identity.tree_sha,
    files: [{ path: workerFile, type: "blob", mode: "100644" }],
  };
  const context = createWorkerFailureContext(
    identity,
    snapshot,
    options.executor ?? "ssh",
    options.scope,
  );
  if (options.root && context)
    bindWorkerCheckout(
      context,
      verifiedCheckoutContext({
        project_id: identity.project_id,
        attempt_id: identity.attempt_id,
        candidate_sha: identity.candidate_sha,
        tree_sha: identity.tree_sha,
        root: options.root,
      }),
    );
  return {
    identity,
    snapshot,
    context,
    options: {
      identity,
      ...(context ? { context } : {}),
      rules: [WORKER_EXIT_RULE],
    },
  };
}
