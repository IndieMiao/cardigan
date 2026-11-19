import { spawn } from "node:child_process";
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

// Executed by the worker's isolated Python. URL/token go only through stdin.
// initialize authenticates without acknowledging a Run or touching tool activity.
const probe = `
import http.client, json, socket, ssl, sys, urllib.error, urllib.request
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None
def read_reply(response):
    raw = response.read(65537)
    length = response.headers.get("Content-Length", "")
    if length.isdecimal() and len(raw) < min(65537, int(length)):
        raise http.client.IncompleteRead(raw)
    return raw

def check():
    try:
        data = json.load(sys.stdin)
        context = ssl.create_default_context()
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
            urllib.request.HTTPSHandler(context=context), NoRedirect())
        body = json.dumps({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2025-03-26","capabilities":{},
            "clientInfo":{"name":"cardigan-worker-preflight","version":"1"}}}).encode()
        headers = {"Content-Type":"application/json", "Accept":"application/json, text/event-stream"}
        if data["authenticate"]:
            headers["Authorization"] = "Bearer " + data["token"]
        req = urllib.request.Request(data["url"], data=body, method="POST", headers=headers)
        with opener.open(req, timeout=data["timeoutMs"]/1000) as response:
            if not data["authenticate"]: return "mcp_protocol_error"
            raw = read_reply(response)
            if response.status != 200 or len(raw) > 65536:
                return "mcp_protocol_error"
            reply = json.loads(raw)
            result = reply.get("result", {})
            if (reply.get("jsonrpc") != "2.0" or reply.get("id") != 1 or "error" in reply
                or result.get("serverInfo", {}).get("name") != "cardigan"
                or result.get("protocolVersion") != "2025-03-26"):
                return "mcp_protocol_error"
        return "ok"
    except urllib.error.HTTPError as error:
        if 500 <= error.code < 600: return "mcp_gateway_error"
        if error.code == 401 and not data["authenticate"]:
            try:
                raw = read_reply(error)
                if (len(raw) <= 65536 and error.headers.get("WWW-Authenticate") == "Bearer"
                    and json.loads(raw).get("error", {}).get("code") == "unauthorized"):
                    return "ok"
            except http.client.HTTPException: return "mcp_gateway_error"
            except Exception: pass
            return "mcp_protocol_error"
        if error.code in (401, 403): return "mcp_auth_failed"
        if 300 <= error.code < 400: return "mcp_redirect"
        return "mcp_protocol_error"
    except http.client.HTTPException:
        return "mcp_gateway_error"
    except (ssl.SSLError, urllib.error.URLError, OSError) as error:
        reason = getattr(error, "reason", error)
        if isinstance(reason, ssl.SSLError): return "mcp_tls_failed"
        if isinstance(reason, (TimeoutError, socket.timeout)): return "mcp_timeout"
        return "mcp_unreachable"
    except Exception:
        return "mcp_protocol_error"
print(check())
`;

/** Authenticated startup never accepts a reachability-only result. */
export function checkWorkerMcp(
  execution: Extract<ExecutionConfig, { mode: "agent-ssh" }>,
  token: string,
): Promise<void> {
  if (typeof token !== "string" || !token)
    return Promise.reject(new WorkerMcpError("mcp_auth_failed"));
  return probeWorkerMcp(execution, token);
}

/** A human machine check needs no Assignment credential and grants no authority. */
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
    const command = await agentProcessCommand(execution, [
      execution.fileHelper?.python ?? execution.gitHelper?.python ?? "python3",
      "-I",
      "-B",
      "-c",
      probe,
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
