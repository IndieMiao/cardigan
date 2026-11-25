export {
  claudeContextWindow,
  expandClaudeModel,
  parseClaudeTranscript,
} from "./adapters/claude-context.js";
export { parseCodexContext } from "./adapters/codex-context.js";
export {
  type ActivityMetadata,
  type ContextReadInput,
  type ContextReading,
  type ContextSample,
  measured,
  parseContextCache,
  parseContextSample,
} from "./adapters/context.js";
export { getHarnessAdapter } from "./adapters/registry.js";
export type { HarnessAdapter } from "./adapters/types.js";
export {
  type AssignmentIdentity,
  type AssignmentMcpEndpoint,
  type AssignmentRoleInput,
  BROWSER_BOUNDARY_RULE,
  BROWSER_CAPABILITY,
  BROWSER_MCP_ARGS,
  BROWSER_MCP_SERVER_NAME,
  BROWSER_ROLES,
  BROWSER_TOOL_PATTERN,
  type CompileAssignmentInput,
  type CompiledAssignmentLaunch,
  compileAssignmentLaunch,
  LAUNCH_SCRIPT_NAME,
  MCP_SERVER_NAME,
  MCP_SESSION_HEADER,
  MCP_SESSION_KEY_PATTERN,
  RUN_RESOURCE_RULE,
  SECRETS_FILE_NAME,
  START_FILE_NAME,
  TOKEN_ENV_VAR,
  TOKEN_FILE_NAME,
} from "./assignment.js";
export {
  CAPABILITY_GUIDE_TOOL,
  CAPABILITY_NOTE_PROMPT_MAX_ENTRIES,
  CAPABILITY_NOTE_PROMPT_MAX_LENGTH,
  type CapabilityNoteInput,
  capabilityNotesPrompt,
  condenseCapabilityNote,
} from "./capability-notes.js";
export {
  type CompiledFile,
  type CompiledLaunch,
  type CompileLaunchInput,
  compileLaunch,
} from "./compile.js";
export {
  LaunchConfigError,
  type LaunchConfigErrorCode,
} from "./errors.js";
export {
  HARNESS_BINARY,
  HARNESSES,
  type Harness,
  isHarness,
} from "./harness.js";
export {
  type ImportClaudeSettingsInput,
  type ImportClaudeSettingsResult,
  importClaudeSettings,
} from "./import-claude-settings.js";
export {
  type LaunchWarning,
  launchWarnings,
  reportLaunchWarnings,
} from "./launch-diagnostics.js";
export {
  DEFAULT_MCP_BRIDGE_PYTHON,
  MCP_BRIDGE_PROBE_ARGS,
  MCP_BRIDGE_SESSION_ENV,
  MCP_BRIDGE_SOURCE,
  mcpBridgeAccepts,
  mcpBridgeArgs,
} from "./mcp-bridge.js";
export {
  type CatalogEntry,
  catalogCache,
  catalogEntries,
} from "./model-catalog.js";
export { REDACTED, redactLaunch } from "./redact.js";
export {
  exportRoleMarkdown,
  parseRoleMarkdown,
  type RoleMarkdown,
  RoleMarkdownError,
} from "./role-markdown.js";
export {
  AGENT_PROTOCOL,
  BROWSER_SCREENSHOT_RULE,
  type ConvertedRoleInstructions,
  composeRolePrompt,
  convertLegacyRole,
  corePromptFor,
  DEFAULT_ROLE_KINDS,
  DEFAULT_ROLE_LAUNCH,
  type DefaultRoleId,
  type DefaultRoleOptions,
  defaultRoleDefinition,
  defaultRoles,
  firstPrompt,
  HOST_OPS_OFFICE_MENTION_RULES,
  HUMAN_ACTION_MERGE_RULE,
  instructionsFor,
  isDefaultRoleId,
  MENTION_FIELD_RULE,
  P2A_PM_DECISION_RULES,
  P2A_PM_OPS_RULES,
  P2A_PM_PLANNING_RULES,
  PM_CARD_DEPENDENCY_RULE,
  PM_DECISION_RULES,
  PM_DELEGATION_RULES,
  PM_FLOW_LITE_RULES,
  PM_HOST_MATTERS_RULE,
  PM_OFFICE_MENTION_FIRST_LINE_RULE,
  PM_OFFICE_MENTION_RULES,
  PM_OFFICE_NUDGE_RULES,
  PM_OFFICE_PRE_MERGE_RULES,
  PM_OFFICE_REPORTING_RULES,
  PM_OFFICE_SESSION_START_RULES,
  PM_OFFICE_STORY_PROPOSAL_RULES,
  PM_OPS_EVENT_RULES,
  PM_OWNER_REQUIRED_RULE,
  PM_PLANNING_RULES,
  PM_TEMPLATE_RULES,
  PM_UNNAMED_REQUEST_RULE,
  PM_VERIFICATION_RULES,
  REVIEW_CONVERGENCE_RULES,
  SHARED_BOUNDARIES,
  VERIFIER_MUST_FIX_RULES,
} from "./role-pack.js";
export {
  type BrowserLaunchDefinition,
  type LaunchConfig,
  type LaunchProfileDefinition,
  type ProviderDefinition,
  parseLaunchConfig,
  parseSecretsText,
  prepareLaunchConfig,
  type ResolvedProfile,
  requiredSecretKeys,
  resolveProfile,
  validateLaunchSecrets,
} from "./schema.js";
export {
  compiledLaunchSettings,
  effortFromArgs,
  type LaunchSettings,
  profileLaunchSettings,
} from "./settings.js";
export { testReviewPrompt } from "./test-review.js";
export { parseWorkerEnvironment } from "./worker-environment.js";
