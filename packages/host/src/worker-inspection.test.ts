import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type Assignment,
  createHostOpsAssignment,
  formatId,
  HOST_OPS_ROLE_TOOLS,
  type Run,
  type Runtime,
} from "@cardigan/domain";
import {
  authenticate,
  loadCommandState,
  persistEffect,
  unwrap,
} from "@cardigan/mcp-server";
import {
  agentProcessCommand,
  type ExecutionConfig,
} from "@cardigan/runtime-herdr";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { HostOpsService } from "./host-ops.js";
import { inspectWorker } from "./worker-inspection.js";

vi.mock("@cardigan/runtime-herdr", async (original) => ({
  ...(await original<typeof import("@cardigan/runtime-herdr")>()),
  agentProcessCommand: vi.fn(),
}));
const project = "fixture";
function worker(machine: string) {
  const target = {
    project_id: project,
    machine_id: machine,
    generation: "one",
    session: "fixture",
    fingerprint: "a".repeat(64),
  };
  const execution: ExecutionConfig = {
    mode: "agent-ssh",
    dataDir: "/controller",
    agentRoot: "/worker",
    gid: 2001,
    machine: "binding",
    host: machine === "local" ? "localhost" : "remote.invalid",
    user: "worker",
    identityFile: "/private/ssh",
    knownHostsFile: "/private/fingerprint",
    target,
  };
  const a = { id: "A-1", machine_id: machine, runtime_ref: null } as Assignment;
  return { execution, a, target };
}
const sha = createHash("sha256")
  .update(
    readFileSync(new URL("../../../deploy/worker-files.py", import.meta.url)),
  )
  .digest("hex");
const reply = {
  free_bytes: 1000,
  helpers: [sha, "b".repeat(64), null],
  processes: [],
  terminals: null,
  markers: null,
  events: null,
};
const transport = (code: string) => ({
  file: process.execPath,
  args: ["-e", code],
});
test.each(["local", "remote-worker"])(
  "%s uses the selected worker account, projects only bounded evidence and compares deployed helpers",
  async (machine) => {
    const { execution, a } = worker(machine);
    vi.mocked(agentProcessCommand).mockResolvedValueOnce(
      transport(
        `let data='';process.stdin.on('data',s=>data+=s).on('end',()=>{const p=JSON.parse(data); if(p.assignment!=='A-1'||p.project!=='fixture'||p.root!=='/worker'||data.includes('/private/'))process.exit(3);console.log(JSON.stringify(${JSON.stringify({ ...reply, secrets: "do not copy" })}))})`,
      ),
    );
    const result = await inspectWorker(
      execution,
      project,
      a,
      undefined,
      true,
      "linux",
    );
    expect(agentProcessCommand).toHaveBeenLastCalledWith(
      execution,
      [
        "/usr/bin/python3",
        "-IB",
        "-c",
        expect.stringContaining("terminal.read"),
      ],
      { workerRuntimeDir: true },
    );
    expect(result.helpers.map((x) => x.matches_release)).toEqual([
      true,
      false,
      null,
    ]);
    expect(result).not.toHaveProperty("secrets");
  },
);
test.each([
  [
    "console.error('private credential');process.exit(255)",
    "ssh_connection_failed",
  ],
  ["console.error('private credential');process.exit(9)", "collector_exit_9"],
  [
    `console.log(JSON.stringify(${JSON.stringify({ ...reply, events: [{ time: "private credential", type: "private" }] })}))`,
    "invalid_collector_response",
  ],
  ["console.log('x'.repeat(40000))", "response_too_large"],
])(
  "local worker inspection reports a bounded failure (%s)",
  async (code, reason) => {
    const { execution, a } = worker("local");
    vi.mocked(agentProcessCommand).mockResolvedValueOnce(transport(code));
    await expect(
      inspectWorker(execution, project, a, undefined, true, "linux"),
    ).rejects.toMatchObject({
      message: `Worker inspection unavailable: ${reason}`,
      details: { reason },
    });
  },
);
test("unisolated local mode, external assignment, historical target drift and admin identity never reach SSH", async () => {
  const { execution, a } = worker("local");
  vi.mocked(agentProcessCommand).mockClear();
  for (const fn of [
    () =>
      inspectWorker(
        { mode: "local", dataDir: "/controller" },
        project,
        a,
        undefined,
        true,
        "linux",
      ),
    () =>
      inspectWorker(
        { ...execution, user: "ciadmin" },
        project,
        a,
        undefined,
        true,
        "linux",
      ),
    () =>
      inspectWorker(
        execution,
        project,
        { ...a, external: true },
        undefined,
        true,
        "linux",
      ),
    () => inspectWorker(execution, "other", a, undefined, true, "linux"),
    () =>
      inspectWorker(
        execution,
        project,
        a,
        {
          launch_publication: {
            target: { ...execution.target, fingerprint: "x" },
          },
        } as Run,
        false,
        "linux",
      ),
  ])
    await expect(fn()).rejects.toThrow();
  expect(agentProcessCommand).not.toHaveBeenCalled();
});
test.each([
  ["queued", false, false],
  ["cancelled", false, false],
  ["dispatched", true, false],
  ["running", true, true],
  ["acked", true, true],
] as const)(
  "local %s Run only receives the resident session with proof",
  async (status, current, live) => {
    const { execution, a, target } = worker("local");
    const generation = "cad0f00d-aaaa-4bbb-8000-aaaaaaaaaaaa";
    const owner = {
      ...a,
      runtime_ref: {
        target,
        runtime_machine: "binding",
        machine_id: "local",
        terminal_ref: "binding/t2",
        agent_name: "agent",
        launch_generation: { run_id: unwrap(formatId("run", 1)), generation },
      },
    };
    const run = {
      id: "R-9",
      status,
      recovery_runtime: owner.runtime_ref,
    } as Run;
    const expected = {
      live,
      generation: live ? generation : null,
      launch_run: live ? "R-1" : null,
      terminal: live ? "t2" : null,
      local: true,
    };
    vi.mocked(agentProcessCommand).mockResolvedValueOnce(
      transport(
        `let s='';process.stdin.on('data',x=>s+=x).on('end',()=>{const p=JSON.parse(s);if(!Object.entries(${JSON.stringify(expected)}).every(([k,v])=>p[k]===v))process.exit(2);console.log(JSON.stringify(${JSON.stringify(reply)}))})`,
      ),
    );
    const result = await inspectWorker(
      execution,
      project,
      owner,
      run,
      current,
      "linux",
    );
    expect(result.session_launch_run_id).toBe(expected.launch_run);
    expect(result.processes).toEqual(live ? [] : null);
    // C-746: every null live field names why; a present one names nothing.
    expect(result.unavailable).toEqual(
      live
        ? { terminals: "other", events: "other", last_activity_at: "other" }
        : Object.fromEntries(
            ["terminals", "processes", "events", "last_activity_at"].map(
              (k) => [k, current ? "session_not_bound" : "run_not_current"],
            ),
          ),
    );
  },
);

test("C-746: inspecting an idle remote session names why each field is null instead of returning bare nulls", async () => {
  const { execution, a, target } = worker("remote-worker");
  const generation = "c".repeat(32);
  const owner = {
    ...a,
    runtime_ref: {
      target,
      runtime_machine: "binding",
      machine_id: "remote-worker",
      terminal_ref: "binding/t86",
      agent_name: "agent",
      launch_generation: { run_id: unwrap(formatId("run", 2319)), generation },
    },
  };
  const collector = (out: object) =>
    vi
      .mocked(agentProcessCommand)
      .mockResolvedValueOnce(
        transport(
          `process.stdin.resume().on('end',()=>console.log(${JSON.stringify(JSON.stringify(out))}))`,
        ),
      );
  // sensen C-113#69: the query named the session's completed launch Run.
  // That Run does not hold the session, so the collector was not asked.
  collector(reply);
  const finished = await inspectWorker(
    execution,
    project,
    owner,
    { id: "R-2319", status: "completed" } as Run,
    false,
    "darwin",
  );
  expect(finished).toMatchObject({
    terminals: null,
    processes: null,
    events: null,
    unavailable: {
      terminals: "run_not_current",
      processes: "run_not_current",
      events: "run_not_current",
      last_activity_at: "run_not_current",
    },
  });
  // The unqualified query of the idle Assignment reads the live facts; the
  // collector's own reasons pass through, unknown codes are never echoed.
  collector({
    ...reply,
    processes: null,
    unavailable: {
      terminals: "core_error",
      processes: "process_identity_changed",
      events: "/private/path",
    },
  });
  const idle = await inspectWorker(
    execution,
    project,
    owner,
    undefined,
    true,
    "darwin",
  );
  expect(idle.unavailable).toEqual({
    terminals: "core_error",
    processes: "process_identity_changed",
    events: "other",
    last_activity_at: "other",
  });
  expect(JSON.stringify(idle)).not.toContain("/private/path");
});
test("C-849: an idle remote session lists its launch Run's enrolled CLI and names absent activity", async () => {
  const { execution, a, target } = worker("remote-worker");
  const generation = "d".repeat(32);
  const runtime_ref = {
    target,
    runtime_machine: "binding",
    machine_id: "remote-worker",
    terminal_ref: "binding/t9",
    agent_name: "agent",
    launch_generation: { run_id: unwrap(formatId("run", 6666)), generation },
  };
  const owner = { ...a, runtime_ref };
  const process = {
    machine: target.fingerprint,
    boot: "boot",
    uid: 501,
    pid: 54997,
    start: "start",
    process_group: 54989,
    terminal: generation,
  };
  const launch = {
    id: "R-6666",
    assignment_id: "A-1",
    status: "completed",
    launch_publication: {
      generation,
      target,
      runtime_ref,
      process,
    },
  } as unknown as Run;
  const events = [
    { type: "assistant", time: "2026-11-28T10:49:58Z" },
    { type: "result", time: "2026-11-28T10:50:01Z" },
  ];
  const collect = (expected: unknown) =>
    vi.mocked(agentProcessCommand).mockResolvedValueOnce(
      transport(
        `let s='';process.stdin.on('data',x=>s+=x).on('end',()=>{const p=JSON.parse(s);if(JSON.stringify(p.process)!==${JSON.stringify(JSON.stringify(expected))})process.exit(2);console.log(JSON.stringify(${JSON.stringify(
          {
            ...reply,
            terminals: [
              { address: "t9", state: "live", activity: null, screen: [] },
            ],
            events,
            unavailable: { activity: "activity_not_reported" },
          },
        )}))})`,
      ),
    );
  collect(process);
  const idle = await inspectWorker(
    execution,
    project,
    owner,
    undefined,
    true,
    "darwin",
    "claude-code",
    undefined,
    undefined,
    launch,
  );
  expect(idle.unavailable).toEqual({ activity: "activity_not_reported" });
  expect(idle.last_activity_at).toBe("2026-11-28T10:50:01Z");
  // A receipt of another generation, terminal, Assignment or target is not sent.
  for (const changed of [
    { ...launch, assignment_id: "A-2" },
    { ...launch, id: "R-1" },
    {
      ...launch,
      launch_publication: {
        ...launch.launch_publication,
        process: { ...process, terminal: "e".repeat(32) },
      },
    },
    {
      ...launch,
      launch_publication: {
        ...launch.launch_publication,
        runtime_ref: { ...runtime_ref, terminal_ref: "binding/t8" },
      },
    },
    {
      ...launch,
      launch_publication: {
        ...launch.launch_publication,
        process: { ...process, machine: "f".repeat(64) },
      },
    },
  ] as Run[]) {
    collect(null);
    await inspectWorker(
      execution,
      project,
      owner,
      undefined,
      true,
      "darwin",
      "claude-code",
      undefined,
      undefined,
      changed,
    );
  }
});
test.each(["alive", "exited", "unknown"] as const)(
  "native local: only exact hc evidence is exposed (%s)",
  async (value) => {
    const { a, target } = worker("local");
    const bound = { ...target, generation: "legacy" };
    const ref = {
      machine_id: "local",
      runtime_machine: "local",
      terminal_ref: "t2",
      agent_name: "reviewer",
      target: bound,
    };
    const observe = vi.fn().mockResolvedValue({ ok: true, value });
    const runtime = { observe_retirement: observe } as unknown as Runtime;
    vi.mocked(agentProcessCommand).mockClear();
    const read = inspectWorker(
      { mode: "local", dataDir: "/controller", target: bound },
      project,
      { ...a, runtime_ref: ref },
      undefined,
      true,
      "linux",
      undefined,
      runtime,
    );
    if (value === "unknown")
      await expect(read).rejects.toThrow("local_terminal_unconfirmed");
    else
      expect(await read).toMatchObject({
        terminals: [
          {
            address: "t2",
            state: value === "alive" ? "live" : "finished",
            screen: [],
          },
        ],
        processes: null,
        events: null,
      });
    expect(observe).toHaveBeenCalledWith(ref, {
      project_id: project,
      assignment_id: a.id,
    });
    expect(agentProcessCommand).not.toHaveBeenCalled();
  },
);

test("collector: synthetic hc socket, generation, transcript, truncated command and redaction boundaries", () => {
  execFileSync(
    "/usr/bin/python3",
    [
      "-IB",
      new URL("../test-support/worker-inspection.py", import.meta.url).pathname,
    ],
    { timeout: 10000 },
  );
});

test("service journals before attempting transport; a second instance cannot bypass the limit; target rotation discards results", async () => {
  const store = Store.open({ dbPath: ":memory:" });
  const clock = { now: () => "2026-01-01T00:00:00Z" };
  const { execution } = worker("local");
  const workerExecution = vi
    .fn()
    .mockReturnValueOnce(execution)
    .mockReturnValue({
      ...execution,
      target: { ...execution.target, fingerprint: "new" },
    });
  const options = {
    store,
    clock,
    workerExecution,
    runtime: {} as Runtime,
    snapshot: async () => ({ model: "fixture", agent_cli_version: "fixture" }),
  };
  const first = new HostOpsService(options),
    second = new HostOpsService(options);
  try {
    store.createProject({ id: project });
    const assignment = store.uow.run((tx) => {
      tx.roles.put(project, {
        role_id: "host_ops",
        role_version: 1,
        allowed_tools: HOST_OPS_ROLE_TOOLS,
        capabilities: [],
      });
      const effect = unwrap(
        createHostOpsAssignment(
          loadCommandState(tx, project),
          { kind: "human", project_id: project },
          {},
          { clock, ids: tx.ids },
        ),
      );
      persistEffect(tx, project, effect);
      return effect.data.assignment;
    });
    const token = store.issueToken({
      project_id: project,
      assignment_id: assignment.id,
      role: { role_version: 1, allowed_tools: HOST_OPS_ROLE_TOOLS },
    });
    const context = {
      store,
      identity: unwrap(authenticate(store, token.token)),
      revalidateToken: vi.fn(),
    };
    const p = { machine_id: "local", assignment_id: assignment.id };
    const events = () =>
      store.uow
        .read((tx) => tx.events.listAfter(project, undefined, 0))
        .filter((e) => e.type === "worker_inspection_requested");
    vi.mocked(agentProcessCommand).mockImplementationOnce(async () => {
      expect(events().at(-1)?.payload).toEqual({
        ...p,
        run_id: null,
        status: "admitted",
      });
      return transport(`console.log(JSON.stringify(${JSON.stringify(reply)}))`);
    });
    await expect(first.tools.inspectWorker(context, p)).rejects.toThrow(
      "binding changed",
    );
    await expect(second.tools.inspectWorker(context, p)).rejects.toThrow(
      "rate limited",
    );
    expect(workerExecution).toHaveBeenCalledTimes(2);
    expect(events().map((e) => e.payload)).toEqual(
      ["admitted", "rate_limited"].map((status) => ({
        ...p,
        run_id: null,
        status,
      })),
    );
  } finally {
    await first.close();
    await second.close();
    store.close();
  }
});
