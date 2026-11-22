import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, request } from "node:http";
import { createServer, type Server } from "node:https";
import { type AddressInfo, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMcpServer } from "@cardigan/mcp-server";
import {
  agentProcessCommand,
  type ExecutionConfig,
} from "@cardigan/runtime-herdr";
import { Store } from "@cardigan/store";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { project_id, seedProject } from "../../mcp-server/src/test-support.js";
import { runtimeWorkerMcpHosts } from "./runtime-workers-config.js";
import {
  checkWorkerMcp,
  checkWorkerMcpReachability,
  launchNoProxy,
  workerMcpConfig,
} from "./worker-mcp.js";

vi.mock("@cardigan/runtime-herdr", async (original) => ({
  ...(await original<object>()),
  agentProcessCommand: vi.fn(),
}));
let root: string, server: Server, endpoint: string;
let proxyTarget: string | undefined, observedHost: string | undefined;
let authorization: string | undefined, challenge: string | undefined;
let systemProxy: string | undefined;
let status: number,
  body: unknown,
  requests: number,
  trusted: boolean,
  stall: boolean;
const credential = "synthetic-preflight-token";
let truncated = false;
const validReply = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    protocolVersion: "2025-03-26",
    serverInfo: { name: "cardigan", version: "0.0.0" },
  },
};
const execution = (): Extract<ExecutionConfig, { mode: "agent-ssh" }> => ({
  mode: "agent-ssh",
  dataDir: "/unused",
  agentRoot: "/worker",
  gid: 1001,
  machine: "fixture",
  identityFile: "/unused/key",
  knownHostsFile: "/unused/known",
  mcp: { url: endpoint, timeoutMs: 3000 },
});

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "worker-mcp-"));
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
      "/CN=control.example-tailnet.ts.net",
      "-addext",
      "subjectAltName=DNS:control.example-tailnet.ts.net",
      "-keyout",
      join(root, "key.pem"),
      "-out",
      join(root, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  server = createServer(
    {
      key: readFileSync(join(root, "key.pem")),
      cert: readFileSync(join(root, "cert.pem")),
    },
    async (req, res) => {
      requests++;
      observedHost = req.headers.host;
      expect(req.headers.authorization).toBe(authorization);
      expect(req.url).toBe("/mcp");
      expect(req.method).toBe("POST");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      expect(JSON.parse(Buffer.concat(chunks).toString()).method).toBe(
        "initialize",
      );
      if (proxyTarget) {
        // Preserve the worker's actual Host, just as Tailscale Serve does.
        const forwarded = request(
          proxyTarget,
          { method: req.method, headers: req.headers },
          (upstream) => {
            res.writeHead(upstream.statusCode ?? 500, upstream.headers);
            upstream.pipe(res);
          },
        );
        forwarded.on("error", (error) => res.destroy(error));
        forwarded.end(Buffer.concat(chunks));
        return;
      }
      if (stall) return;
      res.writeHead(status, {
        ...(truncated ? { "Content-Length": 256, Connection: "close" } : {}),
        "Content-Type": "application/json",
        Location: "http://127.0.0.1/never-follow",
        ...(challenge ? { "WWW-Authenticate": challenge } : {}),
      });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `https://control.example-tailnet.ts.net:${(server.address() as AddressInfo).port}/mcp`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  status = 200;
  body = validReply;
  requests = 0;
  trusted = true;
  stall = false;
  truncated = false;
  proxyTarget = undefined;
  observedHost = undefined;
  authorization = `Bearer ${credential}`;
  challenge = undefined;
  systemProxy = undefined;
  vi.mocked(agentProcessCommand)
    .mockReset()
    .mockImplementation(async (_config, args) => {
      expect(args.slice(0, 4)).toEqual(["python3", "-I", "-B", "-c"]);
      expect(args.join(" ")).not.toContain(credential);
      expect(args.join(" ")).not.toContain(endpoint);
      // The SSH seam runs the actual worker program locally against a fixture TLS
      // server. Only this test adds its CA and synthetic DNS mapping.
      // A system proxy is simulated with macOS's `_scproxy` interface,
      // including an exception list the harness client does not honour.
      const prefix = `import os, socket\nos.environ.pop("SSL_CERT_FILE", None)\n${trusted ? `os.environ["SSL_CERT_FILE"] = ${JSON.stringify(join(root, "cert.pem"))}\n` : ""}${systemProxy ? `import sys, types\nscproxy = types.ModuleType("_scproxy")\nscproxy._get_proxies = lambda: {"http": ${JSON.stringify(systemProxy)}, "https": ${JSON.stringify(systemProxy)}}\nscproxy._get_proxy_settings = lambda: {"exclude_simple": False, "exceptions": ["*.ts.net"]}\nsys.modules["_scproxy"] = scproxy\n` : ""}lookup = socket.getaddrinfo\nsocket.getaddrinfo = lambda host, port, *a, **kw: lookup(host, port, *a, **kw) if host == "127.0.0.1" else lookup("127.0.0.1", ${(server.address() as AddressInfo).port}, *a, **kw)\n`;
      return { file: "python3", args: ["-I", "-B", "-c", prefix + args[4]] };
    });
});

test("machine reachability requires the service's unauthenticated rejection and cannot authenticate a launch", async () => {
  authorization = undefined;
  status = 401;
  challenge = "Bearer";
  body = { error: { code: "unauthorized", message: "unauthorized" } };
  await expect(
    checkWorkerMcpReachability(execution()),
  ).resolves.toBeUndefined();
  authorization = `Bearer ${credential}`;
  await expect(checkWorkerMcp(execution(), credential)).rejects.toThrow(
    "mcp_auth_failed",
  );
  await expect(checkWorkerMcp(execution(), "")).rejects.toThrow(
    "mcp_auth_failed",
  );
  expect(requests).toBe(2);
});

test.each([
  [200, validReply, "Bearer"],
  [401, { error: { code: "unrelated" } }, "Bearer"],
  [401, { error: { code: "unauthorized" } }, undefined],
  [401, "invalid json", "Bearer"],
  [401, "x".repeat(65537), "Bearer"],
  [403, { error: { code: "unauthorized" } }, "Bearer"],
  [302, {}, "Bearer"],
] as const)(
  "machine reachability rejects unrelated HTTP %s replies",
  async (code, reply, header) => {
    authorization = undefined;
    status = code;
    body = reply;
    challenge = header;
    await expect(checkWorkerMcpReachability(execution())).rejects.toThrow(
      /^mcp_(protocol_error|auth_failed|redirect)$/,
    );
    expect(requests).toBe(1);
  },
);

test("machine reachability against the real MCP endpoint works without issuing a Token", async () => {
  authorization = undefined;
  const dataDir = mkdtempSync(join(root, "reachability-"));
  const store = Store.open({ dataDir });
  const mcpServer = await startMcpServer({ store, port: 0, log: () => {} });
  proxyTarget = mcpServer.url;
  try {
    await expect(
      checkWorkerMcpReachability(execution()),
    ).resolves.toBeUndefined();
    trusted = false;
    await expect(checkWorkerMcpReachability(execution())).rejects.toThrow(
      "mcp_tls_failed",
    );
    expect(requests).toBe(1);
  } finally {
    proxyTarget = undefined;
    await mcpServer.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test.each(["443", "0443", "08443"])(
  "canonical port %s matches the exact Host fence through a TLS proxy",
  async (port) => {
    const configuredUrl = `https://control.example-tailnet.ts.net:${port}/mcp`;
    const mcp = workerMcpConfig(configuredUrl);
    const config = { ...execution(), mcp };
    const hosts = runtimeWorkerMcpHosts(
      [
        {
          machine_id: "worker-a",
          project_id,
          os: "linux",
          arch: "x64",
          session: "fixture",
          generation: "one",
          execution: config,
        },
      ],
      project_id,
    );
    const dataDir = mkdtempSync(join(root, "proxy-"));
    const store = Store.open({ dataDir });
    const { assignment } = seedProject(store);
    const { token } = store.issueToken({
      project_id,
      assignment_id: assignment.id,
      role: {
        role_version: assignment.role_version,
        allowed_tools: ["whoami"],
      },
      token: credential,
    });
    const mcpServer = await startMcpServer({
      store,
      port: 0,
      proxyHosts: (project) => (project === project_id ? hosts : []),
      log: () => {},
    });
    proxyTarget = mcpServer.url;
    try {
      await expect(checkWorkerMcp(config, token)).resolves.toBeUndefined();
      expect(requests).toBe(1);
      expect(hosts).toEqual([observedHost]);
      expect(mcp.url).toBe(`https://${observedHost}/mcp`);
    } finally {
      proxyTarget = undefined;
      await mcpServer.close();
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

test("worker authenticates over verified TLS without a business tool call", async () => {
  await expect(
    checkWorkerMcp(execution(), credential),
  ).resolves.toBeUndefined();
  expect(agentProcessCommand).toHaveBeenCalledWith(
    execution(),
    expect.any(Array),
  );
  expect(requests).toBe(1);
});
test.each([401, 403, 301, 302, 307, 308, 404, 500, 502, 503])(
  "HTTP %s refuses startup without following redirects",
  async (code) => {
    status = code;
    await expect(checkWorkerMcp(execution(), credential)).rejects.toThrow(
      code === 401 || code === 403
        ? "mcp_auth_failed"
        : code < 400
          ? "mcp_redirect"
          : code >= 500
            ? "mcp_gateway_error"
            : "mcp_protocol_error",
    );
    expect(requests).toBe(1);
  },
);
test("incomplete gateway response is distinct from a complete invalid MCP reply", async () => {
  truncated = true;
  body = "{";
  await expect(checkWorkerMcp(execution(), credential)).rejects.toThrow(
    /^mcp_gateway_error$/,
  );
});
test.each([
  "not-json",
  "x".repeat(65537),
  { ...validReply, id: 2 },
  { jsonrpc: "2.0", id: 1, error: { message: credential } },
  {
    ...validReply,
    result: { ...validReply.result, serverInfo: { name: "other" } },
  },
])(
  "invalid MCP response is rejected without echoing the body",
  async (reply) => {
    body = reply;
    await expect(checkWorkerMcp(execution(), credential)).rejects.toThrow(
      /^mcp_protocol_error$/,
    );
  },
);
test("untrusted TLS never sends the token and never falls back to HTTP", async () => {
  trusted = false;
  await expect(checkWorkerMcp(execution(), credential)).rejects.toThrow(
    /^mcp_tls_failed$/,
  );
  expect(requests).toBe(0);
});
test("a trusted certificate for another hostname still fails before sending the token", async () => {
  await expect(
    checkWorkerMcp(
      {
        ...execution(),
        mcp: { url: endpoint.replace("control.", "other."), timeoutMs: 3000 },
      },
      credential,
    ),
  ).rejects.toThrow(/^mcp_tls_failed$/);
  expect(requests).toBe(0);
});
test("deadline bounds a stalled worker request", async () => {
  stall = true;
  await expect(
    checkWorkerMcp(
      { ...execution(), mcp: { url: endpoint, timeoutMs: 200 } },
      credential,
    ),
  ).rejects.toThrow(/^mcp_timeout$/);
});
test("SSH failure is redacted", async () => {
  vi.mocked(agentProcessCommand).mockRejectedValueOnce(new Error(credential));
  await expect(checkWorkerMcp(execution(), credential)).rejects.toThrow(
    /^mcp_worker_failed$/,
  );
  expect(requests).toBe(0);
});

/** A CONNECT proxy, like the local proxy app that captured the tailnet traffic. */
async function connectProxy() {
  let tunnels = 0;
  const proxy = createHttpServer();
  proxy.on("connect", (_req, client: Socket, head: Buffer) => {
    tunnels++;
    const upstream = connect(
      (server.address() as AddressInfo).port,
      "127.0.0.1",
      () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      },
    );
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    tunnels: () => tunnels,
    close: () =>
      new Promise<void>((resolve) => {
        proxy.closeAllConnections();
        proxy.close(() => resolve());
      }),
  };
}

/** A proxy address nothing listens on, as when the proxy cannot reach the tailnet. */
async function deadProxy() {
  const probe = createHttpServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

test("C-600 the launch's NO_PROXY keeps the harness route direct despite a system proxy", async () => {
  expect(launchNoProxy(endpoint)).toEqual(["control.example-tailnet.ts.net"]);
  systemProxy = await deadProxy();
  authorization = undefined;
  status = 401;
  challenge = "Bearer";
  body = { error: { code: "unauthorized", message: "unauthorized" } };
  await expect(
    checkWorkerMcpReachability(execution()),
  ).resolves.toBeUndefined();
  for (const entry of [".example-tailnet.ts.net", "ts.net", "*"])
    await expect(
      checkWorkerMcpReachability(execution(), ["localhost", entry]),
    ).resolves.toBeUndefined();
  // Authenticated launch preflight takes the same route.
  authorization = `Bearer ${credential}`;
  status = 200;
  body = validReply;
  challenge = undefined;
  await expect(
    checkWorkerMcp(execution(), credential),
  ).resolves.toBeUndefined();
  expect(requests).toBe(5);
});

test("C-600 without a covering NO_PROXY the machine check reports the system proxy route", async () => {
  systemProxy = await deadProxy();
  authorization = undefined;
  status = 401;
  challenge = "Bearer";
  body = { error: { code: "unauthorized", message: "unauthorized" } };
  // The OS exception list (*.ts.net) is ignored, exactly like the harness.
  for (const noProxy of [[], ["other.ts.net"], ["tailnet.ts.net"]])
    await expect(
      checkWorkerMcpReachability(execution(), noProxy),
    ).rejects.toThrow(/^mcp_harness_proxy_failed$/);
  expect(requests).toBe(0);

  const proxy = await connectProxy();
  systemProxy = proxy.url;
  try {
    await expect(
      checkWorkerMcpReachability(execution(), []),
    ).resolves.toBeUndefined();
    expect(proxy.tunnels()).toBe(1);
    expect(requests).toBe(1);
  } finally {
    await proxy.close();
  }
});

test("C-600 without a system proxy setting the probe connects directly", async () => {
  authorization = undefined;
  status = 401;
  challenge = "Bearer";
  body = { error: { code: "unauthorized", message: "unauthorized" } };
  await expect(
    checkWorkerMcpReachability(execution(), []),
  ).resolves.toBeUndefined();
  expect(requests).toBe(1);
});
