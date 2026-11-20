import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Assignment, CommandState, RuntimeRef } from "@cardigan/domain";
import {
  agentProcessCommand,
  type ExecutionConfig,
  workerSessionPath,
} from "@cardigan/runtime-herdr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readSessionContexts } from "./context-usage.js";

// Replace only SSH transport: the production worker command runs on isolated files.
vi.mock("@cardigan/runtime-herdr", async (original) => ({
  ...(await original<typeof import("@cardigan/runtime-herdr")>()),
  agentProcessCommand: vi.fn(async (_config, args: string[]) => ({
    file: args[0],
    args: args.slice(1),
  })),
}));
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worker-activity-"));
});
afterEach(async () => {
  vi.clearAllMocks();
  await rm(root, { recursive: true, force: true });
});
const at = "2026-01-01T01:00:00Z";
function scenario() {
  const target = {
    project_id: "fixture",
    machine_id: "worker",
    session: "fixture",
    generation: "one",
    fingerprint: "a".repeat(64),
  };
  const worker = {
    mode: "agent-ssh",
    machine: "fixture-worker",
    dataDir: join(root, "controller"),
    agentRoot: join(root, "worker"),
    gid: 1234,
    identityFile: "/unused/id",
    knownHostsFile: "/unused/known",
    fileHelper: { python: "python3", path: "/unused/helper" },
    target,
  } satisfies ExecutionConfig;
  const generation = "b".repeat(32);
  const ref = {
    machine_id: "worker",
    runtime_machine: worker.machine,
    terminal_ref: "fixture-worker/t1",
    agent_name: "fixture",
    launch_generation: { run_id: "R-1", generation },
    target,
  } satisfies RuntimeRef;
  const a: Assignment = {
    id: "A-1",
    role_id: "coder",
    role_version: 1,
    scope: "standing",
    status: "active",
    runtime_state: "running",
    machine_id: "worker",
    mcp_token_id: "fixture",
    runtime_ref: ref,
    worktree_path: "/worktree",
    created_at: "2026-01-01T00:00:00Z",
  };
  // A later Run can reuse this same launch generation.
  const state = {
    project_id: "fixture",
    assignments: [a],
    runs: [
      {
        id: "R-2",
        assignment_id: a.id,
        harness: "claude-code",
        status: "running",
        started_at: a.created_at,
      },
    ],
    employees: [],
    events: [],
  } as unknown as CommandState;
  const sessionRoot = workerSessionPath(worker, {
    project: "fixture",
    assignment: a.id,
    run: "R-1",
    generation,
    target: target.fingerprint,
  });
  const path = join(
    sessionRoot,
    "claude",
    "projects",
    "-worktree",
    "one.jsonl",
  );
  const record = `${JSON.stringify({
    type: "assistant",
    sessionId: "one",
    cwd: "/worktree/src",
    timestamp: at,
    message: {
      model: "fixture",
      content: "SECRET-BODY",
      usage: { input_tokens: 1000, output_tokens: 20 },
    },
  })}\n`;
  const resolve = vi.fn(() => worker);
  const read = async (when = at) =>
    (
      await readSessionContexts(
        state,
        { execution: { mode: "local", dataDir: worker.dataDir } },
        when,
        undefined,
        resolve,
      )
    )[0];
  return { a, state, worker, ref, path, record, read, resolve };
}

test("worker Claude progress comes from the bound session generation and original record time", async () => {
  const t = scenario();
  await mkdir(dirname(t.path), { recursive: true });
  await writeFile(t.path, t.record);
  const sample = await t.read();
  expect(t.resolve).toHaveBeenCalledWith(t.ref, "fixture");
  expect(agentProcessCommand).toHaveBeenCalledWith(t.worker, expect.any(Array));
  expect(sample).toMatchObject({
    activity_status: "fresh",
    activity: {
      assignment_id: "A-1",
      run_id: "R-2",
      source: "claude-code:session_metadata",
      updated_at: expect.stringContaining("01:00:00"),
    },
  });
  expect(sample?.observation).toBeUndefined(); // No context restart from this activity-only source.
  expect(JSON.stringify(sample)).not.toContain("SECRET-BODY");
  expect((await t.read("2026-01-01T01:16:00Z"))?.activity_status).toBe("stale");
  await writeFile(join(dirname(t.path), "other.jsonl"), t.record);
  expect((await t.read())?.activity).toBeUndefined();
});

test("worker missing, symlink and changed target never borrow a local or old-generation record", async () => {
  const t = scenario();
  const local = join(
    t.worker.dataDir,
    "runs",
    "fixture",
    "A-1",
    "claude",
    "projects",
    "-worktree",
    "one.jsonl",
  );
  await mkdir(dirname(local), { recursive: true });
  await writeFile(local, t.record);
  const old = t.path.replace("b".repeat(32), "c".repeat(32));
  await mkdir(dirname(old), { recursive: true });
  await writeFile(old, t.record);
  expect((await t.read())?.activity).toBeUndefined();
  await mkdir(dirname(t.path), { recursive: true });
  await symlink(local, t.path);
  expect((await t.read())?.activity).toBeUndefined();
  t.resolve.mockReturnValue({
    ...t.worker,
    target: { ...t.worker.target, generation: "new" },
  });
  vi.mocked(agentProcessCommand).mockClear();
  expect((await t.read())?.activity).toBeUndefined();
  expect(agentProcessCommand).not.toHaveBeenCalled();
});

test("a unique worker file with conflicting session metadata proves neither progress nor a stall", async () => {
  const t = scenario();
  await mkdir(dirname(t.path), { recursive: true });
  await writeFile(t.path, t.record.replace('"one"', '"other"'));
  for (const when of [at, "2026-01-01T02:00:00Z"]) {
    const sample = await t.read(when);
    expect(sample?.activity).toBeUndefined();
    expect(sample?.activity_diagnostic).toContain("远程活动来源缺失");
  }
});

test("a worker target replaced during the read cannot supply activity", async () => {
  const t = scenario();
  await mkdir(dirname(t.path), { recursive: true });
  await writeFile(t.path, t.record);
  vi.mocked(agentProcessCommand).mockImplementationOnce(
    async (_config, args) => {
      t.resolve.mockReturnValue({
        ...t.worker,
        target: { ...t.worker.target, generation: "two" },
      });
      if (!args[0]) throw new Error("Missing worker command");
      return { file: args[0], args: args.slice(1) };
    },
  );
  const sample = await t.read();
  expect(sample?.activity).toBeUndefined();
  expect(sample?.activity_diagnostic).toContain("远程活动来源缺失");
  expect(t.resolve).toHaveBeenCalledTimes(2);
});
