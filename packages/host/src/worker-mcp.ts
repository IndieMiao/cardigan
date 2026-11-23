import { spawn } from "node:child_process";
import { MCP_BRIDGE_PROBE_ARGS } from "@cardigan/roles";
import {
  agentProcessCommand,
  type ExecutionConfig,
} from "@cardigan/runtime-herdr";

const codes = [
  "mcp_config_missing",
  "mcp_config_invalid",
  "mcp_auth_failed",
  "mcp_tls_failed",
  "mcp_unreachable",
  "mcp_timeout",
  "mcp_redirect",
  "mcp_protocol_error",
  "mcp_gateway_error",
  "mcp_worker_failed",
] as const;
type Code = (typeof codes)[number];
export class WorkerMcpError extends Error {
  constructor(readonly code: Code) {
    super(code);
  }
}

/** Only private host configuration reaches this parser; never echo rejected input. */
export function workerMcpConfig(url: unknown, timeoutMs: unknown = 10_000) {
  if (url === undefined) throw new WorkerMcpError("mcp_config_missing");
  try {
    const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
    if (
      typeof url !== "string" ||
      !new RegExp(
        `^https://${label}\\.${label}\\.ts\\.net(?::[0-9]+)?/mcp$`,
        "u",
      ).test(url) ||
      new URL(url).port === "0" ||
      !Number.isSafeInteger(timeoutMs) ||
      Number(timeoutMs) <= 0 ||
      Number(timeoutMs) > 2147483647
    )
      throw new Error();
    // urllib preserves the supplied authority; share WHATWG's canonical port
    // spelling with the proxy Host fence and every compiled Harness address.
    return { url: new URL(url).href, timeoutMs: Number(timeoutMs) };
  } catch {
    throw new WorkerMcpError("mcp_config_invalid");
  }
}

/**
 * C-600: the interpreter that runs Card MCP code on this worker: the launch
 * preflight, the machine check and the Codex Card bridge all use it.
 */
export function workerMcpPython(
  execution: Extract<ExecutionConfig, { mode: "agent-ssh" }>,
): string {
  return (
    execution.fileHelper?.python ?? execution.gitHelper?.python ?? "python3"
  );
}

/** Authenticated startup never accepts a reachability-only result. */
export function checkWorkerMcp(
  execution: Extract<ExecutionConfig, { mode: "agent-ssh" }>,
  token: string,
): Promise<void> {
  if (typeof token !== "string" || !token)
    return Promise.reject(new WorkerMcpError("mcp_auth_failed"));
  return probeWorkerMcp(execution, token);
}

/**
 * A human machine check needs no Assignment credential and grants no
 * authority. C-600: it runs the Codex Card bridge's own connection function
 * on the worker, so it takes exactly the harness's route: direct, no proxy.
 */
export function checkWorkerMcpReachability(
  execution: Extract<ExecutionConfig, { mode: "agent-ssh" }>,
): Promise<void> {
  return probeWorkerMcp(execution);
}

async function probeWorkerMcp(
  execution: Extract<ExecutionConfig, { mode: "agent-ssh" }>,
  token?: string,
): Promise<void> {
  const config = workerMcpConfig(execution.mcp?.url, execution.mcp?.timeoutMs);
  const started = Date.now();
  try {
    // URL and token go only through stdin.
    const command = await agentProcessCommand(execution, [
      workerMcpPython(execution),
      ...MCP_BRIDGE_PROBE_ARGS,
    ]);
    const remaining = config.timeoutMs - (Date.now() - started);
    if (remaining <= 0) throw new WorkerMcpError("mcp_timeout");
    const code = await new Promise<string>((resolve, reject) => {
      const child = spawn(command.file, command.args, {
        stdio: ["pipe", "pipe", "ignore"],
      });
      let output = "",
        size = 0,
        timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, remaining);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > 128) child.kill("SIGKILL");
        else output += chunk.toString();
      });
      child.stdin.on("error", () => child.kill("SIGKILL"));
      child.on("error", () => {
        clearTimeout(timer);
        reject(new WorkerMcpError("mcp_worker_failed"));
      });
      child.on("close", (status) => {
        clearTimeout(timer);
        if (timedOut) reject(new WorkerMcpError("mcp_timeout"));
        else if (status !== 0 || size > 128)
          reject(new WorkerMcpError("mcp_worker_failed"));
        else resolve(output.trim());
      });
      child.stdin.end(
        JSON.stringify({ ...config, authenticate: token !== undefined, token }),
      );
    });
    if (code !== "ok")
      throw new WorkerMcpError(
        codes.includes(code as Code) ? (code as Code) : "mcp_worker_failed",
      );
  } catch (error) {
    throw error instanceof WorkerMcpError
      ? error
      : new WorkerMcpError("mcp_worker_failed");
  }
}
