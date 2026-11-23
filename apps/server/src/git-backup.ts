import { isDeepStrictEqual } from "node:util";
import { type Assignment, type ProjectId, parseId } from "@cardigan/domain";
import type {
  CentralProject,
  CentralRepositoryService,
  RepositoryLock,
} from "@cardigan/git-service";
import type { Store, StoreTransactionContext } from "@cardigan/store";

export const backupWriter = (a: Assignment) =>
  a.scope === "work_item" &&
  a.status === "active" &&
  !!a.branch &&
  !!a.worktree_path;

type Job = { assignment: Assignment } | { excludedBranches: readonly string[] };

/** One independent capture. No remote operation (including source resolution)
 * is inside the shared lock. Only the CAS and its evidence are serialized. */
export async function backupBranches(
  input: {
    project: CentralProject;
    currentProject: () => CentralProject | undefined;
    central: CentralRepositoryService;
    validateTarget?: (tx?: StoreTransactionContext) => void;
    lock: RepositoryLock;
    uow: Store["uow"];
  },
  job: Job,
) {
  const { project, central, uow } = input;
  const id = project.project_id as ProjectId;
  const a = "assignment" in job ? job.assignment : undefined;
  const machine = a?.machine_id ?? "local";
  const branch = a?.branch;
  if (
    a &&
    (!parseId("assignment", a.id).ok ||
      !backupWriter(a) ||
      !branch?.startsWith("agent/") ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(machine))
  )
    throw new Error("Invalid backup Assignment");
  const prefix = `refs/cardigan/backups/${machine}/`;
  const optionalSource = !a && (await central.backupSource(project, machine));
  if (!a && !optionalSource) return;
  const repository = await central.ensureCentral(project);
  const source =
    optionalSource || (await central.agentSource(project, machine));
  const transaction = await central.git.prepareBranchBackup(
    repository,
    source.address,
    {
      machine,
      ...(branch ? { branch } : {}),
      excludedBranches: "excludedBranches" in job ? job.excludedBranches : [],
      ...(source.uploadPack ? { uploadPack: source.uploadPack } : {}),
    },
  );
  const edits = transaction.refs;
  if (a && (edits.length !== 1 || edits[0]?.ref !== prefix + branch))
    throw new Error("Missing staged Assignment branch");
  if (!edits.length) return;
  const key = { project_id: id, repository, operation: "branch_backup" };
  return input.lock(key, async () => {
    let published = false;
    const commit = (tx: StoreTransactionContext) => {
      const currentProject = input.currentProject();
      if (
        currentProject?.source_repo !== project.source_repo ||
        currentProject.base_branch !== project.base_branch
      )
        throw new Error("Backup project changed");
      input.validateTarget?.(tx);
      if (a) {
        const cur = tx.assignments.get(id, a.id);
        if (
          !cur ||
          !backupWriter(cur) ||
          cur.work_item_id !== a.work_item_id ||
          cur.machine_id !== machine ||
          cur.branch !== branch ||
          cur.worktree_path !== a.worktree_path ||
          !isDeepStrictEqual(cur.runtime_ref, a.runtime_ref)
        )
          throw new Error("Backup Assignment changed");
      } else {
        const bound = new Set(
          tx.assignments
            .list(id)
            .filter(
              (owner) => owner.machine_id === machine && backupWriter(owner),
            )
            .map((owner) => prefix + owner.branch),
        );
        if (edits.some((e) => bound.has(e.ref)))
          throw new Error("Backup branch acquired an Assignment");
      }
      transaction.publish();
      published = true;
      const tip = edits[0];
      if (a && branch && tip)
        tx.events.append(id, {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(id, undefined),
          actor: { kind: "system", project_id: id },
          type: "assignment_branch_backed_up",
          payload: {
            assignment_id: a.id,
            machine_id: machine,
            branch,
            sha: tip.sha,
            ref: tip.ref,
          },
          created_at: new Date().toISOString(),
        });
    };
    try {
      uow.run(commit);
      return a ? edits[0] : undefined;
    } catch (error) {
      if (published) transaction.rollback();
      throw error;
    }
  });
}
