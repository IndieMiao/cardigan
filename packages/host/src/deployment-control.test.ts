import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { currentDeploymentPin } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { deploymentMergeSegments } from "./deployment-audit.js";
import { acquireDeploymentCapacity } from "./deployment-capacity.js";
import { changeDeployment } from "./deployment-control.js";
import { NodeDeploymentDriver } from "./deployment-node.js";

test("supervisor lag is visibly audited once and never triggers a supervisor upgrade", async () => {
  const root = await mkdtemp(join(tmpdir(), "cg-supervisor-version-"));
  const store = Store.open({ dataDir: root });
  const old = "a".repeat(40),
    next = "b".repeat(40);
  store.createProject({ id: "cardigan" });
  const driver = new NodeDeploymentDriver({
    store,
    dataDir: root,
    env: {},
    config: {
      enabled: true,
      initial_release: root,
      initial_sha: old,
      ready_timeout_ms: 1000,
      stop_timeout_ms: 1000,
      poll_interval_ms: 1000,
      build_timeout_ms: 1000,
    },
  });
  const command = vi
    .spyOn(
      driver as unknown as {
        command(
          file: string,
          args: string[],
          cwd: string,
          env: NodeJS.ProcessEnv,
        ): Promise<{ code: number; text: string }>;
      },
      "command",
    )
    .mockImplementation(async (_file, args) => ({
      code: 0,
      text: args.includes("HEAD") ? old : next,
    }));
  vi.spyOn(driver, "isFastForward").mockResolvedValue(true);
  const start = vi.spyOn(driver, "start");
  try {
    for (let i = 0; i < 3; i++) expect(await driver.main()).toBe(next);
    const actions = store.uow.read((tx) => tx.human_actions.list("cardigan"));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      triage: "human",
      blocked_work_items: [],
    });
    expect(actions[0]?.instructions).toContain(old);
    expect(actions[0]?.instructions).toContain("系统不会自我升级");
    expect(
      command.mock.calls.every(
        ([file, args]) => file === "git" && args.includes("rev-parse"),
      ),
    ).toBe(true);
    expect(start).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("human controls validate central history, audit adoption and persist a pin across supervisor instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "cg-deploy-control-"));
  const dataDir = join(root, "data");
  const source = join(root, "source");
  const repo = join(dataDir, "central/cardigan.git");
  const exec = promisify(execFile);
  const git = async (cwd: string, ...args: string[]) =>
    (
      await exec("git", [
        "-C",
        cwd,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ])
    ).stdout.trim();
  const store = Store.open({ dataDir });
  const human = { kind: "human", project_id: "cardigan" } as const;
  try {
    store.createProject({ id: "cardigan" });
    await chmod(dataDir, 0o700);
    await mkdir(join(dataDir, "self-deploy"), { mode: 0o700 });
    await mkdir(source);
    await git(source, "init", "-b", "main");
    const shas: string[] = [];
    for (const content of ["old", "foreign", "next"]) {
      await writeFile(join(source, "file"), content);
      await git(source, "add", ".");
      await git(source, "commit", "-m", content);
      shas.push(await git(source, "rev-parse", "HEAD"));
    }
    const [old, foreign, next] = shas as [string, string, string];
    await mkdir(join(dataDir, "central"), { mode: 0o700 });
    await git(root, "clone", "--bare", source, repo);
    await chmod(repo, 0o700);
    const driver = () =>
      new NodeDeploymentDriver({
        store,
        dataDir,
        env: {},
        config: {
          enabled: true,
          initial_release: source,
          initial_sha: old,
          ready_timeout_ms: 1000,
          stop_timeout_ms: 1000,
          poll_interval_ms: 1000,
          build_timeout_ms: 1000,
        },
      });
    expect(await driver().passedMergeGate(old, next)).toBe(false);
    for (const [from, to] of [
      [old, foreign],
      [foreign, next],
    ])
      await changeDeployment(store, dataDir, human, {
        action: "adopt",
        from: from as string,
        to: to as string,
        reason: "Reviewed foreign history",
      });
    expect(await driver().passedMergeGate(old, next)).toBe(true);
    expect(deploymentMergeSegments(store, "cardigan", old, next)).toHaveLength(
      2,
    );
    await changeDeployment(store, dataDir, human, {
      action: "pin",
      sha: old,
      reason: "Reviewed rollback",
    });
    expect(await driver().target()).toMatchObject({
      sha: old,
      control_event_id: expect.any(String),
    });
    expect(await driver().target()).toEqual(await driver().target());
    const events = () =>
      store.uow.read((tx) => tx.events.listAfter("cardigan", undefined, 0));
    expect(currentDeploymentPin(events())?.sha).toBe(old);
    const count = events().length;
    const release = acquireDeploymentCapacity(store);
    expect(release).toBeTypeOf("function");
    try {
      await expect(
        changeDeployment(store, dataDir, human, {
          action: "unpin",
          reason: "Busy",
        }),
      ).rejects.toThrow("正在运行");
    } finally {
      release?.();
    }
    await git(source, "switch", "--detach", old);
    await writeFile(join(source, "file"), "unpublished");
    await git(source, "commit", "-am", "unpublished");
    const unmerged = await git(source, "rev-parse", "HEAD");
    await git(repo, "fetch", source, "HEAD:refs/heads/foreign");
    await expect(
      changeDeployment(store, dataDir, human, {
        action: "pin",
        sha: unmerged,
        reason: "Not on main",
      }),
    ).rejects.toThrow("main 历史");
    await expect(
      changeDeployment(store, dataDir, human, {
        action: "adopt",
        from: next,
        to: old,
        reason: "Invalid range",
      }),
    ).rejects.toThrow("main 历史");
    await expect(
      changeDeployment(
        store,
        dataDir,
        { kind: "system", project_id: "cardigan" },
        { action: "unpin", reason: "No authority" },
      ),
    ).rejects.toThrow("人类");
    expect(events()).toHaveLength(count);
    await changeDeployment(store, dataDir, human, {
      action: "unpin",
      reason: "Resume main",
    });
    expect(await driver().target()).toEqual({ sha: next });
    expect(
      events().filter((e) => e.type === "host_deployment_controlled"),
    ).toHaveLength(4);
    expect(
      events().some((e) =>
        ["card_merged", "merge_check_finished"].includes(e.type),
      ),
    ).toBe(false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
