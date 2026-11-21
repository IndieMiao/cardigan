import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import * as workerRuntime from "@cardigan/runtime-herdr";
import {
  WorkerPreparationFailure,
  workerFileRequest,
  workerFiles,
  workerGitFailure,
} from "@cardigan/runtime-herdr";
import { beginLaunchAttempt, Store, writeRole } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { applyCommand } from "./commands.js";
import { HostLaunchError } from "./errors.js";
import {
  launchRun,
  RunPreflightDeferred,
  scrubRunCredentials,
} from "./launch.js";
import { recoverLaunchPublications } from "./launch-publish.js";
import { RuntimeTargetError, RuntimeTargets } from "./runtime-targets.js";
import { checkWorkerMcp, WorkerMcpError } from "./worker-mcp.js";

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
vi.mock("./worker-mcp.js", async (original) => ({
  ...(await original<object>()),
  checkWorkerMcp: vi.fn(async () => {
    order.push("mcp");
    if (failAt === "mcp") throw new WorkerMcpError("mcp_auth_failed");
  }),
}));
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
          throw new WorkerPreparationFailure("synthetic lost response");
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
        if (failAt === "start_ack")
          throw new WorkerPreparationFailure("synthetic lost response");
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
    mcp: {
      url: "https://control.example-tailnet.ts.net/mcp",
      timeoutMs: 10000,
    },
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

function preparationCount() {
  return (
    store.database
      .prepare(
        "SELECT SUM(failures) AS failures FROM worker_preparation_health WHERE project_id=? AND machine_id=?",
      )
      .get("fixture", "worker-a")?.failures ?? 0
  );
}

function fixture(
  harness: "codex" | "pi" | "claude-code" = "codex",
  profile = "fixture",
) {
  const role: Role = {
    role_id: "pm",
    version: 1,
    display_name: "Fixture",
    kind: "standing",
    harness,
    core_prompt: "Synthetic instructions",
    launch_profile_ref: profile,
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
        profiles: { [profile]: { harness, model: "fixture" } },
      }),
      secrets: {},
    },
  };
  const start = (retry = false) =>
    launchRun(host, {
      project: "fixture",
      assignment_id: assignment.id,
      actor,
      run,
      reuse_session: true,
      ...(retry ? { retry_target_preflight: true as const } : {}),
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

test.each(["clean", "unconfirmed", "auth"])(
  "authenticated worker preflight only defers a fully withdrawn transient launch: %s",
  async (mode) => {
    const f = fixture();
    if (mode === "unconfirmed") failAt = "clear_fail";
    vi.mocked(checkWorkerMcp).mockRejectedValueOnce(
      new WorkerMcpError(
        mode === "auth" ? "mcp_auth_failed" : "mcp_gateway_error",
      ),
    );
    await expect(f.start(true)).rejects.toBeInstanceOf(
      mode === "clean" ? RunPreflightDeferred : HostLaunchError,
    );
    expect(order).not.toContain("provision");
    expect(f.latest()).toMatchObject({
      status: mode === "auth" ? "cancelled" : "queued",
      launch_publication: {
        phase: mode === "unconfirmed" ? "stopping" : "exited",
      },
    });
    const tokens = store.uow.run((tx) =>
      tx.tokensForAssignment("fixture", "A-1"),
    );
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.revoked_at).not.toBeNull();
    if (mode === "clean") expect((await f.start(true)).run.id).toBe(f.run.id);
  },
);

test.each(["codex", "pi", "claude-code"] as const)(
  "%s material is generation-private and start follows durable dispatch",
  async (harness) => {
    const f = fixture(harness);
    const launched = await f.start();
    expect(order).toEqual([
      "mcp",
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
    expect(
      files.some((file) =>
        file.content.includes(execution.mcp?.url ?? "missing"),
      ),
    ).toBe(true);
    expect(files.some((file) => file.content.includes(f.host.mcpUrl))).toBe(
      false,
    );
    const launchJson =
      files.find((file) => file.path.endsWith("/launch.json"))?.content ?? "";
    const spec = JSON.parse(launchJson);
    const description = runtime.provision.mock.calls.at(-1)?.[3];
    expect(description.command).toBe(execution.fileHelper?.python);
    expect(description.args.at(-1)).toBe(
      createHash("sha256").update(launchJson).digest("hex"),
    );
    expect(description.args).toContain(execution.fileHelper?.path);
    expect(
      Object.values(spec.env).some(
        (v) => typeof v === "string" && v.includes("/sessions/"),
      ),
    ).toBe(true);
    const resource = files.find((file) =>
      file.path.endsWith("/run-command.py"),
    );
    expect(resource?.mode).toBe(0o600);
    expect(spec.env.CARDIGAN_RUN_COMMAND).toContain("hashlib.sha256(b)");
    expect(spec.env.CARDIGAN_RUN_COMMAND).toContain(resource?.path);
    expect(spec.env.CARDIGAN_RESOURCE_SESSION).toMatch(/^A-\d+\.R-\d+$/u);
    expect(files.every((file) => file.path.includes("/generations/"))).toBe(
      true,
    );
    const wrapper =
      files.find((file) => file.path.endsWith("/launch.sh"))?.content ?? "";
    const token = files
      .find((file) => file.path.endsWith("/token"))
      ?.content.trim();
    expect(checkWorkerMcp).toHaveBeenCalledWith(execution, token);
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
test.each(["local size limit", "remote Git refusal"])(
  "attributes %s at the preparation boundary before opening a maintenance task",
  async (scenario) => {
    execution = {
      ...execution,
      preparationCooldown: { failures: 1, duration_ms: 1800000 },
    };
    const f = fixture();
    const remote = scenario === "remote Git refusal";
    const real = await vi.importActual<typeof workerRuntime>(
      "@cardigan/runtime-herdr",
    );
    if (!remote) {
      // Inspect uses the synthetic disk, then publish uses the production encoder.
      const usual = vi.mocked(workerFiles).getMockImplementation();
      if (!usual) throw new Error("Missing synthetic worker");
      vi.mocked(workerFiles)
        .mockImplementationOnce(usual)
        .mockImplementationOnce(real.workerFiles);
    }
    // The host data-directory guard is Linux-specific, not the boundary under test.
    const guard = vi
      .spyOn(workerRuntime, "secureDataDirectory")
      .mockResolvedValueOnce(undefined);
    try {
      await expect(
        launchRun(f.host, {
          project: "fixture",
          assignment_id: "A-1",
          actor: { kind: "human", project_id: "fixture" },
          run: f.run,
          reuse_session: true,
          ...(remote
            ? {
                prepare_worktree: async () => {
                  throw workerGitFailure("prepare", {
                    code: 255,
                    stderr: "Connection refused",
                  });
                },
              }
            : {
                first_prompt: "x".repeat(
                  (execution.publication?.file_max_bytes ?? 0) + 1,
                ),
                worktree: {
                  path: "/independent-worker/worktrees/fixture/A-1",
                  base_sha: "a".repeat(40),
                  branch: "agent/fixture",
                },
              }),
        }),
      ).rejects.toThrow(
        remote
          ? "SSH connection refused"
          : "Worker publication rejected: invalid publication",
      );
      expect(f.latest()?.launch_publication).toMatchObject({
        phase: "exited",
        wait: false,
      });
      expect(preparationCount()).toBe(remote ? 1 : 0);
      const tasks = store.uow.read((tx) => tx.human_actions.list("fixture"));
      expect(tasks).toHaveLength(remote ? 1 : 0);
      if (remote)
        expect(tasks[0]?.instructions).toContain("SSH connection refused");
    } finally {
      guard.mockRestore();
    }
  },
);

test("worktree preparation reports one redacted cause to the dispatcher and to the abort event before any token/provision", async () => {
  const f = fixture();
  const secret = "fixture-only-credential";
  await expect(
    launchRun(
      { ...f.host, launch: { ...f.host.launch, secrets: { CUSTOM: secret } } },
      {
        project: "fixture",
        assignment_id: "A-1",
        actor: { kind: "system", project_id: "fixture" },
        run: f.run,
        reuse_session: true,
        prepare_worktree: async () => {
          throw Object.assign(
            new Error("Command failed: git -c private-argument"),
            {
              stderr: `fatal: lock unavailable ${secret} Authorization: Bearer synthetic-private /private/path\nextra-context`,
            },
          );
        },
      },
    ),
  ).rejects.toThrow(
    /directory preparation: fatal: lock unavailable.*withdrawn/u,
  );
  expect(order).toEqual(["clear", "clear"]);
  const reason = f.latest()?.summary;
  expect(reason).toContain("directory preparation: fatal: lock unavailable");
  expect(reason).not.toMatch(
    /private-argument|synthetic-private|fixture-only-credential|extra-context|\/private\/path/u,
  );
  expect(
    store.uow
      .read((tx) => tx.events.listAfter("fixture", undefined, 0))
      .find((e) => e.type === "run_dispatch_aborted")?.payload.reason,
  ).toBe(reason);
});
test("failed remote MCP check revokes the new token before any material or process is published", async () => {
  const f = fixture();
  failAt = "mcp";
  await expect(f.start()).rejects.toThrow("mcp_auth_failed");
  expect(order).not.toContain("publish");
  expect(order).not.toContain("provision");
  expect(order).not.toContain("commit");
  expect(f.latest()?.status).toBe("cancelled");
  expect(
    store.uow
      .run((tx) => tx.tokensForAssignment("fixture", "A-1"))
      .every((token) => token.revoked_at !== null),
  ).toBe(true);
});

test.each(["provision", "replacement", "cleanup_unknown", "adapter_unknown"])(
  "a system launch settles only the exact router refusal before adapter invocation: %s",
  async (mode) => {
    const f = fixture();
    const previous: RuntimeRef = {
      machine_id: "worker-a",
      terminal_ref: "fixture-worker/old",
      runtime_machine: "fixture-worker",
      agent_name: "old",
      target: execution.target,
    };
    if (mode === "replacement")
      store.uow.run((tx) => {
        const owner = tx.assignments.get("fixture", "A-1");
        if (!owner) throw new Error("Missing owner");
        tx.assignments.put("fixture", { ...owner, runtime_ref: previous });
      });
    store.uow.run(() =>
      beginLaunchAttempt(store.database, {
        id: "dispatch",
        project_id: "fixture",
        assignment_id: f.run.assignment_id,
        run_id: f.run.id,
        started_at: clock.now(),
        lease_until: new Date(now + 60_000).toISOString(),
      }),
    );
    const router: RuntimeTargets = Object.create(RuntimeTargets.prototype);
    const probe = vi
      .spyOn(router, "forLaunch")
      .mockRejectedValue(new RuntimeTargetError("mcp_timeout"));
    // This runtime wrapper already has a durable intent. Only an actual
    // pre-adapter refusal from the router can retract it, never an error code.
    const replace = vi.fn<Runtime["resume_or_replace"]>((ref, launch) =>
      router.resume_or_replace(ref, launch),
    );
    if (mode === "adapter_unknown")
      vi.mocked(runtime.provision).mockResolvedValueOnce({
        ok: false,
        error: {
          code: "invalid_launch",
          message: "Runtime target rejected: mcp_timeout",
        },
      });
    else if (mode !== "replacement")
      vi.mocked(runtime.provision).mockImplementationOnce((...args) =>
        router.provision(...args),
      );
    if (mode === "cleanup_unknown") failAt = "clear_fail";
    const host = {
      ...f.host,
      runtime: { ...runtime, resume_or_replace: replace },
    };
    const start = () =>
      launchRun(host, {
        project: "fixture",
        assignment_id: f.run.assignment_id,
        actor: { kind: "system", project_id: "fixture" },
        run: f.run,
        retry_target_preflight: true,
        worktree: {
          path: "/independent-worker/worktrees/fixture/A-1",
          base_sha: "a".repeat(40),
          branch: "agent/fixture",
        },
        ...(mode === "replacement"
          ? { replacement: { previous, reason: "runtime_not_found" as const } }
          : {}),
      });
    const clean = mode === "provision" || mode === "replacement";
    await expect(start()).rejects.toBeInstanceOf(
      clean ? RunPreflightDeferred : HostLaunchError,
    );
    expect(probe).toHaveBeenCalledTimes(mode === "adapter_unknown" ? 0 : 1);
    expect(replace).toHaveBeenCalledTimes(mode === "replacement" ? 1 : 0);
    expect(order).toContain("publish");
    expect(order).not.toContain("commit");
    expect(f.latest()).toMatchObject({
      status: "queued",
      launch_publication: {
        phase: clean ? "exited" : "stopping",
        provision_attempted: mode === "adapter_unknown",
      },
    });
    expect(runOccupiesSlot(f.latest() ?? f.run)).toBe(!clean);
    const tokens = store.uow.run((tx) =>
      tx.tokensForAssignment("fixture", "A-1"),
    );
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.revoked_at).not.toBeNull();
    if (mode === "adapter_unknown") {
      now += 600_000;
      await expect(recoverLaunchPublications(host, "fixture")).rejects.toThrow(
        "exit_unconfirmed",
      );
      expect(order).toContain("locate");
    } else expect(order).not.toContain("locate");
    if (mode === "provision") {
      expect((await start()).run.id).toBe(f.run.id);
      expect(order.filter((op) => op === "commit")).toHaveLength(1);
    }
  },
);

test.each([
  "ready",
  "disabled",
  "reachability",
  "authentication",
  "revoked_after_auth",
  "revoked_after_provision",
  "last_check_timeout",
] as const)(
  "the real target gate integrates remote launch and authenticated publication: %s",
  async (mode) => {
    execution = {
      ...execution,
      path: "/usr/bin:/bin",
      gitHelper: {
        python: "/usr/bin/python3",
        path: "/opt/worker/worker-git.py",
      },
    };
    const f = fixture();
    let allowed = mode !== "disabled";
    const created = await RuntimeTargets.create({
      store,
      execution: { mode: "local", dataDir },
      workers: () => [
        {
          machine_id: "worker-a",
          project_id: "fixture",
          os: "linux",
          arch: "x64",
          session: "fixture",
          generation: "one",
          allow_remote_launch: allowed,
          execution,
        },
      ],
      workerReadiness: async () => {
        order.push("readiness");
        return [];
      },
      workerMcpReachability: async () => {
        order.push("reachability");
        if (
          mode === "last_check_timeout" &&
          order.includes("publish") &&
          !order.includes("clear")
        ) {
          expect(f.latest()?.launch_publication).toMatchObject({
            phase: "published",
            provision_attempted: false,
          });
          throw new WorkerMcpError("mcp_timeout");
        }
        if (mode === "reachability")
          throw new WorkerMcpError("mcp_unreachable");
      },
      factory: async () => ({
        ok: true,
        value: {
          ...runtime,
          provision: async (...args: Parameters<Runtime["provision"]>) => {
            expect(f.latest()?.launch_publication).toMatchObject({
              phase: "provisioning",
              provision_attempted: true,
            });
            const result = await runtime.provision(...args);
            if (mode === "revoked_after_provision") allowed = false;
            return result;
          },
          captureAgent: async () => ({ ok: true, value: "git version 2.43.0" }),
          probeTerminal: async () => ({
            ok: true,
            value: alive ? "alive" : "exited",
          }),
          async *events() {},
        },
      }),
    });
    if (!created.ok) throw new Error("Invalid runtime fixture");
    f.host.runtime = created.value;
    const resolved = created.value.resolve("fixture", "worker-a").execution;
    if (resolved.mode !== "agent-ssh")
      throw new Error("Invalid target fixture");
    execution = resolved;
    if (mode === "authentication") failAt = "mcp";
    if (mode === "revoked_after_auth")
      vi.mocked(checkWorkerMcp).mockImplementationOnce(async () => {
        order.push("mcp");
        allowed = false;
      });
    if (mode === "last_check_timeout") {
      await expect(f.start(true)).rejects.toBeInstanceOf(RunPreflightDeferred);
      expect(f.latest()).toMatchObject({
        status: "queued",
        launch_publication: { phase: "exited", provision_attempted: false },
      });
      expect(order).not.toContain("provision");
      expect(order).not.toContain("locate");
      expect((await f.start(true)).run.id).toBe(f.run.id);
      expect(order.filter((op) => op === "provision")).toHaveLength(1);
      expect(order.filter((op) => op === "commit")).toHaveLength(1);
    } else if (mode === "ready") {
      const launched = await f.start();
      expect(launched.runtime_ref).toMatchObject({
        machine_id: "worker-a",
        target: execution.target,
      });
      expect(order.indexOf("readiness")).toBeLessThan(order.indexOf("mcp"));
      expect(order.indexOf("reachability")).toBeLessThan(order.indexOf("mcp"));
      expect(order.indexOf("mcp")).toBeLessThan(order.indexOf("publish"));
      expect(order.indexOf("publish")).toBeLessThan(order.indexOf("provision"));
      expect(order.indexOf("provision")).toBeLessThan(order.indexOf("commit"));
    } else {
      await expect(f.start()).rejects.toThrow(
        {
          disabled: "remote_launch_disabled",
          reachability: "mcp_unreachable",
          authentication: "mcp_auth_failed",
          revoked_after_auth: "remote_launch_disabled",
          revoked_after_provision: "remote_launch_disabled",
        }[mode],
      );
      if (mode === "revoked_after_provision") {
        expect(order).toContain("publish");
        expect(order).toContain("provision");
        expect(order).toContain("release");
      } else {
        expect(order).not.toContain("publish");
        expect(order).not.toContain("provision");
      }
      expect(order).not.toContain("commit");
      const tokens = store.uow.run((tx) =>
        tx.tokensForAssignment("fixture", "A-1"),
      );
      expect(tokens).toHaveLength(
        [
          "authentication",
          "revoked_after_auth",
          "revoked_after_provision",
        ].includes(mode)
          ? 1
          : 0,
      );
      expect(tokens.every((t) => t.revoked_at !== null)).toBe(true);
    }
  },
);
test.each(["mcp", "inspect"])(
  "target change during %s refuses publication and revokes the token before cleanup",
  async (phase) => {
    execution = {
      ...execution,
      path: "/usr/bin:/bin",
      gitHelper: {
        python: "/usr/bin/python3",
        path: "/opt/worker/worker-git.py",
      },
    };
    const f = fixture();
    let mcp = execution.mcp;
    const created = await RuntimeTargets.create({
      store,
      execution: { mode: "local", dataDir },
      workers: () => [
        {
          machine_id: "worker-a",
          project_id: "fixture",
          os: "linux",
          arch: "x64",
          session: "fixture",
          generation: "one",
          allow_remote_launch: true,
          execution: { ...execution, ...(mcp ? { mcp } : {}) },
        },
      ],
    });
    if (!created.ok) throw new Error("Missing fixture runtime");
    const targets = created.value;
    // This fixture skips only network probes; publication policy and fingerprint
    // checks remain real. No SSH or actual worker is used here.
    vi.spyOn(targets, "forLaunch").mockImplementation(
      async (project, assignment) =>
        targets.resolve(project, assignment.machine_id),
    );
    f.host.runtime = targets;
    const change = () => {
      mcp = {
        url: "https://changed.example-tailnet.ts.net/mcp",
        timeoutMs: 10000,
      };
    };
    if (phase === "mcp")
      vi.mocked(checkWorkerMcp).mockImplementationOnce(async () => {
        order.push("mcp");
        change();
      });
    else {
      const inspect = vi.mocked(workerFiles).getMockImplementation();
      if (!inspect) throw new Error("Missing worker fixture");
      vi.mocked(workerFiles).mockImplementationOnce(async (...args) => {
        const result = await inspect(...args);
        change();
        return result;
      });
    }
    await expect(f.start()).rejects.toThrow("withdrawn");
    expect(order).not.toContain("publish");
    expect(order).not.toContain("provision");
    expect(order).not.toContain("commit");
    expect(order.filter((operation) => operation === "clear")).toHaveLength(2);
    expect(f.latest()).toMatchObject({
      status: "cancelled",
      launch_publication: { phase: "exited" },
    });
    expect(preparationCount()).toBe(0);
    const tokens = store.uow.run((tx) =>
      tx.tokensForAssignment("fixture", "A-1"),
    );
    expect(tokens).toHaveLength(1);
    expect(tokens.every((token) => token.revoked_at !== null)).toBe(true);
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
    expect(preparationCount()).toBe(1);
    if (failure === "provision_ack")
      expect(order.indexOf("locate")).toBeGreaterThan(order.indexOf("clear"));
    if (failure !== "publish_ack")
      expect(order.indexOf("release")).toBeGreaterThan(order.indexOf("clear"));
  },
);
test("an expired delivery lease withdraws without blaming the worker", async () => {
  const f = fixture();
  vi.mocked(checkWorkerMcp).mockImplementationOnce(async () => {
    const publication = f.latest()?.launch_publication;
    if (!publication) throw new Error("Missing publication");
    now = Date.parse(publication.lease_until);
  });
  await expect(f.start()).rejects.toThrow(
    "Launch target or delivery lease changed",
  );
  expect(f.latest()?.launch_publication).toMatchObject({
    phase: "exited",
    wait: false,
  });
  expect(order).not.toContain("publish");
  expect(preparationCount()).toBe(0);
});
test("target withdrawal before start keeps the queued Run and never provisions", async () => {
  const f = fixture();
  failAt = "withdraw";
  await expect(f.start()).rejects.toThrow();
  expect(f.latest()).toMatchObject({
    status: "queued",
    outcome: null,
    launch_publication: { phase: "exited", wait: true },
  });
  expect(preparationCount()).toBe(0);
  expect(order).not.toContain("provision");
});
test("unknown exit survives database restart and recovery only resumes exact-generation cleanup", async () => {
  const f = fixture();
  failAt = "clear_fail";
  const reason =
    "runtime provision: provision failed: runtime_timeout synthetic";
  await expect(f.start()).rejects.toThrow(`${reason}; exit_unconfirmed`);
  expect(f.latest()?.launch_publication?.failure_reason).toBe(reason);
  expect(f.latest()?.launch_publication?.phase).toBe("stopping");
  expect(preparationCount()).toBe(1);
  expect(runOccupiesSlot(f.latest() ?? f.run)).toBe(true);
  const generation = f.latest()?.launch_publication?.generation;
  store.close();
  store = Store.open({ dataDir });
  now += 600_000;
  failAt = "unknown_exit";
  await expect(
    recoverLaunchPublications({ ...f.host, store }, "fixture"),
  ).rejects.toThrow("exit_unconfirmed");
  expect(preparationCount()).toBe(1);
  expect(runOccupiesSlot(f.latest() ?? f.run)).toBe(true);
  expect(f.latest()?.launch_publication?.generation).toBe(generation);
  failAt = "";
  await recoverLaunchPublications({ ...f.host, store }, "fixture");
  expect(f.latest()).toMatchObject({
    status: "cancelled",
    summary: reason,
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

test("a real dotted Claude profile compiles, encodes and publishes on the independent worker disk", async () => {
  const f = fixture("claude-code", "claude.fixture");
  await f.start();
  const generation = f.latest()?.launch_publication?.generation ?? "";
  const files = disk.get(generation)?.files ?? [];
  expect(
    files.some((file) =>
      file.path.endsWith(
        "cardigan-assignment.claude.fixture.claude-settings.json",
      ),
    ),
  ).toBe(true);
  const packet = workerFileRequest(
    execution,
    {
      project: "fixture",
      assignment: "A-1",
      run: f.run.id,
      generation,
      target: execution.target?.fingerprint ?? "",
    },
    "publish",
    files,
  );
  const root = join(dataDir, "independent-worker");
  await mkdir(root, { mode: 0o700 });
  const receiver = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      `import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location('files',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
p=m.limits(json.loads(sys.argv[3]));h=m.manifest(sys.stdin.buffer,p)
n=m.Namespace(os.open(sys.argv[2],m.DIRECTORY),h,lambda:None)
try: print(json.dumps(m.operate(n,h,sys.stdin.buffer,p)))
finally: n.close()
`,
      resolve("deploy/worker-files.py"),
      root,
      JSON.stringify(execution.publication),
    ],
    { input: packet, encoding: "utf8", timeout: 4000 },
  );
  expect(receiver.status, receiver.stderr).toBe(0);
  expect(JSON.parse(receiver.stdout)).toMatchObject({
    phase: "published",
    generation,
  });
});
test.each(["clear_fail", "token_failure", "journal_failure", "target_failure"])(
  "recovery reports %s with Run/generation/operation while retaining the stop fence",
  async (failure) => {
    const f = fixture();
    failAt = "clear_fail";
    await expect(f.start()).rejects.toThrow();
    now += 600_000;
    const generation = f.latest()?.launch_publication?.generation;
    if (failure === "token_failure") {
      store.database
        .prepare("UPDATE tokens SET revoked_at = NULL WHERE id = ?")
        .run(f.latest()?.launch_publication?.token_id ?? "");
      store.database.exec(
        "CREATE TRIGGER synthetic_token_failure BEFORE UPDATE OF revoked_at ON tokens BEGIN SELECT RAISE(ABORT, 'SYNTHETIC-SECRET /private/path'); END",
      );
    }
    if (failure === "journal_failure") {
      store.database.exec(
        "CREATE TRIGGER synthetic_journal_failure BEFORE UPDATE ON runs WHEN json_extract(NEW.doc, '$.launch_publication.phase') = 'exited' BEGIN SELECT RAISE(ABORT, 'SYNTHETIC-SECRET /private/path'); END",
      );
      failAt = "";
    }
    const target = execution.target;
    if (!target) throw new Error("Synthetic target missing");
    const host =
      failure === "target_failure"
        ? {
            ...f.host,
            execution: {
              ...execution,
              target: { ...target, generation: "changed" },
            },
          }
        : f.host;
    let diagnostic = "";
    try {
      await recoverLaunchPublications(host, "fixture");
    } catch (error) {
      diagnostic = (error as Error).message;
    }
    expect(diagnostic).toContain(f.run.id);
    expect(diagnostic).toContain(generation);
    expect(diagnostic).toContain(
      failure === "target_failure" ? "target_mismatch" : "operation_failed",
    );
    expect(diagnostic).toContain(
      failure === "clear_fail"
        ? "worker_clear"
        : failure === "token_failure"
          ? "revoke_identity"
          : failure === "journal_failure"
            ? "journal"
            : "resolve_target",
    );
    expect(diagnostic).not.toContain("SYNTHETIC-SECRET");
    expect(diagnostic).not.toContain("/private/path");
    expect(f.latest()?.launch_publication?.phase).toBe("stopping");
    expect(preparationCount()).toBe(1);
    expect(runOccupiesSlot(f.latest() ?? f.run)).toBe(true);
    vi.restoreAllMocks();
  },
);
