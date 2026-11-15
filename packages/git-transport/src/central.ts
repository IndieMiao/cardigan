import { execFile, execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  GitCentralPort,
  GitCommitTreeInput,
  GitFileDiff,
  GitPublicationGuard,
  GitRef,
  GitTreeMerge,
} from "@cardigan/domain";
import {
  type CandidateDeleteRequest,
  candidateDeleteCommand,
} from "./candidate-delete.js";
import {
  type CandidatePushRequest,
  candidatePushCommand,
} from "./candidate-push.js";
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
const treeRecord =
  /^([0-7]{6}) (blob|tree|commit) ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t(.+)$/su;
/** Pathspecs are literal: no glob or magic in tree reads. */
const literalPathspecs = { GIT_LITERAL_PATHSPECS: "1" } as const;
/** A normalized path inside a tree: relative, no `.`/`..` or empty segments. */
const treePath = (path: string) => {
  const segments = path.split("/");
  if (
    path.length === 0 ||
    path.length > 4096 ||
    [...path].some((c) => c.charCodeAt(0) < 0x20 || c === "\x7f") ||
    segments.some((s) => s === "" || s === "." || s === "..")
  )
    throw new Error("Invalid tree path");
  return path;
};
export interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
  /** Full path from the tree root. */
  readonly path: string;
}
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
    preserveOutput = false,
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
      return {
        code: 0,
        stdout: preserveOutput ? r.stdout : r.stdout.trimEnd(),
        stderr: r.stderr,
      };
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
              code?: unknown;
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
              ...(typeof e.code === "number" &&
              Number.isSafeInteger(e.code) &&
              e.code >= 0
                ? { exit_code: e.code }
                : {}),
            } as const;
          }
        },
      );
      return outcome;
    } catch {
      return { status: "failed", reason: "other" };
    }
  }
  /** Host-only GitHub App publication, restricted to a single non-force ci ref. */
  async pushCandidateCommit(
    repository: string,
    input: CandidatePushRequest,
  ): Promise<PushResult> {
    try {
      if (dirname(repository) !== this.root)
        throw new Error("Unexpected center");
      await this.privateDirectory(this.root);
      await this.privateDirectory(repository);
      const command = candidatePushCommand(repository, input);
      if ((await this.objectType(repository, input.sha)) !== "commit")
        throw new Error("Missing commit");
      await withGitTimeout("push", this.options, (timeout) =>
        exec("git", command.args, {
          env: command.env,
          timeout,
          killSignal: "SIGKILL",
          maxBuffer: 1024 * 1024,
          ...(input.signal ? { signal: input.signal } : {}),
        }),
      );
      return { status: "pushed" };
    } catch {
      return { status: "failed", reason: "other" };
    }
  }
  /** Host-only compare-and-delete; no generic branch deletion entry point. */
  async deleteCandidateCommit(
    repository: string,
    input: CandidateDeleteRequest,
  ): Promise<boolean> {
    try {
      if (dirname(repository) !== this.root)
        throw new Error("Unexpected center");
      await this.privateDirectory(this.root);
      await this.privateDirectory(repository);
      const command = candidateDeleteCommand(repository, input);
      // Missing refs are already cleaned, including a crash after remote deletion.
      // Still use the exact lease on push: the ref may change after this query.
      const queryArgs = command.args.slice(0, command.args.indexOf("push"));
      queryArgs.push(
        "ls-remote",
        "--refs",
        "--",
        `https://github.com/${input.repo}.git`,
        input.ref,
      );
      const remote = await withGitTimeout(
        "ls-remote",
        this.options,
        (timeout) =>
          exec("git", queryArgs, {
            env: command.env,
            timeout,
            killSignal: "SIGKILL",
            maxBuffer: 1024 * 1024,
            ...(input.signal ? { signal: input.signal } : {}),
          }),
      );
      const observed = remote.stdout.trim();
      if (!observed) return true;
      if (observed !== `${input.sha}\t${input.ref}`) return false;
      await withGitTimeout("push", this.options, (timeout) =>
        exec("git", command.args, {
          env: command.env,
          timeout,
          killSignal: "SIGKILL",
          maxBuffer: 1024 * 1024,
          ...(input.signal ? { signal: input.signal } : {}),
        }),
      );
      return true;
    } catch {
      return false;
    }
  }
  private async checked(
    repository: string,
    args: string[],
    extraEnv: NodeJS.ProcessEnv = {},
    preserveOutput = false,
  ) {
    const r = await this.command(repository, args, extraEnv, preserveOutput);
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
    skipIfUnchanged = false,
  ) {
    const local = await this.source(source);
    if ((await this.agentSource(source, local)) && !uploadPack)
      throw new Error("Agent fetch requires an Agent upload-pack entry");
    // Bound Agent transports keep one streaming upload-pack per fetch.
    // A refs probe would add another SSH call and a query-timeout failure mode.
    if (skipIfUnchanged && !uploadPack) {
      try {
        if (await this.refsUnchanged(repository, local, refspecs)) return;
      } catch (error) {
        // The probe is only an optimization. Report a bounded classification,
        // never raw diagnostics (which can contain source paths or credentials).
        const cause = (
          error instanceof Error ? (error.cause ?? error) : error
        ) as { code?: unknown; killed?: boolean; signal?: string } | null;
        const reason =
          cause?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? "output_limit"
            : cause?.code === "runtime_timeout" ||
                (cause?.killed &&
                  cause.signal === "SIGKILL" &&
                  cause.code == null)
              ? "timeout"
              : "query_failed";
        console.warn(
          `Git refs preflight failed (${reason}); falling back to fetch`,
        );
      }
    }
    // Keep real transfer failures outside the optional probe's catch.
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
  /** Read both sides each time: failed fetches, restarts and deleted backups retry. */
  private async refsUnchanged(
    repository: string,
    source: string,
    refspecs: readonly string[],
  ): Promise<boolean> {
    // Optimize the two polling shapes only. SHA fetches and other refspecs
    // keep the ordinary transfer path, including Git's validation/errors.
    if (refspecs.length !== 1) return false;
    const match =
      /^\+?(refs\/[A-Za-z0-9._/-]+)(\*)?:(refs\/[A-Za-z0-9._/-]+)(\*)?$/u.exec(
        refspecs[0] ?? "",
      );
    if (!match || match[2] !== match[4]) return false;
    const from = match[1] as string,
      to = match[3] as string;
    if (from.includes("..") || to.includes("..")) return false;
    const wildcard = match[2] === "*";
    if (wildcard && (!from.endsWith("/") || !to.endsWith("/"))) return false;
    const raw = await this.checked(repository, [
      "ls-remote",
      "--refs",
      "--",
      source,
      `${from}${wildcard ? "*" : ""}`,
    ]);
    const advertised = raw
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const [sha, ref] = line.split("\t");
        if (!sha || !fullSha.test(sha) || !ref)
          throw new Error("Unsupported advertised Git ref record");
        // ls-remote patterns also match after a slash, not just at the root.
        if (wildcard ? !ref.startsWith(from) : ref !== from) return [];
        return [{ sha, ref: wildcard ? to + ref.slice(from.length) : to }];
      });
    // A missing exact source ref must still fail in fetch; an empty agent/*
    // set is normal and never prunes existing backups.
    if (!advertised.length) return wildcard;
    const current = new Map(
      (await this.listRefs(repository, to)).map(({ ref, sha }) => [ref, sha]),
    );
    return advertised.every(({ ref, sha }) => current.get(ref) === sha);
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
  private async requireCommit(repository: string, sha: string) {
    if (
      !fullSha.test(sha) ||
      (await this.objectType(repository, sha)) !== "commit"
    )
      throw new Error("Tree reads require a full commit SHA");
  }
  /**
   * P2a-13 A1: paths changed between two commits of the center. Both ends are
   * full commit SHAs (never refs); renames are reported as delete + add.
   */
  async fileDiffs(
    repository: string,
    base: string,
    head: string,
  ): Promise<readonly GitFileDiff[]> {
    await this.requireCommit(repository, base);
    await this.requireCommit(repository, head);
    const raw = await this.checked(repository, [
      "diff-tree",
      "-r",
      "-z",
      "--raw",
      "--no-abbrev",
      "--no-renames",
      "--no-commit-id",
      "--ignore-submodules=none",
      base,
      head,
    ]);
    const records = raw.split("\0");
    if (!raw) return [];
    if (records.pop() !== "" || records.length % 2)
      throw new Error("Invalid raw diff");
    const result: GitFileDiff[] = [];
    for (let i = 0; i < records.length; i += 2) {
      const m =
        /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])$/u.exec(
          records[i] ?? "",
        );
      const path = records[i + 1];
      if (!m || !path) throw new Error("Unsupported raw diff");
      // Literal pathspecs and no converters: repository attributes cannot run code.
      const patch = await this.checked(
        repository,
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          "--unified=0",
          "--no-color",
          base,
          head,
          "--",
          path,
        ],
        literalPathspecs,
        true,
      );
      const before =
        m[1] === "100644" || m[1] === "100755"
          ? await this.checked(
              repository,
              ["cat-file", "blob", m[3]!],
              {},
              true,
            )
          : undefined;
      const after =
        m[2] === "100644" || m[2] === "100755"
          ? await this.checked(
              repository,
              ["cat-file", "blob", m[4]!],
              {},
              true,
            )
          : undefined;
      result.push({
        ...(before === undefined ? {} : { before }),
        ...(after === undefined ? {} : { after }),
        path,
        old_mode: m[1]!,
        new_mode: m[2]!,
        old_oid: m[3]!,
        new_oid: m[4]!,
        status: m[5]!,
        patch,
      });
    }
    return result;
  }
  async changedPaths(
    repository: string,
    base: string,
    commit: string,
  ): Promise<readonly string[]> {
    await this.requireCommit(repository, base);
    await this.requireCommit(repository, commit);
    const out = await this.checked(repository, [
      "diff-tree",
      "-r",
      "-z",
      "--name-only",
      "--no-renames",
      "--no-commit-id",
      base,
      commit,
    ]);
    return out.split("\0").filter(Boolean);
  }
  /**
   * P2a-13 A1: entries directly under `directory` ("" for the root) in a
   * commit's tree. Reads only that tree, never a working copy.
   */
  async listTree(
    repository: string,
    commit: string,
    directory: string,
  ): Promise<readonly TreeEntry[]> {
    await this.requireCommit(repository, commit);
    if (directory !== "") treePath(directory);
    const out = await this.checked(
      repository,
      [
        "ls-tree",
        "-z",
        "--end-of-options",
        commit,
        "--",
        ...(directory === "" ? [] : [`${directory}/`]),
      ],
      literalPathspecs,
    );
    return out
      .split("\0")
      .filter(Boolean)
      .map((record) => {
        const match = treeRecord.exec(record);
        if (!match?.[1] || !match[2] || !match[3] || !match[4])
          throw new Error("Unsupported ls-tree record");
        return {
          mode: match[1],
          type: match[2],
          oid: match[3],
          path: match[4],
        };
      });
  }
  /**
   * P2a-13 A1: a regular file of a commit's tree, or undefined when absent.
   * Symlinks, submodules and directories are refused: their content would not
   * be the file the workspace sees, or could point outside the tree.
   */
  async readTreeFile(
    repository: string,
    commit: string,
    path: string,
  ): Promise<string | undefined> {
    await this.requireCommit(repository, commit);
    treePath(path);
    const out = await this.checked(
      repository,
      ["ls-tree", "-z", "--end-of-options", commit, "--", path],
      literalPathspecs,
    );
    const record = out.split("\0").find(Boolean);
    if (record === undefined) return undefined;
    const match = treeRecord.exec(record);
    if (match?.[4] !== path) throw new Error("Unexpected ls-tree record");
    if (match[2] !== "blob" || !["100644", "100755"].includes(match[1] ?? ""))
      throw new Error(`Tree path is not a regular file: ${path}`);
    return this.checked(repository, ["cat-file", "blob", match[3] ?? ""]);
  }
  async compareAndSwapRef(
    repository: string,
    ref: string,
    sha: string,
    expected: string | null,
    guard?: GitPublicationGuard,
  ) {
    await this.checked(repository, ["check-ref-format", ref]);
    if (![sha, expected ?? sha].every((s) => fullSha.test(s)))
      throw new Error("Invalid full commit SHA");
    const args = ["update-ref", ref, sha, expected ?? "0".repeat(sha.length)];
    if (!guard) {
      await this.checked(repository, args);
      return;
    }
    // Complete filesystem IO before entering the host's synchronous write
    // transaction. No await may separate authorization, ref CAS and its audit.
    await this.privateDirectory(this.root);
    await this.privateDirectory(repository);
    const command = [...gitSafetyArguments, "-C", repository, ...args];
    this.options.onCommand?.(repository, command);
    return withGitTimeout("update-ref", this.options, async (timeout) => {
      const authorized = guard(() => {
        try {
          execFileSync("git", command, {
            env: gitEnvironment(),
            timeout,
            killSignal: "SIGKILL",
            maxBuffer: 4 * 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ETIMEDOUT")
            Object.assign(error as object, { killed: true, code: null });
          throw error;
        }
      });
      if (!authorized) return false as const;
    });
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
