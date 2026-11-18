import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acknowledgeRun,
  finishRun,
  queueRun,
  type Runtime,
} from "@cardigan/domain";
import { CentralRepositoryService } from "@cardigan/git-service";
import { CentralGitTransport } from "@cardigan/git-transport";
import { RuntimeTargets } from "@cardigan/host";
import { parseLaunchConfig } from "@cardigan/roles";
import { beginLaunchAttempt, finishBellAttempt } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { workerGitFixture } from "../../cli/test-support/worker-git.js";
import { dispatchFixture } from "../test-support/dispatch.js";
import { startQueuedRun } from "./host-start.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();
let f: ReturnType<typeof dispatchFixture>;
afterEach(() => {
  vi.unstubAllEnvs();
  f?.close();
});

test("system starts the initial and follow-up Run on the worker, syncing origin/main without moving the writer's HEAD", async () => {
  f = dispatchFixture("worker-a", "write");
  const { project, dataDir, store, clock } = f;
  const { assignment } = f.create();
  const source = join(dataDir, "source");
  git(dataDir, "init", "-q", "-b", "main", source);
  const commit = () => {
    git(source, "commit", "--allow-empty", "-qm", "baseline");
    return git(source, "rev-parse", "HEAD");
  };
  const initial = commit();
  store.setProjectRepo({ project_id: project, repo_path: source });

  // Only SSH, MCP, publication acknowledgements and the terminal are synthetic.
  // Git runs through the host's real center, pack stream and worker helper on a separate disk.
  const worker = await workerGitFixture(
    dataDir,
    {
      mode: "agent-ssh",
      dataDir,
      agentRoot: "/worker-fixture",
      gid: process.getgid?.() ?? 0,
      machine: "worker-a",
      identityFile: join(dataDir, "key"),
      knownHostsFile: join(dataDir, "known"),
    },
    "worker-a",
    "linux",
    project,
  );
  const fileHelper = join(dataDir, "files.py");
  writeFileSync(
    fileHelper,
    `import json,sys
r=json.loads(sys.stdin.buffer.readline());sys.stdin.buffer.read()
print(json.dumps(dict(r,process=None,observed='unknown',phase={'publish':'published','commit':'start','clear':'revoked'}.get(r['operation'],'empty'))))`,
  );
  const execution = {
    ...worker.config,
    fileHelper: { python: "/usr/bin/python3", path: fileHelper },
    mcp: { url: "https://worker.fixture.ts.net/mcp", timeoutMs: 5000 },
    publication: {
      header_max_bytes: 8192,
      file_max_bytes: 1048576,
      batch_max_bytes: 2097152,
      timeout_ms: 5000,
    },
  };
  for (const path of [execution.identityFile, execution.knownHostsFile])
    writeFileSync(path, "fixture", { mode: 0o600 });
  writeFileSync(
    join(dataDir, "ssh"),
    `#!/bin/sh
for cmd do :; done
case "$cmd" in *'urllib.request'*) cat >/dev/null; echo ok;; *) exec sh -c "$cmd";; esac\n`,
    { mode: 0o700 },
  );
  vi.stubEnv("PATH", `${dataDir}:${process.env.PATH}`);
  const path = join(execution.agentRoot, "worktrees", project, assignment.id);
  const onDisk = join(worker.disk, "worktrees", project, assignment.id);
  const provision = vi.fn<Runtime["provision"]>(async (_a, _r, _m, desc) => {
    expect(desc.cwd).toBe(path);
    expect(git(onDisk, "rev-parse", "refs/remotes/origin/main")).toBe(
      git(source, "rev-parse", "HEAD"),
    );
    return {
      ok: true,
      value: {
        ...f.refFor(assignment),
        target: runtime.resolve(project, assignment.machine_id).execution
          .target,
        agent_name: desc.agent_name,
      },
    };
  });
  const local = { mode: "local" as const, dataDir };
  const created = await RuntimeTargets.create({
    store,
    execution: local,
    workers: () => [
      {
        project_id: project,
        machine_id: assignment.machine_id,
        os: "linux",
        arch: "x64",
        session: "fixture-worker",
        generation: "one",
        allow_remote_launch: true,
        execution,
      },
    ],
    factory: async () => ({
      ok: true,
      value: {
        provision,
        captureAgent: async () => ({ ok: true, value: "git fixture" }),
      } as never,
    }),
    workerReadiness: async () => [],
  });
  if (!created.ok) throw new Error(created.error.message);
  const runtime = created.value;
  const launch = {
    config: parseLaunchConfig({
      profiles: { fixture: { harness: "pi", model: "fixture" } },
    }),
    secrets: {},
  };
  async function start(kind: "initial" | "rework") {
    const run = f.apply((s, a, p) =>
      queueRun(
        s,
        a,
        {
          assignment_id: assignment.id,
          kind,
          model: "fixture",
          agent_cli_version: "pi fixture",
        },
        p,
      ),
    );
    const attempt = {
      id: `attempt-${run.id}`,
      project_id: project,
      assignment_id: assignment.id,
      run_id: run.id,
      started_at: clock.now(),
      lease_until: new Date(Date.parse(clock.now()) + 60_000).toISOString(),
    };
    store.uow.run(() => beginLaunchAttempt(store.database, attempt));
    await startQueuedRun(
      {
        store,
        runtime,
        launch,
        execution: local,
        dataDir,
        clock,
        mcpUrl: "unused",
      },
      { project, assignment, run, bell: `[bell] run=${run.id}` },
    );
    expect(f.state().runs.find((r) => r.id === run.id)).toMatchObject({
      status: "dispatched",
      launch_publication: { phase: "started", work_dir: path },
    });
    store.uow.run(() =>
      finishBellAttempt(
        store.database,
        project,
        attempt.id,
        "sent",
        clock.now(),
      ),
    );
    return run;
  }
  const first = await start("initial");
  f.apply(
    (s, a, p) => acknowledgeRun(s, a, { run_id: first.id }, p),
    f.actorFor(assignment),
  );
  f.apply(
    (s, a, p) =>
      finishRun(
        s,
        a,
        { run_id: first.id, outcome: "completed", summary: "fixture" },
        p,
      ),
    f.actorFor(assignment),
  );
  writeFileSync(join(onDisk, "draft"), "uncommitted");
  expect(commit()).not.toBe(initial);
  await new CentralRepositoryService(new CentralGitTransport({ dataDir }), {
    dataDir,
  }).syncFromSource({
    project_id: project,
    source_repo: source,
    base_branch: "main",
  });
  await start("rework");
  expect(provision).toHaveBeenCalledTimes(2);
  expect(git(onDisk, "rev-parse", "HEAD")).toBe(initial);
  expect(readFileSync(join(onDisk, "draft"), "utf8")).toBe("uncommitted");
  expect(
    f.state().assignments.find((a) => a.id === assignment.id),
  ).toMatchObject({ base_sha: initial, worktree_path: path });
}, 30_000);
