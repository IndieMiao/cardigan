import type {
  Assignment,
  Card,
  CardId,
  DeliveryVerifier,
  Event,
  ProjectId,
  TimelineEntry,
  ToolName,
  WorkItem,
} from "@cardigan/domain";
import type { McpBackend } from "./backend.js";
import type { DeliveryVerifierFor } from "./commands/delivery-tools.js";

/**
 * Domain-only fixtures for the MCP tests.
 *
 * This helper deliberately depends on nothing but `domain` and the local
 * `McpBackend` port: the concrete `Store` is opened by the test files, which
 * the dependency rules exempt. Production code never imports it.
 */

export const project_id = "p-fictional" as ProjectId;

/**
 * M4.4 moved the "accept everything" stub out of production code: only tests
 * that do not exercise Git may stand in for the real verifier (§3.3).
 */
export const acceptingVerifier: DeliveryVerifier = {
  verify: async () => ({ ok: true, value: [] }),
};
export const acceptingVerifierFor: DeliveryVerifierFor = () =>
  acceptingVerifier;
export const card_id = "C-1" as CardId;
export const NOW = "2026-01-01T00:00:00.000Z";

export const serverCard: Card = {
  id: card_id,
  project_id,
  title: "Fictional card",
  goal: "Exercise the MCP endpoint",
  acceptance_criteria: ["tools answer"],
  source: { kind: "quote", text: "fictional request" },
  out_of_scope: [],
  related_cards: [],
  repo: "example/repo",
  base_branch: "main",
  priority: 1,
  status: "todo",
  template: "dev",
  created_by: "human",
  created_at: NOW,
};

export const workItems: WorkItem = {
  id: "W-1" as never,
  card_id,
  title: "Fictional work item",
  kind: "produce",
  role_id: "coder",
  required: true,
  depends_on: [],
  completion_criteria: [],
  status: "todo",
};

export const assignments: Assignment = {
  id: "A-1" as never,
  scope: "work_item",
  work_item_id: workItems.id,
  role_id: "coder",
  role_version: 1,
  status: "active",
  runtime_state: "not_running" as never,
  machine_id: "local",
  runtime_ref: null,
  mcp_token_id: "tok_coder",
  created_at: NOW,
  worktree_path: "/srv/agent/worktrees/A-1",
  branch: "agent/C-1/W-1",
  base_sha: "abc123",
};

export interface SeedOptions {
  readonly allowed_tools?: readonly ToolName[];
  readonly role_version?: number;
}

export interface SeededRows {
  readonly assignment: Assignment;
  readonly events: readonly Event[];
  readonly timeline: readonly TimelineEntry[];
}

/**
 * Write one project, one card, one work item, one assignment, one role and
 * three events with timeline entries. The caller keeps ownership of the
 * backend (and of the token, which the store issues).
 */
export function seedProject(
  backend: McpBackend,
  options: SeedOptions = {},
): SeededRows {
  const assignment: Assignment = {
    ...assignments,
    role_version: options.role_version ?? 1,
  };
  const events: Event[] = [];
  const timeline: TimelineEntry[] = [];

  backend.uow.run((tx) => {
    tx.cards.put(project_id, serverCard);
    tx.work_items.put(project_id, workItems);
    tx.assignments.put(project_id, assignment);
    tx.roles.put(project_id, {
      role_id: "coder",
      role_version: assignment.role_version,
      allowed_tools: options.allowed_tools ?? [
        "whoami",
        "get_updates",
        "ack_events",
      ],
      capabilities: ["code"],
    });

    for (let i = 1; i <= 3; i += 1) {
      const seq = tx.ids.nextEventSequence(project_id, card_id);
      const event: Event = {
        id: tx.ids.nextEventId(),
        card_id,
        seq,
        type: "comment_added",
        actor: { kind: "system", project_id },
        payload: { note: `fictional ${i}` },
        created_at: NOW,
      };
      tx.events.append(project_id, event);
      events.push(event);

      const entryId = tx.ids.nextTimelineEntryId(project_id, card_id);
      const entry: TimelineEntry = {
        id: entryId,
        short_id: entryId,
        card_id,
        event_seq: seq,
        type: "comment",
        author: "human",
        refs: [],
        retracted: false,
        body: `comment ${i}`,
        mentions: [],
        created_at: NOW,
      };
      tx.timeline.put(project_id, entry);
      timeline.push(entry);
    }
  });

  return { assignment, events, timeline };
}
