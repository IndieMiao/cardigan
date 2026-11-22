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
