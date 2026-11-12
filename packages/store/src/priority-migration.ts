import type { DatabaseSync } from "node:sqlite";

/** q(227) 选 b：High 无上界；null 明确表示不自动迁成 Urgent。 */
export function priorityMigrationThresholds(
  value = process.env.CARDIGAN_PRIORITY_MIGRATION_THRESHOLDS,
): readonly (number | null)[] {
  const thresholds = (value ?? "1,2,unbounded")
    .split(",")
    .map((part, index) => {
      const text = part.trim();
      if (index === 2 && text === "unbounded") return null;
      return text ? Number(text) : Number.NaN;
    });
  if (
    thresholds.length !== 3 ||
    thresholds.some(
      (n, i) =>
        n !== null && (!Number.isFinite(n) || n <= (thresholds[i - 1] ?? 0)),
    )
  )
    throw new Error(
      "CARDIGAN_PRIORITY_MIGRATION_THRESHOLDS 必须是三个递增正数，或两个递增正数后接 unbounded（默认 1,2,unbounded，按 q(227) 定为 b）",
    );
  return thresholds;
}

export function migrateCardPriorities(db: DatabaseSync): void {
  const thresholds = priorityMigrationThresholds();
  const update = db.prepare(
    "UPDATE cards SET doc = ? WHERE project_id = ? AND id = ?",
  );
  for (const row of db.prepare("SELECT project_id, id, doc FROM cards").all()) {
    const card = JSON.parse(String(row.doc));
    const old = card.priority ?? 0;
    if (typeof old !== "number" || !Number.isFinite(old))
      throw new Error("旧卡片优先级不是有限数值，迁移已回滚");
    const index = thresholds.findIndex((max) => max === null || old <= max);
    const priority = old <= 0 ? 0 : index < 0 ? 4 : index + 1;
    update.run(
      JSON.stringify({ ...card, priority }),
      String(row.project_id),
      String(row.id),
    );
  }
}
