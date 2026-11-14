import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RuntimeTargetBinding } from "@cardigan/domain";

export interface ExecutionEnv {
  readonly HOME?: string | undefined;
  readonly CARDIGAN_RUNTIME_MODE?: string | undefined;
  readonly CARDIGAN_DATA_DIR?: string | undefined;
  readonly CARDIGAN_AGENT_ROOT?: string | undefined;
  readonly CARDIGAN_AGENT_GID?: string | undefined;
  readonly CARDIGAN_AGENT_MACHINE?: string | undefined;
  readonly CARDIGAN_AGENT_IDENTITY?: string | undefined;
  readonly CARDIGAN_AGENT_KNOWN_HOSTS?: string | undefined;
  readonly CARDIGAN_AGENT_NICE?: string | undefined;
}

export const defaultDataDirectory = (home = homedir()): string =>
  join(home, ".local", "share", "cardigan");

/** Application data is independent of the project cwd unless explicitly overridden. */
export function resolveDataDirectory(
  env: Pick<ExecutionEnv, "HOME" | "CARDIGAN_DATA_DIR"> = process.env,
  cwd = process.cwd(),
): string {
  const configured = env.CARDIGAN_DATA_DIR;
  return resolve(
    cwd,
    configured?.trim() ? configured : defaultDataDirectory(env.HOME),
  );
}
export type ExecutionConfig = {
  readonly agentNice?: number;
  readonly target?: RuntimeTargetBinding;
} & (
  | { readonly mode: "local"; readonly dataDir: string }
  | {
      readonly mode: "agent-ssh";
      readonly dataDir: string;
      readonly agentRoot: string;
      readonly gid: number;
      readonly machine: string;
      readonly identityFile: string;
      readonly knownHostsFile: string;
      /** Omitted fields preserve the local isolated-account SSH endpoint. */
      readonly host?: string;
      readonly port?: number;
      readonly user?: string;
      readonly hostKeyAlias?: string;
      readonly path?: string;
    }
);
export const LOCAL_RUNTIME_WARNING =
  "警告：local 模式没有 Agent 账号隔离，会继承主机账号的文件和凭据访问能力；生产运行请配置 agent-ssh。";
export const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export function within(parent: string, path: string): boolean {
  const part = relative(parent, path);
  return (
    part === "" ||
    (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
  );
}
export function resolveExecutionConfig(
  env: ExecutionEnv = process.env,
): ExecutionConfig {
  const mode = env.CARDIGAN_RUNTIME_MODE ?? "local";
  const dataDir = resolveDataDirectory(env);
  const configuredNice = env.CARDIGAN_AGENT_NICE;
  if (
    configuredNice !== undefined &&
    !/^(?:[0-9]|1[0-9])$/.test(configuredNice)
  )
    throw new Error("CARDIGAN_AGENT_NICE must be an integer from 0 to 19");
  const priority =
    configuredNice === undefined ? {} : { agentNice: Number(configuredNice) };
  if (mode === "local") return { mode, dataDir, ...priority };
  if (mode !== "agent-ssh")
    throw new Error("CARDIGAN_RUNTIME_MODE must be local or agent-ssh");
  const path = (value: string | undefined, name: string) => {
    if (!value || !isAbsolute(value) || resolve(value) === "/")
      throw new Error(`${name} must be an absolute non-root path`);
    return resolve(value);
  };
  const agentRoot = path(env.CARDIGAN_AGENT_ROOT, "CARDIGAN_AGENT_ROOT");
  const identityFile = path(
    env.CARDIGAN_AGENT_IDENTITY,
    "CARDIGAN_AGENT_IDENTITY",
  );
  const knownHostsFile = path(
    env.CARDIGAN_AGENT_KNOWN_HOSTS,
    "CARDIGAN_AGENT_KNOWN_HOSTS",
  );
  if (
    within(agentRoot, dataDir) ||
    within(dataDir, agentRoot) ||
    within(agentRoot, identityFile) ||
    within(agentRoot, knownHostsFile)
  )
    throw new Error(
      "Agent root must be separate from private data and SSH credentials",
    );
  const gid = Number(env.CARDIGAN_AGENT_GID);
  if (!Number.isSafeInteger(gid) || gid <= 0)
    throw new Error(
      "CARDIGAN_AGENT_GID must identify the dedicated shared group",
    );
  const machine = env.CARDIGAN_AGENT_MACHINE ?? "cardigan-agent";
  if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(machine) || machine === "local")
    throw new Error("Invalid agent machine name");
  return {
    mode,
    dataDir,
    agentRoot,
    gid,
    machine,
    identityFile,
    knownHostsFile,
    ...priority,
  };
}
export function executionPaths(
  config: ExecutionConfig,
  project: string,
  assignment: string,
) {
  if (
    !/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u.test(project) ||
    !/^A-[1-9][0-9]*$/u.test(assignment)
  )
    throw new Error("Invalid execution path component");
  const root = config.mode === "local" ? config.dataDir : config.agentRoot;
  const gitRoot = config.mode === "local" ? join(root, "agent") : root;
  return {
    runDir: join(root, "runs", project, assignment),
    repositoriesRoot: join(gitRoot, "repos"),
    worktreesRoot: join(gitRoot, "worktrees"),
    /** P2a-3: writable build checkouts of verifier Runs (`<root>/<project>/<A-n>`). */
    buildsRoot: join(gitRoot, "builds"),
  };
}
export function executionPermissions(config: ExecutionConfig) {
  return config.mode === "local"
    ? { parent: 0o700, directory: 0o700, file: 0o600, executable: 0o700 }
    : { parent: 0o2750, directory: 0o2770, file: 0o660, executable: 0o770 };
}
