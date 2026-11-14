import { expect, test } from "vitest";
import { mcpUrlFor, resolveMcpUrl } from "./mcp-url.js";

test("C-211 the MCP URL follows CARDIGAN_MCP_PORT when CARDIGAN_MCP_URL is not set", () => {
  expect(resolveMcpUrl({})).toBe("http://127.0.0.1:3004/mcp");
  expect(resolveMcpUrl({ CARDIGAN_MCP_PORT: "4610" })).toBe(
    "http://127.0.0.1:4610/mcp",
  );
  expect(
    resolveMcpUrl({ CARDIGAN_MCP_HOST: "::1", CARDIGAN_MCP_PORT: " 4610 " }),
  ).toBe("http://[::1]:4610/mcp");
  expect(resolveMcpUrl({ CARDIGAN_MCP_HOST: "LocalHost" })).toBe(
    "http://localhost:3004/mcp",
  );
  expect(mcpUrlFor("127.0.0.1", 1)).toBe("http://127.0.0.1:1/mcp");
});

test("C-211 an explicit CARDIGAN_MCP_URL wins; a blank one is ignored", () => {
  expect(
    resolveMcpUrl({
      CARDIGAN_MCP_URL: "http://127.0.0.1:5000/mcp",
      CARDIGAN_MCP_PORT: "4610",
    }),
  ).toBe("http://127.0.0.1:5000/mcp");
  expect(
    resolveMcpUrl({ CARDIGAN_MCP_URL: "  ", CARDIGAN_MCP_PORT: "4610" }),
  ).toBe("http://127.0.0.1:4610/mcp");
});

test("C-211 a non-loopback host or an unusable port is refused, never guessed", () => {
  for (const host of ["0.0.0.0", "::", "192.168.1.5", "example.com"])
    expect(() => resolveMcpUrl({ CARDIGAN_MCP_HOST: host })).toThrow(
      /CARDIGAN_MCP_HOST/,
    );
  for (const port of ["0", "-1", "65536", "abc", "3004.5"])
    expect(() => resolveMcpUrl({ CARDIGAN_MCP_PORT: port })).toThrow(
      /CARDIGAN_MCP_PORT/,
    );
});
