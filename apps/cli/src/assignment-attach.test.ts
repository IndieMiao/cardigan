import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Assignment, Role } from "@cardigan/domain";
import { tryHostOpsLock } from "@cardigan/host";
import { defaultRoleDefinition } from "@cardigan/roles";
import { Store, writeRole } from "@cardigan/store";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const bin = join(cliRoot, "dist/bin.js");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const execute = promisify(execFile);
const connections = new Set<Socket>();
const rpcCalls: { method: string; params: Record<string, unknown> }[] = [];
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
  rpcCalls.length = 0;
  socket = createServer((connection) => {
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
    connection.on("error", () => {});
    connection.setEncoding("utf8");
    let buffer = "";
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const request = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        rpcCalls.push(request);
        const reply = (result: unknown) =>
          connection.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
          );
        if (request.method === "hello") {
          reply({
            generation: 1,
            version: "0.1.18",
            framed: false,
            methods: ["terminal.get", "machine.list"],
          });
        } else if (request.method === "terminal.get") {
          if (env.FIXTURE_STATE === "missing") {
            connection.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                error: {
                  code: -32000,
                  message: "RAW HC ERROR",
                  data: { kind: "not_found" },
                },
              })}\n`,
            );
          } else if (env.FIXTURE_STATE === "disconnect") {
            connection.destroy();
          } else if (env.FIXTURE_STATE === "invalid-json") {
            connection.write("RAW HC NON-JSON\n");
          } else reply({ state: env.FIXTURE_STATE });
        } else if (request.method === "machine.list") {
          reply({ machines: [] });
        } else {
          connection.destroy();
        }
      }
    });
  });
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
  // Control reads use the fake protocol above; CLI-only operations stay here.
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
  console.log(process.env.FIXTURE_STATE === 'invalid-json' ? 'RAW HC NON-JSON' : JSON.stringify({state: process.env.FIXTURE_STATE}));
} else if (args[0] === 'events') {
  console.log(JSON.stringify({seq: 1, terminals: [{address: process.env.FIXTURE_TERMINAL || 't7', state: process.env.FIXTURE_STATE}]}));
} else if (args[0] === 'machine') {
  console.log(JSON.stringify(args[1] === 'ls' ? {machines: []} : {version: '0.1.18'}));
} else if (args[0] === 'kill' || args[0] === 'rm') {
  console.log('{}');
} else if (args[0] === 'attach') {
  fs.writeFileSync(path.join(process.env.FIXTURE_ROOT, 'attached'), JSON.stringify({
    args, session: process.env.HC_SESSION, socket: process.env.HC_SOCKET,
    stdinTTY: process.stdin.isTTY === true, stdoutTTY: process.stdout.isTTY === true
  }));
  if (process.env.FIXTURE_EXIT !== '0') console.error('RAW HC ERROR');
  if (process.env.FIXTURE_SIGNAL) process.kill(process.pid, process.env.FIXTURE_SIGNAL);
  else if (process.env.FIXTURE_HOLD_ATTACH === '1') setTimeout(() => process.exit(0), 600);
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
  for (const connection of connections) connection.destroy();
  connections.clear();
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
async function cliProcess(file: string, args: string[]) {
  // Keep the test's socket responsive while the real CLI runs. A synchronous
  // wait would deadlock the hello handshake until the original 10s timeout.
  const result = await execute(file, args, {
    env,
    encoding: "utf8",
    timeout: 10_000,
  }).then(
    (output) => ({ ...output, code: 0 }),
    (error) => {
      expect(error.killed).toBe(false);
      expect(error.signal ?? null).toBeNull();
      expect(typeof error.code).toBe("number");
      return {
        code: error.code as number,
        stdout: String(error.stdout),
        stderr: String(error.stderr),
      };
    },
  );
  return {
    code: result.code,
    output: `${result.stdout}${result.stderr}`.replaceAll("\r", ""),
  };
}

async function run(
  flags: string[] = [],
  mode: TerminalMode = "pipe",
  id = "A-1",
) {
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
  return mode === "pipe"
    ? cliProcess(process.execPath, args)
    : cliProcess("script", ["-q", "-e", "-c", script, "/dev/null"]);
}

function expectProbe(terminal = "t7", registersMachine = false) {
  expect(rpcCalls.filter((call) => call.method === "terminal.get")).toEqual([
    expect.objectContaining({ params: expect.objectContaining({ terminal }) }),
  ]);
  if (!registersMachine)
    expect(rpcCalls.map((call) => call.method)).toEqual([
      "hello",
      "terminal.get",
    ]);
  else {
    expect(
      rpcCalls.filter((call) => call.method === "machine.list").length,
    ).toBeGreaterThan(0);
    for (const call of rpcCalls)
      expect(["hello", "machine.list", "terminal.get"]).toContain(call.method);
  }
  for (const call of rpcCalls.filter((call) => call.method === "hello"))
    expect(call.params).toEqual({ generation: 1, framed: false });
}

function attached() {
  return JSON.parse(readFileSync(join(root, "attached"), "utf8"));
}

describe("assignment attach", () => {
  test.skipIf(process.platform !== "linux")(
    "TTY directly observes with the configured environment and preserves hc's exit code",
    async () => {
      env.FIXTURE_EXIT = "23";
      const result = await run([], "tty");
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
      expect(
        readFileSync(join(root, "calls"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)[0]),
      ).toEqual(["--version", "attach"]);
      expectProbe();
    },
  );

  test.skipIf(process.platform !== "linux")(
    "--interactive explicitly enables terminal input",
    async () => {
      expect(await run(["--interactive"], "tty")).toMatchObject({
        code: 0,
        output: expect.stringContaining("将接管终端输入"),
      });
      expect(attached().args).toEqual(["attach", "t7"]);
    },
  );

  test.skipIf(process.platform !== "linux")(
    "returns a signal exit status",
    async () => {
      env.FIXTURE_SIGNAL = "SIGTERM";
      expect((await run([], "tty")).code).toBe(143);
    },
  );

  test.skipIf(process.platform !== "linux")(
    "agent-ssh attaches the bridged address from the host with the same session and socket",
    async () => {
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
      const result = await run(["--hc-session", "attach-fixture"], "tty");
      expect(result.code, result.output).toBe(0);
      expect(attached()).toMatchObject({
        args: ["attach", "--observe", "fixture-agent/t7"],
        session: "attach-fixture",
        socket: socketPath,
        stdinTTY: true,
        stdoutTTY: true,
      });
      expectProbe("fixture-agent/t7", true);
    },
  );

  test.each(
    [[], ["--print"], ["--interactive"], ["--print", "--interactive"]].map(
      (flags) => ({ flags }),
    ),
  )("non-TTY $flags only prints a safely quoted command", async ({ flags }) => {
    const result = await run(flags);
    expect(result.code).toBe(0);
    expect(result.output).toContain(
      `HC_SESSION='attach-fixture' HC_SOCKET=${quote(socketPath)} 'hc' attach 't7'${flags.includes("--interactive") ? "" : " --observe"}\n`,
    );
    expect(
      readFileSync(join(root, "calls"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)[0]),
    ).toEqual(["--version"]);
    expectProbe();
    expect(existsSync(join(root, "attached"))).toBe(false);
    expect(result.output).not.toContain("分离退出");
  });

  test
    .skipIf(process.platform !== "linux")
    .each(["tty", "stdin-pipe", "stdout-pipe"] as const)(
    "--print only prints even in %s",
    async (mode) => {
      expect((await run(["--print"], mode)).code).toBe(0);
      expectProbe();
      expect(existsSync(join(root, "attached"))).toBe(false);
    },
  );

  test
    .skipIf(process.platform !== "linux")
    .each(["stdin-pipe", "stdout-pipe"] as const)(
    "automatically prints with %s",
    async (mode) => {
      expect((await run([], mode)).code).toBe(0);
      expect(existsSync(join(root, "attached"))).toBe(false);
    },
  );

  test.each([[], ["--print"]].map((flags) => ({ flags })))(
    "missing Assignment exits before contacting hc ($flags)",
    async ({ flags }) => {
      expect(await run(flags, "pipe", "A-999")).toMatchObject({
        code: 2,
        output: expect.stringContaining(
          "A-999 在当前项目中不存在；请检查编号和 --project",
        ),
      });
      expect(existsSync(join(root, "calls"))).toBe(false);
      expect(rpcCalls).toEqual([]);
    },
  );

  test.each([
    [{ status: "released" }, "已释放"],
    [{ status: "suspended" }, "已暂停"],
    [{ runtime_ref: null }, "没有在运行的终端"],
    [{ runtime_state: "released" }, "没有在运行的终端"],
  ] as const)(
    "invalid Assignment %j has a Chinese reason and next step",
    async (patch, reason) => {
      updateAssignment(patch);
      const result = await run();
      expect(result.code).toBe(2);
      expect(result.output).toContain(reason);
      expect(result.output).toMatch(/重新指派|cardigan assignment start A-1/);
      expect(existsSync(join(root, "calls"))).toBe(false);
    },
  );

  test.skipIf(process.platform !== "linux").each([
    ["finished", "终端已结束"],
    ["missing", "终端不存在或已结束"],
    ["unknown", "无法确认终端仍在运行"],
    ["invalid-json", "运行时不可用"],
  ])(
    "%s terminal has a Chinese reason and recovery command",
    async (state, reason) => {
      env.FIXTURE_STATE = state;
      const result = await run([], "tty");
      expect(result.code).toBe(1);
      expect(result.output).toContain(reason);
      expect(result.output).toContain("cardigan assignment start A-1");
      expect(result.output).not.toContain("RAW HC");
      expect(existsSync(join(root, "attached"))).toBe(false);
    },
  );

  test.skipIf(process.platform !== "linux")(
    "missing socket refuses direct entry without hc get or attach",
    async () => {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
      const result = await run([], "tty");
      expect(result.code).toBe(1);
      expect(result.output).toContain("运行时不可用");
      expect(result.output).toContain("cardigan assignment start A-1");
      expect(readFileSync(join(root, "calls"), "utf8")).toBe('["--version"]\n');
    },
  );

  test.each(["missing", "unknown", "invalid-json", "disconnect"])(
    "non-TTY printing tolerates a %s probe",
    async (state) => {
      env.FIXTURE_STATE = state;
      const result = await run();
      expect(result.code).toBe(0);
      expect(result.output).toContain("'hc' attach 't7' --observe\n");
      expect(result.output).not.toContain("RAW HC");
      expect(existsSync(join(root, "attached"))).toBe(false);
      expectProbe();
    },
  );

  test
    .skipIf(process.platform !== "linux")
    .each(["missing", "unknown", "invalid-json", "disconnect"])(
    "TTY --print tolerates a %s probe",
    async (state) => {
      env.FIXTURE_STATE = state;
      expect(await run(["--print"], "tty")).toMatchObject({
        code: 0,
        output: expect.stringContaining("'hc' attach 't7' --observe\n"),
      });
      expect(existsSync(join(root, "attached"))).toBe(false);
      expectProbe();
    },
  );

  test.each([[], ["--print"]].map((flags) => ({ flags })))(
    "printing exits naturally without a running core ($flags)",
    async ({ flags }) => {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
      expect(await run(flags)).toMatchObject({
        code: 0,
        output: expect.stringContaining("'hc' attach 't7' --observe\n"),
      });
      expect(readFileSync(join(root, "calls"), "utf8")).toBe('["--version"]\n');
      expect(rpcCalls).toEqual([]);
      expect(existsSync(join(root, "attached"))).toBe(false);
    },
  );

  test.each([false, true])(
    "printing rejects a confirmed finished terminal (--print=%s)",
    async (print) => {
      env.FIXTURE_STATE = "finished";
      const result = await run(print ? ["--print"] : []);
      expect(result.code).toBe(1);
      expect(result.output).toContain("终端已结束");
      expect(result.output).toContain("cardigan assignment start A-1");
      expect(result.output).not.toContain("HC_SESSION=");
    },
  );

  test("incompatible hc version gets a Chinese diagnosis", async () => {
    env.FIXTURE_VERSION = "hc 0.0.0";
    expect(await run()).toMatchObject({
      code: 1,
      output: expect.stringContaining("运行时版本不兼容"),
    });
    expect(existsSync(join(root, "attached"))).toBe(false);
  });

  test("attach help explains print, interactive mode, TTY and detach", async () => {
    const result = await run(["--help"]);
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
    expect(rpcCalls).toEqual([]);
  });
});

describe("C-152: server-registered runtime", () => {
  // The fixture hc listens only in the `attach-fixture` session: the server's.
  const registerAgentSsh = (machine = "cardigan-agent") =>
    writeFileSync(
      join(root, "data", "runtime.json"),
      JSON.stringify({
        mode: "agent-ssh",
        session: "attach-fixture",
        machine,
        agentRoot: join(root, "agent"),
        gid: 4242,
        identityFile: join(root, "ssh", "id"),
        knownHostsFile: join(root, "ssh", "known_hosts"),
      }),
      { mode: 0o600 },
    );
  const calls = () =>
    existsSync(join(root, "calls"))
      ? readFileSync(join(root, "calls"), "utf8").trim().split("\n")
      : [];
  function cli(args: string[]) {
    return cliProcess(process.execPath, [bin, ...args]);
  }

  test("agent-ssh project + shell without runtime env: start is refused before any terminal or Run", async () => {
    registerAgentSsh();
    delete env.CARDIGAN_RUNTIME_MODE;
    updateAssignment({ runtime_ref: null, runtime_state: "idle" });
    const result = await cli([
      "assignment",
      "start",
      "A-1",
      "--project",
      "fixture",
    ]);
    expect(result.code).toBe(2);
    expect(result.output).toContain("拒绝启动：当前 shell 没有加载运行环境");
    expect(result.output).toContain("agent-ssh（机器 cardigan-agent）");
    expect(result.output).toContain("runtime.env");
    expect(calls()).toEqual([]);
    const store = Store.open({ dataDir: join(root, "data") });
    try {
      expect(store.uow.read((tx) => tx.runs.list("fixture" as never))).toEqual(
        [],
      );
    } finally {
      store.close();
    }
  });

  // One CLI process per case: each spawn costs a Node startup, and three in a
  // row exceeded the 5s budget under a fully parallel run (C-152#35).
  test.each([
    [["assignment", "start", "A-1", "--project", "fixture"]],
    [["pm", "start", "--project", "fixture"]],
    [["pm", "rotate", "--ops", "--project", "fixture"]],
  ])(
    "a shell whose runtime differs from the registration is refused with the differing fields: %j",
    async (args) => {
      registerAgentSsh();
      Object.assign(env, {
        CARDIGAN_RUNTIME_MODE: "agent-ssh",
        CARDIGAN_AGENT_MACHINE: "elsewhere",
        CARDIGAN_AGENT_ROOT: join(root, "agent"),
        CARDIGAN_AGENT_GID: "4242",
        CARDIGAN_AGENT_IDENTITY: join(root, "ssh", "id"),
        CARDIGAN_AGENT_KNOWN_HOSTS: join(root, "ssh", "known_hosts"),
      });
      updateAssignment({ standing_mode: "ops" });
      const result = await cli(args);
      expect(result.code).toBe(2);
      expect(result.output).toContain("和 server 登记的不一致");
      expect(result.output).toContain(
        "CARDIGAN_AGENT_MACHINE：server 登记为 cardigan-agent，当前 shell 为 elsewhere",
      );
      expect(calls()).toEqual([]);
    },
  );

  test("without any registration an empty shell is refused instead of defaulting to local", async () => {
    delete env.CARDIGAN_RUNTIME_MODE;
    updateAssignment({ runtime_ref: null, runtime_state: "idle" });
    const result = await cli([
      "assignment",
      "start",
      "A-1",
      "--project",
      "fixture",
    ]);
    expect(result.code).toBe(2);
    expect(result.output).toContain("server 还没有在这个数据目录登记运行时");
    expect(result.output).toContain("CARDIGAN_RUNTIME_MODE=local");
    expect(calls()).toEqual([]);
  });

  test("a start whose hc session differs from the server's is refused", async () => {
    writeFileSync(
      join(root, "data", "runtime.json"),
      JSON.stringify({ mode: "local", session: "server-session" }),
    );
    updateAssignment({ runtime_ref: null, runtime_state: "idle" });
    const result = await cli([
      "assignment",
      "start",
      "A-1",
      "--project",
      "fixture",
    ]);
    expect(result.code).toBe(2);
    expect(result.output).toContain(
      "CARDIGAN_HC_SESSION（或 --hc-session）：server 登记为 server-session，当前 shell 为 attach-fixture",
    );
    expect(calls()).toEqual([]);
  });

  test.skipIf(process.platform !== "linux")(
    "attach to an agent-ssh terminal from a plain shell uses the server's registered hc session",
    async () => {
      mkdirSync(join(root, "ssh"));
      for (const name of ["id", "known_hosts"])
        writeFileSync(join(root, "ssh", name), "fixture", { mode: 0o600 });
      registerAgentSsh();
      delete env.CARDIGAN_RUNTIME_MODE;
      delete env.CARDIGAN_HC_SESSION;
      updateAssignment({
        runtime_ref: {
          machine_id: "local",
          runtime_machine: "cardigan-agent",
          terminal_ref: "cardigan-agent/t7",
          agent_name: "fixture",
        },
      });
      const result = await run(["--print"]);
      expect(result.output).toContain("HC_SESSION='attach-fixture'");
      expect(result.output).toContain("attach 'cardigan-agent/t7' --observe");
      expect(result.code).toBe(0);
      expectProbe("cardigan-agent/t7", true);
    },
  );

  test("attach from a plain shell follows the terminal's recorded local runtime", async () => {
    registerAgentSsh();
    delete env.CARDIGAN_RUNTIME_MODE;
    delete env.CARDIGAN_HC_SESSION;
    const result = await run(["--print"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("attach 't7' --observe");
    // The local terminal is reached without registering the Agent machine.
    expect(calls().map((line) => JSON.parse(line)[0])).toEqual(["--version"]);
    expectProbe();
  });

  test.each(["fixture", "other"])(
    "legacy local attach/stop coexist with an SSH ref in project %s",
    async (otherProject) => {
      registerAgentSsh();
      delete env.CARDIGAN_RUNTIME_MODE;
      delete env.CARDIGAN_HC_SESSION;
      const data = Store.open({ dataDir: join(root, "data") });
      if (otherProject !== "fixture")
        data.createProject({ id: otherProject, name: "Other" });
      const foreign = data.uow.run((tx) => {
        writeRole(
          tx,
          "fixture",
          {
            ...defaultRoleDefinition("pm", {
              harness: "pi",
              launch_profile_ref: "fixture",
            }),
            version: 1,
          } as Role,
          { mode: "add" },
        );
        const current = tx.assignments.get(
          "fixture",
          "A-1" as Assignment["id"],
        );
        if (!current) throw new Error("Missing fixture assignment");
        const other: Assignment = {
          ...current,
          id: "A-2" as Assignment["id"],
          runtime_ref: {
            machine_id: "local",
            runtime_machine: "cardigan-agent",
            terminal_ref: "cardigan-agent/t2",
            agent_name: "ssh-fixture",
          },
        };
        tx.assignments.put(otherProject, other);
        return other;
      });
      data.close();
      const attached = await run(["--print"]);
      expect(attached.code, attached.output).toBe(0);
      expect(attached.output).toContain("attach 't7'");
      const stopped = await cli([
        "assignment",
        "stop",
        "A-1",
        "--project",
        "fixture",
      ]);
      expect(stopped.code, stopped.output).toBe(0);
      const commands = calls().map((line) => JSON.parse(line));
      expect(commands).toContainEqual(["kill", "t7", "--json"]);
      expect(commands).toContainEqual(["rm", "t7", "--json"]);
      expect(
        commands.some(
          (args) => args[0] === "machine" || args.includes("cardigan-agent/t2"),
        ),
      ).toBe(false);
      const after = Store.open({ dataDir: join(root, "data") });
      expect(
        after.uow.read((tx) => tx.assignments.get(otherProject, foreign.id)),
      ).toEqual(foreign);
      after.close();
    },
  );

  test("attach to a terminal outside the registered runtime names the real cause", async () => {
    registerAgentSsh();
    updateAssignment({
      runtime_ref: {
        machine_id: "local",
        runtime_machine: "other-box",
        terminal_ref: "other-box/t9",
        agent_name: "fixture",
      },
    });
    const result = await run(["--print"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "终端 other-box/t9 记录在运行时机器 other-box，不属于 server 登记的运行时 agent-ssh（机器 cardigan-agent）",
    );
    expect(result.output).not.toContain("启动配置不合法");
    expect(calls()).toEqual([]);
  });
});

test.skipIf(process.platform !== "linux")(
  "human attach holds the same retirement lock until detaching",
  async () => {
    env.FIXTURE_HOLD_ATTACH = "1";
    const store = Store.open({ dataDir: join(root, "data") });
    try {
      const attaching = run([], "tty");
      await vi.waitFor(() =>
        expect(existsSync(join(root, "attached"))).toBe(true),
      );
      expect(
        await tryHostOpsLock(store, "fixture", "A-1" as never),
      ).toBeUndefined();
      expect((await attaching).code).toBe(0);
      const unlock = await tryHostOpsLock(store, "fixture", "A-1" as never);
      expect(unlock).toBeDefined();
      await unlock?.();
    } finally {
      store.close();
    }
  },
);
