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
  closeExtRateBatch,
  collectingExtRateBatch,
  deferExtRateBatch,
  type ExtChannelActivation,
  type ExtMessageRow,
  extAttemptAvailable,
  extAttemptSlots,
  extChannelActivation,
  extQuietOverflow,
  extQuietStamp,
  extRateBatch,
  finishExtAttempt,
  getExtMessage,
  groupExtMessage,
  hasExtMessage,
  invalidateExtHistory,
  openExtRateBatch,
  ownsExtDispatch,
  pendingExtGroupSize,
  pendingExtMessages,
  projectExtMessage,
  releaseUnsentExtMessage,
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
  rateBatches: ReadonlyMap<string, number | null>;
  state: CommandState;
  version: string;
  items: Map<string, ExtMessageItem>;
  incompleteDigests: ReadonlySet<string>;
  incompleteOrdinary: ReadonlySet<string>;
  singles: ReadonlyMap<string, ReadonlySet<string>>;
  quietStamps: ReadonlyMap<string, string | null>;
};
const compareKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const itemKey = (kind: string, id: string) => `${kind}:${id}`;
// Build the complete membership decision from one read snapshot. Only item
// identities survive projection; message contents are rebuilt just before claim.
function planChannel(
  store: Store,
  project: ProjectId,
  channel: string,
  items: readonly ExtMessageItem[],
  config: ExtMessageConfig,
  quiet: boolean,
  watermark: number,
  through: number | null,
  slots: number,
  now: string,
) {
  const previous = extQuietOverflow(store.database, project, channel);
  const remembered = new Set<string>(
    previous ? JSON.parse(previous.members) : [],
  );
  const knownOverflow = new Set<string>(
    previous ? JSON.parse(previous.ordinary) : [],
  );
  const wasWaiting = new Set<string>(
    previous ? JSON.parse(previous.waiting) : [],
  );
  const waiting: string[] = [];
  const heldOverflow: string[] = [];
  const heldQuiet: string[] = [];
  const collecting = collectingExtRateBatch(store.database, channel);
  const batchOpen = through !== null || collecting;
  const unassigned = config.quiet_hours
    ? new Map(
        pendingExtMessages(store.database, project, channel)
          .filter((row) => row.digest_id === null && row.attempts === 0)
          .map((row) => [itemKey(row.item_kind, row.item_id), row] as const),
      )
    : undefined;
  const previousSingles = new Set<string>(
    previous ? JSON.parse(previous.singles) : [],
  );
  const candidates: {
    key: string;
    item: ExtMessageItem;
    row?: ExtMessageRow;
    rank: number;
    at: string;
    inRange: boolean;
    quietItem: boolean;
    ordinaryReady: boolean;
    assignedRate: boolean;
  }[] = [];
  let newRows = 0;
  for (const item of items) {
    if (
      item.handled ||
      !afterExtWatermark(store.database, project, item.event_id, watermark)
    )
      continue;
    const key = itemKey(item.kind, item.item_id);
    const row = unassigned?.get(key);
    if (!row && hasExtMessage(store.database, item, channel)) continue;
    const inRange =
      through === null ||
      !afterExtWatermark(store.database, project, item.event_id, through);
    const earlier = previousSingles.has(key);
    const evidence = item.ready_evidence;
    // An observation of a closed gate invalidates birth-time inference, not a
    // later release fact. Once admitted, use the saved class, not replay time.
    const quietItem =
      remembered.has(key) ||
      (item.ready &&
        !earlier &&
        !knownOverflow.has(key) &&
        evidence !== undefined &&
        (evidence.basis === "release" || !wasWaiting.has(key)) &&
        extMessageQuiet(config, evidence.at));
    if (config.quiet_hours && (!item.ready || wasWaiting.has(key)))
      waiting.push(key);
    const ordinaryReady = item.ready && !quietItem && (!quiet || earlier);
    const assignedRate =
      knownOverflow.has(key) ||
      (batchOpen && !earlier && ordinaryReady && inRange);
    if (!inRange && !quiet && !quietItem && !assignedRate) continue;
    if (!item.ready && channel.startsWith("lark_app:")) {
      if (remembered.has(key)) heldQuiet.push(key);
      if (knownOverflow.has(key)) heldOverflow.push(key);
      continue;
    }
    const rank = !row && newRows++ >= projectionBatch ? 1 : 0;
    candidates.push({
      key,
      item,
      ...(row ? { row } : {}),
      rank,
      at: row?.next_attempt_at ?? now,
      inRange,
      quietItem,
      ordinaryReady,
      assignedRate,
    });
    if (!config.quiet_hours && rank && item.ready) break;
  }
  // Match drain priority: enqueued (or inserted this round) before the bounded
  // tail, then next_attempt_at and item ID. A projected slot is not a lease.
  const eligiblePrefix = config.quiet_hours
    ? candidates
        .filter((c) => c.ordinaryReady && c.inRange && !c.assignedRate)
        .sort(
          (a, b) =>
            a.rank - b.rank ||
            compareKey(a.at, b.at) ||
            compareKey(a.item.item_id, b.item.item_id),
        )
    : [];
  // A competing reservation between read and commit can only shorten this
  // prefix. Reclassify the observed IDs, never rescan readiness at a later clock.
  function classify(available: number) {
    const singles = new Set(
      eligiblePrefix.slice(0, available).map((c) => c.key),
    );
    const overflowTail = new Set(heldOverflow);
    const admissions: {
      row: ExtMessageRow;
      group: "queued" | typeof rateQueue;
    }[] = [];
    const remaining = [...heldQuiet];
    const writes: {
      item: ExtMessageItem;
      channel: string;
      group: "queued" | typeof rateQueue | null;
    }[] = [];
    let hasRate = false,
      complete = true,
      incompleteDigest = false,
      incompleteOrdinary = false;
    for (const c of candidates) {
      const { row, key, item } = c;
      const rate =
        c.assignedRate ||
        (config.quiet_hours &&
          c.inRange &&
          c.ordinaryReady &&
          !singles.has(key));
      const deferred = !rate && (quiet || c.quietItem);
      if (!c.inRange && !deferred && !rate) continue;
      const group = rate ? rateQueue : item.ready && deferred ? "queued" : null;
      if (rate) hasRate = true;
      if (deferred) singles.delete(key);
      if (row) {
        if (group && item.ready) admissions.push({ row, group });
        else if (rate) overflowTail.add(key);
      } else if (!c.rank) {
        writes.push({ item, channel, group });
      } else {
        complete = false;
        if (group === "queued") remaining.push(key);
        if (rate && config.quiet_hours) overflowTail.add(key);
        if (item.ready) {
          if (deferred) incompleteDigest = true;
          else incompleteOrdinary = true;
        }
      }
    }
    const waitingKeys = JSON.stringify(waiting);
    const members = JSON.stringify(remaining),
      overflowKeys = JSON.stringify([...overflowTail]),
      singleKeys = JSON.stringify([...singles]);
    const next =
      !remaining.length &&
      !overflowTail.size &&
      !singles.size &&
      !waiting.length
        ? null
        : previous?.members === members &&
            previous.ordinary === overflowKeys &&
            previous.singles === singleKeys &&
            previous.waiting === waitingKeys
          ? previous
          : {
              stamp: randomUUID(),
              members,
              ordinary: overflowKeys,
              singles: singleKeys,
              waiting: waitingKeys,
            };
    return {
      channel,
      writes,
      admissions,
      collecting,
      singles,
      hasRate,
      complete: complete && next === null,
      incompleteDigest,
      incompleteOrdinary,
      previous,
      next,
    };
  }
  return { ...classify(slots), classify };
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
    const rateBatches = new Map(
      channels.map((channel) => {
        const db = store.database;
        // Seal a waiting batch before projection, even on the first tick after
        // restart. A concurrent sender must observe the same boundary or retry.
        if (
          collectingExtRateBatch(db, channel) &&
          this.slotAvailable(channel, config, this.clock.now())
        )
          store.uow.run(() => {
            if (
              this.current(channel) &&
              this.slotAvailable(channel, config, this.clock.now())
            )
              openExtRateBatch(db, channel);
          });
        return [channel, extRateBatch(db, channel)] as const;
      }),
    );
    const projections = new Map<string, Projection>();
    let snapshotConflict = false;
    const prefixSlots = new Map<string, number>();
    for (const project of store.listProjects()) {
      const projection = this.project(
        project.id,
        channels,
        generation,
        watermarks,
        rateBatches,
        prefixSlots,
        config,
      );
      if (projection === false) snapshotConflict = true;
      else if (projection) {
        projections.set(project.id, projection);
        for (const [channel, keys] of projection.singles)
          prefixSlots.set(channel, (prefixSlots.get(channel) ?? 0) + keys.size);
      }
    }
    // Drain sibling channels before reporting an error, including their result commits.
    const results = await Promise.allSettled(
      channels.map((channel) =>
        this.drain(
          channel,
          config,
          projections,
          snapshotConflict,
          rateBatches.get(channel)!,
        ),
      ),
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
  private slotAvailable(channel: string, config: ExtMessageConfig, at: string) {
    return extAttemptAvailable(
      this.options.store.database,
      channel.split(":")[0]!,
      Date.parse(at),
      config.policy.max_per_minute ?? defaultMaxPerMinute,
    );
  }
  private async drain(
    channel: string,
    config: ExtMessageConfig,
    projections: Map<string, Projection>,
    snapshotConflict: boolean,
    through: number | null,
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
        if (
          through !== null &&
          row.digest_id === null &&
          row.attempts === 0 &&
          afterExtWatermark(
            this.options.store.database,
            project,
            row.event_id,
            through,
          )
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
    const incomplete = [...projections.values()].some((p) =>
      p.incompleteOrdinary.has(channel),
    );
    const ordered = [...groups.values()];
    const lastOrdinary = ordered.findLastIndex(([row]) => {
      if (!row || row.digest_id !== null || row.attempts !== 0) return false;
      const item = projections
        .get(row.project_id)
        ?.items.get(itemKey(row.item_kind, row.item_id));
      return item?.ready && !item.handled;
    });
    for (const [i, group] of ordered.entries()) {
      if (this.stopped) return;
      const result = await this.deliver(
        group,
        config,
        projections,
        through !== null || overflow.length > 0,
        incomplete || i < lastOrdinary,
      );
      if (result === "conflict") snapshotConflict = true;
      else if (result && result !== "deferred") overflow.push(result);
    }
    if (this.stopped || snapshotConflict || incomplete || through === null)
      return;
    const { store } = this.options;
    if (overflow.length) {
      const result = await this.deliver(
        overflow,
        config,
        projections,
        false,
        false,
      );
      if (result === "conflict" || result === "deferred") return;
    }
    store.uow.run(() => closeExtRateBatch(store.database, channel, through));
  }
  private project(
    projectId: ProjectId,
    channels: readonly string[],
    generation: string | undefined,
    watermarks: ReadonlyMap<string, number>,
    rateBatches: ReadonlyMap<string, number | null>,
    prefixSlots: ReadonlyMap<string, number>,
    config: ExtMessageConfig,
  ): Projection | false | undefined {
    const { store } = this.options;
    const now = this.clock.now();
    const available = (channel: string, at: string) =>
      config.quiet_hours
        ? Math.max(
            0,
            extAttemptSlots(
              store.database,
              channel.split(":")[0]!,
              Date.parse(at),
              config.policy.max_per_minute ?? defaultMaxPerMinute,
            ) - (prefixSlots.get(channel) ?? 0),
          )
        : 0;
    const plan = store.uow.read((tx) => {
      const version = store.snapshotVersion(projectId);
      if (version === undefined)
        throw new Error("External reminders require a versioned snapshot");
      const cursor = JSON.stringify([version, generation, [...rateBatches]]);
      const projected =
        this.projectedVersions.get(projectId) === cursor &&
        channels.every(
          (c) => extQuietStamp(store.database, projectId, c) === null,
        );
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
      const plans =
        projected && !config.quiet_hours
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
                rateBatches.get(channel)!,
                available(channel, now),
                now,
              ),
            );
      return {
        cursor,
        plans,
        version,
        state,
        items: new Map(items.map((i) => [itemKey(i.kind, i.item_id), i])),
      };
    });
    if (!plan) return;
    if (
      plan.plans.some(
        (p) =>
          p.writes.length ||
          p.admissions.length ||
          p.previous !== p.next ||
          (p.singles.size &&
            p.singles.size > available(p.channel, this.clock.now())),
      ) &&
      !store.uow.run(() => {
        if (
          store.snapshotVersion(projectId) !== plan.version ||
          this.app?.binding?.generation !== generation ||
          plan.plans.some(
            (p) =>
              extRateBatch(store.database, p.channel) !==
                rateBatches.get(p.channel) ||
              collectingExtRateBatch(store.database, p.channel) !==
                p.collecting ||
              !this.current(p.channel) ||
              extQuietStamp(store.database, projectId, p.channel) !==
                (p.previous?.stamp ?? null),
          )
        )
          return false;
        for (const [i, initial] of plan.plans.entries()) {
          let p = initial;
          if (p.singles.size) {
            const left = available(p.channel, this.clock.now());
            if (left < p.singles.size) {
              p = { ...p, ...p.classify(left) };
              plan.plans[i] = p;
            }
          }
          // The quota can already be full when the read plan first discovers
          // ordinary overflow, even if every row in this write batch is deferred.
          if (
            p.hasRate ||
            ((p.incompleteOrdinary ||
              p.writes.some(
                ({ item, group }) => item.ready && group === null,
              )) &&
              !this.slotAvailable(p.channel, config, this.clock.now()))
          )
            deferExtRateBatch(store.database, p.channel);
          for (const { item, channel, group } of p.writes)
            projectExtMessage(store.database, item, channel, now, group);
          for (const { row, group } of p.admissions)
            groupExtMessage(store.database, row, group);
          if (p.previous !== p.next)
            saveExtQuietOverflow(store.database, projectId, p.channel, p.next);
        }
        return true;
      })
    )
      return false;
    if (plan.plans.every((p) => p.complete))
      this.projectedVersions.set(projectId, plan.cursor);
    const { plans } = plan;
    return {
      version: plan.version,
      state: plan.state,
      items: plan.items,
      watermarks,
      rateBatches,
      incompleteOrdinary: new Set(
        plans.filter((p) => p.incompleteOrdinary).map((p) => p.channel),
      ),
      incompleteDigests: new Set(
        plans.filter((p) => p.incompleteDigest).map((p) => p.channel),
      ),
      singles: new Map(plans.map((p) => [p.channel, p.singles])),
      quietStamps: new Map(
        plans.map((p) => [p.channel, p.next?.stamp ?? null]),
      ),
    };
  }
  private async deliver(
    candidates: readonly ExtMessageRow[],
    config: ExtMessageConfig,
    projections: Map<string, Projection>,
    collectOverflow: boolean,
    moreOrdinary: boolean,
  ): Promise<ExtMessageRow | "conflict" | "deferred" | undefined> {
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
      kind: "skip" | "fail" | "expire";
    }[] = [];
    for (const row of candidates) {
      if (row.lease_until && row.lease_until > at) continue;
      const item = projections
        .get(row.project_id)
        ?.items.get(itemKey(row.item_kind, row.item_id));
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
      eligible.push({ row, item });
    }
    if (!eligible.length && !updates.length)
      return quiet && candidate.digest_id === rateQueue
        ? "deferred"
        : undefined;
    const first = quiet ? undefined : eligible[0]?.item;
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
        extRateBatch(store.database, candidate.channel) !==
          projection.rateBatches.get(candidate.channel) ||
        (candidate.digest_id?.startsWith("rate:") &&
          pendingExtGroupSize(
            store.database,
            candidate.channel,
            candidate.digest_id,
          ) !== candidates.length) ||
        (candidate.digest_id === rateQueue
          ? [...projections.keys()]
          : participants
        ).some(
          (p) => store.snapshotVersion(p) !== projections.get(p)!.version,
        ) ||
        ((candidate.digest_id === "queued" ||
          (candidate.digest_id === null && !!config.quiet_hours)) &&
          extQuietStamp(store.database, project, candidate.channel) !==
            (projection.quietStamps.get(candidate.channel) ?? null)) ||
        (appChannel &&
          candidate.channel !== `lark_app:${this.app?.binding?.generation}`)
      )
        return "conflict" as const;
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
          return "conflict" as const;
      }
      for (const { row, kind } of updates) {
        if (kind === "expire")
          this.settle(tx, row, "pending", "unknown", at, row.next_attempt_at);
        else if (kind === "skip") this.settle(tx, row, "skipped", null, at, at);
        else this.settle(tx, row, "failed", "unknown", at, at);
      }
      const lease = randomUUID();
      const claimAt = this.clock.now();
      const sendBy = Date.parse(claimAt) + config.policy.timeout_ms;
      if (eligible.length) {
        const single = digest === null && candidate.attempts === 0;
        const enqueueRate = () => {
          deferExtRateBatch(store.database, candidate.channel);
          groupExtMessage(store.database, candidate, rateQueue);
          return { queued: { ...candidate, digest_id: rateQueue } };
        };
        // Establish ownership independently of the send gate. A quiet-time
        // observation alone cannot turn a newly ready item into prior overflow.
        const prefix = projection.singles
          .get(candidate.channel)
          ?.has(itemKey(candidate.item_kind, candidate.item_id));
        if (
          single &&
          (prefix
            ? !this.slotAvailable(candidate.channel, config, claimAt)
            : collectOverflow ||
              collectingExtRateBatch(store.database, candidate.channel))
        )
          return enqueueRate();
        if (quiet || extMessageQuiet(config, claimAt)) {
          if (single) groupExtMessage(store.database, candidate, "queued");
          return "deferred" as const;
        }
        if (
          !reserveExtAttempt(
            store.database,
            candidate.channel.split(":")[0]!,
            Date.parse(claimAt),
            config.policy.max_per_minute ?? defaultMaxPerMinute,
            lease,
            sendBy,
          )
        ) {
          if (single) return enqueueRate();
          return "deferred" as const;
        }
        // The last reservation may precede the first overflow outbox row. A
        // crash here must not turn the remaining known members back into singles.
        if (
          moreOrdinary &&
          !this.slotAvailable(candidate.channel, config, claimAt)
        )
          deferExtRateBatch(store.database, candidate.channel);
      }
      const until = new Date(sendBy).toISOString();
      const rows = eligible.map(({ row }) => {
        if (digest !== null) groupExtMessage(store.database, row, digest);
        const retryAt = new Date(
          Date.parse(until) +
            (config.policy.retry_delays_ms[row.attempts] ?? 0),
        ).toISOString();
        if (
          !claimExtMessage(store.database, row, lease, claimAt, until, retryAt)
        )
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
        lease,
        sendBy,
        appPort:
          interaction && first
            ? this.app?.prepare(interaction, first, digest)
            : undefined,
        versions: participants.map(
          (p) => [p, store.snapshotVersion(p)!] as const,
        ),
      };
    });
    if (typeof claimed === "string") return claimed;
    // Only our own ext_message_* audits changed since the checked snapshot;
    // they cannot affect outbound membership or Feishu action eligibility.
    if ("queued" in claimed) return claimed.queued;
    for (const [p, version] of claimed.versions)
      projections.get(p)!.version = version;
    if (!message) return;
    const factory = (this.options.adapters ?? extMessageAdapters)[
      candidate.channel
    ];
    let result: ExtSendResult = "adapter_unavailable";
    let port: ExtMessagePort | undefined;
    try {
      port =
        claimed.appPort ??
        factory?.(config.channels[candidate.channel]?.credential);
    } catch {
      result = "unknown";
    }
    if (port) {
      // Claim commit and adapter construction can cross quiet hours, a lease
      // deadline or a recipient change. Recheck immediately before the call.
      const dispatchAt = this.clock.now();
      const nowQuiet = extMessageQuiet(config, dispatchAt);
      const name = candidate.channel.split(":")[0]!;
      const activation = this.activations?.get(name);
      if (
        !activation ||
        nowQuiet ||
        Date.parse(dispatchAt) >= claimed.sendBy ||
        (appChannel &&
          candidate.channel !== `lark_app:${this.app?.binding?.generation}`) ||
        !ownsExtDispatch(
          store.database,
          name,
          activation.epoch,
          claimed.lease,
          claimed.rows.length,
        )
      ) {
        store.uow.run(() => {
          let restoredOverflow = false;
          for (const { row } of eligible) {
            const released = releaseUnsentExtMessage(
              store.database,
              row,
              claimed.lease,
              nowQuiet && row.digest_id === null && row.attempts === 0
                ? "queued"
                : row.digest_id,
            );
            if (released && row.digest_id === rateQueue)
              restoredOverflow = true;
          }
          // Another sender may have closed the fence while all members were leased.
          if (restoredOverflow)
            deferExtRateBatch(store.database, candidate.channel);
          finishExtAttempt(store.database, claimed.lease, null);
        });
        return "deferred";
      }
      result = await sendExtMessage(port, message, config.policy.timeout_ms);
    }
    const now = this.clock.now();
    const settledVersions = store.uow.run((tx) => {
      finishExtAttempt(store.database, claimed.lease, Date.parse(now));
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
