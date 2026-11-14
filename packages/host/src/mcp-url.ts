/**
 * The card MCP endpoint written into Agent configs (C-211).
 *
 * Derived only from the host's own configuration: an explicit
 * `CARDIGAN_MCP_URL`, otherwise the loopback host and port the server listens
 * on (`CARDIGAN_MCP_HOST`, `CARDIGAN_MCP_PORT`). Nothing an Agent or a card
 * writes can reach these values, and a non-loopback host is refused just as
 * the server refuses to listen on one (§14).
 */
export const DEFAULT_MCP_HOST = "127.0.0.1";
export const DEFAULT_MCP_PORT = 3004;
export const MCP_PATH = "/mcp";
const LOOPBACK = ["127.0.0.1", "::1", "localhost"] as const;

export interface McpUrlEnv {
  readonly CARDIGAN_MCP_URL?: string | undefined;
  readonly CARDIGAN_MCP_HOST?: string | undefined;
  readonly CARDIGAN_MCP_PORT?: string | undefined;
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim().length === 0 ? undefined : value.trim();

/** `http://<host>:<port>/mcp`, bracketing an IPv6 host. */
export function mcpUrlFor(host: string, port: number): string {
  const shown = host.includes(":") ? `[${host}]` : host;
  return `http://${shown}:${port}${MCP_PATH}`;
}

/** The explicit `CARDIGAN_MCP_URL`, if one is set. */
export function explicitMcpUrl(env: McpUrlEnv): string | undefined {
  return nonEmpty(env.CARDIGAN_MCP_URL);
}

/**
 * Resolve the MCP URL from the environment. Port `0` (an OS-chosen port) has
 * no fixed address, so callers that cannot see the listener must set
 * `CARDIGAN_MCP_URL`.
 */
export function resolveMcpUrl(env: McpUrlEnv): string {
  const explicit = explicitMcpUrl(env);
  if (explicit !== undefined) return explicit;
  const hostText = nonEmpty(env.CARDIGAN_MCP_HOST);
  const host =
    hostText === undefined ? DEFAULT_MCP_HOST : hostText.toLowerCase();
  if (!(LOOPBACK as readonly string[]).includes(host))
    throw new Error(
      `CARDIGAN_MCP_HOST=${JSON.stringify(hostText)} 不是本机地址，无法推导 MCP 地址；只支持 127.0.0.1、::1、localhost`,
    );
  const portText = nonEmpty(env.CARDIGAN_MCP_PORT);
  const port = portText === undefined ? DEFAULT_MCP_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(
      `CARDIGAN_MCP_PORT=${JSON.stringify(portText)} 无法推导 MCP 地址（需要 1–65535 的整数）；端口为 0 时请设置 CARDIGAN_MCP_URL`,
    );
  return mcpUrlFor(host, port);
}
