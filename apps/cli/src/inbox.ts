import type { Assignment, Notification } from "@cardigan/domain";
import { openStore, type Store, tokensForAssignment } from "@cardigan/store";
import { CliError, EXIT } from "./errors.js";
import { resolveDataDir, resolveProject } from "./host.js";
import type { CliIo } from "./io.js";

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
  const assignment = store.uow.read((tx) =>
    tx.assignments.get(project_id, assignment_id),
  );
  if (
    assignment === undefined ||
    assignment.scope !== "standing" ||
    assignment.role_id !== "pm"
  )
    return undefined;
  return tokensForAssignment(store.database, project_id as never, assignment_id)
    .at(-1)
    ?.allowed_tools.includes("record_decision")
    ? "pm_office"
    : "pm_ops";
}

/** `cardigan inbox` — pending, belled and failed notifications, grouped by owner. */
export function inboxCommand(args: readonly string[], io: CliIo): number {
  const flags = parseFlags(args, ["assignment", "project", "data-dir"]);
  const store = open(io, flags);
  try {
    const project_id = resolveProject(store, io, flags.project);
    const assignment = flags.assignment;
    const wanted: Assignment["id"] | undefined =
      assignment === undefined ? undefined : (assignment as Assignment["id"]);
    // §7.1: a standing PM is addressed logically (pm_office / pm_ops) as well as
    // directly, so asking for its Assignment must not hide those notifications.
    const logical =
      wanted === undefined
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
    const escalated = store
      .listNotifications({ project_id })
      .filter((notification) =>
        ["needs_attention", "delivery_failed"].includes(notification.status),
      );
    const lost = store.uow.read((tx) =>
      tx.assignments
        .list(project_id)
        .filter(
          (candidate) =>
            candidate.status === "active" &&
            ["lost", "unknown"].includes(candidate.runtime_state),
        ),
    );
    if (escalated.length === 0 && lost.length === 0) {
      io.stdout("没有需要关注的项：没有升级通知，也没有失联的 Assignment。");
      return EXIT.ok;
    }
    const now = new Date().toISOString();
    const lines: string[] = [];
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
  return openStore({ dataDir: resolveDataDir(io, flags["data-dir"]) });
}
