import type { DecisionId, DeliveryId } from "./ids.js";

export interface RoleRuleChange {
  readonly id: string;
  readonly path: string;
  readonly old_mode: string;
  readonly new_mode: string;
  readonly old_oid: string;
  readonly new_oid: string;
  readonly status: string;
  readonly category: "ordinary" | "body" | "forbidden" | "unknown";
  readonly edits: readonly {
    readonly id: string;
    readonly before: string;
    readonly after: string;
  }[];
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
  readonly inventories: readonly {
    readonly delivery_id: DeliveryId;
    readonly base_sha: string;
    readonly sha: string;
    readonly tree_sha: string;
  }[];
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
