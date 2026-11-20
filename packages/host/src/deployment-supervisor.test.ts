import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { writeDeploymentNotice } from "./deployment-audit.js";
import { NodeDeploymentDriver } from "./deployment-node.js";

// Only redirect discovery of the stable checkout's HEAD; main, ancestry, diff and blobs use real Git.
test("watch retires false alarms, retries unknown evidence, and asks exactly once for a real change", async () => {
  const root = await mkdtemp(join(tmpdir(), "cg-supervisor-"));
  const store = Store.open({ dataDir: root, dbPath: ":memory:" });
  const repo = join(root, "work");
  const bin = join(root, "bin");
  const git = async (...args: string[]) =>
    (
      await promisify(execFile)(
        "git",
        [
          "-c",
          "user.name=fixture",
          "-c",
          "user.email=fixture@example.invalid",
          ...args,
        ],
        { cwd: repo },
      )
    ).stdout.trim();
  const commit = async (path: string, content: string) => {
    await writeFile(join(repo, path), content);
    await git("add", "--", path);
    await git("commit", "-qm", "test: change");
    return git("rev-parse", "HEAD");
  };
  const actions = () =>
    store.uow.read((tx) => tx.human_actions.list("cardigan"));
  try {
    store.createProject({ id: "cardigan" });
    for (const dir of [
      "bin",
      "central",
      "self-deploy",
      "work/apps/web",
      "work/packages/host/src",
    ])
      await mkdir(join(root, dir), { recursive: true });
    await git(
      "init",
      "-qb",
      "main",
      "--separate-git-dir",
      join(root, "central/cardigan.git"),
    );
    const lockfile =
      "lockfileVersion: '9.0'\nimporters: {}\npackages: {}\nsnapshots: {}\n";
    await commit("pnpm-lock.yaml", lockfile);
    const supervisor = await commit("package.json", "{}");
    const script = `#!/bin/sh\nfor arg do if [ "$arg" = -C ]; then echo ${supervisor}; exit 0; fi; done\nPATH=\${PATH#*:} exec git "$@"\n`;
    await writeFile(join(bin, "git"), script, { mode: 0o700 });
    const driver = () =>
      new NodeDeploymentDriver({
        store,
        dataDir: root,
        config: {
          enabled: true,
          initial_sha: supervisor,
          initial_release: repo,
          ready_timeout_ms: 1000,
          stop_timeout_ms: 1000,
          poll_interval_ms: 1000,
          build_timeout_ms: 5000,
        },
        env: { PATH: `${bin}:${process.env.PATH}` },
      });
    const watch = driver();
    await commit("apps/web/view.ts", "web");
    await watch.main();
    expect(actions()).toHaveLength(0);
    writeDeploymentNotice(
      store,
      `supervisor-outdated:${supervisor}`,
      "old warning",
    );
    writeDeploymentNotice(
      store,
      "deployment-config-invalid",
      "keep this action",
    );
    const bad = await commit("package.json", "not valid JSON");
    expect(await watch.main()).toBe(bad);
    await watch.main();
    await driver().main();
    const unknown = () =>
      store
        .getUpdates({ project_id: "cardigan" })
        .events.filter(
          (e) => e.type === "host_deployment_supervisor_comparison_unavailable",
        )
        .map((e) => e.payload);
    expect(unknown()).toEqual([{ supervisor, main: bad }]);
    expect(actions().map((h) => h.status)).toEqual(["open", "open"]);
    await commit("package.json", "{}");
    await watch.main();
    expect(actions()).toMatchObject([
      {
        status: "cancelled",
        cancellation: { reason: expect.stringContaining("无需升级") },
      },
      { status: "open" },
    ]);
    // The lockfile remains valid, but its blob exceeds the bounded Git read. It is not evidence either way.
    const oversized = await commit(
      "pnpm-lock.yaml",
      `${lockfile}#${"x".repeat(2 * 1024 * 1024)}\n`,
    );
    await watch.main();
    expect(actions().map((h) => h.status)).toEqual(["cancelled", "open"]);
    const main = await commit(
      "packages/host/src/deployment-config.ts",
      "config",
    );
    await watch.main();
    await watch.main();
    await driver().main();
    expect(actions()).toHaveLength(3);
    expect(unknown()).toEqual([
      { supervisor, main: bad },
      { supervisor, main: oversized },
    ]);
    const current = actions().at(-1);
    expect(current?.status).toBe("open");
    expect(current?.instructions).not.toContain("pnpm-lock.yaml");
    for (const part of [
      supervisor,
      main,
      "packages/host",
      "cardigan-deploy README「升级监督器本身」",
    ])
      expect(current?.instructions).toContain(part);
    const cancelled = store
      .getUpdates({ project_id: "cardigan" })
      .events.filter((e) => e.type === "human_action_cancelled");
    expect(cancelled).toMatchObject([
      { payload: { reason: expect.stringContaining("无需升级") } },
    ]);
    // After an operator upgrades the stable checkout, the old SHA is no longer active.
    await writeFile(join(bin, "git"), script.replace(supervisor, main));
    await driver().main();
    expect(
      actions().find((h) => h.id === current?.id)?.cancellation?.reason,
    ).toContain("已不在运行");
    expect(actions().filter((h) => h.status === "open")).toMatchObject([
      { instructions: "keep this action" },
    ]);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
