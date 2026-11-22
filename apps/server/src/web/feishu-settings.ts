import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import {
  boundTestAdapter,
  extChannelLimit,
  extFingerprints,
  extMessageAdapters,
  loadExtMessageConfig,
  sendExtMessage,
} from "@cardigan/host";
import {
  activateExtChannels,
  finishExtAttempt,
  reserveExtAttempt,
  type Store,
  type WebSession,
} from "@cardigan/store";
import { z } from "zod";
import {
  type Change,
  type Channel,
  changeSchema,
  channelNames,
  invalid,
  plan,
  publicSettings,
  publish,
  readSettings,
  stale,
  valuesSchema,
} from "./feishu-settings-file.js";
import {
  HttpRejection,
  methodNotAllowed,
  readJsonBody,
  sendJson,
} from "./http.js";
import { digest } from "./launch-settings-file.js";
import { serialSecrets } from "./launch-settings-secrets.js";

const version = z.string().regex(/^[a-f0-9]{64}$/u);
const preview = z.strictObject({ version, change: changeSchema });
const confirm = z.strictObject({
  version,
  preview_id: z.uuid(),
  secrets: valuesSchema.default({}),
});
function checked<T>(schema: z.ZodType<T>, value: unknown) {
  const r = schema.safeParse(value);
  if (!r.success) throw invalid();
  return r.data;
}
const denied = () => new HttpRejection(403, "human_only", "仅限人员登录会话");
export class FeishuSettings {
  private closing = false;
  private readonly pending = new Set<Promise<unknown>>();
  beginShutdown() {
    this.closing = true;
  }
  async drain() {
    await Promise.allSettled(this.pending);
  }
  private previews = new Map<
    string,
    { owner: string; version: string; change: Change }
  >();
  constructor(
    private store: Store,
    private path: string,
  ) {}
  private replay(key: string, subject: string) {
    const row = this.store.database
      .prepare(
        "SELECT subject,result FROM feishu_settings_requests WHERE request_key=?",
      )
      .get(key);
    if (row && row.subject !== subject)
      throw new HttpRejection(
        409,
        "idempotency_conflict",
        "请求键已用于其他操作",
      );
    return row ? String(row.result) : null;
  }
  private record(
    key: string,
    subject: string,
    actor: string,
    keys: string[],
    result: string,
  ) {
    this.store.database
      .prepare(
        "INSERT INTO feishu_settings_requests(request_key,subject,actor,keys,result,at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        key,
        subject,
        actor,
        JSON.stringify(keys),
        result,
        new Date().toISOString(),
      );
  }
  private async test(channel: Channel, key: string, authorize: () => string) {
    const subject = `test.${channel}`,
      db = this.store.database,
      lease = randomUUID();
    const ready = this.store.uow.run(() => {
      const actor = authorize();
      const replay = this.replay(key, subject);
      if (replay) return { result: replay } as const;
      const c = loadExtMessageConfig(this.path);
      if (
        c.status !== "loaded" ||
        !c.config.enabled ||
        !c.config.channels[channel]?.enabled
      )
        throw new HttpRejection(
          409,
          "channel_disabled",
          "渠道未启用或配置无效",
        );
      const credential = c.config.channels[channel].credential,
        timeout = c.config.policy.timeout_ms;
      const adapter =
        channel === "lark"
          ? extMessageAdapters.lark?.(credential)
          : credential
            ? boundTestAdapter(this.store, credential, actor, timeout)
            : undefined;
      if (!adapter)
        throw new HttpRejection(
          409,
          "binding_unavailable",
          "应用凭据无效或本人尚未绑定",
        );
      const at = Date.now();
      if (
        !reserveExtAttempt(
          db,
          channel,
          at,
          extChannelLimit(c.config, channel),
          lease,
          at + timeout,
        )
      )
        throw new HttpRejection(429, "rate_limited", "渠道已限速");
      // Ambiguous outcome, including a process exit after dispatch, never authorizes a retry.
      this.record(key, subject, actor, [subject], "unknown");
      return { adapter, timeout, url: c.config.workbench_url } as const;
    });
    if ("result" in ready) return ready.result;
    const result = await sendExtMessage(
      ready.adapter,
      { title: "Cardigan 外部通知测试", url: ready.url },
      ready.timeout,
    );
    this.store.uow.run(() => {
      finishExtAttempt(db, lease, Date.now());
      db.prepare(
        "UPDATE feishu_settings_requests SET result=? WHERE request_key=?",
      ).run(result, key);
    });
    return result;
  }
  async serve(
    rest: string,
    req: IncomingMessage,
    res: ServerResponse,
    authorize: () => WebSession,
    owner: string,
  ) {
    if (req.headers.authorization !== undefined) throw denied();
    const human = () => {
      const actor = authorize().member_id;
      if (
        !actor ||
        !this.store.database
          .prepare(
            "SELECT 1 FROM members WHERE id=? AND role='owner' AND status='active'",
          )
          .get(actor)
      )
        throw denied();
      return actor;
    };
    if (rest === "") {
      human();
      if (req.method !== "GET") methodNotAllowed(["GET"]);
      const f = readSettings(this.path);
      sendJson(res, 200, {
        version: f.version,
        settings: publicSettings(f),
        secrets: f.secrets,
      });
      return;
    }
    if (
      !["/preview", "/confirm", "/test/lark", "/test/lark_app"].includes(rest)
    )
      throw new HttpRejection(404, "not_found", "接口不存在");
    if (req.method !== "POST") methodNotAllowed(["POST"]);
    const body = await readJsonBody(req);
    if (this.closing)
      throw new HttpRejection(503, "shutting_down", "后台正在关闭");
    human();
    if (rest === "/preview") {
      const input = checked(preview, body),
        f = readSettings(this.path);
      if (f.version !== input.version) throw stale();
      const diff = plan(f, input.change),
        id = randomUUID();
      if (this.previews.size >= 128)
        this.previews.delete(this.previews.keys().next().value!);
      this.previews.set(id, {
        owner,
        version: f.version,
        change: input.change,
      });
      sendJson(res, 200, {
        preview_id: id,
        version: f.version,
        diff,
        restart_required: false,
      });
      return;
    }
    const raw = req.headers["idempotency-key"];
    if (typeof raw !== "string" || !raw.trim() || raw.length > 128)
      throw new HttpRejection(400, "idempotency_required", "需要请求键");
    const key = digest(JSON.stringify([owner, raw]));
    if (rest === "/confirm") {
      const input = checked(confirm, body),
        subject = `confirm:${input.preview_id}:${input.version}`;
      const result = await serialSecrets(dirname(this.path), async () =>
        this.store.uow.run((tx) => {
          const actor = human();
          const replay = this.replay(key, subject);
          if (replay) return replay;
          const p = this.previews.get(input.preview_id),
            f = readSettings(this.path);
          if (
            !p ||
            p.owner !== owner ||
            input.version !== p.version ||
            f.version !== p.version
          )
            throw stale();
          const diff = plan(f, p.change);
          try {
            publish(f, p.change, input.secrets, (effective) => {
              activateExtChannels(
                this.store.database,
                tx,
                extFingerprints(effective, true),
                new Date().toISOString(),
              );
              this.record(
                key,
                subject,
                actor,
                diff.map((d) => d.key),
                "applied",
              );
            });
          } catch (e) {
            if (e instanceof HttpRejection) throw e;
            throw invalid();
          }
          this.previews.delete(input.preview_id);
          return "applied";
        }),
      );
      sendJson(res, 200, { result });
      return;
    }
    checked(z.strictObject({}), body);
    const task = this.test(
      checked(z.enum(channelNames), rest.slice("/test/".length)),
      key,
      human,
    );
    this.pending.add(task);
    try {
      sendJson(res, 200, { result: await task });
    } finally {
      this.pending.delete(task);
    }
  }
}
