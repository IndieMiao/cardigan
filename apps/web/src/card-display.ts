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

export const DEFAULT_CARD_DISPLAY: CardDisplay = Object.fromEntries(
  CARD_DISPLAY_FIELDS.map((field) => [field.key, true]),
) as CardDisplay;

export const CARD_DISPLAY_KEY = "cardigan.cards.display";

/** localStorage is optional (private mode/SSR); bad data falls back to defaults. */
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
