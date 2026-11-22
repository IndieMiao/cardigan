import {
  ApiError,
  describeWriteError,
  FEISHU_SECRET_KEYS,
  type FeishuSecretKey,
  type FeishuSettingsChange,
  type FeishuSettingsView,
  type FeishuTestResult,
} from "../api.js";

/**
 * C-561: client rules for the Feishu bot settings (C-558 contract). They mirror
 * the server so a mistyped field is marked in place before any preview; the
 * server validates everything again and decides what is accepted.
 */

/** Editable text fields of the drawer form, in display order. */
export type DraftField =
  | "workbench_url"
  | "quiet_start"
  | "quiet_end"
  | "timezone"
  | "lark_rate"
  | "lark_app_rate"
  | "timeout"
  | "retry_delays"
  | "title_limit"
  | "digest_limit"
  | "binding_ttl"
  | "action_ttl"
  | "binding_attempts"
  | "pending_limit";
export type DraftSwitch = "enabled" | "lark" | "lark_app" | "quiet" | PushKind;
/** C-580: one switch per pushed item kind, in display order. */
export const PUSH_KINDS = [
  "push_decision",
  "push_human_action",
  "push_merge_confirmation",
  "push_notice",
] as const;
export type PushKind = (typeof PUSH_KINDS)[number];
export const PUSH_LABELS: Record<
  PushKind,
  { label: string; description: string }
> = {
  push_decision: { label: "待你拍板", description: "需要你拍板的事项" },
  push_human_action: {
    label: "待你执行",
    description: "需要你本人去做的事项",
  },
  push_merge_confirmation: {
    label: "合并确认",
    description: "只推需要你本人确认的合并",
  },
  push_notice: { label: "知会", description: "PM 代拍、自动合并等通知" },
};
/** The projects list edit (C-580); not a switch or a text field. */
export const PROJECTS_EDIT = "projects" as const;
const EXCLUDED_KEY = "filter.excluded_projects";

export interface FeishuDraft {
  readonly switches: Readonly<Record<DraftSwitch, boolean>>;
  readonly fields: Readonly<Record<DraftField, string>>;
  /** C-580: projects not pushed, sorted; projects created later are pushed. */
  readonly excluded: readonly string[];
  /** Masked fields (they held a credential) the person has retyped. */
  readonly retyped: ReadonlySet<DraftField>;
  readonly secrets: Readonly<
    Partial<Record<FeishuSecretKey, "replace" | "clear">>
  >;
}

const SWITCH_KEYS: Record<DraftSwitch, string> = {
  enabled: "enabled",
  lark: "channels.lark.enabled",
  lark_app: "channels.lark_app.enabled",
  quiet: "quiet_hours.enabled",
  push_decision: "filter.decision",
  push_human_action: "filter.human_action",
  push_merge_confirmation: "filter.merge_confirmation",
  push_notice: "filter.notice",
};

type Unit = "text" | "count" | "seconds" | "minutes" | "delays";
const FIELDS: Record<DraftField, { key: string; unit: Unit }> = {
  workbench_url: { key: "workbench_url", unit: "text" },
  quiet_start: { key: "quiet_hours.start", unit: "text" },
  quiet_end: { key: "quiet_hours.end", unit: "text" },
  timezone: { key: "quiet_hours.timezone", unit: "text" },
  lark_rate: { key: "channels.lark.max_per_minute", unit: "count" },
  lark_app_rate: { key: "channels.lark_app.max_per_minute", unit: "count" },
  timeout: { key: "policy.timeout_ms", unit: "seconds" },
  retry_delays: { key: "policy.retry_delays_ms", unit: "delays" },
  title_limit: { key: "policy.title_limit", unit: "count" },
  digest_limit: { key: "policy.digest_limit", unit: "count" },
  binding_ttl: { key: "channels.lark_app.binding_ttl_ms", unit: "minutes" },
  action_ttl: { key: "channels.lark_app.action_ttl_ms", unit: "minutes" },
  binding_attempts: {
    key: "channels.lark_app.binding_attempts_per_minute",
    unit: "count",
  },
  pending_limit: { key: "channels.lark_app.pending_limit", unit: "count" },
};
export const draftFields = Object.keys(FIELDS) as DraftField[];
const MAX_INT = 2147483647;

/** The read's excluded projects, sorted (an unreadable value reads as none). */
export function excludedFrom(view: FeishuSettingsView): string[] {
  const value = view.settings[EXCLUDED_KEY];
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string").sort()
    : [];
}
const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const msText = (ms: unknown, per: number) =>
  typeof ms === "number" ? String(ms / per) : "";

/** The form's starting point: the values of one read. Masked strings start empty. */
export function draftFrom(view: FeishuSettingsView): FeishuDraft {
  const s = view.settings;
  const text = (field: DraftField) => {
    const { key, unit } = FIELDS[field];
    const value = s[key];
    if (unit === "seconds") return msText(value, 1000);
    if (unit === "minutes") return msText(value, 60000);
    if (unit === "delays")
      return Array.isArray(value)
        ? value.map((ms) => msText(ms, 1000)).join(", ")
        : "";
    return typeof value === "number" || typeof value === "string"
      ? String(value)
      : "";
  };
  return {
    switches: Object.fromEntries(
      Object.entries(SWITCH_KEYS).map(([k, key]) => [k, s[key] === true]),
    ) as Record<DraftSwitch, boolean>,
    fields: Object.fromEntries(
      draftFields.map((field) => [field, text(field)]),
    ) as Record<DraftField, string>,
    excluded: excludedFrom(view),
    retyped: new Set(),
    secrets: {},
  };
}

/** Fields the server masked because they contained a credential. */
export const maskedFields = (view: FeishuSettingsView) =>
  draftFields.filter(
    (field) =>
      FIELDS[field].unit === "text" &&
      view.settings[FIELDS[field].key] === null,
  );

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/u;
const CONTROL = /\p{Cc}/u;

function parseCount(text: string): number | string {
  const value = Number(text.trim());
  return text.trim() !== "" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_INT
    ? value
    : "请填写 1 到 2147483647 之间的整数。";
}
/** Seconds or minutes to whole milliseconds (≥ 1 ms). */
function parseDuration(text: string, per: number): number | string {
  const value = Number(text.trim());
  const ms = Math.round(value * per);
  return text.trim() !== "" &&
    Number.isFinite(value) &&
    ms >= 1 &&
    ms <= MAX_INT &&
    Math.abs(value * per - ms) < 1e-6
    ? ms
    : per === 1000
      ? "请填写大于 0 的秒数，最多精确到毫秒。"
      : "请填写大于 0 的分钟数，换算后须是整毫秒。";
}
function parseDelays(text: string): number[] | string {
  const parts = text.split(/[\s,，、]+/u).filter(Boolean);
  const out: number[] = [];
  for (const part of parts) {
    const ms = parseDuration(part, 1000);
    if (typeof ms === "string")
      return "请用逗号分隔大于 0 的秒数；不重试时留空。";
    out.push(ms);
  }
  return out;
}
export function urlProblem(value: string) {
  if (value === "") return undefined;
  const url = URL.parse(value);
  return value.length <= 2048 &&
    !CONTROL.test(value) &&
    url &&
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    !url.pathname.includes("/bot/v2/hook/")
    ? undefined
    : "请填写 http(s) 地址，不要带账号、查询参数、# 片段或机器人 Webhook。";
}
function timezoneProblem(value: string) {
  if (value === "" || value.length > 128)
    return "请填写时区，例如 Asia/Shanghai。";
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return undefined;
  } catch {
    return "无法识别这个时区，例如 Asia/Shanghai。";
  }
}

export const SECRET_LABELS: Record<FeishuSecretKey, string> = {
  lark_webhook: "群机器人 Webhook",
  lark_sign_secret: "群机器人签名密钥",
  app_id: "应用 App ID",
  app_secret: "应用 App Secret",
  tenant_key: "租户 Tenant Key",
};
/** Credentials a channel cannot run without (the signing secret is optional). */
const REQUIRED: Record<"lark" | "lark_app", readonly FeishuSecretKey[]> = {
  lark: ["lark_webhook"],
  lark_app: ["app_id", "app_secret", "tenant_key"],
};
const WEBHOOK = /^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9_-]+$/u;
export function secretProblem(key: FeishuSecretKey, value: string) {
  if (value === "") return "请填写新值。";
  if (value !== value.trim() || value.length > 4096 || CONTROL.test(value))
    return "首尾不能有空格，不能包含换行等控制字符，最多 4096 个字符。";
  if (key === "lark_webhook") {
    const url = URL.parse(value);
    if (
      url?.protocol !== "https:" ||
      url.hostname !== "open.feishu.cn" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !WEBHOOK.test(url.pathname) ||
      url.href !== value
    )
      return "请填写 https://open.feishu.cn/open-apis/bot/v2/hook/ 开头的机器人地址。";
  }
  if (key === "app_id" && !/^cli_[a-fA-F0-9]{16}$/u.test(value))
    return "App ID 形如 cli_ 加 16 位十六进制字符。";
  if (REQUIRED.lark_app.includes(key) && value.length > 512)
    return "最多 512 个字符。";
  return undefined;
}

class Problem {
  constructor(readonly message: string) {}
}
/** A field's text as the value the server stores, or why it is not one. */
function parseField(field: DraftField, text: string): unknown {
  const unit = FIELDS[field].unit;
  const value =
    unit === "text"
      ? text
      : unit === "count"
        ? parseCount(text)
        : unit === "seconds"
          ? parseDuration(text, 1000)
          : unit === "minutes"
            ? parseDuration(text, 60000)
            : parseDelays(text);
  return unit !== "text" && typeof value === "string"
    ? new Problem(value)
    : value;
}

/**
 * The parts of `draft` that differ from the read `view` (net edits: a value
 * changed and changed back is not an edit). An unparsable field counts, so
 * the person's text is kept.
 */
export function netEdits(view: FeishuSettingsView, draft: FeishuDraft) {
  const out = new Set<DraftField | DraftSwitch | typeof PROJECTS_EDIT>();
  if (!sameList(draft.excluded, excludedFrom(view))) out.add(PROJECTS_EDIT);
  for (const [k, key] of Object.entries(SWITCH_KEYS) as [DraftSwitch, string][])
    if (draft.switches[k] !== (view.settings[key] === true)) out.add(k);
  const masked = new Set(maskedFields(view));
  for (const field of draftFields) {
    if (masked.has(field)) {
      if (draft.retyped.has(field)) out.add(field);
      continue;
    }
    const value = parseField(field, draft.fields[field]);
    if (
      value instanceof Problem ||
      JSON.stringify(value) !== JSON.stringify(view.settings[FIELDS[field].key])
    )
      out.add(field);
  }
  return out;
}

/**
 * V-2869: the draft kept out of view (memory only). A text field holding a
 * credential being typed falls back to the read's value, so the held draft
 * never carries it; unrelated edits stay.
 */
export function withoutTypedSecrets(
  view: FeishuSettingsView,
  draft: FeishuDraft,
  values: Readonly<Partial<Record<FeishuSecretKey, string>>>,
): FeishuDraft {
  const typed = FEISHU_SECRET_KEYS.filter((k) => draft.secrets[k] === "replace")
    .map((k) => values[k] ?? "")
    .filter((v) => v !== "");
  const hit = draftFields.filter(
    (f) =>
      FIELDS[f].unit === "text" &&
      typed.some((v) => draft.fields[f].includes(v)),
  );
  if (!hit.length) return draft;
  const fresh = draftFrom(view);
  const fields = { ...draft.fields };
  const retyped = new Set(draft.retyped);
  for (const f of hit) {
    fields[f] = fresh.fields[f];
    retyped.delete(f);
  }
  return { ...draft, fields, retyped };
}

export type DraftProblems = Partial<
  Record<DraftField | FeishuSecretKey, string>
>;

/**
 * The change to preview (only what the person changed) and the problems that
 * stop it. `change` is undefined while nothing changed or a field is invalid.
 */
export function buildChange(
  view: FeishuSettingsView,
  draft: FeishuDraft,
  values: Readonly<Partial<Record<FeishuSecretKey, string>>>,
): { change?: FeishuSettingsChange; problems: DraftProblems; dirty: boolean } {
  const s = view.settings;
  const settings: Record<string, unknown> = {};
  const problems: DraftProblems = {};
  for (const [k, key] of Object.entries(SWITCH_KEYS) as [DraftSwitch, string][])
    if (draft.switches[k] !== (s[key] === true))
      settings[key] = draft.switches[k];
  const masked = new Set(maskedFields(view));
  const merged: Record<string, unknown> = { ...s };
  for (const field of draftFields) {
    const { key } = FIELDS[field];
    if (masked.has(field) && !draft.retyped.has(field)) continue;
    const value = parseField(field, draft.fields[field]);
    if (value instanceof Problem) {
      problems[field] = value.message;
      continue;
    }
    if (JSON.stringify(value) === JSON.stringify(s[key])) continue;
    settings[key] = value;
    merged[key] = value;
  }
  for (const [k, key] of Object.entries(SWITCH_KEYS))
    merged[key] = draft.switches[k as DraftSwitch];
  if (!sameList(draft.excluded, excludedFrom(view)))
    settings[EXCLUDED_KEY] = [...draft.excluded];
  // The attempt count follows the retry delays (server rule: delays + 1).
  if ("policy.retry_delays_ms" in settings) {
    const attempts =
      (settings["policy.retry_delays_ms"] as number[]).length + 1;
    if (attempts !== s["policy.max_attempts"])
      settings["policy.max_attempts"] = attempts;
  }
  const url = String(merged.workbench_url ?? "");
  if (!masked.has("workbench_url") || draft.retyped.has("workbench_url")) {
    const problem = urlProblem(draft.fields.workbench_url);
    if (problem) problems.workbench_url = problem;
    else if (draft.switches.enabled && url === "")
      problems.workbench_url = "开启消息推送需要填写 Workbench 链接。";
  }
  for (const field of ["quiet_start", "quiet_end"] as const)
    if (
      (!masked.has(field) || draft.retyped.has(field)) &&
      !CLOCK.test(draft.fields[field])
    )
      problems[field] = "请按 24 小时制填写，例如 22:00。";
  if (
    draft.switches.quiet &&
    !problems.quiet_start &&
    !problems.quiet_end &&
    draft.fields.quiet_start === draft.fields.quiet_end
  )
    problems.quiet_end = "结束时间不能与开始时间相同。";
  if (!masked.has("timezone") || draft.retyped.has("timezone")) {
    const problem = timezoneProblem(draft.fields.timezone);
    if (problem) problems.timezone = problem;
  }
  const set: FeishuSecretKey[] = [];
  const clear: FeishuSecretKey[] = [];
  for (const key of FEISHU_SECRET_KEYS) {
    const mode = draft.secrets[key];
    if (mode === "clear" && view.secrets[key].set) clear.push(key);
    if (mode !== "replace") continue;
    set.push(key);
    const problem = secretProblem(key, values[key] ?? "");
    if (problem) problems[key] = problem;
  }
  // A credential being typed must not reach the preview through a public
  // text field (now or as an unchanged value): the field is marked, never
  // the value repeated.
  const typed = set.map((k) => values[k] ?? "").filter((v) => v !== "");
  for (const field of draftFields) {
    if (FIELDS[field].unit !== "text" || problems[field]) continue;
    const current = s[FIELDS[field].key];
    const texts = [
      ...(masked.has(field) && !draft.retyped.has(field)
        ? []
        : [draft.fields[field]]),
      ...(typeof current === "string" ? [current] : []),
    ];
    if (typed.some((v) => texts.some((t) => t.includes(v))))
      problems[field] = "这一项不能包含正在填写的凭据。";
  }
  if (draft.switches.enabled)
    for (const channel of ["lark", "lark_app"] as const) {
      if (!draft.switches[channel]) continue;
      for (const key of REQUIRED[channel])
        if (
          !problems[key] &&
          (clear.includes(key) ||
            (!view.secrets[key].set && !set.includes(key)))
        )
          problems[key] =
            channel === "lark"
              ? "群机器人开启时需要 Webhook；要清除请同时关闭群机器人。"
              : "应用机器人开启时需要 App ID、App Secret 和 Tenant Key；要清除请同时关闭应用机器人。";
    }
  const changed = Object.keys(settings).length + set.length + clear.length > 0;
  const dirty =
    changed ||
    Object.keys(draft.secrets).length > 0 ||
    draft.retyped.size > 0 ||
    Object.keys(problems).length > 0;
  if (changed)
    for (const field of masked)
      if (!draft.retyped.has(field) && !problems[field])
        problems[field] = "原值含有凭据内容，已隐藏；保存前请重新填写。";
  if (!changed || Object.keys(problems).length > 0) return { problems, dirty };
  return {
    change: {
      ...(Object.keys(settings).length ? { settings } : {}),
      ...(set.length + clear.length ? { secrets: { set, clear } } : {}),
    },
    problems,
    dirty,
  };
}

const KEY_LABELS: Record<string, string> = {
  enabled: "消息推送",
  workbench_url: "Workbench 链接",
  "channels.lark.enabled": "群机器人",
  "channels.lark_app.enabled": "应用机器人",
  "quiet_hours.enabled": "免打扰",
  "quiet_hours.start": "免打扰开始",
  "quiet_hours.end": "免打扰结束",
  "quiet_hours.timezone": "时区",
  "policy.max_per_minute": "默认限速",
  "channels.lark.max_per_minute": "群机器人限速",
  "channels.lark_app.max_per_minute": "应用机器人限速",
  "policy.timeout_ms": "请求超时",
  "policy.max_attempts": "发送次数上限",
  "policy.retry_delays_ms": "重试间隔",
  "policy.title_limit": "标题长度",
  "policy.digest_limit": "汇总条数",
  "channels.lark_app.binding_ttl_ms": "绑定码有效期",
  "channels.lark_app.action_ttl_ms": "按钮有效期",
  "channels.lark_app.binding_attempts_per_minute": "每分钟绑定尝试",
  "channels.lark_app.pending_limit": "待处理上限",
  "filter.decision": "推送待你拍板",
  "filter.human_action": "推送待你执行",
  "filter.merge_confirmation": "推送合并确认",
  "filter.notice": "推送知会",
  [EXCLUDED_KEY]: "不推送的项目",
};
export const diffLabel = (key: string) =>
  key.startsWith("secrets.")
    ? (SECRET_LABELS[key.slice("secrets.".length) as FeishuSecretKey] ?? key)
    : (KEY_LABELS[key] ?? key);

const seconds = (ms: number) => `${ms / 1000} 秒`;
const minutes = (ms: number) => `${ms / 60000} 分钟`;
/** A setting's value for display (never a credential: those read as `null`). */
export function formatValue(key: string, value: unknown): string {
  if (value === null) return "已隐藏";
  if (value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "开启" : "关闭";
  if (key === EXCLUDED_KEY && Array.isArray(value))
    return value.length ? value.join("、") : "无";
  if (key === "policy.retry_delays_ms" && Array.isArray(value))
    return value.length
      ? value.map((ms) => seconds(Number(ms))).join("、")
      : "不重试";
  if (typeof value === "number") {
    if (key === "policy.timeout_ms") return seconds(value);
    if (key.endsWith("_ttl_ms")) return minutes(value);
    if (key.endsWith("max_per_minute")) return `每分钟 ${value} 条`;
    if (key === "policy.max_attempts") return `${value} 次`;
    if (key === "policy.title_limit") return `${value} 字`;
    if (key === "policy.digest_limit") return `${value} 条`;
    if (key.endsWith("attempts_per_minute")) return `每分钟 ${value} 次`;
    if (key.endsWith("pending_limit")) return `${value} 条`;
  }
  return String(value);
}
export function formatSecretDiff(side: "before" | "after", value: unknown) {
  if (side === "before") return value === "set" ? "已设置" : "未设置";
  return value === "new" ? "写入新值" : "清除";
}

/** Replies that prove the server wrote nothing for this confirmation. */
const NOT_WRITTEN = new Set([
  "stale_snapshot",
  "invalid_settings",
  "invalid_request",
  "not_applied",
  "idempotency_conflict",
  "human_only",
  "shutting_down",
]);
export const provedNotWritten = (error: unknown) =>
  error instanceof ApiError &&
  !error.outcomeUncertain &&
  NOT_WRITTEN.has(error.code);

export const STALE = "stale" as const;
/** Why a preview or confirmation failed, for the top of the form. */
export function saveProblem(error: unknown): string | typeof STALE {
  if (error instanceof ApiError) {
    if (error.code === "stale_snapshot") return STALE;
    if (error.code === "invalid_settings")
      return "服务端未接受这次修改：配置或凭据无效，或开启的渠道缺少凭据。没有保存。";
    if (error.code === "not_applied") return "这次保存没有应用，请重新预览。";
    if (error.code === "unconfirmed")
      return "无法确认是否已保存，请刷新后核对当前配置。";
    if (error.code === "human_only")
      return "只有人员登录会话可以修改飞书配置。";
    if (error.code === "shutting_down")
      return "后台正在关闭，没有保存，请稍后重试。";
  }
  return describeWriteError(error);
}

/** One test message result, as the channel row shows it. */
export function testOutcome(
  result: FeishuTestResult | undefined,
  error?: unknown,
): { status: string; label: string } {
  if (error !== undefined) {
    if (error instanceof ApiError && !error.outcomeUncertain) {
      if (error.code === "channel_disabled")
        return { status: "failed", label: "未发送：渠道未开启" };
      if (error.code === "binding_unavailable")
        return { status: "failed", label: "未发送：本人未绑定或凭据无效" };
      if (error.code === "rate_limited" || error.status === 429)
        return { status: "failed", label: "未发送：渠道已限速" };
      if (error.code === "invalid_settings")
        return { status: "failed", label: "未发送：配置无效" };
      if (error.status < 500) return { status: "failed", label: "未发送" };
    }
    return { status: "unknown", label: "结果未知" };
  }
  switch (result) {
    case "sent":
      return { status: "done", label: "已发送" };
    case "permanent":
      return { status: "failed", label: "发送失败" };
    case "retryable":
      return { status: "failed", label: "暂时失败" };
    case "timeout":
      return { status: "unknown", label: "超时，未确认送达" };
    default:
      return { status: "unknown", label: "结果未知" };
  }
}
