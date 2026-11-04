import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { GitWorktree, GitWorktreePort } from "@cardigan/domain";

const exec = promisify(execFile);
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Execute workspace Git as the workspace owner (for isolated Agent accounts). */
export interface WorkspaceGit {
  run(args: readonly string[]): Promise<string>;
  prepareWorktree?(path: string): Promise<void>;
}

/** All fetches use a verified local path, never a configured network remote. */
export class LocalGitTransport implements GitWorktreePort {
  constructor(
    private readonly binary = "git",
    private readonly timeoutMs = 30000,
    private readonly workspace?: WorkspaceGit,
  ) {}
  private async git(repository: string | undefined, args: string[]) {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    for (const key of Object.keys(env))
      if (key.startsWith("GIT_") && key !== "GIT_TERMINAL_PROMPT")
        delete env[key];
    const command = [
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.file.allow=always",
      "-c",
      "core.hooksPath=/dev/null",
      ...(repository ? ["-C", repository] : []),
      ...args,
    ];
    if (this.workspace) return (await this.workspace.run(command)).trimEnd();
    const { stdout } = await exec(this.binary, command, {
      env,
      timeout: this.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trimEnd();
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
      throw new Error("Existing clone does not belong to this local source");
  }
  async fetch(repository: string, source: string): Promise<void> {
    const local = await this.source(source);
    await this.git(repository, [
      "fetch",
      "--no-tags",
      "--",
      local,
      "+refs/heads/*:refs/remotes/origin/*",
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
    if (await exists(path))
      throw new Error("Worktree path already exists outside this clone");
    await mkdir(dirname(path), { recursive: true });
    await this.workspace?.prepareWorktree?.(path);
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
  async isDirty(path: string): Promise<boolean> {
    return (
      (
        await this.git(path, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ])
      ).length > 0
    );
  }
}
