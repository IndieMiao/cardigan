import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cardTemplate,
  generalCardTemplate,
  storyCardTemplate,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import { defaultMigrationsDir } from "./migrate.js";
import { Store } from "./store.js";
import { seedStoryTemplates } from "./templates.js";
import { migrationsThrough } from "./test-support.js";

test("upgrading an existing project seeds the builtin beside conflicting custom names without editing pinned snapshots", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cardigan-story-upgrade-"));
  const version = 1795222266848;
  const migrationsDir = migrationsThrough(dataDir, version - 1);
  const store = Store.open({ dbPath: ":memory:", migrationsDir });
  try {
    for (const id of ["legacy", "clean"])
      expect(store.createProject({ id }).ok).toBe(true);
    const db = store.database;
    db.prepare("DELETE FROM card_templates WHERE template_id = 'story'").run(); // Projects created by the old host have no builtin story.
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
    const upgrade = `${version}_story_template.sql`;
    copyFileSync(
      join(defaultMigrationsDir, upgrade),
      join(migrationsDir, upgrade),
    );
    expect(store.migrate()).toEqual([{ version, name: "story_template" }]);
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) {
        expect(store.migrate()).toEqual([]);
        seedStoryTemplates(db);
      }
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
    rmSync(dataDir, { recursive: true, force: true });
  }
});
