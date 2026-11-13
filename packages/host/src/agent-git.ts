import { randomUUID } from "node:crypto";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { GitWorktreePort } from "@cardigan/domain";
import {
  CentralGitTransport,
  type GitTimeoutOptions,
  gitSafetyArguments,
  LocalGitTransport,
  withGitTimeout,
} from "@cardigan/git-transport";
import {
  type AgentExecution,
  agentReceivePack,
  prepareAgentProject,
} from "@cardigan/runtime-herdr";

const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;
export type AgentGitRunner = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<string>;
export interface AgentGitOptions extends GitTimeoutOptions {
  /** Observation only: all host calls still execute real Git in the center. */
  readonly onHostCommand?: (cwd: string, args: readonly string[]) => void;
}

/** Host reads only the central repository; all mutable workspace Git runs as agent. */
export class AgentGitTransport implements GitWorktreePort {
  private readonly commands: LocalGitTransport;
  private readonly repository: string;
  private readonly worktree: string;
  /** P2a-3: the verifier's writable build checkout of the same Assignment. */
  private readonly build: string;
  private readonly inputs: string;
  constructor(
    private readonly config: AgentExecution,
    private readonly project: string,
    private readonly assignment: string,
    private readonly run: AgentGitRunner,
    private readonly options: AgentGitOptions = {},
  ) {
    this.repository = join(config.agentRoot, "repos", project);
    this.worktree = join(config.agentRoot, "worktrees", project, assignment);
    this.build = join(config.agentRoot, "builds", project, assignment);
    this.inputs = join(config.agentRoot, "inputs", project);
    this.commands = new LocalGitTransport("git", options, {
      run: (args, timeout) =>
        this.run(
          [
            "-c",
            `safe.directory=${this.repository}`,
            "-c",
            `safe.directory=${this.worktree}`,
            "-c",
            `safe.directory=${this.build}`,
            ...args,
          ],
          timeout,
        ),
      prepareWorktree: async (path) => {
        this.placement(path);
        await this.leaf(path);
      },
    });
  }
  private exact(actual: string, expected: string) {
    if (resolve(actual) !== expected)
      throw new Error("Unexpected Agent Git path");
  }
  /** Worktree placement may only target this Assignment's two leaves. */
  private placement(actual: string) {
    if (![this.worktree, this.build].includes(resolve(actual)))
      throw new Error("Unexpected Agent Git path");
  }
  private async prepare() {
    await prepareAgentProject(this.config, this.project, this.assignment);
  }
  private async leaf(path: string) {
    // Its namespace parent is host-owned 2750, so agent cannot replace this leaf.
    await mkdir(path, { mode: 0o700 });
    await chown(path, process.getuid?.() ?? -1, this.config.gid);
    await chmod(path, 0o2770);
  }
  private async checkLeaf(path: string) {
    const s = await lstat(path);
    if (
      !s.isDirectory() ||
      s.uid !== process.getuid?.() ||
      s.gid !== this.config.gid ||
      (s.mode & 0o7777) !== 0o2770
    )
      throw new Error("Unsafe Agent repository directory");
  }
  private async source(path: string) {
    if (!isAbsolute(path))
      throw new Error("Git source must be an absolute local repository path");
    const source = await realpath(path);
    const root = `${this.config.agentRoot}/`;
    if (source === this.config.agentRoot || source.startsWith(root))
      throw new Error("Host Git source must not be in the Agent workspace");
    const metadata = join(this.inputs, "source.path");
    try {
      await writeFile(metadata, source, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
    }
    if ((await readFile(metadata, "utf8")) !== source)
      throw new Error(
        "Existing clone does not belong to this local source; rebuild it from the central repository",
      );
    return source;
  }
  private host(source: string) {
    return new CentralGitTransport({
      ...this.options,
      dataDir: this.config.dataDir,
      centralRoot: dirname(source),
      agentRoot: this.config.agentRoot,
      ...(this.options.onHostCommand
        ? { onCommand: this.options.onHostCommand }
        : {}),
    });
  }
  private async push(source: string, target: string) {
    await this.host(source).pushBaseline(
      source,
      target,
      await agentReceivePack(this.config, target),
    );
  }
  private git(args: readonly string[]) {
    const directory = args[0] === "-C" ? args[1] : undefined;
    return withGitTimeout(args[directory ? 2 : 0], this.options, (timeout) =>
      this.run(
        [
          ...(directory ? ["-c", `safe.directory=${directory}`] : []),
          ...gitSafetyArguments,
          ...args,
        ],
        timeout,
      ),
    );
  }
  async ensureClone(source: string, directory: string) {
    await this.prepare();
    this.exact(directory, this.repository);
    const local = await this.source(source);
    let exists = true;
    try {
      await this.checkLeaf(directory);
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
      exists = false;
    }
    const bundle = join(this.inputs, "source.bundle");
    if (!exists) {
      const stage = join(
        this.config.agentRoot,
        "repos",
        `.clone-${randomUUID()}`,
      );
      await this.leaf(stage);
      try {
        const format = await this.host(local).objectFormat(local);
        await this.git([
          "init",
          `--object-format=${format}`,
          "--shared=0660",
          "--",
          stage,
        ]);
        await this.git(["-C", stage, "config", "remote.origin.url", local]);
        await this.push(local, stage);
        try {
          await rename(stage, directory);
        } catch (error) {
          if (!["EEXIST", "ENOTEMPTY"].includes(errno(error) ?? ""))
            throw error;
          await this.checkLeaf(directory);
        }
      } finally {
        // Never recursively traverse Agent-controlled files as the host. Nonempty failed
        // staging clones remain for explicit M4 cleanup; they contain code, no credentials.
        await rmdir(stage).catch((error) => {
          if (!["ENOENT", "ENOTEMPTY"].includes(errno(error) ?? ""))
            throw error;
        });
      }
    }
    await this.checkLeaf(directory);
    const origin = (
      await this.git(["-C", directory, "config", "--get", "remote.origin.url"])
    ).trim();
    if (
      (
        await this.git(["-C", directory, "rev-parse", "--show-toplevel"])
      ).trim() !== directory ||
      // Existing center-based bundle clones can receive incremental updates too.
      ![local, bundle].includes(origin)
    )
      throw new Error("Existing Agent clone has an unexpected origin");
  }
  async fetch(repository: string, source: string) {
    await this.prepare();
    this.exact(repository, this.repository);
    await this.checkLeaf(repository);
    await this.push(await this.source(source), repository);
  }

  async resolveCommit(repository: string, ref: string) {
    this.exact(repository, this.repository);
    return this.commands.resolveCommit(repository, ref);
  }
  async listWorktrees(repository: string) {
    this.exact(repository, this.repository);
    return this.commands.listWorktrees(repository);
  }
  async addWorktree(
    repository: string,
    path: string,
    head: string,
    branch?: string,
  ) {
    await this.prepare();
    this.exact(repository, this.repository);
    this.placement(path);
    // A build checkout is always detached: it must never own a branch.
    if (branch !== undefined && resolve(path) !== this.worktree)
      throw new Error("Build checkout must be detached");
    return this.commands.addWorktree(repository, path, head, branch);
  }
  async isDirty(path: string) {
    this.exact(path, this.worktree);
    return this.commands.isDirty(path);
  }
  async checkoutDetached(path: string, head: string) {
    this.exact(path, this.worktree);
    return this.commands.checkoutDetached(path, head);
  }
  /** §3.4: status and diff read Agent-writable files, so the Agent runs them. */
  async changes(path: string) {
    this.exact(path, this.worktree);
    return this.commands.changes(path);
  }
  async diffHead(path: string) {
    this.exact(path, this.worktree);
    return this.commands.diffHead(path);
  }
  /** C-211: only this Assignment's build checkout, never its write worktree. */
  async cleanBuildCheckout(repository: string, path: string) {
    await this.prepare();
    this.exact(repository, this.repository);
    this.exact(path, this.build);
    return this.commands.cleanBuildCheckout(repository, path);
  }
  async removeWorktree(
    repository: string,
    path: string,
    options: { readonly force: boolean },
  ) {
    await this.prepare();
    this.exact(repository, this.repository);
    this.placement(path);
    return this.commands.removeWorktree(repository, path, options);
  }
  async deleteBranch(repository: string, branch: string) {
    await this.prepare();
    this.exact(repository, this.repository);
    return this.commands.deleteBranch(repository, branch);
  }
}
