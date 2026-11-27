import {
  type Assignment,
  type CommandState,
  type ProjectId,
  type PromptObservation,
  type Run,
  type Runtime,
  type RuntimeRef,
  runsOf,
} from "@cardigan/domain";

/**
 * C-838: the harness this session runs. The Run it was launched for records
 * it; a legacy session (no launch generation, or a launch Run without it)
 * falls back to the latest started Run on the Assignment that recorded one.
 */
export function sessionHarness(
  state: CommandState,
  a: Assignment,
): Run["harness"] | undefined {
  const runs = runsOf(state.runs, a.id);
  const launch = a.runtime_ref?.launch_generation?.run_id;
  const launched = launch && runs.find((r) => r.id === launch)?.harness;
  if (launched) return launched;
  let latest: Run | undefined;
  for (const r of runs)
    if (
      r.harness &&
      r.started_at &&
      (!latest?.started_at || r.started_at > latest.started_at)
    )
      latest = r;
  return latest?.harness;
}

/**
 * C-838: the bound empty-editor observation for a session whose CLI does not
 * report activity to hc (Claude Code, Codex). Undefined for other harnesses.
 */
export function idlePromptBinding(
  project: ProjectId,
  a: Assignment,
  harness: Run["harness"] | undefined,
): PromptObservation | undefined {
  return harness === "claude-code" || harness === "codex"
    ? { project_id: project, assignment_id: a.id, harness }
    : undefined;
}

/**
 * C-838: hc 0.1.x takes activity only from OSC 7501, which Claude Code and
 * Codex never emit, so their sessions always read `unknown`. True only when
 * the bound CLI is in the foreground of this exact terminal showing its empty
 * editor and its own idle footer, read twice without change (C-626). A turn,
 * a draft, a confirmation, another program or a failed read are all false.
 */
export async function boundIdlePrompt(
  runtime: Pick<Runtime, "observe_prompt">,
  ref: RuntimeRef,
  binding: PromptObservation | undefined,
) {
  if (!binding || !runtime.observe_prompt) return false;
  const seen = await runtime
    .observe_prompt(ref, binding)
    .catch(() => undefined);
  return !!seen?.ok && seen.value === true;
}
