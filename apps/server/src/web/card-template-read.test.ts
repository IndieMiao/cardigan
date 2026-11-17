import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  builtinCardTemplateVersions,
  type CardId,
  developmentCardTemplate,
} from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { project_id, seedWebProject } from "../../test-support/web-data.js";
import { readCardDetail, readCardList } from "./card-state.js";
import { readCardsPage } from "./cards-page.js";

test("template metadata follows each card's exact version across full, summary, paginated and board reads", () => {
  const root = mkdtempSync(join(tmpdir(), "cg-template-read-"));
  const store = Store.open({ dbPath: ":memory:" });
  try {
    seedWebProject(store, root);
    const historical = {
      ...developmentCardTemplate,
      id: "custom",
      title: "旧版自定义名称",
      version: 3,
      builtin: false,
      status: "inactive" as const,
    };
    const definitions = [...builtinCardTemplateVersions, historical];
    store.uow.run((tx) => {
      const base = tx.cards.get(project_id, "C-1" as CardId);
      if (!base) throw new Error("Missing fixture");
      tx.card_templates.put(project_id, historical);
      tx.card_templates.put(project_id, {
        ...historical,
        version: 4,
        title: "最新名称不能覆盖历史",
        status: "active",
      });
      definitions.forEach((t, i) => {
        tx.cards.put(project_id, {
          ...base,
          id: `C-${801 + i}` as CardId,
          title: "Template fixture",
          template: t.id,
          template_version: t.version,
        });
      });
      tx.card_templates.put(project_id, {
        ...historical,
        id: "unregistered",
        title: "新类型模板",
        version: 7,
        builtin: true,
      });
      tx.cards.put(project_id, {
        ...base,
        id: "C-899" as CardId,
        template: "unregistered",
        template_version: 7,
      });
    });
    for (const rows of [
      readCardList(store, project_id),
      ...["", "?view=summary", "?view=summary&mode=board"].map(
        (q) =>
          readCardsPage(
            store,
            project_id,
            new URL(`http://fixture/cards${q}${q ? "&" : "?"}limit=50`),
          ).cards,
      ),
    ]) {
      definitions.forEach((t, i) => {
        const row = rows.find((c) => c.id === `C-${801 + i}`);
        expect(row?.template_info).toEqual({
          id: t.id,
          title: t.title,
          version: t.version,
          builtin: t.builtin,
        });
        expect(row?.template_version).toBe(t.version);
        expect(
          readCardDetail(store, project_id, `C-${801 + i}` as CardId)?.template,
        ).toMatchObject(row?.template_info ?? {});
      });
      expect(rows.find((c) => c.id === "C-899")).toMatchObject({
        template: "unregistered",
        template_version: 7,
        template_info: {
          id: "unregistered",
          title: "新类型模板",
          version: 7,
          builtin: true,
        },
      });
    }
    // A project's metadata takes precedence even for a familiar ID.
    store.uow.run((tx) =>
      tx.card_templates.put(project_id, {
        ...developmentCardTemplate,
        version: 2,
        builtin: false,
        title: "自定义开发流程",
      }),
    );
    expect(
      readCardList(store, project_id).find(
        (c) => c.template === "dev" && c.template_version === 2,
      )?.template_info,
    ).toMatchObject({ builtin: false, title: "自定义开发流程" });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
