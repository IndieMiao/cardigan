import type { CapabilityGuideEntry, ToolName } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test, vi } from "vitest";
import { startMcpServer } from "./server.js";
import {
  acceptingVerifierFor,
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
