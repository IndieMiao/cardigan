import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, vi } from "vitest";
import { makePiContextUsageExtension } from "./pi-context-usage.js";

test.each([false, true])(
  "writes usage to the persistent home and tolerates IO failures (isolated registry: %s)",
  checkUsage,
);
async function checkUsage(isolated: boolean) {
  const root = await mkdtemp(join(tmpdir(), "pi-context-"));
  try {
    const script = join(root, "extension.mjs");
    await writeFile(
      script,
      makePiContextUsageExtension(isolated ? root : undefined),
    );
    const extension = (await import(pathToFileURL(script).href)).default;
    let callback: (_event: unknown, ctx: unknown) => Promise<void> =
      async () => {};
    extension({
      on: (event: string, cb: typeof callback) => {
        expect(event).toBe("turn_end");
        callback = cb;
      },
    });
    vi.stubEnv(
      "PI_CODING_AGENT_DIR",
      isolated ? join(root, "launch-R-1") : root,
    );
    const ctx = (session = "session-1", tokens: number | null = 850) => ({
      cwd: "/fixture",
      model: { id: "fixture" },
      getContextUsage: () => ({
        tokens,
        contextWindow: 1000,
        percent: tokens === null ? null : tokens / 10,
      }),
      sessionManager: {
        getSessionId: () => session,
        getSessionFile: () => `/fixture/${session}.jsonl`,
      },
    });
    await callback({}, ctx());
    const file = join(root, "context-usage", "pi-session-1.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      agent: "pi",
      session_id: "session-1",
      context_tokens: 850,
      context_window_size: 1000,
      used_percentage: 85,
    });
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    await callback({}, ctx("session-1", 900));
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      context_tokens: 900,
    });
    for (const getContextUsage of [
      () => ({ tokens: null, contextWindow: 1000, percent: null }),
      () => undefined,
      () => ({ tokens: NaN, contextWindow: 1000 }),
      () => ({ tokens: Infinity, contextWindow: 1000 }),
      () => ({ tokens: -1, contextWindow: 1000 }),
      () => ({ tokens: 850, contextWindow: 0 }),
      () => {
        throw new Error("Context temporarily unavailable");
      },
    ]) {
      await callback({}, ctx());
      await expect(
        callback({}, { ...ctx(), getContextUsage }),
      ).resolves.toBeUndefined();
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
        session_id: "session-1",
        context_tokens: null,
        context_window_size: null,
        used_percentage: null,
      });
    }
    await callback({}, ctx("session-1", 10));
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      context_tokens: 10,
      used_percentage: 1,
    });
    await callback({}, ctx("session-2", 0));
    expect(
      JSON.parse(
        await readFile(
          join(root, "context-usage", "pi-session-2.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ context_tokens: 0, used_percentage: 0 });
    await callback({}, ctx("unknown", null));
    expect((await readdir(join(root, "context-usage"))).sort()).toEqual([
      "pi-session-1.json",
      "pi-session-2.json",
      "pi-unknown.json",
    ]);
    await rm(join(root, "context-usage"), { recursive: true });
    await writeFile(join(root, "context-usage"), "not a directory");
    await expect(callback({}, ctx())).resolves.toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}
