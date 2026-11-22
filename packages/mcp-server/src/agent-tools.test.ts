import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AGENT_TOOLS, generateAgentTools } from "../scripts/agent-tools.mjs";
import {
  agentToolsDirectory,
  runAgentTool,
} from "../test-support/agent-tools.js";

test("committed agent tools are the current build of the package sources", async () => {
  const built = await generateAgentTools();
  expect(Object.keys(built).sort()).toEqual(
    AGENT_TOOLS.map((name) => `${name}.mjs`).sort(),
  );
  for (const [file, code] of Object.entries(built)) {
    const path = join(agentToolsDirectory, file);
    // Rebuild with `pnpm --filter @cardigan/mcp-server build:agent-tools`.
    expect(await readFile(path, "utf8"), file).toBe(code);
    // The release records 100755; a restricted checkout only needs this account to run it.
    expect(
      execFileSync("git", ["ls-files", "-s", "--", path], {
        cwd: agentToolsDirectory,
      })
        .toString()
        .split(" ")[0],
      file,
    ).toBe("100755");
    await access(path, constants.R_OK | constants.X_OK);
  }
});

test("agent tools only import Node built-in modules", async () => {
  for (const name of AGENT_TOOLS) {
    const code = await readFile(
      join(agentToolsDirectory, `${name}.mjs`),
      "utf8",
    );
    expect(code.startsWith("#!/usr/bin/env node\n")).toBe(true);
    const specifiers = [
      ...code.matchAll(/\bfrom\s*["']([^"']+)["']/gu),
      ...code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu),
      ...code.matchAll(/^import\s*["']([^"']+)["']/gmu),
    ].map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !s?.startsWith("node:"))).toEqual([]);
    expect(code).not.toContain("createRequire");
  }
});

test.each([
  ["download-attachment", ["http://127.0.0.1:9/mcp", "F-1"]],
  ["upload-evidence", ["http://127.0.0.1:9/mcp", "C-1", "D-1"]],
] as const)(
  "%s prints its usage when arguments are missing",
  async (tool, partial) => {
    for (const args of [[], partial]) {
      const result = await runAgentTool(tool, args, "synthetic-token");
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("[arguments]");
      expect(result.stderr).toContain(
        `Usage: ${tool} <configured Card MCP URL>`,
      );
      expect(result.stderr).not.toContain("synthetic-token");
    }
  },
);
