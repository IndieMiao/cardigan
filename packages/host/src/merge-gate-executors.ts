import { posix } from "node:path";
import type { AgentExecution, ExecutionConfig } from "@cardigan/runtime-herdr";
import { secureCredentialFile } from "./merge-push-config.js";

/** Parsed host-owned `executors.<name>` entry of merge-gate.yaml. */
export interface MergeGateExecutor {
  readonly name: string;
  /** Omitted in legacy SSH configurations. GitHub execution is reserved for D3. */
  readonly type?: "ssh" | "github";
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly hostKeyAlias: string;
  /** Absolute host path below the data directory, host-only 0600. */
  readonly identityFile: string;
  /** Absolute host path below the data directory, host-only 0600. */
  readonly knownHostsFile: string;
  /** Absolute POSIX path on the executor machine. */
  readonly agentRoot: string;
  readonly maxConcurrent: number;
}
export type ExecutorEntry =
  | { readonly status: "valid"; readonly executor: MergeGateExecutor }
  | { readonly status: "invalid"; readonly reason: string };

/** The implicit executor name meaning "today's behavior"; never configurable. */
export const LOCAL_EXECUTOR = "local";
export const MAX_EXECUTOR_CONCURRENCY = 16;

const fail = (message: string): never => {
  throw new Error(message);
};
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** Same shape as runtime machine names, so it can later double as a capacity bucket id. */
export const validExecutorName = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-z][a-z0-9_-]{0,31}$/u.test(value) &&
  value !== LOCAL_EXECUTOR;
/**
 * DNS-style host names and IPv4 literals only: no leading "-", whitespace,
 * "@", ":" or control characters, so the value can never become an ssh option or a second argument.
 */
const validHost = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 253 &&
  /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(value) &&
  !value.includes("..");
const validUser = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z_][a-z0-9_-]{0,31}$/u.test(value);
const validAgentRoot = (value: unknown): value is string =>
  typeof value === "string" &&
  value !== "/" &&
  /^\/[A-Za-z0-9._/-]+$/u.test(value) &&
  posix.normalize(value) === value &&
  !value.endsWith("/") &&
  !value.split("/").some((part) => part === "." || part === "..");
/**
 * ssh expands %-tokens and ${VAR} in -i / UserKnownHostsFile=, and -o values have their own quoting.
 * Mirrors the agent-ssh known_hosts rule (C-118 validateSshConfig) on the resolved absolute path,
 * so a configuration that loads here is never rejected later when the SSH command is built.
 */
const sshLiteralPath = (path: string) =>
  posix.isAbsolute(path) &&
  path !== "/" &&
  !/[\s\p{Cc}\p{Cf}"'\\%$]/u.test(path);
const integer = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  message: string,
) => {
  const number = value === undefined ? fallback : value;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < min ||
    number > max
  )
    fail(message);
  return number as number;
};

async function parseExecutor(
  name: string,
  raw: unknown,
  dataDir: string,
): Promise<MergeGateExecutor> {
  if (!object(raw)) fail("执行目标配置必须是对象");
  const entry = raw as Record<string, unknown>;
  const keys = [
    "type",
    "host",
    "port",
    "user",
    "host_key_alias",
    "identity_file",
    "known_hosts_file",
    "agent_root",
    "max_concurrent",
  ];
  if (Object.keys(entry).some((key) => !keys.includes(key)))
    fail("含有不支持的配置字段");
  if (
    entry.type !== undefined &&
    entry.type !== "ssh" &&
    entry.type !== "github"
  )
    fail("type 必须是 ssh 或 github");
  if (entry.type === "github")
    fail("GitHub 检查执行器尚未启用，不会回退到 SSH");
  if (!validHost(entry.host))
    fail("host 必须是主机名或 IPv4 地址，不能以 - 开头，不能含空白或换行");
  const user = entry.user ?? "agent";
  if (!validUser(user))
    fail("user 必须是小写字母开头的账号名，不能以 - 开头，不能含空白或换行");
  const hostKeyAlias = entry.host_key_alias ?? entry.host;
  if (!validHost(hostKeyAlias))
    fail("host_key_alias 必须是主机名，不能以 - 开头，不能含空白或换行");
  if (!validAgentRoot(entry.agent_root))
    fail(
      "agent_root 必须是规范化的绝对路径，不能是根目录，只能含字母、数字和 . _ - /",
    );
  const port = integer(
    entry.port,
    22,
    1,
    65535,
    "port 必须是 1 到 65535 的整数",
  );
  const maxConcurrent = integer(
    entry.max_concurrent,
    1,
    1,
    MAX_EXECUTOR_CONCURRENCY,
    `max_concurrent 必须是 1 到 ${MAX_EXECUTOR_CONCURRENCY} 的整数`,
  );
  const credential = async (field: string) => {
    let file: string;
    try {
      file = await secureCredentialFile(dataDir, entry[field]);
    } catch {
      // Never echo the configured path or filesystem errors.
      return fail(
        `${field} 无效：路径须相对数据目录且无链接，文件 0600、目录 0700，属主须为主机账号`,
      );
    }
    if (!sshLiteralPath(file))
      fail(
        `${field} 无效：数据目录和文件名的完整路径不能含空白、控制字符、引号、反斜杠、% 或 $`,
      );
    return file;
  };
  const identityFile = await credential("identity_file");
  const knownHostsFile = await credential("known_hosts_file");
  if (identityFile === knownHostsFile)
    fail("identity_file 和 known_hosts_file 不能是同一个文件");
  return {
    name,
    ...(entry.type === "ssh" ? { type: "ssh" as const } : {}),
    host: entry.host as string,
    port,
    user: user as string,
    hostKeyAlias: hostKeyAlias as string,
    identityFile,
    knownHostsFile,
    agentRoot: entry.agent_root as string,
    maxConcurrent,
  };
}

/**
 * Parse the optional top-level `executors` mapping. A malformed mapping throws (the whole file fails closed);
 * a bad individual entry only invalidates the projects that reference it.
 */
export async function parseMergeGateExecutors(
  raw: unknown,
  dataDir: string,
): Promise<{
  readonly entries: ReadonlyMap<string, ExecutorEntry>;
  readonly errors: readonly string[];
}> {
  const entries = new Map<string, ExecutorEntry>(),
    errors: string[] = [];
  if (raw === undefined) return { entries, errors };
  if (!object(raw)) return fail("executors 必须是映射");
  for (const [name, value] of Object.entries(raw)) {
    if (!validExecutorName(name))
      // The key failed validation, so it is not echoed.
      return fail(
        "executors 含有无效的执行目标名称：须为小写字母开头的 1-32 位字母、数字、_ 或 -，且不能是 local",
      );
    try {
      entries.set(name, {
        status: "valid",
        executor: await parseExecutor(name, value, dataDir),
      });
    } catch (error) {
      const reason = `执行目标 ${name} 无效：${(error as Error).message}`;
      entries.set(name, { status: "invalid", reason });
      errors.push(reason);
    }
  }
  return { entries, errors };
}

/** `undefined` means the project keeps today's behavior (no executor or `local`). */
export function resolveProjectExecutor(
  value: unknown,
  entries: ReadonlyMap<string, ExecutorEntry>,
): MergeGateExecutor | undefined {
  if (value === undefined || value === LOCAL_EXECUTOR) return undefined;
  if (typeof value !== "string" || !validExecutorName(value))
    return fail("executor 必须是 local 或 executors 中定义的执行目标名称");
  const entry = entries.get(value);
  if (!entry)
    return fail(`executor 引用了不存在的执行目标 ${value}，不会回退到本机`);
  if (entry.status === "invalid")
    return fail(`${entry.reason}，不会回退到本机`);
  return entry.executor;
}

/**
 * P2a-12 C: the agent-ssh execution for a project's merge-check executor.
 * Host-side fields (data directory, shared group, niceness) come from the
 * server's default execution; the SSH target, credentials and agent root come
 * from the executor. The machine name is the executor name.
 */
export function executorExecution(
  executor: MergeGateExecutor,
  base: ExecutionConfig,
): AgentExecution {
  if (executor.type === "github")
    throw new Error("GitHub 检查执行器不能通过 SSH 执行");
  return {
    mode: "agent-ssh",
    dataDir: base.dataDir,
    agentRoot: executor.agentRoot,
    gid: base.mode === "agent-ssh" ? base.gid : (process.getgid?.() ?? 0),
    machine: executor.name,
    identityFile: executor.identityFile,
    knownHostsFile: executor.knownHostsFile,
    host: executor.host,
    port: executor.port,
    user: executor.user,
    hostKeyAlias: executor.hostKeyAlias,
    ...(base.agentNice === undefined ? {} : { agentNice: base.agentNice }),
  };
}
