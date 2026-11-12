import type { DatabaseSync } from "node:sqlite";

/** 待定，由人确认：旧值 <=0→无，(0,1]→低，(1,2]→中，(2,4]→高，>4→紧急。 */
export function priorityMigrationThresholds(
  value = process.env.CARDIGAN_PRIORITY_MIGRATION_THRESHOLDS,
): readonly number[] {
  const thresholds = (value ?? "1,2,4")
    .split(",")
    .map((part) => (part.trim() ? Number(part) : Number.NaN));
  if (
    thresholds.length !== 3 ||
    thresholds.some(
      (n, i) => !Number.isFinite(n) || n <= (thresholds[i - 1] ?? 0),
    )
  )
    throw new Error(
      "CARDIGAN_PRIORITY_MIGRATION_THRESHOLDS 必须是三个递增正数（默认 1,2,4，待定）",
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
    const index = thresholds.findIndex((max) => old <= max);
    const priority = old <= 0 ? 0 : index < 0 ? 4 : index + 1;
    update.run(
      JSON.stringify({ ...card, priority }),
      String(row.project_id),
      String(row.id),
    );
  }
}
