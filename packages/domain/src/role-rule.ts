import type { Delivery, Decision } from "./entities.js";
import type { DeliveryId, DecisionId } from "./ids.js";

export interface RoleRuleChange {
  readonly id: string;
  readonly path: string;
  readonly old_mode: string;
  readonly new_mode: string;
  readonly old_oid: string;
  readonly new_oid: string;
  readonly status: string;
  readonly category: "ordinary" | "body" | "forbidden" | "unknown";
  readonly edits: readonly { readonly id: string; readonly before: string; readonly after: string }[];
}
export interface RoleRuleInventory {
  readonly version: 1;
  readonly base_sha: string;
  readonly sha: string;
  readonly tree_sha: string;
  readonly complete: boolean;
  readonly changes: readonly RoleRuleChange[];
}
export interface RoleRuleBasis {
  readonly completion_id: DeliveryId;
  readonly inventories: readonly { readonly delivery_id: DeliveryId; readonly base_sha: string; readonly sha: string; readonly tree_sha: string }[];
  readonly mappings: readonly {
    readonly delivery_id: DeliveryId;
    readonly edit_id: string;
    readonly category: "body";
    readonly decision_id: DecisionId;
    /** Exact fragment of the human's audited answer, with the semantic mapping explained. */
    readonly quote: string;
    readonly explanation: string;
  }[];
}
/** Evidence is supplied only by the host's DeliveryVerifier, never submit_delivery input. */
export function roleRuleInventory(v: Delivery): RoleRuleInventory | undefined {
  const e = v.evidence.find(e => e.kind === "diff" && e.details && typeof e.details === "object" && !Array.isArray(e.details) && "role_rule_inventory" in e.details);
  return e ? (e.details as unknown as {role_rule_inventory: RoleRuleInventory}).role_rule_inventory : undefined;
}
export function humanRuleDecision(q: Decision): boolean {
  return q.status === "resolved" && q.trigger === undefined &&
    q.resolution?.resolved_by === "human" && q.resolution.via === "needs_you" &&
    q.resolution.via_chain.length === 1 && q.resolution.via_chain[0] === "human" &&
    q.options.some(o => o.key === q.resolution?.option);
}
