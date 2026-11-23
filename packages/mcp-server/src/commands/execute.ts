import type {
  Actor,
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
import type { McpBackend, McpReadContext } from "../backend.js";
import { publicSourceMergeData } from "../source-merge-public.js";
import type { ToolContext } from "../tools/types.js";

const histories = new WeakMap<
  ReadonlyMap<string, readonly Event[]>,
  { cards: readonly string[]; events: readonly Event[] }
>();

/** Entity-only revisions do not change immutable event history or its indexes. */
function eventHistory(
  streams: ReadonlyMap<string, readonly Event[]>,
  cards: readonly { id: string }[],
) {
  const cached = histories.get(streams);
  if (
    cached?.cards.length === cards.length &&
    cached.cards.every((id, i) => id === cards[i]?.id)
  )
    return cached.events;
  const events = ["", ...cards.map((c) => c.id)].flatMap(
    (id) => streams.get(id) ?? [],
  );
  histories.set(streams, { cards: cards.map((c) => c.id), events });
  return events;
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
): CommandState {
  // Resolve the transaction's event history even on a state cache hit. A
  // backend without this bulk port keeps the original per-stream read path.
  const streams = tx.events.listStreams?.(project_id);
  const build = () => readCommandState(tx, project_id, streams);
  const state =
    (streams && tx.cachedCommandState?.(project_id, build)) || build();
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

function readCommandState(
  tx: McpReadContext,
  project_id: ProjectId,
  streams: ReadonlyMap<string, readonly Event[]> | undefined,
): CommandState {
  const cards = tx.cards.list(project_id);
  // Store reads only newly appended rows. Keep the original project/card/seq
  // order, including filtering out streams whose card is absent from this snapshot.
  return {
    project_id,
    project_preferences: tx.project_preferences?.list(project_id) ?? [],
    card_templates: tx.card_templates?.list(project_id) ?? [],
    employees: tx.employees?.list() ?? [],
    members: tx.members?.list() ?? [],
    employee_activity: tx.employees?.assignmentActivity?.() ?? [],
    machines: tx.machines.list(project_id),
    cards,
    work_items: tx.work_items.list(project_id),
    assignments: tx.assignments.list(project_id),
    runs: tx.runs.list(project_id),
    deliveries: tx.deliveries.list(project_id),
    reviews: tx.reviews.list(project_id),
    decisions: tx.decisions.list(project_id),
    human_actions: tx.human_actions.list(project_id),
    attachments: tx.attachments.list(project_id),
    roles: tx.roles.list(project_id),
    cursors: tx.cursors.list(project_id),
    timeline: tx.timeline.list(project_id),
    events: streams
      ? eventHistory(streams, cards)
      : [undefined, ...cards.map((c) => c.id)].flatMap((id) =>
          tx.events.listAfter(project_id, id, 0),
        ),
  };
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
