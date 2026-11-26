import { createHash } from "node:crypto";
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
  validExecutorName,
} from "./merge-gate-executors.js";
import {
  type MergePushConfig,
  parseMergePushRoutes,
} from "./merge-push-config.js";
import type { CheckoutCheck } from "./temporary-checkout.js";

export interface MergeGateCheck extends CheckoutCheck {
  /** Only used when the merge queue is enabled; absent means both tiers. */
  readonly tiers?: readonly ("card" | "batch")[];
  readonly scope?: "affected";
  readonly skipDocsOnly?: boolean;
}

/**
 * C-798: fingerprint of what one check step executes: its name, command and
 * timeout. A card check reuses a precheck only when every card-tier step
 * still has the fingerprint the precheck ran with. Selection metadata (tiers,
 * scope, docs-only skipping) is not part of it: the precheck always runs the
 * step in full. Environment values are deliberately excluded so no digest of
 * a secret is ever recorded.
 */
export function checkStepFingerprint(
  step: Pick<CheckoutCheck, "name" | "run" | "timeoutMs">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "cardigan.check-step.v1",
        step.name,
        step.run,
        step.timeoutMs ?? null,
      ]),
    )
    .digest("hex");
}

export interface MergeGateAffected {
  /** Package directory -> directories of additional dependent packages. */
  readonly extraDependents?: Readonly<Record<string, readonly string[]>>;
}

export type ProjectMergeGate =
  | { readonly status: "disabled" }
  | { readonly status: "invalid"; readonly reason: string }
  | {
      readonly status: "enabled";
      readonly checks: readonly MergeGateCheck[];
      readonly env: Readonly<Record<string, string>>;
      readonly totalTimeoutMs: number;
      /** Push routes, at most one per central baseline branch. */
      readonly push?: readonly MergePushConfig[];
      /** Absent for `executor: local` or no executor: exactly today's behavior. */
      readonly executor?: MergeGateExecutor;
      readonly affected?: MergeGateAffected;
      readonly queue?: {
        readonly maxBatchSize: number;
        readonly conflictThreshold: number;
        readonly windowTimeoutMs: number;
        /** C-803: how long one window may hold a card before it may join a batch. */
        readonly windowHoldLimitMs: number;
        /** C-781: absent means a card check reuses a passed same-head precheck. */
        readonly reusePrecheck?: false;
      };
    };
export interface MergeGateConfiguration {
  readonly errors: readonly string[];
  forProject(project: string): ProjectMergeGate;
  /** Retained host configuration for maintenance after a project changes executor. */
  forExecutor?(name: string): MergeGateExecutor | undefined;
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
function parseTiers(value: unknown): readonly ("card" | "batch")[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 2 ||
    new Set(value).size !== value.length
  )
    invalid("tiers 必须是由 card、batch 组成的非空且不重复的列表");
  return value.map((tier: unknown) => {
    if (tier !== "card" && tier !== "batch")
      invalid("tiers 只允许 card 和 batch");
    return tier;
  });
}
const packageDirectory = (value: unknown): value is string =>
  typeof value === "string" && /^(packages|apps)\/[a-z0-9-]+$/u.test(value);
function parseAffected(value: unknown): MergeGateAffected {
  if (!object(value)) invalid("affected 必须是对象");
  only(value, ["extra_dependents"]);
  if (value.extra_dependents === undefined) return {};
  if (!object(value.extra_dependents))
    invalid("affected.extra_dependents 必须是包目录到包目录列表的映射");
  const entries = Object.entries(value.extra_dependents).map(
    ([directory, dependents]): [string, string[]] => {
      if (
        !packageDirectory(directory) ||
        !Array.isArray(dependents) ||
        !dependents.every(packageDirectory)
      )
        invalid(
          "affected.extra_dependents 的键和列表元素必须是 packages/ 或 apps/ 下仅含小写字母、数字、短横线的包目录",
        );
      return [directory, [...dependents]];
    },
  );
  return { extraDependents: Object.fromEntries(entries) };
}
async function projectConfig(
  raw: unknown,
  dataDir: string,
  baseBranch: string,
  executors: ReadonlyMap<string, ExecutorEntry>,
): Promise<ProjectMergeGate> {
  if (!object(raw)) invalid("项目配置必须是对象");
  only(raw, [
    "checks",
    "env",
    "total_timeout_minutes",
    "push",
    "executor",
    "affected",
    "queue",
  ]);
  let queue:
    | {
        maxBatchSize: number;
        conflictThreshold: number;
        windowTimeoutMs: number;
        windowHoldLimitMs: number;
        reusePrecheck?: false;
      }
    | undefined;
  if (raw.queue !== undefined) {
    if (!object(raw.queue)) invalid("queue 必须是对象");
    only(raw.queue, [
      "enabled",
      "max_batch_size",
      "window_conflicts",
      "window_timeout_minutes",
      "window_hold_minutes",
      "reuse_precheck",
    ]);
    if (typeof raw.queue.enabled !== "boolean")
      invalid("queue.enabled 必须是布尔值");
    const size = raw.queue.max_batch_size ?? 4;
    if (
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > 8
    )
      invalid("queue.max_batch_size 必须是 1–8 的整数");
    const threshold = raw.queue.window_conflicts ?? 2;
    if (
      typeof threshold !== "number" ||
      !Number.isSafeInteger(threshold) ||
      threshold < 1
    )
      invalid("queue.window_conflicts 必须是正整数");
    const timeout = minutes(raw.queue.window_timeout_minutes, 1440);
    const holdLimit = minutes(raw.queue.window_hold_minutes, 120);
    const reuse = raw.queue.reuse_precheck ?? true;
    if (typeof reuse !== "boolean")
      invalid("queue.reuse_precheck 必须是布尔值");
    if (raw.queue.enabled)
      queue = {
        maxBatchSize: size,
        conflictThreshold: threshold,
        windowTimeoutMs: timeout,
        windowHoldLimitMs: holdLimit,
        ...(reuse ? {} : { reusePrecheck: false as const }),
      };
  }
  const executor = resolveProjectExecutor(raw.executor, executors);
  if (queue && executor?.type === "github" && !executor.scopedChecks)
    invalid(
      "GitHub 合并队列需要 scoped_checks 和支持 merge_tier 的可信基线工作流",
    );
  if (!Array.isArray(raw.checks) || !raw.checks.length)
    invalid("checks 必须是非空列表");
  const names = new Set<string>();
  const checks = raw.checks.map((value: unknown): MergeGateCheck => {
    if (!object(value)) invalid("每条检查必须是对象");
    only(value, [
      "name",
      "run",
      "timeout_minutes",
      "tiers",
      "scope",
      "skip_docs_only",
    ]);
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
    if (value.scope !== undefined && value.scope !== "affected")
      invalid("scope 只允许 affected");
    if (
      value.skip_docs_only !== undefined &&
      typeof value.skip_docs_only !== "boolean"
    )
      invalid("skip_docs_only 必须是布尔值");
    return {
      name: value.name,
      run: value.run,
      timeoutMs: minutes(value.timeout_minutes, 30),
      ...(value.tiers === undefined ? {} : { tiers: parseTiers(value.tiers) }),
      ...(value.scope === undefined ? {} : { scope: value.scope }),
      ...(value.skip_docs_only === undefined
        ? {}
        : { skipDocsOnly: value.skip_docs_only }),
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
    ...(queue ? { queue } : {}),
    ...(raw.push === undefined
      ? {}
      : { push: await parseMergePushRoutes(raw.push, dataDir, baseBranch) }),
    ...(executor === undefined ? {} : { executor }),
    ...(raw.affected === undefined
      ? {}
      : { affected: parseAffected(raw.affected) }),
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
  let executors: ReadonlyMap<string, ExecutorEntry> = new Map();
  const result = (): MergeGateConfiguration => ({
    errors,
    forProject: (project) =>
      globalError
        ? { status: "invalid", reason: globalError }
        : (projects.get(project) ?? { status: "disabled" }),
    forExecutor: (name) => {
      const entry = executors.get(name);
      return !globalError && entry?.status === "valid"
        ? entry.executor
        : undefined;
    },
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
  try {
    const parsed = await parseMergeGateExecutors(raw.executors, dataDir);
    executors = parsed.entries;
    errors.push(...parsed.errors);
  } catch (error) {
    globalError = `merge-gate.yaml 的 ${(error as Error).message}，所有项目暂停合并`;
    errors.push(globalError);
    return result();
  }
  // Q-208 one_project_per_account: an executor (one execution account) serves exactly one project.
  // Counted over every project in the file, registered or not, so the shared account is never used.
  const referencedBy = new Map<string, string[]>();
  for (const [project, value] of Object.entries(raw.projects)) {
    const name = object(value) ? value.executor : undefined;
    if (validExecutorName(name))
      referencedBy.set(name, [...(referencedBy.get(name) ?? []), project]);
  }
  for (const [project, value] of Object.entries(raw.projects)) {
    try {
      if (!input.projectIds.includes(project)) invalid("项目未登记");
      const name = object(value) ? value.executor : undefined;
      const sharing = validExecutorName(name)
        ? (referencedBy.get(name) ?? [])
        : [];
      if (sharing.length > 1)
        invalid(
          `执行目标 ${name as string} 被 ${sharing.length} 个项目引用（${sharing.join("、")}），一个执行账号只能服务一个项目（Q-208），不会回退到本机；请给每个项目配置独立的执行账号或执行目标`,
        );
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
