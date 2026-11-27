import {
  type Assignment,
  BUILTIN_CAPABILITY_NOTES,
  type CapabilityGuideEntry,
  HOST_OPS_ROLE_TOOLS,
  STANDING_ROLE_TOOLS,
  standingTools,
  type ToolName,
} from "@cardigan/domain";
import {
  listCapabilityGuides,
  readCapabilityGuides,
  Store,
  setCapabilityGuide,
} from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test, vi } from "vitest";
import { startMcpServer } from "./server.js";
import {
  acceptingVerifierFor,
  NOW,
  project_id,
  seedProject,
} from "./test-support.js";
import { CAPABILITY_GUIDE_NOTICE } from "./tools/capability-guide.js";

const entry = (
  scope: CapabilityGuideEntry["scope"],
  key: string,
  usage_note: string,
  machine_id: string | null = null,
): CapabilityGuideEntry => ({
  scope,
  key,
  machine_id,
  usage_note,
  updated_at: "2026-11-25T00:00:00.000Z",
  updated_by: "human",
});

/**
 * C-726: `get_capability_guide` is read-only, scoped by the role's
 * allowed_tools like every tool, and returns only the caller's project notes
 * merged for the machine of its own Assignment (`local` in the fixture).
 */
test("C-726 get_capability_guide reads the caller's project notes for its machine and stays behind allowed_tools", async () => {
  const store = Store.open({ dbPath: ":memory:" });
  const { assignment } = seedProject(store, {
    allowed_tools: ["whoami", "get_capability_guide"],
  });
  const token = (allowed_tools: ToolName[]) =>
    store.issueToken({
      project_id,
      assignment_id: assignment.id,
      role: { role_version: 1, allowed_tools },
    }).token;
  const without = token(["whoami"]);
  const holder = token(["whoami", "get_capability_guide"]);
  const mine = [
    entry("capability", "android.emulator", "主说明：先读 README。"),
    entry("machine", "android.emulator", "本机 SDK 在 ~/Sdk。", "local"),
    entry("machine", "android.emulator", "别的机器补充", "mac-mini"),
    entry("machine", "godot", "只在别的机器", "mac-mini"),
    entry("project", "test-accounts", "受管文件 /srv/p/accounts.md"),
  ];
  const guides = vi.fn((project: string) =>
    project === project_id
      ? mine
      : [entry("capability", "android.emulator", "其它项目的说明")],
  );
  const server = await startMcpServer({
    store,
    deliveryVerifier: acceptingVerifierFor,
    port: 0,
    capabilityGuides: guides,
    acknowledgeRuns: false,
    log: () => {},
  });
  const clients: Client[] = [];
  const connect = async (secret: string) => {
    const c = new Client({ name: "capability-guide-test", version: "1" });
    clients.push(c);
    await c.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${secret}` } },
      }),
    );
    return c;
  };
  const call = async (c: Client, args: Record<string, unknown>) => {
    const result = await c.callTool({
      name: "get_capability_guide",
      arguments: args,
    });
    const content = result.content as { type: string; text: string }[];
    return {
      isError: result.isError === true,
      body: JSON.parse(content[0]?.text ?? "null") as Record<string, unknown>,
    };
  };
  try {
    // Without the tool in allowed_tools it is neither listed nor callable,
    // and the host store is never read.
    const a = await connect(without);
    expect((await a.listTools()).tools.map((t) => t.name)).not.toContain(
      "get_capability_guide",
    );
    expect(
      (await a.callTool({ name: "get_capability_guide", arguments: {} }))
        .isError,
    ).toBe(true);
    expect(guides).not.toHaveBeenCalled();

    const b = await connect(holder);
    expect((await b.listTools()).tools.map((t) => t.name)).toContain(
      "get_capability_guide",
    );
    expect(await call(b, {})).toEqual({
      isError: false,
      body: {
        machine_id: "local",
        capabilities: [
          {
            key: "android.emulator",
            has_usage_note: true,
            has_machine_note: true,
          },
        ],
        project_topics: ["test-accounts"],
        notice: CAPABILITY_GUIDE_NOTICE,
      },
    });
    expect(await call(b, { capability: "android.emulator" })).toEqual({
      isError: false,
      body: {
        machine_id: "local",
        key: "android.emulator",
        usage_note: "主说明：先读 README。",
        machine_note: "本机 SDK 在 ~/Sdk。",
        notice: CAPABILITY_GUIDE_NOTICE,
      },
    });
    // Another machine's supplement never shows; an unknown key is null.
    expect((await call(b, { capability: "godot" })).body).toMatchObject({
      usage_note: null,
      machine_note: null,
    });
    // C-815: without a project note, android.any reads the built-in one.
    expect((await call(b, { capability: "android.any" })).body).toMatchObject({
      key: "android.any",
      usage_note: BUILTIN_CAPABILITY_NOTES["android.any"],
      machine_note: null,
    });
    expect(await call(b, { topic: "test-accounts" })).toEqual({
      isError: false,
      body: {
        topic: "test-accounts",
        usage_note: "受管文件 /srv/p/accounts.md",
        notice: CAPABILITY_GUIDE_NOTICE,
      },
    });
    expect(guides.mock.calls.every(([p]) => p === project_id)).toBe(true);
    // Arguments name a key only: no project, machine or write fields.
    for (const args of [
      { capability: "godot", topic: "x" },
      { capability: "Godot" },
      { capability: "../x" },
      { project_id: "other" },
      { machine_id: "mac-mini" },
      { capability: "godot", usage_note: "write" },
    ])
      expect((await call(b, args)).isError).toBe(true);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await server.close();
    store.close();
  }
});

test("C-726 get_capability_guide fails closed when the host has no notes source", async () => {
  const store = Store.open({ dbPath: ":memory:" });
  const { assignment } = seedProject(store, {
    allowed_tools: ["get_capability_guide"],
  });
  const secret = store.issueToken({
    project_id,
    assignment_id: assignment.id,
    role: { role_version: 1, allowed_tools: ["get_capability_guide"] },
  }).token;
  const server = await startMcpServer({
    store,
    deliveryVerifier: acceptingVerifierFor,
    port: 0,
    acknowledgeRuns: false,
    log: () => {},
  });
  const c = new Client({ name: "capability-guide-test", version: "1" });
  try {
    await c.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${secret}` } },
      }),
    );
    expect(
      (await c.callTool({ name: "get_capability_guide", arguments: {} }))
        .isError,
    ).toBe(true);
  } finally {
    await c.close();
    await server.close();
    store.close();
  }
});

/**
 * C-731: the standing PM (Office and Ops) carries `get_capability_guide` in
 * its default tools, reads the same note `cardigan capability guide get`
 * prints, and still cannot write notes; host_ops does not gain the tool.
 */
test("C-731 standing PM Office and Ops read the current capability note and cannot write it", async () => {
  const store = Store.open({ dbPath: ":memory:" });
  store.createProject({ id: project_id });
  seedProject(store, { allowed_tools: STANDING_ROLE_TOOLS });
  setCapabilityGuide(
    store,
    { kind: "human", project_id },
    project_id,
    { scope: "capability", key: "android.emulator" },
    "主说明：先读 README。",
    "2026-11-25T00:00:00.000Z",
  );
  setCapabilityGuide(
    store,
    { kind: "human", project_id },
    project_id,
    { scope: "machine", key: "android.emulator", machine_id: "local" },
    "本机 SDK 在 ~/Sdk。",
    "2026-11-25T00:00:00.000Z",
  );
  const server = await startMcpServer({
    store,
    deliveryVerifier: acceptingVerifierFor,
    port: 0,
    capabilityGuides: (project) => listCapabilityGuides(store, project),
    acknowledgeRuns: false,
    log: () => {},
  });
  const clients: Client[] = [];
  const connect = async (mode: "office" | "ops", id: string) => {
    const assignment: Assignment = {
      id: id as never,
      scope: "standing",
      standing_mode: mode,
      role_id: "pm",
      role_version: 1,
      status: "active",
      runtime_state: "idle",
      runtime_ref: null,
      machine_id: "local" as never,
      mcp_token_id: `fixture-${mode}`,
      created_at: NOW,
    };
    store.uow.run((tx) => tx.assignments.put(project_id, assignment));
    const { token } = store.issueToken({
      project_id,
      assignment_id: assignment.id,
      role: {
        role_version: 1,
        allowed_tools: standingTools(STANDING_ROLE_TOOLS, mode),
      },
    });
    const c = new Client({ name: "capability-guide-pm-test", version: "1" });
    clients.push(c);
    await c.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return { c, assignment };
  };
  try {
    expect(HOST_OPS_ROLE_TOOLS).not.toContain("get_capability_guide");
    const cli = readCapabilityGuides(store, project_id, {
      machine_id: "local",
      capabilities: ["android.emulator"],
    }).capabilities[0];
    for (const [mode, id] of [
      ["office", "A-2"],
      ["ops", "A-3"],
    ] as const) {
      const { c, assignment } = await connect(mode, id);
      const listed = (await c.listTools()).tools.map((t) => t.name);
      // The read tool is listed; no MCP tool writes capability notes.
      expect(listed.filter((name) => name.includes("capability"))).toEqual([
        "get_capability_guide",
      ]);
      const whoami = await c.callTool({ name: "whoami", arguments: {} });
      expect(JSON.stringify(whoami.content)).toContain("get_capability_guide");
      const result = await c.callTool({
        name: "get_capability_guide",
        arguments: { capability: "android.emulator" },
      });
      expect(result.isError).not.toBe(true);
      const content = result.content as { type: string; text: string }[];
      expect(JSON.parse(content[0]?.text ?? "null")).toEqual({
        machine_id: "local",
        key: "android.emulator",
        usage_note: cli?.usage_note,
        machine_note: cli?.machine_note,
        notice: CAPABILITY_GUIDE_NOTICE,
      });
      // The write path stays human/host only for the PM's own identity.
      expect(() =>
        setCapabilityGuide(
          store,
          {
            kind: "assignment",
            project_id,
            assignment_id: assignment.id,
            role_id: "pm",
          } as never,
          project_id,
          { scope: "capability", key: "android.emulator" },
          "PM 改写",
          "2026-11-25T01:00:00.000Z",
        ),
      ).toThrow(/Agent Token 不可写/);
    }
    expect(
      readCapabilityGuides(store, project_id, {
        capabilities: ["android.emulator"],
      }).capabilities[0]?.usage_note,
    ).toBe("主说明：先读 README。");
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await server.close();
    store.close();
  }
});
