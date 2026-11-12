import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  builtinCardTemplates,
  developmentCardTemplate,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import { defaultMigrationsDir, listMigrations } from "./migrate.js";
import { Store } from "./store.js";

test("v10 upgrade seeds each project's three templates and fixes legacy cards at dev v1", () => {
  const root = mkdtempSync(join(tmpdir(), "cardigan-templates-"));
  let store: Store | undefined;
  try {
    for (const migration of listMigrations(defaultMigrationsDir).filter(
      (m) => m.version <= 10,
    ))
      writeFileSync(
        join(
          root,
          `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`,
        ),
        migration.sql,
      );
    const dbPath = join(root, "old.db");
    store = Store.open({ dbPath, migrationsDir: root });
    for (const id of ["one", "two"])
      expect(store.createProject({ id }).ok).toBe(true);
    const card = {
      id: "C-1",
      project_id: "one",
      template: "dev",
      repo: "example/repo",
    };
    store.database
      .prepare("INSERT INTO cards (project_id, id, doc) VALUES (?, ?, ?)")
      .run("one", "C-1", JSON.stringify(card));
    store.close();
    store = Store.open({ dbPath });
    expect(store.uow.read((tx) => tx.cards.list("one"))[0]).toEqual({
      ...card,
      template_version: 1,
      priority: 0,
    });
    for (const id of ["one", "two"])
      expect(store.uow.read((tx) => tx.card_templates.list(id))).toEqual(
        expect.arrayContaining(builtinCardTemplates),
      );
    expect(store.migrate()).toEqual([]);
    expect(store.createProject({ id: "new" }).ok).toBe(true);
    expect(store.uow.read((tx) => tx.card_templates.list("new"))).toHaveLength(
      3,
    );
    const upgraded = store;
    expect(() =>
      upgraded.uow.run((tx) =>
        tx.card_templates.put("one", {
          ...developmentCardTemplate,
          title: "Overwrite",
        }),
      ),
    ).toThrow(/immutable/);
    expect(
      store.uow.read((tx) =>
        tx.card_templates.get("two", { id: "dev", version: 1 }),
      ),
    ).toEqual(builtinCardTemplates[0]);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
