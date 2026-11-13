import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assignment, CommandState } from "@cardigan/domain";
import { executionPaths } from "@cardigan/runtime-herdr";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
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
