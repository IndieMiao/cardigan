import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

import {
  type CommandState,
  completeHumanAction,
  type ExtMessageItem,
  type ExtMessagePort,
  extInteraction,
  extMessageItems,
  extMessageUrl,
  type ProjectId,
  recordDecision,
} from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import {
  digestFeishu,
  feishuAudit,
  feishuBinding,
  type Store,
  type StoreTransactionContext,
} from "@cardigan/store";
import type { ExtMessageConfiguration } from "./ext-message-config.js";
import {
  currentExtGeneration,
  type ExtGeneration,
} from "./ext-message-generation.js";
import { feishuCard, feishuReceipt } from "./feishu-card.js";
import {
  type AppCredential,
  appScope,
  type FeishuJob,
  parseAppCredential,
} from "./feishu-inbox.js";
import { feishuSdk, privateSdkHttp, privateSdkLogger } from "./feishu-sdk.js";

type Gate =
  | ((project: ProjectId) => CommandState["project_settings"])
  | undefined;
export interface AppTransport {
  create(
    to: string,
    uuid: string,
    content: string,
  ): Promise<string | undefined>;
  bindingFailure(to: string): Promise<void>;
  patch(id: string, content: string): Promise<boolean>;
}
function transport(c: AppCredential, timeout: number): AppTransport {
  const { Client } = feishuSdk();
  const client = new Client({
    appId: c.app_id,
    appSecret: c.app_secret,
    logger: privateSdkLogger,
    httpInstance: privateSdkHttp(timeout),
  });
  return {
    async create(to, uuid, content) {
      const r = await client.im.message.create({
        params: { receive_id_type: "open_id" },
        data: { receive_id: to, msg_type: "interactive", content, uuid },
      });
      return r.code === 0 ? r.data?.message_id : undefined;
    },
    async bindingFailure(to) {
      await client.im.message.create({
        params: { receive_id_type: "open_id" },
        data: {
          receive_id: to,
          msg_type: "text",
          uuid: randomUUID(),
          content: JSON.stringify({
            text: "未能绑定，请回到 Workbench 重新生成绑定码。",
          }),
        },
      });
    },
    async patch(id, content) {
      return (
        (
          await client.im.message.patch({
            path: { message_id: id },
            data: { content },
          })
        ).code === 0
      );
    },
  };
}
/** No recipient or message content can be supplied by a Workbench request. */
export function boundTestAdapter(
  store: Store,
  credential: string | undefined,
  member: string,
  timeout: number,
  makeTransport = transport,
): ExtMessagePort | undefined {
  const c = parseAppCredential(credential),
    scope = appScope(c),
    binding = feishuBinding(store.database, scope);
  if (!binding || binding.member !== member) return;
  const client = makeTransport(c, timeout);
  return {
    send: async (message, signal) => {
      if (
        signal.aborted ||
        feishuBinding(store.database, scope)?.generation !== binding.generation
      )
        return "permanent";
      return (await client.create(
        binding.open_id,
        randomUUID(),
        feishuCard(message, "", []),
      ))
        ? "sent"
        : "permanent";
    },
  };
}
export function startFeishu(
  store: Store,
  config: ExtMessageConfiguration,
  gate: Gate,
  tx?: StoreTransactionContext,
  generation?: ExtGeneration,
) {
  const status = (scope: string, state: string) =>
    store.database
      .prepare("INSERT OR REPLACE INTO feishu_runtime VALUES(1,?,?,?,?)")
      .run(
        scope,
        state,
        Date.now(),
        config.status === "loaded"
          ? (config.config.channels.lark_app?.binding_ttl_ms ?? 300_000)
          : 300_000,
      );
  if (
    config.status !== "loaded" ||
    !config.config.enabled ||
    !config.config.channels.lark_app?.enabled
  ) {
    const last = store.database
      .prepare("SELECT scope FROM feishu_runtime WHERE id=1")
      .get();
    status(String(last?.scope ?? ""), "disabled");
    return;
  }
  try {
    const c = parseAppCredential(config.config.channels.lark_app.credential),
      scope = appScope(c);
    const app = new FeishuApp(
      store,
      scope,
      config.config.workbench_url,
      transport(c, config.config.policy.timeout_ms),
      gate,
      Date.now,
      config.config.channels.lark_app.action_ttl_ms,
      generation,
    );
    const recover = () => {
      store.database
        .prepare("DELETE FROM feishu_codes WHERE scope<>?")
        .run(scope);
      store.database
        .prepare("DELETE FROM feishu_bindings WHERE scope<>?")
        .run(scope);
      status(scope, "connecting");
      app.recover();
    };
    if (tx) recover();
    else store.uow.run(recover);
    const worker = new Worker(
      new URL("./feishu-ws-worker.js", import.meta.url),
      {
        workerData: {
          credential: c,
          generation,
          path: store.database.location(),
          limits: {
            bindingAttempts:
              config.config.channels.lark_app.binding_attempts_per_minute ?? 30,
            pending: config.config.channels.lark_app.pending_limit ?? 32,
          },
        },
      },
    );
    app.stopWorker = async () => {
      if (worker.threadId !== -1)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => void worker.terminate(), 1000);
          worker.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          worker.postMessage("stop");
        });
      status(scope, "stopped");
    };
    worker.on(
      "message",
      (m: { state?: string; job?: FeishuJob; bindingFailure?: string }) => {
        if (app.stopped || !currentExtGeneration(generation)) return;
        try {
          if (m.bindingFailure) {
            void app.remote.bindingFailure(m.bindingFailure).catch(() => {});
          } else if (m.job) {
            try {
              app.execute(m.job);
            } catch {
              app.abandon(m.job.ref);
            }
          } else if (
            m.state &&
            [
              "idle",
              "connecting",
              "connected",
              "reconnecting",
              "failed",
            ].includes(m.state)
          )
            status(scope, m.state);
        } catch {
          /* never log callback text; abandoned claims reconciled on restart */
        }
      },
    );
    worker.on("error", () => {
      if (!app.stopped) status(scope, "failed");
    });
    worker.on("exit", () => {
      if (!app.stopped) status(scope, "failed");
    });
    return app;
  } catch {
    status("", "failed");
    return;
  }
}
export class FeishuApp {
  stopped = false;
  stopWorker?: () => Promise<void>;
  constructor(
    readonly store: Store,
    readonly scope: string,
    readonly base: string,
    readonly remote: AppTransport,
    readonly gate: Gate,
    readonly now = Date.now,
    readonly actionTtl = 86_400_000,
    readonly generation?: ExtGeneration,
  ) {}
  get db() {
    return this.store.database;
  }
  get binding() {
    return currentExtGeneration(this.generation)
      ? feishuBinding(this.db, this.scope)
      : undefined;
  }
  abandon(ref: string) {
    this.db
      .prepare(
        "UPDATE feishu_cards SET state='failed',receipt=1 WHERE ref=? AND state='claimed'",
      )
      .run(ref);
  }
  recover() {
    this.db
      .prepare(
        "UPDATE feishu_cards SET state='failed',receipt=1 WHERE state='claimed'",
      )
      .run();
  }
  async stop() {
    this.stopped = true;
    await this.stopWorker?.();
  }
  /** Created inside the outbox lease transaction, with the exact state used to claim the row. */
  prepare(
    interaction: ReturnType<typeof extInteraction>,
    item: ExtMessageItem,
    digest: string | null,
  ): ExtMessagePort | undefined {
    const b = this.binding;
    if (!b) return;
    const { options, basis, sensitive } = interaction,
      version = digest || !options.length ? "" : digestFeishu(basis);
    const actions = digest ? [] : options;
    const sendKey = digestFeishu(
      JSON.stringify([
        b.generation,
        // A rate digest spans projects. Its remote idempotency key must not
        // change when the first member is handled between attempts.
        digest?.startsWith("rate:") ? null : item.project_id,
        digest ?? item.item_id,
        version,
      ]),
    );
    this.db
      .prepare(
        "INSERT OR IGNORE INTO feishu_cards(ref,send_key,binding,project,item_kind,item,version,expires,choices) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        sendKey,
        b.generation,
        item.project_id,
        item.kind,
        item.item_id,
        version,
        this.now() + this.actionTtl,
        JSON.stringify(actions.map((o) => digestFeishu(o.key))),
      );
    const ref = String(
      this.db
        .prepare("SELECT ref FROM feishu_cards WHERE send_key=?")
        .get(sendKey)?.ref,
    );
    return {
      send: async (message, signal) => {
        if (
          this.stopped ||
          signal.aborted ||
          this.binding?.generation !== b.generation
        )
          return "permanent";
        const safe =
          sensitive && !digest
            ? { title: "有 1 条敏感事项待处理", url: message.url }
            : message;
        const id = await this.remote.create(
          b.open_id,
          ref,
          feishuCard(safe, ref, actions),
        );
        if (!id || signal.aborted || this.stopped) return "retryable";
        const saved = this.db
          .prepare(
            "UPDATE feishu_cards SET message=? WHERE ref=? AND (message IS NULL OR message=?)",
          )
          .run(id, ref, id);
        return saved.changes === 1 ? "sent" : "permanent";
      },
    };
  }
  execute(job: FeishuJob) {
    const { store, db } = this;
    store.uow.run((tx) => {
      const row = db
        .prepare("SELECT * FROM feishu_cards WHERE ref=? AND state='claimed'")
        .get(job.ref);
      if (!row) return;
      const b = this.binding;
      const settle = (state: string) => {
        db.prepare("UPDATE feishu_cards SET state=?,receipt=1 WHERE ref=?").run(
          state,
          job.ref,
        );
        feishuAudit(db, state, b?.member ?? null, job.ref);
      };
      if (
        !b ||
        b.generation !== job.generation ||
        b.open_id !== job.operator ||
        b.chat !== job.chat ||
        row.binding !== b.generation ||
        row.message !== job.message ||
        Number(row.expires) <= this.now()
      ) {
        settle("stale");
        return;
      }
      const project = String(row.project) as ProjectId,
        s = loadCommandState(tx, project, this.gate?.(project)),
        item = extMessageItems(s, project).find((i) => i.item_id === row.item);
      if (!item) {
        settle("stale");
        return;
      }
      const action = extInteraction(s, item);
      if (
        digestFeishu(action.basis) !== row.version ||
        !action.options.some((o) => o.key === job.key)
      ) {
        settle("stale");
        return;
      }
      const ports = {
          ids: tx.ids,
          clock: { now: () => new Date(this.now()).toISOString() },
        },
        actor = { kind: "human" as const, project_id: project };
      const reason = job.text || "确认合并";
      const effect =
        item.kind === "human_action"
          ? completeHumanAction(
              s,
              actor,
              {
                human_action_id: s.human_actions.find(
                  (h) => h.id === item.item_id,
                )!.id,
                text: job.text,
              },
              ports,
            )
          : recordDecision(
              s,
              actor,
              {
                decision_id: s.decisions.find((d) => d.id === item.item_id)!.id,
                option: job.key,
                rationale: reason,
                raw_quote: reason,
              },
              ports,
            );
      if (!effect.ok) {
        settle("stale");
        return;
      }
      persistEffect(tx, project, {
        ...effect.value,
        timeline: effect.value.timeline.map((t) =>
          t.author !== "human"
            ? t
            : {
                ...t,
                body: `${t.body}（来自飞书 · ${b.member}）`,
              },
        ),
      });
      tx.events.append(project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project, item.card_id),
        ...(item.card_id ? { card_id: item.card_id } : {}),
        created_at: ports.clock.now(),
        actor,
        type: "ext_message_interaction",
        payload: {
          source: "feishu",
          member_id: b.member,
          item_id: item.item_id,
        },
      });
      settle(
        item.kind === "merge_confirmation" && job.key === "hold"
          ? "held"
          : "done",
      );
    });
  }
  async receipts() {
    const b = this.binding;
    if (!b || this.stopped) return;
    for (const row of this.db
      .prepare(
        "SELECT ref,message,state,project FROM feishu_cards WHERE binding=? AND receipt=1 AND retry_at<=? AND message IS NOT NULL LIMIT 10",
      )
      .all(b.generation, this.now())) {
      if (this.stopped || this.binding?.generation !== b.generation) return;
      this.db
        .prepare("UPDATE feishu_cards SET retry_at=? WHERE ref=?")
        .run(this.now() + 60_000, row.ref!);
      try {
        if (
          (await this.remote.patch(
            String(row.message),
            feishuReceipt(
              String(row.state),
              extMessageUrl(this.base, String(row.project)),
            ),
          )) &&
          !this.stopped
        )
          this.db
            .prepare("UPDATE feishu_cards SET receipt=0 WHERE ref=?")
            .run(row.ref!);
      } catch {
        /* retry receipt only */
      }
    }
  }
}
