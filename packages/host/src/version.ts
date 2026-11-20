import type { AgentBinary, RuntimeResult } from "@cardigan/domain";
import { getHarnessAdapter, HARNESSES, type Harness } from "@cardigan/roles";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import { HostLaunchError, messageOf } from "./errors.js";

/**
 * Snapshot the Agent CLI version of a Run (invariant 12).
 *
 * In `agent-ssh` mode the binary lives for the `agent` account only: asking the
 * host's PATH would either miss it or report a different installation, so the
 * probe goes through the runtime's configured Agent entry (M2.7, §13.4). The
 * local probe stays a caller-supplied callback because the CLI injects its IO
 * and the server uses `execFile`.
 */

export type { AgentBinary } from "@cardigan/domain";

export function harnessBinary(harness: Harness): AgentBinary {
  return getHarnessAdapter(harness).binary;
}

export type CaptureAgent = (
  command: "git" | AgentBinary,
  args: readonly string[],
) => Promise<RuntimeResult<string>>;

export interface AgentCliVersionSource {
  readonly execution: ExecutionConfig;
  /** Present on the real runtime adapter; required in `agent-ssh` mode. */
  readonly captureAgent?: CaptureAgent | undefined;
  readonly captureLocal: (
    binary: AgentBinary,
    args: readonly string[],
  ) => Promise<string>;
}

export async function agentCliVersion(
  source: AgentCliVersionSource,
  binary: AgentBinary,
): Promise<string> {
  const adapter = HARNESSES.map(getHarnessAdapter).find(
    (a) => a.binary === binary,
  );
  if (!adapter) throw new HostLaunchError("cli version", "未知的 Agent CLI");
  if (source.execution.mode === "local")
    return await source.captureLocal(binary, adapter.versionArgs);

  if (source.captureAgent === undefined) {
    throw new HostLaunchError(
      "cli version",
      "agent-ssh 启动需要 Agent 执行入口，不能用主机账号执行 Agent CLI",
    );
  }
  let captured: RuntimeResult<string>;
  try {
    captured = await source.captureAgent(binary, adapter.versionArgs);
  } catch (error) {
    throw new HostLaunchError("cli version", messageOf(error), {
      cause: error,
    });
  }
  if (!captured.ok) {
    throw new HostLaunchError(
      "cli version",
      `Agent 命令失败：${captured.error.code} ${captured.error.message}`,
      { cause: captured.error },
    );
  }
  const line = captured.value.trim().split("\n")[0] ?? "";
  if (line.length === 0)
    throw new HostLaunchError("cli version", "Agent CLI 没有返回版本");
  return line;
}
