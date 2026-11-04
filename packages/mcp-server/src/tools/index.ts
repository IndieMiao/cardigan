import { ackEventsTool } from "./ack-events.js";
import { getCardTool } from "./get-card.js";
import { getUpdatesTool } from "./get-updates.js";
import type { ToolDefinition } from "./types.js";
import { whoamiTool } from "./whoami.js";

/** Read-only tools of M1.5; write tools arrive with M1.6. */
export const readOnlyTools: readonly ToolDefinition[] = [
  whoamiTool,
  getCardTool,
  getUpdatesTool,
  ackEventsTool,
];

export {
  allowedTools,
  defineTool,
  type ToolContext,
  type ToolDefinition,
} from "./types.js";
export { ackEventsTool, getCardTool, getUpdatesTool, whoamiTool };
