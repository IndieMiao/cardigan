import { dirname, posix, resolve } from "node:path";
import type { GitRepositoryAddress, GitWorkspaceFiles } from "@cardigan/domain";
import {
  CentralGitTransport,
  type GitTimeoutOptions,
  LocalGitTransport,
  withGitTimeout,
} from "@cardigan/git-transport";
import {
  type AgentExecution,
  type WorkerGitRequest,
  workerGit,
  workerGitPack,
} from "@cardigan/runtime-herdr";

export interface WorkerGitOptions extends GitTimeoutOptions {
  readonly validateTarget?: () => void;
  readonly onHostCommand?: (cwd: string, args: readonly string[]) => void;
}

/** Remote workspace IO never calls the host filesystem for worker paths. */
export class WorkerGitTransport extends LocalGitTransport {
  readonly files: GitWorkspaceFiles;
  readonly repository: string;
  private readonly machineId: string;
  private readonly request: Pick<WorkerGitRequest, "project" | "assignment">;
  constructor(
    private readonly config: AgentExecution,
    project: string,
    assignment: string,
    private readonly options: WorkerGitOptions = {},
  ) {
    const request = { project, assignment };
    const operation = <T>(
      input: Omit<WorkerGitRequest, "project" | "assignment" | "timeout_ms">,
    ) => {
      options.validateTarget?.();
      return withGitTimeout("status", options, (timeout_ms) =>
        workerGit<T>(config, { ...request, ...input, timeout_ms }),
      );
    };
    const files: GitWorkspaceFiles = {
      exists: (repository) =>
        operation<boolean>({ operation: "exists", repository }),
      isDirectory: (repository) =>
        operation<boolean>({ operation: "exists", repository }),
      directories: (repository) =>
        operation<readonly string[]>({ operation: "directories", repository }),
      prepareWorktree: (repository) =>
        operation<void>({ operation: "prepare", repository }),
      removeEmpty: (repository) =>
        operation<void>({ operation: "remove-empty", repository }),
    };
    super("git", options, {
      files,
      run: (args, timeout_ms) => {
        options.validateTarget?.();
        return workerGit<string>(config, {
          ...request,
          operation: "git",
          args,
          timeout_ms,
        });
      },
    });
    if (
      !config.target ||
      config.target.project_id !== project ||
      !config.gitHelper
    )
      throw new Error("Worker Git requires a trusted project target");
    this.machineId = config.target.machine_id;
    this.files = files;
    this.request = request;
    this.repository = posix.join(config.agentRoot, "repos", project);
  }
  private address(path: string): GitRepositoryAddress {
    this.options.validateTarget?.();
    return {
      kind: "worker-remote",
      path,
      root: this.config.agentRoot,
      project_id: this.request.project,
      machine_id: this.machineId,
    };
  }
  private check(repository: string) {
    this.options.validateTarget?.();
    if (repository !== this.repository)
      throw new Error("Unexpected worker repository");
  }
  private central(source: string) {
    return new CentralGitTransport({
      ...this.options,
      dataDir: this.config.dataDir,
      centralRoot: dirname(source),
      ...(this.options.onHostCommand
        ? { onCommand: this.options.onHostCommand }
        : {}),
    });
  }
  private async metadata(source: string) {
    if (
      source !==
      resolve(this.config.dataDir, "central", `${this.request.project}.git`)
    )
      throw new Error("Worker clone requires its registered private center");
    return {
      source: `cardigan-central:${this.request.project}`,
      format: await this.central(source).objectFormat(source),
    };
  }
  override async ensureClone(
    source: string,
    repository: string,
  ): Promise<void> {
    this.check(repository);
    const metadata = await this.metadata(source);
    await withGitTimeout("fetch", this.options, async (timeout_ms) => {
      const request = { ...this.request, ...metadata, timeout_ms };
      if (await this.files.exists(repository)) {
        await workerGit(this.config, {
          ...request,
          operation: "validate",
          repository,
        });
        return;
      }
      const stage = await workerGit<string>(this.config, {
        ...request,
        operation: "stage",
      });
      // A failed or disconnected stage is deliberately retained for controlled cleanup.
      await this.central(source).pushBaseline(
        source,
        this.address(stage),
        await workerGitPack(this.config, {
          ...request,
          operation: "receive-pack",
          repository: stage,
        }),
      );
      this.options.validateTarget?.();
      await workerGit(this.config, {
        ...request,
        operation: "publish",
        repository: stage,
      });
    });
    this.options.validateTarget?.();
  }
  override async fetch(repository: string, source: string): Promise<void> {
    this.check(repository);
    const metadata = await this.metadata(source);
    await withGitTimeout("fetch", this.options, async (timeout_ms) => {
      await this.central(source).pushBaseline(
        source,
        this.address(repository),
        await workerGitPack(this.config, {
          ...this.request,
          ...metadata,
          timeout_ms,
          operation: "receive-pack",
          repository,
        }),
      );
    });
    this.options.validateTarget?.();
  }
}
