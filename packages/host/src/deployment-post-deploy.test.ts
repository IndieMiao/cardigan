import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { databaseOpeners } from "./database-openers.js";
import { RoleRefreshFailed } from "./deployment.js";
import { writeDeploymentRecord } from "./deployment-audit.js";
import type { DeploymentConfig } from "./deployment-config.js";
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

async function fixture(lock: Partial<DeploymentConfig> = {}) {
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
      ...lock,
    },
    env: { PATH: process.env.PATH, CARDIGAN_HC_SESSION: "fixture" },
  });
  // The driver's state as initialize() and promote() leave it.
  const setState = (state: object) => {
    (driver as unknown as { state: object }).state = state;
  };
  return {
    root,
    dataDir,
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

/** A role sync that writes like the CLI does: it gives up on a busy database. */
const LOCKED_SYNC = `const { DatabaseSync } = require('node:sqlite');
  const { appendFileSync } = require('node:fs');
  const { join } = require('node:path');
  appendFileSync(join(process.env.CARDIGAN_DATA_DIR, 'sync-runs'), 'x');
  const db = new DatabaseSync(join(process.env.CARDIGAN_DATA_DIR, 'cardigan.db'));
  try {
    db.exec('PRAGMA busy_timeout = 20');
    db.exec('BEGIN IMMEDIATE');
    db.exec('COMMIT');
  } catch (error) {
    process.stderr.write('Error: ' + error.message + '\\n');
    process.exit(1);
  }`;

/**
 * Another writer: a CLI command holding the write lock (its arguments carry
 * a value that must never be recorded) until it is told to commit.
 */
async function holdWriteLock(root: string, dataDir: string) {
  const bin = join(root, "holder/apps/cli/dist/bin.js");
  await mkdir(join(bin, ".."), { recursive: true });
  await writeFile(
    bin,
    `const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(require('node:path').join(process.env.CARDIGAN_DATA_DIR, 'cardigan.db'));
    db.exec('BEGIN IMMEDIATE');
    process.stdout.write('held\\n');
    process.stdin.once('data', () => { db.exec('COMMIT'); process.exit(0); });`,
  );
  const child = spawn(
    process.execPath,
    [bin, "card", "comment", "C-1", "--body", "synthetic-holder-secret"],
    {
      env: { PATH: process.env.PATH, CARDIGAN_DATA_DIR: dataDir },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout?.once("data", () => resolve());
  });
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  return {
    pid: child.pid ?? 0,
    release: async () => {
      child.stdin?.write("go\n");
      await exited;
    },
  };
}

test("C-845: a role sync that meets another writer's lock finishes inside its own backoff", async () => {
  const f = await fixture({
    role_sync_lock_retries: 5,
    role_sync_lock_backoff_ms: 100,
  });
  try {
    const current = await f.release("b", {
      "packages/roles/dist/index.js": ROLE_PACK,
      "apps/cli/dist/bin.js": LOCKED_SYNC,
    });
    const old = await f.release("c", {
      "packages/roles/dist/index.js": ROLE_PACK,
    });
    f.setState({ current, previous: old });
    const holder = await holdWriteLock(f.root, f.dataDir);
    // The other writer commits after the first runs found the lock.
    const released = new Promise<void>((resolve) =>
      setTimeout(() => void holder.release().then(resolve), 250),
    );
    await f.driver.refreshRoles();
    await released;
    const runs = (await readFile(join(f.dataDir, "sync-runs"), "utf8")).length;
    expect(runs).toBeGreaterThan(1);
    expect(runs).toBeLessThanOrEqual(6);
  } finally {
    await f.close();
  }
});

test("C-845: a sync still locked after its backoff names its wait and the processes holding the database", async () => {
  const f = await fixture({
    role_sync_lock_retries: 2,
    role_sync_lock_backoff_ms: 20,
  });
  const holder = await holdWriteLock(f.root, f.dataDir);
  try {
    const current = await f.release("b", {
      "packages/roles/dist/index.js": ROLE_PACK,
      "apps/cli/dist/bin.js": LOCKED_SYNC,
    });
    const old = await f.release("c", {
      "packages/roles/dist/index.js": ROLE_PACK,
    });
    f.setState({ current, previous: old });
    const started = Date.now();
    const sync = await failure(() => f.driver.refreshRoles());
    expect(sync.step).toBe("sync");
    expect(sync.detail.changed).toEqual([]);
    // 1 run and 2 retries, 20 + 40 ms of backoff.
    expect((await readFile(join(f.dataDir, "sync-runs"), "utf8")).length).toBe(
      3,
    );
    const lock = sync.detail.lock;
    expect(lock?.retries).toBe(2);
    expect(lock?.waited_ms).toBeGreaterThanOrEqual(60);
    expect(lock?.waited_ms).toBeLessThanOrEqual(Date.now() - started);
    expect(sync.message).toContain("self-deploy roles 退出码 1（数据库被锁）");
    expect(sync.message).toContain(
      `同步内已退避重试 2 次、共等约 ${Math.round((lock?.waited_ms ?? 0) / 1000)} 秒仍被锁；打开数据库的进程：`,
    );
    if (process.platform === "linux") {
      const label = `cardigan CLI card comment（pid ${holder.pid}）`;
      expect(lock?.holders).toContain(label);
      expect(sync.message).toContain(label);
    } else expect(sync.message).toContain("未能识别");
    expect(JSON.stringify({ lock, message: sync.message })).not.toMatch(
      /synthetic-holder-secret|C-1|\/holder\//u,
    );
  } finally {
    await holder.release();
    await f.close();
  }
});

test("C-845: the holders are labelled by the supervisor's own roles first, without arguments or paths", async () => {
  if (process.platform !== "linux") return;
  const f = await fixture();
  const holder = await holdWriteLock(f.root, f.dataDir);
  try {
    const database = join(f.dataDir, "cardigan.db");
    expect(await databaseOpeners(database)).toContain(
      `cardigan CLI card comment（pid ${holder.pid}）`,
    );
    expect(
      await databaseOpeners(database, { [holder.pid]: "后台服务" }),
    ).toContain(`后台服务（pid ${holder.pid}）`);
    // This process (the supervisor) is never named; nor is an unrelated file.
    expect(
      (await databaseOpeners(database)).some((h) =>
        h.includes(`pid ${process.pid}）`),
      ),
    ).toBe(false);
    expect(await databaseOpeners(join(f.root, "missing/x.db"))).toEqual([]);
    expect(
      await databaseOpeners(database, {}, join(f.root, "no-proc")),
    ).toEqual([]);
  } finally {
    await holder.release();
    await f.close();
  }
});

test("C-845: a final locked sync reaches the host operator with its wait and holders; the owner is never pushed", async () => {
  const f = await fixture();
  try {
    f.store.uow.run((tx) => {
      tx.assignments.put("cardigan", assignment("A-1", "pm", "office"));
    });
    const error =
      "self-deploy roles 退出码 1（数据库被锁）；同步内已退避重试 5 次、共等约 71 秒仍被锁；打开数据库的进程：后台服务（pid 12）";
    const lock_wait = {
      retries: 5,
      waited_ms: 71000,
      holders: ["后台服务（pid 12）"],
    };
    writeDeploymentRecord(f.store, "cardigan", {
      ...deployed("post-deploy-lock"),
      post_deploy_failure: {
        attempts: [
          { step: "sync", error, lock_wait },
          { step: "sync", error, lock_wait },
        ],
        changed_roles: ["pm"],
      },
    });
    const state = f.store.uow.read((tx) => loadCommandState(tx, "cardigan"));
    expect(state.human_actions).toHaveLength(1);
    const [action] = state.human_actions;
    expect(action).toMatchObject({ executor: "operator", status: "open" });
    expect(action?.instructions).toContain(`第 2 次：sync：${error}`);
    expect(
      extMessageItems(state, "cardigan").filter(
        (i) => i.item_id === action?.id,
      ),
    ).toEqual([]);
    const diagnostics = await readDeploymentDiagnostics(f.store, "cardigan");
    expect(diagnostics?.records[0]).toMatchObject({
      post_deploy_failure: {
        attempts: [{ step: "sync", lock_wait }, { lock_wait }],
      },
    });
  } finally {
    await f.close();
  }
});
