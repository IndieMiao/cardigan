import { access, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  GitWorkspaceFiles,
  GitWorktree,
  GitWorktreeChanges,
  GitWorktreePort,
} from "@cardigan/domain";
import { gitEnvironment, gitSafetyArguments } from "./hardening.js";
import { localGitCommand } from "./local-command.js";
import { type GitTimeoutOptions, withGitTimeout } from "./timeouts.js";

export {
  type CentralGitOptions,
  CentralGitTransport,
  type FirstParentCommit,
  type TreeEntry,
} from "./central.js";
export { gitEnvironment, gitSafetyArguments } from "./hardening.js";
export {
  type GitTimeoutOptions,
  withGitTimeout,
  withMergeTransferBudget,
} from "./timeouts.js";

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Execute workspace Git as the workspace owner (for isolated Agent accounts). */
export interface WorkspaceGit {
  run(args: readonly string[], timeoutMs: number): Promise<string>;
  prepareWorktree?(path: string): Promise<void>;
  readonly files?: GitWorkspaceFiles;
}

/** All fetches use a verified local path, never a configured network remote. */
export class LocalGitTransport implements GitWorktreePort {
  constructor(
    private readonly binary = "git",
    private readonly timeouts: GitTimeoutOptions | number = {},
    private readonly workspace?: WorkspaceGit,
  ) {}
  private async git(repository: string | undefined, args: string[]) {
    const env = gitEnvironment();
    const command = [
      ...gitSafetyArguments,
      ...(repository ? ["-C", repository] : []),
      ...args,
    ];
    const options =
      typeof this.timeouts === "number"
        ? { queryTimeoutMs: this.timeouts, transferTimeoutMs: this.timeouts }
        : this.timeouts;
    return withGitTimeout(args[0], options, async (timeout) => {
      if (this.workspace)
        return (await this.workspace.run(command, timeout)).trimEnd();
      const stdout = await localGitCommand(this.binary, command, env, timeout);
      return stdout.trimEnd();
    });
  }
  private async source(path: string) {
    if (!isAbsolute(path))
      throw new Error("Git source must be an absolute local repository path");
    const source = await realpath(path);
    await this.git(source, ["rev-parse", "--git-dir"]);
    return source;
  }
  async ensureClone(source: string, directory: string): Promise<void> {
    const local = await this.source(source);
    if (!(await exists(directory))) {
      await mkdir(dirname(directory), { recursive: true });
      const temporary = await mkdtemp(join(dirname(directory), ".clone-"));
      try {
        await this.git(undefined, [
          "clone",
          "--no-local",
          "--no-checkout",
          "--",
          local,
          temporary,
        ]);
        try {
          await rename(temporary, directory);
        } catch (error) {
          if (!(await exists(directory))) throw error;
        }
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
    if (
      (await this.git(directory, ["rev-parse", "--show-toplevel"])) !==
        (await realpath(directory)) ||
      (await this.git(directory, ["config", "--get", "remote.origin.url"])) !==
        local
    )
      throw new Error(
        "Existing clone does not belong to this local source; rebuild it from the central repository",
      );
  }
  async fetch(repository: string, source: string): Promise<void> {
    const local = await this.source(source);
    await this.git(repository, [
      "fetch",
      "--atomic",
      "--no-tags",
      "--no-auto-maintenance",
      "--",
      local,
      "+refs/heads/*:refs/remotes/origin/*",
      "+refs/cardigan/deliveries/*:refs/cardigan/deliveries/*",
      "+refs/cardigan/candidates/*:refs/cardigan/candidates/*",
    ]);
  }
  async resolveCommit(repository: string, ref: string): Promise<string> {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(ref))
      await this.git(repository, ["check-ref-format", ref]);
    return this.git(repository, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ]);
  }
  async listWorktrees(repository: string): Promise<readonly GitWorktree[]> {
    const raw = await this.git(repository, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    return raw
      .split("\0\0")
      .filter(Boolean)
      .map((entry) => {
        const fields = entry.split("\0");
        const get = (prefix: string) =>
          fields.find((line) => line.startsWith(prefix))?.slice(prefix.length);
        const path = get("worktree "),
          head = get("HEAD "),
          branch = get("branch refs/heads/");
        if (!path || !head) throw new Error("Unsupported Git worktree record");
        return { path: resolve(path), head, ...(branch ? { branch } : {}) };
      });
  }
  async addWorktree(
    repository: string,
    path: string,
    head: string,
    branch?: string,
  ): Promise<void> {
    if (await (this.workspace?.files?.exists(path) ?? exists(path)))
      throw new Error("Worktree path already exists outside this clone");
    if (this.workspace?.files) await this.workspace.files.prepareWorktree(path);
    else {
      await mkdir(dirname(path), { recursive: true });
      await this.workspace?.prepareWorktree?.(path);
    }
    if (branch) {
      await this.git(repository, ["check-ref-format", "--branch", branch]);
      const branches = await this.git(repository, [
        "for-each-ref",
        "--format=%(refname)",
        `refs/heads/${branch}`,
      ]);
      if (
        branches.split("\n").includes(`refs/heads/${branch}`) &&
        (await this.resolveCommit(repository, `refs/heads/${branch}`)) !== head
      )
        throw new Error(
          "Existing branch does not match the requested baseline",
        );
      await this.git(
        repository,
        branches.split("\n").includes(`refs/heads/${branch}`)
          ? ["worktree", "add", "--", path, branch]
          : ["worktree", "add", "-b", branch, "--", path, head],
      );
    } else
      await this.git(repository, [
        "worktree",
        "add",
        "--detach",
        "--",
        path,
        head,
      ]);
  }
  async changes(path: string): Promise<GitWorktreeChanges> {
    // -z keeps paths literal (no quoting) and separates rename pairs with NUL.
    const fields = (
      await this.git(path, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ])
    ).split("\0");
    const tracked: string[] = [],
      untracked: string[] = [];
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index];
      if (!field) continue;
      const code = field.slice(0, 2),
        name = field.slice(3);
      // A rename or copy entry carries the original path as the next field.
      if (code.startsWith("R") || code.startsWith("C")) index += 1;
      if (code === "??") untracked.push(name);
      else tracked.push(name);
    }
    return { tracked, untracked };
  }
  async isDirty(path: string): Promise<boolean> {
    const changes = await this.changes(path);
    return changes.tracked.length + changes.untracked.length > 0;
  }
  async checkoutDetached(path: string, head: string): Promise<void> {
    const target = await this.resolveCommit(path, head);
    const registered = (await this.listWorktrees(path)).find(
      (w) => w.path === resolve(path),
    );
    if (!registered || registered.branch)
      throw new Error("Review workspace must be detached");
    if ((await this.changes(path)).tracked.length > 0)
      throw new Error("Review worktree has uncommitted changes");
    await this.git(path, [
      "checkout",
      "--detach",
      "--no-overwrite-ignore",
      target,
      "--",
    ]);
  }
  async diffHead(path: string): Promise<string> {
    return this.git(path, ["diff", "HEAD", "--"]);
  }
  async cleanBuildCheckout(repository: string, path: string): Promise<void> {
    const target = resolve(path);
    if (
      !(await this.listWorktrees(repository)).some(
        (worktree) => worktree.path === target,
      )
    )
      throw new Error("Worktree is not registered in this clone");
    // Never let Git pick an enclosing repository: clean only at the top level.
    const top = await this.git(target, ["rev-parse", "--show-toplevel"]);
    if (resolve(top) !== target)
      throw new Error("Build checkout is not a worktree top level");
    await this.git(target, ["clean", "-ffdxq", "--", "."]);
  }
  async removeWorktree(
    repository: string,
    path: string,
    options: { readonly force: boolean },
  ): Promise<void> {
    const registered = (await this.listWorktrees(repository)).some(
      (worktree) => worktree.path === resolve(path),
    );
    if (!registered)
      throw new Error("Worktree is not registered in this clone");
    await this.git(repository, [
      "worktree",
      "remove",
      ...(options.force ? ["--force"] : []),
      "--",
      path,
    ]);
  }
  async deleteBranch(repository: string, branch: string): Promise<void> {
    await this.git(repository, ["check-ref-format", "--branch", branch]);
    // Deletion is force-only: the service has already backed the commits up.
    await this.git(repository, ["branch", "-D", branch]);
  }
}

export {
  type CandidateDeleteRequest,
  candidateDeleteCommand,
} from "./candidate-delete.js";
export {
  type CandidatePushRequest,
  candidatePushCommand,
} from "./candidate-push.js";
export {
  classifyPushFailure,
  mergePushCommand,
  type PushFailure,
  type PushRequest,
  type PushResult,
} from "./merge-push.js";
