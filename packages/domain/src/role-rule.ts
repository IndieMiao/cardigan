import type { DecisionId, DeliveryId } from "./ids.js";

/**
 * Positive grammar for the currently supported non-authority body instructions.
 * Absence of a sensitive word is never proof that arbitrary prose is safe.
 * Both sides must be complete language instructions, without qualifiers or code.
 */
export function supportedRoleBodyEdit(
  path: string,
  before: string,
  after: string,
): boolean {
  if (path !== "AGENTS.md" && path !== "packages/roles/src/role-pack.ts")
    return false;
  const lines = (text: string): string[] => {
    const rows = text.trimEnd().split("\n");
    if (path === "AGENTS.md") return rows;
    return rows.map((line) => {
      if (!/^\s*"(?:[^"\\]|\\.)*",?\s*$/u.test(line)) throw new Error("syntax");
      const decoded: unknown = JSON.parse(line.trim().replace(/,$/u, ""));
      if (typeof decoded !== "string") throw new Error("literal");
      return decoded;
    });
  };
  const languageInstruction =
    /^(?:日志|说明|讨论|注释|报告)(?:和(?:日志|说明|讨论|注释|报告))*使用(?:中文|英文)。$/u;
  try {
    return [before, after].every((text) =>
      lines(text).every((line) => languageInstruction.test(line)),
    );
  } catch {
    return false;
  }
}

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
