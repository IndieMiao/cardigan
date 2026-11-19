import { createHash } from "node:crypto";
import type { MergeCheckView } from "@cardigan/domain";
import type { Store } from "@cardigan/store";
import type { CheckRequest } from "./check-executor.js";
import { githubCheckScope, githubScopedRequest } from "./github-check-scope.js";
import {
  type GithubClient,
  GithubExecutorError,
  type GithubRun,
} from "./github-client.js";
import type {
  ExternalGithubRun,
  GithubDispatchIntent,
  GithubDispatchJournal,
} from "./github-dispatch-journal.js";
import { canFinishUndispatched } from "./github-dispatch-journal.js";
import { GITHUB_POLL_DEFAULTS } from "./github-rate-limit.js";
import type { ProjectMergeGate } from "./merge-gate-config.js";
import {
  type GithubMergeGateExecutor,
  MAX_EXECUTOR_CONCURRENCY,
} from "./merge-gate-executors.js";
/** D2 uses this exact six-input expression for workflow run-name. */
export function githubCheckRunName(
  inputs: Readonly<Record<string, string>>,
): string {
  return `cardigan/${inputs.card}/${inputs.delivery}/${inputs.attempt}/${inputs.kind}/${inputs.sha}/${inputs.tree}`;
}
export interface GithubCheckContext {
  readonly card: string;
  readonly delivery: string;
  readonly baselineBranch: string;
  /** Called with validated public identity, before onReady. May persist a domain running record. */
  readonly onExternalRun?: (run: ExternalGithubRun) => void;
}
export function githubDispatchIdentity(
  request: CheckRequest,
  context: GithubCheckContext,
  config: GithubMergeGateExecutor,
  abandonedKey?: string,
) {
  if (!request.attempt) throw new GithubExecutorError("security");
  const inputs = {
    sha: request.sha,
    tree: request.tree,
    card: context.card,
    delivery: context.delivery,
    attempt: request.attempt,
    kind: request.kind,
    ...(config.scopedChecks ? githubCheckScope(request) : {}),
  };
  // Cleanup policy is not dispatch identity; preserve existing durable keys.
  const dispatchConfig = { ...config };
  delete dispatchConfig.branchRetentionMs;
  delete dispatchConfig.queueWaitMs;
  if (dispatchConfig.scopedChecks === false) delete dispatchConfig.scopedChecks;
  const digest = (candidate: GithubMergeGateExecutor) =>
    createHash("sha256")
      .update(
        JSON.stringify([
          candidate,
          request.project,
          context.baselineBranch,
          inputs,
        ]),
      )
      .digest("hex");
  const key = digest(dispatchConfig);
  // C-308 predates a capacity change. Prove the historical digest exactly;
  // only the local admission limit can vary, never the workflow, credentials or inputs.
  if (abandonedKey && key !== abandonedKey) {
    for (let n = 1; n <= MAX_EXECUTOR_CONCURRENCY; n++)
      if (digest({ ...dispatchConfig, maxConcurrent: n }) === abandonedKey)
        return { inputs, key: abandonedKey };
  }
  return { inputs, key };
}
export function requestChecks(
  settings: Extract<ProjectMergeGate, { status: "enabled" }>,
  scope?: MergeCheckView["scope"],
  level: "card" | "batch" = "card",
): CheckRequest["checks"] {
  return settings.checks
    .filter(
      (step) =>
        !settings.queue ||
        (step.name === "e2e"
          ? level === "batch"
          : !step.tiers || step.tiers.includes(level)) ||
        settings.executor?.type === "github",
    )
    .map((step) => ({
      name: step.name,
      run: step.run,
      ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
      ...(settings.queue && level === "card" && step.name === "e2e"
        ? { skipReason: "card_tier" as const }
        : {}),
      ...(scope?.kind === "docs_only" &&
      step.skipDocsOnly &&
      !(settings.queue && level === "card" && step.name === "e2e")
        ? { skipReason: "docs_only" as const }
        : {}),
      ...(step.scope === "affected"
        ? {
            affectedPaths:
              scope?.kind === "affected" ? (scope.packages ?? []) : [],
          }
        : {}),
    }));
}

/** Reconstruct the exact original check (including its scope), never the latest attempt. */
export function abandonedGithubRequest(
  store: Store,
  journal: GithubDispatchJournal,
  intent: GithubDispatchIntent,
  settings: ProjectMergeGate,
) {
  const original = store.uow.read(
    (tx) =>
      journal.candidatePrecheck(tx, intent) ??
      journal.candidateCheck(tx, intent),
  );
  if (!original?.candidate_sha || !original.tree_sha) return;
  const author = "assignment_id" in original;
  const check: CheckRequest = {
    kind: author ? "precheck" : "merge_check",
    ...(!author && (original.level === "card" || original.level === "batch")
      ? { mergeTier: original.level }
      : {}),
    project: intent.project,
    attempt: intent.attempt,
    sha: original.candidate_sha,
    tree: original.tree_sha,
    checks:
      settings.status === "enabled"
        ? requestChecks(
            settings,
            author ? undefined : original.scope,
            !author && original.level === "batch" ? "batch" : "card",
          )
        : [],
    env: settings.status === "enabled" ? settings.env : {},
  };
  return {
    check,
    delivery: author ? original.assignment_id : original.completion_id,
  };
}

/** A normal return from runs() means the fixed time window was exhaustively enumerated. */
export async function discoverUnboundGithub(o: {
  client: Pick<GithubClient, "runs">;
  journal: GithubDispatchJournal;
  intent: GithubDispatchIntent;
  key: string;
  inputs: Readonly<Record<string, string>>;
  branch: string;
  config: GithubMergeGateExecutor;
  scanStarted: number;
  signal?: AbortSignal | undefined;
  finishAs?: "automatic" | "human" | undefined;
}): Promise<readonly GithubRun[] | undefined> {
  const { intent, scanStarted, signal, finishAs } = o;
  if (o.key !== intent.key) throw new GithubExecutorError("security");
  const deadline =
    intent.discoveryDeadlineAt ??
    Date.parse(intent.startedAt) +
      (o.config.waitStartMs ?? GITHUB_POLL_DEFAULTS.waitStartMs);
  const eligible =
    finishAs && canFinishUndispatched(intent, scanStarted, deadline);
  if (finishAs === "human" && !eligible)
    throw new GithubExecutorError("recovery_incomplete");
  const listed = await o.client.runs(o.branch, intent.startedAt, signal);
  if (signal?.aborted) throw new GithubExecutorError("recovery_incomplete");
  const matches = listed.filter(
    (run) => run.display_title === githubCheckRunName(o.inputs),
  );
  if (eligible && !matches.length) {
    // A missing/unevaluated title from our bot could still be this dispatch.
    if (
      listed.some(
        (run) =>
          !run.actor?.login ||
          (run.actor.login === o.config.botLogin &&
            !/^cardigan\/[\w-]+\/[\w-]+\/[\w-]+\/(precheck|merge_check)\/[a-f0-9]{40}\/[a-f0-9]{40}$/u.test(
              run.display_title,
            )),
      )
    )
      throw new GithubExecutorError("recovery_incomplete");
    o.journal.finishUndispatched(
      intent,
      scanStarted,
      deadline,
      listed.length,
      finishAs,
    );
    return undefined;
  }
  return matches;
}

/** Offline assertions/flags cannot authorize settlement. The CLI uses the same online proof as maintenance. */
export async function verifyUndispatched(
  store: Store,
  journal: GithubDispatchJournal,
  intent: GithubDispatchIntent,
  settings: ProjectMergeGate,
  config: GithubMergeGateExecutor,
  branch: string,
  client: Pick<GithubClient, "runs">,
) {
  const current = journal.recoverAbandoned(intent);
  const request = abandonedGithubRequest(store, journal, current, settings);
  if (!request) throw new GithubExecutorError("security");
  const context = {
    card: current.card,
    delivery: request.delivery,
    baselineBranch: branch,
  };
  const identity = githubDispatchIdentity(
    githubScopedRequest(request.check, config.scopedChecks === true),
    context,
    config,
    current.key,
  );
  const matches = await discoverUnboundGithub({
    client,
    journal,
    intent: current,
    ...identity,
    branch,
    config,
    scanStarted: Date.now(),
    finishAs: "human",
  });
  if (matches) throw new GithubExecutorError("recovery_incomplete");
}
