import { posix } from "node:path";
import type { MergeCheckView } from "@cardigan/domain";

export const WORKER_EXIT_RULE = "vitest_worker_exit_5_1" as const;
export type InfraFlakyRule = typeof WORKER_EXIT_RULE;
export interface WorkerFailureIdentity {
  readonly project_id: string;
  readonly card_id: string;
  readonly completion_id: string;
  readonly attempt_id: string;
  readonly candidate_sha: string;
  readonly tree_sha: string;
}
export interface CandidateTestSnapshot {
  readonly candidate_sha: string;
  readonly tree_sha: string;
  readonly files: readonly {
    readonly path: string;
    readonly type: string;
    readonly mode: string;
  }[];
}
/** Opaque host values: serialized objects and copied markers carry no authority. */
export interface WorkerFailureContext {
  readonly kind: "worker_failure_context";
}
export interface VerifiedCheckoutContext {
  readonly kind: "verified_checkout";
}
const contexts = new WeakMap<
  WorkerFailureContext,
  {
    identity: WorkerFailureIdentity;
    files: ReadonlySet<string>;
    executor: "ssh" | "github";
    root?: string;
  }
>();
const checkouts = new WeakMap<
  VerifiedCheckoutContext,
  {
    project_id: string;
    attempt_id: string;
    candidate_sha: string;
    tree_sha: string;
    root: string;
  }
>();
const sha = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
const relative = (value: string) =>
  !!value &&
  !posix.isAbsolute(value) &&
  !/[\\\s%\p{Cc}\p{Cf}]/u.test(value) &&
  posix.normalize(value) === value &&
  !value.split("/").some((s) => !s || s === "." || s === "..");
export function candidateTestPath(path: string): boolean {
  return (
    relative(path) &&
    /^(?:packages|apps)\/[a-z0-9-]+\/src\/.+\.test\.tsx?$/u.test(path)
  );
}
const same = (a: WorkerFailureIdentity, b: WorkerFailureIdentity) =>
  a.project_id === b.project_id &&
  a.card_id === b.card_id &&
  a.completion_id === b.completion_id &&
  a.attempt_id === b.attempt_id &&
  a.candidate_sha === b.candidate_sha &&
  a.tree_sha === b.tree_sha;
/** Called only by host orchestration with the center's fixed candidate tree. */
export function createWorkerFailureContext(
  identity: WorkerFailureIdentity,
  snapshot: CandidateTestSnapshot,
  executor: "ssh" | "github",
  scope?: MergeCheckView["scope"],
): WorkerFailureContext | undefined {
  if (
    !sha(identity.candidate_sha) ||
    !sha(identity.tree_sha) ||
    snapshot.candidate_sha !== identity.candidate_sha ||
    snapshot.tree_sha !== identity.tree_sha ||
    scope?.kind === "docs_only"
  )
    return undefined;
  const files = new Set(
    snapshot.files
      .filter(
        (entry) =>
          entry.type === "blob" &&
          ["100644", "100755"].includes(entry.mode) &&
          candidateTestPath(entry.path) &&
          (scope?.kind !== "affected" ||
            scope.packages?.some((p) => entry.path.startsWith(`${p}/`))),
      )
      .map((entry) => entry.path),
  );
  const token = Object.freeze({ kind: "worker_failure_context" as const });
  contexts.set(token, { identity: { ...identity }, files, executor });
  return token;
}
/** Minted at the authenticated checkout-verified event, never from output text. */
export function verifiedCheckoutContext(input: {
  project_id: string;
  attempt_id: string;
  candidate_sha: string;
  tree_sha: string;
  root: string;
}): VerifiedCheckoutContext {
  if (
    !posix.isAbsolute(input.root) ||
    posix.normalize(input.root) !== input.root ||
    input.root === "/" ||
    /[\\%\p{Cc}\p{Cf}]/u.test(input.root) ||
    !sha(input.candidate_sha) ||
    !sha(input.tree_sha)
  )
    throw new Error("Invalid verified checkout context");
  const token = Object.freeze({ kind: "verified_checkout" as const });
  checkouts.set(token, { ...input });
  return token;
}
export function bindWorkerCheckout(
  context: WorkerFailureContext,
  checkout: VerifiedCheckoutContext,
): boolean {
  const target = contexts.get(context),
    root = checkouts.get(checkout);
  if (
    !target ||
    !root ||
    target.executor !== "ssh" ||
    target.root !== undefined ||
    target.identity.project_id !== root.project_id ||
    target.identity.attempt_id !== root.attempt_id ||
    target.identity.candidate_sha !== root.candidate_sha ||
    target.identity.tree_sha !== root.tree_sha
  )
    return false;
  target.root = root.root;
  return true;
}
export function workerContextMatches(
  context: WorkerFailureContext | undefined,
  identity: WorkerFailureIdentity | undefined,
): boolean {
  const value = context && contexts.get(context);
  return !!value && !!identity && same(value.identity, identity);
}
export function workerExitLine(
  context: WorkerFailureContext,
  identity: WorkerFailureIdentity,
  line: string,
): boolean {
  if (!workerContextMatches(context, identity)) return false;
  const value = contexts.get(context);
  const match =
    /^Error: Worker exited unexpectedly with exit code 1 during started state while running test file (.+)$/u.exec(
      line,
    );
  if (!value || !match?.[1]) return false;
  let path = match[1];
  if (posix.isAbsolute(path)) {
    if (
      value.executor !== "ssh" ||
      !value.root ||
      !path.startsWith(`${value.root}/`)
    )
      return false;
    path = path.slice(value.root.length + 1);
  }
  return relative(path) && value.files.has(path);
}
