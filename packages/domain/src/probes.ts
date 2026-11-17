import {
  attempt,
  CommandDraft,
  type CommandState,
  ensure,
} from "./commands/core.js";
import type { Actor, Assignment, Event } from "./entities.js";
import type { Result } from "./errors.js";
import type { AssignmentId, CardId, WorkItemId } from "./ids.js";

export type ProbeOperation = "smoke" | "status" | "cancel" | "cleanup";
export interface ProbeInput {
  readonly probe: "github" | "config";
  readonly operation: ProbeOperation;
  readonly parameters?: { readonly probe_run_id: string } | undefined;
  readonly idempotency_key: string;
}
export interface ProbeOwner {
  readonly project_id: string;
  readonly card_id: CardId;
  readonly work_item_id: WorkItemId;
  readonly assignment_id: AssignmentId;
}
/** IO belongs to the host; identity always comes from the authenticated actor. */
export function authorizeProbe(
  state: CommandState,
  actor: Actor,
): Result<{
  assignment: Extract<Assignment, { scope: "work_item" }>;
  owner: ProbeOwner;
}> {
  return attempt(() => {
    const d = new CommandDraft(state, actor, "run_probe");
    const a = d.assignment;
    ensure(
      actor.kind === "assignment" &&
        a?.scope === "work_item" &&
        a.status === "active",
      "unauthorized",
      "只有当前产出负责人可以运行探针",
    );
    const item = d.ownWork(a.work_item_id);
    const card = d.card(item.card_id);
    ensure(
      item.kind === "produce" &&
        item.assignment_id === a.id &&
        item.status !== "cancelled" &&
        !["done", "cancelled", "awaiting_merge"].includes(card.status) &&
        a.branch &&
        a.worktree_path,
      "unauthorized",
      "探针目标已失效",
    );
    return {
      assignment: a,
      owner: {
        project_id: state.project_id,
        card_id: card.id,
        work_item_id: item.id,
        assignment_id: a.id,
      } satisfies ProbeOwner,
    };
  });
}

/** Only a host-created attachment for the exact tested revision is evidence. */
export function hasProbeEvidence(
  events: readonly Event[],
  owner: Pick<ProbeOwner, "project_id" | "card_id" | "work_item_id">,
  sha: string,
  attachments: readonly string[],
): boolean {
  return events.some((e) => {
    const p = e.payload as Record<string, unknown>;
    return (
      e.type === "probe_evidence" &&
      e.actor.kind === "system" &&
      e.actor.project_id === owner.project_id &&
      e.card_id === owner.card_id &&
      p.work_item_id === owner.work_item_id &&
      typeof p.tested_sha === "string" &&
      /^[a-f0-9]{40}$/u.test(p.tested_sha) &&
      p.head_sha === sha &&
      p.result === "passed" &&
      p.cleanup === "complete" &&
      p.source === "live" &&
      typeof p.attachment_id === "string" &&
      attachments.includes(p.attachment_id)
    );
  });
}

/** Host IO port and durable execution facts; domain performs no external IO. */
export interface ProbePolicy {
  readonly operations: readonly ProbeOperation[];
  readonly timeout_ms: number;
  readonly executor?: string;
  readonly rest_budget_per_hour: number;
}
export interface ProbeJob extends ProbeOwner {
  readonly id: string;
  readonly probe: "github" | "config";
  readonly head_sha: string;
  readonly created_at: string;
  readonly profile: ProbePolicy;
  readonly status: "queued" | "running" | "passed" | "failed" | "cancelled";
  readonly cleanup: "pending" | "complete" | "held";
  readonly cancel_requested?: boolean;
  readonly tested_sha?: string;
  readonly tree_sha?: string;
  readonly baseline_branch?: string;
  readonly executor_fingerprint?: string;
  readonly process?: { readonly pid: number; readonly start: string };
  readonly sandbox?: { readonly dev: number; readonly ino: number };
  readonly attachment_id?: string;
  readonly checks?: readonly {
    readonly name: string;
    readonly status: string;
  }[];
}
export interface ProbeAdapter {
  /** Bounded step. Ambiguous external effects must remain pending/held. */
  advance(
    job: ProbeJob,
    checkpoint: (job: ProbeJob) => void,
    cancelled?: () => boolean,
  ): Promise<ProbeJob>;
}
