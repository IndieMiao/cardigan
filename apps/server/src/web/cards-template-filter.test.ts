import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CardId,
  developmentCardTemplate,
  storyCardTemplate,
} from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { project_id, seedWebProject } from "../../test-support/web-data.js";
import { readCardsPage } from "./cards-page.js";

/** C-816: the card-type filter mirrors each card's template marker. */
test("template filter lists used types and narrows list, board and cursor reads", () => {
  const root = mkdtempSync(join(tmpdir(), "cg-template-filter-"));
  const store = Store.open({ dbPath: ":memory:" });
  try {
    seedWebProject(store, root);
    store.uow.run((tx) => {
      const base = tx.cards.get(project_id, "C-1" as CardId);
      if (!base) throw new Error("Missing fixture");
      for (const card of tx.cards.list(project_id))
        tx.cards.put(project_id, { ...card, template: "dev" });
      const put = (n: number, template: string, version?: number) => {
        const { template_version: _, ...rest } = base;
        tx.cards.put(project_id, {
          ...rest,
          id: `C-${n}` as CardId,
          title: `Card ${n}`,
          template,
          ...(version === undefined ? {} : { template_version: version }),
        });
      };
      put(901, "story", storyCardTemplate.version);
      put(902, "story", storyCardTemplate.version);
      put(903, "story", storyCardTemplate.version);
      put(904, "my-flow", 1);
      put(905, "my-flow", 2);
      put(906, "imported", 7);
      tx.card_templates.put(project_id, {
        ...developmentCardTemplate,
        id: "my-flow",
        title: "项目流程",
        version: 1,
        builtin: false,
      });
      tx.card_templates.put(project_id, {
        ...developmentCardTemplate,
        id: "my-flow",
        title: "项目流程第二版",
        version: 2,
        builtin: false,
      });
      // A stored builtin snapshot keeps its own title, like TemplateMarker.
      tx.card_templates.put(project_id, {
        ...developmentCardTemplate,
        id: "imported",
        title: "导入类型",
        version: 7,
        builtin: true,
      });
    });
    const read = (query: string) =>
      readCardsPage(
        store,
        project_id,
        new URL(`http://fixture/cards?view=summary&${query}`),
      );
    const all = read("limit=50");
    expect(all.templates).toEqual([
      { value: "imported", label: "导入类型" },
      { value: "dev", label: "开发卡" },
      { value: "story", label: "需求卡" },
      { value: "_custom", label: "自定义或未知模板" },
    ]);
    const story = read("limit=50&template=story");
    expect(story.cards.map((c) => c.id).sort()).toEqual([
      "C-901",
      "C-902",
      "C-903",
    ]);
    expect(story.total_filtered).toBe(3);
    // The options describe the project, not the current selection.
    expect(story.templates).toEqual(all.templates);
    expect(
      read("limit=50&template=_custom")
        .cards.map((c) => c.id)
        .sort(),
    ).toEqual(["C-904", "C-905"]);
    expect(
      read("limit=50&template=dev").cards.every((c) => c.template === "dev"),
    ).toBe(true);
    expect(read("limit=50&template=unknown-type").cards).toEqual([]);
    // Search stacks on the type, and board lanes count only that type.
    expect(
      read("limit=50&template=story&q=C-902").cards.map((c) => c.id),
    ).toEqual(["C-902"]);
    const board = read("mode=board&limit=2&sort=id&template=story");
    const lane = Object.entries(board.lanes).find(([, l]) => l.total > 0);
    expect(lane?.[1].total).toBe(3);
    expect(board.cards.map((c) => c.id)).toEqual(["C-901", "C-902"]);
    const next = read(
      `mode=board&limit=2&sort=id&template=story&status=${lane?.[0]}&cursor=${encodeURIComponent(lane?.[1].next_cursor ?? "")}`,
    );
    expect(next.cards.map((c) => c.id)).toEqual(["C-903"]);
    // A cursor from another type is rejected rather than silently reused.
    expect(() =>
      read(
        `mode=board&limit=2&sort=id&template=dev&status=${lane?.[0]}&cursor=${encodeURIComponent(lane?.[1].next_cursor ?? "")}`,
      ),
    ).toThrow();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
