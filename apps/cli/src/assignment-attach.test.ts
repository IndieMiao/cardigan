import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Assignment } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const bin = join(cliRoot, "dist/bin.js");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
let root: string, socket: Server, socketPath: string, env: NodeJS.ProcessEnv;

beforeAll(() => {
  execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../../node_modules/typescript/bin/tsc", import.meta.url),
      ),
      "-b",
      cliRoot,
    ],
    { stdio: "pipe" },
  );
}, 30_000);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "cg-attach-"));
  const runtimeDir = join(root, "runtime's dir");
  mkdirSync(join(runtimeDir, "cardigan"), { recursive: true });
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  socketPath = join(runtimeDir, "cardigan", "attach-fixture.sock");
  socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(socketPath, resolve);
  });
  env = {
    ...process.env,
    CARDIGAN_DATA_DIR: join(root, "data"),
    CARDIGAN_RUNTIME_MODE: "local",
    CARDIGAN_HC_SESSION: "attach-fixture",
    XDG_RUNTIME_DIR: runtimeDir,
    HC_SESSION: "must-not-inherit",
    HC_SOCKET: "must-not-inherit",
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    FIXTURE_ROOT: root,
    FIXTURE_STATE: "live",
    FIXTURE_EXIT: "0",
  };
  // Every hc invocation, including preflight reads, hits this fake executable.
  writeFileSync(join(root, "bin/ssh"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  writeFileSync(
    join(root, "bin/hc"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.FIXTURE_ROOT, 'calls'), JSON.stringify(args) + '\\n');
if (args[0] === '--version') {
  console.log(process.env.FIXTURE_VERSION || 'hc 0.1.18');
} else if (args[0] === 'get') {
  if (process.env.FIXTURE_STATE === 'missing') {
    console.error(JSON.stringify({error: {kind: 'not_found', message: 'RAW HC ERROR'}}));
    process.exit(1);
  }
  console.log(process.env.FIXTURE_STATE === 'invalid-json' ? 'RAW HC NON-JSON' : '{}');
} else if (args[0] === 'events') {
  console.log(JSON.stringify({seq: 1, terminals: [{address: process.env.FIXTURE_TERMINAL || 't7', state: process.env.FIXTURE_STATE}]}));
} else if (args[0] === 'machine') {
  console.log(JSON.stringify(args[1] === 'ls' ? {machines: []} : {version: '0.1.18'}));
} else if (args[0] === 'attach') {
  fs.writeFileSync(path.join(process.env.FIXTURE_ROOT, 'attached'), JSON.stringify({
    args, session: process.env.HC_SESSION, socket: process.env.HC_SOCKET,
    stdinTTY: process.stdin.isTTY === true, stdoutTTY: process.stdout.isTTY === true
  }));
  if (process.env.FIXTURE_EXIT !== '0') console.error('RAW HC ERROR');
  if (process.env.FIXTURE_SIGNAL) process.kill(process.pid, process.env.FIXTURE_SIGNAL);
  else process.exit(Number(process.env.FIXTURE_EXIT));
} else {
  console.error('Unexpected hc command');
  process.exit(99);
}
`,
    { mode: 0o755 },
  );
  const store = Store.open({ dataDir: join(root, "data") });
  store.createProject({ id: "fixture", name: "Fixture" });
  store.uow.run((tx) =>
    tx.assignments.put("fixture" as never, {
      id: "A-1" as never,
      scope: "standing",
      role_id: "pm",
      role_version: 1,
      status: "active",
      runtime_state: "running",
      machine_id: "local",
      runtime_ref: {
        machine_id: "local",
        runtime_machine: "local",
        terminal_ref: "t7",
        agent_name: "fixture",
      },
      mcp_token_id: "fixture",
      created_at: "2026-01-01T00:00:00Z",
    }),
  );
  store.close();
});

afterEach(async () => {
  if (socket?.listening)
    await new Promise<void>((resolve) => socket.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

function updateAssignment(patch: Partial<Assignment>) {
  const store = Store.open({ dataDir: join(root, "data") });
  store.uow.run((tx) => {
    const assignment = tx.assignments.get("fixture" as never, "A-1" as never);
    tx.assignments.put(
      "fixture" as never,
      { ...assignment, ...patch } as Assignment,
    );
  });
  store.close();
}

type TerminalMode = "tty" | "pipe" | "stdin-pipe" | "stdout-pipe";
function run(flags: string[] = [], mode: TerminalMode = "pipe", id = "A-1") {
  const args = [
    bin,
    "assignment",
    "attach",
    id,
    "--project",
    "fixture",
    ...flags,
  ];
  const command = [process.execPath, ...args].map(quote).join(" ");
  // script allocates a real PTY for this fake-only CLI test. A separate pipe on
  // either stream verifies that BOTH stdin and stdout must be terminals.
  const script =
    mode === "stdin-pipe"
      ? `${command} </dev/null`
      : mode === "stdout-pipe"
        ? `${command} >${quote(join(root, "printed"))}`
        : command;
  const result =
    mode === "pipe"
      ? spawnSync(process.execPath, args, {
          env,
          encoding: "utf8",
          timeout: 10_000,
        })
      : spawnSync("script", ["-q", "-e", "-c", script, "/dev/null"], {
          env,
          encoding: "utf8",
          timeout: 10_000,
        });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return {
    code: result.status,
    output: `${result.stdout}${result.stderr}`.replaceAll("\r", ""),
  };
}

function attached() {
  return JSON.parse(readFileSync(join(root, "attached"), "utf8"));
}

describe("assignment attach", () => {
  test.skipIf(process.platform !== "linux")(
    "TTY directly observes with the configured environment and preserves hc's exit code",
    () => {
      env.FIXTURE_EXIT = "23";
      const result = run([], "tty");
      expect(result.code).toBe(23);
      expect(attached()).toEqual({
        args: ["attach", "--observe", "t7"],
        session: "attach-fixture",
        socket: socketPath,
        stdinTTY: true,
        stdoutTTY: true,
      });
      expect(result.output).toContain("只读观察");
      expect(result.output).toContain("Ctrl+\\");
      expect(result.output).toContain("你的输入会直接发给正在工作的 Agent");
      expect(result.output).toContain("cardigan assignment start A-1");
      expect(result.output).not.toContain("RAW HC ERROR");
      expect(result.output).not.toContain("HC_SESSION=");
    },
  );

  test.skipIf(process.platform !== "linux")(
    "--interactive explicitly enables terminal input",
    () => {
      expect(run(["--interactive"], "tty")).toMatchObject({
        code: 0,
        output: expect.stringContaining("将接管终端输入"),
      });
      expect(attached().args).toEqual(["attach", "t7"]);
    },
  );

  test.skipIf(process.platform !== "linux")(
    "returns a signal exit status",
    () => {
      env.FIXTURE_SIGNAL = "SIGTERM";
      expect(run([], "tty").code).toBe(143);
    },
  );

  test.skipIf(process.platform !== "linux")(
    "agent-ssh attaches the bridged address from the host with the same session and socket",
    () => {
      env.CARDIGAN_RUNTIME_MODE = "agent-ssh";
      env.CARDIGAN_AGENT_ROOT = join(root, "agent");
      env.CARDIGAN_AGENT_GID = "1234";
      env.CARDIGAN_AGENT_MACHINE = "fixture-agent";
      env.CARDIGAN_AGENT_IDENTITY = join(root, "identity");
      env.CARDIGAN_AGENT_KNOWN_HOSTS = join(root, "known-hosts");
      for (const file of [
        env.CARDIGAN_AGENT_IDENTITY,
        env.CARDIGAN_AGENT_KNOWN_HOSTS,
      ])
        writeFileSync(file, "fixture only", { mode: 0o600 });
      env.FIXTURE_TERMINAL = "fixture-agent/t7";
      // The explicit session overrides CARDIGAN_HC_SESSION, just as it does
      // for the preflight; inherited HC_* values must never select a session.
      env.CARDIGAN_HC_SESSION = "wrong-session";
      updateAssignment({
        runtime_ref: {
          machine_id: "local",
          runtime_machine: "fixture-agent",
          terminal_ref: "fixture-agent/t7",
          agent_name: "fixture",
        },
      });
      const result = run(["--hc-session", "attach-fixture"], "tty");
      expect(result.code, result.output).toBe(0);
      expect(attached()).toMatchObject({
        args: ["attach", "--observe", "fixture-agent/t7"],
        session: "attach-fixture",
        socket: socketPath,
        stdinTTY: true,
        stdoutTTY: true,
      });
    },
  );

  test.each(
    [[], ["--print"], ["--interactive"], ["--print", "--interactive"]].map(
      (flags) => ({ flags }),
    ),
  )("non-TTY $flags only prints a safely quoted command", ({ flags }) => {
    const result = run(flags);
    expect(result.code).toBe(0);
    expect(result.output).toContain(
      `HC_SESSION='attach-fixture' HC_SOCKET=${quote(socketPath)} 'hc' attach 't7'${flags.includes("--interactive") ? "" : " --observe"}`,
    );
    expect(existsSync(join(root, "attached"))).toBe(false);
    expect(result.output).not.toContain("分离退出");
  });

  test
    .skipIf(process.platform !== "linux")
    .each(["tty", "stdin-pipe", "stdout-pipe"] as const)(
    "--print only prints even in %s",
    (mode) => {
      expect(run(["--print"], mode).code).toBe(0);
      expect(existsSync(join(root, "attached"))).toBe(false);
    },
  );

  test
    .skipIf(process.platform !== "linux")
    .each(["stdin-pipe", "stdout-pipe"] as const)(
    "automatically prints with %s",
    (mode) => {
      expect(run([], mode).code).toBe(0);
      expect(existsSync(join(root, "attached"))).toBe(false);
    },
  );

  test("missing Assignment is diagnosed before contacting hc", () => {
    expect(run([], "pipe", "A-999")).toMatchObject({
      code: 2,
      output: expect.stringContaining(
        "A-999 在当前项目中不存在；请检查编号和 --project",
      ),
    });
    expect(existsSync(join(root, "calls"))).toBe(false);
  });

  test.each([
    [{ status: "released" }, "已释放"],
    [{ status: "suspended" }, "已暂停"],
    [{ runtime_ref: null }, "没有在运行的终端"],
    [{ runtime_state: "released" }, "没有在运行的终端"],
  ] as const)(
    "invalid Assignment %j has a Chinese reason and next step",
    (patch, reason) => {
      updateAssignment(patch);
      const result = run();
      expect(result.code).toBe(2);
      expect(result.output).toContain(reason);
      expect(result.output).toMatch(/重新指派|cardigan assignment start A-1/);
      expect(existsSync(join(root, "calls"))).toBe(false);
    },
  );

  test.each([
    ["finished", "终端已结束"],
    ["missing", "终端不存在或已结束"],
    ["unknown", "无法确认终端仍在运行"],
    ["invalid-json", "运行时不可用"],
  ])(
    "%s terminal has a Chinese reason and recovery command",
    (state, reason) => {
      env.FIXTURE_STATE = state;
      const result = run();
      expect(result.code).toBe(1);
      expect(result.output).toContain(reason);
      expect(result.output).toContain("cardigan assignment start A-1");
      expect(result.output).not.toContain("RAW HC");
      expect(existsSync(join(root, "attached"))).toBe(false);
    },
  );

  test("missing socket refuses without hc get or attach", async () => {
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const result = run();
    expect(result.code).toBe(1);
    expect(result.output).toContain("运行时不可用");
    expect(result.output).toContain("cardigan assignment start A-1");
    expect(readFileSync(join(root, "calls"), "utf8")).toBe('["--version"]\n');
  });

  test("incompatible hc version gets a Chinese diagnosis", () => {
    env.FIXTURE_VERSION = "hc 0.0.0";
    expect(run()).toMatchObject({
      code: 1,
      output: expect.stringContaining("运行时版本不兼容"),
    });
    expect(existsSync(join(root, "attached"))).toBe(false);
  });

  test("attach help explains print, interactive mode, TTY and detach", () => {
    const result = run(["--help"]);
    expect(result.code).toBe(0);
    for (const text of [
      "--print",
      "--interactive",
      "TTY",
      "只读观察",
      "Ctrl+\\",
    ])
      expect(result.output).toContain(text);
    expect(existsSync(join(root, "calls"))).toBe(false);
  });
});
