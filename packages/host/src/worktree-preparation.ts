import { dirname, join } from "node:path";
import type { WorktreePreparation } from "@cardigan/domain";
import { runtimeTargetBinding } from "./runtime-target-fingerprint.js";
import {
  type RuntimeWorker,
  runtimeWorkersPath,
} from "./runtime-workers-config.js";
import { readOnboardingYaml } from "./worker-onboarding-config.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Reject absent timezones, normalized impossible dates, and ambiguous local times.
function instant(value: unknown): number {
  if (typeof value !== "string") return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : NaN;
}

/** Read once for this selection; no record is written by a worker, check, or launch. */
export function readWorktreePreparation(
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
    const { project_id, machine_id, execution } = worker;
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
      !execution.gitHelper ||
      !execution.fileHelper ||
      !execution.publication ||
      proof.target_fingerprint !== runtimeTargetBinding(worker).fingerprint
    )
      return "invalid";
    const from = instant(proof.verified_at),
      until = instant(proof.expires_at);
    if (!(from <= at && from < until)) return "invalid";
    return at < until ? "verified" : "expired";
  };
}
