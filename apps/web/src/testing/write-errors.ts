import { ApiError } from "../api.js";

/** Shared regression cases for every idempotent write surface. */
export const writeFailures = [
  {
    label: "validation",
    error: new ApiError(400, "validation_failed", "Invalid request parameters"),
    uncertain: false,
    reason: "填写的内容不符合要求",
  },
  {
    label: "conflict",
    error: new ApiError(409, "idempotency_conflict", "请求内容冲突"),
    uncertain: false,
    reason: "请求内容冲突",
  },
  {
    label: "domain rejection",
    error: new ApiError(409, "illegal_transition", "Illegal transition"),
    uncertain: false,
    reason: "当前状态不允许此操作",
  },
  {
    label: "network",
    error: new TypeError("Failed to fetch"),
    uncertain: true,
    reason: "连不上 Workbench 服务",
  },
  {
    label: "timeout",
    error: new DOMException("Timed out", "TimeoutError"),
    uncertain: true,
    reason: "请求超时",
  },
  {
    label: "server error",
    error: new ApiError(500, "internal_error", "Internal error"),
    uncertain: true,
    reason: "服务暂时异常",
  },
  {
    label: "proxy error",
    error: new ApiError(503, "http_503", "Service unavailable"),
    uncertain: true,
    reason: "服务暂时异常",
  },
];
