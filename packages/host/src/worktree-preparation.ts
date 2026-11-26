import { dirname, join } from "node:path";
import type { ProjectId, WorktreePreparation } from "@cardigan/domain";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import type { Store, StoreTransactionContext } from "@cardigan/store";
import {
  runtimeTargetBinding,
  worktreePreparationFingerprint,
} from "./runtime-target-fingerprint.js";
import {
  type RuntimeWorker,
  runtimeWorkersPath,
} from "./runtime-workers-config.js";
import { readOnboardingYaml } from "./worker-onboarding-config.js";

const DEFAULT_EVIDENCE_TTL_MS = 30 * 86_400_000;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Reject absent timezones, normalized impossible dates, and ambiguous local times.
function instant(value: unknown): number {
  if (typeof value !== "string") return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : NaN;
}

function window(
  proof: Record<string, unknown>,
  at: number,
): WorktreePreparation {
  const from = instant(proof.verified_at),
    until = instant(proof.expires_at);
  if (!(from <= at && from < until)) return "invalid";
  return at < until ? "verified" : "expired";
}

function helpersConfigured({ execution }: RuntimeWorker): boolean {
  return Boolean(
    execution.gitHelper && execution.fileHelper && execution.publication,
  );
}

/** C-784: the host's own observation for one project/worker, if any. */
export type ObservedPreparation = (
  project: string,
  machine: string,
) => Record<string, unknown> | undefined;

export function observedWorktreePreparation(store: Store): ObservedPreparation {
  const query = store.database.prepare(
    "SELECT * FROM worktree_preparation_evidence WHERE project_id=? AND machine_id=?",
  );
  return (project, machine) => query.get(project, machine);
}

const RANK: Record<WorktreePreparation, number> = {
  missing: 0,
  invalid: 1,
  expired: 2,
  verified: 3,
};

/**
 * Read once for this selection. The private file is never written by a worker,
 * check, or launch; the observed evidence only by `recordWorktreePreparation`.
 */
export function readWorktreePreparation(
  env: NodeJS.ProcessEnv,
  now: string,
  observed: ObservedPreparation = () => undefined,
): (worker: RuntimeWorker) => WorktreePreparation {
  const manual = readAttestedPreparation(env, now);
  const at = instant(now);
  return (worker) => {
    const attested = manual(worker);
    const proof = observed(worker.project_id, worker.machine_id);
    const seen: WorktreePreparation = !proof
      ? "missing"
      : proof.os !== worker.os ||
          proof.arch !== worker.arch ||
          typeof proof.evidence_ref !== "string" ||
          !proof.evidence_ref.trim() ||
          !helpersConfigured(worker) ||
          (proof.target_fingerprint !==
            runtimeTargetBinding(worker).fingerprint &&
            proof.preparation_fingerprint !==
              worktreePreparationFingerprint(worker))
        ? "invalid"
        : window(proof, at);
    return RANK[seen] > RANK[attested] ? seen : attested;
  };
}

function readAttestedPreparation(
  env: NodeJS.ProcessEnv,
  now: string,
): (worker: RuntimeWorker) => WorktreePreparation {
  let input: unknown;
  try {
    input = readOnboardingYaml(
      join(dirname(runtimeWorkersPath(env)), "worktree-preparation.yaml"),
    );
  } catch {
    return () => "invalid";
  }
  if (input === undefined) return () => "missing";
  if (
    !record(input) ||
    input.version !== 1 ||
    !record(input.bindings) ||
    Object.keys(input).some((k) => k !== "version" && k !== "bindings")
  )
    return () => "invalid";
  const bindings = input.bindings;
  const at = instant(now);
  return (worker) => {
    const { project_id, machine_id } = worker;
    const key = `${project_id}/${machine_id}`;
    if (!Object.hasOwn(bindings, key)) return "missing";
    const proof = bindings[key];
    if (
      !record(proof) ||
      Object.keys(proof).some(
        (k) =>
          ![
            "target_fingerprint",
            "os",
            "arch",
            "verified_at",
            "expires_at",
            "evidence_ref",
          ].includes(k),
      ) ||
      proof.os !== worker.os ||
      proof.arch !== worker.arch ||
      typeof proof.evidence_ref !== "string" ||
      !proof.evidence_ref.trim() ||
      !helpersConfigured(worker) ||
      proof.target_fingerprint !== runtimeTargetBinding(worker).fingerprint
    )
      return "invalid";
    return window(proof, at);
  };
}

/**
 * C-784: called only in the publication transaction that records a remote
 * launch as started on a worktree this host prepared during that launch. The
 * binding must re-derive from the private configuration it was resolved from.
 */
export function recordWorktreePreparation(
  store: Store,
  tx: StoreTransactionContext,
  project: ProjectId,
  execution: Extract<ExecutionConfig, { mode: "agent-ssh" }>,
  evidence_ref: string,
  now: string,
): boolean {
  const target = execution.target;
  if (
    !target ||
    target.project_id !== project ||
    target.machine_id === "local" ||
    !execution.gitHelper ||
    !execution.fileHelper ||
    !execution.publication
  )
    return false;
  const identity = { ...target, execution };
  const machine = tx.machines.get(project, target.machine_id);
  const at = instant(now);
  if (
    !machine ||
    !Number.isFinite(at) ||
    runtimeTargetBinding(identity).fingerprint !== target.fingerprint
  )
    return false;
  store.database
    .prepare(`INSERT INTO worktree_preparation_evidence VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(project_id,machine_id) DO UPDATE SET
      target_fingerprint=excluded.target_fingerprint,
      preparation_fingerprint=excluded.preparation_fingerprint,
      os=excluded.os, arch=excluded.arch, verified_at=excluded.verified_at,
      expires_at=excluded.expires_at, evidence_ref=excluded.evidence_ref`)
    .run(
      project,
      target.machine_id,
      target.fingerprint,
      worktreePreparationFingerprint(identity),
      machine.os,
      machine.arch,
      now,
      new Date(
        at + (execution.preparationEvidenceTtlMs ?? DEFAULT_EVIDENCE_TTL_MS),
      ).toISOString(),
      evidence_ref,
    );
  return true;
}
