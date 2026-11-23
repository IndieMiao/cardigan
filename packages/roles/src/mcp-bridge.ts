import { MCP_SESSION_HEADER } from "@cardigan/domain";

/**
 * C-600: Codex reads the macOS system proxy but not its exception list, so its
 * own HTTP client sent the Card MCP connection to a local proxy that cannot
 * reach the tailnet. Proxy variables are inherited by every process of the
 * session and clients disagree on how to read them, so no environment change
 * can make only the Card connection direct. Instead Codex starts this bridge
 * as a stdio MCP server for the session: it forwards each JSON-RPC message to
 * the configured Card MCP address and writes the reply back.
 *
 * `card_post` is the one Card connection. `http.client` has no proxy support,
 * so no environment or system proxy setting can take the connection elsewhere,
 * and a redirect reply is returned, never followed. Remote addresses must be
 * HTTPS with the default certificate and hostname verification; plain HTTP is
 * accepted for loopback only. The launch preflight and the machine check run
 * `probe` from this same source, so all three take the same route.
 *
 * The Token comes from the bridge's environment (`MCP_TOKEN`, forwarded by
 * Codex `env_vars`), the session key from `MCP_BRIDGE_SESSION_ENV` set in the
 * server's own config table: neither is in the process arguments, and neither
 * is written to stderr or into an error reply. The bridge lives as long as the
 * Codex session that started it: no listener, port or background process.
 *
 * Python 3.8+ (macOS Command Line Tools ship 3.9). No backticks in the source.
 */
export const MCP_BRIDGE_SOURCE = String.raw`import http.client, ipaddress, json, os, socket, ssl, sys, threading, urllib.parse

SESSION_HEADER = ${JSON.stringify(MCP_SESSION_HEADER)}
SESSION_ENV = "CARDIGAN_MCP_SESSION"
REPLY_LIMIT = 64 << 20
BRIDGE_TIMEOUT = 300

class Refused(Exception):
    pass

def loopback(host):
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False

def card_post(url, token, session, payload, timeout, limit, version=None):
    # The only Card MCP connection: straight to the configured address.
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname or ""
    if parts.username is not None or parts.password is not None or not host:
        raise Refused()
    if parts.scheme == "https":
        connection = http.client.HTTPSConnection(host, parts.port, timeout=timeout,
            context=ssl.create_default_context())
    elif parts.scheme == "http" and loopback(host):
        connection = http.client.HTTPConnection(host, parts.port, timeout=timeout)
    else:
        raise Refused()
    try:
        path = (parts.path or "/") + ("?" + parts.query if parts.query else "")
        connection.putrequest("POST", path, skip_host=True, skip_accept_encoding=True)
        connection.putheader("Host", parts.netloc)
        connection.putheader("Content-Type", "application/json")
        connection.putheader("Accept", "application/json, text/event-stream")
        if token:
            connection.putheader("Authorization", "Bearer " + token)
        if session:
            connection.putheader(SESSION_HEADER, session)
        if version:
            connection.putheader("MCP-Protocol-Version", version)
        connection.putheader("Content-Length", str(len(payload)))
        connection.endheaders(payload)
        response = connection.getresponse()
        raw = response.read(limit + 1)
        length = response.getheader("Content-Length", "")
        if length.isdecimal() and len(raw) < min(limit + 1, int(length)):
            raise http.client.IncompleteRead(raw)
        return (response.status, response.getheader("Content-Type", ""),
            response.getheader("WWW-Authenticate"), raw)
    finally:
        connection.close()

def failure(error):
    if isinstance(error, Refused):
        return "mcp_config_invalid"
    if isinstance(error, http.client.HTTPException):
        return "mcp_gateway_error"
    if isinstance(error, ssl.SSLError):
        return "mcp_tls_failed"
    if isinstance(error, (socket.timeout, TimeoutError)):
        return "mcp_timeout"
    if isinstance(error, OSError):
        return "mcp_unreachable"
    return "mcp_protocol_error"

def probe():
    # initialize authenticates without acknowledging a Run or touching activity.
    try:
        data = json.load(sys.stdin)
        url, timeout = data["url"], data["timeoutMs"] / 1000
        authenticate = data["authenticate"] is True
        token = data["token"] if authenticate else None
    except Exception:
        return "mcp_worker_failed"
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-03-26", "capabilities": {},
        "clientInfo": {"name": "cardigan-worker-preflight", "version": "1"}}}).encode()
    try:
        status, _, challenge, raw = card_post(url, token, None, body, timeout, 65536)
    except Exception as error:
        return failure(error)
    if 500 <= status < 600:
        return "mcp_gateway_error"
    if status == 401 and not authenticate:
        try:
            if (len(raw) <= 65536 and challenge == "Bearer"
                    and json.loads(raw).get("error", {}).get("code") == "unauthorized"):
                return "ok"
        except Exception:
            pass
        return "mcp_protocol_error"
    if status in (401, 403):
        return "mcp_auth_failed"
    if 300 <= status < 400:
        return "mcp_redirect"
    if status != 200 or not authenticate or len(raw) > 65536:
        return "mcp_protocol_error"
    try:
        reply = json.loads(raw)
        result = reply.get("result", {})
        if (reply.get("jsonrpc") != "2.0" or reply.get("id") != 1 or "error" in reply
                or result.get("serverInfo", {}).get("name") != "cardigan"
                or result.get("protocolVersion") != "2025-03-26"):
            return "mcp_protocol_error"
    except Exception:
        return "mcp_protocol_error"
    return "ok"

def decode(content_type, raw):
    if not raw.strip():
        return []
    if content_type.split(";")[0].strip().lower() == "text/event-stream":
        messages, data = [], []
        for line in raw.decode("utf-8").splitlines() + [""]:
            if not line:
                if data:
                    messages.append(json.loads("\n".join(data)))
                data = []
            elif line.startswith("data:"):
                data.append(line[6:] if line.startswith("data: ") else line[5:])
    else:
        messages = [json.loads(raw)]
    flat = []
    for message in messages:
        flat.extend(message if isinstance(message, list) else [message])
    return [message for message in flat if isinstance(message, dict)]

def bridge(url):
    token = os.environ.get("MCP_TOKEN", "")
    session = os.environ.get(SESSION_ENV) or None
    out = sys.stdout.buffer
    lock = threading.Lock()
    state = {"version": None}

    def emit(message):
        line = json.dumps(message, separators=(",", ":")).encode() + b"\n"
        with lock:
            out.write(line)
            out.flush()

    def error(ident, text):
        emit({"jsonrpc": "2.0", "id": ident, "error": {"code": -32000, "message": text}})

    def handle(line):
        try:
            message = json.loads(line)
        except ValueError:
            emit({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
            return
        batch = message if isinstance(message, list) else [message]
        pending = {}
        for item in batch:
            if isinstance(item, dict) and "method" in item and item.get("id") is not None:
                pending[json.dumps(item["id"])] = item
        try:
            status, content_type, _, raw = card_post(url, token, session, line,
                BRIDGE_TIMEOUT, REPLY_LIMIT, state["version"])
            replies = decode(content_type, raw)
        except Exception as caught:
            for item in pending.values():
                error(item["id"], "Card MCP 连接失败：" + failure(caught))
            return
        for reply in replies:
            key = json.dumps(reply.get("id"))
            if key not in pending and not (200 <= status < 300):
                continue
            request = pending.pop(key, None)
            result = reply.get("result")
            if (request is not None and request.get("method") == "initialize"
                    and isinstance(result, dict)
                    and isinstance(result.get("protocolVersion"), str)):
                state["version"] = result["protocolVersion"]
            emit(reply)
        for item in pending.values():
            error(item["id"], "Card MCP 未返回结果：HTTP " + str(status))

    for line in iter(sys.stdin.buffer.readline, b""):
        if line.strip():
            threading.Thread(target=handle, args=(line.strip(),), daemon=True).start()
    # The client closed the session: leave without racing in-flight writers.
    with lock:
        os._exit(0)

if __name__ == "__main__":
    if sys.argv[1:2] == ["bridge"] and len(sys.argv) == 3:
        bridge(sys.argv[2])
    elif sys.argv[1:] == ["probe"]:
        print(probe())
    else:
        sys.exit(2)
`;

/** Environment variable of the bridge process that carries the session key. */
export const MCP_BRIDGE_SESSION_ENV = "CARDIGAN_MCP_SESSION";

/** Interpreter for the bridge when the launch names none (local machine). */
export const DEFAULT_MCP_BRIDGE_PYTHON = "/usr/bin/python3";

/** Interpreter arguments that run the bridge for `url` on stdio. */
export function mcpBridgeArgs(url: string): string[] {
  return ["-I", "-B", "-c", MCP_BRIDGE_SOURCE, "bridge", url];
}

/** Interpreter arguments for the preflight probe; the request is on stdin. */
export const MCP_BRIDGE_PROBE_ARGS: readonly string[] = [
  "-I",
  "-B",
  "-c",
  MCP_BRIDGE_SOURCE,
  "probe",
];

const LOOPBACK_NAMES = new Set(["localhost"]);
function loopbackHost(host: string): boolean {
  if (LOOPBACK_NAMES.has(host)) return true;
  const bare = host.replace(/^\[(.*)\]$/u, "$1");
  if (bare === "::1") return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(bare);
  return (
    octets !== null &&
    octets[1] === "127" &&
    octets.slice(2).every((octet) => Number(octet) <= 255)
  );
}

/**
 * Whether `card_post` accepts `url`: HTTPS anywhere, plain HTTP on loopback
 * only, no credentials in the address. The launch refuses other addresses
 * before any material exists rather than start a session without Card tools.
 */
export function mcpBridgeAccepts(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || !parsed.hostname) return false;
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && loopbackHost(parsed.hostname);
}
