export {
  type AssignmentIdentity,
  type AssignmentMcpEndpoint,
  type AssignmentRoleInput,
  type CompileAssignmentInput,
  type CompiledAssignmentLaunch,
  compileAssignmentLaunch,
  LAUNCH_SCRIPT_NAME,
  MCP_SERVER_NAME,
  SECRETS_FILE_NAME,
  TOKEN_ENV_VAR,
  TOKEN_FILE_NAME,
} from "./assignment.js";
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
export { REDACTED, redactLaunch } from "./redact.js";
export {
  AGENT_PROTOCOL,
  corePromptFor,
  type DefaultRoleId,
  type DefaultRoleOptions,
  defaultRoles,
  firstPrompt,
} from "./role-pack.js";
export {
  type LaunchConfig,
  type LaunchProfileDefinition,
  type ProviderDefinition,
  parseLaunchConfig,
  parseSecretsText,
  type ResolvedProfile,
  requiredSecretKeys,
  resolveProfile,
} from "./schema.js";
