import {
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandState } from "@cardigan/domain";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readSessionContexts } from "./context-usage.js";
import { readParts } from "./session-files.js";

vi.mock("./session-files.js", async (original) => {
  const actual = await original<typeof import("./session-files.js")>();
  return { ...actual, readParts: vi.fn(actual.readParts) };
});
let root: string;
const now = "2026-01-01T01:00:00.000Z";
const cwd = "/fixture";
const metadata = { id: "session-1", cwd };
const line = (v: unknown) => `${JSON.stringify(v)}\n`;
const progress = (at = now) =>
  line({
    type: "response_item",
    timestamp: at,
    payload: { content: "SECRET-BODY-429-stream disconnected" },
  });
const codex = (body = progress(), session = metadata) =>
  line({ type: "session_meta", payload: session }) + body;
const state = (harness = "codex"): CommandState =>
  ({
    project_id: "fixture",
    assignments: [
      {
        id: "A-1",
        status: "active",
        worktree_path: cwd,
        runtime_ref: { terminal_ref: "t-1", agent_session_id: "session-1" },
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    runs: [
      {
        id: "R-1",
        assignment_id: "A-1",
        harness,
        status: "running",
        started_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    events: [],
    employees: [],
    project_preferences: [],
  }) as unknown as CommandState;
const runDir = () => join(root, "runs", "fixture", "A-1");
const rollout = () =>
  join(runDir(), "codex", "sessions", "rollout-2026-01-01-01.jsonl");
async function write(path: string, data: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, data);
}
const read = async (s = state(), at = now) =>
  (
    await readSessionContexts(
      s,
      { execution: { mode: "local", dataDir: root } },
      at,
    )
  )[0];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-activity-"));
});
afterEach(async () => {
  vi.mocked(readParts).mockClear();
  await rm(root, { recursive: true, force: true });
});

test.each(["codex", "claude-code", "pi"])(
  "%s activity does not require token/window measurements or disclose body",
  async (harness) => {
    if (harness === "codex") await write(rollout(), codex());
    if (harness === "claude-code")
      await write(
        join(runDir(), "claude", "projects", "-fixture", "session-1.jsonl"),
        line({
          type: "assistant",
          sessionId: "session-1",
          cwd,
          timestamp: now,
          message: { content: "SECRET-BODY", model: "fixture" },
        }),
      );
    if (harness === "pi")
      await write(
        join(
          runDir(),
          "pi",
          "sessions",
          "-fixture",
          "2026-01-01_session-1.jsonl",
        ),
        line({ type: "session", ...metadata }) +
          line({
            type: "message",
            timestamp: now,
            message: { role: "toolResult", content: "SECRET-BODY" },
          }),
      );
    const sample = await read(state(harness));
    expect(sample).toMatchObject({
      status: "missing",
      activity_status: "fresh",
      activity: { session_id: "session-1", updated_at: now },
    });
    expect(sample?.activity).not.toHaveProperty("error");
    expect(JSON.stringify(sample)).not.toContain("SECRET-BODY");
  },
);

test.each([
  ["usage_limit_exceeded", "rate_limit"],
  [{ http_connection_failed: { http_status_code: 429 } }, "rate_limit"],
  [{ http_connection_failed: { http_status_code: 503 } }, "server_error"],
  [{ stream_disconnected: { http_status_code: null } }, "stream_disconnected"],
  [undefined, "unclassified"],
])("Codex classifies only explicit error metadata: %j", async (info, error) => {
  await write(
    rollout(),
    codex(
      line({
        type: "event_msg",
        timestamp: now,
        payload: {
          type: "error",
          codex_error_info: info,
          message: "SECRET-BODY-429-stream disconnected",
        },
      }),
    ),
  );
  expect((await read())?.activity).toMatchObject({ error });
  await appendFile(
    rollout(),
    line({
      type: "event_msg",
      timestamp: now,
      payload: { type: "token_count", info: null },
    }),
  );
  expect((await read())?.activity).not.toHaveProperty("error");
});

test.each([429, 503])(
  "Claude API status %s is classified without exporting its message",
  async (status) => {
    await write(
      join(runDir(), "claude", "projects", "-fixture", "session-1.jsonl"),
      line({
        type: "system",
        subtype: "api_error",
        sessionId: "session-1",
        cwd,
        timestamp: now,
        error: { status, message: "SECRET-BODY" },
      }),
    );
    const sample = await read(state("claude-code"));
    expect(sample?.activity).toMatchObject({
      error: status === 429 ? "rate_limit" : "server_error",
    });
    expect(JSON.stringify(sample)).not.toContain("SECRET-BODY");
  },
);

test("missing files, failed reads and symlinked roots never imply activity", async () => {
  expect((await read())?.activity_status).toBe("missing");
  await write(rollout(), codex());
  vi.mocked(readParts).mockRejectedValueOnce(new Error("SECRET-READ-ERROR"));
  const failed = await read();
  expect(failed?.activity_diagnostic).toContain("活动来源缺失");
  expect(JSON.stringify(failed)).not.toContain("SECRET-READ-ERROR");
  await rm(join(runDir(), "codex"), { recursive: true });
  await write(join(root, "other", "sessions", "rollout-x.jsonl"), codex());
  await symlink(join(root, "other"), join(runDir(), "codex"));
  expect((await read())?.activity_status).toBe("missing");
});

test("rotation never falls back to a late older file; partial records cannot revive it", async () => {
  await write(rollout(), codex());
  await write(
    rollout().replace("-01.jsonl", "-02.jsonl"),
    line({ type: "session_meta", payload: { ...metadata, id: "new" } }) +
      '{"partial',
  );
  await appendFile(rollout(), progress());
  expect((await read())?.activity_status).toBe("missing");
});

test.each([
  ["2026-01-01T00:49:59.999Z", "stale"],
  ["2026-01-01T01:00:00.001Z", "stale"],
  ["2026-01-01T00:50:00.000Z", "fresh"],
])(
  "timestamp %s retains the existing inclusive freshness boundary",
  async (at, status) => {
    await write(rollout(), codex(progress(at)));
    expect((await read())?.activity_status).toBe(status);
  },
);

test("regressed record clocks, mismatched session/cwd and old generations fail association", async () => {
  await write(rollout(), codex(progress() + progress("2026-01-01T00:59:00Z")));
  expect((await read())?.activity_status).toBe("missing");
  await write(rollout(), codex(progress(), { ...metadata, id: "other" }));
  expect((await read())?.activity_status).toBe("stale");
  await write(
    rollout(),
    codex(progress(), { ...metadata, cwd: "/another-assignment" }),
  );
  expect((await read())?.activity_status).toBe("missing");
  await write(rollout(), codex());
  const s = state();
  const replaced = {
    ...s,
    events: [
      {
        type: "session_replaced",
        payload: { assignment_id: "A-1" },
        created_at: "2026-01-01T01:00:01Z",
      },
    ],
  } as unknown as CommandState;
  expect((await read(replaced, "2026-01-01T01:00:02Z"))?.activity_status).toBe(
    "stale",
  );
});

test("pi rotation and unclassified errors cannot borrow old progress or scan error text", async () => {
  const folder = join(runDir(), "pi", "sessions", "-fixture");
  const old = join(folder, "2026-01-01_session-1.jsonl");
  const next = join(folder, "2026-01-02_session-2.jsonl");
  const body = line({
    type: "message",
    timestamp: now,
    message: { role: "assistant" },
  });
  await write(old, line({ type: "session", ...metadata }) + body);
  await write(next, line({ type: "session", id: "session-2", cwd }));
  await appendFile(old, body);
  expect((await read(state("pi")))?.activity_status).toBe("missing");
  await rm(next);
  await appendFile(
    old,
    line({
      type: "message",
      timestamp: now,
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "SECRET-BODY 429 stream disconnected",
      },
    }),
  );
  const sample = await read(state("pi"));
  expect(sample?.activity?.error).toBe("unclassified");
  expect(sample?.activity_diagnostic).toContain("缺少结构化");
  expect(JSON.stringify(sample)).not.toContain("SECRET-BODY");
});

test("an unbound Claude session cannot use a late write to an older transcript as activity", async () => {
  const dir = join(runDir(), "claude", "projects", "-fixture");
  const record = (session: string) =>
    line({
      type: "assistant",
      sessionId: session,
      cwd,
      timestamp: now,
      message: { model: "fixture" },
    });
  await write(join(dir, "session-1.jsonl"), record("session-1"));
  await write(join(dir, "session-9.jsonl"), record("session-9"));
  await appendFile(join(dir, "session-1.jsonl"), record("session-1"));
  await utimes(
    join(dir, "session-1.jsonl"),
    new Date("2030-01-01T00:00:00Z"),
    new Date("2030-01-01T00:00:00Z"),
  );
  const s = state("claude-code");
  const unbound = {
    ...s,
    assignments: s.assignments.map((a) => ({
      ...a,
      runtime_ref: { ...a.runtime_ref, agent_session_id: undefined },
    })),
  } as unknown as CommandState;
  expect((await read(unbound))?.activity_status).toBe("missing");
});

test("only the bounded tail of allowed metadata records supplies activity", async () => {
  await write(
    rollout(),
    codex(
      progress() + line({ type: "irrelevant", timestamp: now }).repeat(256),
    ),
  );
  expect((await read())?.activity_status).toBe("missing");
});
