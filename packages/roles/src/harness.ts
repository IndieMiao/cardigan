import {
  type AgentBinary,
  HARNESS_CATALOG,
  HARNESSES,
  type Harness,
} from "@cardigan/domain";

export { HARNESSES, type Harness, isHarness } from "@cardigan/domain";
/** Compatibility projection of the public catalog. */
export const HARNESS_BINARY = Object.freeze(
  Object.fromEntries(
    HARNESSES.map((id) => [id, HARNESS_CATALOG[id].binary]),
  ) as Record<Harness, AgentBinary>,
);

/**
 * C-564: values the launch settings form offers for a profile's
 * `permission_mode`, per harness. Only Claude Code takes the parameter
 * (`--permission-mode`, choices of Claude Code 2.1.318); the other harnesses
 * have none, so nothing is selectable there. launch.yaml itself is not
 * restricted: a hand-written value outside the list stays as it is.
 */
export const PERMISSION_MODES: Readonly<Record<Harness, readonly string[]>> =
  Object.freeze({
    "claude-code": Object.freeze([
      "plan",
      "manual",
      "acceptEdits",
      "dontAsk",
      "auto",
      "bypassPermissions",
    ]),
    codex: Object.freeze([]),
    pi: Object.freeze([]),
  });
