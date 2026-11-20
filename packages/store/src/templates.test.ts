import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactCardTemplate,
  builtinCardTemplates,
  cardTemplate,
  designCardTemplate,
  developmentCardTemplate,
  developmentCardTemplateV2,
  generalCardTemplate,
  productCardTemplate,
  storyCardTemplate,
  uiCardTemplate,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import { defaultMigrationsDir, listMigrations } from "./migrate.js";
import { Store } from "./store.js";
import { seedStoryTemplates } from "./templates.js";
import { latestSchemaVersion } from "./test-support.js";

test("B3b registration preserves old card versions and every builtin version remains immutable", () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    expect(store.createProject({ id: "versions" }).ok).toBe(true);
    const old = { id: "C-1", project_id: "versions", template: "dev" };
    store.database
      .prepare("INSERT INTO cards (project_id, id, doc) VALUES (?, ?, ?)")
      .run("versions", old.id, JSON.stringify(old));
    store.uow.run((tx) => {
      tx.card_templates.put("versions", developmentCardTemplateV2);
      tx.card_templates.put("versions", productCardTemplate);
    });
    const saved = store.uow.read((tx) => tx.cards.list("versions"))[0];
    if (!saved) throw new Error("Missing old card");
    expect(saved.template_version).toBeUndefined();
    expect(
      cardTemplate(
        saved,
        store.uow.read((tx) => tx.card_templates.list("versions")),
      ),
    ).toEqual(developmentCardTemplate);
    expect(
      store.database.prepare("SELECT doc FROM cards WHERE id = ?").get(old.id),
    ).toEqual({ doc: JSON.stringify(old) });
    for (const template of [
      developmentCardTemplate,
      developmentCardTemplateV2,
      productCardTemplate,
    ]) {
      expect(() =>
        store.uow.run((tx) =>
          tx.card_templates.put("versions", {
            ...template,
            title: "Overwrite",
          }),
        ),
      ).toThrow(/immutable/);
      expect(
        store.uow.read((tx) =>
          tx.card_templates.get("versions", {
            id: template.id,
            version: template.version,
          }),
        ),
      ).toEqual(template);
    }
  } finally {
    store.close();
  }
});

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
      flow_version: 1,
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

test("v39 seeds ui for flow 5 without rewriting historical cards or existing template versions", () => {
  const root = mkdtempSync(join(tmpdir(), "cardigan-ui-template-"));
  let store: Store | undefined;
  try {
    for (const migration of listMigrations(defaultMigrationsDir).filter(
      (m) => m.version < 39,
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
    const custom = { ...uiCardTemplate, builtin: false, title: "Project UI" };
    for (const id of ["modern", "legacy", "custom"]) {
      expect(store.createProject({ id }).ok).toBe(true);
      store.uow.run((tx) => {
        tx.project_preferences.put(id, {
          id,
          auto_merge_after_minutes: null,
          flow_version: id === "legacy" ? 4 : 5,
        });
        if (id === "custom") tx.card_templates.put(id, custom);
      });
    }
    const old = {
      id: "C-1",
      project_id: "modern",
      template: "product",
      template_version: 1,
      flow_version: 5,
    };
    store.database
      .prepare("INSERT INTO cards (project_id, id, doc) VALUES (?, ?, ?)")
      .run("modern", old.id, JSON.stringify(old));
    store.close();
    store = Store.open({ dbPath });
    const opened = store;
    expect(
      opened.uow.read((tx) =>
        tx.card_templates.get("modern", { id: "ui", version: 1 }),
      ),
    ).toEqual(uiCardTemplate);
    expect(
      opened.uow.read((tx) =>
        tx.card_templates.get("legacy", { id: "ui", version: 1 }),
      ),
    ).toBeUndefined();
    expect(
      opened.uow.read((tx) =>
        tx.card_templates.get("custom", { id: "ui", version: 1 }),
      ),
    ).toEqual(custom);
    expect(
      opened.database.prepare("SELECT doc FROM cards WHERE id = ?").get(old.id),
    ).toEqual({ doc: JSON.stringify(old) });
    expect(opened.migrate()).toEqual([]);
    expect(() =>
      opened.uow.run((tx) =>
        tx.card_templates.put("modern", {
          ...uiCardTemplate,
          title: "Overwrite",
        }),
      ),
    ).toThrow(/immutable/);
    store.close();
    store = Store.open({ dbPath });
    expect(store.migrate()).toEqual([]);
    expect(
      store.uow
        .read((tx) => tx.card_templates.list("modern"))
        .filter((t) => t.id === "ui"),
    ).toEqual([uiCardTemplate]);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("v45 seeds the builtin beside conflicting custom names without editing pinned snapshots", () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    for (const id of ["legacy", "clean"])
      expect(store.createProject({ id }).ok).toBe(true);
    const db = store.database;
    db.prepare("DELETE FROM card_templates WHERE template_id = 'story'").run(); // simulate pre-v45
    const legacy = {
      ...generalCardTemplate,
      id: "story",
      title: "Existing",
      builtin: false,
    };
    const latest = {
      ...legacy,
      version: 2,
      title: "Edited",
      status: "inactive" as const,
    };
    const occupied = { ...legacy, id: "builtin-story" };
    store.uow.run((tx) => {
      for (const t of [legacy, latest, occupied])
        tx.card_templates.put("legacy", t);
    });
    const pinned = { template: "story", template_version: 1 };
    for (let pass = 0; pass < 2; pass++) {
      seedStoryTemplates(db);
      const templates = store.uow.read((tx) =>
        tx.card_templates.list("legacy"),
      );
      expect(cardTemplate(pinned, templates)).toEqual(legacy);
      expect(templates.filter((t) => t.id === "story")).toEqual(
        expect.arrayContaining([legacy, latest]),
      );
      expect(templates.filter((t) => t.id === occupied.id)).toEqual([occupied]);
      expect(templates.filter((t) => t.story)).toEqual([
        { ...storyCardTemplate, id: "builtin-story-2" },
      ]);
      expect(
        store.uow
          .read((tx) => tx.card_templates.list("clean"))
          .filter((t) => t.story),
      ).toEqual([storyCardTemplate]);
    }
  } finally {
    store.close();
  }
});
