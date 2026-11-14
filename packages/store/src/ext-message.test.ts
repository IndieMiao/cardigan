import { DatabaseSync } from "node:sqlite";
import type { ExtMessageItem } from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  claimExtMessage,
  listExtMessages,
  projectExtMessage,
  settleExtMessage,
} from "./ext-message.js";
import { defaultMigrationsDir, listMigrations, migrate } from "./migrate.js";
import { withTempStore } from "./test-support.js";

const at = "2026-01-01T00:00:00.000Z";
const item: ExtMessageItem = {
  project_id: "fictional",
  event_id: "event-1",
  card_id: "C-1",
  item_id: "Q-1",
  kind: "decision",
  sensitive: false,
  handled: false,
  ready: true,
};
test("migration upgrades an existing schema without rewriting existing notifications", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const m of listMigrations(defaultMigrationsDir).filter(
      (m) => m.version < 25,
    ))
      db.exec(m.sql);
    const before = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    db.exec(
      listMigrations(defaultMigrationsDir).find((m) => m.version === 25)!.sql,
    );
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),
    ).toHaveLength(before.length + 2);
    expect(listExtMessages(db)).toEqual([]);
  } finally {
    db.close();
  }
});
test("replay is unique per item and channel, transactional and terminal rows cannot be claimed", () =>
  withTempStore((store) => {
    store.uow.run(() => {
      projectExtMessage(store.database, item, "fake", at);
      projectExtMessage(
        store.database,
        { ...item, event_id: "later-event" },
        "fake",
        at,
      );
      projectExtMessage(store.database, item, "second", at);
    });
    expect(listExtMessages(store.database)).toHaveLength(2);
    expect(() =>
      store.uow.run(() => {
        projectExtMessage(
          store.database,
          { ...item, item_id: "Q-2" },
          "fake",
          at,
        );
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(listExtMessages(store.database)).toHaveLength(2);
    const row = listExtMessages(store.database)[0]!;
    expect(
      claimExtMessage(
        store.database,
        row,
        "lease-1",
        at,
        "2026-01-01T00:00:10.000Z",
        "2026-01-01T00:00:40.000Z",
      ),
    ).toBe(true);
    expect(claimExtMessage(store.database, row, "lease-2", at, at, at)).toBe(
      false,
    );
    expect(
      settleExtMessage(
        store.database,
        { ...row, attempts: 1, lease_id: "wrong" },
        "sent",
        null,
        at,
        at,
      ),
    ).toBe(false);
    expect(
      settleExtMessage(
        store.database,
        { ...row, attempts: 1, lease_id: "lease-1" },
        "sent",
        null,
        at,
        at,
      ),
    ).toBe(true);
    const sent = listExtMessages(store.database)[0]!;
    expect(claimExtMessage(store.database, sent, "lease-3", at, at, at)).toBe(
      false,
    );
    expect(migrate(store.database)).toEqual([]);
  }));
