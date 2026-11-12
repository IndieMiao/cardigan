import type {
  Actor,
  Assignment,
  Card,
  Decision,
  Delivery,
  Event,
  HumanAction,
  Review,
  Run,
  TimelineEntry,
  WorkItem,
} from "@cardigan/domain";
import type { RouterSnapshot } from "./types.js";

/**
 * Minimal fixtures for the M3.1 tests: only the fields the rules read are
 * filled in, and each builder takes overrides, because the router is pure and
 * the tests only assert routing decisions.
 */
export const NOW = "2026-01-01T00:00:00.000Z";
export const project_id = "p-routing" as never;
const CARD_ID = "C-1";

type Overrides<T> = Partial<Record<keyof T, unknown>>;

export const card = (overrides: Overrides<Card> = {}): Card =>
  ({
    id: CARD_ID,
    project_id,
    title: "Routing card",
    source: { kind: "quote", text: "Routing request" } satisfies Card["source"],
    template: "dev",
    status: "in_progress",
    ...overrides,
  }) as unknown as Card;

export const workItem = (
  id: string,
  overrides: Overrides<WorkItem> = {},
): WorkItem =>
  ({
    id,
    card_id: CARD_ID,
    title: id,
    kind: "produce",
    role_id: "coder",
    required: true,
    depends_on: [],
    status: "in_progress",
    ...overrides,
  }) as unknown as WorkItem;

export const assignment = (
  id: string,
  overrides: Overrides<Assignment> = {},
): Assignment =>
  ({
    id,
    scope: "work_item",
    role_id: "coder",
    role_version: 1,
    status: "active",
    ...overrides,
  }) as unknown as Assignment;

export const delivery = (
  id: string,
  overrides: Overrides<Delivery> = {},
): Delivery =>
  ({
    id,
    work_item_id: "W-1",
    kind: "code",
    status: "submitted",
    requested_verifiers: [],
    ...overrides,
  }) as unknown as Delivery;

export const review = (
  verdict: Review["verdict"],
  delivery_id = "D-1",
  overrides: Overrides<Review> = {},
): Review =>
  ({
    id: "V-1",
    delivery_id,
    verdict,
    work_item_id: "W-2",
    ...overrides,
  }) as unknown as Review;

export const decision = (overrides: Overrides<Decision> = {}): Decision =>
  ({
    id: "Q-1",
    card_id: CARD_ID,
    decider: "human",
    question: "Which shape?",
    affected_work_items: ["W-1"],
    ...overrides,
  }) as unknown as Decision;

export const humanAction = (id = "H-1"): HumanAction =>
  ({
    id,
    card_id: CARD_ID,
    instructions: "Connect the device",
  }) as unknown as HumanAction;

export const run = (id: string, overrides: Overrides<Run> = {}): Run =>
  ({
    id,
    assignment_id: "A-1",
    trigger_event_id: "E-0",
    kind: "initial",
    status: "completed",
    role_version: 1,
    model: "fixture-model",
    agent_cli_version: "fixture-cli",
    outcome: "completed",
    summary: "finished",
    ...overrides,
  }) as unknown as Run;

export const entry = (
  seq: number,
  overrides: Overrides<TimelineEntry> = {},
): TimelineEntry =>
  ({
    id: `T-${seq}`,
    card_id: CARD_ID,
    type: "comment",
    author: "human",
    mentions: [],
    event_seq: seq,
    ...overrides,
  }) as unknown as TimelineEntry;

/** The human actor, or an Assignment acting through its token. */
export const human = (): Actor => ({ kind: "human", project_id });
export const agent = (assignment_id: string): Actor =>
  ({
    kind: "assignment",
    project_id,
    assignment_id,
    role_id: "coder",
    role_version: 1,
  }) as unknown as Actor;

export const event = (
  type: string,
  payload: Record<string, unknown> = {},
  options: { seq?: number; actor?: Actor; card?: boolean } = {},
): Event =>
  ({
    id: `E-${options.seq ?? 1}`,
    ...(options.card === false ? {} : { card_id: CARD_ID }),
    seq: options.seq ?? 1,
    type,
    actor: options.actor ?? human(),
    payload,
  }) as unknown as Event;

export const snapshot = (
  overrides: Overrides<RouterSnapshot> = {},
): RouterSnapshot =>
  ({
    project_id,
    cards: [card()],
    work_items: [
      workItem("W-1", { assignment_id: "A-1" }),
      workItem("W-2", {
        kind: "verify",
        role_id: "reviewer",
        assignment_id: "A-2",
      }),
    ],
    assignments: [
      assignment("A-1", { work_item_id: "W-1" }),
      assignment("A-2", { role_id: "reviewer", work_item_id: "W-2" }),
      assignment("A-3", { scope: "standing", role_id: "pm" }),
    ],
    deliveries: [],
    reviews: [],
    decisions: [],
    human_actions: [],
    runs: [],
    timeline: [],
    events: [],
    ...overrides,
  }) as unknown as RouterSnapshot;
