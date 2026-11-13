import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type AgentExecution,
  clearAgentSentinel,
  prepareAgentCheckout,
  prepareAgentProject,
  prepareCheckLock,
  prepareCheckoutAlias,
  scrubAgentLaunch,
  secureDataDirectory,
  writeAgentLaunch,
  writeAgentSentinel,
} from "./agent-files.js";
import { executionPaths } from "./execution.js";

// No sudo, chown to another UID or real agent account: exercise the host's own group.
describe.skipIf(process.platform !== "linux")("shared launch files", () => {
  let root: string, config: AgentExecution, runDir: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cg-files-"));
    config = {
      mode: "agent-ssh",
      dataDir: join(root, "private"),
      agentRoot: join(root, "agent"),
      gid: process.getgid?.() ?? 0,
      machine: "cardigan-agent",
      identityFile: join(root, "key"),
      knownHostsFile: join(root, "known"),
    };
    await mkdir(config.dataDir, { mode: 0o700 });
    await mkdir(config.agentRoot, { mode: 0o2750 });
    await chmod(config.agentRoot, 0o2750);
    runDir = executionPaths(config, "project", "A-1").runDir;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const mode = async (path: string) => (await stat(path)).mode & 0o7777;
  test("machine lock is a stable host-owned inode; unsafe existing files are preserved and rejected", async () => {
    const [first, second] = await Promise.all([
      prepareCheckLock(config),
      prepareCheckLock(config),
    ]);
    expect(first).toBe(second);
    expect(await mode(first)).toBe(0o660);
    expect((await stat(first)).gid).toBe(config.gid);
    const inode = (await stat(first)).ino;
    expect(await prepareCheckLock(config)).toBe(first);
    expect((await stat(first)).ino).toBe(inode);
    await writeFile(first, "not a lock");
    await expect(prepareCheckLock(config)).rejects.toThrow(/Unsafe/);
    expect(await readFile(first, "utf8")).toBe("not a lock");
  });
  test("P2a-12 D: each concurrency slot has its own lock; slot 0 keeps the historical name", async () => {
    const zero = await prepareCheckLock(config);
    expect(await prepareCheckLock(config, 0)).toBe(zero);
    expect(zero).toBe(join(config.agentRoot, "merge-check.lock"));
    const one = await prepareCheckLock(config, 1);
    expect(one).toBe(join(config.agentRoot, "merge-check-1.lock"));
    expect((await stat(one)).ino).not.toBe((await stat(zero)).ino);
    for (const slot of [-1, 1.5, 64])
      await expect(prepareCheckLock(config, slot)).rejects.toThrow(/slot/);
  });
  test.each(["local", "agent-ssh"] as const)(
    "%s short namespace rejects existing aliases and preserves their contents",
    async (modeName) => {
      const execution =
        modeName === "local"
          ? { mode: "local" as const, dataDir: config.dataDir }
          : config;
      const path = await prepareCheckoutAlias(execution, "unique");
      const base = modeName === "local" ? config.dataDir : config.agentRoot;
      expect(path).toBe(join(base, "s", "unique"));
      expect(await mode(path)).toBe(modeName === "local" ? 0o700 : 0o2770);
      expect(await mode(join(base, "s"))).toBe(
        modeName === "local" ? 0o700 : 0o2750,
      );
      await writeFile(join(path, "keep"), "existing attempt");
      await expect(
        prepareCheckoutAlias(execution, "unique"),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(join(path, "keep"), "utf8")).toBe(
        "existing attempt",
      );
      await expect(
        prepareCheckoutAlias(execution, "../escape"),
      ).rejects.toThrow();
    },
  );
  test("temporary checkout namespaces are protected, exclusive and reject links", async () => {
    const path = await prepareAgentCheckout(config, "project", "attempt-1");
    expect(path).toBe(join(config.agentRoot, "checks", "project", "attempt-1"));
    expect(await mode(path)).toBe(0o2770);
    expect(await mode(join(config.agentRoot, "checks", "project"))).toBe(
      0o2750,
    );
    await expect(
      prepareAgentCheckout(config, "project", "attempt-1"),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(
      prepareAgentCheckout(config, "project", "../escape"),
    ).rejects.toThrow();
    await symlink(config.dataDir, join(config.agentRoot, "checks", "linked"));
    await expect(
      prepareAgentCheckout(config, "linked", "attempt-2"),
    ).rejects.toThrow();
    expect(await readdir(config.dataDir)).toEqual([]);
  });
  test("prepares protected project parents and writable shared leaves, keeping data private", async () => {
    const paths = await prepareAgentProject(config, "project", "A-1");
    expect(paths.runDir).toBe(runDir);
    expect(await mode(config.dataDir)).toBe(0o700);
    expect(await mode(join(config.agentRoot, "runs", "project"))).toBe(0o2750);
    expect(await mode(join(config.agentRoot, "worktrees", "project"))).toBe(
      0o2750,
    );
    // P2a-3: build checkouts get the same host-protected namespace parent.
    expect(await mode(join(config.agentRoot, "builds", "project"))).toBe(
      0o2750,
    );
    expect(await mode(runDir)).toBe(0o2770);
    expect((await stat(runDir)).gid).toBe(config.gid);
    expect(await prepareAgentProject(config, "project", "A-1")).toEqual(paths);
    expect((await prepareAgentProject(config, "other", "A-1")).runDir).not.toBe(
      runDir,
    );
  });
  test("writes credentials 0660 and launch scripts 0770, including nested MCP configuration", async () => {
    const files = [
      {
        path: join(runDir, "launch.sh"),
        content: "#!/bin/sh\nexit 0\n",
        mode: 0o700,
      },
      {
        path: join(runDir, "secrets.env"),
        content: "KEY='fixture-only'\n",
        mode: 0o600,
      },
      {
        path: join(runDir, "codex", "config.toml"),
        content: 'bearer_token_env_var="MCP_TOKEN"',
        mode: 0o600,
      },
    ];
    await writeAgentLaunch(config, "project", "A-1", files, "fixture-token");
    for (const name of ["secrets.env", "token", "codex/config.toml"]) {
      expect(await mode(join(runDir, name))).toBe(0o660);
      expect((await stat(join(runDir, name))).gid).toBe(config.gid);
    }
    expect(await mode(join(runDir, "launch.sh"))).toBe(0o770);
    expect(await mode(join(runDir, "codex"))).toBe(0o2770);
    expect(await readFile(join(runDir, "token"), "utf8")).toBe(
      "fixture-token\n",
    );
    await scrubAgentLaunch(config, "project", "A-1");
    await scrubAgentLaunch(config, "project", "A-1");
    expect(await readdir(runDir)).toEqual(["codex", "launch.sh"]);
  });
  test("the dispatch sentinel never follows a planted link or hardlink", async () => {
    await prepareAgentProject(config, "project", "A-1");
    const outside = join(config.dataDir, "host-file");
    await writeFile(outside, "host-private");
    // An Agent of another Assignment shares this writable directory.
    await symlink(outside, join(runDir, "start"));
    await writeAgentSentinel(config, "project", "A-1");
    // The link itself was replaced, and the host file it pointed at is intact.
    expect((await stat(join(runDir, "start"))).isFile()).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("host-private");
    expect(await mode(join(runDir, "start"))).toBe(0o660);

    // A stale sentinel is removed as a link, never by following it.
    await clearAgentSentinel(config, "project", "A-1");
    expect(await readdir(runDir)).not.toContain("start");
    expect(await readFile(outside, "utf8")).toBe("host-private");
    // Clearing twice is a no-op.
    await clearAgentSentinel(config, "project", "A-1");
  });

  test("atomic replacement never follows a credential symlink or modifies a hardlink target", async () => {
    await prepareAgentProject(config, "project", "A-1");
    const outside = join(config.dataDir, "untouched");
    await writeFile(outside, "host-private");
    await symlink(outside, join(runDir, "token"));
    await link(outside, join(runDir, "secrets.env"));
    await writeAgentLaunch(
      config,
      "project",
      "A-1",
      [
        {
          path: join(runDir, "secrets.env"),
          content: "replacement",
          mode: 0o600,
        },
      ],
      "new-token",
    );
    expect(await readFile(outside, "utf8")).toBe("host-private");
    expect(await readFile(join(runDir, "secrets.env"), "utf8")).toBe(
      "replacement",
    );
    expect(await readFile(join(runDir, "token"), "utf8")).toBe("new-token\n");
  });
  test("nested or namespace symlinks and out-of-directory files fail without changing private data", async () => {
    await prepareAgentProject(config, "project", "A-1");
    const protectedFile = join(config.dataDir, "config.toml");
    await writeFile(protectedFile, "private");
    await symlink(config.dataDir, join(runDir, "codex"), "dir");
    await expect(
      writeAgentLaunch(
        config,
        "project",
        "A-1",
        [
          {
            path: join(runDir, "codex", "config.toml"),
            content: "attack",
            mode: 0o600,
          },
        ],
        "token",
      ),
    ).rejects.toThrow();
    await expect(
      writeAgentLaunch(
        config,
        "project",
        "A-1",
        [{ path: protectedFile, content: "attack", mode: 0o600 }],
        "token",
      ),
    ).rejects.toThrow(/outside/);
    expect(await readFile(protectedFile, "utf8")).toBe("private");
    await rm(runDir, { recursive: true });
    await writeFile(join(config.dataDir, "token"), "private-token");
    await symlink(config.dataDir, runDir, "dir");
    await expect(scrubAgentLaunch(config, "project", "A-1")).rejects.toThrow();
    expect(await readFile(join(config.dataDir, "token"), "utf8")).toBe(
      "private-token",
    );
    expect(await readFile(protectedFile, "utf8")).toBe("private");
  });
  test("unsafe data/parent permissions are refused instead of silently weakening isolation", async () => {
    await chmod(config.dataDir, 0o750);
    await expect(secureDataDirectory(config)).rejects.toThrow(/0700/);
    await chmod(config.dataDir, 0o700);
    await chmod(config.agentRoot, 0o2770);
    await expect(
      prepareAgentProject(config, "project", "A-1"),
    ).rejects.toThrow();
    await chmod(config.agentRoot, 0o2750);
    await expect(
      prepareAgentProject(config, "../project", "A-1"),
    ).rejects.toThrow(/path component/);
  });
});
