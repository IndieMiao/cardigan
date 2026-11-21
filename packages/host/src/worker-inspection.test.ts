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
test("unreachable SSH, malformed, secret-bearing and oversized responses have only the fixed error", async () => {
  const { execution, a } = worker("remote");
  for (const code of [
    "console.error('private credential');process.exit(9)",
    `console.log(JSON.stringify(${JSON.stringify({ ...reply, events: [{ time: "private credential", type: "private" }] })}))`,
    `console.log('x'.repeat(40000))`,
  ]) {
    vi.mocked(agentProcessCommand).mockResolvedValueOnce(transport(code));
    await expect(
      inspectWorker(execution, project, a, undefined, true, "linux"),
    ).rejects.toThrow(
      /^Worker unreachable or read-only diagnostics unavailable$/u,
    );
  }
});
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
