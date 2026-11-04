import { execFileSync, spawn } from "node:child_process";
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
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * End-to-end check of the reviewer's reproduction: the parent must survive
 * Ctrl+C (SIGINT to the foreground process group) while the harness CLI is
 * still running, and the settings file that holds secrets must be deleted
 * only after the CLI exits.
 *
 * A real Node process runs `dist/bin.js` in its own process group; the fake
 * `claude` script traps SIGINT and keeps working, like a real agent that was
 * only interrupted mid-turn.
 */

const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const distBin = join(cliRoot, "dist", "bin.js");
const workspaceRoot = join(cliRoot, "..", "..");

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  label: string,
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 10000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await sleep(50);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "EPERM"
    );
  }
}

async function settingsFiles(runtimeDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(runtimeDir, "cardigan"));
    return entries.filter((entry) => entry.endsWith(".claude-settings.json"));
  } catch {
    return [];
  }
}

describe.skipIf(process.platform === "win32")("launch signal handling", () => {
  test("parent survives SIGINT to the process group and cleans up after the CLI", async () => {
    // Build the CLI so the test runs the code under review, not a stale build.
    execFileSync(
      join(workspaceRoot, "node_modules", ".bin", "tsc"),
      ["-b", "."],
      { cwd: cliRoot, stdio: "ignore" },
    );

    const root = await mkdtemp(join(tmpdir(), "cardigan-signal-"));
    const configDir = join(root, "config");
    const binDir = join(root, "bin");
    const runtimeDir = join(root, "run");
    const workDir = join(root, "work");
    const markFile = join(root, "harness.log");
    await mkdir(configDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await mkdir(workDir, { recursive: true });

    await writeFile(
      join(configDir, "launch.yaml"),
      [
        "providers:",
        "  fake:",
        "    harness: claude-code",
        "    env:",
        "      ANTHROPIC_BASE_URL: https://fake.example.invalid",
        "    secret_env:",
        "      ANTHROPIC_AUTH_TOKEN: FAKE_TOKEN",
        "profiles:",
        "  fake-claude:",
        "    harness: claude-code",
        "    provider: fake",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(configDir, "secrets.env"),
      "FAKE_TOKEN=sk-fictional-signal-test\n",
      "utf8",
    );
    await chmod(join(configDir, "secrets.env"), 0o600);

    // The fake harness ignores SIGINT (traps it, keeps working for ~1.5s) and
    // exits with code 3, like an agent that finishes its turn.
    await writeFile(
      join(binDir, "claude"),
      [
        "#!/bin/sh",
        `MARK=${JSON.stringify(markFile)}`,
        'echo started >> "$MARK"',
        "trap 'echo caught-int >> \"$MARK\"' INT",
        "i=0",
        'while [ "$i" -lt 15 ]; do',
        "  sleep 0.1",
        "  i=$((i + 1))",
        "done",
        'echo finished >> "$MARK"',
        "exit 3",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(join(binDir, "claude"), 0o755);

    const child = spawn(process.execPath, [distBin, "launch", "fake-claude"], {
      cwd: workDir,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        CARDIGAN_CONFIG_DIR: configDir,
        XDG_RUNTIME_DIR: runtimeDir,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });
    const parentPid = child.pid;
    expect(parentPid).toBeTypeOf("number");
    if (parentPid === undefined) {
      throw new Error("no pid");
    }

    const exited = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );

    try {
      // The harness has started and the settings file exists.
      await waitFor("harness start", async () =>
        (await readFile(markFile, "utf8").catch(() => "")).includes("started")
          ? true
          : undefined,
      );
      await waitFor("settings file", async () => {
        const files = await settingsFiles(runtimeDir);
        return files.length === 1 ? files[0] : undefined;
      });

      // Ctrl+C: the terminal sends SIGINT to the whole foreground process group.
      process.kill(-parentPid, "SIGINT");

      // The harness saw the signal and kept running.
      await waitFor("harness INT trap", async () =>
        (await readFile(markFile, "utf8").catch(() => "")).includes(
          "caught-int",
        )
          ? true
          : undefined,
      );

      // The parent is still alive while the CLI runs, and the settings file is
      // still on disk because the CLI may still need it.
      expect(isAlive(parentPid)).toBe(true);
      expect(await settingsFiles(runtimeDir)).toHaveLength(1);

      // Only after the CLI exits does the parent return its exit code and
      // remove the settings file.
      const result = await exited;
      expect(result).toEqual({ code: 3, signal: null });
      expect(await settingsFiles(runtimeDir)).toEqual([]);
      expect(await readFile(markFile, "utf8")).toContain("finished");
    } finally {
      if (isAlive(parentPid)) {
        process.kill(-parentPid, "SIGKILL");
      }
      // Do not leave the fixture directory behind.
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
