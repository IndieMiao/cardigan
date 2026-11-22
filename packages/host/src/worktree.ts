import type {
  Assignment,
  Card,
  DecisionId,
  ProjectId,
  Role,
  Runtime,
  WorkItem,
} from "@cardigan/domain";
import { pauseDiscussionFor } from "@cardigan/domain";
import {
  CentralRepositoryService,
  GitWorktreeService,
} from "@cardigan/git-service";
import {
  CentralGitTransport,
  LocalGitTransport,
} from "@cardigan/git-transport";
import {
  agentCommandError,
  type ExecutionConfig,
  executionPaths,
  type HerdrRuntime,
} from "@cardigan/runtime-herdr";
import type { ReadRepositories, Store } from "@cardigan/store";
import { AgentGitTransport } from "./agent-git.js";
import { launchEntities } from "./commands.js";
import { withPreparationQueue } from "./preparation-queue.js";
import { hostRepositoryLock } from "./repository-lock.js";
import { RuntimeTargets } from "./runtime-targets.js";
import { WorkerGitTransport } from "./worker-git.js";
/** The host-owned placement passed to launch and persisted by dispatchRun. */
export interface PreparedWorktree {
  readonly path: string;
  readonly review_plan?: DecisionId;
  readonly branch?: string | undefined;
  readonly base_sha: string;
  readonly baseline?: { readonly ref: string; readonly sha: string };
  /** P2a-3: a readonly verifier's writable build checkout of the same delivery. */
  readonly build?: { readonly path: string; readonly sha: string };
}

/** Host facts the Agent needs on every start or wake: baseline and build checkout. */
export function worktreeBaselinePrompt(
  worktree?: PreparedWorktree,
): string | undefined {
  const baseline = worktree?.baseline,
    build = worktree?.build;
  const lines = [
    baseline
      ? `当前基线 ${baseline.ref}：${baseline.sha}（已由主机同步）。`
      : undefined,
    worktree?.review_plan
      ? `本次只确认 ${worktree.review_plan} 的方案方向。只读检出是项目基线，不是待审交付；请在卡上回复方案。`
      : undefined,
    build === undefined
      ? undefined
      : `可写构建目录：${build.path}（交付 ${build.sha} 的全新独立检出，可安装依赖、构建和跑测试；只读 worktree 保持不动。本次 Run 结束后主机会删除它，里面的改动不会保留，也不会被拉取、交付或合并）。`,
  ].filter((line): line is string => line !== undefined);
  return lines.length ? lines.join("\n") : undefined;
}

export interface WorktreeRequest {
  readonly project_id: ProjectId;
  readonly source_repo: string;
  readonly assignment: Assignment;
  readonly role: Role;
  readonly card?: Card | undefined;
  readonly work_item?: WorkItem | undefined;
  readonly target_sha?: string;
  readonly review_plan?: DecisionId;
}
export type WorktreeProvider = (
  request: WorktreeRequest,
) => Promise<PreparedWorktree | undefined>;
type AgentRuntime = Runtime & Partial<Pick<HerdrRuntime, "captureAgent">>;

/** Select the current delivery from persisted facts, never from a stale bell. */
export function reviewTargetSha(
  store: Store,
  project: ProjectId,
  item?: WorkItem,
): string {
  return store.uow.read((tx) => {
    const sha = currentDeliverySha(tx, project, item);
    if (!sha)
      throw new Error(
        `No current Git delivery for readonly work item ${item?.id}`,
      );
    return sha;
  });
}

function currentDeliverySha(
  tx: ReadRepositories,
  project: ProjectId,
  item?: WorkItem,
): string | undefined {
  if (item?.kind !== "verify")
    throw new Error("Readonly Assignment requires a verification work item");
  const delivery = tx.deliveries
    .list(project)
    .filter(
      (d) =>
        d.status !== "superseded" &&
        (item.target_work_item_id
          ? d.work_item_id === item.target_work_item_id &&
            d.kind !== "card_completion"
          : d.kind === "card_completion" &&
            d.requested_verifiers.includes(item.id)),
    )
    .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
  return delivery?.subject.kind === "git_head"
    ? delivery.subject.value
    : undefined;
}

/** A plan is a discussion target, never a substitute SHA for a formal review. */
export function readonlyWorktreeTarget(
  store: Store,
  project: ProjectId,
  assignment: Assignment,
): { work_item: WorkItem } & (
  | { target_sha: string }
  | { review_plan: DecisionId }
) {
  if (assignment.scope !== "work_item")
    throw new Error("Readonly Assignment requires its verification work item");
  return store.uow.read((tx) => {
    const current = tx.work_items.get(project, assignment.work_item_id);
    if (
      current?.kind !== "verify" ||
      current.assignment_id !== assignment.id ||
      current.status === "cancelled"
    )
      throw new Error(
        `Readonly Assignment no longer owns an active work item ${assignment.work_item_id}`,
      );
    if (current.review_plan_target)
      return { work_item: current, review_plan: current.review_plan_target };
    // A pause can also name a reviewer who still has a formal delivery to inspect.
    // Never substitute the baseline for that delivery. Without one, project the
    // current discussion target from the same read transaction for a readonly checkout.
    const sha = currentDeliverySha(tx, project, current);
    if (sha) return { work_item: current, target_sha: sha };
    const plan = pauseDiscussionFor(
      tx.decisions.list(project),
      assignment.id,
    )?.id;
    if (plan)
      return {
        work_item: { ...current, review_plan_target: plan },
        review_plan: plan,
      };
    throw new Error(
      `No current Git delivery for readonly work item ${current.id}`,
    );
  });
}

/** Shared by the CLI start and server start/wake paths; all Agent Git stays on its entry. */
export function worktreeProvider(
  defaultExecution: ExecutionConfig,
  runtime: AgentRuntime,
): WorktreeProvider {
  return async (request) =>
    withPreparationQueue(
      defaultExecution.dataDir,
      request.project_id,
      async () => {
        const { project_id, assignment } = request;
        const target =
          runtime instanceof RuntimeTargets
            ? runtime.forWorkspace(project_id, assignment)
            : undefined;
        const execution = target?.execution ?? defaultExecution;
        const machineId = execution.target?.machine_id ?? "local";
        if (
          machineId !== assignment.machine_id ||
          (execution.target && execution.target.project_id !== project_id) ||
          (defaultExecution.target &&
            machineId !== "local" &&
            defaultExecution.target.machine_id === machineId &&
            defaultExecution.target.fingerprint !==
              execution.target?.fingerprint) ||
          (target &&
            !request.role.required_machine_tags.every((tag) =>
              target.machine.tags.includes(tag),
            ))
        )
          throw new Error("Workspace target does not match Assignment");
        // The legacy agent-ssh transport assumes a shared disk. A remote
        // assignment can only use the host-driven worker Git helper.
        if (
          machineId !== "local" &&
          (execution.mode !== "agent-ssh" || !execution.gitHelper)
        )
          throw new Error(
            "Remote worktree requires a configured worker Git helper",
          );
        const dataDir = execution.dataDir;
        const transport =
          execution.mode === "local"
            ? new LocalGitTransport()
            : execution.gitHelper
              ? new WorkerGitTransport(execution, project_id, assignment.id, {
                  validateTarget: () => {
                    if (
                      runtime instanceof RuntimeTargets &&
                      runtime.forWorkspace(project_id, assignment).execution
                        .target?.fingerprint !== execution.target?.fingerprint
                    )
                      throw new Error("Workspace target configuration changed");
                  },
                })
              : new AgentGitTransport(
                  execution,
                  project_id,
                  assignment.id,
                  async (args, timeout) => {
                    if (!runtime.captureAgent)
                      throw new Error(
                        "agent-ssh worktree requires the Agent execution entry",
                      );
                    const result =
                      runtime instanceof RuntimeTargets
                        ? await runtime.captureFor(
                            project_id,
                            assignment,
                            "git",
                            args,
                            timeout,
                          )
                        : await runtime.captureAgent("git", args, timeout);
                    // Keep Git's exit status and stderr for failure classification.
                    if (!result.ok) throw agentCommandError(result.error);
                    return result.value;
                  },
                );
        const central = new CentralRepositoryService(
          new CentralGitTransport({
            dataDir,
            ...(execution.mode === "agent-ssh" && !execution.gitHelper
              ? { agentRoot: execution.agentRoot }
              : {}),
          }),
          { dataDir },
        );
        const service = new GitWorktreeService(transport, central, {
          dataDir,
          machineId,
          ...(transport instanceof WorkerGitTransport
            ? { files: transport.files }
            : {}),
          ...executionPaths(execution, project_id, assignment.id),
          lock: hostRepositoryLock(dataDir),
        });
        const placed = await service.ensureWorktree({
          project_id,
          source_repo: request.source_repo,
          assignment,
          role: request.role,
          ...(request.card ? { card: request.card } : {}),
          ...(request.work_item ? { work_item: request.work_item } : {}),
          ...(request.review_plan ? { review_plan: request.review_plan } : {}),
          ...(request.target_sha ? { target_sha: request.target_sha } : {}),
        });
        if (!placed) return undefined;
        // P2a-3: a readonly verifier also gets a writable checkout of the same SHA.
        // A failure is a preparation failure like the readonly worktree's: the
        // caller retries, reports the error and escalates (§12.4).
        const build =
          request.role.worktree === "readonly" && request.target_sha
            ? await service.ensureBuildCheckout({
                project_id,
                source_repo: request.source_repo,
                assignment,
                role: request.role,
                ...(request.card ? { card: request.card } : {}),
                ...(request.work_item ? { work_item: request.work_item } : {}),
                target_sha: request.target_sha,
              })
            : undefined;
        return {
          path: placed.worktree_path,
          base_sha: placed.base_sha,
          ...(request.review_plan ? { review_plan: request.review_plan } : {}),
          ...(placed.baseline ? { baseline: placed.baseline } : {}),
          ...(placed.branch ? { branch: placed.branch } : {}),
          ...(build ? { build } : {}),
        };
      },
    );
}

/**
 * The worktree this Role needs when a launch did not pass one.
 *
 * `cardigan assignment start` prepares its own (it owns the human's placement
 * choice), but the Dispatcher only has the Run and the bell, so the host
 * prepares what the Role asks for: nothing for `none`, the write worktree and
 * branch for a coder, and the current delivery SHA for a readonly reviewer
 * (M5.S S7).
 */
export async function prepareRoleWorktree(
  host: { store: Store; execution: ExecutionConfig; runtime: AgentRuntime },
  project: ProjectId,
  assignment: Assignment["id"],
): Promise<PreparedWorktree | undefined> {
  const entities = launchEntities(host.store, project, assignment);
  // A standing Assignment owns no work item, so it never gets a worktree even
  // when the role is readonly (M5.S S13): only a work-item PM acceptance reads
  // the completion's SHA.
  if (
    entities.role.worktree === "none" ||
    entities.assignment.scope !== "work_item" ||
    !entities.card?.repo
  )
    return undefined;
  const source = host.store.getProject(project)?.repo_path;
  if (!source)
    throw new Error(`Project ${project} has no registered repository`);
  return worktreeProvider(
    host.execution,
    host.runtime,
  )({
    project_id: project,
    source_repo: source,
    ...entities,
    ...(entities.role.worktree === "readonly"
      ? readonlyWorktreeTarget(host.store, project, entities.assignment)
      : { work_item: entities.workItem }),
  });
}

/** Only a readonly reviewer needs its worktree refreshed before every wake. */
export async function prepareReadonlyWorktree(
  host: { store: Store; execution: ExecutionConfig; runtime: AgentRuntime },
  project: ProjectId,
  assignment: Assignment["id"],
): Promise<PreparedWorktree | undefined> {
  const entities = launchEntities(host.store, project, assignment);
  if (entities.role.worktree !== "readonly") return undefined;
  return prepareRoleWorktree(host, project, assignment);
}
