import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeRef } from "@cardigan/domain";
import { afterAll, beforeEach, expect, test, vi } from "vitest";
import { ownerRefusal, stopDarwinOwner } from "./darwin-idle-owner.js";
import {
  darwinRetirementObservation,
  explainDarwinRefusal,
  stopDarwinTurn,
} from "./darwin-retirement.js";
import type { ExecutionConfig } from "./execution.js";
import { HC_RELEASE } from "./hc-version.js";
import { HerdrRuntime } from "./index.js";
import { value } from "./test-support.js";

// The real adapter; only the two worker transports are substituted.
vi.mock("./darwin-retirement.js", () => ({
  darwinRetirementObservation: vi.fn(),
  explainDarwinRefusal: vi.fn(),
  stopDarwinTurn: vi.fn(),
}));
vi.mock("./darwin-idle-owner.js", async (original) => ({
  ...(await original<typeof import("./darwin-idle-owner.js")>()),
  stopDarwinOwner: vi.fn(),
}));

const dir = mkdtempSync(join(realpathSync(tmpdir()), "darwin-turn-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const target = {
  project_id: "fixture",
  machine_id: "mac",
  session: "fixture",
  generation: "binding",
  fingerprint: "f".repeat(64),
};
const execution: Extract<ExecutionConfig, { mode: "agent-ssh" }> = {
  mode: "agent-ssh",
  machine: "mac",
  dataDir: dir,
  agentRoot: "/worker",
  gid: 42,
  user: "worker",
  identityFile: join(dir, "id"),
  knownHostsFile: join(dir, "hosts"),
  target,
  macosCore: { python: "/usr/bin/python3", retiredLaunchdLabel: "fixture" },
  fileHelper: {
    python: "/usr/bin/python3",
    path: "/installed/worker-files.py",
  },
};
for (const file of [execution.identityFile, execution.knownHostsFile])
  writeFileSync(file, "fixture only", { mode: 0o600 });
const ref: RuntimeRef = {
  machine_id: "mac",
  runtime_machine: "mac",
  terminal_ref: "mac/t1",
  agent_name: "coder-fixture",
  target,
  launch_generation: { run_id: "R-1" as never, generation: "g1" },
};
const receipt = {
  machine: target.fingerprint,
  terminal: "g1",
  pid: 4242,
  uid: 501,
  process_group: 4242,
  boot: "boot",
  start: "1",
};
let screen = "";
/** C-849: per-test changes to the hc terminal record. */
let terminal: Record<string, unknown> = {};
async function runtime() {
  return value(
    await HerdrRuntime.create({
      session: target.session,
      execution,
      socketPath: join(dir, "relay.sock"),
      client: {
        available: async () => true,
        async *lines() {},
        exec: async (args) => {
          if (args[0] === "--version") return `hc ${HC_RELEASE.version}`;
          if (args[0] === "machine")
            return JSON.stringify(
              args[1] === "ls"
                ? { machines: [] }
                : { version: HC_RELEASE.version },
            );
          if (args[0] === "get")
            return JSON.stringify({
              address: ref.terminal_ref,
              state: "live",
              created_ms: 1,
              labels: {
                project: "fixture",
                assignment: "A-1",
                run: "R-1",
                generation: "g1",
              },
              status: { state: "unknown" },
              foreground: { name: "claude", pid: receipt.pid },
              ...terminal,
            });
          if (args[0] === "read") return screen;
          throw new Error(`unexpected hc call ${args[0]}`);
        },
      },
    }),
  );
}
const idle = "──────\n❯\n──────\n? for shortcuts";
const busy = "✻ Working… (esc to interrupt)\n❯\n? for shortcuts";
const prompt = {
  project_id: "fixture",
  assignment_id: "A-1",
  harness: "claude-code" as const,
};
const options = (guard = vi.fn(() => true)) => ({
  project_id: "fixture",
  assignment_id: "A-1",
  enrolled_process: receipt,
  hangup_ms: 1,
  terminate_ms: 50,
  system_finished_turn: true as const,
  idle_prompt: prompt,
  workspace_preflight: vi.fn(async () => true),
  before_signal: guard,
});
const observe = vi.mocked(darwinRetirementObservation);
const owner = vi.mocked(stopDarwinOwner);
const pid = vi.mocked(stopDarwinTurn);
beforeEach(() => {
  vi.clearAllMocks();
  screen = idle;
  terminal = {};
  // Strict worker proof cannot confirm (hc has no activity); the opted-in
  // proof can, until the CLI exits after a TERM.
  let exited = false;
  observe.mockImplementation(async (_e, _r, o) =>
    exited ? "exited" : o.unknown_activity ? "alive" : "unknown",
  );
  pid.mockImplementation(async (_e, _r, _o, guard) => {
    if (!guard()) return { sent: false, reason: "guard_changed" };
    exited = true;
    return { sent: true, pid: receipt.pid };
  });
  owner.mockResolvedValue({
    outcome: "withdrawn",
    evidence: { stage: "probe", reason: "probe_invalid" },
  });
});

test("C-626 macOS: no activity plus the bound empty editor confirms the live owner", async () => {
  const r = await runtime();
  const identity = {
    project_id: "fixture",
    assignment_id: "A-1",
    enrolled_process: receipt,
    system_finished_turn: true as const,
  };
  expect(value(await r.observe_retirement(ref, identity))).toBe("unknown");
  expect(
    value(
      await r.observe_retirement(ref, { ...identity, idle_prompt: prompt }),
    ),
  ).toBe("alive");
  screen = busy;
  expect(
    value(
      await r.observe_retirement(ref, { ...identity, idle_prompt: prompt }),
    ),
  ).toBe("unknown");
  // The opt-in never reaches the worker without the bound editor read first.
  expect(
    observe.mock.calls.filter(([, , o]) => o.unknown_activity),
  ).toHaveLength(1);
});

test("C-626 macOS: an owner that cannot serve the turn falls back to one TERM of the enrolled PID", async () => {
  const r = await runtime();
  const guard = vi.fn(() => true);
  const stopped = value(await r.retire_idle(ref, options(guard)));
  expect(stopped).toEqual({
    outcome: "exited",
    stop: { path: "darwin_pid", signal: "TERM", pid: receipt.pid },
  });
  expect(owner).toHaveBeenCalledOnce();
  expect(pid).toHaveBeenCalledOnce();
  expect(pid.mock.calls[0]?.[2]).toMatchObject({
    enrolled_process: receipt,
    system_finished_turn: true,
    unknown_activity: true,
  });
  expect(guard).toHaveBeenCalledOnce();
});

test("C-626 macOS: the enrolled idle owner is used first", async () => {
  const r = await runtime();
  let exited = false;
  observe.mockImplementation(async (_e, _r, o) =>
    exited ? "exited" : o.unknown_activity ? "alive" : "unknown",
  );
  owner.mockImplementation(async (_e, _r, o) => {
    if (!o.before_signal()) throw new Error("guard");
    exited = true;
    return {
      outcome: "uncertain",
      evidence: { stage: "confirm", reason: "confirmation_pending" },
    };
  });
  expect(value(await r.retire_idle(ref, options()))).toEqual({
    outcome: "exited",
    stop: { path: "darwin_idle_owner", signal: "TERM", pid: receipt.pid },
  });
  expect(pid).not.toHaveBeenCalled();
});

test.each(["busy", "guard", "dirty", "refused", "owner_guard"])(
  "C-626 macOS: %s never signals",
  async (mode) => {
    const r = await runtime();
    const guard = vi.fn(() => mode !== "guard");
    if (mode === "busy") screen = busy;
    if (mode === "owner_guard")
      owner.mockResolvedValue({
        outcome: "withdrawn",
        evidence: { stage: "probe", reason: "guard_changed" },
      });
    if (mode === "refused")
      pid.mockResolvedValue({ sent: false, reason: "refused" });
    const o = options(guard);
    if (mode === "dirty") o.workspace_preflight.mockResolvedValue(false);
    const stopped = value(await r.retire_idle(ref, o));
    expect(stopped).toMatchObject({
      outcome: "withdrawn",
      evidence: {
        reason:
          mode === "busy"
            ? "prompt_not_idle"
            : mode === "refused"
              ? "terminal_busy"
              : "guard_changed",
      },
    });
    expect(stopped).not.toHaveProperty("stop");
    if (mode === "busy" || mode === "dirty") {
      expect(owner).not.toHaveBeenCalled();
      expect(pid).not.toHaveBeenCalled();
    }
    if (mode === "owner_guard") expect(pid).not.toHaveBeenCalled();
  },
);

test("C-626 macOS: a TERM that is not followed by exit keeps the fence for observation", async () => {
  const r = await runtime();
  observe.mockImplementation(async (_e, _r, o) =>
    o.unknown_activity ? "alive" : "unknown",
  );
  pid.mockResolvedValue({ sent: "unknown" });
  expect(value(await r.retire_idle(ref, options()))).toMatchObject({
    outcome: "uncertain",
    evidence: {
      reason: "confirmation_pending",
      stop: { path: "darwin_pid", signal: "TERM", pid: receipt.pid },
    },
  });
  expect(pid).toHaveBeenCalledOnce();
});

test("C-746 macOS: an owner's anonymous refusal of an idle retirement is explained from the worker, never signalled", async () => {
  const r = await runtime();
  const explain = vi.mocked(explainDarwinRefusal);
  const idleOptions = () => {
    const { system_finished_turn: _t, idle_prompt: _p, ...rest } = options();
    return rest;
  };
  observe.mockResolvedValue("alive");
  const anonymous = {
    outcome: "withdrawn" as const,
    evidence: {
      stage: "probe" as const,
      reason: "probe_invalid" as const,
      owner_reason: "no_reply",
      exit_code: 1,
    },
  };
  owner.mockResolvedValue(anonymous);
  explain.mockResolvedValue("terminal_not_idle");
  // sensen A-252: the owner (enrolled before C-746) closed without a word.
  expect(value(await r.retire_idle(ref, idleOptions()))).toEqual({
    outcome: "withdrawn",
    evidence: {
      stage: "probe",
      reason: "terminal_busy",
      owner_reason: "terminal_not_idle",
      owner_reason_source: "worker_probe",
      exit_code: 1,
    },
  });
  expect(explain).toHaveBeenCalledOnce();
  expect(explain.mock.calls[0]?.[2]).toMatchObject({
    enrolled_process: receipt,
  });
  // Every current proof passes: the owner refused by its older rule.
  explain.mockResolvedValue(null);
  expect(value(await r.retire_idle(ref, idleOptions()))).toEqual({
    outcome: "withdrawn",
    evidence: {
      ...anonymous.evidence,
      owner_reason: "legacy_owner_refused",
      owner_reason_source: "worker_probe",
    },
  });
  // The explanation itself could not be read: nothing more is claimed.
  explain.mockResolvedValue(undefined);
  expect(value(await r.retire_idle(ref, idleOptions()))).toEqual(anonymous);
  // A named refusal needs no explanation.
  explain.mockClear();
  owner.mockResolvedValue(ownerRefusal("worktree_dirty"));
  expect(value(await r.retire_idle(ref, idleOptions()))).toEqual(
    ownerRefusal("worktree_dirty"),
  );
  expect(explain).not.toHaveBeenCalled();
  // An owner that answered (named or not) is never bypassed by a PID signal.
  expect(pid).not.toHaveBeenCalled();
});

const idleOptions = (guard = vi.fn(() => true)) => {
  const {
    system_finished_turn: _t,
    idle_prompt: _p,
    workspace_preflight: _w,
    ...rest
  } = options(guard);
  return rest;
};
/** sensen A-657: launched before enrollment, nothing listens (C-804 facts). */
const unenrolled = {
  outcome: "withdrawn" as const,
  evidence: {
    stage: "probe" as const,
    reason: "conditional_close_unavailable" as const,
    precondition: "owner_not_listening",
    enrollment: "unrecorded",
    exit_code: 3,
  },
};

test("C-849 macOS: an idle session no owner can be asked is proved read-only, then one TERM of the enrolled PID", async () => {
  const r = await runtime();
  const explain = vi.mocked(explainDarwinRefusal);
  owner.mockResolvedValue(unenrolled);
  explain.mockResolvedValue(null);
  const guard = vi.fn(() => true);
  expect(value(await r.retire_idle(ref, idleOptions(guard)))).toEqual({
    outcome: "exited",
    stop: { path: "darwin_pid", signal: "TERM", pid: receipt.pid },
  });
  expect(explain).toHaveBeenCalledOnce();
  expect(explain.mock.calls[0]?.[2]).toEqual({
    project_id: "fixture",
    assignment_id: "A-1",
    enrolled_process: receipt,
  });
  // The worker requires an idle terminal; no unknown-activity opt-in.
  expect(pid).toHaveBeenCalledOnce();
  expect(pid.mock.calls[0]?.[2]).toEqual({
    project_id: "fixture",
    assignment_id: "A-1",
    enrolled_process: receipt,
    system_finished_turn: true,
  });
  expect(guard).toHaveBeenCalledOnce();
});

test.each([
  ["dirty", "worktree_dirty"],
  ["busy", "terminal_not_idle"],
  ["unread", undefined],
  ["refused", null],
  ["guard", null],
] as const)(
  "C-849 macOS: an idle session no owner can be asked is kept when %s",
  async (mode, proof) => {
    const r = await runtime();
    owner.mockResolvedValue(unenrolled);
    vi.mocked(explainDarwinRefusal).mockResolvedValue(proof);
    if (mode === "refused")
      pid.mockResolvedValue({ sent: false, reason: "refused" });
    const guard = vi.fn(() => mode !== "guard");
    const kept = value(await r.retire_idle(ref, idleOptions(guard)));
    const expected = {
      dirty: {
        ...unenrolled.evidence,
        ...ownerRefusal("worktree_dirty").evidence,
        owner_reason_source: "worker_probe",
      },
      busy: {
        ...unenrolled.evidence,
        ...ownerRefusal("terminal_not_idle").evidence,
        owner_reason_source: "worker_probe",
      },
      // Nothing could be read: the owner's precondition stays as it was.
      unread: unenrolled.evidence,
      refused: {
        ...unenrolled.evidence,
        stage: "TERM",
        reason: "terminal_busy",
      },
      guard: { ...unenrolled.evidence, stage: "TERM", reason: "guard_changed" },
    }[mode];
    expect(kept).toEqual({ outcome: "withdrawn", evidence: expected });
    if (mode !== "refused" && mode !== "guard")
      expect(pid).not.toHaveBeenCalled();
  },
);

test("C-849 macOS: an idle session TERM not followed by exit keeps the fence for observation", async () => {
  const r = await runtime();
  owner.mockResolvedValue(unenrolled);
  vi.mocked(explainDarwinRefusal).mockResolvedValue(null);
  observe.mockResolvedValue("unknown");
  pid.mockResolvedValue({ sent: "unknown" });
  expect(value(await r.retire_idle(ref, idleOptions()))).toEqual({
    outcome: "uncertain",
    evidence: {
      stage: "confirm",
      reason: "confirmation_pending",
      stop: { path: "darwin_pid", signal: "TERM", pid: receipt.pid },
    },
  });
});

test.each([
  // hc reports the idle owner (the terminal's program), not claude (C-690).
  [
    "owner in the foreground",
    { pid: 4100, foreground: { name: "Python", pid: 4100 }, keep: false },
    true,
  ],
  [
    "launcher exec'd the CLI",
    { pid: 4242, foreground: { name: "2.1.0", pid: 4242 }, keep: false },
    true,
  ],
  [
    "kept terminal",
    { pid: 4100, foreground: { name: "Python", pid: 4100 }, keep: true },
    false,
  ],
  [
    "keep not reported",
    { pid: 4100, foreground: { name: "Python", pid: 4100 } },
    false,
  ],
  [
    "another process group in the foreground",
    { pid: 4100, foreground: { name: "vim", pid: 4300 }, keep: false },
    false,
  ],
  [
    "no terminal pid",
    { foreground: { name: "Python", pid: 4100 }, keep: false },
    false,
  ],
] as const)(
  "C-849 macOS: bound empty editor with %s",
  async (_label, record, shown) => {
    const r = await runtime();
    terminal = record;
    expect(value(await r.observe_prompt(ref, prompt))).toBe(shown);
    // A turn on screen is never idle, whoever holds the foreground.
    screen = busy;
    expect(value(await r.observe_prompt(ref, prompt))).toBe(false);
  },
);

test("C-746 macOS: a system-ended turn keeps its bounded PID fallback when the owner names its refusal", async () => {
  const r = await runtime();
  // Before C-746 this refusal was anonymous (probe_invalid) and fell back.
  owner.mockResolvedValue(ownerRefusal("terminal_not_idle"));
  const guard = vi.fn(() => true);
  expect(value(await r.retire_idle(ref, options(guard)))).toMatchObject({
    outcome: "exited",
  });
  expect(pid).toHaveBeenCalledOnce();
});
