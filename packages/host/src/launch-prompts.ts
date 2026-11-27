import type { StartupPrompt } from "@cardigan/domain";

/**
 * C-823: phrases of the first-run confirmations Claude Code (2.1.3xx) and
 * Codex show before a session starts. Matched on the redacted terminal tail
 * with whitespace removed and case folded, because a terminal may render a
 * dialog with cursor moves instead of spaces.
 */
const PHRASES: readonly (readonly [StartupPrompt, readonly string[]])[] = [
  [
    "trust_folder",
    [
      "is this a project you created or one you trust",
      "yes, i trust this folder",
      "do you trust the files in this folder",
      "do you trust the contents of this directory",
    ],
  ],
  [
    "api_key",
    [
      "detected a custom api key in your environment",
      "do you want to use this api key",
    ],
  ],
  ["theme", ["choose the text style that looks best with your terminal"]],
  ["bypass_permissions", ["running in bypass permissions mode"]],
  ["security_notes", ["security notes:"]],
  ["terminal_setup", ["use claude code's terminal setup"]],
  [
    "mcp_server_approval",
    ["new mcp server found in", "new mcp servers found in"],
  ],
  ["login", ["select login method"]],
];

const fold = (text: string) => text.replace(/\s+/gu, "").toLowerCase();
const FOLDED = PHRASES.map(
  ([prompt, phrases]) => [prompt, phrases.map(fold)] as const,
);

/**
 * The confirmation nearest the bottom of the tail, if any. Lines are joined
 * first so a phrase wrapped across terminal rows still matches.
 */
export function startupPrompt(
  tail: readonly string[],
): StartupPrompt | undefined {
  const screen = fold(tail.join(""));
  let found: StartupPrompt | undefined;
  let at = -1;
  for (const [prompt, phrases] of FOLDED)
    for (const phrase of phrases) {
      const index = screen.lastIndexOf(phrase);
      if (index > at) [found, at] = [prompt, index];
    }
  return found;
}
