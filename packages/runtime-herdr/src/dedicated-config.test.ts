import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { corePid, stopCore } from "../test-support/hc-core.js";
import {
  checkCoreConfig,
  dedicatedConfigHome,
  prepareDedicatedConfig,
} from "./dedicated-config.js";
import { HerdrRuntime } from "./index.js";
import { assignment, launch, machine, role, value } from "./test-support.js";

test("dedicated config creation is idempotent and refuses links or unexpected content", async () => {
  const root = await mkdtemp(join(tmpdir(), "cg-config-"));
  try {
    const home = dedicatedConfigHome(root, "test");
    await prepareDedicatedConfig(home, 5000);
    await prepareDedicatedConfig(home, 5000);
    const file = join(home, "herdr-core", "config.toml");
    expect(await readFile(file, "utf8")).toBe("draft_wait = 0\n");
    await writeFile(file, "draft_wait = 60\n");
    await expect(prepareDedicatedConfig(home, 5000)).rejects.toThrow();
    await rm(file);
    const shared = join(root, "shared.toml");
    await writeFile(shared, "draft_wait = 60\n");
    await symlink(shared, file);
    await expect(prepareDedicatedConfig(home, 5000)).rejects.toThrow();
    expect(await readFile(shared, "utf8")).toBe("draft_wait = 60\n");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("remote configuration probe binds the fixed SSH machine and rejects an unverified core", async () => {
  const client = {
    exec: vi.fn(async () => "wrong"),
    available: async () => true,
    async *lines() {},
  };
  await expect(
    checkCoreConfig(client, "/fixture/hc-config/test", "worker-a"),
  ).rejects.toThrow();
  expect(client.exec.mock.calls[0]?.[0]?.slice(0, 5)).toEqual([
    "exec",
    "--on",
    "worker-a",
    "--",
    "python3",
  ]);
});

const binary = process.env.CARDIGAN_TEST_HC;
test.skipIf(!binary)(
  "an existing core with shared config is refused without restarting it or sending",
  async () => {
    if (!binary) throw new Error("Missing isolated hc binary");
    const root = await mkdtemp(join(tmpdir(), "cg-old-config-"));
    const session = "c313-old-config",
      socketPath = join(root, "core.sock");
    const env = {
      ...process.env,
      HOME: root,
      HC_SESSION: session,
      HC_SOCKET: socketPath,
      XDG_CONFIG_HOME: join(root, "user-config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_RUNTIME_DIR: root,
    };
    execFileSync(binary, ["server", "start", "--json"], {
      env,
      timeout: 5000,
    });
    const pid = corePid({ session, socket: socketPath, env });
    try {
      const runtime = value(
        await HerdrRuntime.create({
          binary: binary,
          session,
          socketPath,
          env,
          execution: { mode: "local", dataDir: join(root, "private") },
        }),
      );
      const result = await runtime.provision(assignment, role, machine, {
        ...launch,
        cwd: root,
        command: "/bin/cat",
        args: [],
      });
      expect(result.ok).toBe(false);
      expect(corePid({ session, socket: socketPath, env })).toBe(pid);
      const listing = JSON.parse(
        execFileSync(binary, ["ls", "--all", "--json"], {
          env,
          encoding: "utf8",
          timeout: 5000,
        }),
      );
      expect(listing.terminals).toEqual([]);
    } finally {
      await stopCore({ session, socket: socketPath, env, pid });
      await rm(root, { recursive: true });
    }
  },
  20_000,
);
test.skipIf(!binary)(
  "real Runtime.wake delivers with an unsent draft, retaining quiet wait and user config",
  async () => {
    if (!binary) throw new Error("Missing isolated hc binary");
    const root = await mkdtemp(join(tmpdir(), "cg-bell-"));
    const session = "c313-config-test",
      socketPath = join(root, "core.sock");
    const dataDir = join(root, "private"),
      configHome = dedicatedConfigHome(dataDir, session);
    const userConfig = join(root, "user-config", "herdr-core");
    await mkdir(userConfig, { recursive: true, mode: 0o700 });
    await writeFile(join(userConfig, "config.toml"), "draft_wait = 60\n");
    const env = {
      ...process.env,
      HOME: root,
      HC_SESSION: session,
      HC_SOCKET: socketPath,
      XDG_CONFIG_HOME: join(root, "user-config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_RUNTIME_DIR: root,
      TERM: "xterm-256color",
    };
    let attach: ReturnType<typeof spawn> | undefined;
    const runtime = value(
      await HerdrRuntime.create({
        binary: binary,
        session,
        socketPath,
        env,
        execution: { mode: "local", dataDir },
      }),
    );
    let ref: Awaited<ReturnType<typeof runtime.provision>> | undefined;
    try {
      expect(
        execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(),
      ).toBe("hc 0.1.21");
      ref = await runtime.provision(assignment, role, machine, {
        ...launch,
        cwd: root,
        command: "/bin/cat",
        args: [],
      });
      const r = value(ref);
      attach = spawn(
        "python3",
        [
          "-c",
          `import os,pty,fcntl,struct,subprocess,sys,termios,time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH',24,80,0,0))
proc = subprocess.Popen([sys.argv[1],'attach',sys.argv[2]],stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
os.close(slave)
try:
    time.sleep(1)
    assert proc.poll() is None
    os.write(master,b'unsent-draft')
    time.sleep(.1)
    print('ready',flush=True)
    sys.stdin.readline()
finally:
    if proc.poll() is None:
        proc.terminate()
        proc.wait(timeout=5)
    os.close(master)
`,
          binary,
          r.terminal_ref,
        ],
        { env: { ...env, XDG_CONFIG_HOME: configHome } },
      );
      if (!attach.stdout) throw new Error("Missing test attach stdout");
      const ready = await once(attach.stdout, "data");
      expect(String(ready[0])).toContain("ready");
      const started = Date.now();
      expect(
        value(
          await runtime.wake(
            r,
            "[bell] card=C-1 wi=W-1 asg=A-1 run=R-1 kind=initial",
          ),
        ),
      ).toEqual({ sent: true });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(10_000);
      // The upstream quiet pause remains active even though draft_wait is zero.
      expect(elapsed).toBeGreaterThan(500);
      expect(await readFile(join(userConfig, "config.toml"), "utf8")).toBe(
        "draft_wait = 60\n",
      );
      expect(value(await runtime.verifyExit(r)).state).toBe("unknown");
    } finally {
      if (attach) {
        const closed = once(attach, "close");
        attach.stdin?.end("done\n");
        await closed;
      }
      const pid = corePid({ session, socket: socketPath, env });
      if (ref?.ok) await runtime.release(ref.value, { force: true });
      await stopCore({ session, socket: socketPath, env, pid });
      await rm(root, { recursive: true });
    }
  },
  30_000,
);
