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
import type { McpReadContext } from "../backend.js";
import type { ToolContext } from "../tools/types.js";

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
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
  if (!project_settings && !tx.test_review_trust) return state;
  // Attach live authority AFTER the data cache; revoked/restarted sources must
  // never survive as cached command-state eligibility.
  return {
    ...state,
    ...(project_settings ? { project_settings } : {}),
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
    events: [undefined, ...cards.map((c) => c.id)].flatMap((id) =>
      streams
        ? (streams.get(id ?? "") ?? [])
        : tx.events.listAfter(project_id, id, 0),
    ),
  };
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
  return unwrap(
    store.runIdempotent(invocation(context, tool, key, params), (tx) => {
      context.revalidateToken?.();
      const effect = unwrap(
        reduce(loadCommandState(tx, actor.project_id), actor, params, {
          clock,
          ids: tx.ids,
        }),
      );
      persistEffect(tx, actor.project_id, effect);
      return effect.data;
    }),
  ).value;
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
    return unwrap(
      store.runIdempotent<T>(invocation(context, tool, key, params), () => {
        throw needsPreparation;
      }),
    ).value;
  } catch (error) {
    if (error !== needsPreparation) throw error;
  }
  const snapshot = store.uow.read((tx) =>
    loadCommandState(tx, actor.project_id),
  );
  const prepared = await prepare(snapshot, actor, params);
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
