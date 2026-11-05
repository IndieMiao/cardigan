/**
 * M4.5: every token path derives a standing PM's scope from `standing_mode`
 * (M4 plan §4 M4.5, development plan §7.1, §10.4).
 *
 * `issueAssignmentToken` is the one place the CLI start, the Dispatcher restart
 * and `token issue` share; these tests call it the way those paths do.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assignment, ProjectId, Role } from "@cardigan/domain";
import { Store, writeRole } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { issueAssignmentToken } from "./commands.js";

const project = "p-host-standing" as ProjectId;
const tools = ["whoami", "create_card", "record_decision"] as const;
let dataDir: string;
let store: Store;

const role: Role = {
  role_id: "pm",
  version: 1,
  display_name: "PM",
  kind: "standing",
  core_prompt: "pm",
  harness: "pi",
  launch_profile_ref: "fixture",
  allowed_tools: [...tools],
  capabilities: [],
  abilities: [],
  worktree: "none",
  required_machine_tags: [],
};

const standing = (extra: Partial<Assignment> = {}): Assignment =>
  ({
    id: "A-1" as never,
    scope: "standing",
    role_id: "pm",
    role_version: 1,
    status: "active",
    runtime_state: "not_provisioned",
    machine_id: "local",
    runtime_ref: null,
    mcp_token_id: "pm-ops",
    created_at: "2026-01-01T00:00:00.000Z",
    ...extra,
  }) as Assignment;

function seat(assignment: Assignment, scope?: readonly string[]) {
  store.uow.run((tx) => {
    tx.assignments.put(project, assignment);
    if (scope !== undefined)
      tx.issueToken({
        project_id: project,
        assignment_id: assignment.id,
        role: { role_version: 1, allowed_tools: scope as never },
      });
  });
}

const current = () =>
  store.uow.read((tx) => tx.assignments.get(project, "A-1" as never)) as
    | Assignment
    | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-host-standing-"));
  store = Store.open({ dataDir });
  store.createProject({ id: project, name: "Standing" });
  store.uow.run((tx) => writeRole(tx, project, role, { mode: "add" }));
});
afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("a legacy ops row stays ops when its token is rotated", () => {
  // Before M4.5 the mode was the newest token's scope: without the tool it was
  // Ops, and a rotation must not hand it the role's full list.
  seat(standing(), ["whoami", "create_card"]);
  const issued = issueAssignmentToken(store, project, {
    assignment: current() as Assignment,
    role,
  });
  expect(issued.record.allowed_tools).not.toContain("record_decision");
  expect(current()?.standing_mode).toBe("ops");
});

test("a stamped ops row keeps ops even if its newest token was wider", () => {
  seat(standing({ standing_mode: "ops" }), [...tools]);
  const rotated = issueAssignmentToken(store, project, {
    assignment: current() as Assignment,
    role,
  });
  expect(rotated.record.allowed_tools).toEqual(["whoami", "create_card"]);
  expect(current()?.standing_mode).toBe("ops");
});

test("office keeps record_decision and the mode is written back once", () => {
  seat(standing(), ["whoami", "record_decision"]);
  const first = issueAssignmentToken(store, project, {
    assignment: current() as Assignment,
    role,
  });
  expect(first.record.allowed_tools).toContain("record_decision");
  expect(current()?.standing_mode).toBe("office");
  const second = issueAssignmentToken(store, project, {
    assignment: current() as Assignment,
    role,
  });
  expect(second.record.allowed_tools).toContain("record_decision");
  expect(current()?.standing_mode).toBe("office");
});

test("a legacy row with no token at all defaults to the least privilege", () => {
  seat(standing());
  const issued = issueAssignmentToken(store, project, {
    assignment: current() as Assignment,
    role,
  });
  expect(issued.record.allowed_tools).not.toContain("record_decision");
  expect(current()?.standing_mode).toBe("ops");
});

test("work-item Assignments keep the never-wider rule", () => {
  const item = {
    ...standing(),
    scope: "work_item",
    work_item_id: "W-1",
  } as Assignment;
  seat(item, ["whoami"]);
  const issued = issueAssignmentToken(store, project, {
    assignment: item,
    role,
  });
  expect(issued.record.allowed_tools).toEqual(["whoami"]);
  expect(current()?.standing_mode).toBeUndefined();
});
