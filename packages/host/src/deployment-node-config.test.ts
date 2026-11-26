import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { afterEach, expect, test } from "vitest";
import { deploymentDirectory } from "./deployment-config.js";
import { NodeDeploymentDriver } from "./deployment-node.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

/** A release whose host package answers like the real checker would. */
const CHECKER = `import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
export async function checkHostConfig(input) {
  writeFileSync(process.env.TRIAL_SEEN ?? join(input.dataDir, 'trial-seen.json'),
    JSON.stringify({ ...input, files: readdirSync(input.configDir).sort() }));
  const text = readFileSync(join(input.configDir, 'merge-gate.yaml'), 'utf8');
  const broken = text.includes('[');
  process.stdout.write('noise before the result\\n');
  return { ok: !broken, files: [{ file: 'merge-gate.yaml',
    status: broken ? 'invalid' : 'ok',
    errors: broken ? ['merge-gate.yaml 语法无效，所有项目暂停合并'] : [] }] };
}`;

async function setup(checker: string | undefined) {
  const root = await mkdtemp(join(tmpdir(), "cg-config-trial-"));
  roots.push(root);
  const dataDir = join(root, "data");
  const configDir = join(root, "config");
  const release = join(root, "release");
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(configDir, { mode: 0o700 });
  await mkdir(deploymentDirectory(dataDir), { mode: 0o700 });
  await mkdir(join(release, "packages/host/dist"), { recursive: true });
  await chmod(root, 0o700);
  await writeFile(join(release, "package.json"), '{"type":"module"}');
  await writeFile(
    join(release, "packages/host/dist/index.js"),
    checker ?? "export const other = 1;",
  );
  const store = Store.open({ dataDir });
  store.createProject({ id: "cardigan" });
  const driver = new NodeDeploymentDriver({
    store,
    dataDir,
    configDir,
    config: {
      enabled: true,
      initial_release: release,
      initial_sha: "a".repeat(40),
      ready_timeout_ms: 1000,
      stop_timeout_ms: 1000,
      build_timeout_ms: 20_000,
      poll_interval_ms: 1000,
    },
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  return {
    store,
    driver,
    dataDir,
    configDir,
    build: { sha: "b".repeat(40), release },
  };
}

test("C-792: the new release loads a private copy; the real file is never touched", async () => {
  const s = await setup(CHECKER);
  try {
    const real = join(s.configDir, "merge-gate.yaml");
    await writeFile(real, "projects:\n  cardigan: [\n", { mode: 0o600 });
    const rejected = await s.driver.checkConfig(s.build);
    expect(rejected).toEqual({
      ok: false,
      errors: ["merge-gate.yaml：merge-gate.yaml 语法无效，所有项目暂停合并"],
      fingerprint: await s.driver.configFingerprint(),
    });
    const seen = JSON.parse(
      await readFile(join(s.dataDir, "trial-seen.json"), "utf8"),
    );
    expect(seen.configDir).not.toBe(s.configDir);
    expect(seen.configDir.startsWith(deploymentDirectory(s.dataDir))).toBe(
      true,
    );
    expect(seen.files).toEqual(["merge-gate.yaml"]);
    expect(seen.dataDir).toBe(s.dataDir);
    expect(seen.projects).toEqual([{ id: "cardigan", base_branch: "main" }]);
    // The copy is gone and the real file is unchanged.
    expect(
      (await readdir(deploymentDirectory(s.dataDir))).filter((n) =>
        n.startsWith("config-trial-"),
      ),
    ).toEqual([]);
    expect(await readFile(real, "utf8")).toBe("projects:\n  cardigan: [\n");

    await writeFile(real, "projects: {}\n", { mode: 0o600 });
    expect(await s.driver.checkConfig(s.build)).toMatchObject({
      ok: true,
      errors: [],
    });
  } finally {
    s.store.close();
  }
});

test("C-792: an older release without the checker is not held; a crashing checker fails closed", async () => {
  const older = await setup(undefined);
  try {
    expect(await older.driver.checkConfig(older.build)).toMatchObject({
      ok: true,
    });
  } finally {
    older.store.close();
  }
  const crash = await setup(
    "export async function checkHostConfig() { throw new Error('boom'); }",
  );
  try {
    expect(await crash.driver.checkConfig(crash.build)).toEqual({
      ok: false,
      errors: ["主机配置试加载未能运行"],
    });
  } finally {
    crash.store.close();
  }
});
