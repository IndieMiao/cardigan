import { assignmentCardId } from "../card-hold.js";
import type { Actor, Run } from "../entities.js";
import { eventsOfType } from "../event-index.js";
import type { RunId } from "../ids.js";
import { runById } from "../run-index.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";

/**
 * C-806: first-hand evidence of a Run whose launch failed, taken by the host
 * just before it stops the session. Every field is bounded and already
 * redacted by the worker collector and again by the host; the domain only
 * checks shape and limits and never interprets screen or log text.
 */
export interface LaunchEvidence {
  /** The host's reason for reclaiming the session (dispatch stop reason). */
  readonly reason: NonNullable<Run["dispatch_stop"]>["reason"];
  readonly machine_id: string;
  readonly harness: string | null;
  readonly waited_ms: number | null;
  /** Card MCP as the control host saw it (C-600 handshake). */
  readonly card_handshake: "pending" | "listed" | "missing" | null;
  readonly terminal: {
    readonly state: "live" | "finished";
    readonly exit_code?: number | undefined;
    readonly exit_reason?: string | undefined;
    /** Redacted tail of the terminal (the CLI's stdout and stderr). */
    readonly tail: readonly string[];
    readonly resources?: LaunchResources | null | undefined;
  } | null;
  /** Per-server connection result from the harness's own MCP logs. */
  readonly mcp_servers: readonly LaunchMcpServer[] | null;
  /** Bounded reason codes for each missing part; never a message. */
  readonly unavailable: Readonly<Record<string, string>>;
}
export interface LaunchResources {
  readonly source: "scope" | "process";
  readonly cpu_ms: number;
  readonly memory_bytes: number;
  readonly memory_peak_bytes?: number | undefined;
  readonly elapsed_ms: number;
}
export interface LaunchMcpServer {
  readonly name: string;
  readonly status: "connected" | "failed" | "pending";
  readonly transport?: string | undefined;
  readonly elapsed_ms?: number | undefined;
  readonly error?: string | undefined;
}

export const LAUNCH_EVIDENCE_LIMITS = {
  tail_lines: 20,
  tail_chars: 200,
  tail_bytes: 2048,
  error_chars: 160,
  servers: 8,
} as const;

const count = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
const code = (s: unknown) =>
  typeof s === "string" && /^[a-z][a-z0-9_]{0,39}$/u.test(s);

function valid(e: LaunchEvidence): boolean {
  const L = LAUNCH_EVIDENCE_LIMITS;
  const t = e.terminal;
  const r = t?.resources;
  return (
    code(e.reason) &&
    typeof e.machine_id === "string" &&
    e.machine_id.length <= 64 &&
    (e.harness === null || code(e.harness.replace("-", "_"))) &&
    (e.waited_ms === null || count(e.waited_ms)) &&
    [null, "pending", "listed", "missing"].includes(e.card_handshake) &&
    (t === null ||
      (["live", "finished"].includes(t.state) &&
        (t.exit_code === undefined ||
          (Number.isSafeInteger(t.exit_code) &&
            Math.abs(t.exit_code) <= 255)) &&
        (t.exit_reason === undefined || code(t.exit_reason)) &&
        Array.isArray(t.tail) &&
        t.tail.length <= L.tail_lines &&
        t.tail.every(
          (line) => typeof line === "string" && line.length <= L.tail_chars,
        ) &&
        new TextEncoder().encode(t.tail.join("\n")).length <= L.tail_bytes &&
        (r === undefined ||
          r === null ||
          (["scope", "process"].includes(r.source) &&
            count(r.cpu_ms) &&
            count(r.memory_bytes) &&
            count(r.elapsed_ms) &&
            (r.memory_peak_bytes === undefined ||
              count(r.memory_peak_bytes)))))) &&
    (e.mcp_servers === null ||
      (Array.isArray(e.mcp_servers) &&
        e.mcp_servers.length <= L.servers &&
        e.mcp_servers.every(
          (s) =>
            /^[A-Za-z0-9_-]{1,40}$/u.test(s.name) &&
            ["connected", "failed", "pending"].includes(s.status) &&
            (s.transport === undefined ||
              /^[a-z-]{1,16}$/u.test(s.transport)) &&
            (s.elapsed_ms === undefined || count(s.elapsed_ms)) &&
            (s.error === undefined ||
              (typeof s.error === "string" && s.error.length <= L.error_chars)),
        ))) &&
    typeof e.unavailable === "object" &&
    e.unavailable !== null &&
    Object.entries(e.unavailable).every(([k, v]) => code(k) && code(v))
  );
}

const MCP_STATUS = { connected: "已连上", failed: "未连上", pending: "无结果" };

/** One readable line for the timeline; the tail stays in the event payload. */
export function launchEvidenceSummary(run: RunId, e: LaunchEvidence): string {
  const t = e.terminal;
  const parts = [
    `${run} 启动证据：回收原因 ${e.reason}`,
    t
      ? `终端${t.state === "live" ? "仍在运行" : "已结束"}${
          t.exit_code === undefined ? "" : `，退出码 ${t.exit_code}`
        }${t.exit_reason ? `（${t.exit_reason}）` : ""}`
      : `终端未取得（${e.unavailable.terminal ?? "unknown"}）`,
    e.mcp_servers === null
      ? `MCP 结果未取得（${e.unavailable.mcp ?? "unknown"}）`
      : e.mcp_servers.length === 0
        ? "MCP 无本次连接日志"
        : `MCP ${e.mcp_servers
            .map((s) => `${s.name} ${MCP_STATUS[s.status]}`)
            .join("、")}`,
    ...(e.card_handshake ? [`card 握手 ${e.card_handshake}`] : []),
    ...(t?.resources
      ? [
          `CPU ${(t.resources.cpu_ms / 1000).toFixed(1)} 秒、内存 ${Math.round(
            t.resources.memory_bytes / 1048576,
          )} MB、已运行 ${Math.round(t.resources.elapsed_ms / 1000)} 秒`,
        ]
      : []),
  ];
  return `${parts.join("；")}。`;
}

/** Whether this Run already has recorded launch evidence. */
export function launchEvidenceRecorded(
  state: CommandState,
  run_id: RunId,
): boolean {
  return eventsOfType(state.events, "run_launch_evidence").some(
    (e) => (e.payload as { run_id?: unknown } | null)?.run_id === run_id,
  );
}

/**
 * C-806: system only, once per Run. Emits `run_launch_evidence` (full bounded
 * evidence) with a one-line system timeline entry on the Run's card.
 */
export function recordLaunchEvidence(
  state: CommandState,
  actor: Actor,
  p: { run_id: RunId; evidence: LaunchEvidence },
  ports?: CommandPorts,
) {
  return command(state, actor, "record_launch_evidence", ports, (d) => {
    const run = runById(state.runs, p.run_id);
    ensure(run, "not_found", "Run not found");
    ensure(
      valid(p.evidence),
      "validation_failed",
      "Launch evidence is malformed or exceeds its limits",
    );
    if (launchEvidenceRecorded(state, run.id)) return false;
    const a = state.assignments.find((x) => x.id === run.assignment_id);
    const card = a && assignmentCardId(a, state, run.trigger_event_id);
    const body = launchEvidenceSummary(run.id, p.evidence);
    d.emit(
      "run_launch_evidence",
      card,
      {
        run_id: run.id,
        assignment_id: run.assignment_id,
        ...p.evidence,
      } as unknown as import("../entities.js").JsonValue,
      { type: "system", body, run_id: run.id },
    );
    return true;
  });
}
