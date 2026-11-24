import { expect, test } from "vitest";
import { webHarness } from "../../test-support/web.js";
import { project_id, seedWebProject } from "../../test-support/web-data.js";
import { readCardDetail } from "./card-state.js";
import { readPagedCard } from "./timeline-state.js";

test("C-674: full numbers in bodies resolve in the project their code names; short numbers stay local", async () => {
  const f = await webHarness({ password: "qualified-refs-test-password" });
  try {
    seedWebProject(f.store, f.dataDir);
    expect(f.store.createProject({ id: "sensen-godot", code: "SEN" }).ok).toBe(
      true,
    );
    f.store.uow.run((tx) => {
      const card = tx.cards.get(project_id, "C-1" as never);
      if (!card) throw new Error("missing fixture");
      tx.cards.put("sensen-godot", {
        ...card,
        id: "C-34" as never,
        project_id: "sensen-godot" as never,
      });
      const entry = tx.timeline
        .list(project_id)
        .find((e) => e.card_id === "C-1");
      if (!entry) throw new Error("missing fixture entry");
      tx.timeline.put(project_id, {
        ...entry,
        body: "见 SEN-C-34、SEN-C-99、ZZZ-C-1 和 C-1",
      });
    });
    const code = f.store.projectCode(project_id);
    expect(code).toMatch(/^[A-Z][A-Z0-9]{2,3}$/u);
    const references = (detail: {
      timeline: readonly { body: string; references: readonly unknown[] }[];
    }) =>
      detail.timeline.find((e) => e.body.startsWith("见 SEN-C-34"))?.references;
    const expected = [
      expect.objectContaining({ kind: "card", id: "C-1", exists: true }),
      {
        kind: "card",
        id: "SEN-C-34",
        local_id: "C-34",
        exists: true,
        status: expect.any(String),
        project_id: "sensen-godot",
        card_id: "C-34",
      },
      {
        kind: "card",
        id: "SEN-C-99",
        local_id: "C-99",
        exists: false,
        status: null,
      },
      {
        kind: "card",
        id: "ZZZ-C-1",
        local_id: "C-1",
        exists: false,
        status: null,
      },
    ];
    const detail = readCardDetail(f.store, project_id, "C-1" as never);
    if (!detail) throw new Error("missing card");
    expect(references(detail)).toEqual(expected);
    const page = readPagedCard(
      f.store,
      project_id,
      "C-1" as never,
      new URL("http://localhost/cards/C-1"),
      {},
    );
    if (!page) throw new Error("missing page");
    expect(references(page)).toEqual(expected);
  } finally {
    await f.close();
  }
});
