/**
 * Harness identifiers used by launch profiles.
 *
 * The identifier is Cardigan's own name; the mapping to the CLI binary lives in
 * `HARNESS_BINARY` so the compile step never guesses an executable name.
 */
export const HARNESSES = ["claude-code", "codex", "pi"] as const;

export type Harness = (typeof HARNESSES)[number];

export const HARNESS_BINARY: Readonly<Record<Harness, string>> = {
  "claude-code": "claude",
  codex: "codex",
  pi: "pi",
};

export function isHarness(value: string): value is Harness {
  return (HARNESSES as readonly string[]).includes(value);
}
