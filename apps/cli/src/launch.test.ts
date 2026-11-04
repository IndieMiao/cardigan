import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { main } from "./index.js";
import type { CapturedOutput, CliIo, SpawnInheritOptions } from "./io.js";

/**
 * Every test builds its own fake home: configuration, secrets, generated files
 * and fake harness binaries live under a temp directory, so no real
 * `~/.config/cardigan`, `~/.claude`, `~/.codex` or `~/.pi` is read.
 */
interface Harness {
  readonly root: string;
  readonly env: Record<string, string | undefined>;
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
  readonly spawns: Array<{
    command: string;
    args: readonly string[];
    options: SpawnInheritOptions;
    filesDuringSpawn: Array<{ path: string; mode: number; content: string }>;
  }>;
  run(argv: readonly string[]): Promise<number>;
}

const SECRET_VALUES = {
  OF_AUTH_TOKEN: "sk-fictional-of-token",
  OF_API_KEY: "sk-fictional-of-api-key",
  CX_API_KEY: "sk-fictional-cx-key",
  DS_API_KEY: "sk-fictional-ds-key",
};

const LAUNCH_YAML = `providers:
  of:
    harness: claude-code
    env:
      ANTHROPIC_BASE_URL: https://of.example.invalid
    secret_env:
      ANTHROPIC_AUTH_TOKEN: OF_AUTH_TOKEN
      ANTHROPIC_API_KEY: OF_API_KEY
  cx:
    harness: codex
    env:
      OPENAI_BASE_URL: https://cx.example.invalid/v1
    secret_env:
      OPENAI_API_KEY: CX_API_KEY
  ds:
    harness: pi
    secret_env:
      DS_API_KEY: DS_API_KEY
profiles:
  claude-of:
    harness: claude-code
    provider: of
    model: opus
    permission_mode: bypassPermissions
    auto_update: false
    args: ["--effort", "low"]
  codex-yolo:
    harness: codex
    provider: cx
    model: gpt-6-astra
    config:
      model_reasoning_effort: low
    args: ["--yolo"]
  pi-deepseek:
    harness: pi
    provider: ds
    provider_flag: deepseek
    model: deepseek-flash
    agent_dir: /srv/cardigan/pi-home
`;

async function makeHarness(options?: {
  launchYaml?: string;
  secrets?: Record<string, string>;
  secretsMode?: number;
  withSecretsFile?: boolean;
}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "cardigan-cli-fake-"));
  const configDir = join(root, "config");
  const runtimeDir = join(root, "run");
  const binDir = join(root, "bin");
  await mkdir(configDir, { recursive: true });
  await mkdir(binDir, { recursive: true });

  await writeFile(
    join(configDir, "launch.yaml"),
    options?.launchYaml ?? LAUNCH_YAML,
    "utf8",
  );

  if (options?.withSecretsFile !== false) {
    const secretsPath = join(configDir, "secrets.env");
    const secrets = options?.secrets ?? SECRET_VALUES;
    await writeFile(
      secretsPath,
      `${Object.entries(secrets)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")}\n`,
      "utf8",
    );
    await writeFile(secretsPath, await readFile(secretsPath, "utf8"), "utf8");
    // chmod after writing so the umask cannot interfere.
    const { chmod } = await import("node:fs/promises");
    await chmod(secretsPath, options?.secretsMode ?? 0o600);
  }

  const out: string[] = [];
  const err: string[] = [];
  const spawns: Harness["spawns"] = [];

  const io: CliIo = {
    env: {
      HOME: root,
      PATH: `${binDir}:/usr/bin:/bin`,
      CARDIGAN_CONFIG_DIR: configDir,
      XDG_RUNTIME_DIR: runtimeDir,
    },
    cwd: root,
    platform: "linux",
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    spawnInherit: async (command, args, spawnOptions) => {
      const filesDuringSpawn = [];
      for (const file of await listRuntimeFiles(join(runtimeDir, "cardigan"))) {
        const info = await stat(file);
        filesDuringSpawn.push({
          path: file,
          mode: info.mode & 0o777,
          content: await readFile(file, "utf8"),
        });
      }
      spawns.push({ command, args, options: spawnOptions, filesDuringSpawn });
      return 0;
    },
    captureCommand: async (): Promise<CapturedOutput> => ({
      code: 0,
      stdout: "1.2.3-fictional\n",
      stderr: "",
    }),
  };

  return {
    root,
    env: io.env,
    io,
    out,
    err,
    spawns,
    run: (argv) => main(argv, io),
  };
}

function runtimeDirOf(harness: Harness): string {
  return join(harness.io.env.XDG_RUNTIME_DIR ?? "", "cardigan");
}

async function listRuntimeFiles(dir: string): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

let harness: Harness;

beforeEach(async () => {
  harness = await makeHarness();
});

afterEach(() => {
  // Temp directories are left for the OS to reap; nothing outside them is touched.
});

describe("cardigan (top level)", () => {
  test("prints usage with no arguments", async () => {
    expect(await harness.run([])).toBe(0);
    expect(harness.out.join("\n")).toContain("cardigan");
    expect(harness.out.join("\n")).toContain("launch");
  });

  test("rejects an unknown command", async () => {
    expect(await harness.run(["nope"])).toBe(2);
    expect(harness.err.join("\n")).toContain("不认识的命令");
  });
});

describe("cardigan launch --list", () => {
  test("lists profiles with harness, provider and model", async () => {
    expect(await harness.run(["launch", "--list"])).toBe(0);
    const output = harness.out.join("\n");
    expect(output).toContain("claude-of");
    expect(output).toContain("harness=claude-code");
    expect(output).toContain("provider=of");
    expect(output).toContain("model=opus");
    expect(output).toContain("pi-deepseek");
    expect(output).toContain("deepseek-flash");
    expect(output).not.toContain("sk-fictional");
  });
});

describe("cardigan launch --print", () => {
  test("shows the real command but masks secrets", async () => {
    expect(await harness.run(["launch", "claude-of", "--print"])).toBe(0);
    const output = harness.out.join("\n");

    expect(output).toContain("claude");
    expect(output).toContain("--settings");
    expect(output).toContain("bypassPermissions");
    expect(output).toContain("DISABLE_AUTOUPDATER=1");
    expect(output).toContain("ANTHROPIC_BASE_URL");
    expect(output).toContain("https://of.example.invalid");
    expect(output).toContain("***");
    for (const value of Object.values(SECRET_VALUES)) {
      expect(output).not.toContain(value);
    }
    // Printing must not create the settings file.
    expect(await listRuntimeFiles(runtimeDirOf(harness))).toEqual([]);
    expect(harness.spawns).toEqual([]);
  });

  test("prints codex arguments including -c overrides", async () => {
    expect(await harness.run(["launch", "codex-yolo", "--print"])).toBe(0);
    const output = harness.out.join("\n");
    expect(output).toContain("--profile");
    expect(output).toContain("cx");
    expect(output).toContain('model_reasoning_effort="low"');
    expect(output).not.toContain("sk-fictional");
  });

  test("prints pi arguments and PI_CODING_AGENT_DIR", async () => {
    expect(await harness.run(["launch", "pi-deepseek", "--print"])).toBe(0);
    const output = harness.out.join("\n");
    expect(output).toContain("--provider");
    expect(output).toContain("deepseek");
    expect(output).toContain("PI_CODING_AGENT_DIR=/srv/cardigan/pi-home");
    expect(output).not.toContain("sk-fictional");
  });
});

describe("cardigan launch <profile>", () => {
  test("writes the settings file with 0600, then deletes it", async () => {
    const seen: Array<{ mode: number; content: string }> = [];
    harness.io.spawnInherit = async (command, args, options) => {
      expect(command).toBe("claude");
      expect(args.slice(0, 2)).toEqual([
        "--settings",
        join(runtimeDirOf(harness), "claude-of.claude-settings.json"),
      ]);
      for (const file of await listRuntimeFiles(runtimeDirOf(harness))) {
        const info = await stat(file);
        seen.push({
          mode: info.mode & 0o777,
          content: await readFile(file, "utf8"),
        });
      }
      expect(options.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      return 0;
    };

    expect(await harness.run(["launch", "claude-of"])).toBe(0);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.mode).toBe(0o600);
    expect(JSON.parse(seen[0]?.content ?? "{}")).toEqual({
      env: {
        ANTHROPIC_BASE_URL: "https://of.example.invalid",
        ANTHROPIC_AUTH_TOKEN: SECRET_VALUES.OF_AUTH_TOKEN,
        ANTHROPIC_API_KEY: SECRET_VALUES.OF_API_KEY,
      },
    });
    expect(await listRuntimeFiles(runtimeDirOf(harness))).toEqual([]);
  });

  test("returns the CLI exit code", async () => {
    harness.io.spawnInherit = async () => 7;
    expect(await harness.run(["launch", "claude-of"])).toBe(7);
  });

  test("passes provider env and extra args for codex", async () => {
    let captured: SpawnInheritOptions | undefined;
    let capturedArgs: readonly string[] = [];
    harness.io.spawnInherit = async (_command, args, options) => {
      capturedArgs = args;
      captured = options;
      return 0;
    };

    expect(
      await harness.run(["launch", "codex-yolo", "--", "exec", "do it"]),
    ).toBe(0);
    expect(capturedArgs).toEqual([
      "--profile",
      "cx",
      "-m",
      "gpt-6-astra",
      "-c",
      'model_reasoning_effort="low"',
      "--yolo",
      "exec",
      "do it",
    ]);
    expect(captured?.env.OPENAI_API_KEY).toBe(SECRET_VALUES.CX_API_KEY);
    expect(captured?.env.OUTER_VAR).toBeUndefined();
  });

  test("honours --cwd", async () => {
    let captured: SpawnInheritOptions | undefined;
    harness.io.spawnInherit = async (_command, _args, options) => {
      captured = options;
      return 0;
    };
    expect(await harness.run(["launch", "pi-deepseek", "--cwd", "/tmp"])).toBe(
      0,
    );
    expect(captured?.cwd).toBe("/tmp");
  });

  test("reports a missing CLI binary as exit 127", async () => {
    harness.io.spawnInherit = async () => {
      const error = new Error("spawn claude ENOENT") as Error & {
        code: string;
      };
      error.code = "ENOENT";
      throw error;
    };
    expect(await harness.run(["launch", "claude-of"])).toBe(127);
    expect(harness.err.join("\n")).toContain("没有找到 claude");
    // The temp file is still removed after a failed spawn.
    expect(await listRuntimeFiles(runtimeDirOf(harness))).toEqual([]);
  });

  test("rejects a secrets file with 0644 permissions", async () => {
    harness = await makeHarness({ secretsMode: 0o644 });
    expect(await harness.run(["launch", "claude-of"])).toBe(2);
    const error = harness.err.join("\n");
    expect(error).toContain("chmod 600");
    expect(error).not.toContain("sk-fictional");
    expect(harness.spawns).toEqual([]);
  });

  test("names the missing secret without printing values", async () => {
    harness = await makeHarness({
      secrets: { OF_AUTH_TOKEN: SECRET_VALUES.OF_AUTH_TOKEN },
    });
    expect(await harness.run(["launch", "claude-of"])).toBe(2);
    const error = harness.err.join("\n");
    expect(error).toContain("OF_API_KEY");
    expect(error).not.toContain("sk-fictional");
  });

  test("rejects an unknown profile and lists the known ones", async () => {
    expect(await harness.run(["launch", "nope"])).toBe(2);
    const error = harness.err.join("\n");
    expect(error).toContain("没有名为 nope");
    expect(error).toContain("claude-of");
  });

  test("works without a secrets file when no secret is needed", async () => {
    harness = await makeHarness({
      launchYaml: "profiles:\n  pi-plain:\n    harness: pi\n",
      withSecretsFile: false,
    });
    harness.io.spawnInherit = async () => 0;
    expect(await harness.run(["launch", "pi-plain"])).toBe(0);
  });

  test("rejects unknown options", async () => {
    expect(await harness.run(["launch", "claude-of", "--wat"])).toBe(2);
    expect(harness.err.join("\n")).toContain("不认识的选项");
  });

  test("reports a missing launch.yaml", async () => {
    const root = await mkdtemp(join(tmpdir(), "cardigan-cli-empty-"));
    harness.io.env.CARDIGAN_CONFIG_DIR = join(root, "config");
    expect(await harness.run(["launch", "--list"])).toBe(2);
    expect(harness.err.join("\n")).toContain("找不到启动配置");
  });
});

describe("cardigan launch check", () => {
  test("reports missing secrets and a missing CLI", async () => {
    harness = await makeHarness({
      secrets: { OF_AUTH_TOKEN: SECRET_VALUES.OF_AUTH_TOKEN },
    });
    const code = await harness.run(["launch", "check", "claude-of"]);
    expect(code).toBe(1);
    const output = harness.out.join("\n");
    expect(output).toContain("OF_AUTH_TOKEN（已设置） → ANTHROPIC_AUTH_TOKEN");
    expect(output).toContain("OF_API_KEY（缺失） → ANTHROPIC_API_KEY");
    expect(output).toContain("PATH 里没有");
    expect(output).not.toContain("sk-fictional");
  });

  test("passes when the CLI and secrets are present", async () => {
    const binDir = join(harness.root, "bin");
    await writeFile(join(binDir, "claude"), "#!/bin/sh\necho fake\n", {
      mode: 0o755,
    });
    const code = await harness.run(["launch", "check", "claude-of"]);
    expect(harness.out.join("\n")).toContain("版本：1.2.3-fictional");
    expect(code).toBe(0);
  });

  test("fails on a secrets file with 0644 permissions", async () => {
    harness = await makeHarness({ secretsMode: 0o644 });
    const code = await harness.run(["launch", "check", "claude-of"]);
    expect(code).toBe(1);
    expect(harness.out.join("\n")).toContain("chmod 600");
  });
});

describe("cardigan launch import-claude-settings", () => {
  test("moves secrets into secrets.env and keeps the rest in launch.yaml", async () => {
    const settingsPath = join(harness.root, "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://imported.example.invalid",
          ANTHROPIC_AUTH_TOKEN: "sk-fictional-imported-token",
          ANTHROPIC_MODEL: "opus",
        },
      }),
      "utf8",
    );

    const fresh = await mkdtemp(join(tmpdir(), "cardigan-cli-import-"));
    harness.io.env.CARDIGAN_CONFIG_DIR = join(fresh, "config");

    expect(
      await harness.run([
        "launch",
        "import-claude-settings",
        settingsPath,
        "--provider",
        "imported",
      ]),
    ).toBe(0);

    const configDir = harness.io.env.CARDIGAN_CONFIG_DIR ?? "";
    const launchYaml = await readFile(join(configDir, "launch.yaml"), "utf8");
    const secretsEnv = await readFile(join(configDir, "secrets.env"), "utf8");
    const launchMode =
      (await stat(join(configDir, "launch.yaml"))).mode & 0o777;
    const secretsMode =
      (await stat(join(configDir, "secrets.env"))).mode & 0o777;

    expect(launchYaml).toContain("imported");
    expect(launchYaml).toContain("https://imported.example.invalid");
    expect(launchYaml).not.toContain("sk-fictional-imported-token");
    expect(secretsEnv).toContain(
      "ANTHROPIC_AUTH_TOKEN=sk-fictional-imported-token",
    );
    expect(launchMode).toBe(0o600);
    expect(secretsMode).toBe(0o600);

    const printed = [...harness.out, ...harness.err].join("\n");
    expect(printed).not.toContain("sk-fictional-imported-token");
    expect(printed).toContain("ANTHROPIC_AUTH_TOKEN");

    // The imported provider is usable right away.
    expect(await harness.run(["launch", "--list"])).toBe(0);
    expect(harness.out.join("\n")).toContain("imported");
  });

  test("rejects a settings file without env", async () => {
    const settingsPath = join(harness.root, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ permissions: {} }), "utf8");
    expect(
      await harness.run([
        "launch",
        "import-claude-settings",
        settingsPath,
        "--provider",
        "p",
      ]),
    ).toBe(2);
    expect(harness.err.join("\n")).toContain("没有 env");
  });

  test("rejects a missing --provider", async () => {
    expect(
      await harness.run(["launch", "import-claude-settings", "settings.json"]),
    ).toBe(2);
    expect(harness.err.join("\n")).toContain("--provider");
  });
});
