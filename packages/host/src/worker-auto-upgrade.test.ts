import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Machine } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { refreshMachineObservations } from "./machine-capabilities.js";
import { MachineCheckJournal } from "./machine-check-journal.js";
import { runtimeTargetBinding } from "./runtime-target-fingerprint.js";
import { patrolHelperUpgrade } from "./worker-auto-upgrade.js";
import {
  digestMismatch,
  helpers,
  workerHelperDigests,
} from "./worker-helper-release.js";
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
  signedHelperBundle,
  upgradePrincipal,
} from "./worker-upgrade-transport.js";
import { workerWizardForm } from "./worker-wizard-form.js";

const project = "sample",
  machine = "worker-a",
  mismatch = { blockers: [digestMismatch], launch_enabled: false },
  pass = { blockers: [], launch_enabled: true };
let cleanup = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});
function setup(
  os = "linux",
  project = "sample",
  shared?: { root: string; store: Store },
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
  const target = runtimeTargetBinding(form.config.worker);
  const isHeld = () => upgradeHeld(store, project, machine);
  const options = {
    store,
    project,
    machine,
    env: { CARDIGAN_CONFIG_DIR: root },
    execution: { ...form.config.worker.execution, target },
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
    workerCheck: vi.fn(async () => {
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
  const stageUpgrade = vi.fn(async () => terminal);
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
              target: { ...target, fingerprint: binding },
            },
          }),
          check: () => raw(job.id),
          catalog: () => {
            if (!outerOK) throw new Error("probe interrupted");
            return [];
          },
        }),
      (v) => ({
        status: v.health?.available ? "passed" : "failed",
        failed_steps: [],
      }),
    );
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
    actions: () => store.uow.read((tx) => tx.human_actions.list(project)),
  };
}
test.each(["linux", "macos"])(
  "%s: opt-in, install, both checks, audited release and drift fence",
  async (os) => {
    const f = setup(os);
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
test("a second project on the same machine has its own maintenance and authorization", async () => {
  const first = setup();
  const second = setup("linux", "second", first);
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
  const f = setup();
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
  const f = setup();
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
    const f = setup();
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
    const f = setup();
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
  const f = setup();
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
  const f = setup();
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
  const f = setup();
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
  const f = setup();
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
  const f = setup(),
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
  for (const n of helpers)
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
});
