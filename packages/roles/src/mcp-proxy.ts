/**
 * C-600: some harness HTTP clients (Codex) read the macOS system proxy but not
 * its exception list, so a Card MCP request to a tailnet address goes to the
 * local proxy and fails. Every launch therefore names the Card MCP host in
 * NO_PROXY/no_proxy: the clients that honour system proxies also honour these
 * variables, while the model API keeps using whatever proxy is configured.
 */
export const MCP_PROXY_BYPASS_KEYS = ["NO_PROXY", "no_proxy"] as const;

/** Host of the Card MCP URL as NO_PROXY spells it (no port, no brackets). */
export function mcpProxyBypassHost(url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  host = host.replace(/^\[(.*)\]$/u, "$1");
  return host && !/[\s,]/u.test(host) ? host : undefined;
}

/** Prepend `host` to a comma-separated NO_PROXY list, keeping other entries. */
export function withMcpProxyBypass(
  current: string | undefined,
  host: string,
): string {
  const entries = (current ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry && entry.toLowerCase() !== host);
  return [host, ...entries].join(",");
}
