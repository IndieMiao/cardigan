import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import {
  checkEnvironment,
  MIN_REDACTED_ENV_BYTES,
} from "./check-environment.js";
import {
  type ExecutorEntry,
  type MergeGateExecutor,
  parseMergeGateExecutors,
  resolveProjectExecutor,
} from "./merge-gate-executors.js";
import {
  type MergePushConfig,
  parseMergePushConfig,
} from "./merge-push-config.js";
import type { CheckoutCheck } from "./temporary-checkout.js";

export type ProjectMergeGate =
  | { readonly status: "disabled" }
  | { readonly status: "invalid"; readonly reason: string }
  | {
      readonly status: "enabled";
      readonly checks: readonly CheckoutCheck[];
      readonly env: Readonly<Record<string, string>>;
      readonly totalTimeoutMs: number;
      readonly push?: MergePushConfig;
      /** Absent for `executor: local` or no executor: exactly today's behavior. */
      readonly executor?: MergeGateExecutor;
    };
export interface MergeGateConfiguration {
  readonly errors: readonly string[];
  forProject(project: string): ProjectMergeGate;
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
function invalid(reason: string): never {
  throw new Error(reason);
}
const minutes = (value: unknown, fallback: number) => {
  const number = value === undefined ? fallback : value;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    number > Math.floor(2147483647 / 60_000)
  )
    invalid("超时必须为允许范围内的正整数分钟");
  return number * 60_000;
};
const only = (value: Record<string, unknown>, keys: readonly string[]) => {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    invalid("含有不支持的配置字段");
};
async function projectConfig(
  raw: unknown,
  dataDir: string,
  baseBranch: string,
  executors: ReadonlyMap<string, ExecutorEntry>,
): Promise<ProjectMergeGate> {
  if (!object(raw)) invalid("项目配置必须是对象");
  only(raw, ["checks", "env", "total_timeout_minutes", "push", "executor"]);
  const executor = resolveProjectExecutor(raw.executor, executors);
  if (!Array.isArray(raw.checks) || !raw.checks.length)
    invalid("checks 必须是非空列表");
  const names = new Set<string>();
  const checks = raw.checks.map((value: unknown) => {
    if (!object(value)) invalid("每条检查必须是对象");
    only(value, ["name", "run", "timeout_minutes"]);
    if (
      typeof value.name !== "string" ||
      !value.name.trim() ||
      names.has(value.name) ||
      typeof value.run !== "string" ||
      !value.run.trim() ||
      value.run.includes("\0")
    )
      invalid("检查名称须非空且唯一，run 须为非空字符串");
    names.add(value.name);
    return {
      name: value.name,
      run: value.run,
      timeoutMs: minutes(value.timeout_minutes, 30),
    };
  });
  if (raw.env !== undefined && !object(raw.env))
    invalid("env 必须是字符串映射");
  let env: Record<string, string>;
  try {
    env = checkEnvironment(raw.env as Record<string, string> | undefined);
  } catch {
    return invalid("env 包含非字符串、非法名称或受控运行变量");
  }
  if (
    Object.values(env).some(
      (value) =>
        value.length > 0 &&
        Buffer.byteLength(value, "utf8") < MIN_REDACTED_ENV_BYTES,
    )
  )
    invalid(
      `env 非空值必须至少 ${MIN_REDACTED_ENV_BYTES} 个 UTF-8 字节，短值不能可靠脱敏`,
    );
  return {
    status: "enabled",
    checks,
    env,
    totalTimeoutMs: minutes(raw.total_timeout_minutes, 60),
    ...(raw.push === undefined
      ? {}
      : { push: await parseMergePushConfig(raw.push, dataDir, baseBranch) }),
    ...(executor === undefined ? {} : { executor }),
  };
}

/** Read once at startup (or per CLI invocation). Invalid configured projects never become disabled. */
export async function loadMergeGateConfig(input: {
  readonly projectIds: readonly string[];
  readonly configDir?: string;
  readonly dataDir?: string;
  readonly baseBranches?: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<MergeGateConfiguration> {
  const env = input.env ?? process.env;
  const file = join(
    resolve(
      input.configDir ??
        env.CARDIGAN_CONFIG_DIR ??
        join(homedir(), ".config", "cardigan"),
    ),
    "merge-gate.yaml",
  );
  const projects = new Map<string, ProjectMergeGate>(),
    errors: string[] = [];
  let globalError: string | undefined;
  const result = (): MergeGateConfiguration => ({
    errors,
    forProject: (project) =>
      globalError
        ? { status: "invalid", reason: globalError }
        : (projects.get(project) ?? { status: "disabled" }),
  });
  let source: string;
  try {
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        ![0, process.getuid?.()].includes(info.uid) ||
        info.mode & 0o022 ||
        info.size > 1024 * 1024
      )
        throw new Error("Unsafe config file");
      for (let parent = dirname(file); ; parent = dirname(parent)) {
        const entry = await lstat(parent);
        if (
          !entry.isDirectory() ||
          ![0, process.getuid?.()].includes(entry.uid) ||
          (entry.mode & 0o022 && !(entry.mode & 0o1000))
        )
          throw new Error("Unsafe config directory");
        if (parent === dirname(parent)) break;
      }
      source = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result();
    globalError = "无法安全读取 merge-gate.yaml，所有项目暂停合并";
    errors.push(globalError);
    return result();
  }
  let raw: unknown;
  try {
    const document = parseDocument(source, { uniqueKeys: true, strict: true });
    if (document.errors.length || document.warnings.length)
      throw new Error("Invalid YAML");
    raw = document.toJS({ maxAliasCount: 0 });
  } catch {
    globalError = "merge-gate.yaml 语法无效，所有项目暂停合并";
    errors.push(globalError);
    return result();
  }
  if (
    !object(raw) ||
    !object(raw.projects) ||
    Object.keys(raw).some((key) => !["projects", "executors"].includes(key))
  ) {
    globalError =
      "merge-gate.yaml 顶层只能包含 projects 映射和可选的 executors 映射，所有项目暂停合并";
    errors.push(globalError);
    return result();
  }
  const dataDir =
    input.dataDir ??
    env.CARDIGAN_DATA_DIR ??
    join(homedir(), ".local/share/cardigan");
  let executors: ReadonlyMap<string, ExecutorEntry>;
  try {
    const parsed = await parseMergeGateExecutors(raw.executors, dataDir);
    executors = parsed.entries;
    errors.push(...parsed.errors);
  } catch (error) {
    globalError = `merge-gate.yaml 的 ${(error as Error).message}，所有项目暂停合并`;
    errors.push(globalError);
    return result();
  }
  for (const [project, value] of Object.entries(raw.projects)) {
    try {
      if (!input.projectIds.includes(project)) invalid("项目未登记");
      projects.set(
        project,
        await projectConfig(
          value,
          dataDir,
          input.baseBranches?.[project] ?? "main",
          executors,
        ),
      );
    } catch (error) {
      // Only validation messages from above; never echo YAML, commands or env values.
      const reason = `项目 ${project} 的合并闸门无效：${(error as Error).message}`;
      projects.set(project, { status: "invalid", reason });
      errors.push(reason);
    }
  }
  return result();
}
