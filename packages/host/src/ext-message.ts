import { randomUUID } from "node:crypto";
import {
  buildExtMessage,
  buildExtMessageDigest,
  type CardId,
  type Clock,
  type CommandState,
  type ExtMessage,
  type ExtMessagePort,
  extInteraction,
  extMessageItems,
  type ProjectId,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import {
  claimExtMessage,
  type ExtMessageRow,
  getExtMessage,
  groupExtMessage,
  pendingExtMessages,
  projectExtMessage,
  type Store,
  type StoreTransactionContext,
  settleExtMessage,
} from "@cardigan/store";
import {
  type ExtMessageConfig,
  type ExtMessageConfiguration,
  extMessageQuiet,
} from "./ext-message-config.js";

import { createFeishuAdapter } from "./ext-message-feishu.js";

import { type FeishuApp, startFeishu } from "./feishu-app.js";

export type ExtMessageAdapters = Readonly<
  Record<string, (credential: string | undefined) => ExtMessagePort>
>;
/** Factories are host assembly dependencies, never Agent input. */
export const extMessageAdapters: ExtMessageAdapters = {
  lark: createFeishuAdapter,
};
export type ExtSendResult = "sent" | Exclude<ExtMessageRow["last_error"], null>;
export async function sendExtMessage(
  adapter: ExtMessagePort,
  message: ExtMessage,
  timeout: number,
): Promise<ExtSendResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve("timeout");
        }, timeout);
      }),
      Promise.resolve(adapter.send(message, controller.signal)).then((r) =>
        ["sent", "retryable", "permanent"].includes(r)
          ? r
          : ("unknown" as const),
      ),
    ]);
  } catch {
    return "unknown";
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export interface ExtMessageOptions {
  readonly store: Store;
  readonly configuration: ExtMessageConfiguration;
  readonly gate?: (project: ProjectId) => CommandState["project_settings"];
  readonly startApplication?: typeof startFeishu;
  readonly adapters?: ExtMessageAdapters;
  readonly clock?: Clock;
}
export class ExtMessageSender {
  private running: Promise<void> | undefined;
  private receipts: Promise<void> | undefined;
  private stopped = false;
  private readonly projectedVersions = new Map<ProjectId, string>();
  private readonly clock: Clock;
  private app?: FeishuApp | undefined;
  constructor(private readonly options: ExtMessageOptions) {
    this.clock = options.clock ?? { now: () => new Date().toISOString() };
  }
  /** Persist safe startup metadata for human status; no secrets or URL are written. */
  recordStatus(): void {
    const c = this.options.configuration;
    this.app = (this.options.startApplication ?? startFeishu)(
      this.options.store,
      c,
      this.options.gate,
    );
    this.options.store.uow.run(() =>
      this.options.store.database
        .prepare(
          "INSERT OR REPLACE INTO ext_message_host_status(id,doc) VALUES(1,?)",
        )
        .run(
          JSON.stringify({
            status: c.status,
            enabled: c.status === "loaded" && c.config.enabled,
            channels:
              c.status === "loaded"
                ? Object.fromEntries(
                    Object.entries(c.config.channels).map(([name, value]) => [
                      name,
                      value.enabled,
                    ]),
                  )
                : {},
            loaded_at: this.clock.now(),
          }),
        ),
    );
  }
  tick(): Promise<void> {
    if (this.running) return this.running;
    const run = this.run();
    this.running = run;
    void run
      .finally(() => {
        this.running = undefined;
      })
      .catch(() => {});
    return run;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.app?.stop();
    await Promise.all([this.running, this.receipts]);
  }
  private async run(): Promise<void> {
    const { configuration: c, store } = this.options;
    if (this.stopped || c.status !== "loaded" || !c.config.enabled) return;
    const config = c.config;
    const generation = this.app?.binding?.generation;
    // A slow receipt must not hold up the webhook channel or outbox projection.
    if (this.app && !this.receipts)
      this.receipts = this.app
        .receipts()
        .catch(() => {})
        .finally(() => {
          this.receipts = undefined;
        });
    const channels = Object.keys(config.channels)
      .filter(
        (name) =>
          config.channels[name]?.enabled && (name !== "lark_app" || generation),
      )
      .map((name) => (name === "lark_app" ? `lark_app:${generation}` : name));
    if (!channels.length) return;
    for (const project of store.listProjects()) {
      if (this.stopped) return;
      const projectedVersion = store.uow.run((tx) => {
        const snapshot = store.snapshotVersion(project.id);
        const version = snapshot && `${snapshot}/${generation ?? ""}`;
        if (
          version !== undefined &&
          this.projectedVersions.get(project.id) === version
        )
          return version;
        for (const item of extMessageItems(
          loadCommandState(tx, project.id),
          project.id,
        ))
          for (const channel of channels)
            projectExtMessage(
              store.database,
              item,
              channel,
              this.clock.now(),
              extMessageQuiet(config, this.clock.now()) ||
                (item.created_at !== undefined &&
                  extMessageQuiet(config, item.created_at)),
            );
        return version;
      });
      // Publish the replay cursor only after the transaction commits; restart always replays.
      if (projectedVersion !== undefined)
        this.projectedVersions.set(project.id, projectedVersion);
      // Drain every started channel before reporting failure: stop() must also
      // cover result commits in sibling channels before the caller closes Store.
      const results = await Promise.allSettled(
        channels.map(async (channel) => {
          const rows = pendingExtMessages(store.database, project.id, channel);
          const groups = new Map<string, ExtMessageRow[]>();
          for (const row of rows) {
            const key =
              row.digest_id === null
                ? `item:${row.item_kind}:${row.item_id}`
                : `digest:${row.digest_id}`;
            const group = groups.get(key) ?? [];
            group.push(row);
            groups.set(key, group);
          }
          for (const group of groups.values()) {
            if (this.stopped) return;
            await this.deliver(group, config);
          }
        }),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(
          failures,
          "External notification channels failed",
        );
    }
  }
  private async deliver(
    candidates: readonly ExtMessageRow[],
    config: ExtMessageConfig,
  ): Promise<void> {
    const candidate = candidates[0];
    if (!candidate) return;
    const { store } = this.options;
    const claimed = store.uow.run((tx) => {
      const now = this.clock.now();
      const state = loadCommandState(
        tx,
        candidate.project_id as ProjectId,
        this.options.gate?.(candidate.project_id as ProjectId),
      );
      const items = extMessageItems(state, candidate.project_id as ProjectId);
      if (
        candidate.channel.startsWith("lark_app:") &&
        candidate.channel !== `lark_app:${this.app?.binding?.generation}`
      )
        return;
      const eligible = [];
      for (const pending of candidates) {
        let row = getExtMessage(store.database, pending);
        if (
          row?.status !== "pending" ||
          row.digest_id !== candidate.digest_id ||
          (row.lease_until && row.lease_until > now)
        )
          continue;
        const item = items.find(
          (i) => i.kind === pending.item_kind && i.item_id === pending.item_id,
        );
        if (!item || item.handled) {
          this.settle(tx, row, "skipped", null, now, now);
          continue;
        }
        if (row.next_attempt_at > now) continue;
        if (row.attempts >= config.policy.max_attempts) {
          this.settle(tx, row, "failed", "unknown", now, now);
          continue;
        }
        if (row.lease_id !== null) {
          // An expired reserved attempt may have reached the remote. Count and audit it.
          this.settle(tx, row, "pending", "unknown", now, row.next_attempt_at);
          row = { ...row, lease_id: null, lease_until: null };
        }
        if (!item.ready) continue;
        if (extMessageQuiet(config, now)) {
          groupExtMessage(store.database, row, "queued");
          continue;
        }
        eligible.push({ row, item });
      }
      if (!eligible.length) return;
      const digest =
        candidate.digest_id === "queued" ? randomUUID() : candidate.digest_id;
      const lease = randomUUID();
      const until = new Date(
        Date.parse(now) + config.policy.timeout_ms,
      ).toISOString();
      const reserved = [];
      for (const { row, item } of eligible) {
        if (digest !== null) groupExtMessage(store.database, row, digest);
        const retryAt = new Date(
          Date.parse(until) +
            (config.policy.retry_delays_ms[row.attempts] ?? 0),
        ).toISOString();
        if (!claimExtMessage(store.database, row, lease, now, until, retryAt))
          continue;
        reserved.push({
          row: {
            ...row,
            digest_id: digest,
            attempts: row.attempts + 1,
            lease_id: lease,
            lease_until: until,
          },
          item,
        });
      }
      const first = reserved[0];
      if (!first) return;
      return {
        appPort: candidate.channel.startsWith("lark_app:")
          ? this.app?.prepare(state, first.item, digest)
          : undefined,
        rows: reserved.map((entry) => entry.row),
        message:
          digest !== null
            ? buildExtMessageDigest(
                candidate.project_id as ProjectId,
                reserved.map(({ item }) =>
                  candidate.channel.startsWith("lark_app:") &&
                  extInteraction(state, item).sensitive
                    ? { ...item, sensitive: true }
                    : item,
                ),
                config.workbench_url,
                config.policy,
              )
            : buildExtMessage(
                first.item,
                config.workbench_url,
                config.policy.title_limit,
              ),
      };
    });
    if (!claimed) return;
    const factory = (this.options.adapters ?? extMessageAdapters)[
      candidate.channel
    ];
    let result: ExtSendResult = "adapter_unavailable";
    try {
      const port =
        claimed.appPort ??
        factory?.(config.channels[candidate.channel]?.credential);
      if (port)
        result = await sendExtMessage(
          port,
          claimed.message,
          config.policy.timeout_ms,
        );
    } catch {
      result = "unknown";
    }
    const now = this.clock.now();
    store.uow.run((tx) => {
      for (const row of claimed.rows) {
        const status =
          result === "sent"
            ? "sent"
            : result === "permanent" ||
                result === "adapter_unavailable" ||
                row.attempts >= config.policy.max_attempts
              ? "failed"
              : "pending";
        const next = new Date(
          Date.parse(now) +
            (config.policy.retry_delays_ms[row.attempts - 1] ?? 0),
        ).toISOString();
        this.settle(
          tx,
          row,
          status,
          result === "sent" ? null : result,
          now,
          next,
        );
      }
    });
  }

  /** Outbox result and audit/terminal notice commit together, including crash recovery. */
  private settle(
    tx: StoreTransactionContext,
    row: ExtMessageRow,
    status: ExtMessageRow["status"],
    error: ExtMessageRow["last_error"],
    now: string,
    next: string,
  ): void {
    const { store } = this.options;
    if (!settleExtMessage(store.database, row, status, error, now, next))
      return;

    const project = row.project_id as ProjectId;
    const card = row.card_id as CardId | null;
    tx.events.append(project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project, card ?? undefined),
      ...(card ? { card_id: card } : {}),
      type:
        status === "sent"
          ? "ext_message_sent"
          : status === "skipped"
            ? "ext_message_skipped"
            : "ext_message_failed",
      actor: { kind: "system", project_id: project },
      created_at: now,
      payload: {
        channel: row.channel.split(":")[0]!,
        item_id: row.item_id,
        item_kind: row.item_kind,
        attempts: row.attempts,
        ...(error ? { error } : {}),
        final: status === "failed",
      },
    });
  }
}
