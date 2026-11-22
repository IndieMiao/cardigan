import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface MergePushConfig {
  readonly remote: string;
  /** Remote branch that receives the push. */
  readonly branch: string;
  /** Central baseline branch this route publishes (cards with this `base_branch`). */
  readonly baseBranch: string;
  readonly target: string;
  readonly keyFile?: string;
  readonly knownHostsFile?: string;
}
const fail = (message: string): never => {
  throw new Error(message);
};
export function validPushBranch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "@" &&
    !value.startsWith("-") &&
    !/[\s~^:?*[\\]/u.test(value) &&
    ![...value].some((c) => c.charCodeAt(0) < 33 || c.charCodeAt(0) === 127) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.endsWith(".") &&
    value
      .split("/")
      .every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}
/** Permit explicit SSH endpoints and local file URLs; never remote helpers or credential URLs. */
export function pushProtocol(remote: unknown): "file" | "ssh" {
  if (
    typeof remote !== "string" ||
    [...remote].some((c) => c.charCodeAt(0) < 33 || c.charCodeAt(0) === 127)
  )
    return fail("push.remote 必须是 SSH 地址或本地 file:// URL");
  if (remote.startsWith("file://") || remote.startsWith("ssh://")) {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      return fail("push.remote URL 无效");
    }
    if (
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname ||
      url.pathname === "/"
    )
      return fail("push.remote 不允许密码、查询参数或空仓库路径");
    if (url.protocol === "file:") {
      if (url.host || url.username)
        return fail("file:// 远程必须是本地绝对路径");
      return "file";
    }
    if (!url.hostname || url.hostname.startsWith("-"))
      return fail("push.remote 主机无效");
    return "ssh";
  }
  if (
    /^(?:[a-zA-Z0-9._-]+@)?[a-zA-Z0-9][a-zA-Z0-9.-]*:[^/:][^\s]*$/u.test(remote)
  )
    return "ssh";
  return fail("push.remote 必须是显式 SSH 地址或本地 file:// URL");
}
/**
 * Resolve a host-only credential file below the data directory (deploy keys, executor SSH keys, known_hosts).
 * Metadata only: never read key bytes, not even for validation or diagnostics.
 */
export async function secureCredentialFile(
  dataDir: string,
  name: unknown,
): Promise<string> {
  if (
    typeof name !== "string" ||
    !name ||
    isAbsolute(name) ||
    [...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    return fail("凭据路径必须相对数据目录");
  const root = resolve(dataDir),
    file = resolve(root, name),
    part = relative(root, file);
  if (!part || part === ".." || part.startsWith(`..${sep}`))
    return fail("凭据不能越出数据目录");
  for (let path = file; ; path = dirname(path)) {
    const entry = await lstat(path);
    if (path === file) {
      if (
        !entry.isFile() ||
        entry.nlink !== 1 ||
        entry.uid !== process.getuid?.() ||
        (entry.mode & 0o7777) !== 0o600
      )
        return fail("凭据必须是主机独占的普通文件，权限 0600，不能是链接");
    } else if (
      !entry.isDirectory() ||
      (path === root || path.startsWith(root + sep)
        ? entry.uid !== process.getuid?.() || (entry.mode & 0o7777) !== 0o700
        : ![0, process.getuid?.()].includes(entry.uid) ||
          Boolean(entry.mode & 0o022 && !(entry.mode & 0o1000)))
    ) {
      return fail(
        "凭据目录须为主机独占的 0700 目录，祖先不能是链接或不可信可写目录",
      );
    }
    if (path === dirname(path)) break;
  }
  return file;
}
export async function parseMergePushConfig(
  raw: unknown,
  dataDir: string,
  baseBranch = "main",
): Promise<MergePushConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return fail("push 必须是对象");
  const p = raw as Record<string, unknown>;
  if (
    Object.keys(p).some(
      (key) =>
        ![
          "remote",
          "branch",
          "base_branch",
          "key_file",
          "known_hosts_file",
        ].includes(key),
    )
  )
    return fail("push 含有不支持的字段");
  const source = p.base_branch ?? baseBranch;
  if (!validPushBranch(source))
    return fail("push.base_branch 不是有效的分支名");
  const protocol = pushProtocol(p.remote),
    remote = p.remote as string,
    // Default: the remote branch of the same name as the central branch.
    branch = p.branch ?? source;
  if (!validPushBranch(branch)) return fail("push.branch 不是有效的分支名");
  let keys: Pick<MergePushConfig, "keyFile" | "knownHostsFile"> = {};
  if (
    protocol === "ssh" ||
    p.key_file !== undefined ||
    p.known_hosts_file !== undefined
  ) {
    try {
      keys = {
        keyFile: await secureCredentialFile(dataDir, p.key_file),
        knownHostsFile: await secureCredentialFile(dataDir, p.known_hosts_file),
      };
    } catch {
      return fail(
        "push 凭据无效：路径须在数据目录内且无链接，文件 0600、目录 0700，属主须为主机账号",
      );
    }
  }
  return {
    remote,
    branch,
    baseBranch: source,
    ...keys,
    target: createHash("sha256")
      .update(JSON.stringify([remote, branch]))
      .digest("hex"),
  };
}
/** Recheck paths immediately before Git starts, without accepting a cached permission decision. */
export async function validateMergePushConfig(
  config: MergePushConfig,
  dataDir: string,
): Promise<void> {
  await parseMergePushConfig(
    {
      remote: config.remote,
      branch: config.branch,
      base_branch: config.baseBranch,
      ...(config.keyFile
        ? { key_file: relative(resolve(dataDir), config.keyFile) }
        : {}),
      ...(config.knownHostsFile
        ? {
            known_hosts_file: relative(resolve(dataDir), config.knownHostsFile),
          }
        : {}),
    },
    dataDir,
  );
}

/**
 * `push` is one route or a list of routes. Each central baseline branch pushes
 * through at most one route, and two routes never share a remote branch.
 * Branches without a route merge only in the central repository.
 */
export async function parseMergePushRoutes(
  raw: unknown,
  dataDir: string,
  baseBranch = "main",
): Promise<readonly MergePushConfig[]> {
  const entries = Array.isArray(raw) ? raw : [raw];
  if (!entries.length) return fail("push 列表不能为空");
  const routes: MergePushConfig[] = [];
  for (const entry of entries)
    routes.push(await parseMergePushConfig(entry, dataDir, baseBranch));
  if (new Set(routes.map((r) => r.baseBranch)).size !== routes.length)
    return fail("同一个 base_branch 只能配置一个推送目标");
  if (new Set(routes.map((r) => r.target)).size !== routes.length)
    return fail("两个推送目标不能指向同一远程分支");
  return routes;
}
