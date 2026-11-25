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

test("generate_image is token-scoped, takes no credential or host parameters and never relays raw errors", async () => {
  const store = Store.open({ dbPath: ":memory:" });
  const { assignment } = seedProject(store, {
    allowed_tools: ["generate_image", "whoami"],
  });
  const token = (allowed_tools: ("generate_image" | "whoami")[]) =>
    store.issueToken({
      project_id,
      assignment_id: assignment.id,
      role: { role_version: 1, allowed_tools },
    }).token;
  const execute = vi.fn(async (context, _input) => ({
    assignment: context.identity.actor.assignment_id,
    status: "succeeded",
  }));
  const server = await startMcpServer({
    store,
    deliveryVerifier: acceptingVerifierFor,
    port: 0,
    imageGenerator: { execute },
    acknowledgeRuns: false,
    log: () => {},
  });
  const clients: Client[] = [];
  const connect = async (secret: string) => {
    const c = new Client({ name: "image-test", version: "1" });
    clients.push(c);
    await c.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${secret}` } },
      }),
    );
    return c;
  };
  const input = { prompt: "木质面板", idempotency_key: "one" };
  try {
    const without = await connect(token(["whoami"]));
    expect((await without.listTools()).tools.map((t) => t.name)).not.toContain(
      "generate_image",
    );
    expect(
      (await without.callTool({ name: "generate_image", arguments: input }))
        .isError,
    ).toBe(true);
    const c = await connect(token(["whoami", "generate_image"]));
    expect((await c.listTools()).tools.map((t) => t.name)).toContain(
      "generate_image",
    );
    for (const patch of [
      { api_key: "secret" },
      { api_key_file: "/private/key" },
      { base_url: "https://elsewhere" },
      { assignment_id: "A-2" },
      { card_id: "C-2" },
      { size: "huge" },
      { quality: "ultra" },
      { background: "green" },
      { n: 0 },
      { model: "../x" },
      { prompt: "" },
    ])
      expect(
        (
          await c.callTool({
            name: "generate_image",
            arguments: { ...input, ...patch },
          })
        ).isError,
      ).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    const okCall = await c.callTool({
      name: "generate_image",
      arguments: {
        ...input,
        reference_attachments: ["AT-1"],
        model: "gpt-image-1",
        size: "1024x1536",
        quality: "high",
        n: 2,
        background: "transparent",
      },
    });
    expect(okCall.isError).not.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].identity.actor.assignment_id).toBe(
      assignment.id,
    );
    execute.mockRejectedValueOnce(
      new Error("Bearer sk-SECRET at /private/api-key"),
    );
    const failed = await c.callTool({
      name: "generate_image",
      arguments: input,
    });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain("SECRET");
    expect(JSON.stringify(failed)).not.toContain("api-key");
  } finally {
    for (const c of clients) await c.close();
    await server.close();
    store.close();
  }
});
