import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(instructionsFor(role)).toContain("最多使用 2 个 worker");
    expect(instructionsFor(role)).toContain("不要设法绕过");
  },
);
