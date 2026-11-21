import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CommandState } from "@cardigan/domain";
import {
  agentProcessCommand,
  type ExecutionConfig,
} from "@cardigan/runtime-herdr";
import { afterEach, expect, test, vi } from "vitest";
import { CLAUDE_CONTEXT_READER } from "./claude-context-reader.js";
import { readSessionContexts } from "./context-usage.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(fs.open) };
});
vi.mock("@cardigan/runtime-herdr", async (original) => ({
  ...(await original<typeof import("@cardigan/runtime-herdr")>()),
  // Exercise the actual fixed reader in a separate process, without SSH keys.
  agentProcessCommand: vi.fn(async (_execution, argv: readonly string[]) => ({
    file: process.execPath,
    args: argv.slice(1),
  })),
}));

let root: string;
afterEach(async () => {
  vi.mocked(open).mockReset();
  vi.mocked(agentProcessCommand).mockClear();
  if (root) await rm(root, { recursive: true, force: true });
});

test.each([
  ["worktrees", "claude-fixture[1m]", 1_000_000, 24.6],
  ["runs", "claude-fixture[1m]", 1_000_000, 24.6],
  ["worktrees", null, null, null],
  ["runs", null, null, null],
])(
  "private Claude directories: %s cwd, model %s",
  async (kind, model, window, percent) => {
    root = await mkdtemp(join(tmpdir(), "claude-private-"));
    const runDir = join(root, "runs", "fixture", "A-1");
    const cwd = join(root, String(kind), "fixture", "A-1");
    const dir = join(runDir, "claude", "projects", cwd.replaceAll("/", "-"));
    const file = join(dir, "actual-session.jsonl");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const now = "2026-01-01T00:01:00.000Z";
    await writeFile(
      file,
      JSON.stringify({
        type: "assistant",
        sessionId: "actual-session",
        cwd,
        timestamp: now,
        message: {
          model: null,
          content: "SECRET-TRANSCRIPT-BODY",
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 3998,
            cache_read_input_tokens: 240000,
            output_tokens: 2000,
          },
        },
      }),
      { mode: 0o600 },
    );
    const execution: ExecutionConfig = {
      mode: "agent-ssh",
      dataDir: join(root, "host"),
      agentRoot: root,
      gid: 1234,
      machine: "fixture",
      identityFile: "/unused/key",
      knownHostsFile: "/unused/hosts",
    };
    const state = {
      project_id: "fixture",
      assignments: [
        {
          id: "A-1",
          status: "active",
          created_at: "2026-01-01T00:00:00.000Z",
          ...(kind === "worktrees" ? { worktree_path: cwd } : {}),
          // Production Herdr RuntimeRef has no agent_session_id.
          runtime_ref: { terminal_ref: "t-1", agent_name: "fixture" },
        },
      ],
      runs: [
        { id: "R-1", assignment_id: "A-1", harness: "claude-code", model },
      ],
      events: [],
      employees: [],
      project_preferences: [],
    } as unknown as CommandState;
    // Reproduce host/agent account separation: the host cannot open the private
    // 0700/0600 tree, while the agent-side process owns the synthetic fixture.
    vi.mocked(open).mockRejectedValue(
      Object.assign(new Error("denied"), { code: "EACCES" }),
    );
    const [sample] = await readSessionContexts(state, { execution }, now);
    expect(sample).toMatchObject({
      context_tokens: 246000,
      updated_at: now,
      session_id: "actual-session",
      model: null,
      context_window_size: window,
      used_percentage: percent,
      source: "claude_transcript:last_usage",
    });
    expect(agentProcessCommand).toHaveBeenCalledOnce();
    expect(vi.mocked(agentProcessCommand).mock.calls[0]?.[1].slice(-2)).toEqual(
      [runDir, ""],
    );
    expect(sample?.status).toBe(window === null ? "missing" : "fresh");
    if (window === null) expect(sample).not.toHaveProperty("observation");
    expect(JSON.stringify(sample)).not.toContain("SECRET-TRANSCRIPT-BODY");
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  },
);

const capture = promisify(execFile);
const rawRead = async (runDir: string, session = "") =>
  (
    await capture(
      process.execPath,
      ["-e", CLAUDE_CONTEXT_READER, "--", runDir, session],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 5000,
      },
    )
  ).stdout;
const line = (input = 100) =>
  JSON.stringify({
    type: "assistant",
    sessionId: "session",
    cwd: "/fixture",
    timestamp: "2026-01-01T00:01:00Z",
    message: {
      model: "fixture",
      content: "SECRET-BODY",
      usage: { input_tokens: input, output_tokens: 10 },
    },
  });

test("only complete tail records supply usage; a verified crossing record identifies the file write", async () => {
  root = await mkdtemp(join(tmpdir(), "claude-tail-"));
  const dir = join(root, "claude", "projects", "-fixture");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "session.jsonl");
  const padding = JSON.stringify({
    type: "user",
    sessionId: "session",
    cwd: "/fixture",
    content: "x".repeat(4 * 1024 * 1024),
  });
  await writeFile(file, `${line(1)}\n${padding}\n${line()}\n{"partial`);
  const stdout = await rawRead(root);
  expect(JSON.parse(stdout)).toMatchObject({
    message: { usage: { input_tokens: 100 } },
  });
  expect(stdout).not.toContain("SECRET-BODY");
  expect(stdout).not.toContain("content");
  expect(stdout.length).toBeLessThan(1024);
  // A sample before the bounded tail cannot be recovered from the file head.
  await writeFile(file, `${line(1)}\n${padding}\n`);
  // Use a known whole-second write time distinct from the record timestamp.
  const writtenAt = new Date("2026-01-01T00:05:00.000Z");
  await utimes(file, writtenAt, writtenAt);
  expect(JSON.parse(await rawRead(root))).toEqual({
    path: file,
    file_activity: {
      cwd: "/fixture",
      session_id: "session",
      updated_at: writtenAt.toISOString(),
    },
  });
});

test.each(["claude", "projects", "slug", "file"])(
  "rejects a %s symlink into another Assignment",
  async (level) => {
    root = await mkdtemp(join(tmpdir(), "claude-links-"));
    const first = join(root, "A-1"),
      second = join(root, "A-2");
    const parts = ["claude", "projects", "-fixture", "session.jsonl"];
    await mkdir(join(second, ...parts.slice(0, 3)), { recursive: true });
    await writeFile(join(second, ...parts), line());
    const depth = ["claude", "projects", "slug", "file"].indexOf(level) + 1;
    await mkdir(join(first, ...parts.slice(0, depth - 1)), { recursive: true });
    await symlink(
      join(second, ...parts.slice(0, depth)),
      join(first, ...parts.slice(0, depth)),
    );
    expect(JSON.parse(await rawRead(first, "../../A-2/session"))).toEqual(
      depth <= 2 ? { read_failed: true } : null,
    );
  },
);

test.each([
  "process.stdout.write('invalid-json')",
  "process.stdout.write('x'.repeat(70000))",
  "process.stderr.write('SECRET-ERROR'); process.exit(1)",
  "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 60000)",
])(
  "failed or invalid agent sampling stays missing without disrupting another Assignment: %s",
  async (script) => {
    root = await mkdtemp(join(tmpdir(), "claude-errors-"));
    const now = "2026-01-01T00:01:00Z";
    const dir = join(
      root,
      "runs",
      "fixture",
      "A-2",
      "claude",
      "projects",
      "-fixture",
    );
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "session.jsonl"), line());
    const execution: ExecutionConfig = {
      mode: "agent-ssh",
      dataDir: join(root, "host"),
      agentRoot: root,
      gid: 1234,
      machine: "fixture",
      identityFile: "/unused/key",
      knownHostsFile: "/unused/hosts",
    };
    const state = {
      project_id: "fixture",
      events: [],
      employees: [],
      project_preferences: [],
      assignments: ["A-1", "A-2"].map((id) => ({
        id,
        status: "active",
        runtime_ref: null,
        created_at: "2026-01-01T00:00:00Z",
      })),
      runs: ["A-1", "A-2"].map((assignment_id) => ({
        assignment_id,
        harness: "claude-code",
        model: "fixture[1m]",
      })),
    } as unknown as CommandState;
    vi.mocked(agentProcessCommand).mockResolvedValueOnce({
      file: process.execPath,
      args: ["-e", script, join(root, "reader.pid")],
    });
    const samples = await readSessionContexts(state, { execution }, now);
    expect(samples[0]).toMatchObject({
      status: "missing",
      context_tokens: null,
    });
    expect(samples[1]).toMatchObject({ status: "fresh", context_tokens: 110 });
    expect(JSON.stringify(samples)).not.toContain("SECRET-ERROR");
    if (script.includes("setInterval")) {
      const pid = Number(await readFile(join(root, "reader.pid"), "utf8"));
      expect(pid).toBeGreaterThan(0);
      // The real ten-second execFile timeout must reap the child (which ignores TERM).
      expect(() => process.kill(pid, 0)).toThrow();
    }
  },
  15_000,
);

test("the fixed remote reader exits on its own deadline when filesystem IO stalls", async () => {
  const pending = capture(
    process.execPath,
    [
      "-e",
      `
    require('node:fs/promises').open = () => new Promise(() => {});
    ${CLAUDE_CONTEXT_READER}
  `,
      "--",
      "/unused",
      "",
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  await expect(pending).rejects.toMatchObject({
    code: 1,
    killed: false,
    signal: null,
    stdout: "",
    stderr: "",
  });
  const pid = pending.child.pid;
  expect(pid).toBeGreaterThan(0);
  if (pid) expect(() => process.kill(pid, 0)).toThrow();
}, 16_000);

test("cancelling sampling reaps the active child and never starts the next Assignment", async () => {
  root = await mkdtemp(join(tmpdir(), "claude-abort-"));
  const pidFile = join(root, "reader.pid");
  vi.mocked(agentProcessCommand).mockResolvedValueOnce({
    file: process.execPath,
    args: [
      "-e",
      "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 60000)",
      pidFile,
    ],
  });
  const controller = new AbortController();
  const pending = readSessionContexts(
    {
      project_id: "fixture",
      events: [],
      employees: [],
      project_preferences: [],
      assignments: ["A-1", "A-2"].map((id) => ({
        id,
        status: "active",
        runtime_ref: null,
      })),
      runs: ["A-1", "A-2"].map((assignment_id) => ({
        assignment_id,
        harness: "claude-code",
      })),
    } as unknown as CommandState,
    {
      execution: {
        mode: "agent-ssh",
        dataDir: join(root, "host"),
        agentRoot: root,
        gid: 1234,
        machine: "fixture",
        identityFile: "/unused/key",
        knownHostsFile: "/unused/hosts",
      },
      signal: controller.signal,
    },
    "2026-01-01T00:01:00Z",
  );
  let pid = 0;
  try {
    await vi.waitFor(async () => {
      pid = Number(await readFile(pidFile, "utf8"));
      expect(pid).toBeGreaterThan(0);
    });
  } finally {
    controller.abort();
    await pending;
  }
  expect(agentProcessCommand).toHaveBeenCalledOnce();
  expect(() => process.kill(pid, 0)).toThrow();
});
