import { expect, test } from "vitest";
import { call, webHarness } from "../../test-support/web.js";
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

test("C-675: /api/refs/resolve finds a full number's card, decision or human action in its project", async () => {
  const password = "qualified-resolve-test-password";
  const f = await webHarness({ password });
  try {
    seedWebProject(f.store, f.dataDir);
    expect(f.store.createProject({ id: "sensen-godot", code: "SEN" }).ok).toBe(
      true,
    );
    f.store.uow.run((tx) => {
      const card = tx.cards.get(project_id, "C-1" as never);
      const decision = tx.decisions.list(project_id)[0];
      const action = tx.human_actions.list(project_id)[0];
      if (!card || !decision || !action) throw new Error("missing fixture");
      tx.cards.put("sensen-godot", { ...card, id: "C-34" as never });
      tx.decisions.put("sensen-godot", {
        ...decision,
        id: "Q-12" as never,
        key: "Q-12" as never,
        card_id: "C-34" as never,
      });
      // A project-level human action: no card to anchor on.
      tx.human_actions.put("sensen-godot", {
        ...action,
        id: "H-46" as never,
        key: "H-46" as never,
      });
    });
    const cookie = await f.login(password);
    const resolve = async (id: string) =>
      (
        (await call(f.port, `/api/refs/resolve?id=${encodeURIComponent(id)}`, {
          cookie,
          headers: { host: f.hostHeader },
        })) as { json: { reference: unknown } }
      ).json.reference;
    expect(await resolve("SEN-C-34")).toEqual({
      kind: "card",
      id: "SEN-C-34",
      local_id: "C-34",
      exists: true,
      status: expect.any(String),
      project_id: "sensen-godot",
      card_id: "C-34",
    });
    expect(await resolve(" SEN-Q-12 ")).toMatchObject({
      kind: "decision",
      local_id: "Q-12",
      project_id: "sensen-godot",
      card_id: "C-34",
    });
    expect(await resolve("SEN-H-46")).toMatchObject({
      kind: "human_action",
      local_id: "H-46",
      project_id: "sensen-godot",
    });
    // Unknown numbers or codes, short numbers and text answer null.
    for (const id of ["SEN-C-99", "ZZZ-C-1", "C-1", "SEN-C-34 x", ""])
      expect(await resolve(id), id).toBeNull();
    // Needs a session like every other read.
    expect(
      (
        await call(f.port, "/api/refs/resolve?id=SEN-C-34", {
          headers: { host: f.hostHeader },
        })
      ).status,
    ).toBe(401);
  } finally {
    await f.close();
  }
});
