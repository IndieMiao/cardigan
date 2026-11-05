import { join, resolve } from "node:path";
import { type GitCentralPort, parseId } from "@cardigan/domain";
export interface CentralProject {
  readonly project_id: string;
  readonly source_repo: string;
  readonly base_branch: string;
}
export interface CentralOptions {
  readonly dataDir: string;
  readonly centralRoot?: string;
  readonly repositoriesRoot?: string;
  /** Host-supplied streaming entry; never an Agent-provided command. */
  readonly uploadPack?: (repository: string) => Promise<string>;
}
export type SourceSync = "fast_forwarded" | "up_to_date" | "ahead" | "diverged";
/** Ref policy lives here; filesystem and Git execution stay behind the domain port. */
export class CentralRepositoryService {
  private readonly root: string;
  constructor(
    readonly git: GitCentralPort,
    private readonly options: CentralOptions,
  ) {
    this.root = resolve(
      options.centralRoot ?? join(options.dataDir, "central"),
    );
  }
  async ensureCentral(project: CentralProject): Promise<string> {
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u.test(project.project_id))
      throw new Error("Invalid project path component");
    const repository = join(this.root, `${project.project_id}.git`);
    await this.git.ensureBare(
      project.source_repo,
      repository,
      `refs/heads/${project.base_branch}`,
    );
    if (
      !(await this.git.readRef(repository, `refs/heads/${project.base_branch}`))
    )
      throw new Error("Central baseline branch is missing");
    return repository;
  }
  async syncFromSource(project: CentralProject): Promise<SourceSync> {
    const repo = await this.ensureCentral(project),
      base = `refs/heads/${project.base_branch}`,
      source = `refs/cardigan/source/${project.base_branch}`;
    await this.git.fetchRefs(repo, project.source_repo, [`+${base}:${source}`]);
    const old = await this.git.readRef(repo, base),
      next = await this.git.readRef(repo, source);
    if (!old || !next)
      throw new Error("Baseline disappeared during synchronization");
    if (old === next) return "up_to_date";
    if (await this.git.isAncestor(repo, old, next)) {
      await this.git.compareAndSwapRef(repo, base, next, old);
      return "fast_forwarded";
    }
    return (await this.git.isAncestor(repo, next, old)) ? "ahead" : "diverged";
  }
  async agentSource(project: CentralProject) {
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u.test(project.project_id))
      throw new Error("Invalid project path component");
    const path = resolve(
      this.options.repositoriesRoot ??
        join(this.options.dataDir, "agent", "repos"),
      project.project_id,
    );
    return { path, uploadPack: await this.options.uploadPack?.(path) };
  }
  /** Only creates; same SHA is an idempotent success, including concurrent creation. */
  async createRef(repository: string, ref: string, sha: string) {
    const current = await this.git.readRef(repository, ref);
    if (current === sha) return;
    if (current)
      throw new Error("Immutable ref already points to a different SHA");
    try {
      await this.git.compareAndSwapRef(repository, ref, sha, null);
    } catch (error) {
      if ((await this.git.readRef(repository, ref)) !== sha) throw error;
    }
  }
  async pinDelivery(project: CentralProject, delivery_id: string, sha: string) {
    if (
      !parseId("delivery", delivery_id).ok ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sha)
    )
      throw new Error("Invalid delivery id or SHA");
    const repository = await this.ensureCentral(project);
    if (
      sha.length !==
        ((await this.git.objectFormat(repository)) === "sha1" ? 40 : 64) ||
      (await this.git.objectType(repository, sha)) !== "commit"
    )
      throw new Error("Delivery SHA is not a full commit id");
    await this.createRef(
      repository,
      `refs/cardigan/deliveries/${delivery_id}`,
      sha,
    );
  }
  async backupAgentBranches(project: CentralProject, machine_id: string) {
    if (machine_id !== "local")
      throw new Error("Only local machine backups are supported");
    const repository = await this.ensureCentral(project),
      source = await this.agentSource(project);
    await this.git.fetchRefs(
      repository,
      source.path,
      [`+refs/heads/agent/*:refs/cardigan/backups/${machine_id}/agent/*`],
      source.uploadPack,
    );
  }
}
