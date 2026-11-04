import type {
  Actor,
  Clock,
  CommandEffect,
  CommandPorts,
  CommandState,
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
): CommandState {
  const cards = tx.cards.list(project_id);
  return {
    project_id,
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
      tx.events.listAfter(project_id, id, 0),
    ),
  };
}

function persist(
  tx: TransactionContext,
  project: ProjectId,
  effect: CommandEffect<unknown>,
) {
  // Assignment issuance is added with M1.6b; never silently drop an intent.
  if (effect.token_requests.length)
    throw new Error("Token issuance is not wired yet");
  for (const change of effect.changes) {
    // EntityChange preserves the collection/entity correlation across this union.
    const repository = tx[change.collection] as Pick<
      Repository<typeof change.entity, never>,
      "put"
    >;
    repository.put(project, change.entity);
  }
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
      persist(tx, actor.project_id, effect);
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
