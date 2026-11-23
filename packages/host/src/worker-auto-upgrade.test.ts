import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Machine } from "@cardigan/domain";
import { readMachineObservations, Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { parse } from "yaml";
import {
  AGENT_TOOLS,
  agentToolsCapability,
  agentToolsRelease,
} from "./agent-tools.js";
import {
  agentToolsCommandVisible,
  agentToolsGuidance,
} from "./agent-tools-maintenance.js";
import { refreshMachineObservations } from "./machine-capabilities.js";
import { MachineCheckJournal } from "./machine-check-journal.js";
import { runtimeTargetBinding } from "./runtime-target-fingerprint.js";
import {
  checkRegisteredMachine,
  type RuntimeTargets,
} from "./runtime-targets.js";
import { loadRuntimeWorkers } from "./runtime-workers-config.js";
import { patrolHelperUpgrade } from "./worker-auto-upgrade.js";
import {
  digestMismatch,
  helpers,
  workerHelperDigests,
} from "./worker-helper-release.js";
import { onboardWorker } from "./worker-onboarding.js";
import { type stageWorkerUpgrade, upgradeMaterials } from "./worker-upgrade.js";
import {
  enrolledUpgradeIdentity,
  upgradeIdentity,
} from "./worker-upgrade-enrollment.js";
import {
  upgradeHeld,
  upgradeHold,
  upgradeKey,
  upgradeState,
} from "./worker-upgrade-gate.js";
import {
  installRelease,
  signedHelperBundle,
  upgradePrincipal,
  WORKER_UPGRADE_NOT_SENT,
} from "./worker-upgrade-transport.js";
import { workerWizardForm } from "./worker-wizard-form.js";

const toolEntries = AGENT_TOOLS.map((n) => `agent-tools/${n}`);

const project = "sample",
  machine = "worker-a",
  mismatch = { blockers: [digestMismatch], launch_enabled: false },
  pass = { blockers: [], launch_enabled: true };
let cleanup = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});
async function setup(
  os = "linux",
  project = "sample",
  shared?: { root: string; store: Store },
  appliedPath?: string,
) {
  const root = shared?.root ?? mkdtempSync(join(tmpdir(), "helper-upgrade-"));
  const store = shared?.store ?? Store.open({ dataDir: root });
  if (!shared)
    cleanup = () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    };
  store.createProject({ id: project });
  const form = workerWizardForm(root, root, project, {
    os,
    arch: "arm64",
    machine_id: machine,
    label: "test",
    host: "worker.invalid",
    account: `cg_${project}`,
    uid: project === "sample" ? 2201 : 2202,
    gid: project === "sample" ? 2201 : 2202,
    mcp_url: "https://control.example.ts.net/mcp",
  });
  writeFileSync(
    join(root, `worker-${machine}-${project}.yaml`),
    JSON.stringify(form.raw),
    { mode: 0o600 },
  );
  if (os === "macos")
    writeFileSync(
      join(root, "run-capacity.yaml"),
      JSON.stringify({ machines: { [machine]: { limit: 1, max_limit: 1 } } }),
      { mode: 0o600 },
    );
  expect(
    await onboardWorker({
      configRoot: root,
      dataDir: root,
      config: form.config,
      mode: "add",
      registration: async () => true,
      probe: async () => true,
      report() {},
    }),
  ).toBe(true);
  const runtimeFile = join(root, "runtime-workers.yaml");
  const runtime = existsSync(runtimeFile)
    ? JSON.parse(readFileSync(runtimeFile, "utf8"))
    : structuredClone(form.raw.runtime);
  if (shared)
    runtime.machines[0].projects.push(
      form.raw.runtime.machines[0]?.projects[0],
    );
  const binding = runtime.machines[0].projects.find(
    (p: { project_id: string }) => p.project_id === project,
  );
  if (appliedPath) binding.path = appliedPath;
  binding.allow_remote_launch = true;
  writeFileSync(runtimeFile, JSON.stringify(runtime), { mode: 0o600 });
  const worker = loadRuntimeWorkers(root, runtimeFile).find(
    (w) => w.project_id === project,
  );
  if (!worker) throw new Error("missing test binding");
  const target = runtimeTargetBinding(worker);
  const isHeld = () => upgradeHeld(store, project, machine);
  const options = {
    store,
    project,
    machine,
    env: { CARDIGAN_CONFIG_DIR: root },
    execution: { ...worker.execution, target },
    bindingCurrent: vi.fn(() => true),
    check: vi.fn(async () => {
      expect(isHeld()).toBe(true);
      return pass;
    }),
  };
  const adapters = {
    install: vi.fn(async () => {
      expect(isHeld()).toBe(true);
      return { "worker-files.py": "0".repeat(64) };
    }),
    workerCheck: vi.fn<typeof onboardWorker>(async () => {
      expect(isHeld()).toBe(true);
      return true;
    }),
    promotionPending: () => false,
  };
  const terminal = {
    target: machine,
    login: "fixture",
    command: "fixture",
    expected_output: "fixture",
    on_failure: "fixture",
  };
  const stageUpgrade = vi.fn<typeof stageWorkerUpgrade>(async () => terminal);
  // C-599: when set, the outer observation probes the attachment tools with this output.
  const tools: { output?: string; binding?: string } = {};
  const journal = new MachineCheckJournal(store);
  const registered: Machine = {
    id: machine,
    herdr_machine: machine,
    label: "fixture",
    os: os === "macos" ? "darwin" : os,
    arch: "arm64",
    tags: [],
    max_assignments: 1,
    status: "online",
    last_seen: new Date().toISOString(),
  };
  store.uow.run((tx) => tx.machines.put(project, registered));
  let last: Awaited<ReturnType<typeof refreshMachineObservations>> | undefined;
  const finalize = async (
    kind: "machine" | "worker",
    binding: string,
    raw: (
      id: string,
    ) => Promise<{ blockers: readonly string[]; launch_enabled: boolean }>,
    outerOK = true,
  ) => {
    const { job } = journal.claim(project, machine, kind, "cli");
    const r = await journal.execute(
      job,
      async () =>
        refreshMachineObservations({
          store,
          project,
          machine,
          observationId: job.id,
          env: options.env,
          stageUpgrade,
          target: () => ({
            machine: registered,
            execution: {
              ...options.execution,
              target: { ...target, fingerprint: tools.binding ?? binding },
            },
          }),
          check: () => raw(job.id),
          catalog: () => {
            if (!outerOK) throw new Error("probe interrupted");
            return tools.output === undefined
              ? []
              : [agentToolsCapability(options.execution, machine)];
          },
          probe: async () => ({ ok: true, output: tools.output ?? "" }),
        }),
      (v) => ({
        status: v.health?.available ? "passed" : "failed",
        failed_steps: [],
        ...(v.agent_tools ? { agent_tools: v.agent_tools } : {}),
      }),
    );
    last = r;
    return {
      blockers: r.health?.blockers ?? ["failed"],
      launch_enabled: r.health?.launch_enabled ?? false,
    };
  };
  const run = (
    initial: typeof mismatch = mismatch,
    outerOK = true,
    binding = target.fingerprint,
  ) =>
    finalize(
      "machine",
      binding,
      (job) =>
        patrolHelperUpgrade(
          {
            ...options,
            execution: {
              ...options.execution,
              target: { ...target, fingerprint: binding },
            },
            job,
          },
          initial,
          adapters,
        ),
      outerOK,
    );
  const manual = (
    kind: "worker" | "machine",
    binding = target.fingerprint,
    ok = true,
    outerOK = true,
  ) =>
    finalize(
      kind,
      binding,
      async () => (ok ? pass : { blockers: ["tools"], launch_enabled: false }),
      outerOK,
    );
  const enroll = () =>
    writeFileSync(upgradeIdentity(root, project, machine), "synthetic", {
      mode: 0o600,
    });
  return {
    root,
    runtimeFile,
    run,
    manual,
    journal,
    options,
    adapters,
    enroll,
    isHeld,
    target,
    store,
    stageUpgrade,
    terminal,
    tools,
    last: () => last,
    registered,
    actions: () => store.uow.read((tx) => tx.human_actions.list(project)),
  };
}
test.each(["linux", "macos"])(
  "%s: opt-in, install, both checks, audited release and drift fence",
  async (os) => {
    const f = await setup(os);
    expect(await f.run()).toEqual(mismatch);
    expect(f.adapters.install).not.toHaveBeenCalled();
    expect(f.stageUpgrade).toHaveBeenCalledOnce();
    expect(f.actions()).toEqual([
      expect.objectContaining({
        terminal: f.terminal,
        helper_upgrade: { machine_id: machine, binding: f.target.fingerprint },
      }),
    ]);
    f.enroll();
    expect(await f.run()).toEqual(pass);
    expect(f.adapters.install).toHaveBeenCalledBefore(f.adapters.workerCheck);
    expect(f.adapters.workerCheck).toHaveBeenCalledBefore(f.options.check);
    expect(f.isHeld()).toBe(false);
    expect(f.actions()).toEqual([
      expect.objectContaining({
        status: "cancelled",
        cancellation: {
          source: "worker_helper_superseded",
          by: "system",
          at: expect.any(String),
          reason: expect.any(String),
        },
      }),
    ]);
    expect(f.stageUpgrade).toHaveBeenCalledOnce();
    const events = f.store.uow.read((tx) =>
      tx.events.listAfter(project, undefined, 0),
    );
    expect(
      events.find((e) => e.type === "worker_helper_upgrade_verified")?.payload,
    ).toMatchObject({
      machine_id: machine,
      stage: "machine_check",
      expected: { "worker-files.py": expect.stringMatching(/^[a-f0-9]{64}$/) },
      before: { "worker-files.py": "0".repeat(64) },
    });
    expect((await f.run()).blockers).toEqual([upgradeHold]);
    expect(f.adapters.install).toHaveBeenCalledTimes(1);
  },
);
test("an idle enrolled worker upgrades and is released with only the applied PATH changed", async () => {
  const path = "/new/tools:/usr/bin:/bin";
  const f = await setup("linux", project, undefined, path);
  f.enroll();
  const probe = vi.fn(
    async (_step, config) => config.worker.execution.path === path,
  );
  f.adapters.workerCheck.mockImplementationOnce((opts) =>
    onboardWorker({ ...opts, probe }),
  );
  expect(await f.run()).toEqual(pass);
  expect(probe).toHaveBeenCalled();
  expect(f.adapters.install).toHaveBeenCalledOnce();
  expect(f.adapters.workerCheck).toHaveBeenCalledOnce();
  expect(f.options.check).toHaveBeenCalledOnce();
  expect(f.isHeld()).toBe(false);
  expect(await f.run(pass)).toEqual(pass);
  expect(f.adapters.install).toHaveBeenCalledOnce();
  expect(f.actions()).toEqual([]);
});

test.each(["removed", "account", "trust", "generation", "enrollment", "saved"])(
  "PATH does not authorize a changed binding (%s)",
  async (change) => {
    const f = await setup(
      "linux",
      project,
      undefined,
      "/new/tools:/usr/bin:/bin",
    );
    f.enroll();
    const live = JSON.parse(readFileSync(f.runtimeFile, "utf8"));
    const m = live.machines[0];
    if (change === "enrollment") {
      const file = join(f.root, `worker-${machine}-${project}.yaml`);
      const edited = JSON.parse(readFileSync(file, "utf8"));
      edited.uid += 1;
      writeFileSync(file, JSON.stringify(edited));
    }
    if (change === "saved") {
      const file = join(
        f.root,
        "worker-onboarding",
        machine,
        `${project}.runtime-workers.yaml`,
      );
      const edited = parse(readFileSync(file, "utf8"));
      edited.machines[0].projects[0].generation = "other";
      writeFileSync(file, JSON.stringify(edited));
    }
    if (change === "removed") live.machines = [];
    if (change === "account") m.projects[0].user = "cg_other";
    if (change === "trust") m.known_hosts_file += ".other";
    if (change === "generation") m.projects[0].generation = "next";
    writeFileSync(f.runtimeFile, JSON.stringify(live));
    const current = loadRuntimeWorkers(f.root, f.runtimeFile)[0];
    const binding = current
      ? runtimeTargetBinding(current).fingerprint
      : f.target.fingerprint;
    expect((await f.run(mismatch, true, binding)).blockers).toEqual([
      upgradeHold,
    ]);
    expect(f.adapters.install).not.toHaveBeenCalled();
    expect(f.adapters.workerCheck).not.toHaveBeenCalled();
    expect(f.options.check).not.toHaveBeenCalled();
  },
);

test.each([false, true])(
  "without a wizard journal only an unchanged enrolled target can be checked (PATH changed: %s)",
  async (changed) => {
    const f = await setup(
      "linux",
      project,
      undefined,
      changed ? "/new/tools:/usr/bin:/bin" : undefined,
    );
    f.enroll();
    rmSync(join(f.root, "worker-onboarding"), { recursive: true });
    f.adapters.workerCheck.mockImplementationOnce((opts) =>
      onboardWorker({ ...opts, probe: async () => true }),
    );
    const r = await f.run();
    expect(r.blockers).toEqual(changed ? [upgradeHold] : []);
    expect(f.adapters.install).toHaveBeenCalledTimes(changed ? 0 : 1);
  },
);

test("a second project on the same machine has its own maintenance and authorization", async () => {
  const first = await setup();
  const second = await setup("linux", "second", first);
  first.enroll();
  expect(await first.run(pass)).toEqual(pass);
  expect(await second.run()).toEqual(mismatch);
  expect(first.actions()).toEqual([]);
  expect(second.actions()[0]?.instructions).toContain(
    `项目 second 的机器 ${machine}`,
  );
  const key = `${upgradeIdentity(first.root, "second", machine)}.bound`;
  writeFileSync(key, "synthetic", { mode: 0o600 });
  expect(enrolledUpgradeIdentity(first.root, "second", machine)).toBe(key);
  expect(upgradePrincipal("second", key).user).toBe(
    `cgu_${createHash("sha256").update("second").digest("hex").slice(0, 20)}`,
  );
  second.adapters.install.mockRejectedValueOnce(new Error("binding_failed"));
  expect((await second.run()).blockers).toEqual([upgradeHold]);
  expect(await first.run()).toEqual(pass);
  expect(first.isHeld()).toBe(false);
  expect(second.isHeld()).toBe(true);
  expect(first.adapters.install).toHaveBeenCalledOnce();
  expect(second.adapters.install).toHaveBeenCalledOnce();
});
test("drained enrolled worker waits for patrol without offering a manual install", async () => {
  const f = await setup();
  f.enroll();
  const paused = {
    blockers: [digestMismatch, "machine_not_ready"],
    launch_enabled: false,
  };
  expect(await f.run(paused)).toEqual(paused);
  expect(f.stageUpgrade).not.toHaveBeenCalled();
  expect(f.actions()).toEqual([]);
  expect(f.adapters.install).not.toHaveBeenCalled();
  expect(await f.run()).toEqual(pass);
  expect(f.adapters.install).toHaveBeenCalledOnce();
  expect(f.actions()).toEqual([]);
});

test("enrollment during manual staging cannot publish its stale command", async () => {
  const f = await setup();
  f.stageUpgrade.mockImplementationOnce(async () => {
    f.enroll();
    return f.terminal;
  });
  expect(await f.run()).toEqual(mismatch);
  expect(f.stageUpgrade).toHaveBeenCalledOnce();
  expect(f.actions()).toEqual([]);
  expect(f.adapters.install).not.toHaveBeenCalled();
});

test.each(["install", "worker_check", "machine_check"])(
  "failure at %s remains held across patrols, manual recovery cannot skip either check",
  async (stage) => {
    const f = await setup();
    f.enroll();
    if (stage === "install")
      f.adapters.install.mockRejectedValueOnce(new Error("private-fixture"));
    if (stage === "worker_check")
      f.adapters.workerCheck.mockResolvedValueOnce(false);
    if (stage === "machine_check")
      f.options.check.mockRejectedValueOnce(new Error());
    expect((await f.run()).blockers).toEqual([upgradeHold]);
    expect(f.isHeld()).toBe(true);
    expect((await f.run(pass)).blockers).toEqual([upgradeHold]);
    expect(f.actions()).toHaveLength(1);
    expect(f.stageUpgrade).not.toHaveBeenCalled();
    expect(f.actions()[0]?.instructions).toContain(stage);
    expect(f.actions()[0]?.instructions).not.toContain("private-fixture");
    expect(f.adapters.install).toHaveBeenCalledTimes(1);
    await f.manual("machine");
    expect(f.isHeld()).toBe(true);
    await f.manual("worker");
    await f.manual("machine", "different");
    expect(f.isHeld()).toBe(true);
    await f.manual("machine");
    expect(f.isHeld()).toBe(false);
  },
);
test.each(["failed", "installing", "worker_checked"])(
  "revoked enrollment: %s is held until both checks on the new key",
  async (state) => {
    const f = await setup();
    f.enroll();
    f.adapters.install.mockRejectedValueOnce(new Error());
    await f.run();
    if (state === "installing")
      f.store.database
        .prepare("UPDATE worker_helper_upgrades SET state='installing'")
        .run();
    if (state === "worker_checked") await f.manual("worker");
    rmSync(upgradeIdentity(f.options.execution.dataDir, project, machine));
    const binding = "new-binding";
    await f.run(pass, true, binding);
    expect(upgradeState(f.store, project, machine)).toMatchObject({
      release_key: upgradeKey(binding),
      state: "failed",
    });
    await f.manual("worker");
    await f.manual("machine", binding);
    expect(f.isHeld()).toBe(true);
    await f.manual("worker", binding);
    await f.manual("machine");
    expect(f.isHeld()).toBe(true);
    await f.manual("machine", binding);
    expect(f.isHeld()).toBe(false);
    expect(f.adapters.install).toHaveBeenCalledTimes(1);
  },
);
test("neither automatic nor manual recovery releases on a failed final observation", async () => {
  const f = await setup();
  f.enroll();
  await f.run(mismatch, false);
  expect(f.isHeld()).toBe(true);
  expect(f.actions()[0]?.instructions).toContain("machine_check");
  expect(
    f.store.uow
      .read((tx) => tx.events.listAfter(project, undefined, 0))
      .some((e) => e.type === "worker_helper_upgrade_verified"),
  ).toBe(false);
  await f.manual("worker");
  await f.manual("machine", f.target.fingerprint, true, false);
  expect(f.isHeld()).toBe(true);
  await f.manual("machine");
  expect(f.isHeld()).toBe(false);
});
test("failed and interrupted worker checks supersede earlier success", async () => {
  const f = await setup();
  f.enroll();
  f.adapters.install.mockRejectedValueOnce(new Error());
  await f.run();
  await f.manual("worker");
  await f.manual("worker", f.target.fingerprint, false);
  await f.manual("machine");
  expect(f.isHeld()).toBe(true);
  await f.manual("worker");
  const { job } = f.journal.claim(project, machine, "worker", "web");
  await expect(
    f.journal.execute(
      job,
      async () => {
        throw new Error("aborted");
      },
      () => ({ status: "passed", failed_steps: [] }),
    ),
  ).rejects.toThrow();
  await f.manual("machine");
  expect(f.isHeld()).toBe(true);
});
test("new release without positive mismatch evidence never writes helpers", async () => {
  const f = await setup();
  f.enroll();
  f.adapters.install.mockRejectedValueOnce(new Error());
  await f.run();
  f.store.database
    .prepare("UPDATE worker_helper_upgrades SET release_key='old'")
    .run();
  await f.run({ blockers: ["connection failed"], launch_enabled: false });
  expect(f.isHeld()).toBe(true);
  expect(f.adapters.workerCheck).not.toHaveBeenCalled();
  await f.run(pass);
  expect(f.isHeld()).toBe(false);
  expect(f.adapters.install).toHaveBeenCalledTimes(1);
  expect(f.adapters.workerCheck).toHaveBeenCalledOnce();
});
test("changing binding before installation cannot use the enrolled key", async () => {
  const f = await setup();
  f.enroll();
  f.options.bindingCurrent.mockReturnValue(false);
  expect((await f.run()).blockers).toEqual([upgradeHold]);
  expect(f.adapters.install).not.toHaveBeenCalled();
});
test("root entry uses only a pinned signer, fixed files and unprivileged test fixtures", () => {
  execFileSync(
    "/usr/bin/python3",
    [
      "-IB",
      fileURLToPath(
        new URL("../test-support/worker-upgrade-test.py", import.meta.url),
      ),
    ],
    { timeout: 15000 },
  );
});

test("signs only the approved running deployment commit, not a changed worktree or pending release", async () => {
  const f = await setup(),
    worker = f.options.execution,
    root = worker.dataDir;
  const central = join(root, "central"),
    repo = join(central, "cardigan.git"),
    tree = join(root, "fixture"),
    deploy = join(tree, "deploy"),
    state = join(root, "self-deploy");
  for (const path of [central, repo, tree, deploy, state])
    mkdirSync(path, { mode: 0o700 });
  const git = (args: string[]) =>
    execFileSync("/usr/bin/git", args, {
      env: {
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      encoding: "utf8",
    }).trim();
  git(["init", "-q", "--bare", repo]);
  const prefix = [
    "--git-dir",
    repo,
    "--work-tree",
    tree,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
  ];
  mkdirSync(join(deploy, "agent-tools"), { mode: 0o700 });
  for (const n of [...helpers, ...toolEntries])
    copyFileSync(
      fileURLToPath(new URL(`../../../deploy/${n}`, import.meta.url)),
      join(deploy, n),
    );
  git([...prefix, "add", "--", "deploy"]);
  git([...prefix, "commit", "-qm", "fixture"]);
  const release = resolve(fileURLToPath(new URL("../../..", import.meta.url))),
    sha = git([...prefix, "rev-parse", "HEAD"]);
  const writeState = (current: string) =>
    writeFileSync(
      join(state, "state.json"),
      JSON.stringify({
        running: { release, sha },
        current: { release: current, sha },
      }),
      { mode: 0o600 },
    );
  const identity = upgradeIdentity(root, project, machine);
  f.enroll();
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  writeFileSync(
    `${identity}.signer.pem`,
    privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  writeState(tree);
  await expect(signedHelperBundle(worker, project, identity)).rejects.toThrow();
  writeState(release);
  writeFileSync(join(deploy, helpers[0]), "not a release");
  const bundle = await signedHelperBundle(worker, project, identity);
  expect(
    verify(
      "RSA-SHA256",
      Buffer.from(bundle.manifest),
      publicKey,
      Buffer.from(bundle.signature, "base64"),
    ),
  ).toBe(true);
  for (const n of helpers)
    expect(
      createHash("sha256")
        .update(Buffer.from(bundle.files[n] ?? "", "base64"))
        .digest("hex"),
    ).toBe(workerHelperDigests()[n]);
  // C-595: v2 also carries the attachment tools; v1 stays byte-compatible.
  const tools = agentToolsRelease();
  expect(JSON.parse(bundle.manifest)).toMatchObject({
    kind: "cardigan-helper-v2",
    digests: Object.fromEntries(
      AGENT_TOOLS.map((n) => [`agent-tools/${n}`, tools?.digests[n]]),
    ),
  });
  expect(Object.keys(bundle.files).sort()).toEqual(
    [...helpers, ...toolEntries].sort(),
  );
  const legacy = await signedHelperBundle(
    worker,
    project,
    identity,
    undefined,
    "v1",
  );
  expect(JSON.parse(legacy.manifest)).toMatchObject({
    kind: "cardigan-helper-v1",
    digests: workerHelperDigests(),
  });
  expect(Object.keys(legacy.files).sort()).toEqual([...helpers].sort());
});

test("an entry enrolled before C-595 gets the unchanged v1 bundle after refusing v2", async () => {
  const f = await setup();
  const worker = f.options.execution;
  const before = Object.fromEntries(helpers.map((n) => [n, "a".repeat(64)]));
  const send = vi.fn(async (...args: unknown[]) => {
    if (args[3] === "v2") throw new Error("worker_upgrade_install_failed");
    return before;
  });
  await expect(
    installRelease(worker, project, "identity", undefined, send),
  ).resolves.toEqual(before);
  expect(send.mock.calls.map((call) => call[3])).toEqual(["v2", "v1"]);
  // A v2 entry succeeds first time; a controller-side refusal is never retried.
  send.mockClear();
  send.mockResolvedValueOnce(before);
  await installRelease(worker, project, "identity", undefined, send);
  expect(send.mock.calls.map((call) => call[3])).toEqual(["v2"]);
  send.mockClear();
  send.mockRejectedValueOnce(new Error("worker_upgrade_unavailable"));
  await expect(
    installRelease(worker, project, "identity", undefined, send),
  ).rejects.toThrow("worker_upgrade_unavailable");
  expect(send).toHaveBeenCalledOnce();
});

// C-599: registered (enrolled) and manual workers whose helpers are current but
// whose attachment tools are missing or stale.
const missing = "agent-tools missing:download-attachment.mjs";
const v2Result = {
  "worker-files.py": "0".repeat(64),
  "agent-tools/download-attachment.mjs": "none",
  "agent-tools/upload-evidence.mjs": "none",
};
type Fixture = Awaited<ReturnType<typeof setup>>;
const toolsPayload = (f: Fixture) =>
  f.store.uow
    .read((tx) => tx.events.listAfter(project, undefined, 0))
    .filter((e) => e.type === "worker_helper_upgrade_verified")
    .map((e) => (e.payload as { agent_tools?: string }).agent_tools);
const open = (f: Fixture) => f.actions().filter((a) => a.status === "open");

test.each(["linux", "macos"])(
  "C-599 %s: an enrolled v2 entry installs missing tools once and reports them verified",
  async (os) => {
    const f = await setup(os);
    f.enroll();
    f.tools.output = missing;
    const toolsStale = vi.fn(async () =>
      f.tools.output !== "agent-tools ok"
        ? ("stale" as const)
        : ("current" as const),
    );
    Object.assign(f.adapters, { toolsStale });
    f.adapters.install.mockImplementationOnce(async () => {
      expect(f.isHeld()).toBe(true);
      f.tools.output = "agent-tools ok";
      return v2Result;
    });
    expect(await f.run(pass)).toEqual(pass);
    expect(toolsStale).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "agent-ssh" }),
      machine,
      os === "macos" ? "darwin" : "linux",
      undefined,
    );
    expect(f.adapters.install).toHaveBeenCalledOnce();
    expect(f.isHeld()).toBe(false);
    expect(toolsPayload(f)).toEqual(["verified"]);
    expect(f.last()?.agent_tools).toEqual({ status: "current" });
    expect(f.actions()).toEqual([]);
    // The same release key is never probed or installed again.
    expect(await f.run(pass)).toEqual(pass);
    expect(toolsStale).toHaveBeenCalledOnce();
    expect(f.adapters.install).toHaveBeenCalledOnce();
  },
);

test.each([
  ["v2", v2Result, "unverified"],
  ["v1", { "worker-files.py": "0".repeat(64) }, "entry_v1_needs_migration"],
] as const)(
  "C-599: a %s result that leaves the tools stale is never reported installed nor retried",
  async (_entry, result, outcome) => {
    const f = await setup("linux");
    f.enroll();
    f.tools.output = missing;
    Object.assign(f.adapters, {
      toolsStale: vi.fn(async () => "stale" as const),
    });
    f.adapters.install.mockResolvedValueOnce(result);
    // Tools never block dispatch: the helpers are verified, the tools are not.
    expect(await f.run(pass)).toEqual(pass);
    expect(f.isHeld()).toBe(false);
    expect(toolsPayload(f)).toEqual([outcome]);
    const [notice] = open(f);
    expect(notice).toMatchObject({
      terminal: f.terminal,
      instructions: expect.stringContaining("v1 入口只能更新三个 helper"),
    });
    expect(notice?.helper_upgrade).toBeUndefined();
    expect(f.last()?.agent_tools).toMatchObject({
      status: "ready",
      human_action_id: notice?.id,
    });
    expect(await f.run(pass)).toEqual(pass);
    expect(f.adapters.install).toHaveBeenCalledOnce();
    expect(open(f).map((a) => a.id)).toEqual([notice?.id]);
    expect(f.stageUpgrade).toHaveBeenCalledTimes(2);
  },
);

test("C-599: a tools-only refresh does not hold dispatch while it cannot start", async () => {
  const f = await setup("linux");
  f.enroll();
  f.tools.output = missing;
  Object.assign(f.adapters, {
    toolsStale: vi.fn(async () => "stale" as const),
  });
  f.adapters.promotionPending = () => true;
  expect(await f.run(pass)).toEqual(pass);
  expect(f.adapters.install).not.toHaveBeenCalled();
  expect(upgradeState(f.store, project, machine)).toBeUndefined();
  // Until the patrol has tried this release, no administrator command is offered.
  expect(f.last()?.agent_tools).toEqual({ status: "automatic" });
  expect(f.stageUpgrade).not.toHaveBeenCalled();
  expect(f.actions()).toEqual([]);
  f.adapters.promotionPending = () => false;
  f.adapters.install.mockResolvedValueOnce(v2Result);
  expect(await f.run(pass)).toEqual(pass);
  expect(f.adapters.install).toHaveBeenCalledOnce();
});

test("C-599: a failed tools install after the claim holds dispatch and offers no tools command", async () => {
  const f = await setup("linux");
  f.enroll();
  f.tools.output = missing;
  Object.assign(f.adapters, {
    toolsStale: vi.fn(async () => "stale" as const),
  });
  f.adapters.install.mockRejectedValueOnce(new Error("ssh"));
  expect((await f.run(pass)).blockers).toEqual([upgradeHold]);
  expect(f.isHeld()).toBe(true);
  expect(f.last()?.agent_tools).toBeUndefined();
  expect(f.stageUpgrade).not.toHaveBeenCalled();
  expect(open(f).map((a) => a.instructions)).toEqual([
    expect.stringContaining("helper 自动升级未获验证（install）"),
  ]);
});

test("C-599: a manual worker's notice is re-staged after a failure and replaced on any change", async () => {
  const f = await setup("linux");
  f.tools.output = missing;
  const staged = (command: string) => ({ ...f.terminal, command });
  f.stageUpgrade.mockRejectedValueOnce(new Error("transient"));
  await f.manual("machine");
  const [unstaged] = open(f);
  expect(unstaged?.terminal).toBeUndefined();
  expect(unstaged?.instructions).toContain("暂存失败");
  expect(unstaged?.instructions).toContain("该机未登记签名自动升级");
  expect(f.last()?.agent_tools?.status).toBe("staging_failed");
  // Re-staging succeeds: the command-less notice is replaced, not kept.
  f.stageUpgrade.mockResolvedValue(staged("staged-command-1"));
  await f.manual("machine");
  const [first] = open(f);
  expect(first?.id).not.toBe(unstaged?.id);
  expect(first?.terminal?.command).toBe("staged-command-1");
  await f.manual("machine");
  expect(open(f).map((a) => a.id)).toEqual([first?.id]);
  // Same tools, different release bundle or staged script.
  f.stageUpgrade.mockResolvedValue(staged("staged-command-2"));
  await f.manual("machine");
  const [second] = open(f);
  expect(second?.terminal?.command).toBe("staged-command-2");
  // Same staged bytes, different binding.
  await f.manual("machine", "rebound");
  const [rebound] = open(f);
  expect(rebound?.id).not.toBe(second?.id);
  // Only the latest notice is open; the old ones are retired, not reported done.
  expect(
    f
      .actions()
      .filter((a) => a.id !== rebound?.id)
      .map((a) => [a.status, a.cancellation?.by]),
  ).toEqual(Array(3).fill(["cancelled", "system"]));
  // An unverifiable result never keeps the old command.
  f.tools.output = "unexpected";
  await f.manual("machine", "rebound");
  expect(open(f)).toEqual([]);
  expect(f.last()?.agent_tools).toEqual({ status: "unverifiable" });
  f.tools.output = missing;
  await f.manual("machine", "rebound");
  expect(open(f)).toHaveLength(1);
  f.tools.output = "agent-tools ok";
  await f.manual("machine", "rebound");
  expect(open(f)).toEqual([]);
  expect(f.last()?.agent_tools).toEqual({ status: "current" });
  // Neither history nor the stored job replays a command.
  const history = JSON.stringify([
    readMachineObservations(f.store, project, machine),
    f.store.database.prepare("SELECT doc FROM machine_check_jobs").all(),
  ]);
  expect(history).not.toContain("staged-command");
});

test("C-599: an enrolled worker's explicit check waits for the patrol's first attempt", async () => {
  const f = await setup("linux");
  f.enroll();
  f.tools.output = missing;
  await f.manual("machine");
  expect(f.last()?.agent_tools).toEqual({ status: "automatic" });
  expect(f.stageUpgrade).not.toHaveBeenCalled();
  expect(f.actions()).toEqual([]);
});

test("C-599: standalone and joined explicit checks get the same verified command; history never does", async () => {
  const f = await setup("linux");
  f.tools.output = missing;
  // The real staged command, so the explicit caller can re-derive and compare it.
  f.stageUpgrade.mockImplementation(
    async (worker, os) => upgradeMaterials(worker, os).terminal,
  );
  const runtime = (fingerprint = f.target.fingerprint) =>
    ({
      resolve: () => ({
        execution: {
          ...f.options.execution,
          target: { ...f.target, fingerprint },
        },
        machine: f.registered,
      }),
      check: async () => ({ ok: true, value: pass }),
    }) as unknown as RuntimeTargets;
  const options = {
    store: f.store,
    project,
    machine,
    env: f.options.env,
    stageUpgrade: f.stageUpgrade,
    catalog: () => [agentToolsCapability(f.options.execution, machine)],
    probe: async () => ({ ok: true as const, output: missing }),
  };
  const standalone = await checkRegisteredMachine(options, () => runtime());
  const guidance = (standalone as { agent_tools_guidance?: unknown })
    .agent_tools_guidance;
  const [notice] = open(f);
  const command = upgradeMaterials(
    f.options.execution as Parameters<typeof upgradeMaterials>[0],
    "linux",
  ).terminal.command;
  expect(guidance).toEqual({
    status: "ready",
    message: expect.any(String),
    human_action_id: notice?.id,
    terminal: expect.objectContaining({ command }),
  });
  // Join a patrol observation that is still running.
  const gate = Promise.withResolvers<void>();
  const patrol = checkRegisteredMachine(
    options,
    async () => {
      await gate.promise;
      return runtime();
    },
    "patrol",
  );
  const joined = checkRegisteredMachine(options, () => runtime());
  gate.resolve();
  const [p, j] = await Promise.all([patrol, joined]);
  expect(p.health?.evidence_ref).toBe(j.health?.evidence_ref);
  expect(p).not.toHaveProperty("agent_tools_guidance");
  expect(j).toHaveProperty("agent_tools_guidance", guidance);
  // A binding change after the observation never returns its command.
  let calls = 0;
  const rebound = await checkRegisteredMachine(options, () =>
    calls++ ? runtime("rebound") : runtime(),
  );
  expect(rebound).toHaveProperty("agent_tools_guidance", {
    status: "changed",
    message: expect.any(String),
  });
  expect(JSON.stringify(rebound)).not.toContain(command);
  // `machine show` and stored check jobs carry no command.
  expect(
    JSON.stringify([
      readMachineObservations(f.store, project, machine),
      f.store.database.prepare("SELECT doc FROM machine_check_jobs").all(),
    ]),
  ).not.toContain(command);
});

test("C-599: any failed observation retires the tools notice; helper mismatch keeps only the helper one", async () => {
  const f = await setup("linux");
  f.tools.output = missing;
  f.stageUpgrade.mockResolvedValue({ ...f.terminal, command: "tools-command" });
  await f.manual("machine");
  expect(open(f).map((a) => a.terminal?.command)).toEqual(["tools-command"]);
  // Offline / target problem: nothing verified, no command survives.
  await f.manual("machine", f.target.fingerprint, false);
  expect(open(f)).toEqual([]);
  await f.manual("machine");
  expect(open(f)).toHaveLength(1);
  // A new release whose helpers differ: only the helper upgrade notice remains.
  f.stageUpgrade.mockResolvedValue({
    ...f.terminal,
    command: "helper-command",
  });
  expect(await f.run(mismatch)).toEqual(mismatch);
  expect(open(f)).toEqual([
    expect.objectContaining({
      terminal: expect.objectContaining({ command: "helper-command" }),
      helper_upgrade: { machine_id: machine, binding: f.target.fingerprint },
    }),
  ]);
});

test("C-599: a held worker recovering under a new key also installs stale tools", async () => {
  const f = await setup("linux");
  f.enroll();
  f.store.database
    .prepare(
      "INSERT INTO worker_helper_upgrades(project_id,machine_id,release_key,state) VALUES (?,?,?,'failed')",
    )
    .run(project, machine, "old-key");
  f.tools.output = missing;
  Object.assign(f.adapters, {
    toolsStale: vi.fn(async () => "stale" as const),
  });
  f.adapters.install.mockImplementationOnce(async () => {
    f.tools.output = "agent-tools ok";
    return v2Result;
  });
  expect(await f.run(pass)).toEqual(pass);
  expect(f.adapters.install).toHaveBeenCalledOnce();
  expect(f.isHeld()).toBe(false);
  expect(toolsPayload(f)).toEqual(["verified"]);
});

test("C-599: a tools-only refresh that fails before sending anything does not hold dispatch", async () => {
  const f = await setup("linux");
  f.enroll();
  f.tools.output = missing;
  Object.assign(f.adapters, {
    toolsStale: vi.fn(async () => "stale" as const),
  });
  f.options.bindingCurrent.mockReturnValue(false);
  expect(await f.run(pass)).toEqual(pass);
  expect(f.adapters.install).not.toHaveBeenCalled();
  expect(f.isHeld()).toBe(false);
  expect(upgradeState(f.store, project, machine)).toBeUndefined();
  expect(open(f)).toEqual([]);
  f.options.bindingCurrent.mockReturnValue(true);
  f.adapters.install.mockResolvedValueOnce(v2Result);
  expect(await f.run(pass)).toEqual(pass);
  expect(f.adapters.install).toHaveBeenCalledOnce();
});

test("C-599: current tools are probed once per release key, not on every patrol", async () => {
  const f = await setup("linux");
  f.enroll();
  f.tools.output = "agent-tools ok";
  const toolsStale = vi.fn(async () => "current" as const);
  Object.assign(f.adapters, { toolsStale });
  expect(await f.run(pass)).toEqual(pass);
  expect(await f.run(pass)).toEqual(pass);
  expect(toolsStale).toHaveBeenCalledOnce();
  expect(f.adapters.install).not.toHaveBeenCalled();
});

test("C-599: an unknown probe is never remembered; a later stale probe installs", async () => {
  const f = await setup("linux");
  f.enroll();
  f.tools.output = missing;
  const toolsStale = vi
    .fn<() => Promise<"stale" | "current" | "unknown">>()
    .mockResolvedValueOnce("unknown")
    .mockResolvedValue("stale");
  Object.assign(f.adapters, { toolsStale });
  f.adapters.install.mockResolvedValueOnce(v2Result);
  expect(await f.run(pass)).toEqual(pass);
  expect(f.adapters.install).not.toHaveBeenCalled();
  expect(await f.run(pass)).toEqual(pass);
  expect(toolsStale).toHaveBeenCalledTimes(2);
  expect(f.adapters.install).toHaveBeenCalledOnce();
});

test("C-599: a stale observation forgets an earlier current probe", async () => {
  const f = await setup("linux");
  f.enroll();
  f.tools.output = "agent-tools ok";
  const toolsStale = vi
    .fn<() => Promise<"stale" | "current" | "unknown">>()
    .mockResolvedValueOnce("current")
    .mockResolvedValue("stale");
  Object.assign(f.adapters, { toolsStale });
  expect(await f.run(pass)).toEqual(pass);
  // The tools drift under the same key: the outer observation reports it.
  f.tools.output = missing;
  expect(await f.run(pass)).toEqual(pass);
  expect(toolsStale).toHaveBeenCalledTimes(1);
  expect(f.last()?.agent_tools).toEqual({ status: "automatic" });
  f.adapters.install.mockResolvedValueOnce(v2Result);
  expect(await f.run(pass)).toEqual(pass);
  expect(toolsStale).toHaveBeenCalledTimes(2);
  expect(f.adapters.install).toHaveBeenCalledOnce();
});

test("C-599: a tools-only release refused locally before sending does not hold dispatch", async () => {
  const f = await setup("linux");
  f.enroll();
  f.tools.output = missing;
  Object.assign(f.adapters, {
    toolsStale: vi.fn(async () => "stale" as const),
  });
  f.adapters.install.mockRejectedValueOnce(new Error(WORKER_UPGRADE_NOT_SENT));
  expect(await f.run(pass)).toEqual(pass);
  expect(f.isHeld()).toBe(false);
  expect(upgradeState(f.store, project, machine)).toBeUndefined();
  expect(open(f)).toEqual([]);
  // A helper upgrade that is refused locally still holds, as before.
  f.adapters.install.mockRejectedValueOnce(new Error(WORKER_UPGRADE_NOT_SENT));
  expect((await f.run(mismatch)).blockers).toEqual([upgradeHold]);
});

test("C-599: the local bundle refusal is reported as not sent, before any SSH", async () => {
  const f = await setup();
  // No deployment state: signing refuses locally.
  await expect(
    installRelease(f.options.execution, project, "identity"),
  ).rejects.toThrow(WORKER_UPGRADE_NOT_SENT);
});

test("C-599: rebinding while staging retires the old notice and offers no command", async () => {
  const f = await setup("linux");
  f.tools.output = missing;
  f.stageUpgrade.mockResolvedValue({ ...f.terminal, command: "old-binding" });
  await f.manual("machine");
  expect(open(f)).toHaveLength(1);
  f.stageUpgrade.mockImplementationOnce(async () => {
    f.tools.binding = "moved";
    return { ...f.terminal, command: "old-binding" };
  });
  await f.manual("machine");
  expect(open(f)).toEqual([]);
  expect(f.last()?.agent_tools).toEqual({ status: "unverifiable" });
});

test("C-599: enrollment completed while staging never publishes a manual command", async () => {
  const f = await setup("linux");
  f.tools.output = missing;
  f.stageUpgrade.mockImplementationOnce(async () => {
    f.enroll();
    return f.terminal;
  });
  await f.manual("machine");
  expect(open(f)).toEqual([]);
  expect(f.last()?.agent_tools).toEqual({ status: "automatic" });
});

test("C-599: v2 reached the worker but v1 was refused locally: the attempt still holds", async () => {
  const f = await setup("linux");
  f.enroll();
  f.tools.output = missing;
  Object.assign(f.adapters, {
    toolsStale: vi.fn(async () => "stale" as const),
  });
  const send = vi.fn(async (...args: unknown[]) => {
    if (args[3] === "v2") throw new Error("worker_upgrade_install_failed");
    throw new Error(WORKER_UPGRADE_NOT_SENT);
  });
  f.adapters.install.mockImplementationOnce((worker, p, identity, signal) =>
    installRelease(worker, p, identity, signal, send),
  );
  expect((await f.run(pass)).blockers).toEqual([upgradeHold]);
  expect(send.mock.calls.map((call) => call[3])).toEqual(["v2", "v1"]);
  expect(f.isHeld()).toBe(true);
  expect(upgradeState(f.store, project, machine)).toMatchObject({
    state: "failed",
  });
  // Only a v2 refused before sending is a clean skip.
  await expect(
    installRelease(
      f.options.execution,
      project,
      "identity",
      undefined,
      async () => {
        throw new Error(WORKER_UPGRADE_NOT_SENT);
      },
    ),
  ).rejects.toThrow(WORKER_UPGRADE_NOT_SENT);
});

// Q-1187: staging a notice inside an observation never authorises showing its
// command; only a settled recheck of the current binding and release does.
test.each([
  ["v1 fallback", { "worker-files.py": "0".repeat(64) }, true],
  ["v2 recheck failed", v2Result, true],
  ["v2 ready", v2Result, false],
] as const)(
  "C-599: %s: no command while the check or signed attempt runs, only the settled recheck decides",
  async (_name, result, staysStale) => {
    const f = await setup("linux");
    f.tools.output = missing;
    f.stageUpgrade.mockImplementation(
      async (worker, os) => upgradeMaterials(worker, os).terminal,
    );
    const command = upgradeMaterials(
      f.options.execution as Parameters<typeof upgradeMaterials>[0],
      "linux",
    ).terminal.command;
    const visible = () =>
      agentToolsCommandVisible(
        f.store,
        project,
        machine,
        f.registered,
        f.target.fingerprint,
        f.options.env,
      );
    const resolved = {
      execution: f.options.execution,
      machine: f.registered,
    };
    // Unenrolled: the settled observation staged a notice whose command shows.
    await f.manual("machine");
    const [manual] = open(f);
    expect(manual?.terminal?.command).toBe(command);
    expect(visible()).toBe(true);
    // Enrolled: the signed upgrade owns this release's first attempt.
    f.enroll();
    expect(visible()).toBe(false);
    const probing = Promise.withResolvers<void>(),
      probe = Promise.withResolvers<void>(),
      sending = Promise.withResolvers<void>(),
      send = Promise.withResolvers<void>();
    Object.assign(f.adapters, {
      toolsStale: vi.fn(async () => {
        probing.resolve();
        await probe.promise;
        return "stale" as const;
      }),
    });
    f.adapters.install.mockImplementationOnce(async () => {
      sending.resolve();
      await send.promise;
      if (!staysStale) f.tools.output = "agent-tools ok";
      return result;
    });
    const patrol = f.run(pass);
    // The check has started but has not claimed the signed attempt yet.
    await probing.promise;
    expect(f.journal.running(machine)).toBe(true);
    expect(upgradeState(f.store, project, machine)).toBeUndefined();
    expect(open(f).map((a) => a.terminal?.command)).toEqual([command]);
    expect(visible()).toBe(false);
    probe.resolve();
    // The signed attempt is transferring: dispatch is paused, the attempt is not over.
    await sending.promise;
    expect(upgradeState(f.store, project, machine)).toMatchObject({
      state: "installing",
      pending_final: null,
    });
    expect(f.isHeld()).toBe(true);
    expect(f.adapters.workerCheck).not.toHaveBeenCalled();
    expect(visible()).toBe(false);
    // The CLI guidance follows the same rule for an earlier ready outcome.
    expect(
      agentToolsGuidance(
        f.store,
        project,
        machine,
        {
          status: "ready",
          human_action_id: manual?.id ?? "",
          key: String(f.last()?.agent_tools?.key),
        },
        resolved,
        f.options.env,
      ),
    ).toMatchObject({ status: "changed" });
    send.resolve();
    expect(await patrol).toEqual(pass);
    expect(upgradeState(f.store, project, machine)).toMatchObject({
      state: "verified",
    });
    expect(f.journal.running(machine)).toBe(false);
    expect(visible()).toBe(staysStale);
    const notices = open(f);
    if (!staysStale) {
      expect(notices).toEqual([]);
      expect(f.last()?.agent_tools).toEqual({ status: "current" });
      return;
    }
    // The recheck of this attempt re-staged the same key: still one notice,
    // hidden throughout the attempt and shown only now.
    expect(notices.map((a) => a.id)).toEqual([manual?.id]);
    expect(notices[0]?.terminal?.command).toBe(command);
    const outcome = f.last()?.agent_tools;
    expect(outcome).toMatchObject({
      status: "ready",
      human_action_id: notices[0]?.id,
    });
    expect(
      agentToolsGuidance(
        f.store,
        project,
        machine,
        outcome,
        resolved,
        f.options.env,
      ),
    ).toMatchObject({ status: "ready", terminal: { command } });
    // A later check that has started hides it again until it settles.
    const { job } = f.journal.claim(project, machine, "machine", "patrol");
    expect(visible()).toBe(false);
    expect(
      agentToolsGuidance(
        f.store,
        project,
        machine,
        outcome,
        resolved,
        f.options.env,
      ),
    ).toMatchObject({ status: "changed" });
    await f.journal.execute(
      job,
      async () => undefined,
      () => ({ status: "failed", failed_steps: ["fixture"] }),
    );
    expect(visible()).toBe(true);
    // Another binding's or platform's observation never shows this command.
    expect(
      agentToolsCommandVisible(
        f.store,
        project,
        machine,
        f.registered,
        "rebound",
        f.options.env,
      ),
    ).toBe(false);
    expect(
      agentToolsCommandVisible(
        f.store,
        project,
        machine,
        { ...f.registered, arch: "x64" },
        f.target.fingerprint,
        f.options.env,
      ),
    ).toBe(false);
    expect(f.adapters.install).toHaveBeenCalledOnce();
  },
);

test("C-599: a failed signed attempt and a failed observation never show the tools command", async () => {
  const f = await setup("linux");
  f.tools.output = missing;
  const visible = () =>
    agentToolsCommandVisible(
      f.store,
      project,
      machine,
      f.registered,
      f.target.fingerprint,
      f.options.env,
    );
  await f.manual("machine");
  expect(visible()).toBe(true);
  // The observation could not verify anything.
  await f.manual("machine", f.target.fingerprint, true, false);
  expect(visible()).toBe(false);
  await f.manual("machine");
  expect(visible()).toBe(true);
  // Unknown tools state is never a reason to show a command.
  f.tools.output = "unexpected";
  await f.manual("machine");
  expect(visible()).toBe(false);
  f.tools.output = missing;
  f.enroll();
  Object.assign(f.adapters, {
    toolsStale: vi.fn(async () => "stale" as const),
  });
  f.adapters.install.mockRejectedValueOnce(new Error("ssh"));
  expect((await f.run(pass)).blockers).toEqual([upgradeHold]);
  expect(upgradeState(f.store, project, machine)).toMatchObject({
    state: "failed",
  });
  expect(visible()).toBe(false);
});
