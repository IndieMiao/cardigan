import type {
  Actor,
  CardId,
  Clock,
  CommandEffect,
  CommandPorts,
  CommandState,
  Event,
  ProjectId,
  Repository,
  Result,
  ToolName,
  TransactionContext,
} from "@cardigan/domain";
import {
  COLD_CARD_OMITTED_EVENT_TYPES,
  commandEventHistory,
  commandRunIds,
  commandStreamHistory,
  commandTargetCards,
  githubRunCards,
  hotCardIds,
  LEAN_COLD_CARD_OMITTED_EVENT_TYPES,
  liveTriggerEventIds,
  PROJECT_STREAM_RETENTION,
  projectStreamDropped,
  waitedGithubRuns,
} from "@cardigan/domain";
import type {
  CommandEventStreams,
  McpBackend,
  McpReadContext,
} from "../backend.js";
import { publicSourceMergeData } from "../source-merge-public.js";
import type { ToolContext } from "../tools/types.js";

const histories = new WeakMap<
  ReadonlyMap<string, readonly Event[]>,
  Map<string, readonly Event[]>
>();

/**
 * Project stream, then card streams in card order (C-640: built from the
 * Store log with its index). Entity-only revisions do not change immutable
 * event history or its indexes. `hot` (C-639) keeps whole streams only for
 * hot cards; other cards keep their events except the cold-omitted telemetry
 * types. C-643: telemetry (run lifecycle, GitHub dispatch journal, branch
 * backups, session maintenance) stays out of the command-state stream; rules
 * read it through the attached journal (`eventsOfType`, `eventById`,
 * `fullEventHistory`).
 */
function eventHistory(
  streams: CommandEventStreams,
  cards: readonly { id: string }[],
  hot?: ReadonlySet<string>,
  lean?: Lean,
) {
  // Only which cards are hot matters, in card order: no sort on this path.
  const key =
    (lean ? `L${lean.serial}:` : "") +
    cards
      .map((c) => (hot === undefined ? "*" : hot.has(c.id) ? "+" : "-") + c.id)
      .join(",");
  let cache = histories.get(streams);
  if (!cache) {
    cache = new Map();
    histories.set(streams, cache);
  }
  const cached = cache.get(key);
  if (cached) return cached;
  const events = commandStreamHistory(
    streams,
    ["", ...cards.map((c) => c.id)],
    hot
      ? lean
        ? {
            full: hot,
            omit: LEAN_COLD_CARD_OMITTED_EVENT_TYPES,
            dropped: lean.dropped,
          }
        : { full: hot, omit: COLD_CARD_OMITTED_EVENT_TYPES }
      : undefined,
  );
  // Base state plus a few target extensions share one immutable snapshot.
  if (cache.size >= 8) cache.delete(cache.keys().next().value as string);
  cache.set(key, events);
  return events;
}

/** Hot cards each cached state was built for; extensions rebuild events only. */
const hotSets = new WeakMap<CommandState, ReadonlySet<string>>();
/** C-649: the `lean` inputs each cached state was built with. */
const leanInputs = new WeakMap<CommandState, Lean>();

/**
 * C-649 `lean` scope: project-stream retention (`dropped`, one stable object
 * while its inputs do not change, so histories and index answers are shared)
 * and the project's GitHub dispatch records from the full log index.
 */
interface Lean {
  readonly serial: number;
  readonly dropped: ReadonlySet<string>;
  readonly dispatches: readonly Event[];
}
const DISPATCH_TYPES: ReadonlySet<string> = new Set(["github_check_dispatch"]);
// One subset per type (rules are per type), so no cross-type merge or sort.
const retainedTypes = [...PROJECT_STREAM_RETENTION.keys()].map(
  (type) => new Set([type]),
);
let leanSerial = 0;
const leanCache = new Map<string, { key: string; lean: Lean }>();
function leanInputsFor(
  project: string,
  streams: CommandEventStreams,
  protect: ReadonlySet<string>,
): Lean | undefined {
  if (!streams.ofTypes) return undefined;
  const { ofTypes } = streams;
  const typed = retainedTypes.flatMap(
    (t) => ofTypes.call(streams, t).get("") ?? [],
  );
  const dispatches = [...ofTypes.call(streams, DISPATCH_TYPES).values()].flat();
  // Appends only grow these lists; ids are unique, so count + last id + the
  // protected ids identify the inputs.
  const key = [
    typed.length,
    typed.at(-1)?.id ?? "",
    dispatches.length,
    dispatches.at(-1)?.id ?? "",
    [...protect].join(","),
  ].join("\u0000");
  const cached = leanCache.get(project);
  if (cached?.key === key) return cached.lean;
  const lean = {
    serial: ++leanSerial,
    dropped: projectStreamDropped(typed, protect),
    dispatches,
  };
  leanCache.set(project, { key, lean });
  return lean;
}
const extensions = new WeakMap<
  CommandState,
  { key: string; state: CommandState }
>();

/**
 * Pins only widen the hot set (more history is always correct); they expire
 * after this many base rebuilds without a target or notification naming them.
 */
const STICKY_GENERATIONS = 512;
const sticky = new Map<
  string,
  { generation: number; used: Map<string, number> }
>();
function stickyPins(project: string) {
  let pins = sticky.get(project);
  if (!pins) {
    pins = { generation: 0, used: new Map() };
    sticky.set(project, pins);
  }
  return pins;
}

export interface CommandStateOptions {
  /** Command parameters (or ids) naming the cards a command is about. */
  readonly targets?: readonly unknown[];
}

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

/** Read the registration on the command transaction's connection, never from card history. */
export function projectRepositories(
  store: Pick<McpBackend, "getProject">,
  project_id: ProjectId,
) {
  const project = store.getProject?.(project_id);
  return project?.repo_path
    ? [{ repo: project.repo_path, base_branch: project.base_branch }]
    : [];
}

/** Every list and event stream belongs to this transaction's project snapshot. */
export function loadCommandState(
  tx: McpReadContext,
  project_id: ProjectId,
  project_settings?: CommandState["project_settings"],
  options: CommandStateOptions = {},
): CommandState {
  // Resolve the transaction's event history even on a state cache hit. A
  // backend without this bulk port keeps the original per-stream read path.
  const streams = tx.events.listStreams?.(project_id);
  const scope = tx.command_state_scope;
  const hot = (scope === "hot" || scope === "lean") && streams !== undefined;
  const lean = scope === "lean" && hot;
  const build = () => readCommandState(tx, project_id, streams, hot, lean);
  let state =
    (streams && tx.cachedCommandState?.(project_id, build)) || build();
  if (hot && streams) state = extendHot(tx, state, streams, options, lean);
  if (!project_settings && !tx.test_review_trust && !tx.read_machine_placement)
    return state;
  // Attach live authority AFTER the data cache; revoked/restarted sources must
  // never survive as cached command-state eligibility.
  return {
    ...state,
    ...(project_settings ? { project_settings } : {}),
    ...(tx.read_machine_placement
      ? { read_machine_placement: tx.read_machine_placement }
      : {}),
    ...(tx.test_review_trust
      ? { test_review_trust: tx.test_review_trust }
      : {}),
  };
}

/**
 * Inbox notifications and command targets are not part of the cached state's
 * version; when they name a cold card, rebuild only the event history.
 */
function extendHot(
  tx: McpReadContext,
  state: CommandState,
  streams: CommandEventStreams,
  options: CommandStateOptions,
  lean = false,
): CommandState {
  const base = hotSets.get(state);
  if (!base) return state;
  const extra = new Set<string>(
    tx.hot_state_hints?.liveNotificationCards(state.project_id) ?? [],
  );
  if (options.targets?.length)
    for (const id of commandTargetCards(state, options.targets)) extra.add(id);
  // C-649: notifications are outside the cached state's version, so lean
  // retention inputs are rechecked here; a GitHub run id among the command
  // parameters keeps its dispatch cards whole.
  const built = leanInputs.get(state);
  const current =
    lean && built
      ? (leanInputsFor(
          state.project_id,
          streams,
          leanProtect(tx, state.project_id, state.runs),
        ) ?? built)
      : built;
  if (current && options.targets?.length)
    for (const id of githubRunCards(
      current.dispatches,
      commandRunIds(options.targets),
    ))
      extra.add(id);
  const pins = stickyPins(state.project_id);
  for (const id of extra) pins.used.set(id, pins.generation);
  const missing = [...extra].filter(
    (id) => !base.has(id) && state.cards.some((c) => c.id === id),
  );
  if (!missing.length && current === built) return state;
  const hot = new Set([...base, ...missing]);
  const key = `${[...missing].sort().join(",")}|${current?.serial ?? ""}`;
  const cached = extensions.get(state);
  if (cached?.key === key) return cached.state;
  const extended = {
    ...state,
    events: eventHistory(streams, state.cards, hot, current),
  };
  hotSets.set(extended, hot);
  if (current) leanInputs.set(extended, current);
  extensions.set(state, { key, state: extended });
  return extended;
}

/** C-649: live Run triggers and live notification subjects are never retained away. */
function leanProtect(
  tx: McpReadContext,
  project: ProjectId,
  runs: CommandState["runs"],
): ReadonlySet<string> {
  return new Set<string>([
    ...liveTriggerEventIds(runs),
    ...(tx.hot_state_hints?.liveNotificationEvents?.(project) ?? []),
  ]);
}

function readCommandState(
  tx: McpReadContext,
  project_id: ProjectId,
  streams: CommandEventStreams | undefined,
  hot = false,
  lean = false,
): CommandState {
  const cards = tx.cards.list(project_id);
  const entities = {
    cards,
    work_items: tx.work_items.list(project_id),
    assignments: tx.assignments.list(project_id),
    runs: tx.runs.list(project_id),
    decisions: tx.decisions.list(project_id),
    human_actions: tx.human_actions.list(project_id),
  };
  let hotCards: Set<string> | undefined;
  let leanInput: Lean | undefined;
  if (hot && streams) {
    // Triggers of unfinished Runs may live on a closed card's stream.
    const triggers = tx.hot_state_hints?.eventCards(
      project_id,
      liveTriggerEventIds(entities.runs),
    );
    // Recently targeted or notified cold cards join the base hot set, so
    // repeated targets reuse one history (and its indexes) per snapshot.
    const pins = stickyPins(project_id);
    pins.generation++;
    for (const [id, used] of pins.used)
      if (pins.generation - used > STICKY_GENERATIONS) pins.used.delete(id);
    // C-649: lean keeps the dispatch cards of waited GitHub runs whole.
    leanInput = lean
      ? leanInputsFor(
          project_id,
          streams,
          leanProtect(tx, project_id, entities.runs),
        )
      : undefined;
    hotCards = hotCardIds(entities, [
      ...((triggers?.values() ?? []) as Iterable<CardId | undefined>),
      ...(pins.used.keys() as Iterable<CardId>),
      ...(leanInput
        ? githubRunCards(
            leanInput.dispatches,
            waitedGithubRuns(entities.work_items),
          )
        : []),
    ]);
  }
  // Store reads only newly appended rows. Keep the original project/card/seq
  // order, including filtering out streams whose card is absent from this snapshot.
  const state: CommandState = {
    project_id,
    project_preferences: tx.project_preferences?.list(project_id) ?? [],
    card_templates: tx.card_templates?.list(project_id) ?? [],
    employees: tx.employees?.list() ?? [],
    members: tx.members?.list() ?? [],
    employee_activity: tx.employees?.assignmentActivity?.() ?? [],
    machines: tx.machines.list(project_id),
    ...entities,
    deliveries: tx.deliveries.list(project_id),
    reviews: tx.reviews.list(project_id),
    attachments: tx.attachments.list(project_id),
    roles: tx.roles.list(project_id),
    cursors: tx.cursors.list(project_id),
    timeline: tx.timeline.list(project_id),
    events: streams
      ? eventHistory(streams, cards, hotCards, leanInput)
      : commandEventHistory(
          [undefined, ...cards.map((c) => c.id)].map((id) =>
            tx.events.listAfter(project_id, id, 0),
          ),
        ),
  };
  if (hotCards) hotSets.set(state, hotCards);
  if (leanInput) leanInputs.set(state, leanInput);
  return state;
}

/** Whether `persistEffect` would write anything for `effect`. */
export function effectWrites(effect: CommandEffect<unknown>): boolean {
  return (
    effect.changes.length > 0 ||
    effect.events.length > 0 ||
    effect.timeline.length > 0
  );
}

/** Persist a command effect inside an open transaction (shared with the CLI). */
export function persistEffect(
  tx: TransactionContext,
  project: ProjectId,
  effect: CommandEffect<unknown>,
) {
  for (const change of effect.changes) {
    // EntityChange preserves the collection/entity correlation across this union.
    const repository = tx[change.collection] as Pick<
      Repository<typeof change.entity, never>,
      "put"
    >;
    repository.put(project, change.entity);
  }
  // Token requests reserve metadata for host provisioning; MCP never fulfills them.
  for (const event of effect.events) tx.events.append(project, event);
  for (const entry of effect.timeline) tx.timeline.put(project, entry);
}

const invocation = (
  context: ToolContext,
  tool: ToolName,
  key: string,
  params: unknown,
) => ({
  project_id: context.identity.actor.project_id,
  assignment_id: context.identity.actor.assignment_id,
  key,
  request: { tool, params },
});
type Reducer<P, T> = (
  state: CommandState,
  actor: Actor,
  params: P,
  ports: CommandPorts,
) => Result<CommandEffect<T>>;
function timed<T>(context: ToolContext, stage: string, run: () => T): T {
  const start = performance.now();
  try {
    return run();
  } finally {
    context.recordTiming?.(stage, performance.now() - start);
  }
}
export function executeCommand<P, T>(
  context: ToolContext,
  tool: ToolName,
  key: string,
  params: P,
  reduce: Reducer<P, T>,
  clock: Clock = { now: () => new Date().toISOString() },
): T {
  const {
    store,
    identity: { actor },
  } = context;
  context.revalidateToken?.();
  return publicSourceMergeData(
    timed(
      context,
      "command_transaction",
      () =>
        unwrap(
          store.runIdempotent(invocation(context, tool, key, params), (tx) => {
            context.revalidateToken?.();
            const state = timed(context, "command_state", () =>
              loadCommandState(
                tx,
                actor.project_id,
                context.projectSettings?.(actor.project_id),
                {
                  targets: [
                    params,
                    actor.kind === "assignment"
                      ? actor.assignment_id
                      : undefined,
                  ],
                },
              ),
            );
            const effect = timed(context, "command_reduce", () =>
              unwrap(
                reduce(state, actor, params, {
                  clock,
                  ids: tx.ids,
                  ...(tx.unreservedAssignment
                    ? { unreservedAssignment: tx.unreservedAssignment }
                    : {}),
                  ...(tx.platformDeployments
                    ? { platform_deployments: tx.platformDeployments }
                    : {}),
                }),
              ),
            );
            timed(context, "command_persist", () =>
              persistEffect(tx, actor.project_id, effect),
            );
            return effect.data;
          }),
        ).value,
    ),
  );
}

export async function executePreparedCommand<P, Prepared, T>(
  context: ToolContext,
  tool: ToolName,
  key: string,
  params: P,
  prepare: (state: CommandState, actor: Actor, params: P) => Promise<Prepared>,
  reduce: (
    state: CommandState,
    actor: Actor,
    params: P,
    prepared: Prepared,
    ports: CommandPorts,
  ) => Result<CommandEffect<T>>,
  clock?: Clock,
): Promise<T> {
  const {
    store,
    identity: { actor },
  } = context;
  context.revalidateToken?.();
  const needsPreparation = Symbol("needs-preparation");
  // Cache hits/conflicts need no external IO. A miss rolls back an empty transaction.
  try {
    return publicSourceMergeData(
      unwrap(
        timed(context, "prepare_idempotency", () =>
          store.runIdempotent<T>(invocation(context, tool, key, params), () => {
            throw needsPreparation;
          }),
        ),
      ).value,
    );
  } catch (error) {
    if (error !== needsPreparation) throw error;
  }
  const snapshot = timed(context, "prepare_state", () =>
    store.uow.read((tx) =>
      loadCommandState(
        tx,
        actor.project_id,
        context.projectSettings?.(actor.project_id),
        {
          targets: [
            params,
            actor.kind === "assignment" ? actor.assignment_id : undefined,
          ],
        },
      ),
    ),
  );
  const started = performance.now();
  let prepared: Prepared;
  try {
    prepared = await prepare(snapshot, actor, params);
  } finally {
    context.recordTiming?.("prepare_verify", performance.now() - started);
  }
  // Recheck idempotency after the await; the reducer sees a fresh write snapshot.
  return executeCommand(
    context,
    tool,
    key,
    params,
    (state, actor, p, ports) => reduce(state, actor, p, prepared, ports),
    clock,
  );
}
