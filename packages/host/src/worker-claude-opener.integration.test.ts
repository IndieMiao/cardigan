import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { captureTranscript } from "./capture-transcript.js";
import { CLAUDE_CONTEXT_READER } from "./claude-context-reader.js";
import { WORKER_CLAUDE_OPENER } from "./worker-claude-transcript.js";

// openat/NOFOLLOW, the fd handoff to Node and stdout redaction are OS contracts.
// Run the real opener once per case; no SSH, sleeps or polling.
let root: string, folder: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worker-opener-"));
  folder = join(root, "generation", "claude", "projects", "-worktree");
  await mkdir(folder, { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));
const at = "2026-01-01T01:00:00Z";
const record = (sessionId: string) =>
  JSON.stringify({
    type: "assistant",
    sessionId,
    cwd: "/worktree/src",
    timestamp: at,
    message: {
      model: "fixture",
      content: "SECRET-BODY",
      usage: { input_tokens: 1000, output_tokens: 20 },
    },
  });
const read = () =>
  captureTranscript("python3", [
    "-I",
    "-B",
    "-c",
    WORKER_CLAUDE_OPENER,
    join(root, "generation"),
    "",
    CLAUDE_CONTEXT_READER,
  ]);

test("the worker emits only activity from the fd and original record time", async () => {
  const path = join(folder, "one.jsonl");
  await writeFile(path, record("one"));
  expect(JSON.parse(await read())).toEqual({
    path,
    activity: { cwd: "/worktree/src", session_id: "one", updated_at: at },
  });
});

test.each(["missing", "symlink", "ambiguous", "conflicting session"])(
  "the opener refuses %s transcripts",
  async (kind) => {
    const outside = join(
      root,
      "other-generation",
      "claude",
      "projects",
      "-worktree",
    );
    await mkdir(outside, { recursive: true });
    const other = join(outside, "one.jsonl");
    await writeFile(other, record("one"));
    const path = join(folder, "one.jsonl");
    if (kind === "symlink") await symlink(other, path);
    if (kind === "ambiguous") {
      await writeFile(path, record("one"));
      await writeFile(join(folder, "other.jsonl"), record("other"));
    }
    if (kind === "conflicting session") await writeFile(path, record("other"));
    expect(JSON.parse(await read())).toBeNull();
  },
);
