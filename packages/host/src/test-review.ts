import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
  GitReviewAttributionPort,
  TestReviewCandidate,
  TestReviewProof,
  TestReviewTrust,
} from "@cardigan/domain";
import { attributeReviewChanges } from "@cardigan/git-service";
import { parseDocument } from "yaml";

export interface TestReviewPolicy {
  readonly project_id: string;
  readonly version: string;
  readonly source_version: string;
  readonly test_files: readonly string[];
}
export interface TestInputBoundary {
  readonly generation: string;
  readonly source_version: string;
  readonly input_digest: string;
  readonly production_inputs: readonly string[];
}
/**
 * Host-only integration seam for an EXISTING, enforced closed-input execution
 * chain. A manifest, import scan or successful build is not an implementation
 * of this port. No production adapter is registered by this change.
 */
export interface TestIsolationSource {
  /** Actual writer identities and mount/privilege boundary; unknown => absent. */
  policyBoundary(project: string):
    | {
        readonly owner_uid: number;
        readonly untrusted_uids: readonly number[];
        readonly generation: string;
      }
    | undefined;
  /** Must account for ALL build/copy/deploy/runtime reads on this COMPLETE tree. */
  collect(input: {
    readonly project_id: string;
    readonly sha: string;
    readonly tree: string;
    readonly entries: readonly {
      readonly path: string;
      readonly mode: string;
      readonly type: string;
      readonly oid: string;
    }[];
    readonly policy: TestReviewPolicy;
  }): Promise<TestInputBoundary | undefined>;
  /** Recheck actual enforcement and identities; revoke before ANY boundary mutation. */
  isCurrent(proof: TestReviewProof): boolean;
}

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const literalPath = (path: unknown): path is string =>
  typeof path === "string" &&
  path.length > 0 &&
  path.length <= 4096 &&
  !/[\p{Cc}\p{Cf}\\*?[\]{}]/u.test(path) &&
  !path.startsWith("/") &&
  path.split("/").every((p) => p && p !== "." && p !== "..");

export function parseTestReviewPolicy(
  source: string,
  project: string,
): TestReviewPolicy {
  const doc = parseDocument(source, { uniqueKeys: true, strict: true });
  if (doc.errors.length || doc.warnings.length)
    throw new Error("Invalid test review policy");
  const p = doc.toJS({ maxAliasCount: 0 });
  if (
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    Object.keys(p).some(
      (k) =>
        !["project_id", "version", "source_version", "test_files"].includes(k),
    ) ||
    p.project_id !== project ||
    ![p.version, p.source_version].every(
      (v) => typeof v === "string" && /^[a-zA-Z0-9._-]+$/u.test(v),
    ) ||
    !Array.isArray(p.test_files) ||
    !p.test_files.length ||
    !p.test_files.every(literalPath) ||
    new Set(p.test_files).size !== p.test_files.length
  )
    throw new Error("Invalid test review policy");
  return p as TestReviewPolicy;
}

/**
 * Root-owned sticky ancestors protect trusted child names from other UIDs.
 * Every other ancestor must be non-writable by group/others. POSIX ACL write masks appear in mode's group-write bit. The source
 * must additionally rule out elevated writers, mount substitution and other
 * platform ACLs; the loader cannot establish those facts from mode alone.
 */
export function readTestReviewPolicy(
  file: string,
  project: string,
  source: TestIsolationSource,
) {
  const boundary = source.policyBoundary(project);
  if (
    !boundary?.generation ||
    !boundary.untrusted_uids.length ||
    boundary.untrusted_uids.some(
      (uid) =>
        !Number.isSafeInteger(uid) || uid < 1 || uid === boundary.owner_uid,
    ) ||
    !Number.isSafeInteger(boundary.owner_uid) ||
    boundary.owner_uid < 0 ||
    !isAbsolute(file) ||
    resolve(file) !== file
  )
    throw new Error("Untrusted test review policy boundary");
  for (let path = dirname(file); ; path = dirname(path)) {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      (stat.mode & 0o022 && !(stat.uid === 0 && stat.mode & 0o1000)) ||
      ![0, boundary.owner_uid].includes(stat.uid) ||
      boundary.untrusted_uids.includes(stat.uid)
    )
      throw new Error("Untrusted test review policy directory");
    if (path === dirname(path)) break;
  }
  const fd = openSync(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let text: string;
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== boundary.owner_uid ||
      stat.mode & 0o022 ||
      stat.size > 65536 ||
      stat.nlink !== 1
    )
      throw new Error("Untrusted test review policy file");
    text = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  const after = source.policyBoundary(project);
  if (JSON.stringify(after) !== JSON.stringify(boundary))
    throw new Error("Test review policy boundary changed");
  return {
    policy: parseTestReviewPolicy(text, project),
    digest: digest(text),
    generation: boundary.generation,
  };
}

/** Combines fixed center Git, protected host policy and an actual input source. */
export class HostTestReviewTrust implements TestReviewTrust {
  private readonly authority = randomUUID();
  private readonly issued = new Map<string, string>();
  constructor(
    private readonly options: {
      readonly git: GitReviewAttributionPort;
      readonly repository: (project: string) => string | undefined;
      readonly baseline: (
        project: string,
        branch: string,
      ) => Promise<string | undefined>;
      readonly pinned: (
        project: string,
        delivery: string,
      ) => Promise<string | undefined>;
      readonly policyFile: (project: string) => string | undefined;
      readonly source?: TestIsolationSource;
    },
  ) {}

  async prepare(
    candidate: TestReviewCandidate,
  ): Promise<TestReviewProof | undefined> {
    try {
      const { source } = this.options;
      const file = this.options.policyFile(candidate.project_id);
      const repository = this.options.repository(candidate.project_id);
      if (!source || !file || !repository) return;
      const policy = readTestReviewPolicy(file, candidate.project_id, source);
      if (
        (await this.options.pinned(
          candidate.project_id,
          candidate.previous_delivery_id,
        )) !== candidate.old_sha
      )
        return;
      const baseline = await this.options.baseline(
        candidate.project_id,
        candidate.base_branch,
      );
      if (!baseline) return;
      const attributed = await attributeReviewChanges(
        this.options.git,
        repository,
        {
          old_sha: candidate.old_sha,
          new_sha: candidate.new_sha,
          baseline_sha: baseline,
        },
      );
      if (
        attributed.status !== "attributed" ||
        attributed.proof.old_tree !== candidate.old_tree
      )
        return;
      const git = attributed.proof;
      if (!git.files.every((path) => policy.policy.test_files.includes(path)))
        return;
      const entries: Awaited<
        ReturnType<GitReviewAttributionPort["listTree"]>
      >[number][] = [];
      const pending = [""];
      while (pending.length) {
        const dir = pending.pop() as string;
        for (const entry of await this.options.git.listTree(
          repository,
          candidate.new_sha,
          dir,
        )) {
          if (
            !literalPath(entry.path) ||
            (dir && !entry.path.startsWith(`${dir}/`))
          )
            return;
          if (entry.type === "tree" && entry.mode === "040000")
            pending.push(entry.path);
          else if (entry.type === "blob" && entry.mode === "100644")
            entries.push(entry);
          else return;
        }
      }
      // The provider receives the full new tree including baseline additions.
      const boundary = await source.collect({
        project_id: candidate.project_id,
        sha: candidate.new_sha,
        tree: git.new_tree,
        entries,
        policy: policy.policy,
      });
      if (
        !boundary?.generation ||
        boundary.source_version !== policy.policy.source_version ||
        !/^[a-f0-9]{64}$/u.test(boundary.input_digest) ||
        boundary.production_inputs.some(
          (path) => !literalPath(path) || !entries.some((e) => e.path === path),
        ) ||
        policy.policy.test_files.some((path) =>
          boundary.production_inputs.includes(path),
        )
      )
        return;
      const proof: TestReviewProof = {
        ...candidate,
        ...git,
        policy_boundary_generation: policy.generation,
        policy_digest: policy.digest,
        policy_version: policy.policy.version,
        source_version: boundary.source_version,
        input_digest: boundary.input_digest,
        isolation_generation: boundary.generation,
        authority: this.authority,
      };
      if (
        (await this.options.baseline(
          candidate.project_id,
          candidate.base_branch,
        )) !== baseline ||
        readTestReviewPolicy(file, candidate.project_id, source).digest !==
          policy.digest ||
        !source.isCurrent(proof)
      )
        return;
      this.issued.set(this.key(proof), JSON.stringify(proof));
      return proof;
    } catch {
      return;
    }
  }

  isCurrent(proof: TestReviewProof): boolean {
    try {
      const { source } = this.options;
      const file = this.options.policyFile(proof.project_id);
      if (
        !source ||
        !file ||
        proof.authority !== this.authority ||
        this.issued.get(this.key(proof)) !== JSON.stringify(this.unbind(proof))
      )
        return false;
      const current = readTestReviewPolicy(file, proof.project_id, source);
      const valid =
        current.generation === proof.policy_boundary_generation &&
        current.digest === proof.policy_digest &&
        current.policy.version === proof.policy_version &&
        current.policy.source_version === proof.source_version &&
        source.isCurrent(proof);
      if (!valid) this.issued.delete(this.key(proof));
      return valid;
    } catch {
      this.issued.delete(this.key(proof));
      return false;
    }
  }
  private unbind(proof: TestReviewProof) {
    const { delivery_id: _id, ...rest } = proof as TestReviewProof & {
      delivery_id?: string;
    };
    return rest;
  }
  private key(proof: TestReviewProof) {
    return `${proof.project_id}/${proof.verifier_id}/${proof.previous_delivery_id}/${proof.new_sha}`;
  }
}
