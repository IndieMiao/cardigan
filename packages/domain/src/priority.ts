/** Fixed scheduling ranks, persisted as 0..4. */
export const CARD_PRIORITIES = [0, 1, 2, 3, 4] as const;
export type CardPriority = (typeof CARD_PRIORITIES)[number];
export const PRIORITY_NAMES = [
  "none",
  "low",
  "medium",
  "high",
  "urgent",
] as const;
export const PRIORITY_LABELS = ["无", "低", "中", "高", "紧急"] as const;

export function parseCardPriority(value: unknown): CardPriority | undefined {
  if (typeof value === "number")
    return CARD_PRIORITIES.find((rank) => rank === value);
  if (typeof value !== "string") return undefined;
  const name = value.trim().toLowerCase();
  return CARD_PRIORITIES.find(
    (rank) => PRIORITY_NAMES[rank] === name || PRIORITY_LABELS[rank] === name,
  );
}
