import {
  type PromptObservation,
  type RuntimeRef,
  upstreamApiError,
} from "@cardigan/domain";
import type { HcClient } from "./client.js";

interface Terminal {
  address: string;
  state: string;
  labels?: Record<string, string>;
  status?: { state: string };
  foreground?: { name?: string; pid?: number; argv?: string[] };
  created_ms?: number;
}

/** C-746: lines Claude Code's status line may occupy under the editor. */
const STATUS_LINES = 4;

// The controller snapshot can have no OSC state for these clients. Accept
// only an empty editor and its own idle footer. Plain text cannot distinguish
// a stock placeholder from a draft containing those same words.
// Never export screen text, arguments, process ids or error messages.
function editor(screen: string, binding: PromptObservation) {
  if (Buffer.byteLength(screen) > 65536) return false;
  const lines = screen
    .split(/\r?\n/u)
    .map((s) => s.trim())
    .filter(Boolean);
  const codex = binding.harness === "codex";
  const footer = lines.at(-1) ?? "";
  if (
    !(
      codex
        ? /(?:\? for shortcuts|\d+% context left)/iu
        : /(?:\? for shortcuts|shift\+tab to cycle)/iu
    ).test(footer)
  )
    return false;
  const bottom = lines.slice(0, -1);
  if (!codex) {
    // C-746: Claude Code draws the session's status line (Cardigan's
    // statusLine setting) between the editor's bottom rule and the footer.
    // Skip at most STATUS_LINES of them, only when a rule closes them off
    // and another rule tops the empty editor (same rule as the worker).
    const rule = (line?: string) => /^─+$/u.test(line ?? "");
    for (let n = 1; n <= STATUS_LINES; n++)
      if (bottom.length > n + 2 && rule(bottom.at(-1 - n))) {
        if (bottom.at(-2 - n) === "❯" && rule(bottom.at(-3 - n)))
          bottom.splice(-n);
        break;
      }
    if (rule(bottom.at(-1))) bottom.pop();
  }
  if (bottom.pop() !== (codex ? "›" : "❯")) return false;
  if (
    /esc to (?:interrupt|cancel)|press enter to confirm/iu.test(
      lines.slice(-8).join("\n"),
    )
  )
    return false;
  if (binding.require_upstream_error) {
    while (/^─+$/u.test(bottom.at(-1) ?? "")) bottom.pop();
    return (
      upstreamApiError(bottom) ===
      (binding.require_upstream_error === true ? "outage" : "disconnect")
    );
  }
  if (binding.require_disconnect === undefined) return true;
  while (/^─+$/u.test(bottom.at(-1) ?? "")) bottom.pop();
  const disconnected =
    /^(?:[⎿●■⚠]\s*)?(?:API Error:\s*Connection lost mid-response|stream disconnected(?: before completion)?)(?:[.: ].*)?$/iu.test(
      bottom.at(-1) ?? "",
    );
  return disconnected === binding.require_disconnect;
}

/**
 * C-842: hc may report a CLI stopped on a model API error as `error`. Only an
 * observation that positively requires that error above the empty editor
 * accepts the state; the screen check itself proves the stop.
 */
const errorScreen = (binding: PromptObservation) =>
  !!binding.require_upstream_error || binding.require_disconnect === true;

export async function boundPrompt(
  raw: Pick<HcClient, "exec">,
  ref: RuntimeRef,
  binding: PromptObservation,
) {
  if (
    !/^[a-z0-9_-]{1,32}$/u.test(ref.agent_name) ||
    (ref.target && ref.target.project_id !== binding.project_id)
  )
    return false;
  const name =
    ref.runtime_machine === "local"
      ? ref.agent_name
      : `${ref.runtime_machine}/${ref.agent_name}`;
  const read = async () => {
    const t: Terminal = JSON.parse(await raw.exec(["get", name, "--json"]));
    const labels = t.labels;
    // A legacy relay may omit owner labels. Its project-pinned target and
    // platform-generated unique alias must still resolve to this exact address.
    const namedLegacy =
      !ref.launch_generation &&
      ref.target?.project_id === binding.project_id &&
      /^[a-z0-9_-]{1,7}-[a-f0-9]{24}$/u.test(ref.agent_name) &&
      labels?.project === undefined &&
      labels?.assignment === undefined &&
      labels?.run === undefined;

    if (
      t.address !== ref.terminal_ref ||
      t.state !== "live" ||
      (!namedLegacy &&
        (labels?.project !== binding.project_id ||
          labels?.assignment !== binding.assignment_id)) ||
      labels?.generation !== ref.launch_generation?.generation ||
      (ref.launch_generation && labels?.run !== ref.launch_generation.run_id) ||
      ![
        "unknown",
        "idle",
        "done",
        ...(errorScreen(binding) ? ["error"] : []),
      ].includes(t.status?.state ?? "unknown")
    )
      return;
    const program = binding.harness === "codex" ? "codex" : "claude";
    const executable = t.foreground?.name?.split("/").at(-1);
    const nodeEntry = t.foreground?.argv?.[1] ?? "";
    const packagedCli =
      executable === "node" &&
      (program === "claude"
        ? nodeEntry.endsWith("/@anthropic-ai/claude-code/cli.js")
        : nodeEntry.endsWith("/@openai/codex/bin/codex.js"));
    if (
      (executable !== program && !packagedCli) ||
      !t.foreground?.pid ||
      t.foreground.pid <= 0
    )
      return;
    return t;
  };
  try {
    const before = await read();
    if (!before) return false;
    const screen = await raw.exec(["read", ref.terminal_ref, "--lines", "0"]);
    if (!editor(screen, binding)) return false;
    const after = await read();
    const state = before.status?.state ?? "unknown";
    if (
      !after ||
      (after.status?.state ?? "unknown") !== state ||
      after.created_ms !== before.created_ms ||
      after.foreground?.pid !== before.foreground?.pid
    )
      return false;
    return state;
  } catch {
    return false;
  }
}
