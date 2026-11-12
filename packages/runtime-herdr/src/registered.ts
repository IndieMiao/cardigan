import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeRef } from "@cardigan/domain";
import type { ExecutionConfig } from "./execution.js";

/**
 * C-152: the runtime the server registered for this data directory. The server
 * writes it on startup; CLI commands that open or enter a terminal compare
 * their own environment against it instead of silently falling back to local.
 */
export const REGISTERED_RUNTIME_FILE = "runtime.json";

/** hc session used when neither the server nor the shell names one. */
export const DEFAULT_HC_SESSION = "cardigan";

export type RegisteredRuntime = {
  /** The server's hc session: existing terminals are found only inside it. */
  readonly session: string;
} & (
  | { readonly mode: "local" }
  | {
      readonly mode: "agent-ssh";
      readonly machine: string;
      readonly agentRoot: string;
      readonly gid: number;
      readonly identityFile: string;
      readonly knownHostsFile: string;
      readonly host?: string;
      readonly port?: number;
      readonly user?: string;
      readonly hostKeyAlias?: string;
    }
);

/** The non-secret fields that decide where and as whom terminals run. */
export function registeredRuntimeOf(
  config: ExecutionConfig,
  session: string = DEFAULT_HC_SESSION,
): RegisteredRuntime {
  if (config.mode === "local") return { mode: "local", session };
  return {
    mode: "agent-ssh",
    session,
    machine: config.machine,
    agentRoot: config.agentRoot,
    gid: config.gid,
    identityFile: config.identityFile,
    knownHostsFile: config.knownHostsFile,
    ...(config.host === undefined ? {} : { host: config.host }),
    ...(config.port === undefined ? {} : { port: config.port }),
    ...(config.user === undefined ? {} : { user: config.user }),
    ...(config.hostKeyAlias === undefined
      ? {}
      : { hostKeyAlias: config.hostKeyAlias }),
  };
}

/** hc machine name a runtime places terminals on. */
export const runtimeMachineOf = (
  config: Pick<ExecutionConfig, "mode"> & { readonly machine?: string },
): string =>
  config.mode === "local" ? "local" : (config.machine ?? "cardigan-agent");

/** Whether a recorded terminal belongs to the runtime described by `config`. */
export const runtimeOwnsRef = (
  config: Pick<ExecutionConfig, "mode"> & { readonly machine?: string },
  ref: Pick<RuntimeRef, "machine_id" | "runtime_machine">,
): boolean =>
  ref.machine_id === "local" &&
  ref.runtime_machine === runtimeMachineOf(config);

/** Human-readable label, e.g. `agent-ssh（机器 cardigan-agent）`. */
export const describeRuntime = (
  config: Pick<ExecutionConfig, "mode"> & { readonly machine?: string },
): string =>
  config.mode === "local"
    ? "local（本机、当前账号）"
    : `agent-ssh（机器 ${runtimeMachineOf(config)}）`;

/** Atomically record the server's runtime in the private data directory. */
export async function writeRegisteredRuntime(
  dataDir: string,
  config: ExecutionConfig,
  session: string = DEFAULT_HC_SESSION,
): Promise<void> {
  const target = join(dataDir, REGISTERED_RUNTIME_FILE);
  const temp = join(dataDir, `.${REGISTERED_RUNTIME_FILE}.${randomUUID()}`);
  try {
    await writeFile(
      temp,
      `${JSON.stringify(registeredRuntimeOf(config, session), null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
}

/** `undefined` when no server has registered a runtime in this data directory. */
export async function readRegisteredRuntime(
  dataDir: string,
): Promise<RegisteredRuntime | undefined> {
  const path = join(dataDir, REGISTERED_RUNTIME_FILE);
  let text: string;
  try {
    const entry = await lstat(path);
    if (!entry.isFile()) throw new Error(`${path} must be a regular file`);
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = JSON.parse(text) as Partial<Record<string, unknown>>;
  // Registrations written before C-152 rework had no session: the default.
  const session =
    typeof parsed.session === "string" && parsed.session.length > 0
      ? parsed.session
      : DEFAULT_HC_SESSION;
  if (parsed.mode === "local") return { mode: "local", session };
  const str = (key: string) => {
    const value = parsed[key];
    if (typeof value !== "string" || value.length === 0)
      throw new Error(`${path}: ${key} is missing`);
    return value;
  };
  if (parsed.mode !== "agent-ssh")
    throw new Error(`${path}: mode must be local or agent-ssh`);
  const gid = parsed.gid;
  if (typeof gid !== "number" || !Number.isSafeInteger(gid))
    throw new Error(`${path}: gid is missing`);
  const optional = (key: "host" | "user" | "hostKeyAlias") =>
    typeof parsed[key] === "string" ? { [key]: parsed[key] as string } : {};
  return {
    mode: "agent-ssh",
    session,
    machine: str("machine"),
    agentRoot: str("agentRoot"),
    gid,
    identityFile: str("identityFile"),
    knownHostsFile: str("knownHostsFile"),
    ...optional("host"),
    ...(typeof parsed.port === "number" ? { port: parsed.port } : {}),
    ...optional("user"),
    ...optional("hostKeyAlias"),
  };
}

const FIELD_ENV: Record<string, string> = {
  session: "CARDIGAN_HC_SESSION（或 --hc-session）",
  mode: "CARDIGAN_RUNTIME_MODE",
  machine: "CARDIGAN_AGENT_MACHINE",
  agentRoot: "CARDIGAN_AGENT_ROOT",
  gid: "CARDIGAN_AGENT_GID",
  identityFile: "CARDIGAN_AGENT_IDENTITY",
  knownHostsFile: "CARDIGAN_AGENT_KNOWN_HOSTS",
  host: "host",
  port: "port",
  user: "user",
  hostKeyAlias: "hostKeyAlias",
};

/** Field-by-field differences, worded for the person who has to fix the shell. */
export function runtimeDifferences(
  registered: RegisteredRuntime,
  current: ExecutionConfig,
  session: string = DEFAULT_HC_SESSION,
): string[] {
  const mine = registeredRuntimeOf(current, session) as Record<string, unknown>;
  const theirs = registered as Record<string, unknown>;
  const keys = new Set([...Object.keys(mine), ...Object.keys(theirs)]);
  const show = (value: unknown) =>
    value === undefined ? "（未设置）" : String(value);
  return [...keys]
    .filter((key) => mine[key] !== theirs[key])
    .map(
      (key) =>
        `${FIELD_ENV[key] ?? key}：server 登记为 ${show(theirs[key])}，当前 shell 为 ${show(mine[key])}`,
    );
}
