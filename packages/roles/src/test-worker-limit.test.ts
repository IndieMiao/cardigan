import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";
import { instructionsFor } from "./role-pack.js";
import { testWorkerLimit } from "./test-worker-limit.js";

const exec = promisify(execFile);
let dir: string, cli: string, env: NodeJS.ProcessEnv;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cg-test limit-"));
  const limit = testWorkerLimit(dir, 2);
  await writeFile(limit.file.path, limit.file.content);
  cli = join(dir, "vitest.mjs");
  await writeFile(
    cli,
    "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n",
    { mode: 0o700 },
  );
  env = { ...process.env, NODE_OPTIONS: limit.nodeOptions };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test.each([
  [[], ["--maxWorkers=2"]],
  [["--maxWorkers", "8"], ["--maxWorkers=2"]],
  [["--maxWorkers=100%"], ["--maxWorkers=2"]],
  [["--max-workers=9", "--maxWorkers=8"], ["--maxWorkers=2"]],
  [["--maxWorkers=1"], ["--maxWorkers=1"]],
  [
    ["--", "some.test.ts"],
    ["--maxWorkers=2", "--", "some.test.ts"],
  ],
])(
  "published CLI clamps args %j before option parsing",
  async (args, expected) => {
    const result = await exec(process.execPath, [cli, "run", ...args], { env });
    expect(JSON.parse(result.stdout)).toEqual(["run", ...expected]);
  },
);

test("root scripts, filtered scripts and direct bin invocation inherit the guard", async () => {
  await mkdir(join(dir, "child"));
  await mkdir(join(dir, "bin"));
  await symlink(cli, join(dir, "bin", "vitest"));
  await writeFile(join(dir, "pnpm-workspace.yaml"), "packages: ['child']\n");
  for (const [folder, name, script] of [
    [dir, "fixture-root", "node vitest.mjs run --maxWorkers=8"],
    [
      join(dir, "child"),
      "fixture-child",
      "node ../vitest.mjs run --maxWorkers=8",
    ],
  ] as const)
    await writeFile(
      join(folder, "package.json"),
      JSON.stringify({ name, scripts: { test: script } }),
    );
  for (const args of [["test"], ["--filter", "fixture-child", "test"]]) {
    const result = await exec("pnpm", args, { cwd: dir, env });
    expect(result.stdout).toContain('["run","--maxWorkers=2"]');
  }
  expect(
    (
      await exec("vitest", ["run", "--maxWorkers=8"], {
        env: { ...env, PATH: `${join(dir, "bin")}:${env.PATH}` },
      })
    ).stdout,
  ).toContain('["run","--maxWorkers=2"]');
});

// Probe the installed Vitest parser, not an argv echo. onInit runs before test
// workers are started, so even a broken guard cannot create an oversized pool.
async function realVitestProbe() {
  const vitestCli = fileURLToPath(
    new URL("./vitest.mjs", import.meta.resolve("vitest/package.json")),
  );
  await mkdir(join(dir, "bin"));
  await symlink(vitestCli, join(dir, "bin", "vitest"));
  const config = join(dir, "vitest.config.mjs");
  await writeFile(
    config,
    `export default { test: {
      maxWorkers: 12,
      projects: [{ test: { name: 'probe', maxWorkers: 16 } }],
      reporters: [{ onInit(ctx) {
        process.stdout.write('WORKER_LIMIT=' + JSON.stringify({
          root: ctx.config.maxWorkers,
          projects: ctx.projects.map(project => project.config.maxWorkers),
          env: process.env.VITEST_MAX_WORKERS,
        }) + '\\n', () => process.exit(0));
      } }],
    } };`,
  );
  return {
    args: ["run", "--config", config],
    env: { ...env, PATH: `${join(dir, "bin")}:${env.PATH}` },
  };
}

function parsedWorkers(stdout: string) {
  const line = stdout
    .split("\n")
    .find((line) => line.startsWith("WORKER_LIMIT="));
  expect(line, stdout).toBeDefined();
  return JSON.parse(line?.slice("WORKER_LIMIT=".length) ?? "null");
}

test.each(["root", "filtered", "direct"])(
  "real Vitest clamps inherited/script environment in %s invocation",
  async (invocation) => {
    const probe = await realVitestProbe();
    await mkdir(join(dir, "child"));
    await writeFile(join(dir, "pnpm-workspace.yaml"), "packages: ['child']\n");
    for (const folder of [dir, join(dir, "child")]) {
      await writeFile(
        join(folder, "package.json"),
        JSON.stringify({
          name: folder === dir ? "fixture-root" : "fixture-child",
          scripts: {
            test: `VITEST_MAX_WORKERS=8 vitest run --config ${folder === dir ? "vitest.config.mjs" : "../vitest.config.mjs"} --maxWorkers=8`,
          },
        }),
      );
    }
    const command = invocation === "direct" ? "vitest" : "pnpm";
    const args =
      invocation === "direct"
        ? [...probe.args, "--maxWorkers=8"]
        : invocation === "root"
          ? ["test"]
          : ["--filter", "fixture-child", "test"];
    const result = await exec(command, args, {
      cwd: dir,
      env: { ...probe.env, VITEST_MAX_WORKERS: "8" },
      timeout: 5000,
    });
    expect(parsedWorkers(result.stdout)).toEqual({
      root: 2,
      projects: [2],
      env: "2",
    });
  },
);

test.each([
  { inherited: "1", cliLimit: "8", expected: 1 },
  { inherited: "8", cliLimit: "1", expected: 1 },
  { inherited: "100%", cliLimit: "8", expected: 2 },
  { inherited: "invalid", cliLimit: "8", expected: 2 },
  { inherited: "0", cliLimit: "8", expected: 2 },
])(
  "real Vitest normalizes env=$inherited and CLI=$cliLimit to $expected",
  async ({ inherited, cliLimit, expected }) => {
    const probe = await realVitestProbe();
    const result = await exec(
      "vitest",
      [...probe.args, `--maxWorkers=${cliLimit}`, "--", "some.test.ts"],
      { env: { ...probe.env, VITEST_MAX_WORKERS: inherited }, timeout: 5000 },
    );
    expect(parsedWorkers(result.stdout)).toEqual({
      root: expected,
      projects: [expected],
      env: String(expected),
    });
  },
);

test("real Vitest outside employee injection keeps maxWorkers=4", async () => {
  const probe = await realVitestProbe();
  const manualEnv: NodeJS.ProcessEnv = { ...probe.env };
  delete manualEnv.NODE_OPTIONS;
  delete manualEnv.VITEST_MAX_WORKERS;
  const result = await exec("vitest", [...probe.args, "--maxWorkers=4"], {
    env: manualEnv,
    timeout: 5000,
  });
  expect(parsedWorkers(result.stdout)).toEqual({ root: 4, projects: [4] });
});

test("competing and nested invocations fail promptly; process death releases the lock", async () => {
  await writeFile(cli, "console.log('ready'); process.stdin.resume();\n");
  const first = spawn(process.execPath, [cli], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(first, "close");
  try {
    await once(first.stdout, "data");
    await expect(
      exec(process.execPath, [cli], { env, timeout: 2000 }),
    ).rejects.toMatchObject({ code: 75 });
  } finally {
    first.kill("SIGKILL");
    await closed;
  }
  await writeFile(cli, "console.log('released')\n");
  expect((await exec(process.execPath, [cli], { env })).stdout).toBe(
    "released\n",
  );
  await writeFile(
    cli,
    "import { spawnSync } from 'node:child_process'; console.log(spawnSync(process.execPath, [process.argv[1]], { encoding: 'utf8' }).status);\n",
  );
  expect(
    (await exec(process.execPath, [cli], { env, timeout: 2000 })).stdout,
  ).toBe("75\n");
});

test("manual tests and other Node entrypoints keep their arguments", async () => {
  const manualEnv = { ...env };
  delete manualEnv.NODE_OPTIONS;
  expect(
    (await exec(process.execPath, [cli, "--maxWorkers=4"], { env: manualEnv }))
      .stdout,
  ).toContain('["--maxWorkers=4"]');
  expect(
    (await exec(process.execPath, ["-e", "console.log('unrelated')"], { env }))
      .stdout,
  ).toBe("unrelated\n");
});

test.each(["coder", "reviewer", "tester"] as const)(
  "%s states the self-test limit",
  (role) => {
    expect(instructionsFor(role)).toContain(
      "不超过主机限流配置的上限（启动时已强制）",
    );
    expect(instructionsFor(role)).not.toMatch(/\d+ 个 worker/);
    expect(instructionsFor(role)).toContain("不要设法绕过");
  },
);
