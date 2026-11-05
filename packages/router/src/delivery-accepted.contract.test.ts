/**
 * §4.4: a delivery nothing verifies is accepted at arrival, and the router must
 * treat that as the work item completing (M5.5 appendix A step 2 needs the
 * downstream bell).
 *
 * Unlike the unit tests next door, this one starts from the real commands:
 * `createCard`, `createWorkItem`, `assign` and `submitDelivery` produce the
 * event, and the router sees exactly the state those commands left behind.
 */
import type {
  Actor,
  CommandPorts,
  CommandState,
  RoleReference,
  WorkItem,
} from "@cardigan/domain";
import {
  assign,
  createCard,
  createWorkItem,
  type DeliveryVerifier,
  formatId,
  formatTimelineEntryId,
  parseEventId,
  prepareDelivery,
  submitDelivery,
  toolNames,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import { routeEvent } from "./route.js";
import type { RouterSnapshot } from "./types.js";

const now = "2026-01-01T00:00:00.000Z";
const project = "p-router-accepted" as never;

function role(role_id: string): RoleReference {
  return {
    role_id,
    role_version: 1,
    allowed_tools: [...toolNames],
    capabilities: [role_id],
  };
}

function actor(assignment_id: string, role_id: string): Actor {
  return {
    kind: "assignment",
    project_id: project,
    assignment_id: assignment_id as never,
    role_id,
    role_version: 1,
    allowed_tools: [...toolNames],
    capabilities: [role_id],
  };
}

function ports(): CommandPorts {
  let n = 100;
  const sequences = new Map<string, number>();
  const id = (kind: Parameters<CommandPorts["ids"]["next"]>[1]) => {
    const formatted = formatId(kind, ++n);
    if (!formatted.ok) throw new Error(formatted.error.message);
    return formatted.value;
  };
  return {
    clock: { now: () => now },
    ids: {
      next: (_project, kind) => id(kind),
      nextTimelineEntryId: (_project, card) => {
        const formatted = formatTimelineEntryId(card, ++n);
        if (!formatted.ok) throw new Error(formatted.error.message);
        return formatted.value;
      },
      nextEventId: () => {
        const parsed = parseEventId(String(++n).padStart(26, "0"));
        if (!parsed.ok) throw new Error(parsed.error.message);
        return parsed.value;
      },
      nextEventSequence: (_project, card) => {
        const key = card ?? "project";
        const next = (sequences.get(key) ?? 0) + 1;
        sequences.set(key, next);
        return next;
      },
      nextAttachmentId: () => `F-${++n}` as never,
    },
  };
}

function emptyState(): CommandState {
  return {
    project_id: project,
    roles: [role("coder"), role("pm"), role("reviewer")],
    cards: [],
    work_items: [],
    // The PM Office does the creating; every other Assignment is created by
    // `assign` inside the test.
    assignments: [
      {
        id: "A-9" as never,
        scope: "standing",
        role_id: "pm",
        role_version: 1,
        status: "active",
        runtime_state: "idle",
        machine_id: "local",
        runtime_ref: null,
        mcp_token_id: "pm-office",
        created_at: now,
        standing_mode: "office",
      },
    ],
    runs: [],
    deliveries: [],
    reviews: [],
    decisions: [],
    human_actions: [],
    attachments: [],
    cursors: [],
    timeline: [],
    events: [],
  };
}

function applied(
  state: CommandState,
  effect: {
    changes: readonly { collection: string; entity: unknown }[];
    events: CommandState["events"];
    timeline: CommandState["timeline"];
  },
): CommandState {
  const next: CommandState = {
    ...state,
    events: [...state.events, ...effect.events],
    timeline: [...state.timeline, ...effect.timeline],
  } as CommandState;
  for (const change of effect.changes) {
    const key = (entity: unknown) =>
      "id" in (entity as object)
        ? (entity as { id: string }).id
        : `${(entity as { assignment_id: string }).assignment_id}/${(entity as { card_id: string }).card_id}`;
    const collection = change.collection as keyof CommandState;
    const current = next[collection] as readonly unknown[];
    (next as unknown as Record<string, unknown>)[collection] = [
      ...current.filter((entry) => key(entry) !== key(change.entity)),
      change.entity,
    ];
  }
  return next;
}

const accepting: DeliveryVerifier = {
  verify: async () => ({ ok: true, value: [] }),
};

/**
 * A card from the template, an unreviewed product confirmation created the way
 * PM creates one, and a downstream item that depends on it.
 */
async function cardWithUnreviewedProduct(options: {
  readonly dependentAssigned: boolean;
}) {
  const io = ports();
  const office = actor("A-9", "pm");
  let state = emptyState();
  const step = <T>(result: {
    readonly ok: boolean;
    readonly value?: { readonly data: T };
    readonly error?: { readonly message: string };
  }): { readonly data: T } => {
    if (result.ok !== true || result.value === undefined) {
      throw new Error(result.error?.message ?? "command failed");
    }
    state = applied(state, result.value as never);
    return result.value;
  };

  step(
    createCard(
      state,
      office,
      {
        title: "Appendix A start",
        goal: "Ship",
        acceptance_criteria: ["Pass"],
        source: { kind: "quote", text: "Ship" },
        repo: "example/repo",
        base_branch: "main",
      },
      io,
    ),
  );
  const card = state.cards[0];
  if (card === undefined) throw new Error("card was not created");

  const productItem = step(
    createWorkItem(
      state,
      office,
      {
        card_id: card.id,
        title: "产品确认",
        kind: "produce",
        role_id: "pm",
        required: true,
        completion_criteria: ["Confirmed"],
      },
      io,
    ),
  ).data;

  const downstream = step(
    createWorkItem(
      state,
      office,
      {
        card_id: card.id,
        title: "Write the release notes",
        kind: "produce",
        role_id: "coder",
        required: true,
        completion_criteria: ["Notes written"],
        depends_on: [productItem.id],
      },
      io,
    ),
  ).data;

  const assignment = step(
    assign(state, office, { work_item_id: productItem.id, role_id: "pm" }, io),
  ).data;
  state = {
    ...state,
    runs: [
      {
        id: io.ids.next(project, "run"),
        assignment_id: assignment.id,
        trigger_event_id: io.ids.nextEventId(),
        kind: "initial",
        status: "running",
        role_version: 1,
        model: "fixture-model",
        agent_cli_version: "1.0",
        outcome: null,
        summary: "",
      },
    ],
  };
  void options;
  return { state, io, card, productItem, assignment, downstream };
}

test("§4.4: the command's delivery_accepted event wakes the downstream Assignment", async () => {
  const setup = await cardWithUnreviewedProduct({ dependentAssigned: true });
  const caller = actor(setup.assignment.id, "pm");
  const params = {
    work_item_id: setup.productItem.id,
    kind: "doc" as const,
    summary: "需求已确认",
    subject: { kind: "doc_version" as const, value: "product-v1" },
    requested_verifiers: [],
  };
  const prepared = await prepareDelivery(
    setup.state,
    caller,
    params,
    accepting,
  );
  if (!prepared.ok) throw new Error(prepared.error.message);
  const effect = submitDelivery(
    setup.state,
    caller,
    params,
    prepared.value,
    setup.io,
  );
  if (!effect.ok) throw new Error(effect.error.message);

  const accepted = effect.value.events.find(
    (entry) => entry.type === "delivery_accepted",
  );
  expect(accepted).toBeDefined();
  const state = applied(setup.state, effect.value as never);
  expect(
    state.deliveries.find((entry) => entry.id === effect.value.data.id)?.status,
  ).toBe("accepted");
  expect(
    state.work_items.find((entry) => entry.id === setup.productItem.id)?.status,
  ).toBe("accepted");

  // The downstream item is owned by an active Assignment, so it is belled.
  expect(
    state.work_items.find((entry) => entry.id === setup.downstream.id)?.status,
  ).toBe("todo");
  const withOwner: CommandState = {
    ...state,
    work_items: state.work_items.map((entry: WorkItem) =>
      entry.id === setup.downstream.id
        ? { ...entry, assignment_id: "A-2" as never }
        : entry,
    ),
    assignments: [
      ...state.assignments,
      {
        id: "A-2" as never,
        scope: "work_item",
        work_item_id: setup.downstream.id,
        role_id: "coder",
        role_version: 1,
        status: "active",
        runtime_state: "idle",
        machine_id: "local",
        runtime_ref: null,
        mcp_token_id: "token-A-2",
        created_at: now,
      },
    ],
  };
  const routed = routeEvent({
    event: accepted as never,
    snapshot: withOwner as unknown as RouterSnapshot,
  });
  expect(routed.notifications.map((entry) => entry.rule)).toContain(
    "6.4/dependency completed",
  );
  expect(
    routed.notifications.some(
      (entry) =>
        entry.recipient.kind === "assignment" &&
        entry.recipient.assignment_id === "A-2",
    ),
  ).toBe(true);
});

test("§4.4: an unowned downstream item reaches PM Ops, not silence", async () => {
  const setup = await cardWithUnreviewedProduct({ dependentAssigned: false });
  const caller = actor(setup.assignment.id, "pm");
  const params = {
    work_item_id: setup.productItem.id,
    kind: "doc" as const,
    summary: "需求已确认",
    subject: { kind: "doc_version" as const, value: "product-v1" },
    requested_verifiers: [],
  };
  const prepared = await prepareDelivery(
    setup.state,
    caller,
    params,
    accepting,
  );
  if (!prepared.ok) throw new Error(prepared.error.message);
  const effect = submitDelivery(
    setup.state,
    caller,
    params,
    prepared.value,
    setup.io,
  );
  if (!effect.ok) throw new Error(effect.error.message);
  const accepted = effect.value.events.find(
    (entry) => entry.type === "delivery_accepted",
  );
  if (accepted === undefined) throw new Error("no delivery_accepted event");

  // Nobody owns the downstream verification: the plan hands it to PM Ops.
  const routed = routeEvent({
    event: accepted,
    snapshot: applied(
      setup.state,
      effect.value as never,
    ) as unknown as RouterSnapshot,
  });
  expect(routed.notifications.map((entry) => entry.rule)).toContain(
    "6.4/dependency completed",
  );
  expect(routed.notifications[0]?.recipient.kind).toBe("pm_ops");
});
