/** Installed in the isolated PI_CODING_AGENT_DIR, never in the worktree. */
export const piContextUsageExtension = `
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export default function (pi) {
  pi.on("turn_end", async (_event, ctx) => {
    let temporary;
    try {
      const usage = ctx.getContextUsage();
      const session = ctx.sessionManager.getSessionId();
      const root = process.env.PI_CODING_AGENT_DIR;
      if (!root || !/^[a-zA-Z0-9_-]+$/.test(session) || !usage ||
          !Number.isFinite(usage.tokens) || usage.tokens < 0 ||
          !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return;
      const dir = join(root, "context-usage");
      await mkdir(dir, { recursive: true, mode: 0o750 });
      const value = {
        agent: "pi", session_id: session,
        transcript_path: ctx.sessionManager.getSessionFile() ?? null,
        cwd: ctx.cwd, model: ctx.model?.id ?? null,
        context_tokens: usage.tokens, context_window_size: usage.contextWindow,
        used_percentage: Math.round(usage.tokens / usage.contextWindow * 1000) / 10,
        updated_at: new Date().toISOString(),
      };
      temporary = join(dir, "." + randomUUID() + ".tmp");
      const file = await open(temporary, "wx", 0o640);
      try { await file.writeFile(JSON.stringify(value) + "\\n"); }
      finally { await file.close(); }
      await rename(temporary, join(dir, "pi-" + session + ".json"));
    } catch {
      // Telemetry must never fail the Agent's turn, including unavailable usage.
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
    }
  });
}
`;
