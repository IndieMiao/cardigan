import type { Assignment, Notification } from "@cardigan/domain";
import { sessionMaintenanceReasons } from "@cardigan/domain";
import { readAttention } from "@cardigan/host";
import { launchWarnings } from "@cardigan/roles";
import {
  backfillStandingModesInTransaction,
  openStore,
  type Store,
} from "@cardigan/store";
import { requireCliTool } from "./command-access.js";
import { loadOptionalConfigSync } from "./config.js";
import { CliError, EXIT } from "./errors.js";
import { announceDataDir, resolveActor, resolveProject } from "./host.js";
import type { CliIo } from "./io.js";
import { cliLaunchPaths } from "./paths.js";

/**
 * M3.5 read-only views until M5 builds the pages.
 *
 * `cardigan inbox` shows what is still owed to Assignments (M3 plan §3.2):
 * pending/belled notifications and the ones whose bell failed. `cardigan
 * attention` shows what a human must look at: escalated notifications
 * (`needs_attention`, `delivery_failed`) and Assignments whose runtime is lost
 * (§3.3, §13.9).
 */

const USAGE = [
  "用法：",
  "  cardigan inbox [--assignment <A-n>] [--project <p>] [--data-dir <目录>]",
  "  cardigan attention [--project <p>] [--data-dir <目录>]",
  "",
  "--assignment 省略时列出该项目所有接收者的通知。",
].join("\n");

function parseFlags(
  args: readonly string[],
  allowed: readonly string[],
): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (!token.startsWith("--")) {
      throw new CliError(`不认识的参数：${token}`, EXIT.usage, [USAGE]);
    }
    const name = token.slice(2);
    if (!allowed.includes(name)) {
      throw new CliError(`不认识的参数：${token}`, EXIT.usage, [USAGE]);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliError(`${token} 需要一个值`, EXIT.usage, [USAGE]);
    }
    flags[name] = value;
    index += 1;
  }
  return flags;
}

const recipientOf = (notification: Notification): string =>
  notification.recipient.kind === "assignment"
    ? `assignment:${notification.recipient.assignment_id}`
    : notification.recipient.kind;

const ageMinutes = (from: string, now: string): number =>
  Math.max(0, Math.round((Date.parse(now) - Date.parse(from)) / 60_000));

/**
 * The logical recipient a standing PM Assignment answers to (`pm_office` /
 * `pm_ops`), told apart by the tool scope of its newest token (§7.1).
 */
function standingRecipient(
  store: Store,
  project_id: string,
  assignment_id: Assignment["id"],
): "pm_office" | "pm_ops" | undefined {
  // M4.5: the mode is data. A row written before the field existed is stamped
  // from its newest token here, once, and then read from the field.
  return store.uow.run((tx) => {
    backfillStandingModesInTransaction(tx, project_id as never);
    const assignment = tx.assignments.get(project_id as never, assignment_id);
    if (
      assignment === undefined ||
      assignment.scope !== "standing" ||
      assignment.role_id !== "pm"
    )
      return undefined;
    return assignment.standing_mode === "office"
      ? "pm_office"
      : assignment.standing_mode === "ops"
        ? "pm_ops"
        : undefined;
  });
}

/** `cardigan inbox` — pending, belled and failed notifications, grouped by owner. */
export function inboxCommand(args: readonly string[], io: CliIo): number {
  const flags = parseFlags(args, ["assignment", "project", "data-dir"]);
  const store = open(io, flags);
  try {
    const project_id = resolveProject(store, io, flags.project);
    const actor = resolveActor(io, project_id, store);
    requireCliTool(actor, "inbox");
    if (
      actor.kind === "assignment" &&
      flags.assignment !== undefined &&
      flags.assignment !== actor.assignment_id
    )
      throw new CliError(
        "Token 模式只能读取所属 Assignment 的收件箱，不能指定其他 --assignment。",
        EXIT.usage,
      );
    const assignment =
      actor.kind === "assignment" ? actor.assignment_id : flags.assignment;
    const wanted: Assignment["id"] | undefined =
      assignment === undefined ? undefined : (assignment as Assignment["id"]);
    // §7.1: a standing PM is addressed logically (pm_office / pm_ops) as well as
    // directly, so asking for its Assignment must not hide those notifications.
    const logical =
      wanted === undefined || actor.kind === "assignment"
        ? undefined
        : standingRecipient(store, project_id, wanted);
    const rows = store
      .listNotifications({ project_id })
      .filter(
        (notification) =>
          ["pending", "belled", "delivery_failed"].includes(
            notification.status,
          ) &&
          (wanted === undefined ||
            (notification.recipient.kind === "assignment" &&
              notification.recipient.assignment_id === wanted) ||
            (logical !== undefined && notification.recipient.kind === logical)),
      );
    if (rows.length === 0) {
      io.stdout("收件箱是空的：没有待投递或投递失败的通知。");
      return EXIT.ok;
    }
    const groups = new Map<string, Notification[]>();
    for (const row of rows) {
      const key = recipientOf(row);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const now = new Date().toISOString();
    const lines = [`待投递通知（${rows.length}）`];
    for (const [owner, notes] of [...groups].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      lines.push(`${owner}（${notes.length}）`);
      for (const note of notes) {
        lines.push(
          `  ${note.status.padEnd(15)} seq=${note.seq} ${note.kind}${note.card_id === undefined ? "" : ` ${note.card_id}`} attempts=${note.attempts}${note.next_attempt_at === undefined ? "" : ` next=${note.next_attempt_at}`} age=${ageMinutes(note.created_at, now)}m`,
        );
      }
    }
    io.stdout(lines.join("\n"));
    return EXIT.ok;
  } finally {
    store.close();
  }
}

/** `cardigan attention` — escalations and lost runtimes. */
export function attentionCommand(args: readonly string[], io: CliIo): number {
  const flags = parseFlags(args, ["project", "data-dir"]);
  const store = open(io, flags);
  try {
    const project_id = resolveProject(store, io, flags.project);
    const now = new Date().toISOString();
    const paths = cliLaunchPaths(io, flags["data-dir"]);
    const config = loadOptionalConfigSync(paths);
    const warnings = config ? launchWarnings(config) : [];
    const {
      attention,
      merge_stalls,
      escalated,
      lost,
      paused,
      queued,
      findings,
      session_maintenance,
    } = readAttention(store, project_id, now);
    if (
      warnings.length === 0 &&
      attention.length === 0 &&
      merge_stalls.length === 0 &&
      escalated.length === 0 &&
      lost.length === 0 &&
      findings.length === 0 &&
      paused.length === 0 &&
      queued.length === 0 &&
      session_maintenance.length === 0
    ) {
      io.stdout(
        "没有需要关注的项：没有升级通知，没有失联的 Assignment，也没有对账发现。",
      );
      return EXIT.ok;
    }
    const lines: string[] = [];
    if (session_maintenance.length) {
      lines.push(`会话维护（${session_maintenance.length}）`);
      for (const observation of session_maintenance)
        lines.push(
          `  ${observation.assignment_id} ${sessionMaintenanceReasons[observation.reason]}${observation.candidate ? " · 空闲候选" : ""}；最近评估 ${observation.evaluated_at}；候选阈值 ${observation.threshold_minutes} 分钟`,
        );
    }
    if (warnings.length) {
      lines.push(`启动配置告警（${warnings.length}）`);
      for (const warning of warnings)
        lines.push(`  ${warning.profile}：${warning.message}`);
    }
    if (attention.length) {
      lines.push(`审核恢复异常（${attention.length}）`);
      for (const finding of attention)
        lines.push(
          `  ${finding.kind} ${finding.card_id} age=${ageMinutes(finding.resolved_at, now)}m ${finding.detail}`,
        );
    }
    if (merge_stalls.length) {
      lines.push(`PM 合并确认停留（${merge_stalls.length}）`);
      for (const stall of merge_stalls)
        lines.push(
          `  ${stall.kind} ${stall.card_id} ${stall.decision_id} age=${Math.floor(stall.waited_ms / 60_000)}m threshold=${stall.threshold_minutes}m`,
        );
    }
    if (queued.length) {
      lines.push(`等待并发名额（${queued.length}）`);
      for (const run of queued)
        lines.push(
          `  ${run.run_id} ${run.assignment_id}${run.card_id ? ` ${run.card_id}` : ""} ${run.machine_id} ${run.dispatch_reason ?? ""} 排队中（前面还有 ${run.ahead} 个）`,
        );
    }
    if (paused.length) {
      lines.push(`常驻 PM 已暂停（${paused.length}，门铃排队，不自动启动）`);
      for (const a of paused)
        lines.push(
          `  ${a.id} ${a.standing_mode ?? "pm"} suspended；cardigan assignment start ${a.id} --project ${project_id}`,
        );
    }
    if (findings.length > 0) {
      lines.push(`对账发现（${findings.length}，只报告，不会自动删除）`);
      for (const finding of findings)
        lines.push(
          `  ${finding.kind.padEnd(22)} first=${finding.first_seen_at} last=${finding.last_seen_at} age=${ageMinutes(finding.first_seen_at, now)}m ${finding.detail}${finding.path === undefined ? "" : `  ${finding.path}`}${finding.delivery_id === undefined ? "" : `  ${finding.delivery_id}`}`,
        );
    }
    if (escalated.length > 0) {
      lines.push(`升级通知（${escalated.length}）`);
      for (const note of escalated)
        lines.push(
          `  ${note.status.padEnd(15)} ${recipientOf(note)} seq=${note.seq} ${note.kind}${note.card_id === undefined ? "" : ` ${note.card_id}`} attempts=${note.attempts} age=${ageMinutes(note.created_at, now)}m`,
        );
    }
    if (lost.length > 0) {
      lines.push(`失联 / 状态未知的 Assignment（${lost.length}）`);
      for (const assignment of lost)
        lines.push(
          `  ${assignment.id} ${assignment.role_id} v${assignment.role_version} runtime=${assignment.runtime_state}${assignment.runtime_ref?.terminal_ref === undefined ? "" : ` terminal=${assignment.runtime_ref.terminal_ref}`}`,
        );
    }
    io.stdout(lines.join("\n"));
    return EXIT.ok;
  } finally {
    store.close();
  }
}

/** Open the store the way the other read-only commands do. */
function open(io: CliIo, flags: Record<string, string>): Store {
  return openStore({ dataDir: announceDataDir(io, flags["data-dir"]) });
}
