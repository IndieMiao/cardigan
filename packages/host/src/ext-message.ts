import { randomUUID } from "node:crypto";
import {
  buildExtMessage,
  type CardId,
  type Clock,
  type ExtMessage,
  type ExtMessagePort,
  extMessageItems,
  type ProjectId,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import {
  claimExtMessage,
  type ExtMessageRow,
  getExtMessage,
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

export type ExtMessageAdapters = Readonly<
  Record<string, (credential: string | undefined) => ExtMessagePort>
>;
/** No network adapter ships in C-289. Factories are host assembly dependencies, never Agent input. */
export const extMessageAdapters: ExtMessageAdapters = {};
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
      Promise.resolve()
        .then(() => adapter.send(message, controller.signal))
        .then((r) =>
          ["sent", "retryable", "permanent"].includes(r)
            ? r
            : ("unknown" as const),
        ),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve("timeout");
        }, timeout);
      }),
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
  readonly adapters?: ExtMessageAdapters;
  readonly clock?: Clock;
}
export class ExtMessageSender {
  private running: Promise<void> | undefined;
  private stopped = false;
  private readonly projectedVersions = new Map<ProjectId, string>();
  private readonly clock: Clock;
  constructor(private readonly options: ExtMessageOptions) {
    this.clock = options.clock ?? { now: () => new Date().toISOString() };
  }
  /** Persist safe startup metadata for human status; no secrets or URL are written. */
  recordStatus(): void {
    const c = this.options.configuration;
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
    await this.running;
  }
  private async run(): Promise<void> {
    const { configuration: c, store } = this.options;
    if (this.stopped || c.status !== "loaded" || !c.config.enabled) return;
    const config = c.config;
    const channels = Object.keys(config.channels).filter(
      (name) => config.channels[name]?.enabled,
    );
    if (!channels.length) return;
    for (const project of store.listProjects()) {
      if (this.stopped) return;
      const projectedVersion = store.uow.run((tx) => {
        const version = store.snapshotVersion(project.id);
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
            projectExtMessage(store.database, item, channel, this.clock.now());
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
          for (const row of rows) {
            if (this.stopped) return;
            await this.deliver(row, config);
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
    candidate: ExtMessageRow,
    config: ExtMessageConfig,
  ): Promise<void> {
    const { store } = this.options;
    const claimed = store.uow.run((tx) => {
      let row = getExtMessage(store.database, candidate);
      const now = this.clock.now();
      if (
        row?.status !== "pending" ||
        (row.lease_until && row.lease_until > now)
      )
        return;
      const item = extMessageItems(
        loadCommandState(tx, row.project_id as ProjectId),
        row.project_id as ProjectId,
      ).find(
        (i) =>
          i.kind === candidate.item_kind && i.item_id === candidate.item_id,
      );
      if (!item || item.handled) {
        this.settle(tx, row, "skipped", null, now, now);
        return;
      }
      if (row.next_attempt_at > now) return;
      if (row.attempts >= config.policy.max_attempts) {
        this.settle(tx, row, "failed", "unknown", now, now);
        return;
      }
      if (row.lease_id !== null) {
        // An expired reserved attempt may have reached the remote. Count and audit it.
        this.settle(tx, row, "pending", "unknown", now, row.next_attempt_at);
        row = { ...row, lease_id: null, lease_until: null };
      }
      if (!item.ready || extMessageQuiet(config, now)) return;
      const lease = randomUUID();
      const until = new Date(
        Date.parse(now) + config.policy.timeout_ms,
      ).toISOString();
      const retryAt = new Date(
        Date.parse(until) + (config.policy.retry_delays_ms[row.attempts] ?? 0),
      ).toISOString();
      if (!claimExtMessage(store.database, row, lease, now, until, retryAt))
        return;
      return {
        row: {
          ...row,
          attempts: row.attempts + 1,
          lease_id: lease,
          lease_until: until,
        },
        message: buildExtMessage(
          item,
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
      if (factory)
        result = await sendExtMessage(
          factory(config.channels[candidate.channel]?.credential),
          claimed.message,
          config.policy.timeout_ms,
        );
    } catch {
      result = "unknown";
    }
    const now = this.clock.now();
    const status =
      result === "sent"
        ? "sent"
        : result === "permanent" ||
            result === "adapter_unavailable" ||
            claimed.row.attempts >= config.policy.max_attempts
          ? "failed"
          : "pending";
    const next = new Date(
      Date.parse(now) +
        (config.policy.retry_delays_ms[claimed.row.attempts - 1] ?? 0),
    ).toISOString();
    store.uow.run((tx) =>
      this.settle(
        tx,
        claimed.row,
        status,
        result === "sent" ? null : result,
        now,
        next,
      ),
    );
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
        channel: row.channel,
        item_id: row.item_id,
        item_kind: row.item_kind,
        attempts: row.attempts,
        ...(error ? { error } : {}),
        final: status === "failed",
      },
    });
  }
}
