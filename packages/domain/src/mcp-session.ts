import type { Assignment } from "./entities.js";

/**
 * C-600: a verified session that called a tool before its harness listed the
 * Card MCP tools has no native Card tools (MCP initialize failed). The host
 * stops it and rebuilds the session once; a second failure is reported.
 */
export const mcpSessionMissing = (
  a: Pick<Assignment, "mcp_handshake">,
): boolean => a.mcp_handshake === "missing";

/** Readable reason shared by tool refusals, recovery and escalation text. */
export const MCP_SESSION_FAILURE = "MCP 初始化失败：会话没有原生 Card 工具";

/** Readable recovery reason; unknown reasons stay visible as-is. */
export function dispatchReasonText(reason: string): string {
  return reason === "mcp_unavailable" ? MCP_SESSION_FAILURE : reason;
}

/**
 * C-600: header a verified harness sends from its own MCP configuration with
 * the per-launch session key; the endpoint stores only its SHA-256.
 */
export const MCP_SESSION_HEADER = "X-Cardigan-Session";
/** C-600: shape of a session key (URL-safe, no quoting needed anywhere). */
export const MCP_SESSION_KEY_PATTERN = /^[A-Za-z0-9_-]{22,128}$/u;

/**
 * C-600: default time a verified new session has, from dispatch, to list the
 * Card tools before it counts as an MCP initialize failure. Harness MCP
 * startup takes seconds; the host may configure another positive value.
 */
export const DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS = 180_000;
