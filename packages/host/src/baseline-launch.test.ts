import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Assignment,
  Card,
  Role,
  Runtime,
  WorkItem,
} from "@cardigan/domain";
import { queueRun, updateCard } from "@cardigan/domain";
import { CentralRepositoryService } from "@cardigan/git-service";
import { CentralGitTransport } from "@cardigan/git-transport";
import { parseLaunchConfig, START_FILE_NAME } from "@cardigan/roles";
import { type AgentExecution, executionPaths } from "@cardigan/runtime-herdr";
import { Store, writeRole } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { AgentGitTransport } from "./agent-git.js";
import { applyCommand } from "./commands.js";
import { launchRun } from "./launch.js";
import { RuntimeTargets } from "./runtime-targets.js";
import type { RuntimeWorker } from "./runtime-workers-config.js";
import { prepareRoleWorktree, worktreeBaselinePrompt } from "./worktree.js";

const original = "a".repeat(40),
  head = "b".repeat(40),
  latest = "c".repeat(40);
const project = "baseline";
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cg-baseline-"));
  const dataDir = join(root, "data"),
    agentRoot = join(root, "agent");
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(agentRoot, { mode: 0o2750 });
  await chmod(agentRoot, 0o2750);
  const central = join(dataDir, "central.git");
  await mkdir(central);
  const execution: AgentExecution = {
    mode: "agent-ssh",
    dataDir,
    agentRoot,
    gid: process.getgid?.() ?? 0,
    machine: "fixture",
    identityFile: join(root, "key"),
    knownHostsFile: join(root, "known_hosts"),
  };
  for (const path of [execution.identityFile, execution.knownHostsFile])
    await writeFile(path, "fixture", { mode: 0o600 });
  const path = join(agentRoot, "worktrees", project, "A-1");
  const branch = "agent/C-1/W-1";
  const clock = { now: () => "2026-01-01T00:00:00.000Z" };
  const assignment = {
    id: "A-1",
    scope: "work_item",
    work_item_id: "W-1",
    role_id: "coder",
    role_version: 1,
    status: "active",
    runtime_state: "idle",
    runtime_ref: null,
    machine_id: "local",
    mcp_token_id: "fixture",
    created_at: clock.now(),
    worktree_path: path,
    branch,
    base_sha: original,
  } as Assignment;
  const role: Role = {
    role_id: "coder",
    version: 1,
    display_name: "Coder",
    kind: "work",
    harness: "codex",
    core_prompt: "Fixture",
    launch_profile_ref: "fixture",
    allowed_tools: ["whoami", "finish_run"],
    capabilities: [],
    abilities: [],
    worktree: "write",
    required_machine_tags: [],
  };
  const store = Store.open({ dataDir });
  store.createProject({ id: project, name: "Baseline" });
  store.setProjectRepo({
    project_id: project,
    repo_path: central,
    base_branch: "main",
  });
  store.uow.run((tx) => {
    writeRole(tx, project, role, { mode: "add" });
    tx.cards.put(project, {
      id: "C-1",
      project_id: project,
      title: "Baseline",
      goal: "Refresh",
      acceptance_criteria: ["Refresh"],
      source: { kind: "quote", text: "Fixture" },
      repo: central,
      base_branch: "main",
      status: "in_progress",
      priority: 0,
      template: "dev",
      merge_policy: "confirm",
      out_of_scope: [],
      related_cards: [],
      created_by: "human",
      created_at: clock.now(),
    } as Card);
    tx.work_items.put(project, {
      id: "W-1",
      card_id: "C-1",
      title: "Implement",
      kind: "produce",
      role_id: "coder",
      required: true,
      depends_on: [],
      completion_criteria: [],
      status: "changes_requested",
      assignment_id: assignment.id,
    } as WorkItem);
    tx.assignments.put(project, assignment);
  });
  vi.spyOn(
    CentralRepositoryService.prototype,
    "ensureCentral",
  ).mockResolvedValue(central);
  vi.spyOn(AgentGitTransport.prototype, "ensureClone").mockImplementation(
    async (_, repository) => {
      await mkdir(repository, { recursive: true });
      await chmod(repository, 0o2770);
    },
  );
  vi.spyOn(AgentGitTransport.prototype, "listWorktrees").mockResolvedValue([
    { path, branch, head },
  ]);
  vi.spyOn(AgentGitTransport.prototype, "resolveCommit").mockResolvedValue(
    latest,
  );
  const push = vi
    .spyOn(CentralGitTransport.prototype, "pushBaseline")
    .mockResolvedValue(undefined);
  const provision = vi.fn(async () => {
    expect(push).toHaveBeenCalled();
    return {
      ok: true,
      value: {
        machine_id: "local",
        runtime_machine: "fixture",
        terminal_ref: "fixture",
        agent_name: "fixture",
      },
    };
  });
  const runtime = { provision, release: vi.fn() } as unknown as Runtime;
  const host = {
    store,
    dataDir,
    execution,
    runtime,
    clock,
    mcpUrl: "http://localhost/mcp",
    launch: {
      config: parseLaunchConfig({
        profiles: {
          fixture: {
            harness: "codex",
            model: "fixture",
            config: { model_reasoning_effort: "high" },
            args: ["-c", 'model_reasoning_effort="low"'],
          },
        },
      }),
      secrets: {},
    },
  };
  const actor = { kind: "human" as const, project_id: project };
  const run = applyCommand(store, {
    project,
    actor,
    clock,
    reduce: (s, a, p) =>
      queueRun(
        s,
        a,
        {
          assignment_id: assignment.id,
          model: "fixture",
          agent_cli_version: "fixture",
        },
        p,
      ),
  });
  return {
    root,
    host,
    assignment,
    actor,
    run,
    push,
    provision,
    central,
    close: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test.each(["fix", "followup"] as const)(
  "%s Run pushes the baseline before provision and includes its SHA in the first prompt",
  async (kind) => {
    const s = await fixture();
    try {
      const run = { ...s.run, kind };
      s.host.store.uow.run((tx) => tx.runs.put(project, run));
      const launched = await launchRun(s.host, {
        project,
        assignment_id: s.assignment.id,
        actor: s.actor,
        run,
        first_prompt: `[bell] kind=${kind}`,
      });
      expect(s.push).toHaveBeenCalledWith(
        s.central,
        join(s.host.execution.agentRoot, "repos", project),
        expect.any(String),
      );
      const prompt = await readFile(join(launched.run_dir, "first.md"), "utf8");
      expect(prompt).toContain(`[bell] kind=${kind}`);
      expect(prompt).toContain(`origin/main：${latest}`);
      expect(s.provision).toHaveBeenCalledTimes(1);
      expect(
        s.host.store.uow.read((tx) =>
          tx.assignments.get(project, s.assignment.id),
        ),
      ).toMatchObject({ base_sha: original, branch: s.assignment.branch });
      // C-106: the Run records the launched session's harness and the effort
      // its compiled arguments actually pass (the later override wins).
      expect(
        s.host.store.uow.read((tx) => tx.runs.get(project, run.id)),
      ).toMatchObject({ harness: "codex", effort: "low" });
      // The live-session beforeWake path uses the same preparation and prompt.
      const worktree = await prepareRoleWorktree(
        s.host,
        project,
        s.assignment.id,
      );
      expect(worktreeBaselinePrompt(worktree)).toContain(
        `origin/main：${latest}`,
      );
      expect(s.push).toHaveBeenCalledTimes(2);
    } finally {
      await s.close();
    }
  },
);

test("baseline push failure aborts the queued launch without provisioning an Agent", async () => {
  const s = await fixture();
  try {
    s.push.mockRejectedValue(new Error("baseline transfer failed"));
    await expect(
      launchRun(s.host, {
        project,
        assignment_id: s.assignment.id,
        actor: s.actor,
        run: s.run,
      }),
    ).rejects.toThrow("baseline transfer failed");
    expect(s.provision).not.toHaveBeenCalled();
    expect(
      s.host.store.uow.read((tx) => tx.runs.get(project, s.run.id)),
    ).toMatchObject({ status: "cancelled", outcome: "failed" });
    await expect(
      prepareRoleWorktree(s.host, project, s.assignment.id),
    ).rejects.toThrow("baseline transfer failed");
  } finally {
    await s.close();
  }
});

test.each(["before launch", "during provision"])(
  "C-217: card cancellation %s prevents Agent startup and late dispatch",
  async (timing) => {
    const s = await fixture();
    const cancel = () =>
      applyCommand(s.host.store, {
        project,
        actor: s.actor,
        clock: s.host.clock,
        reduce: (state, actor, ports) =>
          updateCard(
            state,
            actor,
            { card_id: "C-1" as never, status: "cancelled" },
            ports,
          ),
      });
    try {
      vi.mocked(s.host.runtime.release).mockResolvedValue({
        ok: true,
        value: undefined,
      });
      if (timing === "before launch") cancel();
      else
        s.provision.mockImplementationOnce(async () => {
          cancel();
          return {
            ok: true,
            value: {
              machine_id: "local",
              runtime_machine: "fixture",
              terminal_ref: "fixture",
              agent_name: "fixture",
            },
          };
        });
      await expect(
        launchRun(s.host, {
          project,
          assignment_id: s.assignment.id,
          actor: s.actor,
          run: s.run,
        }),
      ).rejects.toThrow();
      expect(s.provision).toHaveBeenCalledTimes(
        timing === "before launch" ? 0 : 1,
      );
      expect(s.host.runtime.release).toHaveBeenCalledTimes(
        timing === "before launch" ? 0 : 1,
      );
      const { runDir } = executionPaths(
        s.host.execution,
        project,
        s.assignment.id,
      );
      await expect(
        readFile(join(runDir, START_FILE_NAME)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        s.host.store.uow.read((tx) => tx.runs.get(project, s.run.id)),
      ).toMatchObject({ status: "cancelled", outcome: "failed" });
      expect(
        s.host.store.uow
          .run((tx) => tx.tokensForAssignment(project, s.assignment.id))
          .every((t) => t.revoked_at !== null),
      ).toBe(true);
      expect(
        s.host.store.uow
          .read((tx) => tx.events.listAfter(project, "C-1" as never, 0))
          .some((e) => e.type === "run_dispatched"),
      ).toBe(false);
    } finally {
      await s.close();
    }
  },
);

test("workspace routing rejects missing helpers, unregistered machines and stale bindings without enabling remote launch", async () => {
  const s = await fixture();
  try {
    const machine = {
      id: "worker-a",
      label: "Worker",
      herdr_machine: "fixture",
      os: "linux",
      arch: "x64",
      tags: [],
      status: "online" as const,
      max_assignments: 1,
      last_seen: s.host.clock.now(),
    };
    s.host.store.uow.run((tx) => tx.machines.put(project, machine));
    let workers: RuntimeWorker[] = [
      {
        machine_id: machine.id,
        project_id: project,
        os: machine.os,
        arch: machine.arch,
        session: "fixture",
        generation: "one",
        execution: s.host.execution,
      },
    ];
    const created = await RuntimeTargets.create({
      execution: s.host.execution,
      store: s.host.store,
      workers: () => workers,
    });
    if (!created.ok) throw new Error("Missing target resolver");
    const targets = created.value,
      assignment = { ...s.assignment, machine_id: machine.id };
    expect(() => targets.forWorkspace(project, assignment)).toThrow(/rejected/);
    const worker = workers[0];
    if (!worker) throw new Error("Missing fixture worker");
    workers = [
      {
        ...worker,
        execution: {
          ...worker.execution,
          gitHelper: {
            python: "/usr/bin/python3",
            path: "/opt/worker/worker-git.py",
          },
        },
      },
    ];
    const target = targets.forWorkspace(project, assignment);
    expect(target.execution.target?.machine_id).toBe(machine.id);
    expect(() =>
      targets.forWorkspace(project, { ...assignment, machine_id: "unknown" }),
    ).toThrow(/rejected/);
    await expect(targets.forLaunch(project, assignment)).rejects.toThrow(
      /rejected/,
    );
    const bound = {
      ...assignment,
      runtime_ref: {
        machine_id: machine.id,
        runtime_machine: "fixture",
        terminal_ref: "fixture/t1",
        agent_name: "fixture",
        target: target.execution.target,
      },
    } as Assignment;
    // Shared Git can be prepared before launch opt-in, but a session-bound
    // worktree cannot be touched with a revoked runtime binding.
    expect(() => targets.forWorkspace(project, bound)).toThrow(
      "remote_launch_disabled",
    );
    workers = workers.map((w) => ({ ...w, allow_remote_launch: true }));
    expect(targets.forWorkspace(project, bound).execution.target).toEqual(
      target.execution.target,
    );
    workers = workers.map((w) => ({ ...w, generation: "two" }));
    expect(() => targets.forWorkspace(project, bound)).toThrow(/rejected/);
    s.host.store.uow.run((tx) =>
      tx.machines.put(project, { ...machine, status: "offline" }),
    );
    expect(() => targets.forWorkspace(project, assignment)).toThrow(/rejected/);
  } finally {
    await s.close();
  }
});
