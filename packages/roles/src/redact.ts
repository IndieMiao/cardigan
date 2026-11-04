import type { CompiledLaunch } from "./compile.js";

export const REDACTED = "***";

/**
 * Replace every secret value with `***` so a compiled launch can be printed.
 *
 * Works on both the environment (by known secret key names) and on generated
 * file content (by replacing each secret value that appears in it). Values
 * shorter than 4 characters are still replaced by exact match, so a short test
 * secret does not leak either.
 */
export function redactLaunch(
  compiled: CompiledLaunch,
  secrets: Readonly<Record<string, string>>,
): CompiledLaunch {
  const values = Object.values(secrets)
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);

  const redactText = (text: string): string => {
    let result = text;
    for (const value of values) {
      result = result.split(value).join(REDACTED);
    }
    return result;
  };

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(compiled.env)) {
    env[key] = compiled.secretEnvKeys.includes(key)
      ? REDACTED
      : redactText(value);
  }

  return {
    ...compiled,
    env,
    files: compiled.files.map((file) => ({
      ...file,
      content: redactText(file.content),
    })),
  };
}
