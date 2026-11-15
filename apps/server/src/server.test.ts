import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeTargets } from "@cardigan/host";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { requestCheckControl } from "./check-handoff-control.js";
import { installShutdownHandlers } from "./lifecycle.js";
import { type CardiganServer, startCardiganServer } from "./server.js";
import { resolveWebConfig } from "./web/config.js";

let dataDir: string;
let store: Store;
let server: CardiganServer;
let warnings: string[];

beforeEach(async () => {
  warnings = [];
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-server-"));
  store = Store.open({ dataDir });
  server = await startCardiganServer({
    config: { dataDir, host: "127.0.0.1", port: 0 },
    store,
    warn: (message) => warnings.push(message),
  });
});

test("local server startup visibly warns that the Agent account is not isolated", () => {
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("没有 Agent 账号隔离");
  expect(warnings[0]).toContain("agent-ssh");
  expect(
    JSON.parse(readFileSync(join(dataDir, "runtime.json"), "utf8")),
  ).toEqual({ mode: "local", session: "cardigan" });
});

test("artifact startup failure visibly disables handoff with a queryable recovery condition while MCP/Web stay available", async () => {
  await server.close();
  const runtime = await RuntimeTargets.create({
    execution: { mode: "local", dataDir },
    session: "cardigan",
    store,
    workers: () => [],
  });
  if (!runtime.ok) throw new Error("fixture runtime");
  let repaired = false;
  const options = {
    config: { dataDir, host: "127.0.0.1", port: 0 },
    store,
    warn: (message: string) => warnings.push(message),
    checkArtifact: async () => {
      if (!repaired) throw new Error("synthetic-private-artifact-detail");
      return { software_sha: "a".repeat(40), artifact_sha256: "b".repeat(64) };
    },
    dispatcher: {
      runtime: runtime.value,
      snapshot: async () => {
        throw new Error("unexpected snapshot");
      },
      startRun: async () => {
        throw new Error("unexpected launch");
      },
    },
    web: { config: resolveWebConfig({}, { port: 0 }), log: () => {} },
  };
  server = await startCardiganServer(options);
  expect(
    warnings.some(
      (message) =>
        message.includes("artifact_unavailable") &&
        message.includes("修复制品后重新启动"),
    ),
  ).toBe(true);
  expect(warnings.join()).not.toContain("synthetic-private-artifact-detail");
  expect((await fetch(server.url)).status).toBe(401);
  expect((await fetch(`${server.web?.url}/api/session`)).status).toBe(200);
  expect(
    await requestCheckControl(dataDir, {
      action: "status",
      project: "fixture",
    }),
  ).toMatchObject([
    {
      phase: "unavailable",
      diagnostic: {
        code: "artifact_unavailable",
        recovery: "repair_artifact_then_restart_controller",
      },
    },
  ]);
  await expect(
    requestCheckControl(dataDir, { action: "begin", project: "fixture" }),
  ).rejects.toMatchObject({ diagnostic: { code: "artifact_unavailable" } });
  repaired = true;
  await expect(
    requestCheckControl(dataDir, { action: "begin", project: "fixture" }),
  ).rejects.toMatchObject({
    diagnostic: {
      code: "artifact_unavailable",
      recovery: "repair_artifact_then_restart_controller",
    },
  });
  await server.close();
  server = await startCardiganServer(options);
  expect(
    await requestCheckControl(dataDir, {
      action: "status",
      project: "fixture",
    }),
  ).toEqual([]);
});

test("C-152: a failed or competing start never replaces the live server's registration", async () => {
  const registration = () =>
    JSON.parse(readFileSync(join(dataDir, "runtime.json"), "utf8"));
  expect(registration()).toEqual({ mode: "local", session: "cardigan" });
  await expect(
    startCardiganServer({
      config: {
        dataDir,
        host: "127.0.0.1",
        port: server.port,
        listenRetryIntervalMs: 5,
        listenRetryTimeoutMs: 10,
      },
      store,
      env: { CARDIGAN_RUNTIME_MODE: "local", CARDIGAN_HC_SESSION: "other" },
      warn: () => {},
    }),
  ).rejects.toMatchObject({ code: "EADDRINUSE" });
  expect(registration()).toEqual({ mode: "local", session: "cardigan" });
});

test("C-152: a shell without runtime.env cannot downgrade an agent-ssh registration", async () => {
  await server.close();
  const agent = {
    mode: "agent-ssh",
    session: "cardigan",
    machine: "cardigan-agent",
    agentRoot: "/srv/agent",
    gid: 900,
    identityFile: "/keys/id",
    knownHostsFile: "/keys/known_hosts",
  };
  writeFileSync(join(dataDir, "runtime.json"), JSON.stringify(agent));
  const start = (env: Record<string, string>) =>
    startCardiganServer({
      config: { dataDir, host: "127.0.0.1", port: 0 },
      store,
      env,
      warn: () => {},
    });
  await expect(start({})).rejects.toThrow(/CARDIGAN_RUNTIME_MODE=local/);
  expect(
    JSON.parse(readFileSync(join(dataDir, "runtime.json"), "utf8")),
  ).toEqual(agent);
  // An explicit switch to local is the operator's decision and is registered.
  server = await start({ CARDIGAN_RUNTIME_MODE: "local" });
  expect(
    JSON.parse(readFileSync(join(dataDir, "runtime.json"), "utf8")),
  ).toEqual({ mode: "local", session: "cardigan" });
});

test("server refuses to replace the registered session while a historical local ref remains after SSH migration", async () => {
  store.createProject({ id: "fixture", name: "Fixture" });
  store.uow.run((tx) =>
    tx.assignments.put("fixture", {
      id: "A-1",
      scope: "standing",
      role_id: "pm",
      role_version: 1,
      status: "active",
      runtime_state: "idle",
      machine_id: "local",
      mcp_token_id: "fixture",
      created_at: "2026-01-01T00:00:00Z",
      runtime_ref: {
        machine_id: "local",
        runtime_machine: "local",
        terminal_ref: "t1",
        agent_name: "old-local",
      },
    }),
  );
  const execution = {
    mode: "agent-ssh" as const,
    dataDir,
    machine: "fixture-agent",
    agentRoot: "/synthetic/agent",
    gid: 2001,
    identityFile: "/synthetic/key",
    knownHostsFile: "/synthetic/known_hosts",
  };
  const registration = { ...execution, session: "old-session" };
  writeFileSync(join(dataDir, "runtime.json"), JSON.stringify(registration));
  const runtime = await RuntimeTargets.create({
    execution,
    session: "old-session",
    store,
    workers: () => [],
  });
  if (!runtime.ok) throw new Error("Invalid fixture router");
  await expect(
    startCardiganServer({
      config: { dataDir, host: "127.0.0.1", port: 0, execution },
      store,
      env: { CARDIGAN_HC_SESSION: "new-session" },
      dispatcher: {
        runtime: runtime.value,
        snapshot: async () => {
          throw new Error("Unexpected snapshot");
        },
        startRun: async () => {
          throw new Error("Unexpected launch");
        },
      },
    }),
  ).rejects.toThrow("Runtime target rejected");
  expect(
    JSON.parse(readFileSync(join(dataDir, "runtime.json"), "utf8")),
  ).toEqual(registration);
  expect(
    store.uow.read((tx) => tx.assignments.get("fixture", "A-1"))?.runtime_ref
      ?.terminal_ref,
  ).toBe("t1");
});

test.each([
  ["unreadable", "EACCES"],
  ["invalid JSON", "SyntaxError"],
])(
  "C-152: an %s registration stops the start instead of being treated as missing",
  async (kind) => {
    await server.close();
    const path = join(dataDir, "runtime.json");
    const agent = JSON.stringify({
      mode: "agent-ssh",
      session: "cardigan",
      machine: "cardigan-agent",
      agentRoot: "/srv/agent",
      gid: 900,
      identityFile: "/keys/id",
      knownHostsFile: "/keys/known_hosts",
    });
    writeFileSync(path, kind === "unreadable" ? agent : agent.slice(0, 20));
    if (kind === "unreadable") chmodSync(path, 0o000);
    const start = () =>
      startCardiganServer({
        config: { dataDir, host: "127.0.0.1", port: 0 },
        store,
        env: {},
        warn: () => {},
      });
    try {
      // Root ignores file modes; the unreadable case needs a regular user.
      if (kind === "unreadable" && process.getuid?.() === 0) return;
      await expect(start()).rejects.toThrow(
        /无法读取数据目录中已有的运行时登记/,
      );
      chmodSync(path, 0o600);
      expect(readFileSync(path, "utf8")).toBe(
        kind === "unreadable" ? agent : agent.slice(0, 20),
      );
    } finally {
      // Restore a running server for afterEach.
      chmodSync(path, 0o600);
      rmSync(path);
      server = await startCardiganServer({
        config: { dataDir, host: "127.0.0.1", port: 0 },
        store,
        warn: () => {},
      });
    }
  },
);

test("C-155: an unsafe data directory is rejected before its runtime registration is read", async () => {
  // A symlinked data directory is refused by the permission check. Its corrupt
  // runtime.json must not be read first, so the error names the directory.
  const target = mkdtempSync(join(tmpdir(), "cardigan-target-"));
  const link = `${target}-link`;
  try {
    writeFileSync(join(target, "runtime.json"), "{not json");
    symlinkSync(target, link);
    await expect(
      startCardiganServer({
        config: { dataDir: link, host: "127.0.0.1", port: 0 },
        store,
        env: { CARDIGAN_RUNTIME_MODE: "local" },
        warn: () => {},
      }),
    ).rejects.toThrow(
      "Data directory must be host-owned and must not be a symlink",
    );
  } finally {
    rmSync(link, { force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("server startup reports invalid merge gate settings in Chinese without exposing YAML values", async () => {
  await server.close();
  writeFileSync(
    join(dataDir, "merge-gate.yaml"),
    "projects: [secret-fixture-value]",
  );
  warnings = [];
  server = await startCardiganServer({
    config: { dataDir, host: "127.0.0.1", port: 0 },
    store,
    env: { CARDIGAN_CONFIG_DIR: dataDir },
    warn: (message) => warnings.push(message),
  });
  expect(warnings.join("\n")).toContain("所有项目暂停合并");
  expect(warnings.join("\n")).not.toContain("secret-fixture-value");
});

test.skipIf(process.platform !== "linux")(
  "agent server refuses unsafe data permissions before opening its database",
  async () => {
    const privateDir = join(dataDir, "private");
    mkdirSync(privateDir, { mode: 0o750 });
    chmodSync(privateDir, 0o750);
    const config = {
      dataDir: privateDir,
      host: "127.0.0.1" as const,
      port: 0,
      execution: {
        mode: "agent-ssh" as const,
        dataDir: privateDir,
        agentRoot: join(dataDir, "agent"),
        gid: process.getgid?.() ?? 0,
        machine: "cardigan-agent",
        identityFile: join(dataDir, "key"),
        knownHostsFile: join(dataDir, "known"),
      },
    };
    await expect(startCardiganServer({ config })).rejects.toThrow(/0700/);
    expect(readdirSync(privateDir)).toEqual([]);
    chmodSync(privateDir, 0o700);
    const isolatedWarnings: string[] = [];
    const isolated = await startCardiganServer({
      config,
      // agent-ssh never runs workspace Git without the Agent execution entry.
      captureAgent: async () => ({ ok: true, value: "" }),
      warn: (m) => isolatedWarnings.push(m),
    });
    try {
      expect(statSync(privateDir).mode & 0o777).toBe(0o700);
      expect(isolatedWarnings).toEqual([]);
      expect(isolated.store.listProjects()).toEqual([]);
      // C-152: the CLI compares its shell against this registration.
      expect(
        JSON.parse(readFileSync(join(privateDir, "runtime.json"), "utf8")),
      ).toEqual({
        mode: "agent-ssh",
        session: "cardigan",
        machine: "cardigan-agent",
        agentRoot: join(dataDir, "agent"),
        gid: process.getgid?.() ?? 0,
        identityFile: join(dataDir, "key"),
        knownHostsFile: join(dataDir, "known"),
      });
      expect(statSync(join(privateDir, "runtime.json")).mode & 0o777).toBe(
        0o600,
      );
    } finally {
      await isolated.close();
    }
  },
);

afterEach(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function connect(token: string | undefined): Promise<Client> {
  const client = new Client({ name: "fictional-smoke", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    ...(token === undefined
      ? {}
      : { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  });
  return client.connect(transport).then(() => client);
}

function textOf(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  const text = content?.[0]?.text;
  return text === undefined
    ? {}
    : (JSON.parse(text) as Record<string, unknown>);
}

/** Seed one project, card, work item, assignment and token. */
function seed(store: Store): string {
  const allowed_tools = [
    "whoami",
    "get_card",
    "post_comment",
    "upload_attachment",
  ] as const;
  const project_id = "p-smoke" as never;
  store.createProject({ id: project_id, name: "Smoke" });
  store.uow.run((tx) => {
    tx.cards.put(project_id, {
      id: "C-1" as never,
      project_id,
      title: "Fictional card",
      goal: "",
      acceptance_criteria: [],
      source: { kind: "quote", text: "" },
      out_of_scope: [],
      related_cards: [],
      repo: "example/repo",
      base_branch: "main",
      priority: 1,
      status: "todo",
      template: "dev",
      created_by: "human",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    tx.work_items.put(project_id, {
      id: "W-1" as never,
      card_id: "C-1" as never,
      title: "Fictional work item",
      kind: "produce",
      role_id: "coder",
      required: true,
      depends_on: [],
      completion_criteria: [],
      status: "todo",
    });
    tx.assignments.put(project_id, {
      id: "A-1" as never,
      scope: "work_item",
      work_item_id: "W-1" as never,
      role_id: "coder",
      role_version: 1,
      status: "active",
      runtime_state: "not_running" as never,
      machine_id: "local",
      runtime_ref: null,
      mcp_token_id: "tok_smoke",
      created_at: "2026-01-01T00:00:00.000Z",
    } as never);
    tx.roles.put(project_id, {
      role_id: "coder",
      role_version: 1,
      allowed_tools,
      capabilities: ["code"],
    });
  });

  // The plan's M1.7a smoke test issues the token directly through the store.
  return store.issueToken({
    project_id,
    assignment_id: "A-1" as never,
    role: { role_version: 1, allowed_tools },
    token: "fictional-smoke-token",
  }).token;
}

test("the assembled server answers whoami with the token identity", async () => {
  const token = seed(store);
  const client = await connect(token);

  const result = await client.callTool({ name: "whoami", arguments: {} });
  expect(result.isError).toBeFalsy();
  expect(textOf(result)).toMatchObject({
    project_id: "p-smoke",
    assignment_id: "A-1",
    role_id: "coder",
    card_id: "C-1",
    machine_id: "local",
  });

  // get_card works through the same assembled server.
  const card = await client.callTool({
    name: "get_card",
    arguments: { card_id: "C-1" },
  });
  expect(textOf(card)).toMatchObject({ card: { id: "C-1" } });
});

test("the assembled server still rejects requests without a token", async () => {
  const response = await fetch(server.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(response.status).toBe(401);
});

test("uploads use the assembled server's configured data directory", async () => {
  const client = await connect(seed(store));
  try {
    const comment = textOf(
      await client.callTool({
        name: "post_comment",
        arguments: {
          idempotency_key: "comment",
          card_id: "C-1",
          body: "Attach here",
        },
      }),
    );
    const result = await client.callTool({
      name: "upload_attachment",
      arguments: {
        idempotency_key: "upload",
        card_id: "C-1",
        file: "aGk=",
        mime: "text/plain",
        kind: "evidence",
        attach_to: { kind: "timeline_entry", id: comment.id },
      },
    });
    expect(result.isError).not.toBe(true);
    expect(
      readFileSync(join(dataDir, String(textOf(result).storage_path)), "utf8"),
    ).toBe("hi");
  } finally {
    await client.close();
  }
});

test("close() closes the MCP endpoint and the store it owns", async () => {
  const owned = await startCardiganServer({
    config: { dataDir, host: "127.0.0.1", port: 0 },
  });
  const url = owned.url;
  await owned.close();

  await expect(fetch(url, { method: "POST" })).rejects.toThrow();
  // The store was opened by the server and closed with it.
  expect(() => owned.store.listProjects()).toThrow(/database is not open/i);
});

test("a failing port bind closes the store it opened", async () => {
  const first = await startCardiganServer({
    config: { dataDir, host: "127.0.0.1", port: 0 },
  });
  try {
    await expect(
      startCardiganServer({
        config: {
          dataDir,
          host: "127.0.0.1",
          port: first.port,
          listenRetryIntervalMs: 5,
          listenRetryTimeoutMs: 10,
        },
      }),
    ).rejects.toThrow();
  } finally {
    await first.close();
  }
});

test.each(["MCP", "Web"])(
  "%s starts on the same port after its previous owner releases it",
  async (listener) => {
    const occupied = createServer();
    await new Promise<void>((resolve) =>
      occupied.listen(0, "127.0.0.1", resolve),
    );
    const port = (occupied.address() as { port: number }).port;
    const messages: string[] = [];
    let release: Promise<void> | undefined;
    let started: CardiganServer | undefined;
    try {
      started = await startCardiganServer({
        config: {
          dataDir,
          host: "127.0.0.1",
          port: listener === "MCP" ? port : 0,
          listenRetryIntervalMs: 10,
          listenRetryTimeoutMs: 1_000,
        },
        store,
        warn: (message) => {
          messages.push(message);
          // Release only after a genuine bind conflict, with no timing guess.
          if (message.includes("EADDRINUSE") && !release)
            release = new Promise<void>((resolve, reject) =>
              occupied.close((error) => (error ? reject(error) : resolve())),
            );
        },
        ...(listener === "Web"
          ? { web: { config: resolveWebConfig({}, { port }) } }
          : {}),
      });
      await release;
      expect(listener === "MCP" ? started.port : started.web?.port).toBe(port);
      expect(
        messages.some((message) =>
          message.includes(`端口 ${port} 被占用（EADDRINUSE）`),
        ),
      ).toBe(true);
      const response = await fetch(
        listener === "MCP" ? started.url : `${started.web?.url}/api/session`,
      );
      expect(response.status).toBe(listener === "MCP" ? 401 : 200);
    } finally {
      await started?.close();
      if (occupied.listening)
        await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  },
);

test("a Web bind timeout closes the already bound MCP listener and preserves the injected store", async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  await expect(
    startCardiganServer({
      config: {
        dataDir,
        host: "127.0.0.1",
        port,
        listenRetryIntervalMs: 5,
        listenRetryTimeoutMs: 10,
      },
      store,
      warn: () => {},
      web: { config: resolveWebConfig({}, { port: server.port }) },
    }),
  ).rejects.toMatchObject({ code: "EADDRINUSE", port: server.port });
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  expect(() => store.listProjects()).not.toThrow();
});

test("SIGTERM triggers shutdown through the installed handler", () => {
  const handlers = new Map<string, () => void>();
  const host = {
    once: (signal: string, listener: () => void) => {
      handlers.set(signal, listener);
    },
    off: (signal: string) => {
      handlers.delete(signal);
    },
  };

  const seen: string[] = [];
  installShutdownHandlers(host as never, (signal) => seen.push(signal));
  expect([...handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);

  handlers.get("SIGTERM")?.();
  expect(seen).toEqual(["SIGTERM"]);
  // Handlers are removed, so a second signal does not run shutdown twice.
  expect(handlers.size).toBe(0);
});

/** Some environments have no IPv6 loopback; skip the ::1 test there. */
const supportsIpv6Loopback = await new Promise<boolean>((resolve) => {
  const probe = createServer();
  probe.once("error", () => resolve(false));
  probe.listen(0, "::1", () => probe.close(() => resolve(true)));
});

test.skipIf(!supportsIpv6Loopback)(
  "listens on the IPv6 loopback and still answers the Host check",
  async () => {
    const v6Store = Store.open({ dataDir });
    const v6 = await startCardiganServer({
      config: { dataDir, host: "::1", port: 0 },
      store: v6Store,
    });
    try {
      expect(v6.url).toContain("http://[::1]:");
      const client = await connect(seed(v6Store));
      const result = await client.callTool({ name: "whoami", arguments: {} });
      expect(textOf(result)).toMatchObject({ assignment_id: "A-1" });
    } finally {
      await v6.close();
      v6Store.close();
    }
  },
);

test("a non-loopback host is refused before anything starts", async () => {
  const env = { CARDIGAN_DATA_DIR: dataDir, CARDIGAN_MCP_HOST: "0.0.0.0" };
  await expect(startCardiganServer({ env })).rejects.toThrow(
    /M1 只支持本机监听/,
  );
});
