import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assignment, CommandState } from "@cardigan/domain";
import { executionPaths } from "@cardigan/runtime-herdr";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  claudeContextWindow,
  parseClaudeTranscript,
  parseCodexContext,
  parseContextCache,
  readSessionContexts,
} from "./context-usage.js";

let root: string;
const now = "2026-01-01T00:01:00.000Z";
const a: Assignment = {
  id: "A-1",
  scope: "standing",
  role_id: "pm",
  role_version: 1,
  status: "active",
  runtime_state: "idle",
  runtime_ref: null,
  machine_id: "local",
  mcp_token_id: "fixture",
  created_at: "2026-01-01T00:00:00.000Z",
};
const state = (harness = "codex"): CommandState =>
  ({
    project_id: "fixture",
    assignments: [a],
    runs: [{ id: "R-1", assignment_id: a.id, harness, status: "completed" }],
    roles: [],
    employees: [],
    events: [],
    project_preferences: [],
  }) as unknown as CommandState;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "context-usage-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const execution = () => ({ mode: "local" as const, dataDir: root });
const runDir = () => executionPaths(execution(), "fixture", a.id).runDir;
const cache = (overrides = {}) => ({
  agent: "claude",
  session_id: "session-1",
  cwd: "/fixture",
  model: "fixture",
  transcript_path: "/never/read/this/path",
  context_tokens: 850,
  context_window_size: 1000,
  used_percentage: 85,
  updated_at: now,
  ...overrides,
});
const rollout = (tokens = 700000, session = "session-1") =>
  `${[
    { type: "session_meta", payload: { id: session, cwd: "/fixture" } },
    { type: "turn_context", payload: { model: "fixture" } },
    {
      type: "event_msg",
      timestamp: now,
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { total_tokens: tokens },
          total_token_usage: { total_tokens: 9000000 },
          model_context_window: 828400,
        },
      },
    },
  ]
    .map((v) => JSON.stringify(v))
    .join("\n")}\n`;
async function write(path: string, text: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

test("Codex uses the last current-context count and recorded window, never cumulative usage or static config", () => {
  const text = rollout() + rollout(500000).split("\n").slice(2).join("\n");
  expect(parseCodexContext(text, text, "/fixture/rollout.jsonl")).toMatchObject(
    {
      context_tokens: 500000,
      context_window_size: 828400,
      used_percentage: 60.4,
      model: "fixture",
    },
  );
  const missing =
    text +
    JSON.stringify({
      type: "event_msg",
      timestamp: now,
      payload: { type: "token_count", info: null },
    });
  expect(parseCodexContext(missing, missing, "unused")).toBeUndefined();
  expect(
    parseCodexContext(text, `${text}\n{partial`, "unused")?.context_tokens,
  ).toBe(500000);
});

test("newest Codex file with no usage stays missing; cache readers reject symlinks and invalid metrics", async () => {
  const dir = join(runDir(), "codex", "sessions", "2026", "01", "01");
  await write(join(dir, "rollout-2026-01-01T00-00-00-old.jsonl"), rollout());
  expect(
    (await readSessionContexts(state(), { execution: execution() }, now))[0],
  ).toMatchObject({ status: "fresh", context_window_size: 828400 });
  const latest = join(dir, "rollout-2026-01-01T00-01-00-new.jsonl");
  await write(
    latest,
    JSON.stringify({
      type: "session_meta",
      payload: { id: "new", cwd: "/fixture" },
    }),
  );
  expect(
    (await readSessionContexts(state(), { execution: execution() }, now))[0],
  ).toMatchObject({ status: "missing", stale: true, context_tokens: null });
  await rm(latest);
  await symlink(join(dir, "rollout-2026-01-01T00-00-00-old.jsonl"), latest);
  // A linked candidate is not read at all.
  expect(
    (await readSessionContexts(state(), { execution: execution() }, now))[0]
      ?.session_id,
  ).toBe("session-1");
  for (const v of [
    { context_tokens: -1 },
    { context_window_size: 0 },
    { context_tokens: null },
    { updated_at: "invalid" },
  ])
    expect(parseContextCache(cache(v))).toBeUndefined();
});

test("intermediate symlink cannot redirect host reads into another tree", async () => {
  const secret = join(root, "private", "sessions");
  await write(join(secret, "rollout-secret.jsonl"), rollout());
  await mkdir(runDir(), { recursive: true });
  await symlink(join(root, "private"), join(runDir(), "codex"));
  expect(
    (await readSessionContexts(state(), { execution: execution() }, now))[0]
      ?.status,
  ).toBe("missing");
});

test("pi and Claude share diagnostics; stale/future caches never yield a threshold action", async () => {
  await write(
    join(runDir(), "pi", "context-usage", "pi-session-1.json"),
    JSON.stringify(cache({ agent: "pi" })),
  );
  const options = { execution: execution(), staleAfterMs: 1000 };
  expect(
    (await readSessionContexts(state("pi"), options, now))[0],
  ).toMatchObject({
    status: "fresh",
    source: "pi_turn_end:getContextUsage",
    used_percentage: 85,
    level: "restart",
  });
  expect(
    (
      await readSessionContexts(
        state("pi"),
        options,
        "2026-01-01T00:01:01.001Z",
      )
    )[0],
  ).toMatchObject({ status: "stale", level: null });
  expect(
    (
      await readSessionContexts(
        state("pi"),
        options,
        "2026-01-01T00:00:59.999Z",
      )
    )[0],
  ).toMatchObject({ status: "stale", level: null });
});

test("external sessions require a unique exact cwd/session match; ambiguous caches stay display-only", async () => {
  const cacheDir = join(root, "shared");
  const s = {
    ...state("claude-code"),
    assignments: [{ ...a, external: true }],
  };
  await write(join(cacheDir, "claude-session-1.json"), JSON.stringify(cache()));
  const options = { execution: execution(), cacheDir };
  expect(
    (await readSessionContexts(s, options, now, "/fixture"))[0],
  ).toMatchObject({
    assignment_id: a.id,
    external: true,
    session_id: "session-1",
    status: "fresh",
  });
  await write(
    join(cacheDir, "claude-session-2.json"),
    JSON.stringify(cache({ session_id: "session-2" })),
  );
  const ambiguous = await readSessionContexts(s, options, now, "/fixture");
  expect(ambiguous[0]?.status).toBe("missing");
  expect(ambiguous.filter((v) => v.status === "unassociated")).toHaveLength(2);
  expect(ambiguous.every((v) => v.level === null)).toBe(true);
  const bound = {
    ...s,
    assignments: [{ ...a, external: true, session_ref: "session-2" }],
  };
  expect(
    (await readSessionContexts(bound, options, now, "/fixture"))[0]?.session_id,
  ).toBe("session-2");
  expect(
    await readSessionContexts(s, options, now, "/other-project"),
  ).toHaveLength(1);
});

test("a missing Codex sample cannot fall back to another harness cache at the same cwd", async () => {
  const cacheDir = join(root, "shared");
  await write(
    join(cacheDir, "claude-session-1.json"),
    JSON.stringify(cache({ cwd: runDir() })),
  );
  const contexts = await readSessionContexts(
    state(),
    { execution: execution(), cacheDir },
    now,
  );
  expect(contexts[0]).toMatchObject({
    assignment_id: a.id,
    context_tokens: null,
    stale: true,
    status: "missing",
    level: null,
  });
});

test.each(["2026-01-01T00:00:59.000Z", now])(
  "latest unknown pi sample suppresses an older valid sample at %s",
  async (olderAt) => {
    const dir = join(runDir(), "pi", "context-usage");
    await write(
      join(dir, "pi-older.json"),
      JSON.stringify(
        cache({ agent: "pi", session_id: "older", updated_at: olderAt }),
      ),
    );
    await write(
      join(dir, "pi-session-1.json"),
      JSON.stringify(
        cache({
          agent: "pi",
          context_tokens: null,
          context_window_size: null,
          used_percentage: null,
        }),
      ),
    );
    const contexts = await readSessionContexts(
      state("pi"),
      { execution: execution() },
      now,
    );
    expect(contexts[0]).toMatchObject({
      session_id: "session-1",
      updated_at: now,
      status: "missing",
      stale: true,
      context_tokens: null,
      used_percentage: null,
      level: null,
    });
    expect(contexts[0]).not.toHaveProperty("observation");
  },
);

const claudeLine = (
  usage: Record<string, unknown> | undefined,
  overrides: Record<string, unknown> = {},
) =>
  JSON.stringify({
    type: "assistant",
    sessionId: "session-1",
    cwd: "/fixture",
    timestamp: now,
    isSidechain: false,
    message: {
      model: "claude-opus-5-5",
      content: [{ type: "text", text: "SECRET-TRANSCRIPT-BODY" }],
      ...(usage ? { usage } : {}),
    },
    ...overrides,
  });
const claudeUsage = (input = 2, read = 240000) => ({
  input_tokens: input,
  cache_creation_input_tokens: 3998,
  cache_read_input_tokens: read,
  output_tokens: 2000,
});
const claudeState = (
  model = "claude-opus-5-5[1m]",
  session?: string,
): CommandState =>
  ({
    ...state("claude-code"),
    assignments: [
      {
        ...a,
        runtime_ref: session ? { agent_session_id: session } : null,
      },
    ],
    runs: [
      {
        id: "R-1",
        assignment_id: a.id,
        harness: "claude-code",
        model,
        status: "running",
      },
    ],
  }) as unknown as CommandState;
const claudeDir = () =>
  join(runDir(), "claude", "projects", "-srv-fixture-worktree");

test("Claude transcript: last main-thread usage, statusline formula, no message text", () => {
  const text = [
    claudeLine(claudeUsage(1, 100000)),
    JSON.stringify({ type: "user", message: { content: "hi" } }),
    claudeLine(claudeUsage()),
    claudeLine(claudeUsage(9, 900000), { isSidechain: true }),
    claudeLine({ input_tokens: 0, output_tokens: 0 }, {}).replace(
      "claude-opus-5-5",
      "<synthetic>",
    ),
    claudeLine(undefined),
    '{"type":"assistant","message":{"usage":{"input_tok',
  ].join("\n");
  const usage = parseClaudeTranscript(text, "/fixture/s.jsonl", 1_000_000);
  expect(usage).toMatchObject({
    agent: "claude",
    session_id: "session-1",
    context_tokens: 246000,
    context_window_size: 1_000_000,
    used_percentage: 24.6,
    updated_at: now,
  });
  expect(JSON.stringify(usage)).not.toContain("SECRET");
  // Truncated head line of a tail read is dropped, not parsed.
  expect(
    parseClaudeTranscript(`${claudeLine(claudeUsage())}`, "x", 1000, 10),
  ).toBeUndefined();
  expect(parseClaudeTranscript(claudeLine(undefined), "x", 1000)).toBe(
    undefined,
  );
  expect(
    parseClaudeTranscript(
      claudeLine({ ...claudeUsage(), output_tokens: -1 }),
      "x",
      1000,
    ),
  ).toBeUndefined();
  expect(
    parseClaudeTranscript(
      claudeLine(claudeUsage(), { sessionId: "../escape" }),
      "x",
      1000,
    ),
  ).toBeUndefined();
  expect(claudeContextWindow("claude-opus-5-5[1m]")).toBe(1_000_000);
  expect(claudeContextWindow("claude-opus-5-5")).toBeNull();
  expect(claudeContextWindow(undefined)).toBeNull();
});

test("managed Claude reads its own transcript and drives thresholds", async () => {
  await write(
    join(claudeDir(), "session-1.jsonl"),
    `${claudeLine(claudeUsage(2, 816000))}\n`,
  );
  const [context] = await readSessionContexts(
    claudeState(),
    { execution: execution() },
    now,
  );
  expect(context).toMatchObject({
    assignment_id: a.id,
    status: "fresh",
    source: "claude_transcript:last_usage",
    context_tokens: 822000,
    context_window_size: 1_000_000,
    used_percentage: 82.2,
    level: "handoff",
  });
  expect(context?.observation).toMatchObject({
    source: "claude_transcript:last_usage",
    used_percentage: 82.2,
  });
});

test("managed Claude picks the runtime session file, else the newest; no usage stays missing", async () => {
  const older = join(claudeDir(), "session-1.jsonl");
  const newer = join(claudeDir(), "session-2.jsonl");
  await write(older, `${claudeLine(claudeUsage(2, 100000))}\n`);
  await write(
    newer,
    `${claudeLine(claudeUsage(2, 500000), { sessionId: "session-2" })}\n`,
  );
  const { utimes } = await import("node:fs/promises");
  await utimes(older, new Date(1000), new Date(1000));
  // Subagent transcripts below the slug directory are not candidates.
  await write(
    join(claudeDir(), "session-2", "subagents", "agent-x.jsonl"),
    `${claudeLine(claudeUsage(2, 999000))}\n`,
  );
  const options = { execution: execution() };
  const read = async (s: CommandState) =>
    (await readSessionContexts(s, options, now))[0];
  expect(await read(claudeState(undefined, "session-1"))).toMatchObject({
    session_id: "session-1",
    context_tokens: 106000,
  });
  expect(await read(claudeState())).toMatchObject({
    session_id: "session-2",
    context_tokens: 506000,
  });
  expect(await read(claudeState(undefined, "unknown-session"))).toMatchObject({
    session_id: "session-2",
  });
  // An invalid session id never builds a path; it falls back to newest.
  expect(await read(claudeState(undefined, "../session-1"))).toMatchObject({
    session_id: "session-2",
  });
  await write(older, `${claudeLine(undefined)}\n{"partial`);
  expect(await read(claudeState(undefined, "session-1"))).toMatchObject({
    status: "missing",
    stale: true,
    context_tokens: null,
    source: "claude_transcript:last_usage",
    level: null,
  });
});

test("unknown Claude window shows tokens only, never a percentage or action", async () => {
  await write(
    join(claudeDir(), "session-1.jsonl"),
    `${claudeLine(claudeUsage(2, 900000))}\n`,
  );
  const [context] = await readSessionContexts(
    claudeState("claude-opus-5-5"),
    { execution: execution() },
    now,
  );
  expect(context).toMatchObject({
    source: "claude_transcript:last_usage",
    context_tokens: 906000,
    context_window_size: null,
    used_percentage: null,
    status: "missing",
    level: null,
  });
  expect(context).not.toHaveProperty("observation");
});

test("Claude transcript reader rejects file and directory symlinks", async () => {
  const secret = join(root, "private", "slug");
  await write(
    join(secret, "session-1.jsonl"),
    `${claudeLine(claudeUsage())}\n`,
  );
  await mkdir(join(runDir(), "claude", "projects"), { recursive: true });
  await symlink(secret, join(runDir(), "claude", "projects", "linked"));
  const options = { execution: execution() };
  expect(
    (await readSessionContexts(claudeState(), options, now))[0]?.status,
  ).toBe("missing");
  await mkdir(claudeDir(), { recursive: true });
  await symlink(
    join(secret, "session-1.jsonl"),
    join(claudeDir(), "session-1.jsonl"),
  );
  expect(
    (
      await readSessionContexts(
        claudeState(undefined, "session-1"),
        options,
        now,
      )
    )[0]?.status,
  ).toBe("missing");
  await rm(join(runDir(), "claude"), { recursive: true });
  await mkdir(runDir(), { recursive: true });
  await symlink(join(root, "private"), join(runDir(), "claude"));
  expect(
    (await readSessionContexts(claudeState(), options, now))[0]?.status,
  ).toBe("missing");
});
