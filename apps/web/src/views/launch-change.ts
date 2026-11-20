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
  return url &&
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password
    ? undefined
    : "请填写 http(s) 地址，不要在地址里写账号或密钥。";
};

/** What went wrong with a preview, confirmation or check, for display in place. */
export type LaunchProblem =
  | { readonly kind: "field"; readonly field: string; readonly message: string }
  | { readonly kind: "form"; readonly message: string }
  | { readonly kind: "stale" }
  | {
      readonly kind: "in_use";
      readonly references: readonly LaunchProfileReference[];
    };

/** Messages for the field named in a C-515 `validation_failed` reply. */
const FIELD_MESSAGES: Record<string, Record<string, string>> = {
  name: {
    create_profile: "已有同名配置，换一个名称。",
    copy_profile: "已有同名配置，换一个名称。",
    default: "这个配置已不存在或不能在页面修改，请刷新。",
  },
  source: { default: "来源配置已不存在，请刷新。" },
  id: { default: "这个别名不能在页面修改，请在主机上修改。" },
  secret_env: { default: "只能选择 secrets.env 中已有的键名。" },
  base_url: {
    edit_provider:
      "这个 Provider 的端点写在旧的环境变量里或含有不安全内容，请在主机上修改。",
    default: "没有能明确显示的端点，不能在线探测。",
  },
  profile: { default: "这个配置已不存在或不能在页面检查，请刷新。" },
};

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
    if (rest.startsWith("env.")) return `端点（${rest.slice("env.".length)}）`;
    return FIELD_LABELS[rest] ?? rest;
  }
  return field;
}

export function diffValue(value: unknown): string {
  if (value === null || value === undefined) return "未设置";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "object") {
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
