import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { GitWorktreePort } from "@cardigan/domain";
import {
  gitEnvironment,
  gitSafetyArguments,
  LocalGitTransport,
} from "@cardigan/git-transport";
import {
  type AgentExecution,
  prepareAgentProject,
} from "@cardigan/runtime-herdr";

const exec = promisify(execFile);
const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;
export type AgentGitRunner = (args: readonly string[]) => Promise<string>;

/** Host reads only the central repository; all mutable workspace Git runs as agent. */
export class AgentGitTransport implements GitWorktreePort {
  private readonly commands: LocalGitTransport;
  private readonly repository: string;
  private readonly worktree: string;
  private readonly inputs: string;
  constructor(
    private readonly config: AgentExecution,
    private readonly project: string,
    private readonly assignment: string,
    private readonly run: AgentGitRunner,
  ) {
    this.repository = join(config.agentRoot, "repos", project);
    this.worktree = join(config.agentRoot, "worktrees", project, assignment);
    this.inputs = join(config.agentRoot, "inputs", project);
    this.commands = new LocalGitTransport("git", 30000, {
      run: (args) =>
        this.run([
          "-c",
          `safe.directory=${this.repository}`,
          "-c",
          `safe.directory=${this.worktree}`,
          ...args,
        ]),
      prepareWorktree: async (path) => {
        this.exact(path, this.worktree);
        await this.leaf(path);
      },
    });
  }
  private exact(actual: string, expected: string) {
    if (resolve(actual) !== expected)
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
  private async bundle(source: string) {
    // Build privately, then publish a read-only bundle under a protected parent.
    const stage = await mkdtemp(join(this.inputs, ".bundle-"));
    const path = join(stage, "source.bundle");
    const target = join(this.inputs, "source.bundle");
    try {
      const env = gitEnvironment();
      await exec(
        "git",
        [
          ...gitSafetyArguments,
          "-C",
          source,
          "bundle",
          "create",
          path,
          "--branches",
          "--glob=refs/cardigan/deliveries/*",
        ],
        {
          env: { ...env, GIT_TERMINAL_PROMPT: "0" },
          timeout: 30000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      await chown(path, process.getuid?.() ?? -1, this.config.gid);
      await chmod(path, 0o640);
      await rename(path, target);
      return target;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  private git(args: readonly string[]) {
    const directory = args[0] === "-C" ? args[1] : undefined;
    return this.run([
      ...(directory ? ["-c", `safe.directory=${directory}`] : []),
      ...gitSafetyArguments,
      ...args,
    ]);
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
      await this.bundle(local);
      const stage = join(
        this.config.agentRoot,
        "repos",
        `.clone-${randomUUID()}`,
      );
      await this.leaf(stage);
      try {
        await this.git([
          "clone",
          "--no-local",
          "--no-checkout",
          "--",
          bundle,
          stage,
        ]);
        await this.git([
          "-C",
          stage,
          "config",
          "core.sharedRepository",
          "0660",
        ]);
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
    if (
      (
        await this.git(["-C", directory, "rev-parse", "--show-toplevel"])
      ).trim() !== directory ||
      (
        await this.git([
          "-C",
          directory,
          "config",
          "--get",
          "remote.origin.url",
        ])
      ).trim() !== bundle
    )
      throw new Error("Existing Agent clone has an unexpected origin");
  }
  async fetch(repository: string, source: string) {
    await this.prepare();
    this.exact(repository, this.repository);
    await this.checkLeaf(repository);
    const bundle = await this.bundle(await this.source(source));
    await this.git([
      "-C",
      repository,
      "fetch",
      "--atomic",
      "--no-tags",
      "--",
      bundle,
      "+refs/heads/*:refs/remotes/origin/*",
      "+refs/cardigan/deliveries/*:refs/cardigan/deliveries/*",
    ]);
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
    this.exact(path, this.worktree);
    return this.commands.addWorktree(repository, path, head, branch);
  }
  async isDirty(path: string) {
    this.exact(path, this.worktree);
    return this.commands.isDirty(path);
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
  async removeWorktree(
    repository: string,
    path: string,
    options: { readonly force: boolean },
  ) {
    await this.prepare();
    this.exact(repository, this.repository);
    this.exact(path, this.worktree);
    return this.commands.removeWorktree(repository, path, options);
  }
  async deleteBranch(repository: string, branch: string) {
    await this.prepare();
    this.exact(repository, this.repository);
    return this.commands.deleteBranch(repository, branch);
  }
}
