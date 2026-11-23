import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import type {
  GitBackupSelection,
  GitCentralPort,
  GitCommitTreeInput,
  GitFileDiff,
  GitPreparedBackup,
  GitPublicationGuard,
  GitRef,
  GitRepositoryAddress,
  GitReviewAttributionPort,
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
import {
  type GitTimeoutOptions,
  gitTimeoutMs,
  withGitTimeout,
} from "./timeouts.js";

const exec = promisify(execFile);
// Git refnames are bytes. Never map an undecodable name onto a genuine U+FFFD ref.
const refDecoder = new TextDecoder("utf-8", { fatal: true });
const strictRefNames = (bytes: Buffer) => refDecoder.decode(bytes);
// One code unit per byte: an opaque Map key, never a name to pass back to Git.
const refByteKey = (bytes: Buffer) => bytes.toString("latin1");
type OutputDecoder = (bytes: Buffer) => string;
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
/** C-637: `geometric` rolls up small packs; `cruft` also separates unreachable objects. */
export type CentralRepackMode = "geometric" | "cruft";
export interface CentralObjectStats {
  readonly packs: number;
  readonly loose: number;
  readonly size_pack_kib: number;
}
export interface CentralRepackResult {
  readonly mode: CentralRepackMode;
  readonly before: CentralObjectStats;
  readonly after: CentralObjectStats;
  readonly duration_ms: number;
}
/** Only these namespaces have a retention period (Q-1233). */
const retainedRef =
  /^refs\/cardigan\/(?:candidates|prechecks)\/[A-Za-z0-9._/-]+$/u;
const cruftIndex = /^pack-[a-f0-9]{40}(?:[a-f0-9]{24})?\.mtimes$/u;
export interface CentralGitOptions extends GitTimeoutOptions {
  dataDir: string;
  centralRoot?: string;
  agentRoot?: string;
  /** Observation only; tests still execute real Git. */
  onCommand?: (cwd: string, args: readonly string[]) => void;
}
/** Host Git never executes inside the source or an Agent repository. */
export class CentralGitTransport
  implements GitCentralPort, GitReviewAttributionPort
{
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
    output: boolean | OutputDecoder = false,
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
          encoding: "buffer",
          timeout,
          killSignal: "SIGKILL",
          maxBuffer: 4 * 1024 * 1024,
        }),
      );
      return {
        code: 0,
        stdout:
          typeof output === "function"
            ? output(r.stdout)
            : output
              ? r.stdout.toString()
              : r.stdout.toString().trimEnd(),
        stderr: r.stderr.toString(),
      };
    } catch (error) {
      const e = error as {
        code?: number;
        stdout?: Buffer;
        stderr?: Buffer;
        killed?: boolean;
      };
      if (typeof e.code !== "number" || e.killed) throw error;
      return {
        code: e.code,
        stdout: e.stdout?.toString().trimEnd() ?? "",
        stderr: e.stderr?.toString() ?? "Git failed",
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
    output: boolean | OutputDecoder = false,
  ) {
    const r = await this.command(repository, args, extraEnv, output);
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
  /** Git probes file URLs for bundles before consulting a custom pack entry.
   * Never give it a worker path: only the bound entry receives that path.
   */
  private async workerEndpoint<T>(transfer: (endpoint: string) => Promise<T>) {
    await this.privateDirectory(this.root);
    const temporary = await mkdtemp(join(this.root, ".worker-transport-"));
    try {
      await this.privateDirectory(temporary);
      // The private, exclusively created parent makes this absent leaf safe
      // from Agent-created files and symlinks, including during the transfer.
      return await transfer(join(temporary, "endpoint"));
    } finally {
      await rmdir(temporary);
    }
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
    await this.verifyBareSource(repository, local);
  }
  /** Read-only counterpart for consumers of an existing center: do not clone
   * or require a particular branch to exist just to mirror its current heads. */
  async verifyBareSource(repository: string, canonicalSource: string) {
    if (dirname(repository) !== this.root)
      throw new Error("Unexpected central repository path");
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
      sourceRecord.stdout !== canonicalSource
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
    target: string | GitRepositoryAddress,
    receivePack: string,
    executorRoot?: string,
  ) {
    const remote =
      typeof target !== "string" && target.kind === "worker-remote";
    const path = typeof target === "string" ? target : target.path;
    const remoteValid =
      remote &&
      !!target.machine_id &&
      /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(target.project_id) &&
      (path === posix.join(target.root, "repos", target.project_id) ||
        (posix.dirname(path) ===
          posix.join(target.root, "repos", target.project_id) &&
          posix.basename(path).startsWith(`.clone-${target.project_id}-`) &&
          /^[a-f0-9]{32}$/u.test(
            posix.basename(path).slice(`.clone-${target.project_id}-`.length),
          ))) &&
      executorTarget(
        target.root,
        posix.join(target.root, "repos", target.project_id),
      );
    if (
      !receivePack ||
      !(remote
        ? remoteValid
        : executorRoot === undefined
          ? await this.agentSource(path, await this.source(path))
          : executorTarget(executorRoot, path))
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
    const push = (endpoint: string) =>
      this.checked(repository, [
        "push",
        "--atomic",
        "--no-verify",
        `--receive-pack=${receivePack}`,
        "--",
        endpoint,
        "+refs/heads/*:refs/remotes/origin/*",
        "+refs/cardigan/deliveries/*:refs/cardigan/deliveries/*",
        "+refs/cardigan/candidates/*:refs/cardigan/candidates/*",
      ]);
    await (remote || executorRoot !== undefined
      ? this.workerEndpoint(push)
      : push(path));
  }
  /** Fetch-equivalent distribution: the sender is the verified private center,
   * never a URL resolved by the mirror. Only remote-tracking refs are updated. */
  async distributeMirrorHeads(repository: string, receivePack: string) {
    await this.workerEndpoint((endpoint) =>
      this.checked(repository, [
        "push",
        "--atomic",
        "--prune",
        "--no-follow-tags",
        "--no-verify",
        `--receive-pack=${receivePack}`,
        "--",
        endpoint,
        "+refs/heads/*:refs/remotes/origin/*",
      ]),
    );
  }
  private async fetchSource(
    source: string | GitRepositoryAddress,
    uploadPack?: string,
  ) {
    const remote =
      typeof source !== "string" && source.kind === "worker-remote";
    const path = typeof source === "string" ? source : source.path;
    if (
      remote &&
      (!uploadPack ||
        !source.machine_id ||
        !executorTarget(source.root, path) ||
        posix.basename(path) !== source.project_id)
    )
      throw new Error(
        "Worker fetch requires a bound repository and upload-pack entry",
      );
    const local = remote ? path : await this.source(path);
    if (!remote && (await this.agentSource(path, local)) && !uploadPack)
      throw new Error("Agent fetch requires an Agent upload-pack entry");
    return { remote, local };
  }
  async fetchRefs(
    repository: string,
    source: string | GitRepositoryAddress,
    refspecs: readonly string[],
    uploadPack?: string,
    skipIfUnchanged = false,
  ) {
    const { remote, local } = await this.fetchSource(source, uploadPack);
    // A bound upload-pack is the only operation that can contact an Agent.
    if (
      skipIfUnchanged &&
      !uploadPack &&
      (await this.probeUnchanged(repository, local, refspecs))
    )
      return;
    // Keep real transfer failures outside the optional probe's catch.
    const fetch = (endpoint: string) =>
      this.checked(repository, [
        "fetch",
        "--atomic",
        "--no-tags",
        "--no-prune",
        "--no-write-fetch-head",
        "--no-auto-maintenance",
        ...(uploadPack ? [`--upload-pack=${uploadPack}`] : []),
        "--",
        endpoint,
        ...refspecs,
      ]);
    await (remote ? this.workerEndpoint(fetch) : fetch(local));
  }
  async sourceHasRef(repository: string, source: string, ref: string) {
    if (dirname(repository) !== this.root)
      throw new Error("Unexpected central repository path");
    await this.checked(repository, ["check-ref-format", ref]);
    const { remote, local } = await this.fetchSource(source);
    if (remote) throw new Error("Only a local source can be queried");
    const raw = await this.checked(
      repository,
      ["ls-remote", "--refs", "--", local, ref],
      {},
      strictRefNames,
    );
    return raw
      .split("\n")
      .filter(Boolean)
      .some((line) => line.split("\t")[1] === ref);
  }
  private async backupInventory(
    repository: string,
    decode: OutputDecoder,
    ...prefixes: string[]
  ) {
    const raw = await this.checked(
      repository,
      [
        "for-each-ref",
        "--format=%(refname) %(objectname) %(objecttype)",
        ...prefixes,
      ],
      {},
      decode,
    );
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [ref, sha, type] = line.split(" ");
        if (!ref || !sha || !fullSha.test(sha) || !type)
          throw new Error("Invalid backup ref record");
        return { ref, sha, type };
      });
  }
  /** Private refs per transfer. Borrow center objects for negotiation; import
   * only the validated tips, without creating any ref (including FETCH_HEAD).
   * Unpublished objects are not recovery roots and can be collected by Git. */
  async prepareBranchBackup(
    repository: string,
    source: GitRepositoryAddress,
    {
      machine,
      branch,
      excludedBranches = [],
      uploadPack,
      skipIfUnchanged,
    }: GitBackupSelection,
  ): Promise<GitPreparedBackup> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(machine))
      throw new Error("Invalid backup machine");
    for (const name of [
      ...(branch === undefined ? [] : [branch]),
      ...excludedBranches,
    ]) {
      if (!name.startsWith("agent/")) throw new Error("Invalid backup branch");
      await this.checked(repository, [
        "check-ref-format",
        `refs/heads/${name}`,
      ]);
    }
    const prefix = `refs/cardigan/backups/${machine}/`;
    const suffix = branch ?? "agent/";
    const inventory = await this.backupInventory(
      repository,
      refByteKey,
      prefix + suffix,
      `refs/cardigan/backup-generations/${machine}/${suffix}`,
    );
    // Old backups may contain names a current capture cannot represent. Compare
    // exact bytes before transfer; never decode, rename or prune that history.
    const byBytes = new Map(inventory.map(({ ref, sha }) => [ref, sha]));
    const previous = {
      get: (ref: string) => byBytes.get(refByteKey(Buffer.from(ref))),
    };
    const head = `refs/heads/${branch ?? "agent/*"}`;
    let confirmed: readonly GitRef[] | undefined;
    if (skipIfUnchanged && !uploadPack && !excludedBranches.length) {
      const { local } = await this.fetchSource(source, uploadPack);
      confirmed = await this.probeUnchanged(
        repository,
        local,
        [`+${head}:${prefix}${branch ?? "agent/*"}`],
        previous,
      );
    }
    const stage = await mkdtemp(join(this.root, ".backup-"));
    try {
      let refs: readonly GitRef[];
      if (confirmed) {
        // The local probe observed these exact tips. Even here publication
        // must advance their generations, not those of absent branches.
        const commits = new Set(
          inventory.filter((r) => r.type === "commit").map((r) => r.sha),
        );
        if (confirmed.some((r) => !commits.has(r.sha)))
          throw new Error("Invalid backup commit");
        refs = confirmed;
      } else {
        const format = await this.objectFormat(repository);
        await this.checked(stage, [
          "init",
          "--bare",
          "--template=",
          `--object-format=${format}`,
        ]);
        // Relative to the stage object directory; only a validated project basename
        // enters this one-line alternates file (never an Agent path).
        await writeFile(
          join(stage, "objects/info/alternates"),
          `../../${basename(repository)}/objects\n`,
        );
        await this.fetchRefs(
          stage,
          source,
          [
            `+${head}:${head}`,
            ...excludedBranches.map((name) => `^refs/heads/${name}`),
          ],
          uploadPack,
        );
        refs = (
          await this.backupInventory(stage, strictRefNames, "refs/heads/agent/")
        ).map(({ ref, sha, type }) => {
          if (!ref.startsWith("refs/heads/agent/") || type !== "commit")
            throw new Error("Invalid staged backup commit");
          return { ref: prefix + ref.slice("refs/heads/".length), sha };
        });
      }
      const edits = refs.map(({ ref, sha }) => ({
        ref,
        sha,
        old: previous.get(ref) ?? null,
      }));
      const tips = [
        ...new Set(edits.filter((e) => e.sha !== e.old).map((e) => e.sha)),
      ];
      if (tips.length) await this.fetchRefs(repository, stage, tips);
      // A successful poll of the very same SHA is still newer evidence. Fence
      // it too, so an older in-flight rewrite cannot win an ABA race.
      if (!edits.length) return { refs, publish() {}, rollback() {} };
      const nonce = join(stage, "generation");
      await writeFile(nonce, randomUUID());
      const generation = await this.checked(repository, [
        "hash-object",
        "-w",
        "--",
        nonce,
      ]);
      const generations = edits.map(({ ref }) => {
        const key = ref.replace(
          "refs/cardigan/backups/",
          "refs/cardigan/backup-generations/",
        );
        return { ref: key, sha: generation, old: previous.get(key) ?? null };
      });
      return {
        refs,
        ...(await this.backupRefTransaction(repository, [
          ...edits,
          ...generations,
        ])),
      };
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  /** Prepare local CAS before entering the short authorization/SQLite section.
   * One update-ref transaction protects wildcard publication and its rollback. */
  private async backupRefTransaction(
    repository: string,
    edits: readonly { ref: string; sha: string; old: string | null }[],
  ) {
    if (dirname(repository) !== this.root)
      throw new Error("Unexpected backup repository");
    await this.privateDirectory(this.root);
    await this.privateDirectory(repository);
    const forward: string[] = [],
      reverse: string[] = [];
    for (const { ref, sha, old } of edits) {
      if (
        !/^refs\/cardigan\/(?:backups|backup-generations)\/[A-Za-z0-9._-]+\/agent\//u.test(
          ref,
        ) ||
        ref.includes("\0") ||
        !fullSha.test(sha) ||
        (old !== null && !fullSha.test(old))
      )
        throw new Error("Invalid backup ref transaction");
      forward.push(`update ${ref}\0${sha}\0${old ?? "0".repeat(sha.length)}\0`);
      if (old !== sha)
        reverse.push(
          old === null
            ? `delete ${ref}\0${sha}\0`
            : `update ${ref}\0${old}\0${sha}\0`,
        );
    }
    const run = (commands: string[]) => {
      if (!commands.length) return;
      const args = [
        ...gitSafetyArguments,
        "-C",
        repository,
        "update-ref",
        "--no-deref",
        "--stdin",
        "-z",
      ];
      this.options.onCommand?.(repository, args);
      try {
        execFileSync("git", args, {
          env: gitEnvironment(),
          timeout: gitTimeoutMs("update-ref", this.options),
          killSignal: "SIGKILL",
          input: commands.join(""),
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        // Match the checked Git command error contract used by worktree callers.
        const status = (error as { status?: number }).status;
        if (typeof status === "number")
          Object.assign(error as Error, { code: status });
        throw error;
      }
    };
    return { publish: () => run(forward), rollback: () => run(reverse) };
  }
  private async probeUnchanged(
    repository: string,
    source: string,
    refspecs: readonly string[],
    previous?: Pick<ReadonlyMap<string, string>, "get">,
  ) {
    try {
      return await this.unchangedRefs(repository, source, refspecs, previous);
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
    return undefined;
  }
  /** Read both sides each time: failed fetches, restarts and deleted backups retry. */
  private async unchangedRefs(
    repository: string,
    source: string,
    refspecs: readonly string[],
    previous?: Pick<ReadonlyMap<string, string>, "get">,
  ): Promise<readonly GitRef[] | undefined> {
    // Optimize the two polling shapes only. SHA fetches and other refspecs
    // keep the ordinary transfer path, including Git's validation/errors.
    if (refspecs.length !== 1) return undefined;
    const match =
      /^\+?(refs\/[A-Za-z0-9._/-]+)(\*)?:(refs\/[A-Za-z0-9._/-]+)(\*)?$/u.exec(
        refspecs[0] ?? "",
      );
    if (!match || match[2] !== match[4]) return undefined;
    const from = match[1] as string,
      to = match[3] as string;
    if (from.includes("..") || to.includes("..")) return undefined;
    const wildcard = match[2] === "*";
    if (wildcard && (!from.endsWith("/") || !to.endsWith("/")))
      return undefined;
    const raw = await this.checked(
      repository,
      ["ls-remote", "--refs", "--", source, `${from}${wildcard ? "*" : ""}`],
      {},
      strictRefNames,
    );
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
    if (!advertised.length) return wildcard ? [] : undefined;
    const current =
      previous ??
      new Map(
        (await this.listRefs(repository, to)).map(({ ref, sha }) => [ref, sha]),
      );
    return advertised.every(({ ref, sha }) => current.get(ref) === sha)
      ? advertised
      : undefined;
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
  /** Transaction-time local read; no cached ref, network, checkout or ref writes. */
  readRefSync(repository: string, ref: string): string | undefined {
    try {
      if (dirname(repository) !== this.root) throw new Error();
      for (const path of [this.root, repository]) {
        for (let parent = dirname(path); ; parent = dirname(parent)) {
          const entry = lstatSync(parent);
          if (
            !entry.isDirectory() ||
            ![0, process.getuid?.()].includes(entry.uid) ||
            (entry.mode & 0o022 && !(entry.mode & 0o1000))
          )
            throw new Error();
          if (parent === dirname(parent)) break;
        }
        const entry = lstatSync(path);
        if (
          !entry.isDirectory() ||
          entry.uid !== process.getuid?.() ||
          entry.mode & 0o077 ||
          realpathSync(path) !== path
        )
          throw new Error();
      }
      const timeout = gitTimeoutMs("rev-parse", this.options);
      const read = (args: string[]) => {
        const command = [...gitSafetyArguments, "-C", repository, ...args];
        this.options.onCommand?.(repository, command);
        return execFileSync("git", command, {
          env: gitEnvironment(),
          timeout,
          killSignal: "SIGKILL",
          maxBuffer: 4 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
        }).trim();
      };
      read(["check-ref-format", ref]);
      const sha = read([
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        ref,
      ]);
      return fullSha.test(sha) ? sha : undefined;
    } catch {
      // Missing, inaccessible and unsupported refs cannot authorize a proof.
      return undefined;
    }
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
  /** C-308: preserve all parents; a first-parent summary cannot prove a merge. */
  async commitParents(
    repository: string,
    sha: string,
  ): Promise<readonly string[]> {
    await this.requireCommit(repository, sha);
    const out = await this.checked(repository, [
      "rev-list",
      "--parents",
      "--max-count=1",
      "--end-of-options",
      sha,
      "--",
    ]);
    const [commit, ...parents] = out.split(" ");
    if (
      commit !== sha ||
      !parents.every((p) => fullSha.test(p) && p.length === sha.length)
    )
      throw new Error("Invalid commit parent record");
    return parents;
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
  /** Author changes exclude unrelated work added to the baseline since branching. */
  async deliveryChangedPaths(
    repository: string,
    base: string,
    commit: string,
  ): Promise<readonly string[]> {
    await this.requireCommit(repository, base);
    await this.requireCommit(repository, commit);
    const ancestor = await this.checked(repository, [
      "merge-base",
      "--all",
      base,
      commit,
    ]);
    if (!fullSha.test(ancestor))
      throw new Error("Delivery needs a unique merge base");
    return this.changedPaths(repository, ancestor, commit);
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
        // An explicit empty path list after `--` makes ls-tree return
        // nothing. With no path list, read all entries at the tree root.
        ...(directory === "" ? [] : ["--", `${directory}/`]),
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
  async resolvePlanConflict(
    repository: string,
    ours: string,
    theirs: string,
    merge: GitTreeMerge,
  ): Promise<GitTreeMerge> {
    const path = "docs/development-plan.md";
    if (merge.conflicts.length !== 1 || merge.conflicts[0] !== path)
      return merge;
    let directory: string | undefined;
    try {
      if (![ours, theirs, merge.tree].every((sha) => fullSha.test(sha)))
        return merge;
      const base = await this.checked(repository, [
        "merge-base",
        "--all",
        ours,
        theirs,
      ]);
      if (!fullSha.test(base)) return merge; // Multiple bases need an author.
      const contents = [];
      for (const sha of [ours, base, theirs]) {
        const entry = await this.checked(
          repository,
          ["ls-tree", "-z", sha, "--", path],
          literalPathspecs,
        );
        const match = treeRecord.exec(entry.replace(/\0$/u, ""));
        if (match?.[1] !== "100644" || match[2] !== "blob" || match[4] !== path)
          return merge;
        const content = await this.checked(
          repository,
          ["cat-file", "blob", match[3] as string],
          {},
          true,
        );
        if (
          content.includes("\0") ||
          content.includes("\ufffd") ||
          /^(?:<{7}|={7}|>{7}|\|{7})(?: |$)/mu.test(content)
        )
          return merge;
        contents.push(content);
      }
      directory = await mkdtemp(join(repository, "plan-union-"));
      const files = ["ours", "base", "theirs"].map((name) =>
        join(directory as string, name),
      );
      for (let i = 0; i < files.length; i++)
        await writeFile(files[i] as string, contents[i] as string, {
          mode: 0o600,
        });
      // Fixed built-in union algorithm: no repository merge driver or checkout filters.
      const union = await this.command(
        repository,
        ["merge-file", "--union", "-p", ...files],
        {},
        true,
      );
      if (union.code !== 0) return merge;
      const output = join(directory, "merged");
      await writeFile(output, union.stdout, { mode: 0o600 });
      const blob = await this.checked(repository, [
        "hash-object",
        "-w",
        "--no-filters",
        output,
      ]);
      const env = { GIT_INDEX_FILE: join(directory, "index") };
      await this.checked(repository, ["read-tree", merge.tree], env);
      await this.checked(
        repository,
        ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`],
        env,
      );
      const tree = await this.checked(repository, ["write-tree"], env);
      if (!fullSha.test(tree)) return merge;
      return { tree, conflicts: [] };
    } catch {
      return merge; // Preserve the original conflict and the normal author fix path.
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
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
    const raw = await this.checked(
      repository,
      ["for-each-ref", "--format=%(refname) %(objectname)", prefix],
      {},
      strictRefNames,
    );
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
  /** C-637: object counts from `git count-objects -v`. */
  async objectStats(repository: string): Promise<CentralObjectStats> {
    const raw = await this.checked(repository, ["count-objects", "-v"]);
    const field = (name: string) => {
      const value = new RegExp(`^${name}: (\\d+)$`, "mu").exec(raw)?.[1];
      if (value === undefined) throw new Error("Unsupported count-objects");
      return Number(value);
    };
    return {
      packs: field("packs"),
      loose: field("count"),
      size_pack_kib: field("size-pack"),
    };
  }
  /**
   * C-637: incremental object maintenance of a central repository. Repack is
   * safe beside concurrent fetches and ref updates: it removes only the packs
   * it rewrote and loose objects already packed. Nothing expires (no
   * `--cruft-expiration`): unreachable objects move into a cruft pack, so no
   * object is deleted. Callers do not hold the host repository lock.
   */
  async repack(
    repository: string,
    mode: CentralRepackMode,
  ): Promise<CentralRepackResult> {
    if (dirname(repository) !== this.root)
      throw new Error("Unexpected central repository path");
    const before = await this.objectStats(repository);
    const started = performance.now();
    await this.checked(repository, [
      "repack",
      ...(mode === "cruft" ? ["--cruft"] : ["--geometric=2"]),
      "-d",
      "-q",
    ]);
    const duration_ms = Math.round(performance.now() - started);
    return {
      mode,
      before,
      after: await this.objectStats(repository),
      duration_ms,
    };
  }
  /**
   * C-637 / Q-1233: compare-and-delete expired candidate and precheck refs.
   * Each chunk is one update-ref transaction; a chunk whose refs moved
   * meanwhile fails as a whole and is left for the next run.
   */
  async deleteRetainedRefs(
    repository: string,
    refs: readonly GitRef[],
    chunk = 500,
  ): Promise<{ readonly deleted: number; readonly failed: number }> {
    if (dirname(repository) !== this.root)
      throw new Error("Unexpected central repository path");
    for (const { ref, sha } of refs)
      if (!retainedRef.test(ref) || ref.includes("..") || !fullSha.test(sha))
        throw new Error("Invalid retained ref deletion");
    await this.privateDirectory(this.root);
    await this.privateDirectory(repository);
    let deleted = 0,
      failed = 0;
    for (let at = 0; at < refs.length; at += chunk) {
      const part = refs.slice(at, at + chunk);
      const args = [
        ...gitSafetyArguments,
        "-C",
        repository,
        "update-ref",
        "--no-deref",
        "--stdin",
        "-z",
      ];
      this.options.onCommand?.(repository, args);
      try {
        await withGitTimeout("update-ref", this.options, (timeout) => {
          const run = exec("git", args, {
            env: gitEnvironment(),
            timeout,
            killSignal: "SIGKILL",
            maxBuffer: 1024 * 1024,
          });
          run.child.stdin?.end(
            part.map(({ ref, sha }) => `delete ${ref}\0${sha}\0`).join(""),
          );
          return run;
        });
        deleted += part.length;
      } catch {
        failed += part.length;
      }
    }
    return { deleted, failed };
  }
  /** C-637: when the newest cruft pack was written (its `.mtimes` file). */
  async lastCruftPack(repository: string): Promise<number | undefined> {
    if (dirname(repository) !== this.root)
      throw new Error("Unexpected central repository path");
    await this.privateDirectory(this.root);
    await this.privateDirectory(repository);
    const packs = join(repository, "objects", "pack");
    let latest: number | undefined;
    for (const name of await readdir(packs)) {
      if (!cruftIndex.test(name)) continue;
      const entry = await lstat(join(packs, name));
      if (entry.isFile() && (latest === undefined || entry.mtimeMs > latest))
        latest = entry.mtimeMs;
    }
    return latest;
  }
}
