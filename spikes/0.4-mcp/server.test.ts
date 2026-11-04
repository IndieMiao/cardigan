import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "./server.js";

test("Bearer authentication, token identity, tools, logs, and stateless restart", async (t) => {
  const token = randomBytes(32).toString("hex");
  const logs: string[] = [];
  let server = await startServer({ token, log: (line) => logs.push(line) });
  t.after(() => server.close());
  for (const method of ["POST", "GET", "DELETE"]) {
    for (const authorization of [
      "",
      `Bearer ${randomBytes(32).toString("hex")}`,
    ]) {
      const response = await fetch(server.url, {
        method,
        headers: { authorization },
      });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("www-authenticate"), "Bearer");
    }
  }
  const client = new Client({ name: "spike-test", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  t.after(() => client.close());
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name).sort(),
    ["echo", "whoami"],
  );
  const expected = [{ type: "text", text: '{"asg":"A-1"}' }];
  assert.deepEqual(
    (await client.callTool({ name: "whoami", arguments: { asg: "forged" } }))
      .content,
    expected,
  );
  assert.deepEqual(
    (await client.callTool({ name: "echo", arguments: { message: "hello" } }))
      .content,
    [{ type: "text", text: "hello" }],
  );
  assert.equal(
    (await client.callTool({ name: "echo", arguments: { message: 42 } }))
      .isError,
    true,
  );
  const port = server.port;
  await server.close();
  // Let the client's keep-alive pool observe the closed socket before reconnecting.
  await setTimeout(100);
  server = await startServer({ token, port, log: (line) => logs.push(line) });
  assert.deepEqual(
    (await client.callTool({ name: "whoami", arguments: {} })).content,
    expected,
  );
  assert.ok(logs.some((line) => JSON.parse(line).identity === null));
  assert.ok(logs.some((line) => JSON.parse(line).identity?.asg === "A-1"));
  assert.ok(logs.every((line) => !line.includes(token)));
});
