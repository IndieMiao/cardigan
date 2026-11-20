import type { DatabaseSync } from "node:sqlite";
import {
  digestFeishu,
  feishuAudit,
  feishuBinding,
  redeemFeishuCode,
} from "@cardigan/store";

export interface AppCredential {
  app_id: string;
  app_secret: string;
  tenant_key: string;
}
export function parseAppCredential(value: string | undefined): AppCredential {
  try {
    const v = JSON.parse(value ?? "");
    if (
      /^cli_[a-fA-F0-9]{16}$/u.test(v.app_id) &&
      ["app_id", "app_secret", "tenant_key"].every(
        (k) =>
          typeof v[k] === "string" && v[k].length > 0 && v[k].length <= 512,
      )
    )
      return {
        app_id: v.app_id,
        app_secret: v.app_secret,
        tenant_key: v.tenant_key,
      };
  } catch {
    /* Never echo input. */
  }
  throw new Error("Invalid application configuration");
}
export const appScope = (c: AppCredential) =>
  digestFeishu(JSON.stringify([c.app_id, c.tenant_key]));
export interface FeishuJob {
  ref: string;
  key: string;
  text: string;
  generation: string;
  message: string;
  operator: string;
  chat: string;
}
const object = (x: unknown): Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : {};
const id = (x: unknown): x is string =>
  typeof x === "string" && x.length > 0 && x.length <= 256;
export const expired = "已过期，请在 Workbench 处理";
const toast = (content: string) => ({ toast: { type: "info", content } });
/** Only called by the private SDK dispatcher. The worker db has a short busy timeout. */
export function feishuInbox(
  db: DatabaseSync,
  c: AppCredential,
  post: (job: FeishuJob) => void,
  clock = Date.now,
  limits = { bindingAttempts: 30, pending: 32 },
  bindingFailed?: (recipient: string) => void,
) {
  const scope = appScope(c);
  let window = 0,
    tries = 0;
  return (kind: "action" | "binding", raw: unknown) => {
    const e = object(raw),
      op = object(e.operator),
      sender = object(e.sender),
      now = clock();
    let job: FeishuJob | undefined;
    let failedRecipient: string | undefined;
    const run = () => {
      const reject = (reason: string, stale = false) => {
        feishuAudit(db, reason);
        return toast(stale ? expired : "未处理");
      };
      const tenant = kind === "action" ? op.tenant_key : sender.tenant_key;
      if (
        e.app_id !== c.app_id ||
        e.tenant_key !== c.tenant_key ||
        tenant !== c.tenant_key ||
        !id(e.event_id)
      )
        return reject("invalid_envelope");
      if (kind === "binding") {
        const m = object(e.message),
          user = object(sender.sender_id).open_id;
        if (
          sender.sender_type !== "user" ||
          m.chat_type !== "p2p" ||
          m.message_type !== "text" ||
          !id(user) ||
          !id(m.chat_id) ||
          typeof m.content !== "string" ||
          m.content.length > 256
        )
          return reject("ignored_message");
        if (now - window >= 60_000) {
          window = now;
          tries = 0;
        }
        if (++tries > limits.bindingAttempts) return reject("limited");
        let code: unknown;
        try {
          code = object(JSON.parse(m.content)).text;
        } catch {
          return reject("invalid_code");
        }
        if (typeof code !== "string" || !/^\s*[0-9a-f]{32}\s*$/u.test(code))
          return reject("invalid_code");
        if (
          !db
            .prepare("INSERT OR IGNORE INTO feishu_events VALUES(?,?)")
            .run(scope, e.event_id).changes
        )
          return;
        if (!redeemFeishuCode(db, scope, user, m.chat_id, code.trim(), now)) {
          failedRecipient = user;
          return reject("invalid_code");
        }
        return;
      }
      const b = feishuBinding(db, scope),
        context = object(e.context),
        act = object(e.action),
        value = object(act.value),
        form = object(act.form_value);
      if (!b || op.open_id !== b.open_id || context.open_chat_id !== b.chat)
        return reject("unbound_operator");
      if (!id(value.ref) || !id(value.key) || !id(context.open_message_id))
        return reject("invalid_action");
      const card = db
        .prepare(
          "SELECT * FROM feishu_cards WHERE ref=? AND binding=? AND message=?",
        )
        .get(value.ref, b.generation, context.open_message_id);
      if (!card?.version) return reject("wrong_message", true);
      if (
        !(JSON.parse(String(card.choices)) as string[]).includes(
          digestFeishu(value.key),
        )
      )
        return reject("invalid_choice");
      if (card.state !== "open")
        return toast(
          card.state === "claimed"
            ? "处理中"
            : card.state === "done"
              ? "已由你处理"
              : card.state === "held"
                ? "已暂缓"
                : expired,
        );
      if (Number(card.expires) <= now) {
        db.prepare(
          "UPDATE feishu_cards SET state='stale',receipt=1 WHERE ref=?",
        ).run(value.ref);
        return reject("expired", true);
      }
      const text = form.note ?? "";
      if (
        typeof text !== "string" ||
        Array.from(text).length > 1000 ||
        (!text.trim() &&
          !(value.key === "merge" && card.item_kind === "merge_confirmation"))
      )
        return toast("请填写理由或结果（最多 1000 字）");
      if (
        Number(
          db
            .prepare(
              "SELECT count(*) AS n FROM feishu_cards WHERE state='claimed'",
            )
            .get()?.n,
        ) >= limits.pending
      )
        return toast("系统忙，请重试");
      if (
        !db
          .prepare("INSERT OR IGNORE INTO feishu_events VALUES(?,?)")
          .run(scope, e.event_id).changes
      )
        return toast("已受理");
      db.prepare("UPDATE feishu_cards SET state='claimed' WHERE ref=?").run(
        value.ref,
      );
      feishuAudit(db, "accepted", b.member, value.ref);
      job = {
        ref: value.ref,
        key: value.key,
        text: text.trim(),
        generation: b.generation,
        message: context.open_message_id,
        operator: b.open_id,
        chat: b.chat,
      };
      return toast("处理中");
    };
    try {
      db.exec("BEGIN IMMEDIATE");
      let result: ReturnType<typeof run>;
      try {
        result = run();
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      if (job) post(job);
      if (failedRecipient) bindingFailed?.(failedRecipient);
      return kind === "action" ? result : undefined;
    } catch {
      return kind === "action"
        ? toast("暂未完成，请在 Workbench 处理")
        : undefined;
    }
  };
}
