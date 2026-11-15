import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectId } from "@cardigan/domain";
import {
  acquireMergeCheckCapacity,
  type CheckoutInput,
  type CheckoutResult,
  executionOwner,
  type ProjectMergeGate,
} from "@cardigan/host";
import { prepareCheckLock } from "@cardigan/runtime-herdr";
import { CheckHandoffs, Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import {
  CheckHandoffController,
  type HandoffOptions,
} from "./check-handoff.js";
import {
  type CheckApproval,
  readCheckApproval,
} from "./check-handoff-artifact.js";
import {
  checkControlPath,
  requestCheckControl,
  startCheckControl,
} from "./check-handoff-control.js";
import { ServerGit } from "./git.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const project = "project" as ProjectId;
const git = (path: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-C",
      path,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();
const passed: CheckoutResult = {
  status: "passed",
  checks: [{ name: "light", status: "passed", exit_code: 0 }],
  cleanup_errors: [],
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "handoff-server-"));
  const dataDir = join(root, "data"),
    source = join(root, "source");
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(source);
  git(source, "init", "-q", "-b", "main");
  await writeFile(join(source, "fixed"), "approved\n");
  git(source, "add", "fixed");
  git(source, "commit", "-qm", "initial");
  const store = Store.open({ dataDir });
  store.createProject({ id: project });
  store.setProjectRepo({
    project_id: project,
    repo_path: source,
    base_branch: "main",
  });
  const execution = { mode: "local" as const, dataDir };
  const assembly = new ServerGit({ store, dataDir, execution });
  const central = assembly.projectOf(project);
  if (!central) throw new Error("missing fixture project");
  await assembly.sync(central);
  await assembly.distribute(central, execution);
  await prepareCheckLock(execution);
  let settings: ProjectMergeGate = {
    status: "enabled",
    checks: [{ name: "light", run: 'test "$(cat fixed)" = approved' }],
    env: {},
    totalTimeoutMs: 5000,
  };
  const artifact = {
    software_sha: "a".repeat(40),
    artifact_sha256: "b".repeat(64),
  };
  const sha = git(source, "rev-parse", "HEAD"),
    tree = git(source, "rev-parse", "HEAD^{tree}");
  const approval: CheckApproval = {
    version: 1,
    project_id: project,
    target: "local",
    ...artifact,
    candidates: [{ sha, tree, base: sha }],
  };
  await writeFile(
    join(dataDir, "check-handoff.json"),
    JSON.stringify(approval),
    { mode: 0o600 },
  );
  const options: HandoffOptions = {
    store,
    git: assembly,
    execution,
    configuration: { errors: [], forProject: () => settings },
    freshConfiguration: async () => ({
      errors: [],
      forProject: () => settings,
    }),
    approval: () => readCheckApproval(dataDir),
    artifact: async () => artifact,
    startupArtifact: { ...artifact },
  };
  cleanup.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    dataDir,
    source,
    store,
    assembly,
    central,
    options,
    approval,
    artifact,
    setSettings: (s: ProjectMergeGate) => {
      settings = s;
    },
  };
}

test("real temporary Git/SQLite/socket/executor path fences, drains, checks fixed objects, stops and explicitly resumes without publication", async () => {
  const f = await fixture();
  const publish = vi.spyOn(f.assembly, "publish"),
    legacy = vi.spyOn(f.assembly, "merge");
  const service = await startCheckControl(f.options);
  cleanup.push(() => service.close());
  const beforeEvents = f.store.database
    .prepare("SELECT COUNT(*) AS n FROM events")
    .get();
  const original = acquireMergeCheckCapacity(f.store, project, "original");
  const row = (await requestCheckControl(f.dataDir, {
    action: "begin",
    project,
  })) as { generation: number };
  expect(() =>
    acquireMergeCheckCapacity(f.store, project, "blocked"),
  ).toThrow();
  await expect(
    requestCheckControl(f.dataDir, {
      action: "measure",
      project,
      generation: row.generation,
    }),
  ).rejects.toThrow();
  expect(
    (
      (await requestCheckControl(f.dataDir, { action: "status", project })) as {
        phase: string;
      }[]
    )[0]?.phase,
  ).toBe("held");
  original(); // Original work exits normally, rather than being cancelled by handoff.
  await requestCheckControl(f.dataDir, {
    action: "resume",
    project,
    generation: row.generation,
  });
  const next = (await requestCheckControl(f.dataDir, {
    action: "begin",
    project,
  })) as { generation: number };
  expect(next.generation).toBeGreaterThan(row.generation);
  const report = (await requestCheckControl(f.dataDir, {
    action: "measure",
    project,
    generation: next.generation,
  })) as { reports: { status: string }[]; restored: boolean };
  expect(report.reports.map((r) => r.status)).toEqual(["passed"]);
  expect(report.restored).toBe(false);
  expect(() =>
    acquireMergeCheckCapacity(f.store, project, "still-blocked"),
  ).toThrow();
  await requestCheckControl(f.dataDir, {
    action: "stop",
    project,
    generation: next.generation,
  });
  await requestCheckControl(f.dataDir, {
    action: "resume",
    project,
    generation: next.generation,
  });
  await requestCheckControl(f.dataDir, {
    action: "resume",
    project,
    generation: next.generation,
  });
  acquireMergeCheckCapacity(f.store, project, "restored")();
  expect(await f.assembly.baseline(f.central)).toBe(
    f.approval.candidates[0]?.base,
  );
  expect(
    f.store.database.prepare("SELECT COUNT(*) AS n FROM events").get(),
  ).toEqual(beforeEvents);
  expect(publish).not.toHaveBeenCalled();
  expect(legacy).not.toHaveBeenCalled();
  expect(await readFile(join(f.source, "fixed"), "utf8")).toBe("approved\n");
});

test("client disconnect cancels only this measurement, retains the fence, and duplicate claims fail", async () => {
  const f = await fixture();
  let ready: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  f.options.run = async (input: CheckoutInput) => {
    input.onReady?.(executionOwner(process.pid));
    ready();
    await new Promise<void>((resolve) =>
      input.signal?.addEventListener("abort", () => resolve(), { once: true }),
    );
    return { ...passed, status: "interrupted" };
  };
  const service = await startCheckControl(f.options);
  cleanup.push(() => service.close());
  const row = (await requestCheckControl(f.dataDir, {
    action: "begin",
    project,
  })) as { generation: number };
  const socket = createConnection(checkControlPath(f.dataDir));
  await once(socket, "connect");
  socket.write(
    `${JSON.stringify({ action: "measure", project, generation: row.generation })}\n`,
  );
  await started;
  await expect(
    requestCheckControl(f.dataDir, {
      action: "measure",
      project,
      generation: row.generation,
    }),
  ).rejects.toThrow();
  socket.destroy();
  await requestCheckControl(f.dataDir, {
    action: "stop",
    project,
    generation: row.generation,
  });
  expect(
    (
      (await requestCheckControl(f.dataDir, { action: "status", project })) as {
        phase: string;
      }[]
    )[0]?.phase,
  ).toBe("held");
  expect(() =>
    acquireMergeCheckCapacity(f.store, project, "late-normal"),
  ).toThrow();
  await requestCheckControl(f.dataDir, {
    action: "resume",
    project,
    generation: row.generation,
  });
});

test("restart advances the persistent generation and old requests cannot resume, reacquire or overwrite it", async () => {
  const f = await fixture();
  let service = await startCheckControl(f.options);
  const first = (await requestCheckControl(f.dataDir, {
    action: "begin",
    project,
  })) as { generation: number };
  await service.close();
  service = await startCheckControl(f.options);
  cleanup.push(() => service.close());
  const current = (
    (await requestCheckControl(f.dataDir, { action: "status", project })) as {
      generation: number;
      phase: string;
    }[]
  )[0];
  expect(current).toMatchObject({
    generation: first.generation + 1,
    phase: "held",
  });
  for (const action of ["measure", "stop", "resume"] as const)
    await expect(
      requestCheckControl(f.dataDir, {
        action,
        project,
        generation: first.generation,
      }),
    ).rejects.toThrow();
  expect(() =>
    acquireMergeCheckCapacity(f.store, project, "restart-normal"),
  ).toThrow();
  await requestCheckControl(f.dataDir, {
    action: "resume",
    project,
    generation: current?.generation,
  });
});

test("cleanup failure and unknown occupancy retain the fence even when the supervisor is gone", async () => {
  const f = await fixture();
  const leftover = join(f.dataDir, "agent", "checks", project, "unclean");
  f.options.run = async () => {
    await mkdir(leftover, { recursive: true });
    return { ...passed, cleanup_errors: ["not clean"] };
  };
  const controller = new CheckHandoffController(f.options);
  const row = (await controller.request({ action: "begin", project })) as {
    generation: number;
  };
  await expect(
    controller.request({
      action: "measure",
      project,
      generation: row.generation,
    }),
  ).rejects.toThrow();
  await expect(
    controller.request({
      action: "resume",
      project,
      generation: row.generation,
    }),
  ).rejects.toThrow();
  expect(controller.facts.read(project, "local")?.phase).toBe("held");
  await rm(leftover, { recursive: true }); // Fixture cleanup; the product never recursively removes unknown resources.
  await controller.request({
    action: "resume",
    project,
    generation: row.generation,
  });
});

test.each(["artifact", "approval", "target", "tree", "base", "configuration"])(
  "%s changes reject preparation/distribution and retain admission",
  async (change) => {
    const f = await fixture();
    f.options.run = vi.fn(async () => passed);
    const controller = new CheckHandoffController(f.options);
    const row = (await controller.request({ action: "begin", project })) as {
      generation: number;
    };
    if (change === "artifact") f.artifact.artifact_sha256 = "c".repeat(64);
    if (change === "configuration")
      f.options.freshConfiguration = async () => ({
        errors: [],
        forProject: () => ({ status: "disabled" }),
      });
    if (["approval", "target"].includes(change)) {
      await writeFile(
        join(f.dataDir, "check-handoff.json"),
        JSON.stringify({
          ...f.approval,
          target: change === "target" ? "elsewhere" : "local",
          software_sha: "d".repeat(40),
        }),
      );
    }
    if (change === "tree" || change === "base") {
      const candidate = f.approval.candidates[0];
      if (!candidate) throw new Error("fixture candidate");
      const verify = f.options.git.verifyCheckCandidate.bind(f.options.git);
      f.options.git = {
        ...f.options.git,
        projectOf: f.assembly.projectOf.bind(f.assembly),
        distribute: f.assembly.distribute.bind(f.assembly),
        verifyCheckCandidate: async (p, c) =>
          verify(p, { ...c, [change]: "e".repeat(40) }),
      };
    }
    await expect(
      controller.request({
        action: "measure",
        project,
        generation: row.generation,
      }),
    ).rejects.toThrow();
    expect(f.options.run).not.toHaveBeenCalled();
    expect(controller.facts.read(project, "local")?.phase).toBe("held");
  },
);

test("approval is a host-owned regular private file, and management never accepts shell, paths or cross-project grants", async () => {
  const f = await fixture();
  const path = join(f.dataDir, "check-handoff.json");
  await chmod(path, 0o644);
  await expect(readCheckApproval(f.dataDir)).rejects.toThrow();
  await chmod(path, 0o600);
  const service = await startCheckControl(f.options);
  cleanup.push(() => service.close());
  await expect(startCheckControl(f.options)).rejects.toThrow(); // A second controller cannot invalidate the original generation.
  await expect(
    requestCheckControl(f.dataDir, { action: "begin", project: "elsewhere" }),
  ).rejects.toThrow();
  const socket = createConnection(checkControlPath(f.dataDir));
  await once(socket, "connect");
  let response = "";
  socket.setEncoding("utf8").on("data", (chunk) => {
    response += chunk;
  });
  socket.write(
    `${JSON.stringify({ action: "begin", project, run: "true", path: "/arbitrary" })}\n`,
  );
  await once(socket, "close");
  expect(JSON.parse(response).ok).toBe(false);
  expect(new CheckHandoffs(f.store, "").blocked("local")).toBe(false);
});

test("SIGKILL of the exact controller leaves a stale socket and ledger; the replacement retains admission until exact proof and explicit resume", async () => {
  const f = await fixture();
  const script = `
    const { Store } = await import(${JSON.stringify(new URL("../../../packages/store/dist/index.js", import.meta.url).href)});
    const { ServerGit } = await import(${JSON.stringify(new URL("../dist/git.js", import.meta.url).href)});
    const { startCheckControl } = await import(${JSON.stringify(new URL("../dist/check-handoff-control.js", import.meta.url).href)});
    const { readCheckApproval } = await import(${JSON.stringify(new URL("../dist/check-handoff-artifact.js", import.meta.url).href)});
    const store = Store.open({dataDir:process.argv[1]});
    const execution = {mode:'local',dataDir:process.argv[1]};
    const approval = await readCheckApproval(execution.dataDir);
    const artifact = {software_sha:approval.software_sha,artifact_sha256:approval.artifact_sha256};
    const settings = ${JSON.stringify(f.options.configuration.forProject(project))};
    const configuration = {errors:[],forProject:() => settings};
    await startCheckControl({store,execution,git:new ServerGit({store,dataDir:execution.dataDir,execution}),configuration,
      freshConfiguration:async () => configuration,approval:() => readCheckApproval(execution.dataDir),artifact:async () => artifact,startupArtifact:artifact,
      run:async () => { process.stdout.write('running\\n'); await new Promise(() => {}); }});
    process.stdout.write('ready\\n');
  `;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", script, f.dataDir],
    {
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  });
  expect(String((await once(child.stdout, "data"))[0])).toContain("ready");
  const row = (await requestCheckControl(f.dataDir, {
    action: "begin",
    project,
  })) as { generation: number };
  const running = once(child.stdout, "data");
  const measure = requestCheckControl(f.dataDir, {
    action: "measure",
    project,
    generation: row.generation,
  }).catch(() => undefined);
  expect(String((await running)[0])).toContain("running");
  expect(
    f.store.database.prepare("SELECT * FROM merge_check_capacity").all(),
  ).toHaveLength(1);
  child.kill("SIGKILL");
  await once(child, "exit");
  await measure;
  const replacement = await startCheckControl(f.options);
  cleanup.push(() => replacement.close());
  const state = (
    (await requestCheckControl(f.dataDir, { action: "status", project })) as {
      generation: number;
      phase: string;
    }[]
  )[0];
  expect(state).toMatchObject({
    generation: row.generation + 1,
    phase: "held",
  });
  expect(() =>
    acquireMergeCheckCapacity(f.store, project, "premature"),
  ).toThrow();
  await expect(
    requestCheckControl(f.dataDir, {
      action: "resume",
      project,
      generation: row.generation,
    }),
  ).rejects.toThrow();
  await requestCheckControl(f.dataDir, {
    action: "resume",
    project,
    generation: state?.generation,
  });
  expect(
    f.store.database.prepare("SELECT * FROM merge_check_capacity").all(),
  ).toHaveLength(0);
  acquireMergeCheckCapacity(f.store, project, "after-exact-recovery")();
});

test("isolated width is bounded by unchanged trusted capacity, uses original slot indices and settles the whole group before retaining the fence", async () => {
  const f = await fixture();
  const old = f.options.configuration.forProject(project);
  if (old.status !== "enabled") throw new Error("fixture settings");
  f.setSettings({
    ...old,
    executor: {
      name: "fixture-ci",
      host: "fixture-ci",
      port: 22,
      user: "agent",
      hostKeyAlias: "fixture-ci",
      agentRoot: "/fixture-agent",
      identityFile: "/fixture-identity",
      knownHostsFile: "/fixture-known",
      maxConcurrent: 2,
    },
  });
  const first = f.approval.candidates[0];
  if (!first) throw new Error("candidate");
  f.approval.target = "fixture-ci";
  f.approval.candidates = [first, first];
  await writeFile(
    join(f.dataDir, "check-handoff.json"),
    JSON.stringify(f.approval),
  );
  const slots: number[] = [];
  const finishers: (() => void)[] = [];
  f.options.probe = async () => {};
  f.options.git = {
    projectOf: f.assembly.projectOf.bind(f.assembly),
    verifyCheckCandidate: f.assembly.verifyCheckCandidate.bind(f.assembly),
    distribute: async () => {},
  };
  f.options.run = async (input) => {
    slots.push(input.lockSlot ?? -1);
    input.onReady?.(executionOwner(process.pid));
    await new Promise<void>((resolve) => {
      finishers.push(resolve);
      input.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return input.signal?.aborted
      ? { ...passed, status: "interrupted" }
      : { ...passed, status: "failed", cleanup_errors: ["unknown exit"] };
  };
  const controller = new CheckHandoffController(f.options);
  const rejected = (await controller.request({ action: "begin", project })) as {
    generation: number;
  };
  await expect(
    controller.request({
      action: "measure",
      project,
      generation: rejected.generation,
      width: 3,
    }),
  ).rejects.toThrow("宽度");
  expect(slots).toEqual([]);
  await controller.request({
    action: "resume",
    project,
    generation: rejected.generation,
  });
  const row = (await controller.request({ action: "begin", project })) as {
    generation: number;
  };
  const work = controller
    .request({
      action: "measure",
      project,
      generation: row.generation,
      width: 2,
    })
    .catch(() => "held");
  await vi.waitFor(() => expect(slots.sort()).toEqual([0, 1]));
  expect(
    f.store.database.prepare("SELECT * FROM merge_check_capacity").all(),
  ).toHaveLength(2);
  expect(() =>
    acquireMergeCheckCapacity(
      f.store,
      project,
      "ordinary",
      undefined,
      "fixture-ci",
    ),
  ).toThrow();
  finishers[0]?.();
  expect(await work).toBe("held");
  expect(
    f.store.database.prepare("SELECT * FROM merge_check_capacity").all(),
  ).toHaveLength(0);
  expect(controller.facts.read(project, "fixture-ci")?.phase).toBe("held");
});
