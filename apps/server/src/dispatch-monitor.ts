import type {
  Assignment,
  Clock,
  CommandState,
  Event,
  ProjectId,
  RuntimeRef,
  RuntimeResult,
} from "@cardigan/domain";
import { settlePendingRunFinish, transition } from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { payloadString } from "@cardigan/router";
import type { RuntimeEvent } from "@cardigan/runtime-herdr";
import type { Store, StoreTransactionContext } from "@cardigan/store";
import { dispatchAlert, unfinishedRun } from "./dispatch-alert.js";
import { dispatcherClock, type StandingResolver } from "./dispatch-inbox.js";
import { dispatcherInterval } from "./dispatch-loop.js";

/** HerdrRuntime implements this host-side subscription interface. */
export interface RuntimeEventSource {
  events(
    ref: RuntimeRef,
    signal?: AbortSignal,
  ): AsyncIterable<RuntimeResult<RuntimeEvent>>;
}
export interface RuntimeMonitorOptions {
  store: Store;
  runtime: RuntimeEventSource;
  clock?: Clock;
  standing?: StandingResolver;
  lossGraceMs?: number;
  eventSilenceMs?: number;
  /** The existing dispatcher interval; time beyond one scheduled interval is excluded. */
  reconcileIntervalMs?: number;
  maxConsecutiveFailures?: number;
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
  done: boolean;
}
const keyOf = (ref: RuntimeRef | null) => JSON.stringify(ref);
const activeRuns = (state: CommandState, a: Assignment) =>
  state.runs.filter(
    (r) =>
      r.assignment_id === a.id && unfinishedRun(r) && r.status !== "queued",
  );
const lostFact = (state: CommandState, a: Assignment) =>
  state.events.findLast(
    (e) =>
      e.type === "runtime_disconnected" &&
      payloadString(e.payload, "assignment_id") === a.id &&
      payloadString(e.payload, "runtime_key") === keyOf(a.runtime_ref),
  );

export class RuntimeMonitor {
  private readonly clock: Clock;
  private readonly grace: number;
  private readonly silence: number;
  private readonly interval: number;
  private readonly failureLimit: number;
  private lastReconciledAt: number;
  private readonly subscriptions = new Map<string, Subscription>();
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
    this.lastReconciledAt = Date.parse(this.clock.now());
    if (
      ![this.grace, this.silence].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      ) ||
      !Number.isSafeInteger(this.failureLimit) ||
      this.failureLimit < 2
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
        if (
          a.status !== "active" ||
          a.external ||
          !a.runtime_ref ||
          ["lost", "released"].includes(a.runtime_state) ||
          !activeRuns(state, a).length
        )
          continue;
        const key = `${project}/${a.id}`;
        wanted.add(key);
        const old = this.subscriptions.get(key);
        const sameSession = old && keyOf(old.ref) === keyOf(a.runtime_ref);
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
            keyOf(old.ref) !== keyOf(a.runtime_ref) ||
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
            a.runtime_ref,
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
            this.observe(project, id, sub.ref, false);
          break;
        }
        const e = result.value;
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
          this.observe(project, id, sub.ref, false);
        else if (terminal) {
          if (terminal.status.process === "alive") sub.failures.count = 0;
          this.observe(
            project,
            id,
            sub.ref,
            terminal.status.process === "alive",
          );
        } else if (["snapshot", "missed"].includes(type ?? ""))
          this.observe(project, id, sub.ref, false);
      }
    } catch (error) {
      if (!signal.aborted) this.failure = error;
    }
    if (!signal.aborted) this.failed(project, id, sub);
  }
  private failed(project: ProjectId, id: Assignment["id"], sub: Subscription) {
    sub.failures.count++;
    if (sub.failures.count >= this.failureLimit)
      this.observe(project, id, sub.ref, false);
  }
  private observe(
    project: ProjectId,
    id: Assignment["id"],
    ref: RuntimeRef,
    alive: boolean,
  ) {
    const { store } = this.options;
    store.uow.run((tx) => {
      const state = loadCommandState(tx, project),
        a = state.assignments.find((a) => a.id === id);
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
      if (!alive && a.runtime_state === "unknown") {
        if (!lostFact(state, a))
          this.fact(tx, state, a, "runtime_disconnected");
        return;
      }
      if (!alive || a.runtime_state === "unknown") {
        const event = alive ? "reconnected" : "connection_lost";
        tx.assignments.put(project, {
          ...a,
          runtime_state: unwrap(transition("runtime", a.runtime_state, event)),
        });
        this.fact(
          tx,
          state,
          a,
          alive ? "runtime_reconnected" : "runtime_disconnected",
        );
        for (const r of runs) {
          if (alive && r.status !== "unknown") continue;
          tx.runs.put(project, {
            ...r,
            status: unwrap(transition("run", r.status, event)),
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
  ) {
    const card = state.work_items.find((w) => w.id === a.work_item_id)?.card_id;
    const event: Event = {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(state.project_id, card),
      ...(card ? { card_id: card } : {}),
      type,
      actor: { kind: "system", project_id: state.project_id },
      created_at: this.clock.now(),
      payload: { assignment_id: a.id, runtime_key: keyOf(a.runtime_ref) },
    };
    tx.events.append(state.project_id, event);
  }
  private expire(project: ProjectId) {
    const { store, standing } = this.options;
    store.uow.run((tx) => {
      const state = loadCommandState(tx, project),
        at = this.clock.now();
      for (const a of state.assignments) {
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
        if (Date.parse(at) - Date.parse(since.created_at) < this.grace)
          continue;
        tx.assignments.put(project, {
          ...a,
          runtime_state: unwrap(
            transition("runtime", a.runtime_state, "declared_lost"),
          ),
        });
        dispatchAlert(tx, store, state, at, {
          assignment: a,
          type: "runtime_lost",
          reason: "runtime_loss_grace_exceeded",
          audience:
            standing?.(project, "pm_office", state) === a.id
              ? "human_only"
              : "human",
          card_id: since.card_id,
        });
      }
    });
  }
}
