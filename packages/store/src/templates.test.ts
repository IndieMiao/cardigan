import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactCardTemplate,
  builtinCardTemplates,
  designCardTemplate,
  developmentCardTemplate,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import { defaultMigrationsDir, listMigrations } from "./migrate.js";
import { Store } from "./store.js";
import { latestSchemaVersion } from "./test-support.js";

test("v10 upgrade seeds each project's builtin templates and fixes legacy cards at dev v1", () => {
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
      builtinCardTemplates.length,
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

test("v21 adds design v1 to projects migrated before it and keeps their stored artifact v1", () => {
  const root = mkdtempSync(join(tmpdir(), "cardigan-design-template-"));
  let store: Store | undefined;
  try {
    for (const migration of listMigrations(defaultMigrationsDir).filter(
      (m) => m.version <= 19,
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
    expect(store.schemaVersion()).toBe(19);
    for (const id of ["one", "two"])
      expect(store.createProject({ id }).ok).toBe(true);
    // Recreate what 0011 stored before V12a: no design, artifact by designer.
    const oldArtifact = {
      ...artifactCardTemplate,
      work_items: [
        { ...artifactCardTemplate.work_items[0], role_id: "designer" },
        artifactCardTemplate.work_items[1],
      ],
    };
    // Versions are append-only (UPDATE aborts), so rebuild the old rows.
    store.database
      .prepare(
        "DELETE FROM card_templates WHERE template_id IN ('design', 'artifact')",
      )
      .run();
    for (const id of ["one", "two"])
      store.database
        .prepare(
          "INSERT INTO card_templates (project_id, template_id, version, doc) VALUES (?, 'artifact', 1, ?)",
        )
        .run(id, JSON.stringify(oldArtifact));
    store.close();

    store = Store.open({ dbPath });
    expect(store.schemaVersion()).toBe(latestSchemaVersion());
    expect(
      store.database
        .prepare("SELECT name FROM schema_version WHERE version = 21")
        .get(),
    ).toEqual({ name: "design_template" });
    for (const id of ["one", "two"]) {
      const opened = store;
      expect(
        opened.uow.read((tx) =>
          tx.card_templates.get(id, { id: "design", version: 1 }),
        ),
      ).toEqual(designCardTemplate);
      expect(
        opened.uow.read((tx) =>
          tx.card_templates.get(id, { id: "artifact", version: 1 }),
        ),
      ).toEqual(oldArtifact);
      expect(opened.uow.read((tx) => tx.card_templates.list(id))).toHaveLength(
        builtinCardTemplates.length,
      );
    }
    expect(store.migrate()).toEqual([]);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
