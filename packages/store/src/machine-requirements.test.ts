import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  developmentCardTemplate,
  type Role,
  type WorkItem,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import { getRoleVersion, writeRole } from "./roles.js";
import { Store } from "./store.js";

test("machine requirements survive reopening; legacy documents remain unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "cg-requirements-"));
  let store = Store.open({ dataDir: dir });
  const project = "fixture";
  const requirements = {
    os: "linux",
    arch: "x64",
    capabilities: ["godot>=4.7", "custom-cli"],
    tags: ["office"],
  };
  const item: WorkItem = {
    id: "W-1",
    card_id: "C-1",
    kind: "produce",
    role_id: "coder",
    title: "Build",
    required: true,
    depends_on: [],
    completion_criteria: [],
    status: "todo",
  };
  const role: Role = {
    role_id: "coder",
    version: 1,
    display_name: "Coder",
    kind: "produce",
    core_prompt: "Build",
    harness: "codex",
    launch_profile_ref: "fixture",
    allowed_tools: ["submit_delivery"],
    capabilities: ["produce"],
    abilities: [],
    worktree: "write",
    required_machine_tags: ["office"],
  };
  const template = {
    ...developmentCardTemplate,
    id: "custom",
    builtin: false,
    work_items: developmentCardTemplate.work_items.map((w) => ({
      ...w,
      requirements,
    })),
  };
  try {
    store.createProject({ id: project });
    store.uow.run((tx) => {
      tx.work_items.put(project, item);
      tx.work_items.put(project, { ...item, id: "W-2", requirements });
      tx.card_templates.put(project, template);
      writeRole(tx, project, role, { mode: "add" });
      writeRole(
        tx,
        project,
        { ...role, required_capabilities: ["browser.chromium"] },
        { mode: "update" },
      );
    });
    store.close();
    store = Store.open({ dataDir: dir });
    store.uow.read((tx) => {
      expect(tx.work_items.get(project, "W-1")).toEqual(item);
      expect(tx.work_items.get(project, "W-2")?.requirements).toEqual(
        requirements,
      );
      expect(
        tx.card_templates.get(project, { id: "custom", version: 1 }),
      ).toEqual(template);
      expect(getRoleVersion(tx, project, "coder", 1)).toEqual(role);
      expect(
        getRoleVersion(tx, project, "coder")?.required_capabilities,
      ).toEqual(["browser.chromium"]);
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
