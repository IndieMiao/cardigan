import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Attachment,
  Card,
  CardId,
  Decision,
  HumanAction,
  ProjectId,
  TimelineEntry,
  WorkItem,
} from "@cardigan/domain";
import type { Store } from "@cardigan/store";

/**
 * Fixtures for the Workbench read API tests.
 *
 * They write one project with three cards, so the two list filters can be told
 * apart: `C-1` waits on the human (a blocking decision), `C-2` waits on an
 * Agent (an assigned, in-progress work item) and `C-3` is done. Events and
 * timeline entries carry different actor roles and types so the activity
 * filters have something to separate.
 */

export const project_id = "p-web" as ProjectId;
export const NOW = "2026-01-01T00:00:00.000Z";

const card = (id: string, overrides: Partial<Card> = {}): Card => ({
  id: id as CardId,
  project_id,
  title: `Card ${id}`,
  goal: `Goal of ${id}`,
  acceptance_criteria: ["tests pass"],
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
  ...overrides,
});

const workItem = (
  id: string,
  card_id: string,
  overrides: Partial<WorkItem> = {},
) =>
  ({
    id,
    card_id,
    title: `Work item ${id}`,
    kind: "produce",
    role_id: "coder",
    required: true,
    depends_on: [],
    completion_criteria: [],
    status: "todo",
    ...overrides,
  }) as WorkItem;

const decision: Decision = {
  id: "D-1" as Decision["id"],
  key: "D-1" as Decision["id"],
  card_id: "C-1" as CardId,
  raised_by: "assignment:A-9",
  category: "general",
  question: "Ship the release branch without the smoke test?",
  context: "The smoke test needs a real Herdr core.",
  options: [
    { key: "ship", description: "Ship now", impact: "Smoke test later" },
    { key: "wait", description: "Wait", impact: "One more day" },
  ],
  recommended: "wait",
  affected_cards: [],
  affected_work_items: [],
  blocking: true,
  decider: "human",
  doc_refs: [],
  status: "open",
  kind: "choose",
};

// A project-level human action: it shows up in Needs You without making any
// card "needs me", which keeps the two list filters distinguishable.
const humanAction: HumanAction = {
  id: "H-1" as HumanAction["id"],
  key: "H-1" as HumanAction["id"],
  requested_by: "assignment:A-1",
  instructions: "Run the migration on the laptop.",
  why_human: "Only you have the database password.",
  expected_return: "The migration output.",
  blocked_work_items: [],
  status: "open",
};

export interface Seeded {
  readonly project_id: ProjectId;
  readonly attachment: Attachment;
  readonly attachment_content: string;
  readonly htmlAttachment: Attachment;
  readonly html_content: string;
  readonly svgAttachment: Attachment;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Store a blob the way the MCP upload path does: `<dataDir>/attachments/<sha256>`. */
function storeBlob(dataDir: string, content: string): string {
  const digest = sha256(content);
  mkdirSync(join(dataDir, "attachments"), { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, "attachments", digest), content, { mode: 0o600 });
  return digest;
}

export function seedWebProject(store: Store, dataDir: string): Seeded {
  store.createProject({ id: project_id, name: "Fixture project" });
  const pngContent = "fictional-png-bytes";
  const htmlContent = "<html><script>alert(1)</script></html>";
  const svgContent =
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  const pngDigest = storeBlob(dataDir, pngContent);
  const htmlDigest = storeBlob(dataDir, htmlContent);
  const svgDigest = storeBlob(dataDir, svgContent);

  const png: Attachment = {
    id: "F-1" as Attachment["id"],
    sha256: pngDigest,
    mime: "image/png",
    size: pngContent.length,
    card_id: "C-1" as CardId,
    uploaded_by: "assignment:A-1",
    storage_path: `attachments/${pngDigest}`,
    attach_to: { kind: "timeline_entry", id: "C-1#1" as TimelineEntry["id"] },
    kind: "evidence",
  };
  const html: Attachment = {
    id: "F-2" as Attachment["id"],
    sha256: htmlDigest,
    mime: "text/html",
    size: htmlContent.length,
    card_id: "C-1" as CardId,
    uploaded_by: "assignment:A-1",
    storage_path: `attachments/${htmlDigest}`,
    attach_to: { kind: "timeline_entry", id: "C-1#1" as TimelineEntry["id"] },
    kind: "artifact",
    basis: "D-1" as Decision["id"],
  };

  const svg: Attachment = {
    id: "F-3" as Attachment["id"],
    sha256: svgDigest,
    mime: "image/svg+xml",
    size: svgContent.length,
    card_id: "C-1" as CardId,
    uploaded_by: "assignment:A-1",
    storage_path: `attachments/${svgDigest}`,
    attach_to: { kind: "timeline_entry", id: "C-1#1" as TimelineEntry["id"] },
    kind: "evidence",
  };

  store.uow.run((tx) => {
    tx.cards.put(
      project_id,
      card("C-1", { title: "Prepare the release", status: "in_progress" }),
    );
    tx.cards.put(project_id, card("C-2", { status: "in_progress" }));
    tx.cards.put(
      project_id,
      card("C-3", {
        status: "done",
        resolution: "done",
        related_cards: ["C-1" as CardId],
      }),
    );
    tx.work_items.put(
      project_id,
      workItem("W-1", "C-1", { status: "waiting_decision" }),
    );
    tx.work_items.put(
      project_id,
      workItem("W-2", "C-2", {
        status: "in_progress",
        assignment_id: "A-1" as never,
      }),
    );
    tx.assignments.put(project_id, {
      id: "A-1" as never,
      scope: "work_item",
      work_item_id: "W-2" as WorkItem["id"],
      role_id: "coder",
      role_version: 1,
      status: "active",
      runtime_state: "running" as never,
      machine_id: "local" as never,
      runtime_ref: null,
      mcp_token_id: "tok_coder",
      created_at: NOW,
      worktree_path: "/srv/agent/worktrees/A-1",
      branch: "agent/C-2/W-2",
      base_sha: "abc123",
    });
    tx.roles.put(project_id, {
      role_id: "coder",
      role_version: 1,
      allowed_tools: ["whoami"],
      capabilities: ["code"],
    });
    tx.decisions.put(project_id, decision);
    tx.human_actions.put(project_id, humanAction);
    tx.attachments.put(project_id, png);
    tx.attachments.put(project_id, html);
    tx.attachments.put(project_id, svg);

    const run = {
      id: "R-1" as never,
      assignment_id: "A-1" as never,
      trigger_event_id: "evt-1" as never,
      kind: "initial" as const,
      status: "running" as const,
      role_version: 1,
      model: "fixture-model",
      agent_cli_version: "1.0.0",
      started_at: NOW,
      outcome: null,
      summary: "",
    };
    tx.runs.put(project_id, run);
    tx.cursors.put(project_id, {
      assignment_id: "A-1" as never,
      card_id: "C-2" as CardId,
      acked_seq: 1,
    });

    // Events and the timeline entries they carry, with different actors/types.
    const append = (
      card_id: CardId | undefined,
      type: string,
      actor: { kind: "human" } | { kind: "assignment"; role_id: string },
      body: string,
      extra: Partial<TimelineEntry> = {},
    ) => {
      const seq = tx.ids.nextEventSequence(project_id, card_id);
      const event = {
        id: tx.ids.nextEventId(),
        ...(card_id === undefined ? {} : { card_id }),
        seq,
        type,
        actor:
          actor.kind === "human"
            ? { kind: "human" as const, project_id }
            : {
                kind: "assignment" as const,
                project_id,
                assignment_id: "A-1" as never,
                role_id: actor.role_id,
                role_version: 1,
                allowed_tools: [],
                capabilities: [],
              },
        payload: {},
        created_at: NOW,
      };
      tx.events.append(project_id, event);
      // Project-level events have no card and therefore no timeline entry.
      if (card_id === undefined) return;
      const entryId = tx.ids.nextTimelineEntryId(project_id, card_id);
      tx.timeline.put(project_id, {
        id: entryId,
        short_id: entryId,
        card_id,
        event_seq: seq,
        type: type === "comment_added" ? "comment" : "decision",
        author: actor.kind === "human" ? "human" : "assignment:A-1",
        refs: [],
        retracted: false,
        body,
        mentions: [],
        created_at: NOW,
        ...(type === "decision_requested"
          ? { decision_id: "D-1" as never }
          : {}),
        ...(type === "human_action_requested"
          ? { human_action_id: "H-1" as never }
          : {}),
        ...extra,
      });
    };
    append(
      "C-1" as CardId,
      "decision_requested",
      { kind: "assignment", role_id: "pm" },
      "D-1 asked",
    );
    append("C-1" as CardId, "comment_added", { kind: "human" }, "looks fine");
    append(
      "C-2" as CardId,
      "human_action_requested",
      { kind: "assignment", role_id: "pm" },
      "H-1 asked",
    );
    append(undefined, "project_created", { kind: "human" }, "project opened");
  });

  return {
    project_id,
    attachment: png,
    attachment_content: pngContent,
    htmlAttachment: html,
    html_content: htmlContent,
    svgAttachment: svg,
  };
}
