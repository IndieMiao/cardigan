import { expect, test } from "vitest";
import { hostMcpUrl } from "./host.js";
import { listenerMcpUrl } from "./mcp-url.js";

test("C-211 Agents get the listener's port, not 3004, on a non-default CARDIGAN_MCP_PORT", () => {
  let listening: string | undefined;
  const url = listenerMcpUrl(
    { CARDIGAN_MCP_PORT: "4610" },
    { host: "127.0.0.1", port: 4610 },
    () => listening,
  );
  // Before startup returns, the configured host and port it binds to.
  expect(url()).toBe("http://127.0.0.1:4610/mcp");
  // Afterwards the address the listener reports (e.g. port 0 in tests).
  listening = "http://127.0.0.1:41234/mcp";
  expect(url()).toBe("http://127.0.0.1:41234/mcp");
  expect(
    listenerMcpUrl({}, { host: "::1", port: 4610 }, () => undefined)(),
  ).toBe("http://[::1]:4610/mcp");
});

test("C-211 an explicit CARDIGAN_MCP_URL still wins over the listener", () => {
  const url = listenerMcpUrl(
    {
      CARDIGAN_MCP_URL: "http://127.0.0.1:5000/mcp",
      CARDIGAN_MCP_PORT: "4610",
    },
    { host: "127.0.0.1", port: 4610 },
    () => "http://127.0.0.1:4610/mcp",
  );
  expect(url()).toBe("http://127.0.0.1:5000/mcp");
});

test("C-211 the host wiring reads the URL at each launch and falls back to CARDIGAN_MCP_PORT", () => {
  expect(hostMcpUrl(undefined, { CARDIGAN_MCP_PORT: "4610" })()).toBe(
    "http://127.0.0.1:4610/mcp",
  );
  expect(hostMcpUrl(undefined, {})()).toBe("http://127.0.0.1:3004/mcp");
  expect(
    hostMcpUrl("http://127.0.0.1:7/mcp", { CARDIGAN_MCP_PORT: "4610" })(),
  ).toBe("http://127.0.0.1:7/mcp");
  let port = 4610;
  const lazy = hostMcpUrl(() => `http://127.0.0.1:${port}/mcp`, {});
  expect(lazy()).toBe("http://127.0.0.1:4610/mcp");
  port = 4611;
  expect(lazy()).toBe("http://127.0.0.1:4611/mcp");
});
