import { createHash, randomUUID } from "node:crypto";
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
  activateExtChannels,
  afterExtWatermark,
  claimExtMessage,
  type ExtChannelActivation,
  type ExtMessageRow,
  extAttemptAvailable,
  extChannelActivation,
  extQuietOverflow,
  extQuietStamp,
  getExtMessage,
  groupExtMessage,
  hasExtMessage,
  invalidateExtHistory,
  pendingExtGroupSize,
  pendingExtMessages,
  projectExtMessage,
  reserveExtAttempt,
  type Store,
  type StoreTransactionContext,
  saveExtQuietOverflow,
  settleExtMessage,
} from "@cardigan/store";
import {
  defaultMaxPerMinute,
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
const rateQueue = "rate:queued";
type Projection = {
  watermarks: ReadonlyMap<string, number>;
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
  watermark: number,
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
    if (
      item.handled ||
      !afterExtWatermark(store.database, project, item.event_id, watermark)
    )
      continue;
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
  private activations?: Map<string, ExtChannelActivation>;
  private observedBinding?: string;
  private activate(): void {
    if (this.activations) return;
    const { configuration: c, store } = this.options;
    const fingerprints = new Map<string, string>();
    if (c.status === "loaded" && c.config.enabled) {
      for (const [name, channel] of Object.entries(c.config.channels)) {
        if (channel.enabled && (name !== "lark_app" || this.app))
          fingerprints.set(
            name,
            createHash("sha256")
              .update(
                JSON.stringify([
                  c.config.workbench_url,
                  c.config.policy,
                  c.config.quiet_hours,
                  channel,
                ]),
              )
              .digest("hex"),
          );
      }
    }
    this.activations = store.uow.run((tx) =>
      activateExtChannels(store.database, tx, fingerprints, this.clock.now()),
    );
  }
  private current(channel: string) {
    const name = channel.split(":")[0]!;
    const expected = this.activations?.get(name);
    return (
      !!expected &&
      extChannelActivation(this.options.store.database, name)?.epoch ===
        expected.epoch
    );
  }
  /** Persist safe startup metadata for human status; no secrets or URL are written. */
  recordStatus(): void {
    const c = this.options.configuration;
    this.app = (this.options.startApplication ?? startFeishu)(
      this.options.store,
      c,
      this.options.gate,
    );
    this.activate();
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
    if (this.stopped) return;
    this.activate();
    if (c.status !== "loaded" || !c.config.enabled) return;
    const config = c.config;
    const binding = this.app?.binding;
    const generation = binding?.generation;
    // A slow receipt must not hold up the webhook channel or outbox projection.
    if (this.app && !this.receipts)
      this.receipts = this.app
        .receipts()
        .catch(() => {})
        .finally(() => {
          this.receipts = undefined;
        });
    const watermarks = new Map<string, number>();
    for (const [name, activation] of this.activations!) {
      if (name === "lark_app") {
        if (binding)
          watermarks.set(
            `lark_app:${binding.generation}`,
            Math.max(binding.watermark, activation.watermark),
          );
      } else watermarks.set(name, activation.watermark);
    }
    const channels = [...watermarks.keys()];
    if (!channels.length) return;
    if (generation && this.observedBinding !== generation) {
      store.uow.run((tx) => {
        if (
          this.current("lark_app") &&
          this.app?.binding?.generation === generation
        )
          invalidateExtHistory(
            store.database,
            tx,
            "lark_app",
            `lark_app:${generation}`,
            this.clock.now(),
          );
      });
      this.observedBinding = generation;
    }
    const projections = new Map<string, Projection>();
    for (const project of store.listProjects()) {
      const projection = this.project(
        project.id,
        channels,
        generation,
        watermarks,
        config,
      );
      if (projection) projections.set(project.id, projection);
    }
    // Drain sibling channels before reporting an error, including their result commits.
    const results = await Promise.allSettled(
      channels.map((channel) => this.drain(channel, config, projections)),
    );
    const failures = results.flatMap((r) =>
      r.status === "rejected" ? [r.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(
        failures,
        "External notification channels failed",
      );
  }
  private async drain(
    channel: string,
    config: ExtMessageConfig,
    projections: Map<string, Projection>,
  ) {
    const groups = new Map<string, ExtMessageRow[]>();
    const overflow: ExtMessageRow[] = [];
    for (const [project, projection] of projections) {
      for (const row of pendingExtMessages(
        this.options.store.database,
        project,
        channel,
      )) {
        if (
          row.digest_id === "queued" &&
          projection.incompleteDigests.has(channel)
        )
          continue;
        if (row.digest_id === rateQueue) {
          overflow.push(row);
          continue;
        }
        const key = row.digest_id?.startsWith("rate:")
          ? row.digest_id
          : JSON.stringify([
              project,
              row.digest_id ?? itemKey(row.item_kind, row.item_id),
            ]);
        const group = groups.get(key) ?? [];
        group.push(row);
        groups.set(key, group);
      }
    }
    // Once saturated, collect all fresh ordinary rows into the same open batch
    // (also across projection ticks/projects) before using the next available slot.
    for (const group of groups.values()) {
      if (this.stopped) return;
      const queued = await this.deliver(
        group,
        config,
        projections,
        overflow.length > 0,
      );
      if (queued) overflow.push(queued);
    }
    if (
      !this.stopped &&
      overflow.length &&
      extAttemptAvailable(
        this.options.store.database,
        channel.split(":")[0]!,
        Date.parse(this.clock.now()),
        config.policy.max_per_minute ?? defaultMaxPerMinute,
      )
    )
      await this.deliver(overflow, config, projections, false);
  }
  private project(
    projectId: ProjectId,
    channels: readonly string[],
    generation: string | undefined,
    watermarks: ReadonlyMap<string, number>,
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
            planChannel(
              store,
              projectId,
              channel,
              items,
              config,
              quiet,
              watermarks.get(channel)!,
            ),
          );
      return {
        cursor,
        plans,
        projection: {
          version,
          state,
          watermarks,
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
              !this.current(p.channel) ||
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
    projections: Map<string, Projection>,
    collectOverflow: boolean,
  ): Promise<ExtMessageRow | undefined> {
    const candidate = candidates[0];
    if (!candidate) return;
    const { store } = this.options;
    const project = candidate.project_id as ProjectId;
    const projection = projections.get(project)!;
    const participants = [
      ...new Set(candidates.map((r) => r.project_id as ProjectId)),
    ];
    const at = this.clock.now();
    const quiet = extMessageQuiet(config, at);
    const digest =
      candidate.digest_id === rateQueue
        ? `rate:${randomUUID()}`
        : candidate.digest_id === "queued"
          ? randomUUID()
          : candidate.digest_id;
    const eligible: { row: ExtMessageRow; item: ExtMessageItem }[] = [];
    const updates: {
      row: ExtMessageRow;
      kind: "skip" | "fail" | "expire" | "queue";
    }[] = [];
    for (const row of candidates) {
      if (row.lease_until && row.lease_until > at) continue;
      const item = projections
        .get(row.project_id)!
        .items.get(itemKey(row.item_kind, row.item_id));
      if (
        !item ||
        item.handled ||
        !afterExtWatermark(
          store.database,
          row.project_id,
          row.event_id,
          projection.watermarks.get(row.channel)!,
        )
      ) {
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
    const firstProject = first?.project_id ?? project;
    const settings = appChannel ? this.options.gate?.(firstProject) : undefined;
    const source = projections.get(firstProject)!.state;
    const state = settings ? { ...source, project_settings: settings } : source;
    const interaction =
      appChannel && first ? extInteraction(state, first) : undefined;
    const message = !first
      ? undefined
      : digest?.startsWith("rate:")
        ? { title: `${eligible.length} 条待处理`, url: config.workbench_url }
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
        !this.current(candidate.channel) ||
        (candidate.digest_id?.startsWith("rate:") &&
          pendingExtGroupSize(
            store.database,
            candidate.channel,
            candidate.digest_id,
          ) !== candidates.length) ||
        participants.some(
          (p) => store.snapshotVersion(p) !== projections.get(p)!.version,
        ) ||
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
      if (eligible.length) {
        const single = digest === null && candidate.attempts === 0;
        if (
          (single && collectOverflow) ||
          !reserveExtAttempt(
            store.database,
            candidate.channel.split(":")[0]!,
            Date.parse(this.clock.now()),
            config.policy.max_per_minute ?? defaultMaxPerMinute,
          )
        ) {
          if (single) {
            groupExtMessage(store.database, candidate, rateQueue);
            return { queued: { ...candidate, digest_id: rateQueue } };
          }
          return;
        }
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
        versions: participants.map(
          (p) => [p, store.snapshotVersion(p)!] as const,
        ),
      };
    });
    if (!claimed) return;
    // Only our own ext_message_* audits changed since the checked snapshot;
    // they cannot affect outbound membership or Feishu action eligibility.
    if (claimed.queued) return claimed.queued;
    for (const [p, version] of claimed.versions)
      projections.get(p)!.version = version;
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
    const settledVersions = store.uow.run((tx) => {
      const stillCurrent = participants.filter(
        (p) => store.snapshotVersion(p) === projections.get(p)!.version,
      );
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
      return stillCurrent.map((p) => [p, store.snapshotVersion(p)!] as const);
    });
    for (const [p, version] of settledVersions)
      projections.get(p)!.version = version;
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
