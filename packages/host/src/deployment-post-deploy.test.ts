import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Assignment,
  type DeploymentRecord,
  extMessageItems,
  type Run,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { notificationsByRecipient, Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { RoleRefreshFailed } from "./deployment.js";
import { writeDeploymentRecord } from "./deployment-audit.js";
import { readDeploymentDiagnostics } from "./deployment-diagnostics.js";
import { redactCommandTail } from "./deployment-log.js";
import {
  NodeDeploymentDriver,
  parseRolePackSnapshot,
  ROLE_PACK_SNAPSHOT_MARKER,
  standingPmOnDuty,
} from "./deployment-node.js";

const ROLE_PACK = `exports.DEFAULT_ROLE_KINDS = { pm: 'standing' };
  exports.defaultRoleDefinition = () => ({ instructions: 'x', allowed_tools: [],
    capabilities: [], kind: 'standing', worktree: false });`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cg-post-deploy-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const store = Store.open({ dataDir });
  store.createProject({ id: "cardigan" });
  const release = async (name: string, files: Record<string, string>) => {
    const dir = join(root, name);
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), text);
    }
    await mkdir(dir, { recursive: true });
    return { sha: name.repeat(40).slice(0, 40), release: dir };
  };
  const driver = new NodeDeploymentDriver({
    store,
    dataDir,
    config: {
      enabled: true,
      initial_release: root,
      initial_sha: "a".repeat(40),
      ready_timeout_ms: 1000,
      stop_timeout_ms: 1000,
      build_timeout_ms: 5000,
      poll_interval_ms: 1000,
    },
    env: { PATH: process.env.PATH, CARDIGAN_HC_SESSION: "fixture" },
  });
  // The driver's state as initialize() and promote() leave it.
  const setState = (state: object) => {
    (driver as unknown as { state: object }).state = state;
  };
  return {
    root,
    store,
    driver,
    release,
    setState,
    close: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function failure(run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof RoleRefreshFailed) return error;
    throw error;
  }
  throw new Error("refreshRoles did not fail");
}

test("C-801: refreshRoles names each of its three failure points with fixed text", async () => {
  const f = await fixture();
  try {
    const current = await f.release("b", {
      "packages/roles/dist/index.js": ROLE_PACK,
      "apps/cli/dist/bin.js":
        "process.stderr.write('项目定制角色未能升级 CARDIGAN_TOKEN=synthetic-secret at ' + __filename + '\\n'); process.exit(4);",
    });
    // 1. No previous build in the state.
    f.setState({ current });
    const previous = await failure(() => f.driver.refreshRoles());
    expect(previous.step).toBe("previous");
    expect(previous.message).toBe("部署状态里没有上一版本，无法比对角色包");
    // 2. The previous build's pack cannot be snapshotted.
    const missing = await f.release("a", {});
    f.setState({ current, previous: missing });
    const snapshot = await failure(() => f.driver.refreshRoles());
    expect(snapshot.step).toBe("snapshot");
    expect(snapshot.message).toBe("上一版本角色包快照失败：退出码 1");
    expect(snapshot.detail.output).toContain("ERR_MODULE_NOT_FOUND");
    const tail = redactCommandTail(snapshot.detail.output ?? "");
    expect(tail).toContain("ERR_MODULE_NOT_FOUND");
    expect(tail).not.toContain(f.root);
    // 3. self-deploy roles exits non-zero.
    const old = await f.release("c", {
      "packages/roles/dist/index.js": ROLE_PACK,
    });
    f.setState({ current, previous: old });
    const sync = await failure(() => f.driver.refreshRoles());
    expect(sync.step).toBe("sync");
    expect(sync.message).toBe("self-deploy roles 退出码 4");
    expect(sync.detail.changed).toEqual([]);
    const syncTail = redactCommandTail(sync.detail.output ?? "");
    expect(syncTail).toBe(
      "项目定制角色未能升级 CARDIGAN_TOKEN=<已隐去> at <路径>",
    );
  } finally {
    await f.close();
  }
});

test("C-801: the snapshot is read from its own line, never from merged warnings", () => {
  const hash = "f".repeat(64);
  expect(
    parseRolePackSnapshot(
      `(node:1) ExperimentalWarning: x\n${ROLE_PACK_SNAPSHOT_MARKER} {"pm":"${hash}"}\n`,
    ),
  ).toEqual({ pm: hash });
  expect(parseRolePackSnapshot(`{"pm":"${hash}"}`)).toBeUndefined();
  expect(
    parseRolePackSnapshot(`${ROLE_PACK_SNAPSHOT_MARKER} {"pm":"short"}`),
  ).toBeUndefined();
});

const assignment = (
  id: string,
  role_id: string,
  standing_mode?: "office" | "ops",
): Assignment =>
  ({
    id,
    scope: "standing",
    role_id,
    ...(standing_mode ? { standing_mode } : {}),
    role_version: 1,
    status: "active",
    runtime_state: "running",
    machine_id: "local",
    runtime_ref: null,
    mcp_token_id: "fixture",
    created_at: "2026-01-01T00:00:00.000Z",
  }) as Assignment;

test("C-801: the standing PMs are on duty only when PM Office and PM Ops both have a session", () => {
  const office = assignment("A-1", "pm", "office");
  const ops = assignment("A-2", "pm", "ops");
  const run = (assignment_id: string) => ({ assignment_id }) as Run;
  expect(standingPmOnDuty([office, ops], [run("A-1"), run("A-2")])).toBe(true);
  expect(standingPmOnDuty([office, ops], [run("A-1")])).toBe(false);
  expect(standingPmOnDuty([office], [run("A-1")])).toBe(false);
  expect(
    standingPmOnDuty(
      [office, { ...ops, status: "released" } as Assignment],
      [run("A-1"), run("A-2")],
    ),
  ).toBe(false);
});

const deployed = (attempt: string): DeploymentRecord => ({
  attempt,
  from: "a".repeat(40),
  to: "b".repeat(40),
  status: "deployed",
  build: "passed",
  ready: true,
  downtime_ms: 1,
  summary: "代码已部署；角色同步（self-deploy roles）未完成",
  post_deploy_failed: true,
});

test("C-801: a final post-deploy failure goes to the host operator with its reasons; the owner is never pushed", async () => {
  const f = await fixture();
  try {
    f.store.uow.run((tx) => {
      tx.assignments.put("cardigan", assignment("A-1", "pm", "office"));
      tx.assignments.put("cardigan", assignment("A-2", "host_ops"));
    });
    writeDeploymentRecord(f.store, "cardigan", {
      ...deployed("post-deploy-1"),
      post_deploy_failure: {
        attempts: [
          { step: "previous", error: "部署状态里没有上一版本，无法比对角色包" },
          {
            step: "sync",
            error: "self-deploy roles 退出码 4",
            output_tail: "项目定制角色未能升级",
          },
        ],
        changed_roles: ["pm"],
      },
    });
    const state = f.store.uow.read((tx) => loadCommandState(tx, "cardigan"));
    expect(state.human_actions).toHaveLength(1);
    const [action] = state.human_actions;
    expect(action).toMatchObject({ executor: "operator", status: "open" });
    expect(action?.instructions).toContain(
      "第 1 次：previous：部署状态里没有上一版本，无法比对角色包",
    );
    expect(action?.instructions).toContain(
      "第 2 次：sync：self-deploy roles 退出码 4；输出尾部：项目定制角色未能升级",
    );
    expect(
      state.events.filter((e) => e.type === "operator_action_requested"),
    ).toHaveLength(1);
    // Feishu reads the owner's items: the operator's action is not among them.
    expect(
      extMessageItems(state, "cardigan").filter(
        (i) => i.item_id === action?.id,
      ),
    ).toEqual([]);
    const diagnostics = await readDeploymentDiagnostics(f.store, "cardigan");
    expect(diagnostics?.records[0]).toMatchObject({
      post_deploy_failed: true,
      post_deploy_failure: {
        attempts: [{ step: "previous" }, { step: "sync" }],
        changed_roles: ["pm"],
      },
    });
  } finally {
    await f.close();
  }
});

test("C-801: an unchanged pack with the standing PMs on duty notifies without a to-do", async () => {
  const f = await fixture();
  try {
    f.store.uow.run((tx) => {
      tx.assignments.put("cardigan", assignment("A-1", "pm", "office"));
      tx.assignments.put("cardigan", assignment("A-2", "host_ops"));
    });
    writeDeploymentRecord(f.store, "cardigan", {
      ...deployed("post-deploy-2"),
      post_deploy_failure: {
        attempts: [
          { step: "sync", error: "self-deploy roles 退出码 1" },
          { step: "sync", error: "self-deploy roles 退出码 1" },
        ],
        changed_roles: [],
        notice_only: true,
      },
    });
    expect(
      f.store.uow.read((tx) => tx.human_actions.list("cardigan")),
    ).toHaveLength(0);
    const notified = notificationsByRecipient(f.store.database, "cardigan");
    for (const id of ["A-1", "A-2"])
      expect(notified.get(`assignment:${id}`)).toHaveLength(1);
  } finally {
    await f.close();
  }
});
