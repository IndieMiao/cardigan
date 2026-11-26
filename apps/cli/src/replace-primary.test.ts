import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectId } from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CLI_TOOLS } from "./command-access.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";
import {
  openHumanCardTemplates,
  registerTemplateRoles,
} from "./template-fixtures.js";

const project = "p-replace-primary" as ProjectId;
let dataDir: string;
let store: Store;
let output: string[];
let errors: string[];
let io: CliIo;

async function run(args: string[]): Promise<number> {
  output = [];
  errors = [];
  return main(args, io);
}
const snapshot = () => store.uow.read((tx) => loadCommandState(tx, project));

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-replace-primary-"));
  io = {
    env: { CARDIGAN_DATA_DIR: dataDir },
    cwd: dataDir,
    platform: "linux",
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("work-item commands must not spawn");
    },
    captureCommand: async () => {
      throw new Error("work-item commands must not spawn");
    },
  };
  expect(await run(["project", "create", project, "--code", "TRP"])).toBe(0);
  const setup = Store.open({ dataDir });
  try {
    registerTemplateRoles(setup, project);
    openHumanCardTemplates(setup, project);
  } finally {
    setup.close();
  }
  expect(
    await run([
      "card",
      "create",
      "--template",
      "dev",
      "--title",
      "Mis-assigned",
      "--goal",
      "Ship",
      "--acceptance",
      "Works",
      "--repo",
      "example/repo",
    ]),
  ).toBe(0);
  store = Store.open({ dataDir });
});

afterEach(() => {
  store?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("C-778: help documents replace-primary and Token mode maps it to the PM Ops tool", async () => {
  expect(await run(["work-item", "--help"])).toBe(0);
  const help = output.join("\n");
  expect(help).toContain(
    "cardigan work-item replace-primary <W-旧> --with <W-新> --reason <理由>",
  );
  expect(help).toContain("仅人或常驻 PM Ops");
  expect(CLI_TOOLS["work-item replace-primary"]).toBe(
    "replace_primary_work_item",
  );
});

test("C-778: the human moves the primary slot to another producer; invalid input changes nothing", async () => {
  const old = snapshot().work_items.find(
    (w) => w.template_key === "development",
  );
  if (!old) throw new Error("missing primary");
  expect(
    await run([
      "work-item",
      "create",
      "C-1",
      "--title",
      "重做",
      "--role",
      "coder",
      "--kind",
      "produce",
    ]),
  ).toBe(0);
  const redo = snapshot().work_items.find(
    (w) => w.kind === "produce" && w.id !== old.id,
  );
  if (!redo) throw new Error("missing replacement");

  const before = JSON.stringify(snapshot());
  expect(
    await run(["work-item", "replace-primary", old.id, "--with", redo.id]),
  ).toBe(2);
  expect(errors.join("\n")).toContain("缺少 --reason");
  expect(
    await run([
      "work-item",
      "replace-primary",
      old.id,
      "--with",
      old.id,
      "--reason",
      "派错",
    ]),
  ).toBe(2);
  expect(errors.join("\n")).toContain("新旧产出项不能相同");
  expect(JSON.stringify(snapshot())).toBe(before);

  expect(
    await run([
      "work-item",
      "replace-primary",
      old.id,
      "--with",
      redo.id,
      "--reason",
      "派错角色",
    ]),
  ).toBe(0);
  expect(output.join("\n")).toBe(
    `已把 C-1 的主产出槽位 development 从 ${old.id} 转给 ${redo.id}`,
  );
  const after = snapshot();
  expect(after.work_items.find((w) => w.id === old.id)).toMatchObject({
    status: "cancelled",
    required: false,
    replaced_by_work_item_id: redo.id,
  });
  expect(after.work_items.find((w) => w.id === redo.id)).toMatchObject({
    template_key: "development",
    required: true,
  });
  expect(after.timeline.at(-1)?.body).toContain("派错角色");
});
