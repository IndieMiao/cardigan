export const DEFAULT_DATA_DIR = ".data";
export const DEFAULT_MCP_HOST = "127.0.0.1";
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
    host: nonEmpty(env.CARDIGAN_MCP_HOST) ?? DEFAULT_MCP_HOST,
    port,
  };
}
