import { explicitMcpUrl, type McpUrlEnv, mcpUrlFor } from "@cardigan/host";

/**
 * The server's MCP URL for Agents: an explicit `CARDIGAN_MCP_URL`, else the
 * address the listener reports, else (before startup returns, while the
 * dispatch loop may already run) the configured host and port it binds to.
 */
export function listenerMcpUrl(
  env: McpUrlEnv,
  config: { readonly host: string; readonly port: number },
  listening: () => string | undefined,
): () => string {
  return () =>
    explicitMcpUrl(env) ?? listening() ?? mcpUrlFor(config.host, config.port);
}
