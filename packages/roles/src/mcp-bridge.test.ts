import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  compileAssignmentLaunch,
  DEFAULT_MCP_BRIDGE_PYTHON,
  MCP_BRIDGE_SESSION_ENV,
  MCP_BRIDGE_SOURCE,
  mcpBridgeAccepts,
  mcpBridgeArgs,
  parseLaunchConfig,
} from "./index.js";

const run = promisify(execFile);
const TAILNET = "https://control.example-tailnet.ts.net:8443/mcp";
const SESSION_KEY = "fictional-session-key-0123456789";
const PATH = process.env.PATH ?? "/usr/bin:/bin";
type Env = Record<string, string>;

function compile(
  harness: "claude-code" | "codex" | "pi",
  options: {
    url?: string;
    remote?: boolean;
    providerEnv?: Env;
    sessionKey?: string;
    python?: string;
  } = {},
) {
  return compileAssignmentLaunch({
    assignment: { assignment_id: "A-1", run_id: "R-1" },
    role: {
      role_id: "coder",
      harness,
      launch_profile: "fixture",
      core_prompt: "Fixture",
      allowed_tools: ["whoami"],
      worktree: "write",
    },
    launch: parseLaunchConfig({
      ...(options.providerEnv
        ? {
            providers: {
              routed: { harness, env: options.providerEnv },
            },
          }
        : {}),
      profiles: {
        fixture: {
          harness,
          ...(options.providerEnv ? { provider: "routed" } : {}),
        },
      },
    }),
    mcp: {
      url: options.url ?? TAILNET,
      ...(options.sessionKey ? { session_key: options.sessionKey } : {}),
      ...(options.python ? { bridge_python: options.python } : {}),
    },
    run_dir: "/fixture/runs/A-1",
    work_dir: "/fixture/worktrees/A-1",
    first_prompt: "hello",
    secrets: {},
    ...(options.remote
      ? {
          worker_launch: {
            command: ["fixture-worker"],
            session_dir: "/fixture/session",
          },
        }
      : {}),
  });
}
type Compiled = ReturnType<typeof compile>;
const fileEnding = (compiled: Compiled, ending: string) =>
  compiled.files.find((file) => file.path.endsWith(ending))?.content ?? "";
/** The `[mcp_servers.card]` table of Codex's config.toml, up to the next table. */
const cardTable = (compiled: Compiled) =>
  /\[mcp_servers\.card\]\n([\s\S]*?)\n\n/u.exec(
    fileEnding(compiled, "/codex/config.toml"),
  )?.[1] ?? "";

test("C-600 Codex reaches Card MCP through the stdio bridge, without a Token in the file or a key in its arguments", () => {
  for (const remote of [false, true]) {
    const compiled = compile("codex", {
      remote,
      sessionKey: SESSION_KEY,
      ...(remote ? { python: "/opt/worker/bin/python3" } : {}),
    });
    const table = cardTable(compiled).split("\n");
    expect(table).toEqual([
      `command = ${JSON.stringify(remote ? "/opt/worker/bin/python3" : DEFAULT_MCP_BRIDGE_PYTHON)}`,
      `args = ${JSON.stringify(mcpBridgeArgs(TAILNET)).replaceAll('","', '", "')}`,
      'env_vars = ["MCP_TOKEN"]',
      `env = { "${MCP_BRIDGE_SESSION_ENV}" = "${SESSION_KEY}" }`,
    ]);
    // TOML basic strings and JSON strings share these escapes.
    expect(
      JSON.parse(table[1]?.slice("args = ".length) ?? "[]") as string[],
    ).toEqual(["-I", "-B", "-c", MCP_BRIDGE_SOURCE, "bridge", TAILNET]);
    expect(table[1]).not.toContain(SESSION_KEY);
    const config = fileEnding(compiled, "/codex/config.toml");
    expect(config).not.toMatch(/^url = |bearer_token_env_var|http_headers/mu);
    expect(config).toContain(
      '[mcp_servers.card.tools.whoami]\napproval_mode = "approve"',
    );
  }
  // Without the session check the bridge gets no key at all.
  expect(cardTable(compile("codex"))).not.toContain("env = ");
});

test("C-600 Claude Code and Pi keep their native HTTP Card connection", () => {
  const claude = JSON.parse(
    fileEnding(
      compile("claude-code", { sessionKey: SESSION_KEY }),
      "/mcp.json",
    ),
  ) as { mcpServers: { card: Record<string, unknown> } };
  expect(claude.mcpServers.card).toEqual({
    type: "http",
    url: TAILNET,
    headers: {
      Authorization: `Bearer \${MCP_TOKEN}`,
      "X-Cardigan-Session": SESSION_KEY,
    },
  });
  expect(fileEnding(compile("pi"), "/pi/mcp.json")).toContain(TAILNET);
});

test("C-600 the bridge accepts HTTPS anywhere and plain HTTP on loopback only", () => {
  for (const url of [
    TAILNET,
    "https://card.example.invalid/mcp",
    "http://127.0.0.1:3004/mcp",
    "http://127.9.9.9:3004/mcp",
    "http://localhost:3004/mcp",
    "http://[::1]:3004/mcp",
  ])
    expect(mcpBridgeAccepts(url), url).toBe(true);
  for (const url of [
    "http://card.example.invalid/mcp",
    "http://10.0.0.1:3004/mcp",
    "http://[::ffff:127.0.0.1]:3004/mcp",
    "https://user:secret@card.example.invalid/mcp",
    "ftp://card.example.invalid/mcp",
    "not a url",
  ]) {
    expect(mcpBridgeAccepts(url), url).toBe(false);
    expect(() => compile("codex", { url })).toThrow(
      "Card MCP address must be HTTPS, or HTTP on a loopback address",
    );
  }
  expect(() => compile("codex", { python: "python" })).toThrow("absolute path");
});

// ---------------------------------------------------------------------------
// Other destinations keep their route: launches no longer touch proxy lists.

const PROXY_KEYS = [
  "NO_PROXY",
  "no_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
];
/** Per-spelling combinations, including the ones clients read differently. */
const COMBINATIONS: { profile: Env; inherited: Env }[] = [
  { profile: {}, inherited: {} },
  { profile: {}, inherited: { NO_PROXY: "", no_proxy: "direct.invalid" } },
  { profile: {}, inherited: { NO_PROXY: "direct.invalid", no_proxy: "" } },
  { profile: { NO_PROXY: "" }, inherited: { no_proxy: "direct.invalid" } },
  { profile: { no_proxy: "" }, inherited: { NO_PROXY: "direct.invalid" } },
  { profile: { NO_PROXY: "direct.invalid" }, inherited: { no_proxy: "" } },
  { profile: { NO_PROXY: "*" }, inherited: { no_proxy: "" } },
  { profile: {}, inherited: { NO_PROXY: "", no_proxy: "" } },
  {
    profile: { no_proxy: ".invalid" },
    inherited: { NO_PROXY: "localhost" },
  },
];

let root: string;
let target: Server, proxy: Server;
let records: string[] = [];
const record =
  (where: string) => (req: IncomingMessage, res: ServerResponse) => {
    const host = req.url?.startsWith("http://")
      ? new URL(req.url).host
      : req.headers.host;
    records.push(`${where} ${req.headers["user-agent"]} ${host}`);
    res.writeHead(where === "target" ? 200 : 502).end();
  };
const port = (server: Server) => (server.address() as AddressInfo).port;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mcp-bridge-routes-"));
  target = createServer(record("target"));
  proxy = createServer(record("proxy"));
  for (const server of [target, proxy])
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
  // urllib resolves the fictional names to the target, like curl --resolve.
  writeFileSync(
    join(root, "clients.sh"),
    `curl -q -s -o /dev/null -A curl --resolve "direct.invalid:${port(target)}:127.0.0.1" --resolve "plain.invalid:${port(target)}:127.0.0.1" "http://direct.invalid:${port(target)}/" "http://plain.invalid:${port(target)}/"
python3 -I -c 'import socket, urllib.request as u
lookup = socket.getaddrinfo
socket.getaddrinfo = lambda h, p, *a, **k: lookup("127.0.0.1", p, *a, **k)
for h in ("direct.invalid", "plain.invalid"):
    try:
        u.urlopen(u.Request("http://%s:${port(target)}/" % h, headers={"User-Agent": "urllib"}), timeout=5).read()
    except Exception:
        pass'
`,
  );
});
afterAll(async () => {
  for (const server of [target, proxy]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  rmSync(root, { recursive: true, force: true });
});

/** Real curl and urllib against both destinations; who received what. */
async function routes(env: Env): Promise<string[]> {
  records = [];
  await run("/bin/sh", [join(root, "clients.sh")], { env });
  return [...records].sort();
}
/** The proxy variables a process started with `env` sees. */
async function proxyEnv(env: Env, script = ""): Promise<Env> {
  const { stdout } = await run("/bin/sh", ["-euc", `${script}\nenv -0`], {
    env,
  });
  return Object.fromEntries(
    stdout
      .split("\0")
      .filter(Boolean)
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ])
      .filter(([key]) => PROXY_KEYS.includes(key as string)),
  );
}
/** Claude Code's settings env as the launch writes it. */
function settingsEnv(compiled: Compiled): Env {
  const file = compiled.files.find((candidate) =>
    candidate.path.endsWith(".claude-settings.json"),
  );
  return file ? ((JSON.parse(file.content) as { env?: Env }).env ?? {}) : {};
}
const toShell = (env: Env) =>
  Object.entries(env)
    .map(([key, value]) => `export ${key}='${value.replaceAll("'", "'\\''")}'`)
    .join("\n");
/** launch.sh's exports, run where the account's environment is inherited. */
function localExports(compiled: Compiled): string {
  const script = fileEnding(compiled, "/launch.sh");
  const start =
    script.indexOf("export MCP_TOKEN\n") + "export MCP_TOKEN\n".length;
  return script
    .slice(start, script.indexOf("# Git's legacy"))
    .split("\n")
    .filter((line) => !line.startsWith("export CARDIGAN_SESSION"))
    .join("\n");
}

test.each(COMBINATIONS)(
  "C-600 curl and urllib reach the same endpoints before and after every launch ($profile over $inherited)",
  async ({ profile, inherited }) => {
    const base = {
      PATH,
      http_proxy: `http://127.0.0.1:${port(proxy)}`,
      HTTP_PROXY: `http://127.0.0.1:${port(proxy)}`,
      ...inherited,
    };
    // Before: the account's environment with the profile's variables set.
    const before = { ...base, ...profile };
    const expected = await routes(before);
    // Sanity: the fixture really exercises both routes somewhere.
    expect(expected).toHaveLength(4);
    for (const harness of ["codex", "claude-code"] as const) {
      const compiled = compile(harness, {
        providerEnv: profile,
        sessionKey: SESSION_KEY,
      });
      const local = localExports(compiled);
      expect(local).not.toMatch(/cardigan_bypass|no_proxy=\$/iu);
      // Claude Code applies its settings env over the process environment.
      const settings = settingsEnv(compiled);
      const settle = harness === "claude-code" ? toShell(settings) : "";
      expect(await proxyEnv(base, `${local}\n${settle}`)).toEqual(
        await proxyEnv(before),
      );
      records = [];
      await run(
        "/bin/sh",
        ["-euc", `${local}\n${settle}\n. ${join(root, "clients.sh")}`],
        { env: base },
      );
      expect([...records].sort(), `${harness} local`).toEqual(expected);

      // The worker helper overlays launch.json's env and execs its command.
      const worker = compile(harness, {
        providerEnv: profile,
        remote: true,
        sessionKey: SESSION_KEY,
      });
      const launch = JSON.parse(fileEnding(worker, "/launch.json")) as {
        command: string;
        args: string[];
        env: Env;
      };
      expect(launch.command).toBe(worker.command);
      expect(launch.args).toEqual(worker.args);
      const overlaid = {
        ...base,
        ...launch.env,
        ...(harness === "claude-code" ? settingsEnv(worker) : {}),
      };
      expect(await proxyEnv(overlaid)).toEqual(await proxyEnv(before));
      expect(await routes(overlaid), `${harness} worker`).toEqual(expected);
    }
  },
);

// ---------------------------------------------------------------------------
// The bridge's message handling against a loopback stand-in for Card MCP.

type Reply = Record<string, unknown>;
/** Start the bridge for `url` and speak newline-delimited JSON-RPC to it. */
function bridgeClient(url: string, env: Env = {}) {
  const child = execFile("python3", mcpBridgeArgs(url), {
    env: { PATH, MCP_TOKEN: "fictional-token", ...env },
  });
  const waiting = new Map<unknown, (reply: Reply) => void>();
  let buffer = "";
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const reply = JSON.parse(buffer.slice(0, end)) as Reply;
      buffer = buffer.slice(end + 1);
      waiting.get(reply.id)?.(reply);
    }
  });
  return {
    send: (message: Reply) =>
      new Promise<Reply>((resolve) => {
        waiting.set(message.id, resolve);
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      }),
    write: (line: string) => child.stdin?.write(line),
    stderr: () => stderr,
    close: () => child.kill(),
  };
}

test("C-600 the bridge relays JSON and event-stream replies, notifications and errors without following redirects", async () => {
  const seen: string[] = [];
  let release: (() => void) | undefined;
  let arrived: () => void = () => {};
  const slowArrived = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const card = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString()) as Reply;
    seen.push(
      `${req.method} ${req.url} ${message.method} ${req.headers.authorization} ${req.headers["x-cardigan-session"]} ${req.headers["mcp-protocol-version"]}`,
    );
    const reply = (result: unknown) => ({
      jsonrpc: "2.0",
      id: message.id,
      result,
    });
    switch (message.method) {
      case "initialize":
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply({ protocolVersion: "2025-06-18" })));
        return;
      case "notifications/initialized":
        res.writeHead(202).end();
        return;
      case "slow":
        // Held until a later request completes: replies are concurrent.
        await new Promise<void>((resolve) => {
          release = resolve;
          arrived();
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply("slow")));
        return;
      case "stream":
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\nevent: message\ndata: ${JSON.stringify(reply("streamed"))}\n\n`,
        );
        release?.();
        return;
      case "moved":
        res.writeHead(307, { Location: "http://127.0.0.1:9/elsewhere" }).end();
        return;
      default:
        res.writeHead(401, {
          "Content-Type": "application/json",
          "WWW-Authenticate": "Bearer",
        });
        res.end(JSON.stringify({ error: { code: "unauthorized" } }));
    }
  });
  await new Promise<void>((resolve) => card.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${port(card)}/mcp`;
  const bridge = bridgeClient(url, { [MCP_BRIDGE_SESSION_ENV]: SESSION_KEY });
  try {
    expect(
      await bridge.send({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    ).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18" },
    });
    bridge.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const slow = bridge.send({ jsonrpc: "2.0", id: 2, method: "slow" });
    await slowArrived;
    expect(
      await bridge.send({ jsonrpc: "2.0", id: "s", method: "stream" }),
    ).toEqual({ jsonrpc: "2.0", id: "s", result: "streamed" });
    expect(await slow).toEqual({ jsonrpc: "2.0", id: 2, result: "slow" });
    expect(
      await bridge.send({ jsonrpc: "2.0", id: 3, method: "moved" }),
    ).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32000, message: "Card MCP 未返回结果：HTTP 307" },
    });
    const refused = await bridge.send({ jsonrpc: "2.0", id: 4, method: "x" });
    expect(refused).toEqual({
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32000, message: "Card MCP 未返回结果：HTTP 401" },
    });
    // Concurrent messages may arrive in any order.
    expect([...seen].sort()).toEqual(
      [
        `POST /mcp initialize Bearer fictional-token ${SESSION_KEY} undefined`,
        `POST /mcp notifications/initialized Bearer fictional-token ${SESSION_KEY} 2025-06-18`,
        `POST /mcp slow Bearer fictional-token ${SESSION_KEY} 2025-06-18`,
        `POST /mcp stream Bearer fictional-token ${SESSION_KEY} 2025-06-18`,
        `POST /mcp moved Bearer fictional-token ${SESSION_KEY} 2025-06-18`,
        `POST /mcp x Bearer fictional-token ${SESSION_KEY} 2025-06-18`,
      ].sort(),
    );
    expect(bridge.stderr()).toBe("");
  } finally {
    bridge.close();
    card.closeAllConnections();
    await new Promise<void>((resolve) => card.close(() => resolve()));
  }
});

test("C-600 the bridge refuses plain HTTP off loopback and reports an unreachable service", async () => {
  const offLoopback = bridgeClient("http://card.example.invalid/mcp");
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const shut = port(closed);
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const unreachable = bridgeClient(`http://127.0.0.1:${shut}/mcp`);
  try {
    expect(
      await offLoopback.send({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    ).toMatchObject({
      error: { message: "Card MCP 连接失败：mcp_config_invalid" },
    });
    expect(
      await unreachable.send({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    ).toMatchObject({
      error: { message: "Card MCP 连接失败：mcp_unreachable" },
    });
  } finally {
    offLoopback.close();
    unreachable.close();
  }
});
