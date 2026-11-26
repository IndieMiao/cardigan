import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolName } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { z } from "zod";
import { memoryLogger } from "./log.js";
import {
  defaultToolCatalog,
  type RunningServer,
  startMcpServer,
} from "./server.js";
import {
  acceptingVerifierFor,
  project_id,
  seedProject,
} from "./test-support.js";
import {
  catalogHash,
  catalogSnapshot,
  compareToolCatalogs,
  structuralSchema,
  TOOL_CATALOG_REVISION,
  toolCatalogFingerprint,
  toolCatalogSnapshot,
} from "./tool-server.js";
import { readOnlyTools } from "./tools/index.js";
import type { ToolDefinition } from "./tools/types.js";

// P2a-10 A (finding 40): the Dispatcher compares a session's recorded tool
// catalog with this fingerprint, so it must hash exactly what tools/list
// serves to the same token, and change only when that list changes.

const allowed: readonly ToolName[] = ["whoami", "get_updates", "ack_events"];
let store: Store, dataDir: string, token: string;
let assignment: ReturnType<typeof seedProject>["assignment"];
const servers: RunningServer[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-catalog-"));
  store = Store.open({ dataDir });
  assignment = seedProject(store, { allowed_tools: allowed }).assignment;
  token = store.issueToken({
    project_id,
    assignment_id: assignment.id,
    role: { role_version: assignment.role_version, allowed_tools: allowed },
    token: "fictional-token-value",
  }).token;
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function deploy(tools?: Parameters<typeof startMcpServer>[0]["tools"]) {
  const server = await startMcpServer({
    store,
    deliveryVerifier: acceptingVerifierFor,
    log: memoryLogger().log,
    ...(tools ? { tools } : {}),
  });
  servers.push(server);
  return server;
}

/** A new session: connect with the token and list tools once. */
async function listed(server: RunningServer) {
  const client = new Client({ name: "fictional-client", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

const hash = (tools: Awaited<ReturnType<typeof listed>>) => catalogHash(tools);

test("P2a-10 A: the fingerprint is the hash of the tools/list a session receives", async () => {
  const server = await deploy();
  const tools = await listed(server);
  expect(tools.map((t) => t.name).sort()).toEqual([...allowed].sort());
  expect(server.toolCatalog(allowed, assignment)).toBe(hash(tools));
  // Allowed-tool order does not matter.
  expect(server.toolCatalog([...allowed].reverse(), assignment)).toBe(
    hash(tools),
  );
});

test("P2a-10 A: a redeploy with the same tools keeps the fingerprint", async () => {
  const before = await deploy();
  const after = await deploy();
  expect(after.toolCatalog(allowed, assignment)).toBe(
    before.toolCatalog(allowed, assignment),
  );
});

test("C-786: a changed description keeps the fingerprint, though a new session lists it", async () => {
  const before = await deploy(readOnlyTools);
  const changed = readOnlyTools.map((tool) =>
    tool.name === "get_updates"
      ? { ...tool, description: `${tool.description} (new deploy)` }
      : tool,
  );
  const after = await deploy(changed);
  expect(after.toolCatalog(allowed, assignment)).toBe(
    before.toolCatalog(allowed, assignment),
  );
  // The same token, in a new session against the new deploy, sees the change.
  const tools = await listed(after);
  expect(tools.find((t) => t.name === "get_updates")?.description).toContain(
    "(new deploy)",
  );
  expect(after.toolCatalog(allowed, assignment)).toBe(hash(tools));
});

test("C-786: a changed parameter structure changes the fingerprint", async () => {
  const before = await deploy(readOnlyTools);
  const changed = readOnlyTools.map((tool) =>
    tool.name === "get_updates"
      ? { ...tool, input: tool.input.extend({ extra: z.string().optional() }) }
      : tool,
  );
  const after = await deploy(changed);
  expect(after.toolCatalog(allowed, assignment)).not.toBe(
    before.toolCatalog(allowed, assignment),
  );
  expect(after.toolCatalog(allowed, assignment)).toBe(
    hash(await listed(after)),
  );
  // Tools outside the token's scope do not affect the fingerprint.
  const unrelated = readOnlyTools.map((tool) =>
    tool.name === "get_card"
      ? { ...tool, input: tool.input.extend({ extra: z.string() }) }
      : tool,
  );
  const other = await deploy(unrelated);
  expect(other.toolCatalog(allowed, assignment)).toBe(
    before.toolCatalog(allowed, assignment),
  );
});

// C-786: typical deploys, judged against a session that listed `base()`.
// C-797: wording alone keeps the fingerprint; new optional parameters change
// it but stay compatible; every other structural change is incompatible.
const fixtureTool = (
  name: ToolName,
  shape: z.ZodRawShape,
  description = `fictional ${name}`,
): ToolDefinition => ({
  name,
  description,
  input: z.object(shape),
  handler: () => ({}),
});
const issue = { severity: z.enum(["major", "minor"]), proof: z.string() };
const discussion = {
  ask: { action: z.literal("ask"), question: z.string() },
  propose: { action: z.literal("propose"), title: z.string() },
};
const base = () => [
  fixtureTool("whoami", {}),
  fixtureTool("get_updates", {
    card_id: z.string().min(1).describe("card to read"),
    since_seq: z.number().int().min(0).optional(),
    filter: z
      .object({ kind: z.enum(["a", "b"]), limit: z.number().optional() })
      .optional(),
    issues: z.array(z.object(issue)).optional(),
    discussion: z
      .union([z.object(discussion.ask), z.object(discussion.propose)])
      .optional(),
  }),
];
const updates = (shape: (old: z.ZodRawShape) => z.ZodRawShape) =>
  base().map((t) =>
    t.name === "get_updates" ? fixtureTool(t.name, shape(t.input.shape)) : t,
  );
const all: readonly ToolName[] = ["whoami", "get_updates", "ack_events"];
const print = (tools: readonly ToolDefinition[]) =>
  toolCatalogFingerprint(tools, all, assignment);
const snapshot = (tools: readonly ToolDefinition[]) =>
  toolCatalogSnapshot(tools, all, assignment).structure;
const compatible = (
  tools: readonly ToolDefinition[],
  immediate: Readonly<Record<string, readonly string[]>> = {},
) =>
  print(tools) === print(base()) ||
  compareToolCatalogs(snapshot(base()), snapshot(tools), immediate).compatible;

test.each([
  [
    "a tool is added",
    () => [...base(), fixtureTool("ack_events", { up_to_seq: z.number() })],
  ],
  ["a tool is removed", () => base().filter((t) => t.name !== "whoami")],
  [
    "a required parameter is added",
    () => updates((old) => ({ ...old, limit: z.number() })),
  ],
  [
    "a required parameter is removed",
    () => updates(({ card_id: _gone, ...old }) => old),
  ],
  [
    "an optional parameter is removed",
    () => updates(({ since_seq: _gone, ...old }) => old),
  ],
  [
    "a parameter type changes",
    () => updates((old) => ({ ...old, since_seq: z.string().optional() })),
  ],
  [
    "an optional parameter becomes required",
    () => updates((old) => ({ ...old, since_seq: z.number().int().min(0) })),
  ],
  [
    "a required parameter becomes optional",
    () => updates((old) => ({ ...old, card_id: z.string().min(1).optional() })),
  ],
  [
    "a bound changes",
    () => updates((old) => ({ ...old, card_id: z.string().min(2) })),
  ],
  [
    "an enum gains a value",
    () =>
      updates((old) => ({
        ...old,
        filter: z
          .object({
            kind: z.enum(["a", "b", "c"]),
            limit: z.number().optional(),
          })
          .optional(),
      })),
  ],
  [
    "a nested optional field changes type",
    () =>
      updates((old) => ({
        ...old,
        filter: z
          .object({ kind: z.enum(["a", "b"]), limit: z.string().optional() })
          .optional(),
      })),
  ],
  [
    "an optional object gains a required field",
    () =>
      updates((old) => ({
        ...old,
        filter: z
          .object({
            kind: z.enum(["a", "b"]),
            limit: z.number().optional(),
            page: z.number(),
          })
          .optional(),
      })),
  ],
  [
    "an object parameter becomes strict",
    () =>
      updates((old) => ({
        ...old,
        filter: z
          .object({ kind: z.enum(["a", "b"]), limit: z.number().optional() })
          .strict()
          .optional(),
      })),
  ],
  [
    "a parameter is renamed",
    () =>
      updates(({ since_seq, ...old }) => ({ ...old, after_seq: since_seq })),
  ],
  [
    "an optional parameter is renamed while another is added",
    () =>
      updates(({ since_seq, ...old }) => ({
        ...old,
        after_seq: since_seq,
        limit: z.number().optional(),
      })),
  ],
  [
    "a parameter gains a default",
    () =>
      updates((old) => ({
        ...old,
        since_seq: z.number().int().min(0).optional().default(0),
      })),
  ],
  [
    "a field inside array items becomes required",
    () =>
      updates((old) => ({
        ...old,
        issues: z.array(z.object({ ...issue, basis: z.string() })).optional(),
      })),
  ],
  [
    "array items change type",
    () =>
      updates((old) => ({ ...old, issues: z.array(z.string()).optional() })),
  ],
  [
    "a branch of a union gains an optional field",
    () =>
      updates((old) => ({
        ...old,
        discussion: z
          .union([
            z.object({ ...discussion.ask, note: z.string().optional() }),
            z.object(discussion.propose),
          ])
          .optional(),
      })),
  ],
  [
    "an optional parameter is added while a tool is added",
    () => [
      ...updates((old) => ({ ...old, limit: z.number().optional() })),
      fixtureTool("ack_events", { up_to_seq: z.number() }),
    ],
  ],
])("C-786: incompatible — %s", (_label, changed) => {
  expect(compatible(changed())).toBe(false);
});

test.each([
  [
    "a tool description changes",
    () =>
      base().map((t) =>
        t.name === "whoami" ? fixtureTool(t.name, {}, "reworded") : t,
      ),
  ],
  [
    "a parameter description changes or is added",
    () =>
      updates((old) => ({
        ...old,
        card_id: z.string().min(1).describe("reworded"),
        since_seq: z.number().int().min(0).optional().describe("new"),
      })),
  ],
  ["only the order changes", () => [...base()].reverse()],
  [
    "an optional parameter is added (C-797)",
    () => updates((old) => ({ ...old, limit: z.number().optional() })),
  ],
  [
    "an optional parameter with a default is added (C-797)",
    () => updates((old) => ({ ...old, limit: z.number().default(10) })),
  ],
  [
    "an optional object parameter is added (C-797)",
    () =>
      updates((old) => ({
        ...old,
        page: z.object({ size: z.number(), cursor: z.string() }).optional(),
      })),
  ],
  [
    "an optional field is added inside an optional object (C-797)",
    () =>
      updates((old) => ({
        ...old,
        filter: z
          .object({
            kind: z.enum(["a", "b"]),
            limit: z.number().optional(),
            page: z.number().optional(),
          })
          .optional(),
      })),
  ],
  [
    "an optional field is added to array items (C-797)",
    () =>
      updates((old) => ({
        ...old,
        issues: z
          .array(z.object({ ...issue, basis: z.string().min(1).optional() }))
          .optional(),
      })),
  ],
  [
    "optional parameters are added to two tools (C-797)",
    () =>
      base().map((t) =>
        fixtureTool(t.name, {
          ...t.input.shape,
          trace: z.boolean().optional(),
        }),
      ),
  ],
])("C-786: compatible — %s", (_label, changed) => {
  expect(compatible(changed())).toBe(true);
});

test("C-797: a new optional parameter changes the fingerprint but stays compatible", () => {
  const added = updates((old) => ({ ...old, limit: z.number().optional() }));
  expect(print(added)).not.toBe(print(base()));
  expect(
    compareToolCatalogs(snapshot(base()), snapshot(added)).compatible,
  ).toBe(true);
  // Not the reverse: a session that listed `limit` loses it.
  expect(compareToolCatalogs(snapshot(added), snapshot(base()))).toMatchObject({
    compatible: false,
    reason: "get_updates:removed limit",
  });
});

test.each([
  ["the parameter itself", ["guard"], "guard"],
  ["a field inside the new parameter", ["guard.strict"], "guard"],
  ["its parent, when the field is new", ["filter"], "filter.page"],
  ["a field of array items", ["issues[].basis"], "issues[].basis"],
  ["the array, when an item field is new", ["issues"], "issues[].basis"],
])(
  "C-797: a new optional parameter marked immediate is incompatible (%s)",
  (_label, marked, added) => {
    const changed = updates((old) => ({
      ...old,
      guard: z.object({ strict: z.boolean().optional() }).optional(),
      filter: z
        .object({
          kind: z.enum(["a", "b"]),
          limit: z.number().optional(),
          page: z.number().optional(),
        })
        .optional(),
      issues: z
        .array(z.object({ ...issue, basis: z.string().optional() }))
        .optional(),
    }));
    expect(compatible(changed)).toBe(true);
    const immediate = { get_updates: marked };
    expect(compatible(changed, immediate)).toBe(false);
    expect(
      compareToolCatalogs(snapshot(base()), snapshot(changed), immediate),
    ).toEqual({
      compatible: false,
      reason: `get_updates:immediate ${added}`,
    });
    // A mark on another tool or another parameter does not apply.
    expect(compatible(changed, { whoami: marked })).toBe(true);
    expect(compatible(changed, { get_updates: ["since_seq"] })).toBe(true);
  },
);

test("C-797: an unreadable structure or another catalog revision is incompatible", () => {
  const listed = [{ name: "whoami", inputSchema: { type: "object" } }];
  const current = catalogSnapshot(listed).structure;
  for (const previous of [
    "",
    "not json",
    "[]",
    '{"revision":1}',
    '{"revision":1,"tools":[{"inputSchema":{}}]}',
    '{"revision":1,"tools":[{"name":"whoami","inputSchema":{"type":"object"}},{"name":"whoami","inputSchema":{"type":"object"}}]}',
  ])
    expect(compareToolCatalogs(previous, current)).toMatchObject({
      compatible: false,
    });
  expect(
    compareToolCatalogs(
      catalogSnapshot(listed, TOOL_CATALOG_REVISION + 1).structure,
      current,
    ),
  ).toEqual({ compatible: false, reason: "revision" });
  expect(compareToolCatalogs(current, current)).toEqual({ compatible: true });
});

test("C-797: a malformed required list is incompatible, a reordered one is not", () => {
  const schema = (required: unknown, extra = {}) =>
    catalogSnapshot([
      {
        name: "get_updates",
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "string" },
            b: { type: "string" },
            ...extra,
          },
          required,
        },
      },
    ]).structure;
  const extra = { c: { type: "number" } };
  expect(
    compareToolCatalogs(schema(["a", "b"]), schema(["b", "a"], extra)),
  ).toEqual({ compatible: true });
  expect(
    compareToolCatalogs(schema(["a", "b"]), schema("a,b", extra)).compatible,
  ).toBe(false);
  expect(
    compareToolCatalogs(schema(["a"]), schema(["a", "c"], extra)).compatible,
  ).toBe(false);
});

test("C-797: an old session that kept running gains nothing: calls follow this deploy's tools and the token", async () => {
  const before = await deploy(readOnlyTools);
  const added = readOnlyTools.map((tool) =>
    tool.name === "get_updates"
      ? {
          ...tool,
          input: tool.input.extend({ mode: z.enum(["brief"]).optional() }),
        }
      : tool,
  );
  const after = await deploy(added);
  expect(
    compareToolCatalogs(
      before.toolCatalogSnapshot(allowed, assignment).structure,
      after.toolCatalogSnapshot(allowed, assignment).structure,
    ).compatible,
  ).toBe(true);
  const client = new Client({ name: "fictional-client", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(after.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  try {
    // The new parameter is validated by the current schema.
    const invalid = await client
      .callTool({ name: "get_updates", arguments: { mode: "full" } })
      .catch((error: unknown) => ({ isError: true, error }));
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid)).toContain("mode");
    // A valid value is accepted under the same token.
    const valid = await client.callTool({
      name: "get_updates",
      arguments: { mode: "brief" },
    });
    expect(valid.isError).toBeFalsy();
    // A tool outside the token's allowed_tools stays unavailable.
    const outside = await client
      .callTool({ name: "get_card", arguments: { card_id: "C-1" } })
      .catch((error: unknown) => ({ isError: true, error }));
    expect(outside.isError).toBe(true);
    expect(JSON.stringify(outside)).toContain("get_card");
  } finally {
    await client.close();
  }
});

test("C-786: allowed_tools decide the catalog: a tool leaving the scope is incompatible", () => {
  const narrower: readonly ToolName[] = ["whoami", "get_updates"];
  const wider = [
    ...base(),
    fixtureTool("ack_events", { up_to_seq: z.number() }),
  ];
  expect(toolCatalogFingerprint(wider, all, assignment)).not.toBe(
    toolCatalogFingerprint(wider, narrower, assignment),
  );
});

test("C-786: a parameter named description is a name, not an annotation", () => {
  const schema = {
    type: "object",
    description: "dropped",
    properties: {
      description: { type: "string", description: "dropped too" },
      known_gaps: {
        type: "array",
        items: {
          type: "object",
          properties: { description: { type: "string" } },
          required: ["description"],
        },
      },
    },
    required: ["description"],
  };
  expect(structuralSchema(schema)).toEqual({
    type: "object",
    properties: {
      description: { type: "string" },
      known_gaps: {
        type: "array",
        items: {
          type: "object",
          properties: { description: { type: "string" } },
          required: ["description"],
        },
      },
    },
    required: ["description"],
  });
  const renamed = {
    ...schema,
    properties: { summary: schema.properties.description },
  };
  expect(structuralSchema(renamed)).not.toEqual(structuralSchema(schema));
  // Enum values and defaults are data: an enum member called "title" stays.
  expect(
    structuralSchema({ type: "string", enum: ["title"], default: "title" }),
  ).toEqual({ type: "string", enum: ["title"], default: "title" });
});

test("C-786: bumping the catalog revision changes the fingerprint", () => {
  const listed = [{ name: "whoami", inputSchema: { type: "object" } }];
  expect(catalogHash(listed)).toBe(catalogHash(listed, TOOL_CATALOG_REVISION));
  expect(catalogHash(listed, TOOL_CATALOG_REVISION + 1)).not.toBe(
    catalogHash(listed),
  );
});
test("P2a-10 A: host launches compute the same fingerprint as the default endpoint", async () => {
  const server = await deploy();
  expect(defaultToolCatalog(allowed, assignment)).toBe(
    server.toolCatalog(allowed, assignment),
  );
  expect(defaultToolCatalog(allowed, assignment)).toBe(
    hash(await listed(server)),
  );
});
