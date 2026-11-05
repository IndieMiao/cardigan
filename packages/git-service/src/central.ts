import { join, resolve } from "node:path";
import type { GitCentralPort } from "@cardigan/domain";
export interface CentralProject {
  readonly project_id: string;
  readonly source_repo: string;
  readonly base_branch: string;
}
export interface CentralOptions {
  readonly dataDir: string;
  readonly centralRoot?: string;
}
export type SourceSync = "fast_forwarded" | "up_to_date" | "ahead" | "diverged";
/** Ref policy lives here; filesystem and Git execution stay behind the domain port. */
export class CentralRepositoryService {
  private readonly root: string;
  constructor(
    readonly git: GitCentralPort,
    options: CentralOptions,
  ) {
    this.root = resolve(
      options.centralRoot ?? join(options.dataDir, "central"),
    );
  }
  async ensureCentral(project: CentralProject): Promise<string> {
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u.test(project.project_id))
      throw new Error("Invalid project path component");
    const repository = join(this.root, `${project.project_id}.git`);
    await this.git.ensureBare(project.source_repo, repository);
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
}
