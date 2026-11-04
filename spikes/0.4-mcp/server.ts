import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// Research only: one assignment, stateless JSON responses, no business writes.
export async function startServer({
  token,
  port = 0,
  log = console.log,
}: {
  token: string;
  port?: number;
  log?: (line: string) => void;
}) {
  if (!token) throw new Error("MCP_TOKEN must be set");
  const identity = { asg: "A-1" };
  const expected = Buffer.from(`Bearer ${token}`);
  const http = createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    const authorized =
      supplied.length === expected.length &&
      timingSafeEqual(supplied, expected);
    log(
      JSON.stringify({
        method: req.method,
        identity: authorized ? identity : null,
      }),
    );
    if (!authorized) {
      res.writeHead(401, {
        "WWW-Authenticate": "Bearer",
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const mcp = new McpServer({ name: "cardigan-p0", version: "0.0.1" });
    mcp.registerTool(
      "whoami",
      {
        description: "Return the identity bound to the bearer token",
        inputSchema: {},
      },
      async () => {
        log(JSON.stringify({ tool: "whoami", identity }));
        return { content: [{ type: "text", text: JSON.stringify(identity) }] };
      },
    );
    mcp.registerTool(
      "echo",
      { description: "Echo a message", inputSchema: { message: z.string() } },
      async ({ message }) => {
        log(JSON.stringify({ tool: "echo", identity }));
        return { content: [{ type: "text", text: message }] };
      },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: ["127.0.0.1", `127.0.0.1:${req.socket.localPort}`],
    });
    res.on("close", () => {
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", resolve);
  });
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("No listening address");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
        http.closeAllConnections();
      }),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const server = await startServer({
    token: process.env.MCP_TOKEN ?? "",
    port: Number(process.env.MCP_PORT ?? 3004),
  });
  console.log(JSON.stringify({ ready: server.url }));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void server.close();
    });
  }
}
