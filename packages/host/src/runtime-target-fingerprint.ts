import { createHash } from "node:crypto";
import type { RuntimeTargetBinding } from "@cardigan/domain";
import {
  type ExecutionConfig,
  registeredRuntimeOf,
} from "@cardigan/runtime-herdr";

/** The persisted runtime_ref identity; placement must compare against the same encoding. */
export function runtimeTargetBinding({
  project_id,
  machine_id,
  generation,
  execution,
  session,
}: {
  project_id: string;
  machine_id: string;
  generation: string;
  execution: ExecutionConfig;
  session: string;
}): RuntimeTargetBinding {
  // parseRuntimeWorkers canonicalizes env keys and omits an empty mapping.
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        project_id,
        machine_id,
        generation,
        registeredRuntimeOf(execution, session),
        execution.dataDir,
        execution.mode === "agent-ssh" ? execution.path : null,
        ...(execution.mode === "agent-ssh" && execution.env
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
      ]),
    )
    .digest("hex");
  return { project_id, machine_id, session, generation, fingerprint };
}
