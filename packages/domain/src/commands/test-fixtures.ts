import type {
  Actor,
  Assignment,
  Card,
  Machine,
  RoleReference,
  Run,
  WorkItem,
} from "../entities.js";
import { toolNames } from "../entities.js";
import type { Result } from "../errors.js";
import {
  type FormattedIdKind,
  formatId,
  formatTimelineEntryId,
  parseEventId,
} from "../ids.js";
import type { MachinePlacement } from "../machine-placement.js";
import type { CommandEffect, CommandPorts, CommandState } from "./core.js";

export function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
export const id = <K extends FormattedIdKind>(kind: K, n: number) =>
  value(formatId(kind, n));
export const now = "2026-01-01T00:00:00.000Z";
/** Synthetic trusted registry row for fixtures that exercise successful assignment. */
export const machine = (): Machine => ({
  id: "local",
  label: "local",
  herdr_machine: "local",
  os: "linux",
  arch: "x64",
  tags: [],
  max_assignments: 4,
  status: "online",
  last_seen: now,
});
export const placement = (
  entries: readonly (readonly [string, MachinePlacement])[] = [],
) => ({ harness: "codex" as const, machines: new Map(entries) });
export const subject = { kind: "git_head" as const, value: "a".repeat(40) };
export const human: Actor = { kind: "human", project_id: "fixture-project" };
export const role = (role_id: string): RoleReference => ({
  role_id,
  role_version: 1,
  allowed_tools: [...toolNames],
  capabilities: [role_id],
});
export function actor(n = 1, role_id = "coder"): Actor {
  return {
    kind: "assignment",
    project_id: human.project_id,
    assignment_id: id("assignment", n),
    ...role(role_id),
  };
}
export function card(n = 1): Card {
  return {
    id: id("card", n),
    project_id: human.project_id,
    title: "Example",
    goal: "Ship",
    acceptance_criteria: ["passes"],
    source: { kind: "quote", text: "Ship" },
    out_of_scope: [],
    related_cards: [],
    repo: "example/repo",
    base_branch: "main",
    priority: 1,
    status: "in_progress",
    template: "dev",
    created_by: "human",
    created_at: now,
  };
}
export function assignment(
  n = 1,
  role_id = "coder",
): Extract<Assignment, { scope: "work_item" }> {
  return {
    id: id("assignment", n),
    scope: "work_item",
    work_item_id: id("work_item", n),
    role_id,
    role_version: 1,
    status: "active",
    runtime_state: "idle",
    machine_id: "local",
    runtime_ref: null,
    session_ref: "fixture-session",
    mcp_token_id: `token-reference-${n}`,
    created_at: now,
  };
}
export function run(n = 1, assignmentNumber = n): Run {
  return {
    id: id("run", n),
    assignment_id: id("assignment", assignmentNumber),
    trigger_event_id: value(parseEventId(`${"0".repeat(25)}1`)),
    kind: "initial",
    status: "running",
    role_version: 1,
    model: "fixture-model",
    agent_cli_version: "1.0",
    outcome: null,
    summary: "",
  };
}
export function fixture(): CommandState {
  const common = {
    card_id: id("card", 1),
    required: true,
    depends_on: [],
    completion_criteria: ["passes"],
  };
  const items: WorkItem[] = [
    {
      ...common,
      id: id("work_item", 1),
      title: "Build",
      kind: "produce",
      role_id: "coder",
      status: "in_progress",
      assignment_id: id("assignment", 1),
      template_key: "development",
    },
    {
      ...common,
      id: id("work_item", 2),
      title: "Review",
      kind: "verify",
      role_id: "reviewer",
      status: "ready",
      assignment_id: id("assignment", 2),
      target_work_item_id: id("work_item", 1),
      max_review_rounds: 3,
      template_key: "code_review",
    },
    {
      ...common,
      id: id("work_item", 3),
      title: "Accept",
      kind: "verify",
      role_id: "pm",
      status: "ready",
      assignment_id: id("assignment", 3),
      max_review_rounds: 3,
      template_key: "pm_acceptance",
    },
  ];
  const { work_item_id: _unused, ...base } = assignment(4, "pm");
  const standing: Assignment = { ...base, scope: "standing" };
  return {
    project_id: human.project_id,
    machines: [machine()],
    roles: [role("coder"), role("reviewer"), role("pm")],
    cards: [card(), card(2)],
    work_items: items,
    assignments: [
      assignment(),
      assignment(2, "reviewer"),
      assignment(3, "pm"),
      standing,
    ],
    runs: [run(1), run(2), run(3)],
    deliveries: [],
    reviews: [],
    decisions: [],
    human_actions: [],
    attachments: [],
    cursors: [],
    events: [],
    timeline: [],
  };
}
export function ports(): CommandPorts {
  let n = 100;
  const seq = new Map<string, number>();
  return {
    clock: { now: () => now },
    ids: {
      next: (_project, kind) => id(kind, ++n),
      nextTimelineEntryId: (_project, card) =>
        value(formatTimelineEntryId(card, ++n)),
      nextEventId: () => value(parseEventId(String(++n).padStart(26, "0"))),
      nextEventSequence: (_project, card) => {
        const key = card ?? "project";
        const next = (seq.get(key) ?? 0) + 1;
        seq.set(key, next);
        return next;
      },
      nextAttachmentId: () => `attachment-${++n}`,
    },
  };
}
export function apply(
  state: CommandState,
  effect: CommandEffect<unknown>,
): CommandState {
  const next = {
    ...state,
    events: [...state.events, ...effect.events],
    timeline: [...state.timeline, ...effect.timeline],
  };
  for (const { collection, entity } of effect.changes) {
    const key = (e: typeof entity) =>
      "version" in e
        ? `${e.id}@${e.version}`
        : "id" in e
          ? e.id
          : `${e.assignment_id}/${e.card_id}`;
    Object.assign(next, {
      [collection]: [
        ...(next[collection] ?? []).filter((e) => key(e) !== key(entity)),
        entity,
      ],
    });
  }
  return next;
}

/**
 * C-610: fields that keep a flow-5 rejection blocking under review
 * convergence — a basis (the checklist once one exists) and a checklist.
 */
export function convergent(state: CommandState, workItemId: string) {
  const reviews = state.reviews
    .filter((r) => r.work_item_id === workItemId)
    .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)));
  const end = reviews.findIndex((r) => r.verdict !== "reject");
  const streak = end === -1 ? reviews : reviews.slice(0, end);
  return {
    basis: streak.slice(0, -1).some((r) => r.pass_conditions?.length)
      ? "PC1"
      : "AC1",
    pass_conditions: [
      { description: "The required check passes", basis: "AC1" },
    ],
  };
}
