import type {
  Assignment,
  Clock,
  CommandState,
  Event,
  ProjectId,
  RemoteWorkerLoss,
  Run,
  Runtime,
  RuntimeObservation,
  RuntimeRef,
  RuntimeResult,
} from "@cardigan/domain";
import {
  DEFAULT_RUNTIME_UNKNOWN_GRACE_MS,
  eventsOfType,
  hostOpsExitConfirmation,
  MAX_RUNTIME_FAILURE_LIMIT,
  MIN_RUNTIME_FAILURE_LIMIT,
  type RuntimeDisconnectCause,
  reconnectRun,
  releaseLostRemoteWorker,
  remoteWorkerLosses,
  remoteWorkerLossReleased,
  reportRemoteWorkerAlive,
  requestRemoteWorkerExit,
  runtimeUnknownVisibleAt,
  settlePendingRunFinish,
  transition,
} from "@cardigan/domain";
import {
  failAutomaticContextRun,
  revokeStoppedRunTokens,
} from "@cardigan/host";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { payloadString } from "@cardigan/router";
import type { RuntimeEvent } from "@cardigan/runtime-herdr";
import type { Store, StoreTransactionContext } from "@cardigan/store";
import {
  alertAudience,
  dispatchAlert,
  unfinishedRun,
} from "./dispatch-alert.js";
import { dispatcherClock, type StandingResolver } from "./dispatch-inbox.js";
import { dispatcherInterval } from "./dispatch-loop.js";
import { cleanReleasedOrphan, type SnapshotOrphan } from "./orphan-cleanup.js";
import { lastSuccessfulWorkerBackup } from "./worker-backup.js";

/** HerdrRuntime implements this host-side subscription interface. */
export interface RuntimeEventSource extends Pick<Runtime, "retire_idle"> {
  probeRemoteProcess?(
    project: ProjectId,
    assignment: Assignment["id"],
    ref: RuntimeRef,
    saved?: RemoteWorkerLoss["process"],
  ): Promise<RuntimeObservation["process"] | "unreachable">;
  events(
    ref: RuntimeRef,
    signal?: AbortSignal,
  ): AsyncIterable<RuntimeResult<RuntimeEvent>>;
}
export interface RuntimeMonitorOptions {
  snapshotOrphan?: SnapshotOrphan;
  store: Store;
  runtime: RuntimeEventSource;
  clock?: Clock;
  standing?: StandingResolver;
  lossGraceMs?: number;
  eventSilenceMs?: number;
  /** The existing dispatcher interval; time beyond one scheduled interval is excluded. */
  reconcileIntervalMs?: number;
  maxConsecutiveFailures?: number;
  /** C-228 / Q-387: how long a failures-only unknown stays out of Needs You. */
  runtimeUnknownGraceMs?: number;
}
/** C-219 / Q-357: three failed attempts, including the initial subscription (§13.9). */
export const DEFAULT_RUNTIME_FAILURE_LIMIT = 3;
interface Subscription {
  controller: AbortController;
  ref: RuntimeRef;
  lastReceived: number;
  silentFor: number;
  failures: { count: number };
  seq: number;
  generation?: number;
  done: boolean;
}
const keyOf = (ref: RuntimeRef | null) => JSON.stringify(ref);
// C-670: every pass visits each assignment; index the immutable snapshot
// arrays once instead of scanning runs, losses and events per assignment.
const runIndex = new WeakMap<
  readonly Run[],
  ReadonlyMap<Assignment["id"], readonly Run[]>
>();
const noRuns: readonly Run[] = Object.freeze([]);
const activeRuns = (state: CommandState, a: Assignment): readonly Run[] => {
  let index = runIndex.get(state.runs);
  if (!index) {
    const map = new Map<Assignment["id"], Run[]>();
    for (const r of state.runs)
      if (unfinishedRun(r) && r.status !== "queued") {
        const list = map.get(r.assignment_id);
        if (list) list.push(r);
        else map.set(r.assignment_id, [r]);
      }
    index = map;
    runIndex.set(state.runs, index);
  }
  return index.get(a.id) ?? noRuns;
};
const lossIndex = new WeakMap<
  readonly RemoteWorkerLoss[],
  ReadonlyMap<string, RemoteWorkerLoss>
>();
/** Same as `remoteWorkerLosses(events).find(...)` for one assignment. */
const lossOf = (state: CommandState, id: Assignment["id"]) => {
  const losses = remoteWorkerLosses(state.events);
  let index = lossIndex.get(losses);
  if (!index) {
    const map = new Map<string, RemoteWorkerLoss>();
    for (const loss of losses)
      if (!map.has(loss.assignment_id)) map.set(loss.assignment_id, loss);
    index = map;
    lossIndex.set(losses, index);
  }
  return index.get(id);
};
const exitObserved = (state: CommandState, action: string) =>
  eventsOfType(state.events, "remote_worker_exit_observed").some(
    (e) => payloadString(e.payload, "action_id") === action,
  );
const lostFact = (state: CommandState, a: Assignment) =>
  eventsOfType(state.events, "runtime_disconnected").findLast(
    (e) =>
      payloadString(e.payload, "assignment_id") === a.id &&
      payloadString(e.payload, "runtime_key") === keyOf(a.runtime_ref),
  );

const factSince = (
  state: CommandState,
  a: Assignment,
  since: Event,
  type: string,
) =>
  state.events
    .slice(state.events.indexOf(since) + 1)
    .some(
      (e) =>
        e.type === type && payloadString(e.payload, "assignment_id") === a.id,
    );

export class RuntimeMonitor {
  private readonly clock: Clock;
  private readonly grace: number;
  private readonly silence: number;
  private readonly interval: number;
  private readonly failureLimit: number;
  private readonly unknownGrace: number;
  private lastReconciledAt: number;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly probes = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  private stopped = false;
  private failure: unknown;
  constructor(readonly options: RuntimeMonitorOptions) {
    this.clock = options.clock ?? dispatcherClock;
    this.grace = options.lossGraceMs ?? 5 * 60000;
    this.silence = options.eventSilenceMs ?? 45000;
    this.interval = dispatcherInterval(options.reconcileIntervalMs);
    this.failureLimit =
      options.maxConsecutiveFailures ?? DEFAULT_RUNTIME_FAILURE_LIMIT;
    this.unknownGrace =
      options.runtimeUnknownGraceMs ?? DEFAULT_RUNTIME_UNKNOWN_GRACE_MS;
    this.lastReconciledAt = Date.parse(this.clock.now());
    if (
      ![this.grace, this.silence, this.unknownGrace].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      ) ||
      !Number.isSafeInteger(this.failureLimit) ||
      this.failureLimit < MIN_RUNTIME_FAILURE_LIMIT ||
      this.failureLimit > MAX_RUNTIME_FAILURE_LIMIT
    )
      throw new Error("Invalid runtime monitor grace period");
  }
  /** Called on each host loop pass. Subscriptions continue independently of a slow wake. */
  reconcile(): void {
    if (this.stopped) return;
    if (this.failure) {
      const error = this.failure;
      this.failure = undefined;
      throw error;
    }
    const wanted = new Set<string>();
    const started = Date.parse(this.clock.now());
    for (const { id: project } of this.options.store.listProjects()) {
      const state = this.options.store.uow.read((tx) =>
        loadCommandState(tx, project),
      );
      for (const a of state.assignments) {
        const loss = lossOf(state, a.id);
        const watchLoss = loss && !exitObserved(state, loss.action_id);
        const ref = watchLoss ? loss.runtime_ref : a.runtime_ref;
        if (
          !ref ||
          (!watchLoss &&
            (a.status !== "active" ||
              a.external ||
              !a.runtime_ref ||
              ["lost", "released"].includes(a.runtime_state) ||
              !activeRuns(state, a).length))
        )
          continue;
        const key = `${project}/${a.id}`;
        wanted.add(key);
        const old = this.subscriptions.get(key);
        const sameSession = old && keyOf(old.ref) === keyOf(ref);
        if (old && sameSession && !old.done)
          old.silentFor += Math.min(
            this.interval,
            Math.max(
              0,
              started - Math.max(this.lastReconciledAt, old.lastReceived),
            ),
          );
        if (
          old &&
          (old.done ||
            keyOf(old.ref) !== keyOf(ref) ||
            old.silentFor >= this.silence)
        ) {
          if (!old.done && sameSession) this.failed(project, a.id, old);
          old.controller.abort();
          this.subscriptions.delete(key);
        }
        if (!this.subscriptions.has(key))
          this.subscribe(
            key,
            project,
            a,
            ref,
            sameSession ? old.failures : { count: 0 },
          );
      }
      this.expire(project);
    }
    for (const [key, sub] of this.subscriptions)
      if (!wanted.has(key)) {
        sub.controller.abort();
        this.subscriptions.delete(key);
      }
    // Store reads and synchronous work in this pass are not terminal silence.
    this.lastReconciledAt = Date.parse(this.clock.now());
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const sub of this.subscriptions.values()) sub.controller.abort();
    await Promise.all(this.tasks);
    this.subscriptions.clear();
    if (this.failure) throw this.failure;
  }
  private subscribe(
    key: string,
    project: ProjectId,
    a: Assignment,
    ref: RuntimeRef,
    failures: Subscription["failures"],
  ) {
    const sub: Subscription = {
      controller: new AbortController(),
      ref,
      lastReceived: Date.parse(this.clock.now()),
      silentFor: 0,
      failures,
      seq: -1,
      done: false,
    };
    this.subscriptions.set(key, sub);
    const task = this.consume(project, a.id, sub)
      .catch((error) => {
        this.failure = error;
      })
      .finally(() => {
        sub.done = true;
        this.tasks.delete(task);
      });
    this.tasks.add(task);
  }
  private async consume(
    project: ProjectId,
    id: Assignment["id"],
    sub: Subscription,
  ) {
    const { signal } = sub.controller;
    try {
      for await (const result of this.options.runtime.events(sub.ref, signal)) {
        if (signal.aborted) return;
        if (!result.ok) {
          if (result.error.code === "runtime_not_found")
            this.observe(project, id, sub.ref, "unknown");
          break;
        }
        const e = result.value;
        if (e.source_generation !== undefined) {
          if (
            sub.generation !== undefined &&
            e.source_generation < sub.generation
          )
            continue;
          if (e.source_generation !== sub.generation) {
            sub.seq = -1;
            sub.generation = e.source_generation;
          }
        }
        if (!Number.isSafeInteger(e.seq) || e.seq < 0 || e.seq < sub.seq)
          continue;
        sub.lastReceived = Date.parse(this.clock.now());
        sub.silentFor = 0;
        // Equal-seq heartbeats prove the connection is alive, but cannot replay state changes.
        if (e.seq === sub.seq) continue;
        sub.seq = e.seq;
        const type = e.type.split(/[.:/]/u).at(-1);
        const terminal = e.observations.find(
          (t) => t.terminal_ref === sub.ref.terminal_ref,
        );
        if (
          e.terminal_ref === sub.ref.terminal_ref &&
          ["lost", "finished", "removed"].includes(type ?? "")
        )
          this.observe(
            project,
            id,
            sub.ref,
            type === "finished" ? "exited" : "unknown",
          );
        else if (terminal) {
          if (terminal.status.process === "alive") sub.failures.count = 0;
          this.observe(project, id, sub.ref, terminal.status.process);
        } else if (["snapshot", "missed"].includes(type ?? ""))
          this.observe(project, id, sub.ref, "unknown");
      }
    } catch (error) {
      if (!signal.aborted) this.failure = error;
    }
    if (!signal.aborted) this.failed(project, id, sub);
  }
  private failed(project: ProjectId, id: Assignment["id"], sub: Subscription) {
    sub.failures.count++;
    if (sub.failures.count >= this.failureLimit)
      this.observe(project, id, sub.ref, "unknown", "failures");
  }
  private observe(
    project: ProjectId,
    id: Assignment["id"],
    ref: RuntimeRef,
    process: RuntimeObservation["process"],
    cause: RuntimeDisconnectCause = "exit",
    proof?: string,
  ) {
    const alive = process === "alive";
    const { store } = this.options;
    store.uow.run((tx) => {
      const state = loadCommandState(tx, project),
        a = state.assignments.find((a) => a.id === id);
      const loss = remoteWorkerLosses(state.events).find(
        (loss) =>
          loss.assignment_id === id && keyOf(loss.runtime_ref) === keyOf(ref),
      );
      if (
        !a ||
        (proof !== undefined && this.probeKey(state, a, ref, loss) !== proof)
      )
        return;
      if (
        a.machine_id !== "local" &&
        !proof &&
        (loss || (alive && a.runtime_state === "unknown"))
      ) {
        if (alive || process === "exited")
          this.probe(project, state, a, ref, loss);
        return;
      }
      if (loss) {
        if (alive)
          persistEffect(
            tx,
            project,
            unwrap(
              reportRemoteWorkerAlive(
                state,
                { kind: "system", project_id: project },
                loss.action_id,
                { clock: this.clock, ids: tx.ids },
              ),
            ),
          );
        // Loss, missing registry entries and transport failures do not prove process exit.
        else if (
          process === "exited" &&
          remoteWorkerLossReleased(state.events, loss.action_id) &&
          a &&
          !exitObserved(state, loss.action_id)
        )
          this.fact(tx, state, a, "remote_worker_exit_observed", {
            action_id: loss.action_id,
          });
        return;
      }
      if (
        a?.status !== "active" ||
        keyOf(a.runtime_ref) !== keyOf(ref) ||
        ["lost", "released"].includes(a.runtime_state)
      )
        return;
      const runs = activeRuns(state, a);
      if (
        !runs.length ||
        (alive &&
          a.runtime_state !== "unknown" &&
          !runs.some((r) => r.pending_finish))
      )
        return;
      // The fresh transaction has checked the complete RuntimeRef. An exit
      // before the first MCP start is a failed replacement, not a retryable Run.
      if (!alive && cause === "exit" && (a.machine_id === "local" || proof))
        for (const run of runs)
          failAutomaticContextRun(
            store,
            project,
            run.id,
            "新会话在首次启动前退出或丢失。",
            this.clock,
            tx,
          );
      if (!alive && a.runtime_state === "unknown") {
        const since = lostFact(state, a);
        if (!since) this.fact(tx, state, a, "runtime_disconnected", { cause });
        // C-228: an explicit exit after a failures-only unknown is shown at once.
        else if (
          cause === "exit" &&
          payloadString(since.payload, "cause") === "failures" &&
          !factSince(state, a, since, "runtime_exit_observed")
        )
          this.fact(tx, state, a, "runtime_exit_observed");
        return;
      }
      if (proof && alive && a.runtime_state === "unknown")
        this.fact(tx, state, a, "remote_worker_process_checked", {
          process: "alive",
        });
      if (!alive || a.runtime_state === "unknown") {
        const event = alive ? "reconnected" : "connection_lost";
        tx.assignments.put(project, {
          ...a,
          runtime_state: unwrap(transition("runtime", a.runtime_state, event)),
        });
        if (alive) this.fact(tx, state, a, "runtime_reconnected");
        else this.fact(tx, state, a, "runtime_disconnected", { cause });
        for (const r of runs) {
          if (alive && r.status !== "unknown") continue;
          tx.runs.put(project, {
            ...r,
            status: unwrap(
              alive
                ? reconnectRun(r)
                : transition("run", r.status, "connection_lost"),
            ),
          });
        }
      }
      // A stop fence may have postponed settlement at reconnection. A later
      // fresh alive observation can settle it once that fence is withdrawn.
      if (alive)
        for (const r of runs) {
          if (!r.pending_finish) continue;
          const token = tx
            .tokensForAssignment(project, r.assignment_id)
            .find((t) => t.id === r.pending_finish?.token_id);
          persistEffect(
            tx,
            project,
            unwrap(
              settlePendingRunFinish(
                loadCommandState(tx, project),
                { kind: "system", project_id: project },
                { run_id: r.id, runtime_ref: ref },
                {
                  clock: this.clock,
                  ids: tx.ids,
                  ...(token ? { run_token: token } : {}),
                },
              ),
            ),
          );
        }
    });
  }
  private fact(
    tx: StoreTransactionContext,
    state: CommandState,
    a: Assignment,
    type: string,
    extra: Readonly<Record<string, string>> = {},
  ) {
    const card = state.work_items.find((w) => w.id === a.work_item_id)?.card_id;
    const event: Event = {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(state.project_id, card),
      ...(card ? { card_id: card } : {}),
      type,
      actor: { kind: "system", project_id: state.project_id },
      created_at: this.clock.now(),
      payload: {
        assignment_id: a.id,
        runtime_key: keyOf(a.runtime_ref),
        ...extra,
      },
    };
    tx.events.append(state.project_id, event);
  }
  private probeKey(
    state: CommandState,
    a: Assignment,
    ref: RuntimeRef,
    loss?: RemoteWorkerLoss,
  ) {
    return JSON.stringify([
      a.id,
      a.status,
      a.runtime_state,
      a.runtime_ref,
      ref,
      activeRuns(state, a).map((r) => [r.id, r.status]),
      lostFact(state, a)?.id,
      loss?.action_id,
      loss && hostOpsExitConfirmation(state, loss.action_id),
      state.work_items.find((w) => w.id === a.work_item_id)?.assignment_id,
    ]);
  }
  private probe(
    project: ProjectId,
    state: CommandState,
    a: Assignment,
    ref: RuntimeRef,
    loss?: RemoteWorkerLoss,
  ) {
    const slot = `${project}/${a.id}`;
    if (this.probes.has(slot)) return;
    this.probes.add(slot);
    const stamp = this.probeKey(state, a, ref, loss);
    const task = Promise.resolve()
      .then(() =>
        this.options.runtime.probeRemoteProcess?.(
          project,
          a.id,
          ref,
          loss?.process,
        ),
      )
      .catch(() => "unknown" as const)
      .then(async (result) => {
        if (this.stopped) return;
        const process = result ?? "unknown";
        if (process === "alive" || loss)
          this.observe(
            project,
            a.id,
            ref,
            process === "unreachable" ? "unknown" : process,
            "exit",
            stamp,
          );
        else this.expire(project, { id: a.id, stamp, process });
        if (
          loss &&
          process !== "exited" &&
          remoteWorkerLossReleased(state.events, loss.action_id)
        )
          await cleanReleasedOrphan({
            store: this.options.store,
            project,
            clock: this.clock,
            loss,
            alive: process === "alive",
            stopped: () => this.stopped,
            runtime: this.options.runtime,
            ...(this.options.snapshotOrphan
              ? { snapshot: this.options.snapshotOrphan }
              : {}),
          });
      })
      .catch((error) => {
        this.failure = error;
      })
      .finally(() => {
        this.probes.delete(slot);
        this.tasks.delete(task);
      });
    this.tasks.add(task);
  }
  private expire(
    project: ProjectId,
    checked?: { id: Assignment["id"]; stamp: string; process: string },
  ) {
    const { store, standing } = this.options;
    store.uow.run((tx) => {
      const state = loadCommandState(tx, project),
        at = this.clock.now();
      for (const a of state.assignments) {
        if (checked && checked.id !== a.id) continue;
        const loss = lossOf(state, a.id);
        if (loss?.runtime_ref && !exitObserved(state, loss.action_id))
          this.probe(project, state, a, loss.runtime_ref, loss);
        if (a.status === "active" && a.runtime_state === "lost") {
          this.recoverLost(tx, project, a);
          continue;
        }
        if (
          a.status !== "active" ||
          a.runtime_state !== "unknown" ||
          !activeRuns(state, a).length
        )
          continue;
        const since = lostFact(state, a);
        if (!since) {
          this.fact(tx, state, a, "runtime_disconnected");
          continue;
        }
        // C-228: tell Needs You (via the event stream) that a failures-only
        // unknown has outlasted its grace period; audit-only otherwise.
        const visibleAt = runtimeUnknownVisibleAt(
          state.events,
          a,
          this.unknownGrace,
        );
        if (
          visibleAt !== null &&
          Date.parse(at) >= Date.parse(visibleAt) &&
          !factSince(state, a, since, "runtime_unknown_surfaced")
        )
          this.fact(tx, state, a, "runtime_unknown_surfaced");
        if (Date.parse(at) - Date.parse(since.created_at) < this.grace)
          continue;
        if (a.machine_id !== "local") {
          if (!a.runtime_ref) continue;
          if (!checked) {
            this.probe(project, state, a, a.runtime_ref);
            continue;
          }
          if (this.probeKey(state, a, a.runtime_ref) !== checked.stamp)
            continue;
          const last = eventsOfType(
            state.events,
            "remote_worker_process_checked",
          ).findLast(
            (e) =>
              payloadString(e.payload, "assignment_id") === a.id &&
              payloadString(e.payload, "disconnect_id") === since.id,
          );
          if (
            payloadString(last?.payload ?? null, "process") !== checked.process
          )
            this.fact(tx, state, a, "remote_worker_process_checked", {
              process: checked.process,
              disconnect_id: since.id,
            });
          if (checked.process === "unknown") continue;
        }
        tx.assignments.put(project, {
          ...a,
          runtime_state: unwrap(
            transition("runtime", a.runtime_state, "declared_lost"),
          ),
        });
        // Transport failures retain the existing loss grace. Its expiry is
        // enough to fail this launch, never proof that the process has exited.
        for (const run of activeRuns(state, a))
          failAutomaticContextRun(
            store,
            project,
            run.id,
            "新会话在首次启动前失联，已超过现有失联宽限期。",
            this.clock,
            tx,
          );
        if (this.recoverLost(tx, project, a)) continue;
        dispatchAlert(tx, store, state, at, {
          assignment: a,
          type: "runtime_lost",
          reason: "runtime_loss_grace_exceeded",
          audience:
            alertAudience(a, state, standing) === "human_only"
              ? "human_only"
              : "human",
          card_id: since.card_id,
        });
      }
    });
  }
  private recoverLost(
    tx: StoreTransactionContext,
    project: ProjectId,
    a: Assignment,
  ): boolean {
    if (a.machine_id === "local" || a.scope !== "work_item" || a.external)
      return false;
    const state = loadCommandState(tx, project);
    const backup = lastSuccessfulWorkerBackup(state, a);
    const requested = unwrap(
      requestRemoteWorkerExit(
        state,
        { kind: "system", project_id: project },
        { assignment_id: a.id, ...(backup ? { backup } : {}) },
        { clock: this.clock, ids: tx.ids },
      ),
    );
    persistEffect(tx, project, requested);
    const fresh = loadCommandState(tx, project);
    if (
      hostOpsExitConfirmation(fresh, requested.data.action_id).status ===
      "confirmed"
    ) {
      const effect = unwrap(
        releaseLostRemoteWorker(
          fresh,
          { kind: "system", project_id: project },
          requested.data.action_id,
          { clock: this.clock, ids: tx.ids },
        ),
      );
      if (effect.data) revokeStoppedRunTokens(tx, project, effect.data);
      persistEffect(tx, project, effect);
    }
    return true;
  }
}
