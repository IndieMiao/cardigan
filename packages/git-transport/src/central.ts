import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  GitCentralPort,
  GitCommitTreeInput,
  GitRef,
  GitTreeMerge,
} from "@cardigan/domain";
import { gitEnvironment, gitSafetyArguments } from "./hardening.js";
import {
  classifyPushFailure,
  mergePushCommand,
  type PushRequest,
  type PushResult,
} from "./merge-push.js";
import { type GitTimeoutOptions, withGitTimeout } from "./timeouts.js";

const exec = promisify(execFile);
const exists = async (path: string) => {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
};
/** A normalized `<root>/repos/<name>` path; no resolution on this disk. */
const executorTarget = (root: string, target: string) =>
  posix.isAbsolute(root) &&
  posix.normalize(root) === root &&
  root !== "/" &&
  !root.endsWith("/") &&
  posix.isAbsolute(target) &&
  posix.normalize(target) === target &&
  posix.dirname(target) === posix.join(root, "repos") &&
  /^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u.test(posix.basename(target));
const within = (root: string, path: string) =>
  path === root || path.startsWith(root + sep);
const fullSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const conflictRecord = /^[0-7]{6} [a-f0-9]+ [1-3]\t/u;
export interface FirstParentCommit {
  readonly sha: string;
  readonly parent?: string;
  readonly author: string;
  readonly committer: string;
  readonly subject: string;
}
export interface CentralGitOptions extends GitTimeoutOptions {
  dataDir: string;
  centralRoot?: string;
  agentRoot?: string;
  /** Observation only; tests still execute real Git. */
  onCommand?: (cwd: string, args: readonly string[]) => void;
}
/** Host Git never executes inside the source or an Agent repository. */
export class CentralGitTransport implements GitCentralPort {
  readonly root: string;
  constructor(private readonly options: CentralGitOptions) {
    this.root = resolve(
      options.centralRoot ?? join(options.dataDir, "central"),
    );
    if (options.agentRoot && within(resolve(options.agentRoot), this.root))
      throw new Error("Central root must be outside the Agent workspace");
  }
  private async privateDirectory(path: string) {
    for (let parent = dirname(path); ; parent = dirname(parent)) {
      const entry = await lstat(parent);
      if (
        !entry.isDirectory() ||
        ![0, process.getuid?.()].includes(entry.uid) ||
        (entry.mode & 0o022 && !(entry.mode & 0o1000))
      )
        throw new Error("Central path has an untrusted writable ancestor");
      if (parent === dirname(parent)) break;
    }
    const s = await lstat(path);
    if (
      !s.isDirectory() ||
      s.uid !== process.getuid?.() ||
      s.mode & 0o077 ||
      (await realpath(path)) !== path
    )
      throw new Error(
        "Central directory must be host-owned, private and without symlinks",
      );
  }
  private async command(
    repository: string,
    args: string[],
    extraEnv: NodeJS.ProcessEnv = {},
  ) {
    if (repository !== this.root && dirname(repository) !== this.root)
      throw new Error("Git command escaped central root");
    await this.privateDirectory(this.root);
    await this.privateDirectory(repository);
    const command = [...gitSafetyArguments, "-C", repository, ...args];
    this.options.onCommand?.(repository, command);
    try {
      const r = await withGitTimeout(args[0], this.options, (timeout) =>
        exec("git", command, {
          env: { ...gitEnvironment(), ...extraEnv },
          timeout,
          killSignal: "SIGKILL",
          maxBuffer: 4 * 1024 * 1024,
        }),
      );
      return { code: 0, stdout: r.stdout.trimEnd(), stderr: r.stderr };
    } catch (error) {
      const e = error as {
        code?: number;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      };
      if (typeof e.code !== "number" || e.killed) throw error;
      return {
        code: e.code,
        stdout: e.stdout?.trimEnd() ?? "",
        stderr: e.stderr ?? "Git failed",
      };
    }
  }
  /** Explicit external publication: host center only, no ambient env or raw diagnostics. */
  async pushMergedCommit(
    repository: string,
    input: PushRequest,
  ): Promise<PushResult> {
    try {
      if (dirname(repository) !== this.root)
        throw new Error("Unexpected center");
      await this.privateDirectory(this.root);
      await this.privateDirectory(repository);
      if ((await this.objectType(repository, input.sha)) !== "commit")
        throw new Error("Missing commit");
      const command = mergePushCommand(repository, input);
      const outcome = await withGitTimeout(
        "push",
        this.options,
        async (timeout) => {
          try {
            await exec("git", command.args, {
              env: command.env,
              timeout,
              killSignal: "SIGKILL",
              maxBuffer: 1024 * 1024,
              ...(input.signal ? { signal: input.signal } : {}),
            });
            return { status: "pushed" } as const;
          } catch (error) {
            const e = error as {
              stdout?: string;
              stderr?: string;
              killed?: boolean;
              name?: string;
            };
            return {
              status: "failed",
              reason: classifyPushFailure(
                `${e.stdout ?? ""}\n${e.stderr ?? ""}`,
                e.killed || e.name === "AbortError",
              ),
            } as const;
          }
        },
      );
      return outcome;
    } catch {
      return { status: "failed", reason: "other" };
    }
  }
  private async checked(
    repository: string,
    args: string[],
    extraEnv: NodeJS.ProcessEnv = {},
  ) {
    const r = await this.command(repository, args, extraEnv);
    // execFile-shaped, so callers can classify by exit status and stderr.
    if (r.code !== 0)
      throw Object.assign(new Error(r.stderr || "Git command failed"), {
        code: r.code,
        stderr: r.stderr,
      });
    return r.stdout;
  }
  /** Merge-tree prints the tree id, then `mode object stage<TAB>path` per conflict. */
  private parseMergeTree(stdout: string): GitTreeMerge {
    const fields = stdout.split("\0"),
      tree = fields[0] ?? "";
    if (!fullSha.test(tree))
      throw new Error("merge-tree did not return a tree id");
    const conflicts: string[] = [];
    for (const field of fields.slice(1)) {
      // An empty field ends the conflicted file section; the rest is informational.
      if (field === "") break;
      const tab = field.lastIndexOf("\t"),
        path = tab < 0 ? "" : field.slice(tab + 1);
      if (!conflictRecord.test(field) || path.length === 0)
        throw new Error("Unsupported merge-tree conflict record");
      if (!conflicts.includes(path)) conflicts.push(path);
    }
    return { tree, conflicts };
  }
  private async source(path: string) {
    if (!isAbsolute(path))
      throw new Error("Git source must be an absolute local repository path");
    return realpath(path);
  }
  private async agentSource(source: string, canonical: string) {
    if (!this.options.agentRoot) return false;
    const configured = resolve(this.options.agentRoot);
    const actual = await realpath(configured).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return configured;
      throw error;
    });
    return [configured, actual].some(
      (root) => within(root, resolve(source)) || within(root, canonical),
    );
  }
  async ensureBare(source: string, repository: string, baseline: string) {
    if (dirname(repository) !== this.root)
      throw new Error("Unexpected central repository path");
    const local = await this.source(source);
    if (await this.agentSource(this.root, this.root))
      throw new Error("Central root must be outside the Agent workspace");
    if (await this.agentSource(source, local))
      throw new Error("Registered source must not be an Agent repository");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.privateDirectory(this.root);
    if (!(await exists(repository))) {
      const stage = await mkdtemp(join(this.root, ".central-"));
      try {
        await this.checked(this.root, [
          "clone",
          "--bare",
          "--no-local",
          "--",
          local,
          stage,
        ]);
        if (
          (await this.checked(stage, ["rev-parse", "--is-bare-repository"])) !==
          "true"
        )
          throw new Error("Central clone must be bare");
        if (!(await this.readRef(stage, baseline)))
          throw new Error("Registered baseline branch is missing");
        await this.checked(stage, [
          "config",
          "--local",
          "cardigan.source",
          local,
        ]);
        try {
          await rename(stage, repository);
        } catch (e) {
          if (!(await exists(repository))) throw e;
        }
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    }
    const sourceRecord = await this.command(repository, [
      "config",
      "--local",
      "--get",
      "cardigan.source",
    ]);
    if (
      (await this.checked(repository, [
        "rev-parse",
        "--is-bare-repository",
      ])) !== "true" ||
      sourceRecord.code !== 0 ||
      sourceRecord.stdout !== local
    )
      throw new Error(
        "Central repository source changed; explicit rebuild required",
      );
  }
  /** Host pushes only baseline snapshots and pinned deliveries, never Agent branches. */
  /**
   * `executorRoot` (P2a-12 C) names another execution target's agent root.
   * Its base clone may live on another machine, so the target is checked
   * lexically against `<executorRoot>/repos/<name>` instead of resolved on
   * this disk; `receivePack` is bound to that path and ignores Git's.
   */
  async pushBaseline(
    repository: string,
    target: string,
    receivePack: string,
    executorRoot?: string,
  ) {
    if (
      !receivePack ||
      !(executorRoot === undefined
        ? await this.agentSource(target, await this.source(target))
        : executorTarget(executorRoot, target))
    )
      throw new Error(
        "Baseline push requires an Agent repository and receive-pack entry",
      );
    if (
      (await this.checked(repository, [
        "rev-parse",
        "--is-bare-repository",
      ])) !== "true"
    )
      throw new Error(
        "Baseline push requires a private bare central repository",
      );
    await this.checked(repository, [
      "push",
      "--atomic",
      "--no-verify",
      `--receive-pack=${receivePack}`,
      "--",
      target,
      "+refs/heads/*:refs/remotes/origin/*",
      "+refs/cardigan/deliveries/*:refs/cardigan/deliveries/*",
      "+refs/cardigan/candidates/*:refs/cardigan/candidates/*",
    ]);
  }
  async fetchRefs(
    repository: string,
    source: string,
    refspecs: readonly string[],
    uploadPack?: string,
  ) {
    const local = await this.source(source);
    if ((await this.agentSource(source, local)) && !uploadPack)
      throw new Error("Agent fetch requires an Agent upload-pack entry");
    await this.checked(repository, [
      "fetch",
      "--atomic",
      "--no-tags",
      "--no-prune",
      "--no-write-fetch-head",
      "--no-auto-maintenance",
      ...(uploadPack ? [`--upload-pack=${uploadPack}`] : []),
      "--",
      local,
      ...refspecs,
    ]);
  }
  async readRef(repository: string, ref: string) {
    await this.checked(repository, ["check-ref-format", ref]);
    const r = await this.command(repository, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      ref,
    ]);
    if (r.code === 1) return undefined;
    if (r.code !== 0) throw new Error(r.stderr || "Git command failed");
    return r.stdout;
  }
  async isAncestor(repository: string, ancestor: string, descendant: string) {
    const r = await this.command(repository, [
      "merge-base",
      "--is-ancestor",
      "--",
      ancestor,
      descendant,
    ]);
    if (r.code > 1) throw new Error(r.stderr);
    return r.code === 0;
  }
  async objectFormat(repository: string) {
    const format = await this.checked(repository, [
      "rev-parse",
      "--show-object-format",
    ]);
    if (format !== "sha1" && format !== "sha256")
      throw new Error("Unsupported Git object format");
    return format;
  }
  async objectType(repository: string, sha: string) {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sha))
      throw new Error("Invalid full object SHA");
    const r = await this.command(repository, ["cat-file", "-t", sha]);
    if (r.code === 128) return undefined;
    if (r.code !== 0)
      throw new Error(r.stderr || "Cannot read Git object type");
    return r.stdout;
  }
  async countCommits(repository: string, base: string, head: string) {
    if (
      ![base, head].every((sha) => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sha))
    )
      throw new Error("Invalid recorded base or delivery SHA");
    return Number(
      await this.checked(repository, [
        "rev-list",
        "--count",
        "--end-of-options",
        `${base}..${head}`,
        "--",
      ]),
    );
  }
  /**
   * First-parent commits of `head` not reachable from `base`, newest first,
   * at most `limit`. Author/committer are display-only; callers identify by SHA.
   */
  async firstParentChain(
    repository: string,
    base: string,
    head: string,
    limit: number,
  ): Promise<readonly FirstParentCommit[]> {
    if (
      ![base, head].every((sha) => fullSha.test(sha)) ||
      !Number.isInteger(limit) ||
      limit < 1
    )
      throw new Error("Invalid first-parent range");
    const out = await this.checked(repository, [
      "rev-list",
      "--first-parent",
      "--no-commit-header",
      `--max-count=${limit}`,
      "--format=%H%x1f%P%x1f%an <%ae>%x1f%cn <%ce>%x1f%s",
      "--end-of-options",
      `${base}..${head}`,
      "--",
    ]);
    if (!out) return [];
    return out.split("\n").map((line) => {
      const [sha = "", parents = "", author = "", committer = "", ...rest] =
        line.split("\x1f");
      const parent = parents.split(" ")[0] ?? "";
      if (!fullSha.test(sha) || (parent && !fullSha.test(parent)))
        throw new Error("Unexpected rev-list record");
      return {
        sha,
        ...(parent ? { parent } : {}),
        author: author.slice(0, 200),
        committer: committer.slice(0, 200),
        subject: rest.join("\x1f").slice(0, 200),
      };
    });
  }
  async treeOfCommit(repository: string, sha: string): Promise<string> {
    if (
      !fullSha.test(sha) ||
      (await this.objectType(repository, sha)) !== "commit"
    )
      throw new Error("Tree lookup requires a full commit SHA");
    const tree = await this.checked(repository, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${sha}^{tree}`,
    ]);
    if (!fullSha.test(tree) || tree.length !== sha.length)
      throw new Error("Invalid commit tree id");
    return tree;
  }
  async compareAndSwapRef(
    repository: string,
    ref: string,
    sha: string,
    expected: string | null,
  ) {
    await this.checked(repository, ["check-ref-format", ref]);
    if (![sha, expected ?? sha].every((s) => fullSha.test(s)))
      throw new Error("Invalid full commit SHA");
    await this.checked(repository, [
      "update-ref",
      ref,
      sha,
      expected ?? "0".repeat(sha.length),
    ]);
  }
  async mergeTree(repository: string, ours: string, theirs: string) {
    if (![ours, theirs].every((sha) => fullSha.test(sha)))
      throw new Error("Invalid full commit SHA");
    const result = await this.command(repository, [
      "merge-tree",
      "--write-tree",
      "-z",
      ours,
      theirs,
    ]);
    // 1 means conflicts; anything else non-zero is a real failure.
    if (result.code !== 0 && result.code !== 1)
      throw new Error(result.stderr || "merge-tree failed");
    const merge = this.parseMergeTree(result.stdout);
    if ((result.code === 1) !== merge.conflicts.length > 0)
      throw new Error("merge-tree conflict report is inconsistent");
    return merge;
  }
  async commitTree(repository: string, input: GitCommitTreeInput) {
    if (!fullSha.test(input.tree)) throw new Error("Invalid tree id");
    if (input.parents.length === 0 || input.parents.length > 2)
      throw new Error("Merge commits need one or two parents");
    if (!input.parents.every((sha) => fullSha.test(sha)))
      throw new Error("Invalid parent SHA");
    // The committer identity is explicit: user or global config must not leak in.
    const identity = {
      GIT_AUTHOR_NAME: input.author.name,
      GIT_AUTHOR_EMAIL: input.author.email,
      GIT_COMMITTER_NAME: input.author.name,
      GIT_COMMITTER_EMAIL: input.author.email,
    };
    const sha = await this.checked(
      repository,
      [
        "commit-tree",
        input.tree,
        ...input.parents.flatMap((parent) => ["-p", parent]),
        "-m",
        input.message,
      ],
      identity,
    );
    if (!fullSha.test(sha))
      throw new Error("commit-tree did not return a commit id");
    return sha;
  }
  async isReachable(repository: string, sha: string) {
    if (!fullSha.test(sha)) throw new Error("Invalid full commit SHA");
    const refs = await this.checked(repository, [
      "for-each-ref",
      "--count=1",
      "--format=%(refname)",
      `--contains=${sha}`,
    ]);
    return refs.length > 0;
  }
  async listRefs(
    repository: string,
    prefix: string,
  ): Promise<readonly GitRef[]> {
    if (!/^refs\/[A-Za-z0-9._/-]+$/u.test(prefix) || prefix.includes(".."))
      throw new Error("Invalid ref prefix");
    const raw = await this.checked(repository, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      prefix,
    ]);
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [ref, sha] = line.split(" ");
        if (!ref || !sha || !fullSha.test(sha))
          throw new Error("Unsupported Git ref record");
        return { ref, sha };
      });
  }
}
