import type {
  Assignment,
  Card,
  ProjectId,
  Role,
  Runtime,
  WorkItem,
} from "@cardigan/domain";
import {
  CentralRepositoryService,
  GitWorktreeService,
} from "@cardigan/git-service";
import {
  CentralGitTransport,
  LocalGitTransport,
} from "@cardigan/git-transport";
import {
  type ExecutionConfig,
  executionPaths,
  type HerdrRuntime,
} from "@cardigan/runtime-herdr";
import type { Store } from "@cardigan/store";
import { AgentGitTransport } from "./agent-git.js";
import { launchEntities } from "./commands.js";
/** The host-owned placement passed to launch and persisted by dispatchRun. */
export interface PreparedWorktree {
  readonly path: string;
  readonly branch?: string | undefined;
  readonly base_sha: string;
}

export interface WorktreeRequest {
  readonly project_id: ProjectId;
  readonly source_repo: string;
  readonly assignment: Assignment;
  readonly role: Role;
  readonly card?: Card | undefined;
  readonly work_item?: WorkItem | undefined;
  readonly target_sha?: string;
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
  if (item?.kind !== "verify")
    throw new Error("Readonly Assignment requires a verification work item");
  const delivery = store.uow
    .read((tx) => tx.deliveries.list(project))
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
  if (delivery?.subject.kind !== "git_head")
    throw new Error(
      `No current Git delivery for readonly work item ${item.id}`,
    );
  return delivery.subject.value;
}

/** Shared by the CLI start and server start/wake paths; all Agent Git stays on its entry. */
export function worktreeProvider(
  execution: ExecutionConfig,
  runtime: AgentRuntime,
): WorktreeProvider {
  return async (request) => {
    const { project_id, assignment } = request,
      dataDir = execution.dataDir;
    const transport =
      execution.mode === "local"
        ? new LocalGitTransport()
        : new AgentGitTransport(
            execution,
            project_id,
            assignment.id,
            async (args, timeout) => {
              if (!runtime.captureAgent)
                throw new Error(
                  "agent-ssh worktree requires the Agent execution entry",
                );
              const result = await runtime.captureAgent("git", args, timeout);
              if (!result.ok)
                throw new Error(
                  `${result.error.code}: ${result.error.message}`,
                );
              return result.value;
            },
          );
    const central = new CentralRepositoryService(
      new CentralGitTransport({
        dataDir,
        ...(execution.mode === "agent-ssh"
          ? { agentRoot: execution.agentRoot }
          : {}),
      }),
      { dataDir },
    );
    const service = new GitWorktreeService(transport, central, {
      dataDir,
      ...executionPaths(execution, project_id, assignment.id),
    });
    const placed = await service.ensureWorktree({
      project_id,
      source_repo: request.source_repo,
      assignment,
      role: request.role,
      ...(request.card ? { card: request.card } : {}),
      ...(request.work_item ? { work_item: request.work_item } : {}),
      ...(request.target_sha ? { target_sha: request.target_sha } : {}),
    });
    return (
      placed && {
        path: placed.worktree_path,
        base_sha: placed.base_sha,
        ...(placed.branch ? { branch: placed.branch } : {}),
      }
    );
  };
}

export async function prepareReadonlyWorktree(
  host: { store: Store; execution: ExecutionConfig; runtime: AgentRuntime },
  project: ProjectId,
  assignment: Assignment["id"],
): Promise<PreparedWorktree | undefined> {
  const entities = launchEntities(host.store, project, assignment);
  if (entities.role.worktree !== "readonly") return undefined;
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
    work_item: entities.workItem,
    target_sha: reviewTargetSha(host.store, project, entities.workItem),
  });
}
