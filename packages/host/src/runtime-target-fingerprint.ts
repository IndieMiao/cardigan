import { createHash } from "node:crypto";
import type { RuntimeTargetBinding } from "@cardigan/domain";
import {
  type ExecutionConfig,
  registeredRuntimeOf,
} from "@cardigan/runtime-herdr";

interface TargetIdentity {
  project_id: string;
  machine_id: string;
  generation: string;
  execution: ExecutionConfig;
  session: string;
}

// parseRuntimeWorkers canonicalizes env keys and omits an empty mapping.
function encode(
  { project_id, machine_id, generation, execution, session }: TargetIdentity,
  tools: boolean,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        project_id,
        machine_id,
        generation,
        registeredRuntimeOf(execution, session),
        execution.dataDir,
        tools && execution.mode === "agent-ssh"
          ? (execution.path ?? null)
          : null,
        ...(tools && execution.mode === "agent-ssh" && execution.env
          ? [{ env: execution.env }]
          : []),
        ...(execution.mode === "agent-ssh" && execution.macosCore
          ? [{ macosCore: execution.macosCore }]
          : []),
        ...(execution.mode === "agent-ssh" && execution.mcp
          ? [{ mcp: execution.mcp }]
          : []),
        ...(execution.mode === "agent-ssh" &&
        (execution.publication || execution.fileHelper || execution.gitHelper)
          ? [
              {
                publication: execution.publication,
                fileHelper: execution.fileHelper,
                gitHelper: execution.gitHelper,
              },
            ]
          : []),
        // Keeps this digest disjoint from every full binding fingerprint.
        ...(tools ? [] : ["worktree-preparation"]),
      ]),
    )
    .digest("hex");
}

/** The persisted runtime_ref identity; placement must compare against the same encoding. */
export function runtimeTargetBinding(
  identity: TargetIdentity,
): RuntimeTargetBinding {
  const { project_id, machine_id, session, generation } = identity;
  const fingerprint = encode(identity, true);
  return { project_id, machine_id, session, generation, fingerprint };
}

/**
 * C-784: the same binding without the Run tool PATH and env. Host Git
 * preparation runs through the configured helpers, never through these, so
 * observed preparation evidence follows a PATH or env edit; every other field,
 * including generation and helpers, still revokes it.
 */
export const worktreePreparationFingerprint = (identity: TargetIdentity) =>
  encode(identity, false);
