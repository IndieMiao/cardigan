/** Card fields the user can show or hide on the cards page (U5a). */
export const CARD_DISPLAY_FIELDS = [
  { key: "number", label: "编号" },
  { key: "waiting", label: "等待标记" },
  { key: "roles", label: "负责角色" },
  { key: "progress", label: "进度" },
  { key: "updated", label: "更新时间" },
  { key: "next", label: "下一步" },
  { key: "reason", label: "原因" },
] as const;

export type CardDisplayField = (typeof CARD_DISPLAY_FIELDS)[number]["key"];
export type CardDisplay = Readonly<Record<CardDisplayField, boolean>>;

/**
 * §9 U6a: "原因" is off by default because it repeats the waiting marker; every
 * other field stays on. Stored settings keep whatever the user chose.
 */
const OFF_BY_DEFAULT: ReadonlySet<CardDisplayField> = new Set(["reason"]);

export const DEFAULT_CARD_DISPLAY: CardDisplay = Object.fromEntries(
  CARD_DISPLAY_FIELDS.map((field) => [
    field.key,
    !OFF_BY_DEFAULT.has(field.key),
  ]),
) as CardDisplay;

export const CARD_DISPLAY_KEY = "cardigan.cards.display";

/**
 * localStorage is optional (private mode/SSR) and bad data falls back to the
 * defaults; stored fields keep the user's own choice (§9 U6a).
 */
export function readCardDisplay(): CardDisplay {
  try {
    const raw = window.localStorage.getItem(CARD_DISPLAY_KEY);
    if (raw === null) return DEFAULT_CARD_DISPLAY;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      CARD_DISPLAY_FIELDS.map((field) => [
        field.key,
        typeof parsed[field.key] === "boolean"
          ? parsed[field.key]
          : DEFAULT_CARD_DISPLAY[field.key],
      ]),
    ) as CardDisplay;
  } catch {
    return DEFAULT_CARD_DISPLAY;
  }
}

export function writeCardDisplay(display: CardDisplay): void {
  try {
    window.localStorage.setItem(CARD_DISPLAY_KEY, JSON.stringify(display));
  } catch {
    // The setting is optional; losing it must not break the page.
  }
}

export type CardGrouping = "none" | "status";
export const cardGroupingKey = (projectId: string) =>
  `cardigan.cards.grouping.${projectId}`;
export function readCardGrouping(projectId: string): CardGrouping {
  try {
    return window.localStorage.getItem(cardGroupingKey(projectId)) === "status"
      ? "status"
      : "none";
  } catch {
    return "none";
  }
}
export function writeCardGrouping(
  projectId: string,
  grouping: CardGrouping,
): void {
  try {
    window.localStorage.setItem(cardGroupingKey(projectId), grouping);
  } catch {
    /* A display preference must not block the page. */
  }
}
