import { resolve } from "node:path";
import {
  checkWorkerCapabilities,
  type WorkerManifest,
  type WorkerRequirements,
} from "./worker-capabilities.js";
import {
  sameWorkerProcess,
  type WorkerNativeConfig,
  type WorkerProcessIdentity,
  workerNative,
} from "./worker-primitives.js";

export interface WorkerPath {
  kind:
    | "repo"
    | "worktree"
    | "build"
    | "cache"
    | "generated"
    | "evidence"
    | "temporary";
  path: string;
  realpath: string;
  mount: string;
  volume: string;
  uid: number;
  common_dir: string | null;
  assignment: string;
  sha: string;
  dirty: boolean;
}
export interface WorkerPathObservation extends WorkerPath {
  mounted: boolean;
  acl_safe: boolean;
  free_bytes: number;
  root_free_bytes: number;
  project_private: boolean;
  lock_verified: boolean;
}
export interface WorkerCredential {
  category:
    | "model"
    | "harness"
    | "ssh"
    | "mcp"
    | "apple-signing"
    | "apple-developer"
    | "login-key"
    | "encryption-key"
    | "play-upload"
    | "app-signing"
    | "debug-signing"
    | "test-account"
    | "test-mail"
    | "external-service";
  owner_role: string;
  credential_ref: string;
  scope: string;
  available: boolean | null;
}
export interface WorkerPreflight {
  requirements: WorkerRequirements;
  paths: WorkerPath[];
  minimum_free_bytes: { root: number; work: number };
  credentials: WorkerCredential[];
}

export function sampleWorkerPaths(
  native: WorkerNativeConfig,
  input: {
    paths: WorkerPath[];
    worktree: string;
    git: string;
    lock?: string;
  },
): WorkerPathObservation[] {
  return workerNative(native, "paths", {
    ...input,
    timeout_ms: native.timeout_ms,
  });
}

export interface WorkerArtifact {
  sha256: string;
  size: number;
  evidence_name: string;
}
export function stageWorkerArtifact(
  native: WorkerNativeConfig,
  input: {
    source: string;
    temporary_root: string;
    evidence_root: string;
    writing_complete: boolean;
  },
): WorkerArtifact {
  return workerNative(native, "artifact", input);
}

/** Persist in 03's launch intent / 05's recovery point, not a second journal store. */
export interface WorkerCheckpoint {
  assignment_id: string;
  run_id: string;
  phase: "prepared" | "running" | "collecting" | "evidence_ready";
  sha: string;
  target_config_digest: string;
  process: WorkerProcessIdentity | null;
  log_offset: number;
  artifacts: WorkerArtifact[];
}
/** Unknown identity cannot authorize replay, termination, deletion or whole-task restart. */
export function resumeWorkerLog(
  checkpoint: WorkerCheckpoint,
  observed: WorkerProcessIdentity | null,
): number | null {
  return checkpoint.process &&
    sameWorkerProcess(checkpoint.process, observed) &&
    Number.isSafeInteger(checkpoint.log_offset) &&
    checkpoint.log_offset >= 0
    ? checkpoint.log_offset
    : null;
}
/** No IO or fallback. Card 02/08 must call this before enabling a remote target. */
export function workerPreflight(
  config: WorkerPreflight,
  manifest: WorkerManifest,
  observations: WorkerPathObservation[],
): { ready: boolean; blockers: string[] } {
  const blockers = checkWorkerCapabilities(manifest, config.requirements);
  const { root, work } = config.minimum_free_bytes;
  if (![root, work].every((n) => Number.isSafeInteger(n) && n > 0))
    blockers.push("space_thresholds");
  if (
    !config.paths.length ||
    new Set(config.paths.map((p) => p.path)).size !== config.paths.length
  )
    blockers.push("path_inventory");
  for (const [index, expected] of config.paths.entries()) {
    const matches = observations.filter((p) => p.path === expected.path);
    const actual = matches.length === 1 ? matches[0] : undefined;
    if (
      actual?.mounted !== true ||
      actual.acl_safe !== true ||
      actual.project_private !== true ||
      actual.lock_verified !== true ||
      ![
        "repo",
        "worktree",
        "build",
        "cache",
        "generated",
        "evidence",
        "temporary",
      ].includes(expected.kind) ||
      !expected.path.startsWith("/") ||
      resolve(expected.path) !== expected.path ||
      typeof expected.dirty !== "boolean" ||
      expected.uid !== config.requirements.uid ||
      !expected.volume ||
      !/^A-\d+$/.test(expected.assignment) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expected.sha) ||
      Object.keys(expected).some(
        (key) =>
          actual[key as keyof WorkerPath] !== expected[key as keyof WorkerPath],
      ) ||
      !Number.isSafeInteger(actual.free_bytes) ||
      !Number.isSafeInteger(actual.root_free_bytes) ||
      actual.free_bytes < work ||
      actual.root_free_bytes < root
    )
      blockers.push(`path:${index}`);
  }
  for (const [index, credential] of config.credentials.entries()) {
    // Return only an index; credentials, scopes and paths never enter diagnostics.
    if (
      credential.available !== true ||
      ![
        credential.owner_role,
        credential.credential_ref,
        credential.scope,
      ].every((v) => /^[\w.:-]{1,128}$/.test(v))
    )
      blockers.push(`credential:${index}`);
  }
  return { ready: blockers.length === 0, blockers };
}
