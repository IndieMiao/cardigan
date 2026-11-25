import { AsyncLocalStorage } from "node:async_hooks";
import type { CandidatePushFailure } from "@cardigan/git-transport";

/**
 * C-681: fixed-shape evidence about the provider HTTP exchanges of one check
 * attempt. Only these fields cross the provider boundary; raw headers, URLs
 * and response bodies never do.
 */
export interface ExecutorHttpObservation {
  readonly operation: "token" | "dispatch" | "run" | "runs" | "jobs" | "other";
  readonly method: string;
  /** Absent when the request never produced an HTTP response. */
  readonly status?: number;
  readonly requestId?: string;
  /** Redacted, bounded response projection. */
  readonly summary: string;
}
/**
 * Which dispatch_unknown branch was taken. C-758 splits the former
 * `push_incomplete` (kept only for old records) by the real cause.
 */
export type DispatchUnknownStage =
  | "not_sent"
  | "push_incomplete"
  | "push_cancelled"
  | "push_timeout"
  | "push_rejected"
  | "push_unreachable"
  | "push_failed"
  | "run_not_found";
/** C-758: transport reason of a candidate push that did not settle as pushed. */
export type CandidatePushReason = CandidatePushFailure;
export function pushFailureStage(
  reason: CandidatePushReason,
): DispatchUnknownStage {
  switch (reason) {
    case "cancelled":
      return "push_cancelled";
    case "timeout":
      return "push_timeout";
    case "network":
      return "push_unreachable";
    case "auth":
    case "rejected":
    case "github_error":
      return "push_rejected";
    default:
      return "push_failed";
  }
}
export interface DispatchUnknownDetail {
  readonly stage: DispatchUnknownStage;
  /** C-758: the candidate transport's fixed reason, when a push failed. */
  readonly pushFailure?: CandidatePushReason;
  /** Latest GitHub request made by this attempt's executor call. */
  readonly last?: ExecutorHttpObservation;
  /** The persisted workflow dispatch POST response, possibly from an earlier pass. */
  readonly post?: ExecutorHttpObservation;
}
/** Structured executor failure kept next to the human-readable reason. */
export interface ExecutorFailure {
  readonly category: string;
  readonly stage?: DispatchUnknownStage;
  readonly pushFailure?: CandidatePushReason;
  readonly httpStatus?: number;
  readonly requestId?: string;
}

export const DISPATCH_STAGE_LABEL: Readonly<
  Record<DispatchUnknownStage, string>
> = {
  not_sent: "未发出",
  push_incomplete: "候选推送未完成",
  push_cancelled: "候选推送被本地取消或中止",
  push_timeout: "候选推送超时",
  push_rejected: "GitHub 拒绝或报错候选推送",
  push_unreachable: "候选推送连不上 GitHub",
  push_failed: "候选推送在本机失败",
  run_not_found: "已发出但超时找不到运行",
};
const PUSH_REASON_LABEL: Readonly<Record<CandidatePushReason, string>> = {
  cancelled: "本地取消",
  timeout: "超过传输时限",
  local: "传输前本机校验失败",
  network: "网络连接失败",
  auth: "认证或权限被拒",
  rejected: "引用更新被拒",
  github_error: "GitHub 服务端错误",
  other: "未识别的推送错误",
};
const OPERATION_LABEL: Readonly<
  Record<ExecutorHttpObservation["operation"], string>
> = {
  token: "安装令牌",
  dispatch: "工作流派发",
  run: "运行详情",
  runs: "运行列表",
  jobs: "作业列表",
  other: "其它",
};

/** Per-attempt trace; concurrent attempts sharing one client stay separate. */
export class GithubHttpTrace {
  last: ExecutorHttpObservation | undefined;
  dispatch: ExecutorHttpObservation | undefined;
  record(observation: ExecutorHttpObservation): void {
    this.last = observation;
    if (observation.operation === "dispatch") this.dispatch = observation;
  }
}
export const githubHttpTrace = new AsyncLocalStorage<GithubHttpTrace>();
export function recordGithubHttp(observation: ExecutorHttpObservation): void {
  githubHttpTrace.getStore()?.record(observation);
}

const SUMMARY_LIMIT = 160;
/**
 * Credentials are removed before any length limit, then everything outside a
 * conservative character set is dropped. URLs are replaced: signed URLs and
 * query strings may carry credentials.
 */
export function redactProviderText(text: string): string {
  const redacted = text
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
      "[REDACTED]",
    )
    .replace(/\b(?:authorization|bearer)\s*:?\s*\S+/giu, "[REDACTED]")
    .replace(/\b(?:access_)?token\s*[:=]\s*\S+/giu, "[REDACTED]")
    .replace(/\b(?:gh[opsur]_|github_pat_)[A-Za-z0-9_.-]+/gu, "[REDACTED]")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/gu,
      "[REDACTED]",
    )
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/giu, "[URL]")
    .replace(/[^\p{L}\p{N} .,:;!?'"()[\]_/@#=+-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return redacted.length > SUMMARY_LIMIT
    ? `${redacted.slice(0, SUMMARY_LIMIT - 3)}...`
    : redacted;
}
/** Allow-listed scalar fields only; a successful body may contain a token. */
export function summarizeProviderBody(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "无正文";
  const value = body as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of [
    "workflow_run_id",
    "id",
    "total_count",
    "status",
    "conclusion",
  ]) {
    const field = value[key];
    if (Number.isSafeInteger(field)) parts.push(`${key}=${field}`);
    else if (typeof field === "string" && /^[a-z_]{1,32}$/u.test(field))
      parts.push(`${key}=${field}`);
  }
  for (const key of ["workflow_runs", "jobs"]) {
    if (Array.isArray(value[key]))
      parts.push(`${key}=${(value[key] as unknown[]).length}`);
  }
  if (typeof value.message === "string")
    parts.push(`message=${redactProviderText(value.message)}`);
  return parts.length ? redactProviderText(parts.join(" ")) : "正文已省略";
}
/** Error bodies are small JSON objects; only their message is kept. */
export function summarizeErrorText(text: string): string {
  if (!text.trim()) return "无正文";
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { message?: unknown }).message === "string"
    )
      return redactProviderText((parsed as { message: string }).message);
    return "正文已省略";
  } catch {
    return redactProviderText(text);
  }
}
export function safeRequestId(value: string | null): string | undefined {
  return value && /^[A-Za-z0-9:._-]{1,80}$/u.test(value) ? value : undefined;
}
/** Shape check for observations restored from a durable journal. */
export function validObservation(
  value: unknown,
): value is ExecutorHttpObservation {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.operation === "string" &&
    o.operation in OPERATION_LABEL &&
    typeof o.method === "string" &&
    /^[A-Z]{1,10}$/u.test(o.method) &&
    (o.status === undefined ||
      (Number.isSafeInteger(o.status) &&
        (o.status as number) >= 100 &&
        (o.status as number) <= 599)) &&
    (o.requestId === undefined ||
      (typeof o.requestId === "string" &&
        safeRequestId(o.requestId) === o.requestId)) &&
    typeof o.summary === "string"
  );
}
function describe(observation: ExecutorHttpObservation | undefined): string {
  if (!observation) return "无";
  return [
    `${observation.method} ${OPERATION_LABEL[observation.operation] ?? "其它"}`,
    observation.status === undefined
      ? "无 HTTP 响应"
      : `HTTP ${observation.status}`,
    `请求 id ${observation.requestId ?? "无"}`,
    `响应：${redactProviderText(observation.summary) || "无正文"}`,
  ].join("，");
}
/** One line for the check log and summary; built from validated fields only. */
export function formatDispatchUnknown(detail: DispatchUnknownDetail): string {
  const parts = [
    `分类：${DISPATCH_STAGE_LABEL[detail.stage]}`,
    ...(detail.pushFailure
      ? [`推送结果：${PUSH_REASON_LABEL[detail.pushFailure]}`]
      : []),
    `最近一次 GitHub 请求：${describe(detail.last)}`,
  ];
  if (detail.post && detail.post !== detail.last)
    parts.push(`派发请求：${describe(detail.post)}`);
  return parts.join("；");
}
export function dispatchFailure(
  category: string,
  detail: DispatchUnknownDetail | undefined,
): ExecutorFailure {
  const last = detail?.last;
  return {
    category,
    ...(detail ? { stage: detail.stage } : {}),
    ...(detail?.pushFailure ? { pushFailure: detail.pushFailure } : {}),
    ...(last?.status !== undefined ? { httpStatus: last.status } : {}),
    ...(last?.requestId ? { requestId: last.requestId } : {}),
  };
}
