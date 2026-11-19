import {
  type ContextReadInput,
  type ContextReading,
  type ContextSample,
  json,
  object,
  parseActivityMetadata,
  parseContextSample,
} from "./context.js";
export async function readClaudeContext({
  readPrivateTranscript,
  onReadFailure,
  model,
  providerEnv,
}: ContextReadInput): Promise<ContextReading | undefined> {
  try {
    const stdout = await readPrivateTranscript();
    if (stdout === undefined) return;
    const event = json(stdout);
    if (event?.read_failed === true) {
      onReadFailure();
      return undefined;
    }
    return event && typeof event.path === "string"
      ? {
          usage: parseClaudeTranscript(
            stdout,
            event.path,
            claudeContextWindow(expandClaudeModel(model, providerEnv)),
          ),
          activity: parseActivityMetadata(event.activity),
          progress: parseActivityMetadata(object(event.activity)?.progress),
        }
      : undefined;
  } catch {
    onReadFailure();
    return undefined;
  }
}
/** Only an explicit launch suffix declares the window; no guessing from names. */
export function claudeContextWindow(
  model: string | null | undefined,
): number | null {
  return model && /\[1m\]$/i.test(model) ? 1_000_000 : null;
}
/**
 * Runs record the profile model, often a Claude Code alias such as `opus`.
 * The alias resolves through the profile's provider env (non-secret; secrets
 * live elsewhere), e.g. ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5-5[1m].
 */
export function expandClaudeModel(
  model: string | undefined,
  providerEnv: ContextReadInput["providerEnv"],
): string | undefined {
  const alias = /^(opus|sonnet|haiku|fable)$/i.exec(model ?? "")?.[1];
  if (!alias) return model;
  try {
    const env = providerEnv();
    const full = env?.[`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`];
    return typeof full === "string" && full ? full : model;
  } catch {
    return model;
  }
}
function tokenCount(value: unknown, optional = false): number | undefined {
  if (value === undefined && optional) return 0;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
/**
 * The last main-thread assistant message with usage is the current context.
 * Only numeric usage and session metadata leave this function; message text
 * and tool output are never copied.
 */
export function parseClaudeTranscript(
  tail: string,
  path: string,
  window: number | null,
  tailStart = 0,
): ContextSample | undefined {
  const lines = tail.split("\n");
  if (tailStart) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const event = json(lines[i] ?? "");
    if (event?.type !== "assistant" || event.isSidechain === true) continue;
    const message = object(event.message);
    const usage = object(message?.usage);
    if (!usage || message?.model === "<synthetic>") continue;
    const parts = [
      tokenCount(usage.input_tokens),
      tokenCount(usage.cache_creation_input_tokens, true),
      tokenCount(usage.cache_read_input_tokens, true),
      tokenCount(usage.output_tokens),
    ];
    if (parts.some((v) => v === undefined)) return undefined;
    const tokens = parts.reduce<number>((sum, v) => sum + (v ?? 0), 0);
    const sample = parseContextSample({
      agent: "claude",
      session_id: event.sessionId,
      cwd: event.cwd,
      transcript_path: path,
      model: message?.model,
      context_tokens: tokens,
      context_window_size: window ?? 1,
      updated_at: event.timestamp,
    });
    if (!sample) return undefined;
    return window === null
      ? { ...sample, context_window_size: null, used_percentage: null }
      : sample;
  }
  return undefined;
}
