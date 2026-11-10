import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRoleVersion, listRoleVersions, Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { main } from "./index.js";
import type { CliIo } from "./io.js";
import { parseRoleFile } from "./role-file.js";

const ROLE_YAML = `role_id: coder
display_name: Coder
kind: work
core_prompt: |
  实现并交付。
harness: codex
launch_profile_ref: codex-agent
allowed_tools: [submit_delivery, get_card]
capabilities: [code]
abilities: [coding]
worktree: write
required_machine_tags: []
`;

let dataDir: string;
let root: string;
let output: string[];
let errors: string[];
let io: CliIo;
let roleFile: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "cardigan-roles-file-"));
  dataDir = join(root, "data");
  output = [];
  errors = [];
  io = {
    env: { CARDIGAN_DATA_DIR: dataDir },
    cwd: root,
    platform: "linux",
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("role commands must not spawn");
    },
    captureCommand: async () => ({ code: 1, stdout: "", stderr: "" }),
  };
  roleFile = join(root, "coder.yaml");
  writeFileSync(roleFile, ROLE_YAML);
  await run(["init"]);
  await run(["project", "create", "p-roles"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function run(argv: string[]): Promise<number> {
  output = [];
  errors = [];
  return main(argv, io);
}

function printed(): string {
  return output.join("\n");
}

test("role add --file writes version 1 and update appends version 2", async () => {
  expect(await run(["role", "add", "--file", roleFile])).toBe(0);
  expect(printed()).toContain("已创建角色 coder v1");

  writeFileSync(
    roleFile,
    ROLE_YAML.replace("codex-agent", "codex-agent-2").replace(
      "submit_delivery, get_card",
      "submit_delivery",
    ),
  );
  expect(await run(["role", "update", "--file", roleFile])).toBe(0);
  expect(printed()).toContain("已更新角色 coder v2");

  const store = Store.open({ dataDir });
  try {
    const versions = store.uow.read((tx) =>
      listRoleVersions(tx, "p-roles" as never),
    );
    expect(versions.map((role) => role.version)).toEqual([1, 2]);
    // The old version keeps its own launch profile and tools.
    expect(versions[0]?.launch_profile_ref).toBe("codex-agent");
    expect(versions[0]?.allowed_tools).toEqual(["submit_delivery", "get_card"]);
    expect(versions[1]?.launch_profile_ref).toBe("codex-agent-2");
    expect(versions[1]?.allowed_tools).toEqual(["submit_delivery"]);
  } finally {
    store.close();
  }
});

test("role add refuses a role that already has a version", async () => {
  await run(["role", "add", "--file", roleFile]);
  expect(await run(["role", "add", "--file", roleFile])).toBe(2);
  expect(errors.at(-1)).toBe(
    "无法创建角色 coder：角色已存在（v1），请用 cardigan role update 添加新版本（validation_failed）",
  );
});

test("role update refuses a role that was never added", async () => {
  expect(await run(["role", "update", "--file", roleFile])).toBe(2);
  expect(errors.at(-1)).toBe(
    "无法更新角色 coder：角色不存在，请先用 cardigan role add 创建（not_found）",
  );
});

test("a role file cannot pin a version", async () => {
  writeFileSync(roleFile, `${ROLE_YAML}version: 5\n`);
  expect(await run(["role", "add", "--file", roleFile])).toBe(2);
  expect(errors.join("\n")).toContain("version");
});

test("invalid role files are refused with a useful message", async () => {
  const cases: Array<[string, RegExp]> = [
    [ROLE_YAML.replace("harness: codex", "harness: cursor"), /harness/],
    [ROLE_YAML.replace("worktree: write", "worktree: sometimes"), /worktree/],
    [
      ROLE_YAML.replace(
        "allowed_tools: [submit_delivery, get_card]",
        "allowed_tools: [fly]",
      ),
      /工具/,
    ],
    [ROLE_YAML.replace("display_name: Coder\n", ""), /display_name/],
  ];
  for (const [content, pattern] of cases) {
    writeFileSync(roleFile, content);
    expect(await run(["role", "add", "--file", roleFile])).toBe(2);
    expect(errors.join("\n")).toMatch(pattern);
  }
});

test("parseRoleFile defaults the optional lists", () => {
  const parsed = parseRoleFile(
    `role_id: reviewer
display_name: Reviewer
kind: work
core_prompt: review
harness: claude-code
launch_profile_ref: claude-agent
worktree: readonly
`,
    "reviewer.yaml",
  );
  expect(parsed.capabilities).toEqual([]);
  expect(parsed.abilities).toEqual([]);
  expect(parsed.required_machine_tags).toEqual([]);
  expect(parsed.allowed_tools).toEqual([]);
});

test("project set-repo records the repository and base branch", async () => {
  expect(
    await run([
      "project",
      "set-repo",
      "--path",
      join(root, "repo"),
      "--base-branch",
      "develop",
    ]),
  ).toBe(0);
  expect(printed()).toContain(`项目 p-roles 的仓库：${join(root, "repo")}`);
  expect(printed()).toContain("默认基线分支：develop");

  const store = Store.open({ dataDir });
  try {
    expect(store.getProject("p-roles" as never)).toMatchObject({
      repo_path: join(root, "repo"),
      base_branch: "develop",
    });
  } finally {
    store.close();
  }
});

test("project set-repo needs --path and an absolute directory", async () => {
  expect(await run(["project", "set-repo"])).toBe(2);
  expect(errors.join("\n")).toContain("--path");

  expect(await run(["project", "set-repo", "--path", "relative/repo"])).toBe(2);
  expect(errors.join("\n")).toContain(
    "无法设置项目仓库 p-roles：仓库路径必须是绝对路径（validation_failed）",
  );
});

test("a run pinned to an old version still resolves that version", async () => {
  await run(["role", "add", "--file", roleFile]);
  const store = Store.open({ dataDir });
  try {
    store.uow.run((tx) => {
      tx.assignments.put("p-roles" as never, {
        id: "A-1" as never,
        scope: "standing",
        role_id: "coder",
        role_version: 1,
        status: "active",
        runtime_state: "not_provisioned",
        machine_id: "local",
        runtime_ref: null,
        mcp_token_id: "t",
        created_at: "2026-01-01T00:00:00.000Z",
      });
      tx.runs.put("p-roles" as never, {
        id: "R-1" as never,
        assignment_id: "A-1" as never,
        trigger_event_id: "01J00000000000000000000001" as never,
        kind: "initial",
        status: "queued",
        role_version: 1,
        model: "fictional-model",
        agent_cli_version: "0.0.1",
        outcome: null,
        summary: "",
      });
    });
  } finally {
    store.close();
  }

  writeFileSync(roleFile, ROLE_YAML.replace("codex-agent", "changed"));
  await run(["role", "update", "--file", roleFile]);

  const reopened = Store.open({ dataDir });
  try {
    const run = reopened.uow.read((tx) =>
      tx.runs.get("p-roles" as never, "R-1" as never),
    );
    const pinned = reopened.uow.read((tx) =>
      getRoleVersion(tx, "p-roles" as never, "coder", run?.role_version),
    );
    expect(run?.role_version).toBe(1);
    expect(pinned?.launch_profile_ref).toBe("codex-agent");
  } finally {
    reopened.close();
  }
});
