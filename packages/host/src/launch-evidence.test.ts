import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CommandState, Run, RuntimeRef } from "@cardigan/domain";
import {
  agentProcessCommand,
  type ExecutionConfig,
} from "@cardigan/runtime-herdr";
import { expect, test, vi } from "vitest";
import { collectLaunchEvidence, redactLaunchText } from "./launch-evidence.js";
import { inspectWorker } from "./worker-inspection.js";

vi.mock("@cardigan/runtime-herdr", async (original) => ({
  ...(await original<typeof import("@cardigan/runtime-herdr")>()),
  agentProcessCommand: vi.fn(),
}));

// C-806: a synthetic failed launch. Neither the token nor a credential path
// may reach the stored evidence, on the local machine or a remote worker.
const project = "fixture";
const TOKEN = `cdg_${"Zx9".repeat(14)}`;
const RUN_DIR = "/worker/runs/fixture/A-1";
const dispatched = "2026-01-01T00:00:00.000Z";
const now = "2026-01-01T00:03:00.500Z";

function scene(machine: "local" | "remote-worker") {
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
  const generation =
    machine === "local"
      ? "cad0f00d-aaaa-4bbb-8000-aaaaaaaaaaaa"
      : "b".repeat(32);
  const ref: RuntimeRef = {
    machine_id: machine,
    runtime_machine: "binding",
    terminal_ref: "binding/t2",
    agent_name: "fixture",
    target,
    launch_generation: { run_id: "R-1", generation },
  } as RuntimeRef;
  const run = {
    id: "R-1",
    assignment_id: "A-1",
    status: "dispatched",
    harness: "claude-code",
    trigger_event_id: "0".repeat(26),
  } as unknown as Run;
  const state = {
    project_id: project,
    machines: [{ id: machine, os: "linux" }],
    assignments: [
      {
        id: "A-1",
        scope: "standing",
        machine_id: machine,
        runtime_ref: ref,
        mcp_handshake: "missing",
      },
    ],
    runs: [run],
    events: [
      {
        id: "1".repeat(26),
        seq: 1,
        type: "run_dispatched",
        payload: { run_id: "R-1", assignment_id: "A-1" },
        created_at: dispatched,
      },
    ],
    cards: [],
    work_items: [],
  } as unknown as CommandState;
  return { execution, state };
}

const sha = createHash("sha256")
  .update(
    readFileSync(new URL("../../../deploy/worker-files.py", import.meta.url)),
  )
  .digest("hex");
const reply = {
  free_bytes: 1000,
  helpers: [sha, null, null],
  processes: [],
  terminals: [],
  markers: null,
  events: null,
  // A collector that (wrongly) let a credential through is redacted again.
  launch: {
    terminal: {
      state: "live",
      tail: [
        `cardigan: token file is missing: ${RUN_DIR}/token`,
        `Authorization: Bearer ${TOKEN}`,
        `. ${RUN_DIR}/secrets.env`,
        "Waiting for MCP servers…",
      ],
      resources: {
        source: "scope",
        cpu_ms: 812,
        memory_bytes: 110_100_480,
        elapsed_ms: 182_000,
      },
    },
    mcp: [
      {
        name: "card",
        status: "failed",
        error: `HTTP Connection failed: ECONNREFUSED MCP_TOKEN=${TOKEN}`,
      },
      {
        name: "playwright",
        status: "connected",
        transport: "stdio",
        elapsed_ms: 812,
      },
    ],
    unavailable: {},
  },
};
const transport = (code: string) => ({
  file: process.execPath,
  args: ["-e", code],
});
const options = (s: ReturnType<typeof scene>) => ({
  store: {} as never,
  loadState: () => s.state,
  workerExecution: () => s.execution,
  now: () => now,
});

test.each(["local", "remote-worker"] as const)(
  "%s: the failed launch's exit, terminal tail, MCP results and resources reach the evidence, redacted",
  async (machine) => {
    const s = scene(machine);
    vi.mocked(agentProcessCommand).mockResolvedValueOnce(
      transport(`console.log(JSON.stringify(${JSON.stringify(reply)}))`),
    );
    const evidence = await collectLaunchEvidence(
      options(s),
      project,
      "R-1" as Run["id"],
      "mcp_unavailable",
    );
    expect(evidence).toEqual({
      reason: "mcp_unavailable",
      machine_id: machine,
      harness: "claude-code",
      waited_ms: 180_500,
      card_handshake: "missing",
      terminal: {
        state: "live",
        tail: [
          "cardigan: token file is missing: [PATH]",
          "[REDACTED]",
          ". [PATH]",
          "Waiting for MCP servers…",
        ],
        resources: reply.launch.terminal.resources,
      },
      mcp_servers: [
        {
          name: "card",
          status: "failed",
          error: "HTTP Connection failed: ECONNREFUSED MCP_TOKEN=[REDACTED]",
        },
        reply.launch.mcp[1],
      ],
      unavailable: {},
    });
    const text = JSON.stringify(evidence);
    for (const leaked of [TOKEN, RUN_DIR, "secrets.env", "/private/"])
      expect(text).not.toContain(leaked);
  },
);

test("the collector is asked for launch facts since dispatch, and only the worker account runs it", async () => {
  const s = scene("remote-worker");
  vi.mocked(agentProcessCommand).mockImplementationOnce(async () =>
    transport(
      `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const p=JSON.parse(d); if(p.launch?.since_ms!==${Date.parse(dispatched)}||p.harness!=='claude-code'||p.launch_run!=='R-1'||d.includes('/private/'))process.exit(3);console.log(JSON.stringify(${JSON.stringify(reply)}))})`,
    ),
  );
  const evidence = await collectLaunchEvidence(
    options(s),
    project,
    "R-1" as Run["id"],
    "dispatch_timeout",
  );
  expect(evidence?.unavailable).toEqual({});
  expect(vi.mocked(agentProcessCommand).mock.calls.at(-1)?.[0]).toBe(
    s.execution,
  );
});

test.each([
  ["process.exit(255)", "ssh_connection_failed"],
  ["process.exit(9)", "collector_exit_9"],
])(
  "an unreachable worker still records the host facts and names why (%s)",
  async (code, reason) => {
    const s = scene("remote-worker");
    vi.mocked(agentProcessCommand).mockResolvedValueOnce(transport(code));
    expect(
      await collectLaunchEvidence(
        options(s),
        project,
        "R-1" as Run["id"],
        "mcp_unavailable",
      ),
    ).toMatchObject({
      reason: "mcp_unavailable",
      card_handshake: "missing",
      waited_ms: 180_500,
      terminal: null,
      mcp_servers: null,
      unavailable: { terminal: reason, mcp: reason },
    });
  },
);

test("a started Run or one with recorded evidence is not collected again", async () => {
  const s = scene("local");
  vi.mocked(agentProcessCommand).mockClear();
  const started = {
    ...s.state,
    runs: [{ ...s.state.runs[0], started_at: dispatched }],
  } as CommandState;
  const recorded = {
    ...s.state,
    events: [
      ...s.state.events,
      { type: "run_launch_evidence", payload: { run_id: "R-1" } },
    ],
  } as CommandState;
  for (const state of [started, recorded])
    expect(
      await collectLaunchEvidence(
        { ...options(s), loadState: () => state },
        project,
        "R-1" as Run["id"],
        "mcp_unavailable",
      ),
    ).toBeUndefined();
  expect(agentProcessCommand).not.toHaveBeenCalled();
});

test("host redaction matches the worker's rules", () => {
  const cases: [string, string][] = [
    [`Authorization: Bearer ${TOKEN}`, "[REDACTED]"],
    [
      `MCP_TOKEN=${TOKEN} api_key: "hunter2"`,
      "MCP_TOKEN=[REDACTED] api_key: [REDACTED]",
    ],
    [`ssh -i ~/.ssh/id_ed25519 host`, "ssh -i [PATH] host"],
    [`X-Cardigan-Session ${"aB3".repeat(8)}`, "X-Cardigan-Session [REDACTED]"],
    ["https://user:pw@example.invalid/x", "[URL]"],
    ["https://example.invalid/mcp?sig=abc", "https://example.invalid/mcp"],
    [
      "-----BEGIN OPENSSH PRIVATE KEY----- abc -----END OPENSSH PRIVATE KEY-----",
      "[REDACTED]",
    ],
    [
      'Error: MCP server "card" connection failed: ECONNREFUSED 127.0.0.1:3004',
      'Error: MCP server "card" connection failed: ECONNREFUSED 127.0.0.1:3004',
    ],
    ["\u001b[31mred", "[31mred"],
  ];
  for (const [input, output] of cases)
    expect(redactLaunchText(input, 200)).toBe(output);
  expect(redactLaunchText("ab ".repeat(200), 200)).toHaveLength(200);
});

test("host_ops inspection carries launch evidence only when asked for a failed launch", async () => {
  const s = scene("remote-worker");
  const a = s.state.assignments[0] as Parameters<typeof inspectWorker>[2];
  const run = s.state.runs[0];
  for (const launch of [undefined, { since: dispatched }]) {
    vi.mocked(agentProcessCommand).mockResolvedValueOnce(
      transport(
        `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const p=JSON.parse(d); if(${launch ? `p.launch?.since_ms!==${Date.parse(dispatched)}` : "p.launch!==null"})process.exit(3);console.log(JSON.stringify(${JSON.stringify(reply)}))})`,
      ),
    );
    const result = await inspectWorker(
      s.execution,
      project,
      a,
      run,
      true,
      "linux",
      "claude-code",
      undefined,
      launch,
    );
    if (!launch) expect(result).not.toHaveProperty("launch");
    else {
      expect(result).toHaveProperty("launch.mcp.0.status", "failed");
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
  }
});
