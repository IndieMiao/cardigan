import { randomUUID } from "node:crypto";
import {
  buildExtMessage,
  buildExtMessageDigest,
  type CardId,
  type Clock,
  type CommandState,
  type ExtMessage,
  type ExtMessageItem,
  type ExtMessagePort,
  extInteraction,
  extMessageItems,
  type ProjectId,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import {
  claimExtMessage,
  type ExtMessageRow,
  extQuietOverflow,
  extQuietStamp,
  getExtMessage,
  groupExtMessage,
  hasExtMessage,
  pendingExtMessages,
  projectExtMessage,
  type Store,
  type StoreTransactionContext,
  saveExtQuietOverflow,
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
// Bound first enable/rebinding work without dropping live items or splitting a frozen digest.
const projectionBatch = 32;
type Projection = {
  state: CommandState;
  version: string;
  items: Map<string, ExtMessageItem>;
  incompleteDigests: ReadonlySet<string>;
  quietStamps: ReadonlyMap<string, string | null>;
};
const itemKey = (kind: string, id: string) => `${kind}:${id}`;
// Called in the read snapshot: retain exact quiet-scan membership, not a time
// watermark that could sweep in items only created or released after wake.
function planChannel(
  store: Store,
  project: ProjectId,
  channel: string,
  items: readonly ExtMessageItem[],
  config: ExtMessageConfig,
  quiet: boolean,
) {
  const previous = extQuietOverflow(store.database, project, channel);
  const remembered = new Set<string>(
    previous ? JSON.parse(previous.members) : [],
  );
  const remaining: string[] = [];
  const writes = [];
  let complete = true;
  let incompleteDigest = false;
  for (const item of items) {
    if (item.handled) continue;
    const key = itemKey(item.kind, item.item_id);
    const observed = remembered.has(key);
    if (!item.ready && channel.startsWith("lark_app:")) {
      if (observed) remaining.push(key);
      continue;
    }
    if (hasExtMessage(store.database, item, channel)) continue;
    const deferred =
      quiet ||
      observed ||
      (item.created_at !== undefined &&
        extMessageQuiet(config, item.created_at));
    if (writes.length < projectionBatch) {
      writes.push({ item, channel, deferred });
      continue;
    }
    complete = false;
    if (quiet || observed) remaining.push(key);
    if (deferred && item.ready) incompleteDigest = true;
    // With no quiet scan to persist, only the first missing digest member matters.
    if (
      !quiet &&
      previous === null &&
      (!config.quiet_hours || incompleteDigest)
    )
      break;
  }
  const members = remaining.length ? JSON.stringify(remaining) : null;
  const next = !members
    ? null
    : previous?.members === members
      ? previous
      : { stamp: randomUUID(), members };
  return {
    channel,
    writes,
    complete: complete && next === null,
    incompleteDigest,
    previous,
    next,
  };
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
      const projection = this.project(project.id, channels, generation, config);
      if (!projection) continue;
      // Drain every started channel before reporting failure: stop() must also
      // cover result commits in sibling channels before the caller closes Store.
      const results = await Promise.allSettled(
        channels.map(async (channel) => {
          const rows = pendingExtMessages(store.database, project.id, channel);
          const groups = new Map<string, ExtMessageRow[]>();
          for (const row of rows) {
            // Frozen retries and ordinary messages are independent of an unfinished quiet batch.
            if (
              row.digest_id === "queued" &&
              projection.incompleteDigests.has(channel)
            )
              continue;
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
            await this.deliver(group, config, projection);
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
  private project(
    projectId: ProjectId,
    channels: readonly string[],
    generation: string | undefined,
    config: ExtMessageConfig,
  ): Projection | undefined {
    const { store } = this.options;
    const now = this.clock.now();
    const plan = store.uow.read((tx) => {
      const version = store.snapshotVersion(projectId);
      if (version === undefined)
        throw new Error("External reminders require a versioned snapshot");
      const cursor = `${version}/${generation ?? ""}`;
      const projected = this.projectedVersions.get(projectId) === cursor;
      if (
        projected &&
        channels.every(
          (channel) =>
            !pendingExtMessages(store.database, projectId, channel).length,
        )
      )
        return;
      const state = loadCommandState(tx, projectId);
      const items = extMessageItems(state, projectId);
      const quiet = extMessageQuiet(config, now);
      const plans = projected
        ? []
        : channels.map((channel) =>
            planChannel(store, projectId, channel, items, config, quiet),
          );
      return {
        cursor,
        plans,
        projection: {
          version,
          state,
          incompleteDigests: new Set(
            plans.filter((p) => p.incompleteDigest).map((p) => p.channel),
          ),
          quietStamps: new Map(
            plans.map((p) => [p.channel, p.next?.stamp ?? null]),
          ),
          items: new Map(items.map((i) => [itemKey(i.kind, i.item_id), i])),
        },
      };
    });
    if (!plan) return;
    const { projection } = plan;
    if (
      plan.plans.some((p) => p.writes.length || p.previous !== p.next) &&
      !store.uow.run(() => {
        if (
          store.snapshotVersion(projectId) !== projection.version ||
          this.app?.binding?.generation !== generation ||
          plan.plans.some(
            (p) =>
              extQuietStamp(store.database, projectId, p.channel) !==
              (p.previous?.stamp ?? null),
          )
        )
          return false;
        for (const p of plan.plans) {
          for (const { item, channel, deferred } of p.writes)
            projectExtMessage(store.database, item, channel, now, deferred);
          if (p.previous !== p.next)
            saveExtQuietOverflow(store.database, projectId, p.channel, p.next);
        }
        return true;
      })
    )
      return;
    if (plan.plans.every((p) => p.complete))
      this.projectedVersions.set(projectId, plan.cursor);
    return projection;
  }
  private async deliver(
    candidates: readonly ExtMessageRow[],
    config: ExtMessageConfig,
    projection: Projection,
  ): Promise<void> {
    const candidate = candidates[0];
    if (!candidate) return;
    const { store } = this.options;
    const project = candidate.project_id as ProjectId;
    const at = this.clock.now();
    const quiet = extMessageQuiet(config, at);
    const digest =
      candidate.digest_id === "queued" ? randomUUID() : candidate.digest_id;
    const eligible: { row: ExtMessageRow; item: ExtMessageItem }[] = [];
    const updates: {
      row: ExtMessageRow;
      kind: "skip" | "fail" | "expire" | "queue";
    }[] = [];
    for (const row of candidates) {
      if (row.lease_until && row.lease_until > at) continue;
      const item = projection.items.get(itemKey(row.item_kind, row.item_id));
      if (!item || item.handled) {
        updates.push({ row, kind: "skip" });
        continue;
      }
      if (row.next_attempt_at > at) continue;
      if (row.attempts >= config.policy.max_attempts) {
        updates.push({ row, kind: "fail" });
        continue;
      }
      if (row.lease_id !== null) updates.push({ row, kind: "expire" });
      if (!item.ready) continue;
      if (quiet) {
        if (row.digest_id === null) updates.push({ row, kind: "queue" });
        continue;
      }
      eligible.push({ row, item });
    }
    if (!eligible.length && !updates.length) return;
    const first = eligible[0]?.item;
    const appChannel = candidate.channel.startsWith("lark_app:");
    const settings = appChannel ? this.options.gate?.(project) : undefined;
    const state = settings
      ? { ...projection.state, project_settings: settings }
      : projection.state;
    const interaction =
      appChannel && first ? extInteraction(state, first) : undefined;
    const message = !first
      ? undefined
      : digest === null
        ? buildExtMessage(
            first,
            config.workbench_url,
            config.policy.title_limit,
          )
        : buildExtMessageDigest(
            project,
            eligible.map(({ item }, i) =>
              appChannel &&
              i < config.policy.digest_limit &&
              (i === 0 ? interaction : extInteraction(state, item))?.sensitive
                ? { ...item, sensitive: true }
                : item,
            ),
            config.workbench_url,
            config.policy,
          );
    const claimed = store.uow.run((tx) => {
      if (
        store.snapshotVersion(project) !== projection.version ||
        (candidate.digest_id === "queued" &&
          extQuietStamp(store.database, project, candidate.channel) !==
            (projection.quietStamps.get(candidate.channel) ?? null)) ||
        (appChannel &&
          candidate.channel !== `lark_app:${this.app?.binding?.generation}`)
      )
        return;
      // Outbox rows are not covered by the command-state revision. If another
      // sender changed any member, never send the previously prepared digest.
      for (const row of candidates) {
        const fresh = getExtMessage(store.database, row);
        if (
          fresh?.status !== "pending" ||
          fresh.digest_id !== row.digest_id ||
          fresh.attempts !== row.attempts ||
          fresh.lease_id !== row.lease_id ||
          fresh.lease_until !== row.lease_until ||
          fresh.next_attempt_at !== row.next_attempt_at
        )
          return;
      }
      for (const { row, kind } of updates) {
        if (kind === "queue") groupExtMessage(store.database, row, "queued");
        else if (kind === "expire")
          this.settle(tx, row, "pending", "unknown", at, row.next_attempt_at);
        else if (kind === "skip") this.settle(tx, row, "skipped", null, at, at);
        else this.settle(tx, row, "failed", "unknown", at, at);
      }
      const lease = randomUUID();
      const until = new Date(
        Date.parse(at) + config.policy.timeout_ms,
      ).toISOString();
      const rows = eligible.map(({ row }) => {
        if (digest !== null) groupExtMessage(store.database, row, digest);
        const retryAt = new Date(
          Date.parse(until) +
            (config.policy.retry_delays_ms[row.attempts] ?? 0),
        ).toISOString();
        if (!claimExtMessage(store.database, row, lease, at, until, retryAt))
          throw new Error("External reminder claim changed");
        return {
          ...row,
          digest_id: digest,
          attempts: row.attempts + 1,
          lease_id: lease,
          lease_until: until,
        };
      });
      return {
        rows,
        appPort:
          interaction && first
            ? this.app?.prepare(interaction, first, digest)
            : undefined,
        version: store.snapshotVersion(project)!,
      };
    });
    if (!claimed) return;
    // Only our own ext_message_* audits changed since the checked snapshot;
    // they cannot affect outbound membership or Feishu action eligibility.
    projection.version = claimed.version;
    if (!message) return;
    const factory = (this.options.adapters ?? extMessageAdapters)[
      candidate.channel
    ];
    let result: ExtSendResult = "adapter_unavailable";
    try {
      const port =
        claimed.appPort ??
        factory?.(config.channels[candidate.channel]?.credential);
      if (port)
        result = await sendExtMessage(port, message, config.policy.timeout_ms);
    } catch {
      result = "unknown";
    }
    const now = this.clock.now();
    const settledVersion = store.uow.run((tx) => {
      const stillCurrent =
        store.snapshotVersion(project) === projection.version;
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
      return stillCurrent ? store.snapshotVersion(project) : undefined;
    });
    if (settledVersion !== undefined) projection.version = settledVersion;
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
