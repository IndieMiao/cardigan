import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  builtinCardTemplates,
  developmentCardTemplateV2,
  fastPatchCardTemplate,
  generalCardTemplate,
  productCardTemplate,
} from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { stringify } from "yaml";
import { main } from "./index.js";
import type { CliIo } from "./io.js";
import { openHumanCardTemplates } from "./template-fixtures.js";

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
  expect(
    await main(["project", "create", "templates", "--code", "TEM"], io),
  ).toBe(0);
  store = Store.open({ dataDir });
  openHumanCardTemplates(store, "templates", ["general", "notes"]);
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

test("B3b registered source templates list exact versions and cannot be overwritten through YAML", async () => {
  store.uow.run((tx) => {
    tx.card_templates.put("templates", developmentCardTemplateV2);
    tx.card_templates.put("templates", productCardTemplate);
    tx.card_templates.put("templates", fastPatchCardTemplate);
  });
  expect(await run(["template", "list"])).toBe(0);
  expect(output.join("\n")).toContain("dev v2");
  expect(output.join("\n")).toContain("product v1");
  expect(output.join("\n")).toContain("fast_patch v1");
  expect(await run(["template", "show", "fast_patch", "--version", "1"])).toBe(
    0,
  );
  expect(JSON.parse(output.join("\n"))).toMatchObject({
    completion: { mode: "review", reviewer: "system" },
    work_items: [{ kind: "produce" }],
  });
  expect(await run(["template", "show", "dev", "--version", "1"])).toBe(0);
  expect(JSON.parse(output.join("\n"))).toMatchObject({
    version: 1,
    work_items: [{}, {}, { key: "pm_acceptance" }],
  });
  for (const template of [
    developmentCardTemplateV2,
    productCardTemplate,
    fastPatchCardTemplate,
  ]) {
    const yaml = join(dataDir, "builtin.yaml");
    writeFileSync(
      yaml,
      stringify({ ...template, builtin: false, title: "Overwrite" }),
    );
    for (const action of ["add", "update"])
      expect(await run(["template", action, "--file", yaml])).toBe(2);
  }
});

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
  expect(errors.at(-1)).toBe(
    "无法更新模板 general：内置模板不能修改，请先复制成新编号（validation_failed）",
  );
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
  expect(errors.at(-1)).toBe(
    `无法完成卡片 ${created.id}：当前状态不允许执行此操作（illegal_transition）`,
  );
  expect(
    store.uow.read((tx) => tx.events.listAfter("templates", created.id, 0)),
  ).toHaveLength(before);
  expect(store.uow.read((tx) => tx.attachments.list("templates"))).toHaveLength(
    2,
  );
});

test("missing completion and copy targets keep their command context and do not write", async () => {
  const snapshot = () =>
    store.uow.read((tx) => ({
      templates: tx.card_templates.list("templates"),
      cards: tx.cards.list("templates"),
      timeline: tx.timeline.list("templates"),
    }));
  const before = snapshot();
  expect(await run(["card", "done", "C-99", "--result", "Done"])).toBe(2);
  expect(errors.at(-1)).toBe(
    "无法完成卡片 C-99：卡片 C-99 在当前项目中不存在（not_found）",
  );
  expect(output).toEqual([]);
  expect(snapshot()).toEqual(before);
  expect(await run(["template", "copy", "missing", "new-template"])).toBe(2);
  expect(errors.at(-1)).toBe(
    "无法复制模板 missing：源模板版本不存在（not_found）",
  );
  expect(output).toEqual([]);
  expect(snapshot()).toEqual(before);
});

test("invalid YAML and missing completion results leave no writes", async () => {
  writeFileSync(join(dataDir, "bad.yaml"), "work_items: [broken");
  expect(await run(["template", "add", "--file", "bad.yaml"])).toBe(2);
  expect(
    store.uow.read((tx) => tx.card_templates.list("templates")),
  ).toHaveLength(builtinCardTemplates.length);
  expect(await run(card("general"))).toBe(0);
  const created = store.uow.read((tx) => tx.cards.list("templates"))[0];
  if (!created) throw new Error("Missing card");
  expect(await run(["card", "done", created.id])).toBe(2);
  expect(
    store.uow.read((tx) => tx.cards.get("templates", created.id))?.status,
  ).toBe("todo");
});

test("flow 5 exposes registered templates without rewriting an existing project's stored versions", async () => {
  const before = store.uow.read((tx) => tx.card_templates.list("templates"));
  expect(
    await run([
      "preference",
      "set",
      "system-merge-shadow-policy",
      '{"role_rule_paths":[],"release_paths":[]}',
    ]),
  ).toBe(0);
  expect(await run(["preference", "set", "flow-version", "5"])).toBe(0);
  expect(await run(["template", "list"])).toBe(0);
  expect(output.join("\n")).toContain("dev v2");
  expect(output.join("\n")).toContain("product v1");
  expect(await run(["template", "show", "dev", "--version", "1"])).toBe(0);
  expect(JSON.parse(output.join("\n"))).toMatchObject({ version: 1 });
  expect(store.uow.read((tx) => tx.card_templates.list("templates"))).toEqual(
    before,
  );
});

test("CLI can parent a card without implying a dependency", async () => {
  store.uow.run((tx) =>
    tx.roles.put("templates", {
      role_id: "pm",
      role_version: 1,
      allowed_tools: ["post_comment", "submit_delivery"],
      capabilities: ["verify"],
    }),
  );
  expect(await run(card("story")), errors.join("\n")).toBe(0);
  expect(await run([...card("general"), "--parent-card", "C-1"])).toBe(0);
  expect(store.uow.read((tx) => tx.cards.list("templates"))[1]).toMatchObject({
    parent_card_id: "C-1",
    status: "todo",
  });
});
