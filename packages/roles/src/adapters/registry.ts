import type { Harness } from "@cardigan/domain";
import { claudeCode } from "./claude-code.js";
import { codex } from "./codex.js";
import { pi } from "./pi.js";
import type { HarnessAdapter } from "./types.js";

const adapters = { "claude-code": claudeCode, codex, pi } satisfies Record<
  Harness,
  HarnessAdapter
>;
export function getHarnessAdapter(harness: Harness): HarnessAdapter {
  return adapters[harness];
}
