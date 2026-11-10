import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generalCardTemplate } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { stringify } from "yaml";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

let dataDir: string,
  io: CliIo,
  output: string[],
  errors: string[],
  store: Store;
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-template-cli-"));
  output = [];
  errors = [];
  io = {
    env: { CARDIGAN_DATA_DIR: dataDir },
    cwd: dataDir,
    platform: "linux",
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    signals: { on: () => {}, off: () => {} },
    spawnInherit: () => {
      throw new Error("No Agent needed");
    },
    captureCommand: async () => {
      throw new Error("No Git needed");
    },
  };
  expect(await main(["project", "create", "templates"], io)).toBe(0);
  store = Store.open({ dataDir });
});
afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});
const run = (args: string[]) => {
  output = [];
  errors = [];
  return main(args, io);
};
const card = (template: string) => [
  "card",
  "create",
  "--template",
  template,
  "--title",
  "Notes",
  "--goal",
  "Prepare notes",
];

test("all template CLI commands use persisted versions and YAML", async () => {
  expect(await run(["template", "list"])).toBe(0);
  expect(output.join("\n")).toContain("artifact v1");
  expect(output.join("\n")).toContain("general v1");
  expect(await run(["template", "copy", "general", "notes"])).toBe(0);
  expect(await run(["template", "show", "notes", "--version", "1"])).toBe(0);
  expect(JSON.parse(output.join("\n"))).toMatchObject({
    id: "notes",
    version: 1,
    builtin: false,
  });
  const yaml = join(dataDir, "template.yaml");
  writeFileSync(
    yaml,
    stringify({ ...generalCardTemplate, id: "notes", title: "Updated notes" }),
  );
  expect(await run(["template", "update", "--file", yaml])).toBe(0);
  expect(await run(["template", "deactivate", "notes"])).toBe(0);
  expect(await run(card("notes"))).toBe(2);
  expect(errors.join("\n")).toContain("停用");
  expect(await run(["template", "activate", "notes"])).toBe(0);
  expect(await run(["template", "rollback", "notes", "--version", "1"])).toBe(
    0,
  );
  expect(await run(["template", "show", "notes"])).toBe(0);
  expect(JSON.parse(output.join("\n"))).toMatchObject({
    version: 5,
    title: generalCardTemplate.title,
    history: [1, 2, 3, 4, 5],
  });
  expect(await run(card("notes"))).toBe(0);
  expect(
    store.uow.read((tx) => tx.cards.list("templates"))[0]?.template_version,
  ).toBe(5);
  writeFileSync(yaml, stringify({ ...generalCardTemplate, id: "added" }));
  expect(await run(["template", "add", "--file", yaml])).toBe(0);
  writeFileSync(
    yaml,
    stringify({ ...generalCardTemplate, title: "Attempt overwrite" }),
  );
  expect(await run(["template", "update", "--file", yaml])).toBe(2);
  expect(errors.join("\n")).toContain("先复制");
});

test("general is created without repo and human completion atomically records result and evidence", async () => {
  expect(await run(card("general"))).toBe(0);
  const created = store.uow.read((tx) => tx.cards.list("templates"))[0];
  if (!created) throw new Error("Missing card");
  expect(created).toMatchObject({
    template: "general",
    template_version: 1,
    status: "todo",
  });
  expect(created).not.toHaveProperty("repo");
  expect(created).not.toHaveProperty("base_branch");
  writeFileSync(join(dataDir, "proof.txt"), "Agreed notes");
  writeFileSync(join(dataDir, "more.md"), "# Evidence");
  expect(
    await run([
      "card",
      "done",
      created.id,
      "--result",
      "Notes agreed",
      "--file",
      "proof.txt",
      "--file",
      "more.md",
    ]),
  ).toBe(0);
  const snapshot = store.uow.read((tx) => ({
    card: tx.cards.get("templates", created.id),
    events: tx.events.listAfter("templates", created.id, 0),
    attachments: tx.attachments.list("templates"),
  }));
  expect(snapshot.card).toMatchObject({ status: "done", resolution: "done" });
  expect(snapshot.attachments).toHaveLength(2);
  expect(snapshot.events.at(-1)).toMatchObject({
    type: "card_marked_done",
    actor: { kind: "human" },
    payload: {
      result: "Notes agreed",
      attachments: snapshot.attachments.map((a) => a.id),
    },
  });
  const before = snapshot.events.length;
  expect(
    await run([
      "card",
      "done",
      created.id,
      "--result",
      "Again",
      "--file",
      "proof.txt",
    ]),
  ).toBe(2);
  expect(
    store.uow.read((tx) => tx.events.listAfter("templates", created.id, 0)),
  ).toHaveLength(before);
  expect(store.uow.read((tx) => tx.attachments.list("templates"))).toHaveLength(
    2,
  );
});

test("invalid YAML and missing completion results leave no writes", async () => {
  writeFileSync(join(dataDir, "bad.yaml"), "work_items: [broken");
  expect(await run(["template", "add", "--file", "bad.yaml"])).toBe(2);
  expect(
    store.uow.read((tx) => tx.card_templates.list("templates")),
  ).toHaveLength(3);
  expect(await run(card("general"))).toBe(0);
  const created = store.uow.read((tx) => tx.cards.list("templates"))[0];
  if (!created) throw new Error("Missing card");
  expect(await run(["card", "done", created.id])).toBe(2);
  expect(
    store.uow.read((tx) => tx.cards.get("templates", created.id))?.status,
  ).toBe("todo");
});
