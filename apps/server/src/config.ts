export const DEFAULT_DATA_DIR = ".data";
/**
 * M1 only listens on this machine (§3, §9.1): LAN listening arrives with the
 * multi-machine phase and needs TLS or a private network on top.
 */
export const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"] as const;
export const DEFAULT_MCP_HOST = "127.0.0.1";
export const LOCAL_ONLY_HINT =
  "M1 只支持本机监听（127.0.0.1、::1、localhost）；监听局域网/所有网卡属于 Phase 2 的多机范围，需要配合 TLS 或私有网络";
export const DEFAULT_MCP_PORT = 3004;

export interface ServerConfig {
  readonly dataDir: string;
  /** Loopback by default; the MCP endpoint is never exposed publicly (§14). */
  readonly host: string;
  /** `0` asks the OS for a free port (tests). */
  readonly port: number;
}

export interface ServerEnv {
  readonly CARDIGAN_DATA_DIR?: string | undefined;
  readonly CARDIGAN_MCP_HOST?: string | undefined;
  readonly CARDIGAN_MCP_PORT?: string | undefined;
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim().length === 0 ? undefined : value.trim();

/** Read the server configuration from the environment (§3, §13.1). */
export function resolveServerConfig(env: ServerEnv): ServerConfig {
  const portText = nonEmpty(env.CARDIGAN_MCP_PORT);
  const port = portText === undefined ? DEFAULT_MCP_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `CARDIGAN_MCP_PORT must be an integer between 0 and 65535, got ${JSON.stringify(portText)}`,
    );
  }
  return {
    dataDir: nonEmpty(env.CARDIGAN_DATA_DIR) ?? DEFAULT_DATA_DIR,
    host: resolveHost(env.CARDIGAN_MCP_HOST),
    port,
  };
}

/**
 * Accept only loopback addresses. `0.0.0.0`, `::` and LAN addresses would put
 * the MCP endpoint on the network, which M1 must not do.
 */
function resolveHost(value: string | undefined): string {
  const requested = nonEmpty(value);
  if (requested === undefined) {
    return DEFAULT_MCP_HOST;
  }
  const normalized = requested.toLowerCase();
  if ((LOOPBACK_HOSTS as readonly string[]).includes(normalized)) {
    return normalized;
  }
  throw new Error(
    `CARDIGAN_MCP_HOST=${JSON.stringify(requested)} 不受支持。${LOCAL_ONLY_HINT}`,
  );
}
