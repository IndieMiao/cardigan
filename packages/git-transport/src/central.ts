import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { GitCentralPort } from "@cardigan/domain";
import { gitEnvironment, gitSafetyArguments } from "./hardening.js";

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
const within = (root: string, path: string) =>
  path === root || path.startsWith(root + sep);
export interface CentralGitOptions {
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
  private async command(repository: string, args: string[]) {
    if (repository !== this.root && dirname(repository) !== this.root)
      throw new Error("Git command escaped central root");
    await this.privateDirectory(this.root);
    await this.privateDirectory(repository);
    const command = [...gitSafetyArguments, "-C", repository, ...args];
    this.options.onCommand?.(repository, command);
    try {
      const r = await exec("git", command, {
        env: gitEnvironment(),
        timeout: 30000,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
      });
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
  private async checked(repository: string, args: string[]) {
    const r = await this.command(repository, args);
    if (r.code !== 0) throw new Error(r.stderr || "Git command failed");
    return r.stdout;
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
  async compareAndSwapRef(
    repository: string,
    ref: string,
    sha: string,
    expected: string | null,
  ) {
    await this.checked(repository, ["check-ref-format", ref]);
    if (
      ![sha, expected ?? sha].every((s) =>
        /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(s),
      )
    )
      throw new Error("Invalid full commit SHA");
    await this.checked(repository, [
      "update-ref",
      ref,
      sha,
      expected ?? "0".repeat(sha.length),
    ]);
  }
}
