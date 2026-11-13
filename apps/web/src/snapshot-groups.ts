import type { CardView } from "./api.js";

export const SNAPSHOT_GROUPS = [
  { value: "human", label: "等你处理" },
  { value: "agent", label: "等 Agent 处理" },
  { value: "progress", label: "进行中" },
  { value: "review", label: "审核与待合并" },
  { value: "blocked", label: "阻塞" },
] as const;

/** Match the existing snapshot read model; these groups may overlap. */
export function inSnapshotGroup(
  card: Pick<CardView, "status" | "next_owners" | "waiting_on">,
  group: string,
): boolean {
  switch (group) {
    case "human":
      return (
        card.next_owners.some((o) => o.kind === "human") ||
        card.waiting_on.some(
          (w) => w.kind === "decision" || w.kind === "human_action",
        )
      );
    case "agent":
      return card.next_owners.some(
        (o) => o.kind === "role" || o.kind === "assignment",
      );
    case "progress":
      return card.status === "in_progress";
    case "review":
      return card.status === "review" || card.status === "awaiting_merge";
    case "blocked":
      return card.waiting_on.some(
        (w) => w.kind === "blocked" || w.kind === "review",
      );
    default:
      return true;
  }
}
