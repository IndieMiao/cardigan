import type { LaunchConfig, LaunchProfileDefinition } from "@cardigan/roles";

/**
 * C-106: what the execution view shows of a Run's launch profile. Only the
 * harness and the reasoning effort; never the provider, env or secrets.
 */
export interface LaunchSummary {
  readonly harness: string;
  /** The profile's model, compared with the Run's recorded model. */
  readonly model: string | null;
  readonly effort: string | null;
}

export type LaunchLookup = (profileRef: string) => LaunchSummary | undefined;

/**
 * The effort only comes from structured profile fields: Claude Code's
 * `--effort` argument and Codex's `model_reasoning_effort` override. Anything
 * else (Pi, free-form args) is unknown rather than guessed.
 */
export function profileEffort(profile: LaunchProfileDefinition): string | null {
  if (profile.harness === "codex") {
    const value = profile.config?.model_reasoning_effort;
    return typeof value === "string" && value.length > 0 ? value : null;
  }
  if (profile.harness === "claude-code") {
    const args = profile.args ?? [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? "";
      if (arg === "--effort") {
        const value = args[index + 1];
        return value && !value.startsWith("-") ? value : null;
      }
      if (arg.startsWith("--effort="))
        return arg.slice("--effort=".length) || null;
    }
  }
  return null;
}

export function launchLookup(config: LaunchConfig): LaunchLookup {
  return (profileRef) => {
    if (!Object.hasOwn(config.profiles, profileRef)) return undefined;
    const profile = config.profiles[profileRef];
    if (profile === undefined) return undefined;
    return {
      harness: profile.harness,
      model: profile.model ?? null,
      effort: profileEffort(profile),
    };
  };
}

/**
 * The Run's harness and effort. The Run only snapshots its model and profile
 * name, so the profile is read from the host's launch configuration; when the
 * profile is gone or its model no longer matches the Run's, the profile has
 * changed since the Run and both stay unknown (null).
 */
export function runLaunchFields(
  run: { readonly model: string; readonly launch_profile_ref?: string },
  lookup: LaunchLookup | undefined,
): { readonly harness: string | null; readonly effort: string | null } {
  const summary =
    run.launch_profile_ref === undefined || lookup === undefined
      ? undefined
      : lookup(run.launch_profile_ref);
  if (summary === undefined || summary.model !== run.model)
    return { harness: null, effort: null };
  return { harness: summary.harness, effort: summary.effort };
}
