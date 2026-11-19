/** Public protocol identifiers, in launch-config / UI order. No runtime IO here. */
export const HARNESS_CATALOG = Object.freeze({
  "claude-code": Object.freeze({
    binary: "claude",
    displayName: "claude",
  } as const),
  codex: Object.freeze({ binary: "codex", displayName: "codex" } as const),
  pi: Object.freeze({ binary: "pi", displayName: "pi" } as const),
});
export type Harness = keyof typeof HARNESS_CATALOG;
export type AgentBinary = (typeof HARNESS_CATALOG)[Harness]["binary"];
export const HARNESSES = Object.freeze(
  Object.keys(HARNESS_CATALOG) as Harness[],
);
export function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && Object.hasOwn(HARNESS_CATALOG, value);
}
export function isAgentBinary(value: unknown): value is AgentBinary {
  return HARNESSES.some((id) => HARNESS_CATALOG[id].binary === value);
}
