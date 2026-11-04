import { ackEventsTool } from "./ack-events.js";
import { getUpdatesTool } from "./get-updates.js";
import type { ToolDefinition } from "./types.js";
import { whoamiTool } from "./whoami.js";

/**
 * Read-only tools of M1.5. `get_card` joins this list once the domain exposes
 * the derived view (M1.2); write tools arrive with M1.6.
 */
export const readOnlyTools: readonly ToolDefinition[] = [
  whoamiTool,
  getUpdatesTool,
  ackEventsTool,
];

export {
  allowedTools,
  defineTool,
  type ToolContext,
  type ToolDefinition,
} from "./types.js";
export { ackEventsTool, getUpdatesTool, whoamiTool };
