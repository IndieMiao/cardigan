import { expect, test } from "vitest";
import { startupPrompt } from "./launch-prompts.js";

// C-823: screens captured from Claude Code 2.1.330 in a PTY (and the known
// first-run screens), as hc renders them or with cursor moves for spaces.
test.each([
  [
    "trust_folder",
    [
      "Accessing workspace:",
      "/srv/cardigan-agent/worktrees/sensen-godot/A-355",
      "Quick safety check: Is this a project you created or one you trust? (Like your",
      "❯ No, exit",
      "Yes, I trust this folder",
    ],
  ],
  [
    "trust_folder",
    ["Quicksafetycheck:Isthisaprojectyoucreatedoroneyou", "trust?(Likeyour"],
  ],
  [
    "api_key",
    [
      "Detected a custom API key in your environment",
      "ANTHROPIC_API_KEY: sk-ant-...[REDACTED]",
      "Do you want to use this API key?",
      "❯ No (recommended)",
    ],
  ],
  ["theme", ["Choose the text style that looks best with your terminal"]],
  [
    "bypass_permissions",
    [
      "WARNING: Claude Code running in Bypass Permissions mode",
      "Yes, I accept",
    ],
  ],
  ["security_notes", ["Security notes:", "Claude can make mistakes"]],
  ["terminal_setup", ["Use Claude Code's terminal setup?"]],
  ["mcp_server_approval", ["New MCP server found in .mcp.json: tools"]],
  ["login", ["Select login method:"]],
] as const)("%s", (prompt, tail) => {
  expect(startupPrompt(tail)).toBe(prompt);
});

test("the dialog nearest the bottom wins; a started session names none", () => {
  expect(
    startupPrompt([
      "Choose the text style that looks best with your terminal",
      "Is this a project you created or one you trust?",
    ]),
  ).toBe("trust_folder");
  expect(
    startupPrompt([
      "❯ PROBE",
      "⏵⏵ bypass permissions on (shift+tab to cycle)",
      "Waiting for MCP servers…",
    ]),
  ).toBeUndefined();
  expect(startupPrompt([])).toBeUndefined();
});
