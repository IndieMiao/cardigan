import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  defaultMigrationsDir,
  listMigrations,
  migrate,
  Store,
} from "./index.js";
import { assignment, event } from "./test-support.js";

test.each([24, 25])(
  "machine migration upgrades v%s atomically and preserves historical identities and aliases",
  checkMachineUpgrade,
);

function checkMachineUpgrade(previousVersion: number) {
  const dataDir = mkdtempSync(join(tmpdir(), "cardigan-machine-upgrade-"));
  const migrationsDir = join(dataDir, "old-migrations");
  mkdirSync(migrationsDir);
  for (const migration of listMigrations(defaultMigrationsDir).filter(
    (m) => m.version <= previousVersion,
  ))
    writeFileSync(
      join(
        migrationsDir,
        `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`,
      ),
      migration.sql,
    );
  let store = Store.open({ dataDir, migrationsDir });
  try {
    store.createProject({ id: "a" });
    store.createProject({ id: "z" });
    store.createProject({ id: "existing" });
    expect(store.database.prepare("SELECT * FROM machines").all()).toEqual([]);
    const noticeEvent = event({
      seq: 1,
      card_id: undefined,
      actor: { kind: "human" },
    });
    store.uow.run((tx) => {
      tx.machines.put("existing", {
        id: "local",
        label: "Existing fixture host",
        herdr_machine: "legacy-alias",
        os: "linux",
        arch: "x64",
        tags: ["fixture-toolchain"],
        status: "draining",
        max_assignments: 2,
        last_seen: "2026-01-01T00:00:00.000Z",
      });
      tx.events.append("a", noticeEvent);
    });
    store.database
      .prepare(`INSERT INTO notifications
      (project_id, id, event_id, recipient_kind, seq, kind, status, doc)
      VALUES ('a', 'fixture-notice', ?, 'needs_you', 1, 'comment', 'acked', '{}')`)
      .run(noticeEvent.id);
    const oldMachines = store.database.prepare("SELECT * FROM machines").all();
    const oldNotifications = store.database
      .prepare("SELECT * FROM notifications")
      .all();
    store.uow.run((tx) =>
      tx.assignments.put(
        "a",
        assignment({
          runtime_ref: {
            machine_id: "local",
            runtime_machine: "legacy-alias",
            agent_name: "fixture-agent",
            agent_session_id: "session",
            terminal_ref: "terminal",
          },
        }),
      ),
    );
    const history = store.database.prepare("SELECT * FROM assignments").all();
    if (previousVersion === 25) {
      store.database.exec(
        `INSERT INTO ext_message_host_status VALUES (1, '{"fixture":"kept"}')`,
      );
      // Seed the historical schema directly; current outbox writers require v27.
      store.database
        .prepare(`INSERT INTO ext_message_outbox
        (project_id,item_kind,item_id,channel,event_id,status,next_attempt_at,updated_at)
        VALUES ('a','notice','fixture-notice','fixture-channel',?,'pending',?,?)`)
        .run(noticeEvent.id, noticeEvent.created_at, noticeEvent.created_at);
    }
    const oldOutbox =
      previousVersion === 25
        ? store.database.prepare("SELECT * FROM ext_message_outbox").all()
        : [];
    const expectPreservedData = (upgraded = false) => {
      expect(
        store.database
          .prepare("SELECT * FROM machines WHERE project_id = 'existing'")
          .all(),
      ).toEqual(oldMachines);
      expect(
        store.database.prepare("SELECT * FROM notifications").all(),
      ).toEqual(oldNotifications);
      expect(
        store.database.prepare("SELECT * FROM ext_message_outbox").all(),
      ).toEqual(
        upgraded
          ? oldOutbox.map((row) => ({ ...row, digest_id: null }))
          : oldOutbox,
      );
      expect(store.database.prepare("SELECT * FROM assignments").all()).toEqual(
        history,
      );
    };
    // Emulate the pre-registry schema, then fail after the first project's seed.
    store.database.exec(
      "DROP TRIGGER IF EXISTS snapshot_machines_insert; DROP TRIGGER IF EXISTS snapshot_machines_update; DROP TRIGGER IF EXISTS snapshot_machines_delete; CREATE TRIGGER fail_seed BEFORE INSERT ON machines WHEN NEW.project_id = 'z' BEGIN SELECT RAISE(ABORT, 'fixture seed failure'); END;",
    );
    expect(() => migrate(store.database)).toThrow("fixture seed failure");
    // Earlier migrations commit independently; only the machine upgrade rolls back.
    expect(store.schemaVersion()).toBe(25);
    expect(store.database.prepare("SELECT * FROM machines").all()).toEqual(
      oldMachines,
    );
    expectPreservedData();
    expect(
      store.database
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'assignment_machine_immutable'",
        )
        .get(),
    ).toBeUndefined();
    store.database.exec("DROP TRIGGER fail_seed");
    store.close();
    store = Store.open({ dataDir });
    expect(
      store.database
        .prepare("SELECT name FROM schema_version WHERE version = 26")
        .get(),
    ).toEqual({ name: "machine_registry" });
    expect(
      store.database.prepare("SELECT * FROM ext_message_host_status").all(),
    ).toEqual(
      previousVersion === 25 ? [{ id: 1, doc: '{"fixture":"kept"}' }] : [],
    );
    expect(store.uow.read((tx) => tx.machines.list("a"))).toMatchObject([
      { id: "local" },
    ]);
    expect(store.uow.read((tx) => tx.machines.list("z"))).toHaveLength(1);
    expectPreservedData(true);
    store.uow.run((tx) => {
      const local = tx.machines.get("a", "local");
      if (!local) throw new Error("missing local");
      tx.machines.put("a", { ...local, herdr_machine: "legacy-alias" });
    });
    expect(store.migrate()).toEqual([]);
    expectPreservedData(true);
    store.createProject({ id: "new" });
    expect(store.uow.read((tx) => tx.machines.list("new"))).toMatchObject([
      { id: "local" },
    ]);
    expect(
      store.uow.read((tx) => tx.machines.get("a", "local"))?.herdr_machine,
    ).toBe("legacy-alias");
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}
