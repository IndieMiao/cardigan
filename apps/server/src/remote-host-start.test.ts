import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acknowledgeRun,
  finishRun,
  postComment,
  queueRun,
  type Run,
  type Runtime,
} from "@cardigan/domain";
import { CentralRepositoryService } from "@cardigan/git-service";
import { CentralGitTransport } from "@cardigan/git-transport";
import { RuntimeTargets } from "@cardigan/host";
import { parseLaunchConfig } from "@cardigan/roles";
import { listBellAttempts } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { workerGitFixture } from "../../cli/test-support/worker-git.js";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher } from "./dispatch.js";
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

async function fixture() {
  f = dispatchFixture("worker-a", "write");
  const { project, dataDir, store } = f;
  const { assignment, card, item } = f.create();
  f.apply((s, a, p) =>
    queueRun(
      s,
      a,
      {
        assignment_id: assignment.id,
        model: "fixture",
        agent_cli_version: "pi fixture",
      },
      p,
    ),
  );
  f.apply((s, a, p) =>
    postComment(
      s,
      a,
      { card_id: card.id, work_item_id: item.id, body: "Start fixture" },
      p,
    ),
  );
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
  function setGitFailure(
    operation?: "exists" | "receive-pack",
    command?: string,
  ) {
    writeFileSync(
      join(dataDir, "ssh"),
      `#!/bin/sh
for cmd do :; done
case "$cmd" in
  *'urllib.request'*) cat >/dev/null; echo ok;;
  ${operation ? `*'-git.py'*'"operation":"${operation}"'*) ${command};;` : ""}
  *) exec sh -c "$cmd";;
esac\n`,
      { mode: 0o700 },
    );
  }
  setGitFailure();
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
  const status = vi.fn<Runtime["status"]>(async () => ({
    ok: true,
    value: { process: "exited", agent: "idle", observed_seq: 1 },
  }));
  const wake = vi.fn<Runtime["wake"]>(async () => ({
    ok: true,
    value: { sent: true },
  }));
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
        status,
        wake,
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
  // Simulate a slow Git transfer without sleeps. Only advance once the worktree
  // has actually been created, after the server claimed the normal delivery.
  let advanced = false;
  const clock = {
    now: () => {
      if (!advanced && existsSync(join(onDisk, ".git"))) {
        f.advance(61_000);
        advanced = true;
      }
      return f.clock.now();
    },
  };
  const logs: string[] = [];
  const dispatcher = new Dispatcher({
    store,
    runtime,
    clock,
    snapshot: async () => ({
      model: "fixture",
      agent_cli_version: "pi fixture",
    }),
    onError: (error) => logs.push(String(error)),
    startRun: (input) =>
      startQueuedRun(
        {
          store,
          runtime,
          launch,
          execution: local,
          dataDir,
          clock,
          mcpUrl: "unused",
        },
        input,
      ),
  });
  async function start() {
    await dispatcher.tick(project);
    const run = f
      .state()
      .runs.filter((r) => r.assignment_id === assignment.id)
      .at(-1);
    if (!run) throw new Error("Missing dispatched fixture Run");
    return run;
  }
  function followUp(run: Run) {
    f.apply(
      (s, a, p) => acknowledgeRun(s, a, { run_id: run.id }, p),
      f.actorFor(assignment),
    );
    f.apply(
      (s, a, p) =>
        finishRun(
          s,
          a,
          { run_id: run.id, outcome: "completed", summary: "fixture" },
          p,
        ),
      f.actorFor(assignment),
    );
    f.apply((s, a, p) =>
      postComment(
        s,
        a,
        { card_id: card.id, work_item_id: item.id, body: "Follow up" },
        p,
      ),
    );
  }
  return {
    project,
    dataDir,
    assignment,
    source,
    commit,
    initial,
    path,
    onDisk,
    provision,
    start,
    logs,
    followUp,
    status,
    wake,
    setGitFailure,
  };
}

test("the dispatcher starts a slow remote checkout and refreshes origin/main on follow-up without moving the writer's HEAD", async () => {
  const {
    project,
    dataDir,
    assignment,
    source,
    commit,
    initial,
    path,
    onDisk,
    provision,
    start,
    logs,
    followUp,
  } = await fixture();
  const first = await start();
  expect(first).toMatchObject({
    kind: "initial",
    status: "dispatched",
    launch_publication: { phase: "started", work_dir: path },
  });
  expect(
    Date.parse(f.clock.now()) - Date.parse(assignment.created_at),
  ).toBeGreaterThan(60_000);
  followUp(first);
  writeFileSync(join(onDisk, "draft"), "uncommitted");
  expect(commit()).not.toBe(initial);
  await new CentralRepositoryService(new CentralGitTransport({ dataDir }), {
    dataDir,
  }).syncFromSource({
    project_id: project,
    source_repo: source,
    base_branch: "main",
  });
  expect(await start()).toMatchObject({
    kind: "followup",
    status: "dispatched",
    launch_publication: { phase: "started", work_dir: path },
  });
  expect(logs).toEqual([]);
  expect(provision).toHaveBeenCalledTimes(2);
  expect(git(onDisk, "rev-parse", "HEAD")).toBe(initial);
  expect(readFileSync(join(onDisk, "draft"), "utf8")).toBe("uncommitted");
  expect(
    f.state().assignments.find((a) => a.id === assignment.id),
  ).toMatchObject({ base_sha: initial, worktree_path: path });
}, 30_000);

test("a live remote writer still receives the ordinary bell lease", async () => {
  const { start, followUp, status, wake, project, provision } = await fixture();
  followUp(await start());
  status.mockResolvedValue({
    ok: true,
    value: { process: "alive", agent: "idle", observed_seq: 1 },
  });
  const followup = await start();
  const [intent] = listBellAttempts(f.store.database, project, followup.id);
  if (!intent) throw new Error("Missing wake intent");
  expect(Date.parse(intent.lease_until) - Date.parse(intent.started_at)).toBe(
    60_000,
  );
  expect(wake).toHaveBeenCalledOnce();
  expect(provision).toHaveBeenCalledOnce();
});

const timeout =
  "echo 'ssh: connect to host private-host port 23456: Connection timed out' >&2; exit 255";
test.each([
  ["initial", "exists", timeout, "SSH connection timed out; exit 255"],
  [
    "initial",
    "exists",
    "printf 'worker_git_rejected\\nprivate-value\\n' >&2; exit 75",
    "helper rejected request; exit 75",
  ],
  [
    "initial",
    "exists",
    "echo 'invalid response: private-value'",
    "invalid helper response",
  ],
  [
    "initial",
    "exists",
    `echo '{"malformed":"private-value"}'`,
    "invalid helper response",
  ],
  ["initial", "receive-pack", timeout, "SSH connection timed out; exit 128"],
  [
    "followup",
    "receive-pack",
    "echo 'private-user@private-host: Permission denied (publickey).' >&2; exit 255",
    "SSH permission denied; exit 128",
  ],
  [
    "initial",
    "receive-pack",
    "echo 'private-value private-host:23456' >&2; exit 42",
    "pack transfer failed; exit 128",
  ],
] as const)(
  "%s %s: only the safe reason reaches the event, Run and dispatch log [case %#]",
  async (kind, operation, command, reason) => {
    const { start, logs, provision, setGitFailure, followUp } = await fixture();
    if (kind === "followup") followUp(await start());
    setGitFailure(operation, command);
    const failed = await start();
    expect(failed).toMatchObject({
      kind,
      status: "cancelled",
      launch_publication: { phase: "exited" },
    });
    const event = f
      .state()
      .events.find(
        (e) =>
          e.type === "run_dispatch_aborted" && e.payload.run_id === failed.id,
      );
    const diagnostic = `directory preparation: Worker Git operation failed (${operation}: ${reason})`;
    expect(event?.payload.reason).toBe(diagnostic);
    expect(failed.summary).toBe(diagnostic);
    expect(logs.join("\n")).toContain(diagnostic);
    expect(JSON.stringify([logs, event, failed.summary])).not.toMatch(
      /private-(?:value|host|user)|23456|IdentityFile|\.py/u,
    );
    expect(provision).toHaveBeenCalledTimes(kind === "followup" ? 1 : 0);
  },
);
