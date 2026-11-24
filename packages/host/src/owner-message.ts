import { randomUUID } from "node:crypto";
import {
  type Actor,
  type CardId,
  type Clock,
  managedPmOffice,
  type OwnerMessageInput,
  ownerTextError,
  type ProjectId,
  qualifyId,
} from "@cardigan/domain";
import {
  digestFeishu,
  feishuBinding,
  finishExtAttempt,
  type ReadRepositories,
  reserveExtAttempt,
  type Store,
  type StoreTransactionContext,
} from "@cardigan/store";
import {
  type ExtMessageConfig,
  extChannelLimit,
  extMessageQuiet,
} from "./ext-message-config.js";
import type { FeishuApp } from "./feishu-app.js";

const hour = 3_600_000;

/**
 * C-674: the owner reads messages from every project in one chat, so each
 * one leads with the card's full number (`[SEN-C-34]`) unless the author
 * already put it first.
 */
export function ownerMessageText(
  code: string | undefined,
  card: CardId,
  body: string,
): string {
  const ref = qualifyId(code, card);
  return body.trimStart().startsWith(ref) ||
    body.trimStart().startsWith(`[${ref}]`)
    ? body
    : `[${ref}] ${body}`;
}
const limit = 6;
type Row = {
  project: ProjectId;
  card: CardId;
  id: string;
  binding: string;
  body: string;
  summary: string;
  sha256: string;
};
type Status = "queued" | "sent" | "skipped" | "unknown" | "failed";
const labels: Record<Status, string> = {
  queued: "已排队",
  sent: "已发送",
  skipped: "已跳过",
  unknown: "送达未确认",
  failed: "发送失败",
};
function audit(
  tx: StoreTransactionContext,
  r: Row,
  actor: Actor,
  status: Status,
  now: number,
  reason?: string,
) {
  const at = new Date(now).toISOString(),
    seq = tx.ids.nextEventSequence(r.project, r.card);
  const summary = tx.cards.get(r.project, r.card)?.sensitive
    ? "敏感卡"
    : r.summary;
  tx.events.append(r.project, {
    id: tx.ids.nextEventId(),
    card_id: r.card,
    seq,
    type: `owner_message_${status}`,
    actor,
    created_at: at,
    payload: {
      message_id: r.id,
      summary,
      sha256: r.sha256,
      status,
      ...(reason ? { reason } : {}),
    },
  });
  const id = tx.ids.nextTimelineEntryId(r.project, r.card);
  tx.timeline.put(r.project, {
    id,
    short_id: id,
    card_id: r.card,
    event_seq: seq,
    type: "system",
    author:
      actor.kind === "assignment"
        ? `assignment:${actor.assignment_id}`
        : "system",
    created_at: at,
    refs: [],
    mentions: [],
    retracted: false,
    body: `飞书私聊${labels[status]}${reason ? `（${reason}）` : ""}：${summary}\nSHA-256：${r.sha256}`,
  });
}
function blocked(
  tx: Pick<ReadRepositories, "project_preferences" | "cards">,
  project: ProjectId,
  card: CardId,
) {
  if (tx.project_preferences.get(project, project)?.pm_owner_messages !== true)
    return "项目未开启所有者私聊";
  const target = tx.cards.get(project, card);
  if (!target) return "卡片不存在";
  if (target.sensitive) return "敏感卡不能发送私聊";
}

export function enqueueOwnerMessage(
  store: Store,
  actor: Extract<Actor, { kind: "assignment" }>,
  input: OwnerMessageInput,
  revalidate: () => void,
  clock = Date.now,
) {
  const project = actor.project_id,
    card = input.card_id,
    error = ownerTextError(input.text);
  if (error) throw new Error(error);
  const sha256 = digestFeishu(input.text);
  const result = store.runIdempotent(
    {
      project_id: project,
      assignment_id: actor.assignment_id,
      key: input.idempotency_key,
      request: { tool: "send_owner_message", card, sha256 },
    },
    (tx) => {
      revalidate();
      const assignment = tx.assignments.get(project, actor.assignment_id);
      if (
        !managedPmOffice(assignment) ||
        assignment?.status !== "active" ||
        assignment.role_version !== actor.role_version ||
        !actor.allowed_tools.includes("send_owner_message")
      )
        throw new Error("仅托管常驻 PM Office 可发私聊");
      const denied = blocked(tx, project, card);
      if (denied) throw new Error(denied);
      const db = store.database,
        runtime = db
          .prepare("SELECT scope,state FROM feishu_runtime WHERE id=1")
          .get();
      const binding = runtime && feishuBinding(db, String(runtime.scope));
      if (!binding) throw new Error("所有者尚未绑定飞书私聊");
      if (["failed", "disabled", "stopped"].includes(String(runtime.state)))
        throw new Error("飞书私聊通道不可用");
      const now = clock();
      if (
        Number(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM owner_messages WHERE project=? AND accepted>?",
            )
            .get(project, now - hour)?.n,
        ) >= limit
      )
        throw new Error("每项目每小时最多 6 条私聊");
      const row: Row = {
        id: randomUUID(),
        project,
        card,
        binding: binding.generation,
        body: input.text,
        summary: [...input.text.trim().replace(/\s+/gu, " ")]
          .slice(0, 80)
          .join(""),
        sha256,
      };
      db.prepare(
        `INSERT INTO owner_messages(id,project,card,binding,body,summary,sha256,accepted,status) VALUES(?,?,?,?,?,?,?,?,'queued')`,
      ).run(
        row.id,
        project,
        card,
        row.binding,
        row.body,
        row.summary,
        sha256,
        now,
      );
      audit(tx, row, actor, "queued", now);
      return { message_id: row.id, status: "queued" as const };
    },
  );
  if (!result.ok) throw result.error;
  return result.value.value;
}

/** One item per tick. Never retry an attempt whose remote outcome might have been lost. */
export async function drainOwnerMessage(
  store: Store,
  app: FeishuApp | undefined,
  config: ExtMessageConfig | undefined,
  clock: Clock,
  current: () => boolean,
) {
  const db = store.database,
    now = () => Date.parse(clock.now());
  const next = (at: number) =>
    db
      .prepare(`SELECT * FROM owner_messages AS m WHERE
    (status='sending' AND deadline<=?) OR
    (status='queued' AND (SELECT COUNT(*) FROM owner_messages AS a WHERE a.project=m.project AND a.attempted>?)<?)
    ORDER BY accepted,rowid LIMIT 1`)
      .get(at, at - hour, limit) as (Row & { status: string }) | undefined;
  if (!current() || !next(now())) return;
  const settle = (
    tx: StoreTransactionContext,
    r: Row,
    status: Exclude<Status, "queued">,
    reason?: string,
  ) => {
    db.prepare("UPDATE owner_messages SET status=?,body=NULL WHERE id=?").run(
      status,
      r.id,
    );
    audit(
      tx,
      r,
      { kind: "system", project_id: r.project },
      status,
      now(),
      reason,
    );
  };
  const claim = store.uow.run((tx) => {
    const at = now(),
      row = next(at);
    if (!row || !current()) return;
    if (row.status === "sending") {
      settle(tx, row, "unknown");
      return;
    }
    const binding = app?.binding;
    const denied =
      blocked(tx, row.project, row.card) ??
      (!config?.channels.lark_app?.enabled ||
      !config.enabled ||
      !app ||
      app.stopped
        ? "飞书私聊通道不可用"
        : binding?.generation !== row.binding
          ? "所有者绑定已变更"
          : undefined);
    if (denied) {
      settle(tx, row, "skipped", denied);
      return;
    }
    if (!config || !binding || extMessageQuiet(config, clock.now())) return;
    const deadline = at + config.policy.timeout_ms;
    if (
      !reserveExtAttempt(
        db,
        "lark_app",
        at,
        extChannelLimit(config, "lark_app"),
        row.id,
        deadline,
      )
    )
      return;
    db.prepare(
      `UPDATE owner_messages SET body=NULL,status='sending',attempted=?,deadline=? WHERE id=?`,
    ).run(at, deadline, row.id);
    return { row, deadline };
  });
  if (!claim || !app || !config) return;
  const { row, deadline } = claim;
  const binding = app.binding;
  let status: Exclude<Status, "queued">;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deny = store.uow.read((tx) => blocked(tx, row.project, row.card));
  if (deny || !current() || app.stopped || binding?.generation !== row.binding)
    status = "skipped";
  else if (extMessageQuiet(config, clock.now()) || now() >= deadline) {
    // The boundary moved between claim and dispatch; nothing went on the wire.
    store.uow.run(() => {
      db.prepare(
        `UPDATE owner_messages SET body=?,status='queued',attempted=NULL,deadline=NULL WHERE id=? AND status='sending'`,
      ).run(row.body, row.id);
      finishExtAttempt(db, row.id, null);
    });
    return;
  } else
    try {
      status = await Promise.race([
        app.remote
          .text(
            binding.open_id,
            row.id,
            ownerMessageText(
              store.projectCode(row.project),
              row.card,
              row.body,
            ),
          )
          .then((ok) => (ok ? ("sent" as const) : ("failed" as const))),
        new Promise<"unknown">((resolve) => {
          timer = setTimeout(
            () => resolve("unknown"),
            Math.max(1, deadline - now()),
          );
        }),
      ]);
    } catch {
      status = "unknown";
    } finally {
      clearTimeout(timer);
    }
  store.uow.run((tx) => {
    if (
      db.prepare("SELECT status FROM owner_messages WHERE id=?").get(row.id)
        ?.status !== "sending"
    )
      return;
    finishExtAttempt(db, row.id, status === "skipped" ? null : now());
    settle(tx, row, status, deny);
  });
}
