import { createHash } from "node:crypto";
import {
  type ExecutionConfig,
  registeredRuntimeOf,
} from "@cardigan/runtime-herdr";

/** The persisted runtime_ref identity; placement must compare against the same encoding. */
export function runtimeTargetFingerprint(
  project: string,
  machine_id: string,
  generation: string,
  execution: ExecutionConfig,
  session: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        project,
        machine_id,
        generation,
        registeredRuntimeOf(execution, session),
        execution.dataDir,
        execution.mode === "agent-ssh" ? execution.path : null,
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
}
