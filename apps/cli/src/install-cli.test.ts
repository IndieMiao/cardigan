import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";

const installer = fileURLToPath(
  new URL("../../../deploy/install-cli.sh", import.meta.url),
);
let root: string;
let repo: string;
let binDir: string;
let runtimeEnv: string;
let env: NodeJS.ProcessEnv;

function file(path: string, contents: string, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { mode });
}
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}
function install(args: string[] = []) {
  return run(installer, [
    "--repo",
    repo,
    "--bin-dir",
    binDir,
    "--runtime-env",
    runtimeEnv,
    ...args,
  ]);
}
function configure(mode = "agent-ssh") {
  file(
    runtimeEnv,
    `CARDIGAN_RUNTIME_MODE='${mode}'\nCARDIGAN_DATA_DIR='data directory'\n`,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cardigan-cli-install-"));
  repo = join(root, "repo ; ' \" {x} $(touch injected-repo)");
  binDir = join(root, "bin directory");
  runtimeEnv = join(root, "config ' $(touch injected-config)", "runtime.env");
  const mockBin = join(root, "mock-bin");
  env = {
    HOME: join(root, "home"),
    PATH: `${mockBin}:${process.env.PATH}`,
  };
  file(
    join(repo, "apps/cli/dist/bin.js"),
    `console.log(JSON.stringify({
      args: process.argv.slice(2),
      mode: process.env.CARDIGAN_RUNTIME_MODE ?? null,
      data: process.env.CARDIGAN_DATA_DIR ?? null,
      sg: process.env.CLI_TEST_SG === '1',
      cwd: process.cwd(),
    }));
    process.exitCode = Number(process.env.CLI_TEST_EXIT ?? 0);\n`,
  );
  file(
    join(mockBin, "id"),
    `#!/bin/sh
[ "$#" -eq 1 ] && [ "$1" = -Gn ] || exit 91
printf '%s\\n' "\${CLI_TEST_GROUPS:-operator}"
`,
    0o755,
  );
  // Execute the actual command string with a shell, without changing OS groups.
  file(
    join(mockBin, "sg"),
    `#!/bin/sh
[ "$#" -eq 3 ] && [ "$1" = cardigan-share ] && [ "$2" = -c ] || exit 92
export CLI_TEST_SG=1
exec /bin/sh -c "$3"
`,
    0o755,
  );
  symlinkSync(process.execPath, join(mockBin, "node"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("installs an executable marked wrapper and replaces a managed version", () => {
  expect(install().status).toBe(0);
  const target = join(binDir, "cardigan");
  const content = readFileSync(target, "utf8");
  expect(content.split("\n").slice(0, 2)).toEqual([
    "#!/bin/sh",
    "# cardigan: managed by deploy/install-cli.sh",
  ]);
  expect(content).toContain("apps/cli/dist/bin.js");
  expect(statSync(target).mode & 0o777).toBe(0o755);
  file(target, "#!/bin/sh\n# cardigan: old managed wrapper\nexit 99\n");
  expect(install().status).toBe(0);
  expect(readFileSync(target, "utf8")).toBe(content);
});

test("defaults to the script's repository and the host user's bin and config paths", () => {
  const copy = join(repo, "deploy/install-cli.sh");
  mkdirSync(dirname(copy), { recursive: true });
  copyFileSync(installer, copy);
  chmodSync(copy, 0o755);
  runtimeEnv = join(
    env.HOME as string,
    ".config/cardigan/agent-ssh/runtime.env",
  );
  configure();
  expect(run(copy, []).status).toBe(0);
  const result = run(join(env.HOME as string, ".local/bin/cardigan"), ["help"]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    args: ["help"],
    mode: "agent-ssh",
    sg: true,
  });
});

test("refuses an unmarked file without modifying its contents or permissions", () => {
  const target = join(binDir, "cardigan");
  const content = "#!/bin/sh\necho user-owned\n# cardigan: wrong line\n";
  file(target, content, 0o700);
  const result = install();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("第二行没有 # cardigan: 标记");
  expect(readFileSync(target, "utf8")).toBe(content);
  expect(statSync(target).mode & 0o777).toBe(0o700);
});

test("refuses symlinks even when their destination is a marked wrapper", () => {
  const original = join(root, "original");
  file(original, "#!/bin/sh\n# cardigan: managed elsewhere\n");
  mkdirSync(binDir);
  symlinkSync(original, join(binDir, "cardigan"));
  expect(install().stderr).toContain("不是普通文件");
  expect(readFileSync(original, "utf8")).toContain("managed elsewhere");
});

test("dry-run prints the wrapper without creating or replacing files", () => {
  const result = install(["--dry-run"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(
    "# cardigan: managed by deploy/install-cli.sh",
  );
  expect(existsSync(binDir)).toBe(false);
  const target = join(binDir, "cardigan");
  const content = "#!/bin/sh\n# cardigan: old wrapper\n";
  file(target, content);
  expect(install(["--dry-run"]).status).toBe(0);
  expect(readFileSync(target, "utf8")).toBe(content);
});

test.each([
  { config: false, groups: "operator", sg: false },
  { config: true, groups: "operator", sg: true },
  { config: true, groups: "operator cardigan-share extra", sg: false },
  { config: true, groups: "cardigan-share-extra", sg: true },
])(
  "preserves arguments and environment with $config config and $groups groups",
  ({ config, groups, sg }) => {
    if (config) configure();
    env.CLI_TEST_GROUPS = groups;
    env.CLI_TEST_EXIT = "17";
    expect(install().status).toBe(0);
    const args = [
      "",
      "two words",
      "x; touch injected-semicolon",
      "single'quote",
      'double"quote',
      "{one,two}",
      "$(touch injected-dollar)",
      "`touch injected-backtick`",
      "'; touch injected-quote; #",
      "\\ $HOME * ? [abc]",
      "中文\ntrailing newlines\n\n",
    ];
    const result = run(join(binDir, "cardigan"), args);
    expect(result.status).toBe(17);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      args,
      mode: config ? "agent-ssh" : null,
      data: config ? "data directory" : null,
      sg,
      cwd: root,
    });
    for (const kind of [
      "repo",
      "config",
      "semicolon",
      "dollar",
      "backtick",
      "quote",
    ])
      expect(existsSync(join(root, `injected-${kind}`))).toBe(false);
  },
);

test("local runtime configuration runs directly without the shared group", () => {
  configure("local");
  expect(install().status).toBe(0);
  const result = run(join(binDir, "cardigan"), []);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ mode: "local", sg: false });
});

test("resolves relative install and config paths at installation time", () => {
  runtimeEnv = join(root, "runtime.env");
  configure();
  expect(
    install(["--bin-dir", "relative-bin", "--runtime-env", "runtime.env"])
      .status,
  ).toBe(0);
  const result = spawnSync(join(root, "relative-bin/cardigan"), [], {
    cwd: repo,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    mode: "agent-ssh",
    cwd: repo,
  });
});

test("reports a missing build before creating the destination", () => {
  rmSync(join(repo, "apps/cli/dist/bin.js"));
  const result = install();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("pnpm exec tsc -b apps/cli");
  expect(existsSync(binDir)).toBe(false);
});

test.each(["--repo", "--bin-dir", "--runtime-env", "--unknown"])(
  "rejects invalid arguments: %s",
  (option) => {
    expect(install([option]).status).not.toBe(0);
    expect(existsSync(binDir)).toBe(false);
  },
);
