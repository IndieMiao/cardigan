import type { AgentBinary } from "@cardigan/domain";
import type {
  BrowserServer,
  CompileAssignmentInput,
} from "../assignment-types.js";
import type {
  CompiledFile,
  CompiledLaunch,
  CompileLaunchInput,
} from "../launch-types.js";
import type {
  LaunchConfig,
  LaunchProfileDefinition,
  ProviderDefinition,
  ResolvedProfile,
} from "../schema-definition.js";
import type { ContextReadInput, ContextReading } from "./context.js";

interface CompileContext {
  input: CompileLaunchInput;
  resolved: ResolvedProfile;
  providerEnv: Readonly<Record<string, string>>;
  secretEnv: Readonly<Record<string, string>>;
  profileArgs: readonly string[];
  extraArgs: readonly string[];
}
interface AssignmentContext {
  input: CompileAssignmentInput;
  base: CompiledLaunch;
  serverName: string;
  browser: BrowserServer | undefined;
  coreFile: string;
  toolNames: readonly string[];
  sessionDir: string;
  harnessFiles: CompiledFile[];
  harnessEnv: Record<string, string>;
  harnessArgs: string[];
}
interface ProfileContext {
  at: string;
  profile: LaunchProfileDefinition;
  model: NonNullable<LaunchConfig["models"]>[string] | undefined;
  provider: ProviderDefinition | undefined;
  details: string[];
}
export interface HarnessAdapter {
  normalizeProfile(context: ProfileContext): void;
  /** Only for an inline route, after validating common options and the provider binding. */
  inlineProfile?(
    context: ProfileContext & { provider: ProviderDefinition },
    configuredArgs: readonly string[],
  ): void;
  endpointEnvKey?(provider: ProviderDefinition): string | undefined;
  validateRoute(
    at: string,
    provider: ProviderDefinition,
    name: string,
    details: string[],
  ): void;
  probeCredential(provider: ProviderDefinition): string | undefined;

  readonly binary: AgentBinary;
  readonly displayName: string;
  readonly versionArgs: readonly string[];
  compile(context: CompileContext): CompiledLaunch;
  configureAssignment(context: AssignmentContext): void;
  /** Non-secret additions to compiled settings, applied after credential extraction. */
  readonly assignmentSettings?: Readonly<Record<string, boolean>>;
  localSetup?(
    input: CompileAssignmentInput,
    quote: (value: string) => string,
  ): string;
  registryDir?(input: CompileAssignmentInput): string;
  effortFromArgs(args: readonly string[]): string | undefined;
  profileArgs?(profile: LaunchProfileDefinition): readonly string[];
  readContext(input: ContextReadInput): Promise<ContextReading | undefined>;
  readonly contextSource: string;
  readonly useStatuslineCache?: boolean;
  readonly allowWorktreeDescendant?: boolean;
  readonly activityDiagnostic?: string;
}
