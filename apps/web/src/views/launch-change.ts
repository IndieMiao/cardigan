import {
  ApiError,
  describeWriteError,
  type LaunchProfileCheck,
  type LaunchProfileReference,
} from "../api.js";

/**
 * C-516: client-side rules for launch settings changes. They mirror the C-515
 * request schema so a mistyped field is marked in place before any preview;
 * the server still validates everything (and the whole file) again.
 */
const NAME = /^[a-z0-9][a-z0-9._-]*$/u;
const PERMISSION = /^[a-zA-Z0-9_-]{1,64}$/u;
const CONTROL = /\p{Cc}/u;

export const nameProblem = (value: string) =>
  value === ""
    ? "请填写名称。"
    : value.length > 64 || !NAME.test(value)
      ? "只能用小写字母、数字、点、下划线和短横线，以字母或数字开头，最多 64 个字符。"
      : undefined;
/** V-2709: a new Provider's ID (the form also has a separate name field). */
export const idProblem = (value: string) =>
  value === ""
    ? "请填写 ID。"
    : value.length > 64 || !NAME.test(value)
      ? "ID 只能用小写字母、数字、点、下划线和短横线，以字母或数字开头，最多 64 个字符。"
      : undefined;
/** Optional identifiers (effort, provider flag): empty clears the value. */
export const optionalNameProblem = (value: string) =>
  value === "" ? undefined : nameProblem(value);
export const permissionProblem = (value: string) =>
  value === "" || PERMISSION.test(value)
    ? undefined
    : "只能用字母、数字、下划线和短横线，最多 64 个字符。";
export const textProblem = (value: string) =>
  value.trim() === ""
    ? "不能为空。"
    : value.length > 256 || CONTROL.test(value)
      ? "最多 256 个字符，不能包含换行等控制字符。"
      : undefined;
export const urlProblem = (value: string) => {
  const text = textProblem(value);
  if (text) return text;
  const url = URL.parse(value);
  // Same rule as the host (`packages/roles` provider schema).
  return url &&
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
    ? undefined
    : "请填写 http(s) 地址，不要带账号、密钥、查询参数或 # 片段。";
};

const ENV = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/** C-549: an environment variable or secrets.env key name. */
export const envNameProblem = (value: string, max = 128) =>
  value === ""
    ? "请填写变量名。"
    : value.length > max || !ENV.test(value)
      ? `只能用字母、数字和下划线，不能以数字开头，最多 ${max} 个字符。`
      : undefined;
/** A plain variable's value may be empty, but stays on one line. */
export const envValueProblem = (value: string) =>
  value.length > 4096 || CONTROL.test(value)
    ? "最多 4096 个字符，不能包含换行等控制字符。"
    : undefined;
/** A secret value is one `KEY=VALUE` line that must read back exactly. */
export const secretValueProblem = (value: string) =>
  value === ""
    ? "请填写密钥。"
    : value.length > 8192 || CONTROL.test(value)
      ? "最多 8192 个字符，不能包含换行等控制字符。"
      : value !== value.trim() ||
          (value.length >= 2 &&
            ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))))
        ? "首尾不能有空格或成对的引号。"
        : undefined;

/** V-2708: writing a shared secrets.env key would change other Providers' credential. */
export const sharedKeyProblem = (key: string, providers: readonly string[]) =>
  `密钥键 ${key} 也被 Provider ${providers.join("、")} 使用，不能在这里改写或清除，请改用独立的键。`;

/** V-2713: replacing or clearing an existing key cannot ride along with other edits. */
export const MIXED_SECRETS =
  "替换或清除已有密钥要单独保存，请先撤销其它修改，或分两次保存。";

/** What went wrong with a preview, confirmation or check, for display in place. */
export type LaunchProblem =
  | { readonly kind: "field"; readonly field: string; readonly message: string }
  | { readonly kind: "form"; readonly message: string }
  | { readonly kind: "stale" }
  | {
      readonly kind: "in_use";
      readonly references: readonly LaunchProfileReference[];
    }
  | {
      readonly kind: "provider_in_use";
      readonly profiles: readonly string[];
      readonly models: readonly string[];
    };

/** Messages for the field named in a C-515 `validation_failed` reply. */
const FIELD_MESSAGES: Record<string, Record<string, string>> = {
  name: {
    create_profile: "已有同名配置，换一个名称。",
    copy_profile: "已有同名配置，换一个名称。",
    create_provider: "已有同一 ID 的 Provider，换一个 ID。",
    default: "这个配置已不存在或不能在页面修改，请刷新。",
  },
  source: { default: "来源配置已不存在，请刷新。" },
  id: { default: "这个别名不能在页面修改，请在主机上修改。" },
  secret_env: {
    default: "密钥键名须是 secrets.env 中已有的键，或这次填写了密钥的键。",
  },
  secrets: { default: "密钥未通过校验，没有写入，请重新输入。" },
  secrets_mixed: { default: MIXED_SECRETS },
  env: { default: "这个变量不能在页面修改，请在主机上修改。" },
  base_url: {
    edit_provider:
      "这个 Provider 的端点写在旧的环境变量里或含有不安全内容，请在主机上修改。",
    create_provider: "请填写 http(s) 地址。",
    default: "没有能明确显示的端点，不能在线探测。",
  },
  provider: { default: "这个 Provider 已不存在或不能在页面探测，请刷新。" },
  profile: { default: "这个配置已不存在或不能在页面检查，请刷新。" },
};

/** V-2708: a confirmation whose outcome could not be verified. */
export const UNSETTLED =
  "无法确认密钥是否已写入，输入框已清空。请刷新后查看密钥状态和最后修改时间，再决定是否重新填写。";
/**
 * Replies that prove the host wrote nothing for this confirmation. Anything
 * else (no reply, a gateway error) may have been written.
 */
const NOT_WRITTEN = new Set([
  "validation_failed",
  "stale_snapshot",
  "write_failed",
  "idempotency_conflict",
  "profile_in_use",
  "provider_in_use",
  "secret_shared",
  "unauthorized",
]);
export const provedNotWritten = (error: unknown) =>
  error instanceof ApiError &&
  !error.outcomeUncertain &&
  NOT_WRITTEN.has(error.code);

const stringList = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

export function launchProblem(error: unknown, op: string): LaunchProblem {
  if (error instanceof ApiError) {
    const details =
      error.details && typeof error.details === "object"
        ? (error.details as Record<string, unknown>)
        : {};
    if (error.code === "stale_snapshot") return { kind: "stale" };
    if (error.code === "profile_in_use" && Array.isArray(details.references))
      return {
        kind: "in_use",
        references: details.references as LaunchProfileReference[],
      };
    if (error.code === "provider_in_use")
      return {
        kind: "provider_in_use",
        profiles: stringList(details.profiles),
        models: stringList(details.models),
      };
    if (error.code === "write_failed")
      return { kind: "form", message: "写入失败，已恢复原文件，没有改动。" };
    if (error.code === "write_unsettled")
      return {
        kind: "form",
        message: "写入结果暂未确认，请刷新后查看是否已保存。",
      };
    if (error.code === "secret_shared" && typeof details.key === "string")
      return {
        kind: "form",
        message: sharedKeyProblem(details.key, stringList(details.providers)),
      };
    if (error.code === "idempotency_conflict") return { kind: "stale" };
    if (error.code === "check_running")
      return { kind: "form", message: "这个配置已有检查在进行。" };
    if (
      error.code === "validation_failed" &&
      typeof details.field === "string"
    ) {
      const messages = FIELD_MESSAGES[details.field];
      return {
        kind: "field",
        field: details.field,
        message:
          messages?.[op] ?? messages?.default ?? "这一项未通过校验，请修改。",
      };
    }
    if (error.code === "validation_failed")
      return {
        kind: "form",
        message:
          "修改后的启动配置未通过校验（模型、Provider、密钥引用或参数不被主机接受），没有写入。",
      };
  }
  return { kind: "form", message: describeWriteError(error) };
}

const FIELD_LABELS: Record<string, string> = {
  harness: "Harness",
  provider: "Provider",
  model: "模型",
  effort: "推理强度",
  permission_mode: "权限模式",
  provider_flag: "Provider 参数",
  auto_update: "自动更新",
  id: "模型标识",
  name: "名称",
  base_url: "端点",
  api: "协议",
};
const GROUP_LABELS: Record<string, string> = {
  profiles: "启动配置",
  models: "模型别名",
  providers: "Provider",
};

/**
 * `profiles.<name>.<field>` → a readable label. Names may contain dots, so
 * the known name of the change is stripped rather than splitting blindly.
 */
export function diffLabel(field: string, name: string) {
  for (const group of Object.keys(GROUP_LABELS)) {
    const prefix = `${group}.${name}`;
    if (field === prefix) return `${GROUP_LABELS[group]} ${name}`;
    if (!field.startsWith(`${prefix}.`)) continue;
    const rest = field.slice(prefix.length + 1);
    if (rest.startsWith("secret_env."))
      return `密钥引用 ${rest.slice("secret_env.".length)}`;
    if (rest.startsWith("env.")) return `环境变量 ${rest.slice("env.".length)}`;
    return FIELD_LABELS[rest] ?? rest;
  }
  if (field.startsWith("secrets."))
    return `密钥 ${field.slice("secrets.".length)}`;
  return field;
}

export function diffValue(value: unknown): string {
  if (value === null || value === undefined) return "未设置";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "object") {
    // V-2708: a value the host does not show (a hidden env value).
    if ((value as Record<string, unknown>).hidden === true) return "已隐藏";
    const copy = (value as Record<string, unknown>).copy_of;
    if (typeof copy === "string") return `复制自 ${copy}`;
    return JSON.stringify(value);
  }
  return String(value);
}

/** Say exactly which check ran: an online check only lists models. */
export function checkLabel(check: LaunchProfileCheck) {
  const online = check.mode === "online";
  switch (check.status) {
    case "running":
      return online ? "在线探测中" : "本地检查中";
    case "passed":
      return online ? "已列出模型" : "本地检查通过";
    case "failed":
      return online ? "在线探测未通过" : "本地检查未通过";
    case "interrupted":
      return online ? "在线探测已中断" : "本地检查已中断";
  }
}

export const checkModeLabel = (mode: LaunchProfileCheck["mode"]) =>
  mode === "online"
    ? "在线探测（只列出模型，不调用推理）"
    : "本地检查（CLI、密钥和模型元数据）";

const PROBLEM_LABELS: Record<string, string> = {
  cli_missing: "找不到 CLI",
  missing_secret: "密钥未设置",
  missing_context_window: "缺少上下文窗口",
  missing_max_output_tokens: "缺少最大输出",
  missing_reasoning_efforts: "缺少推理强度",
  stale_snapshot: "配置已变化，没有探测",
  online_failed: "未能列出模型",
  check_failed: "检查出错",
};
export const problemLabel = (code: string) => PROBLEM_LABELS[code];
