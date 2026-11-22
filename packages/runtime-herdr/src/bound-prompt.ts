import type { PromptBinding, RuntimeRef } from "@cardigan/domain";
import type { HcClient } from "./client.js";

interface Terminal {
  address: string;
  state: string;
  labels?: Record<string, string>;
  status?: { state: string };
  foreground?: { name?: string; pid?: number; argv?: string[] };
  created_ms?: number;
}

// The controller snapshot can have no OSC state for these clients. Accept
// only an empty editor (or a stock placeholder) and its own idle footer.
// Never export screen text, arguments, process ids or error messages.
function editor(screen: string, binding: PromptBinding) {
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
  if (!codex && /^─+$/u.test(bottom.at(-1) ?? "")) bottom.pop();
  if (
    !(
      codex
        ? /^›(?: (?:Implement \{feature\}|Explain this codebase|Find and fix a bug in @filename|Write tests for @filename))?$/u
        : /^❯$/u
    ).test(bottom.pop() ?? "")
  )
    return false;
  if (
    /esc to (?:interrupt|cancel)|press enter to confirm/iu.test(
      lines.slice(-8).join("\n"),
    )
  )
    return false;
  if (!binding.require_disconnect) return true;
  while (/^─+$/u.test(bottom.at(-1) ?? "")) bottom.pop();
  return /^(?:[⎿●■⚠]\s*)?(?:API Error:\s*Connection lost mid-response|stream disconnected(?: before completion)?)(?:[.: ].*)?$/iu.test(
    bottom.at(-1) ?? "",
  );
}

export async function boundPrompt(
  raw: Pick<HcClient, "exec">,
  ref: RuntimeRef,
  binding: PromptBinding,
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
      !labels?.project &&
      !labels?.assignment;

    if (
      t.address !== ref.terminal_ref ||
      t.state !== "live" ||
      (!namedLegacy &&
        (labels?.project !== binding.project_id ||
          labels?.assignment !== binding.assignment_id)) ||
      labels?.generation !== ref.launch_generation?.generation ||
      (ref.launch_generation && labels?.run !== ref.launch_generation.run_id) ||
      !["unknown", "idle", "done"].includes(t.status?.state ?? "unknown")
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
    if (
      !binding.require_disconnect &&
      ["idle", "done"].includes(before.status?.state ?? "")
    )
      return true;
    const screen = await raw.exec(["read", ref.terminal_ref, "--lines", "0"]);
    if (!editor(screen, binding)) return false;
    const after = await read();
    return (
      !!after &&
      after.created_ms === before.created_ms &&
      after.foreground?.pid === before.foreground?.pid
    );
  } catch {
    return false;
  }
}
