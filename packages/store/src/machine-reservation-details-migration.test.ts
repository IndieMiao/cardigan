import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { migrate, Store } from "./index.js";
import { migrationsThrough } from "./test-support.js";

test("C-800 upgrade backfills each reservation's source and classifies existing waits", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cardigan-reservation-upgrade-"));
  const store = Store.open({
    dataDir,
    migrationsDir: migrationsThrough(dataDir, 1795702986475),
  });
  try {
    const db = store.database;
    const reserved = (project: string, generation: string, actor: object) =>
      db
        .prepare(
          "INSERT INTO events (project_id, id, card_id, stream, seq, type, doc) VALUES (?, ?, NULL, '_project', ?, 'machine_resource_reserved', ?)",
        )
        .run(
          project,
          `E-${generation}`,
          generation === "by-human" ? 1 : 2,
          JSON.stringify({ actor, payload: { generation } }),
        );
    store.createProject({ id: "p" });
    reserved("p", "by-human", { kind: "human", project_id: "p" });
    reserved("p", "by-pm", { kind: "assignment", project_id: "p" });
    for (const generation of ["by-human", "by-pm", "unrecorded"])
      db.prepare(
        `INSERT INTO machine_resource_leases (generation, machine, resource, project, starts_at, ends_at, endpoints)
         VALUES (?, 'local', 'device', 'p', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', '[]')`,
      ).run(generation);
    db.exec(`INSERT INTO machine_resource_waits VALUES
      ('q', 'R-1', 'local', 'device：预约独占', 1, 0),
      ('q', 'R-2', 'local', '并发额度或排队顺序', 0, 0),
      ('q', 'R-3', 'local', 'device：等待释放核验', 1, 0)`);
    expect(migrate(db).map((m) => m.name)).toContain(
      "machine_reservation_details",
    );
    expect(
      db
        .prepare(
          "SELECT generation, source, cancelled_at FROM machine_resource_leases ORDER BY generation",
        )
        .all()
        .map((row) => ({ ...row })),
    ).toEqual([
      { generation: "by-human", source: "human", cancelled_at: null },
      { generation: "by-pm", source: "standing_pm", cancelled_at: null },
      { generation: "unrecorded", source: null, cancelled_at: null },
    ]);
    expect(
      db
        .prepare(
          "SELECT run_id, kind, reservation FROM machine_resource_waits ORDER BY run_id",
        )
        .all()
        .map((row) => ({ ...row })),
    ).toEqual([
      { run_id: "R-1", kind: "reservation", reservation: null },
      { run_id: "R-2", kind: "capacity", reservation: null },
      { run_id: "R-3", kind: "resource", reservation: null },
    ]);
    expect(migrate(db)).toEqual([]);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
