import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  request,
} from "node:http";
import { createServer, type Server } from "node:https";
import { type AddressInfo, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Assignment,
  queueRun,
  type Role,
  type Runtime,
} from "@cardigan/domain";
import { type RunningServer, startMcpServer } from "@cardigan/mcp-server";
import { MCP_BRIDGE_SOURCE, parseLaunchConfig } from "@cardigan/roles";
import { Store, writeRole } from "@cardigan/store";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { applyCommand } from "./commands.js";
import { launchRun } from "./launch.js";

/**
 * C-600: the Codex session's Card connection, end to end. The real host launch
 * flow writes Codex's config.toml; the test starts exactly the stdio server it
 * names (the bridge) and talks to it the way Codex does, newline-delimited
 * JSON-RPC. The Card service is the real MCP endpoint behind a TLS front with
 * a tailnet name, like Tailscale Serve. Every proxy setting the bridge could
 * read points at a recording proxy that could reach the Card service too.
 */
const CARD_HOST = "card.example-tailnet.ts.net";
const project = "mcp-bridge";

let root: string;
let store: Store;
let mcp: RunningServer;
let front: Server;
let cardUrl: string;
/** What the Card side received: method, Token and session key presence. */
let received: string[];
/** Every connection or request the proxy saw. */
let proxied: string[];
let proxy: ReturnType<typeof createHttpServer>;
let proxyUrl: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cg-mcp-bridge-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${CARD_HOST}`,
      "-addext",
      `subjectAltName=DNS:${CARD_HOST}`,
      "-keyout",
      join(root, "key.pem"),
      "-out",
      join(root, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  const dataDir = join(root, "data");
  await mkdir(dataDir, { mode: 0o700 });
  store = Store.open({ dataDir });
  store.createProject({ id: project, name: "MCP bridge" });
  front = createServer(
    {
      key: readFileSync(join(root, "key.pem")),
      cert: readFileSync(join(root, "cert.pem")),
    },
    async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      let method = "?";
      try {
        method =
          (JSON.parse(body.toString()) as { method?: string }).method ??
          "reply";
      } catch {}
      received.push(
        `${req.method} ${req.headers.host} ${method} token=${req.headers.authorization?.startsWith("Bearer ") === true} session=${typeof req.headers["x-cardigan-session"] === "string"}`,
      );
      // Preserve the client's Host, just as Tailscale Serve does.
      const forwarded = request(
        mcp.url,
        { method: req.method, headers: req.headers },
        (upstream) => {
          res.writeHead(upstream.statusCode ?? 500, upstream.headers);
          upstream.pipe(res);
        },
      );
      forwarded.on("error", (error) => res.destroy(error));
      forwarded.end(body);
    },
  );
  await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
  const port = (front.address() as AddressInfo).port;
  cardUrl = `https://${CARD_HOST}:${port}/mcp`;
  mcp = await startMcpServer({
    store,
    port: 0,
    proxyHosts: (id) => (id === project ? [`${CARD_HOST}:${port}`] : []),
    log: () => {},
  });
  // A proxy that would tunnel anything to the Card front.
  proxy = createHttpServer((req, res) => {
    proxied.push(`${req.method} ${req.url}`);
    res.writeHead(502).end();
  });
  proxy.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    proxied.push(`CONNECT ${req.url}`);
    const upstream = connect(port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const server of [front, proxy]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await mcp.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  received = [];
  proxied = [];
});

let next = 0;
/** A fresh Assignment launched by the real host flow with Codex. */
async function launchCodex() {
  next++;
  const clock = { now: () => "2026-01-01T00:00:00.000Z" };
  const role: Role = {
    role_id: `pm${next}`,
    version: 1,
    display_name: "PM",
    kind: "standing",
    harness: "codex",
    core_prompt: "Fixture",
    launch_profile_ref: "fixture",
    allowed_tools: ["whoami", "finish_run"],
    capabilities: [],
    abilities: [],
    worktree: "none",
    required_machine_tags: [],
  };
  const assignment: Assignment = {
    id: `A-${next}` as Assignment["id"],
    scope: "standing",
    standing_mode: "ops",
    role_id: role.role_id,
    role_version: 1,
    status: "active",
    runtime_state: "not_provisioned",
    runtime_ref: null,
    machine_id: "local",
    mcp_token_id: "fixture",
    created_at: clock.now(),
  };
  store.uow.run((tx) => {
    writeRole(tx, project, role, { mode: "add" });
    tx.assignments.put(project, assignment);
  });
  const runtime = {
    provision: vi.fn(async () => ({
      ok: true,
      value: {
        machine_id: "local",
        runtime_machine: "local",
        terminal_ref: `fixture-${next}`,
        agent_name: `fixture-${next}`,
      },
    })),
    release: vi.fn(async () => ({ ok: true, value: undefined })),
  } as unknown as Runtime;
  const actor = { kind: "human" as const, project_id: project };
  const run = applyCommand(store, {
    project,
    actor,
    clock,
    reduce: (state, who, ports) =>
      queueRun(
        state,
        who,
        {
          assignment_id: assignment.id,
          model: "fixture",
          agent_cli_version: "fixture",
        },
        ports,
      ),
  });
  const dataDir = join(root, "data");
  const launched = await launchRun(
    {
      store,
      runtime,
      dataDir,
      execution: { mode: "local", dataDir },
      clock,
      mcpUrl: cardUrl,
      verifyMcpSession: true,
      launch: {
        config: parseLaunchConfig({
          profiles: { fixture: { harness: "codex", model: "fixture" } },
        }),
        secrets: {},
      },
    },
    { project, assignment_id: assignment.id, actor, run },
  );
  const config = await readFile(
    join(launched.run_dir, "codex", "config.toml"),
    "utf8",
  );
  const table =
    /\[mcp_servers\.card\]\n([\s\S]*?)\n\n/u.exec(config)?.[1] ?? "";
  const field = (name: string) =>
    new RegExp(`^${name} = (.*)$`, "mu").exec(table)?.[1];
  const server = {
    command: JSON.parse(field("command") ?? "null") as string,
    args: JSON.parse(field("args") ?? "[]") as string[],
    envVars: JSON.parse(field("env_vars") ?? "[]") as string[],
    env: Object.fromEntries(
      [...(field("env") ?? "").matchAll(/"([A-Z_]+)" = "([^"]*)"/gu)].map(
        (match) => [match[1], match[2]],
      ),
    ) as Record<string, string>,
  };
  const token = (
    await readFile(join(launched.run_dir, "token"), "utf8")
  ).trim();
  return { launched, assignment, server, token, config };
}

const state = (assignment: Assignment) =>
  store.uow.read((tx) => tx.assignments.get(project, assignment.id));
const runStatus = (run_id: string) =>
  store.uow.read((tx) => tx.runs.get(project, run_id as never))?.status;

/**
 * Start the configured stdio server as Codex would: its command and args,
 * the variables `env_vars` forwards and its own `env` table. The only test
 * seams: the fixture CA, the tailnet name resolving to the TLS front, and a
 * macOS system proxy (`_scproxy`) whose exception list omits the tailnet.
 */
function startBridge(
  server: Awaited<ReturnType<typeof launchCodex>>["server"],
  env: Record<string, string>,
) {
  const [isolate, bytecode, flag, source, ...rest] = server.args;
  expect([isolate, bytecode, flag, source]).toEqual([
    "-I",
    "-B",
    "-c",
    MCP_BRIDGE_SOURCE,
  ]);
  const seam = `import os, socket, sys, types
os.environ["SSL_CERT_FILE"] = ${JSON.stringify(join(root, "cert.pem"))}
lookup = socket.getaddrinfo
socket.getaddrinfo = lambda host, port, *a, **kw: lookup("127.0.0.1", port, *a, **kw) if host == ${JSON.stringify(CARD_HOST)} else lookup(host, port, *a, **kw)
scproxy = types.ModuleType("_scproxy")
scproxy._get_proxies = lambda: {"http": ${JSON.stringify(proxyUrl)}, "https": ${JSON.stringify(proxyUrl)}}
scproxy._get_proxy_settings = lambda: {"exclude_simple": False, "exceptions": []}
sys.modules["_scproxy"] = scproxy
sys.platform = "darwin"
`;
  // The configured interpreter is an absolute path to this machine's python3.
  expect(server.command).toBe("/usr/bin/python3");
  const child = spawn(
    "python3",
    [isolate, bytecode, flag, seam + source, ...rest] as string[],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return { child, stderr: () => stderr, ...client(child) };
}

/** Newline-delimited JSON-RPC over stdio, as Codex's MCP client speaks it. */
function client(child: ChildProcess) {
  const waiting = new Map<number, (reply: Record<string, unknown>) => void>();
  let buffer = "";
  const lines: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      lines.push(line);
      const reply = JSON.parse(line) as Record<string, unknown>;
      waiting.get(reply.id as number)?.(reply);
    }
  });
  let id = 0;
  return {
    lines,
    send(method: string, params: Record<string, unknown> = {}) {
      id++;
      const current = id;
      return new Promise<Record<string, unknown>>((resolve) => {
        waiting.set(current, resolve);
        child.stdin?.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: current, method, params })}\n`,
        );
      });
    },
    notify(method: string) {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
  };
}
const INITIALIZE = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "codex-mcp-client", version: "0.161.0" },
};

/** Proxy variables of every spelling, including the case conflicts. */
const proxyVariables = (extra: Record<string, string>) => ({
  HTTPS_PROXY: proxyUrl,
  https_proxy: proxyUrl,
  HTTP_PROXY: proxyUrl,
  http_proxy: proxyUrl,
  ALL_PROXY: proxyUrl,
  all_proxy: proxyUrl,
  ...extra,
});

test.each([
  { NO_PROXY: "", no_proxy: "model.invalid" },
  { NO_PROXY: "model.invalid", no_proxy: "" },
  { NO_PROXY: "", no_proxy: "" },
  {},
])(
  "C-600 Codex's Card connection reaches the Card service directly with proxies everywhere (%o)",
  async (lists) => {
    const { launched, assignment, server, token, config } = await launchCodex();
    expect(server.envVars).toEqual(["MCP_TOKEN"]);
    expect(config).not.toContain(token);
    expect(server.args.join(" ")).not.toContain(token);
    expect(server.args.join(" ")).not.toContain(
      server.env.CARDIGAN_MCP_SESSION,
    );
    expect(state(assignment)?.mcp_handshake).toBe("pending");
    const bridge = startBridge(server, {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      MCP_TOKEN: token,
      ...server.env,
      ...proxyVariables(lists),
    });
    try {
      const init = await bridge.send("initialize", INITIALIZE);
      expect(init.result).toMatchObject({ serverInfo: { name: "cardigan" } });
      bridge.notify("notifications/initialized");
      const listed = await bridge.send("tools/list");
      expect(
        (listed.result as { tools: { name: string }[] }).tools.map(
          (tool) => tool.name,
        ),
      ).toContain("whoami");
      // Listing alone starts nothing; the session's first tool call does.
      expect(state(assignment)?.mcp_handshake).toBe("listed");
      expect(runStatus(launched.run.id)).toBe("dispatched");
      const whoami = await bridge.send("tools/call", {
        name: "whoami",
        arguments: {},
      });
      expect(whoami.error).toBeUndefined();
      expect(JSON.stringify(whoami.result)).toContain(assignment.id);
      expect(runStatus(launched.run.id)).toBe("running");

      const host = `${CARD_HOST}:${(front.address() as AddressInfo).port}`;
      // initialize is answered before anything else is sent; the bridge
      // relays later messages concurrently, so they may arrive in any order.
      await vi.waitFor(() => expect(received).toHaveLength(4));
      expect(received[0]).toBe(
        `POST ${host} initialize token=true session=true`,
      );
      expect(received.slice(1).sort()).toEqual([
        `POST ${host} notifications/initialized token=true session=true`,
        `POST ${host} tools/call token=true session=true`,
        `POST ${host} tools/list token=true session=true`,
      ]);
      expect(proxied).toEqual([]);
      // Nothing about the Token or the key reaches the diagnostics stream.
      expect(bridge.stderr()).toBe("");
    } finally {
      bridge.child.kill();
    }
  },
);

test("C-600 a bridge without this launch's session key gets no tools to work with", async () => {
  const { launched, assignment, server, token } = await launchCodex();
  const bridge = startBridge(server, {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    MCP_TOKEN: token,
    ...proxyVariables({}),
  });
  try {
    await bridge.send("initialize", INITIALIZE);
    await bridge.send("tools/list");
    // A listing without the key proves nothing about the launched harness.
    expect(state(assignment)?.mcp_handshake).toBe("pending");
    const refused = await bridge.send("tools/call", {
      name: "whoami",
      arguments: {},
    });
    expect(JSON.stringify(refused)).toContain("MCP 初始化失败");
    expect(state(assignment)?.mcp_handshake).toBe("missing");
    expect(runStatus(launched.run.id)).toBe("dispatched");
    expect(proxied).toEqual([]);
  } finally {
    bridge.child.kill();
  }
});

test("C-600 an untrusted certificate fails initialize before the Token leaves, and the proxy is never tried", async () => {
  const { server, token, assignment } = await launchCodex();
  const [isolate, bytecode, flag, source, ...rest] = server.args;
  // No fixture CA: the front's certificate is not trusted.
  const child = spawn(
    "python3",
    [
      isolate,
      bytecode,
      flag,
      `import socket\nlookup = socket.getaddrinfo\nsocket.getaddrinfo = lambda host, port, *a, **kw: lookup("127.0.0.1", port, *a, **kw) if host == ${JSON.stringify(CARD_HOST)} else lookup(host, port, *a, **kw)\n${source}`,
      ...rest,
    ] as string[],
    {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        MCP_TOKEN: token,
        ...server.env,
        ...proxyVariables({}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const bridge = client(child);
  try {
    const init = await bridge.send("initialize", INITIALIZE);
    expect(init.error).toEqual({
      code: -32000,
      message: "Card MCP 连接失败：mcp_tls_failed",
    });
    expect(JSON.stringify(init)).not.toContain(token);
    expect(received).toEqual([]);
    expect(proxied).toEqual([]);
    // The session never lists tools: the handshake deadline settles it.
    expect(state(assignment)?.mcp_handshake).toBe("pending");
  } finally {
    child.kill();
  }
});
