import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Assignment,
  abortDispatch,
  queueRun,
  type Role,
  type Runtime,
  type RuntimeRef,
  runOccupiesSlot,
} from "@cardigan/domain";
import { parseLaunchConfig } from "@cardigan/roles";
import type {
  ExecutionConfig,
  LaunchFile,
  WorkerFileIdentity,
} from "@cardigan/runtime-herdr";
import { Store, writeRole } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { applyCommand } from "./commands.js";
import { launchRun, scrubRunCredentials } from "./launch.js";
import { recoverLaunchPublications } from "./launch-publish.js";

let store: Store,
  dataDir: string,
  now: number,
  failAt: string,
  withdrawn: boolean,
  alive: boolean;
let execution: Extract<ExecutionConfig, { mode: "agent-ssh" }>;
let ref: RuntimeRef | undefined;
const order: string[] = [];
const disk = new Map<string, { phase: string; files: readonly LaunchFile[] }>();
vi.mock("@cardigan/runtime-herdr", async (original) => ({
  ...(await original<object>()),
  workerFiles: vi.fn(
    async (
      _config: unknown,
      identity: WorkerFileIdentity,
      operation: string,
      files: readonly LaunchFile[] = [],
      worktree?: string,
    ) => {
      order.push(operation);
      const current = store.uow.read((tx) =>
        tx.runs.get("fixture", identity.run),
      );
      if (operation === "publish") {
        expect(current?.status).toBe("queued");
        disk.set(identity.generation, { phase: "published", files });
        if (failAt === "publish_ack")
          throw new Error("synthetic lost response");
        if (failAt === "withdraw") withdrawn = true;
      } else if (operation === "commit") {
        expect(current?.status).toBe("dispatched");
        expect(
          store.uow.read((tx) => tx.assignments.get("fixture", "A-1"))
            ?.runtime_ref,
        ).toMatchObject({
          launch_generation: { generation: identity.generation },
        });
        const entry = disk.get(identity.generation);
        if (entry?.phase !== "published") throw new Error("not published");
        entry.phase = "start";
        if (failAt === "start_ack") throw new Error("synthetic lost response");
      } else if (operation === "clear") {
        // The durable host fence and token revocation precede worker cleanup.
        expect(current?.launch_publication?.phase).toBe("stopping");
        expect(
          store.uow
            .run((tx) => tx.tokensForAssignment("fixture", "A-1"))
            .filter((t) => t.id === current?.launch_publication?.token_id)
            .every((t) => t.revoked_at !== null),
        ).toBe(true);
        if (failAt === "clear_fail") throw new Error("synthetic unavailable");
        disk.set(identity.generation, { phase: "revoked", files: [] });
      }
      return {
        version: 1,
        ...identity,
        phase: disk.get(identity.generation)?.phase ?? "empty",
        process: null,
        observed: "unknown",
        ...(worktree ? { worktree } : {}),
      };
    },
  ),
}));
vi.mock("./run-target.js", async (original) => ({
  ...(await original<object>()),
  refreshTargetWait: () => withdrawn,
}));
const clock = { now: () => new Date(now).toISOString() };
const runtime = {
  provision: vi.fn(async (_a, _r, _m, launch) => {
    order.push("provision");
    alive = true;
    ref = {
      machine_id: "worker-a",
      runtime_machine: "fixture-worker",
      terminal_ref: "fixture-worker/t1",
      agent_name: launch.agent_name,
      target: execution.target,
      launch_generation: {
        run_id: launch.labels.run,
        generation: launch.labels.generation,
      },
    } as RuntimeRef;
    if (["provision_ack", "clear_fail"].includes(failAt))
      return {
        ok: false,
        error: { code: "runtime_timeout", message: "synthetic" },
      };
    return { ok: true, value: ref };
  }),
  find_launch: vi.fn(async () => {
    order.push("locate");
    return ref
      ? { ok: true, value: ref }
      : {
          ok: false,
          error: { code: "runtime_not_found", message: "synthetic" },
        };
  }),
  status: vi.fn(async () => ({
    ok: true,
    value: {
      process:
        failAt === "unknown_exit" ? "unknown" : alive ? "alive" : "exited",
      agent: "idle",
      observed_seq: 1,
    },
  })),
  release: vi.fn(async () => {
    order.push("release");
    if (failAt !== "unknown_exit") alive = false;
    return { ok: true, value: undefined };
  }),
} as unknown as Runtime;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "launch-publication-"));
  store = Store.open({ dataDir });
  store.createProject({ id: "fixture", name: "Synthetic worker launch" });
  now = Date.parse("2026-01-01T00:00:00.000Z");
  failAt = "";
  withdrawn = false;
  alive = false;
  ref = undefined;
  disk.clear();
  order.length = 0;
  vi.clearAllMocks();
  execution = {
    mode: "agent-ssh",
    dataDir,
    agentRoot: "/independent-worker",
    gid: 1001,
    machine: "fixture-worker",
    identityFile: "/host-only/key",
    knownHostsFile: "/host-only/known",
    target: {
      project_id: "fixture",
      machine_id: "worker-a",
      session: "fixture",
      generation: "one",
      fingerprint: "b".repeat(64),
    },
    publication: {
      header_max_bytes: 8192,
      file_max_bytes: 1048576,
      batch_max_bytes: 2097152,
      timeout_ms: 2000,
    },
    fileHelper: {
      python: "/usr/bin/python3",
      path: "/opt/worker/worker-files.py",
    },
  };
  store.uow.run((tx) =>
    tx.machines.put("fixture", {
      id: "worker-a",
      label: "Synthetic",
      herdr_machine: "fixture-worker",
      os: "linux",
      arch: "x64",
      tags: [],
      max_assignments: 4,
      status: "online",
      last_seen: clock.now(),
    }),
  );
});
afterEach(async () => {
  store.close();
  await rm(dataDir, { recursive: true, force: true });
});

function fixture(harness: "codex" | "pi" | "claude-code" = "codex") {
  const role: Role = {
    role_id: "pm",
    version: 1,
    display_name: "Fixture",
    kind: "standing",
    harness,
    core_prompt: "Synthetic instructions",
    launch_profile_ref: "fixture",
    allowed_tools: ["whoami", "get_updates", "finish_run"],
    capabilities: [],
    abilities: [],
    worktree: "write",
    required_machine_tags: [],
  };
  const assignment: Assignment = {
    id: "A-1",
    scope: "standing",
    standing_mode: "ops",
    role_id: "pm",
    role_version: 1,
    status: "active",
    runtime_state: "not_provisioned",
    runtime_ref: null,
    machine_id: "worker-a",
    mcp_token_id: "synthetic",
    created_at: clock.now(),
  };
  store.uow.run((tx) => {
    writeRole(tx, "fixture", role, { mode: "add" });
    tx.assignments.put("fixture", assignment);
  });
  const actor = { kind: "human" as const, project_id: "fixture" };
  const run = applyCommand(store, {
    project: "fixture",
    actor,
    clock,
    reduce: (state, who, ports) =>
      queueRun(
        state,
        who,
        {
          assignment_id: assignment.id,
          model: "fixture",
          agent_cli_version: "fixture",
        },
        ports,
      ),
  });
  const host = {
    store,
    runtime,
    execution,
    dataDir,
    clock,
    mcpUrl: "https://mcp.invalid/mcp",
    launch: {
      config: parseLaunchConfig({
        profiles: { fixture: { harness, model: "fixture" } },
      }),
      secrets: {},
    },
  };
  const start = () =>
    launchRun(host, {
      project: "fixture",
      assignment_id: assignment.id,
      actor,
      run,
      reuse_session: true,
      worktree: {
        path: "/independent-worker/worktrees/fixture/A-1",
        base_sha: "a".repeat(40),
        branch: "agent/fixture",
      },
    });
  return {
    run,
    host,
    start,
    latest: () => store.uow.read((tx) => tx.runs.get("fixture", run.id)),
  };
}

test.each(["codex", "pi", "claude-code"] as const)(
  "%s material is generation-private and start follows durable dispatch",
  async (harness) => {
    const f = fixture(harness);
    const launched = await f.start();
    expect(order).toEqual([
      "inspect",
      "publish",
      "provision",
      "status",
      "commit",
    ]);
    expect(f.latest()?.launch_publication).toMatchObject({
      phase: "started",
      sha: "a".repeat(40),
      provision_attempted: true,
    });
    const files =
      disk.get(launched.runtime_ref.launch_generation?.generation ?? "")
        ?.files ?? [];
    const spec = JSON.parse(
      files.find((file) => file.path.endsWith("/launch.json"))?.content ?? "{}",
    );
    expect(
      Object.values(spec.env).some(
        (v) => typeof v === "string" && v.includes("/sessions/"),
      ),
    ).toBe(true);
    expect(files.every((file) => file.path.includes("/generations/"))).toBe(
      true,
    );
    const wrapper =
      files.find((file) => file.path.endsWith("/launch.sh"))?.content ?? "";
    const token = files
      .find((file) => file.path.endsWith("/token"))
      ?.content.trim();
    expect(wrapper).not.toContain(token ?? "missing");
    if (harness === "pi")
      expect(
        JSON.parse(
          files.find((file) => file.path.endsWith("/trust.json"))?.content ??
            "{}",
        ),
      ).toEqual({ "/independent-worker/worktrees/fixture/A-1": true });
  },
);
test.each(["publish_ack", "provision_ack", "start_ack"])(
  "%s does not mean not-written/not-started; revoke and stop exact generation",
  async (failure) => {
    const f = fixture();
    failAt = failure;
    await expect(f.start()).rejects.toThrow("withdrawn");
    expect(f.latest()).toMatchObject({
      status: "cancelled",
      launch_publication: { phase: "exited" },
    });
    expect(
      disk.get(f.latest()?.launch_publication?.generation ?? "")?.phase,
    ).toBe("revoked");
    if (failure === "provision_ack")
      expect(order.indexOf("locate")).toBeGreaterThan(order.indexOf("clear"));
    if (failure !== "publish_ack")
      expect(order.indexOf("release")).toBeGreaterThan(order.indexOf("clear"));
  },
);
test("target withdrawal before start keeps the queued Run and never provisions", async () => {
  const f = fixture();
  failAt = "withdraw";
  await expect(f.start()).rejects.toThrow();
  expect(f.latest()).toMatchObject({
    status: "queued",
    outcome: null,
    launch_publication: { phase: "exited", wait: true },
  });
  expect(order).not.toContain("provision");
});
test("unknown exit survives database restart and recovery only resumes exact-generation cleanup", async () => {
  const f = fixture();
  failAt = "clear_fail";
  await expect(f.start()).rejects.toThrow("unconfirmed");
  expect(f.latest()?.launch_publication?.phase).toBe("stopping");
  expect(runOccupiesSlot(f.latest() ?? f.run)).toBe(true);
  const generation = f.latest()?.launch_publication?.generation;
  store.close();
  store = Store.open({ dataDir });
  now += 600_000;
  failAt = "unknown_exit";
  await recoverLaunchPublications({ ...f.host, store }, "fixture");
  expect(runOccupiesSlot(f.latest() ?? f.run)).toBe(true);
  expect(f.latest()?.launch_publication?.generation).toBe(generation);
  failAt = "";
  await recoverLaunchPublications({ ...f.host, store }, "fixture");
  expect(f.latest()).toMatchObject({
    status: "cancelled",
    launch_publication: { phase: "exited" },
  });
  expect(runtime.provision).toHaveBeenCalledTimes(1);
  expect(order).not.toContain("commit");
});
test("remote generic cleanup refuses an unbound generation instead of touching an Assignment directory", async () => {
  await expect(
    scrubRunCredentials(execution, "fixture", "A-1"),
  ).rejects.toThrow("exact launch generation");
  expect(order).toEqual([]);
});
test("post-start cancellation scrubs the retired generation without revoking a newer credential", async () => {
  const f = fixture();
  await f.start();
  applyCommand(store, {
    project: "fixture",
    actor: { kind: "system", project_id: "fixture" },
    clock,
    reduce: (state, actor, ports) =>
      abortDispatch(
        state,
        actor,
        { run_id: f.run.id, reason: "Synthetic confirmed stop" },
        ports,
      ),
  });
  alive = false;
  const newer = store.uow.run((tx) =>
    tx.issueToken({
      project_id: "fixture",
      assignment_id: "A-1",
      role: { role_version: 1, allowed_tools: ["whoami"] },
    }),
  );
  await recoverLaunchPublications(f.host, "fixture");
  expect(f.latest()?.launch_publication?.phase).toBe("exited");
  expect(
    store.uow
      .run((tx) => tx.tokensForAssignment("fixture", "A-1"))
      .find((t) => t.id === newer.record.id)?.revoked_at,
  ).toBeNull();
});
