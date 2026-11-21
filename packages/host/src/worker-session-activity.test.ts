import type { Assignment, CommandState, RuntimeRef } from "@cardigan/domain";
import {
  agentProcessCommand,
  type ExecutionConfig,
  workerSessionPath,
} from "@cardigan/runtime-herdr";
import { beforeEach, expect, test, vi } from "vitest";
import { captureTranscript } from "./capture-transcript.js";
import { CLAUDE_CONTEXT_READER } from "./claude-context-reader.js";
import { readSessionContexts } from "./context-usage.js";
import { WORKER_CLAUDE_OPENER } from "./worker-claude-transcript.js";

vi.mock("./capture-transcript.js", () => ({ captureTranscript: vi.fn() }));
vi.mock("@cardigan/runtime-herdr", async (original) => ({
  ...(await original<typeof import("@cardigan/runtime-herdr")>()),
  agentProcessCommand: vi.fn(async (_config, args: string[]) => ({
    file: args[0],
    args: args.slice(1),
  })),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(captureTranscript).mockReset();
});
const at = "2026-01-01T01:00:00Z";
function scenario({ currentMissing = false } = {}) {
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
    dataDir: "/fixture/controller",
    agentRoot: "/fixture/worker",
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
  const sessionRoot = (launchGeneration: string) =>
    workerSessionPath(worker, {
      project: "fixture",
      assignment: a.id,
      run: "R-1",
      generation: launchGeneration,
      target: target.fingerprint,
    });
  const currentRoot = sessionRoot(generation);
  const oldRoot = sessionRoot("c".repeat(32));
  const controllerRoot = `${worker.dataDir}/runs/fixture/${a.id}`;
  const metadata = (root: string) =>
    JSON.stringify({
      path: `${root}/claude/projects/-worktree/one.jsonl`,
      activity: { session_id: "one", cwd: "/worktree/src", updated_at: at },
    });
  // The controller and previous generation still have attributable records.
  vi.mocked(captureTranscript).mockImplementation(async (file, args) => {
    if (file === process.execPath && args.includes(controllerRoot))
      return metadata(controllerRoot);
    if (file === "python3" && args.includes(oldRoot)) return metadata(oldRoot);
    if (file === "python3" && args.includes(currentRoot))
      return currentMissing ? "null" : metadata(currentRoot);
    throw new Error("Unexpected transcript source");
  });
  const argv = [
    "python3",
    "-I",
    "-B",
    "-c",
    WORKER_CLAUDE_OPENER,
    currentRoot,
    "",
    CLAUDE_CONTEXT_READER,
    String(Date.parse(a.created_at)),
  ];
  function expectBoundRead() {
    expect(agentProcessCommand).toHaveBeenCalledExactlyOnceWith(worker, argv);
    expect(captureTranscript).toHaveBeenCalledExactlyOnceWith(
      "python3",
      argv.slice(1),
      undefined,
    );
  }
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
  return { worker, ref, read, resolve, expectBoundRead };
}

test("worker Claude progress comes from the bound session generation and original record time", async () => {
  const t = scenario();
  const sample = await t.read();
  expect(t.resolve).toHaveBeenCalledWith(t.ref, "fixture");
  t.expectBoundRead();
  expect(sample).toMatchObject({
    activity_status: "fresh",
    activity: {
      assignment_id: "A-1",
      run_id: "R-2",
      source: "claude-code:session_metadata",
      updated_at: at,
    },
  });
  expect(sample?.observation).toBeUndefined(); // No context restart from this activity-only source.
  expect((await t.read("2026-01-01T01:16:00Z"))?.activity_status).toBe("stale");
});

test("a missing current generation never borrows controller or old-generation activity", async () => {
  const t = scenario({ currentMissing: true });
  for (const when of [at, "2026-01-01T02:00:00Z"]) {
    vi.clearAllMocks();
    const sample = await t.read(when);
    t.expectBoundRead();
    expect(sample?.activity).toBeUndefined();
    expect(sample?.activity_status).toBe("missing");
    expect(sample?.activity_diagnostic).toContain("远程活动来源缺失");
  }
});

test("a changed target cannot fall back to the controller or old generation", async () => {
  const t = scenario();
  t.resolve.mockReturnValue({
    ...t.worker,
    target: { ...t.worker.target, generation: "new" },
  });
  expect((await t.read())?.activity).toBeUndefined();
  expect(agentProcessCommand).not.toHaveBeenCalled();
  expect(captureTranscript).not.toHaveBeenCalled();
});

test("a worker target replaced during the read cannot supply activity", async () => {
  const t = scenario();
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
