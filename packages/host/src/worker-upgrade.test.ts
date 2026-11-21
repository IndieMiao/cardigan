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
import { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { runtimeTargetBinding } from "./runtime-target-fingerprint.js";
import {
  digestMismatch,
  helpers,
  workerHelperDigests,
} from "./worker-helper-release.js";
import { patrolHelperUpgrade } from "./worker-upgrade.js";
import {
  manualMachineChecked,
  manualWorkerChecked,
  upgradeHeld,
  upgradeHold,
} from "./worker-upgrade-gate.js";
import {
  signedHelperBundle,
  upgradeIdentity,
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
function setup(os = "linux") {
  const root = mkdtempSync(join(tmpdir(), "helper-upgrade-"));
  const store = Store.open({ dataDir: root });
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
    account: "cg_sample",
    uid: 2201,
    gid: 2201,
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
  const run = (initial: typeof mismatch = mismatch) =>
    patrolHelperUpgrade(options, initial, adapters);
  const enroll = () =>
    writeFileSync(upgradeIdentity(root, project, machine), "synthetic", {
      mode: 0o600,
    });
  return {
    run,
    options,
    adapters,
    enroll,
    isHeld,
    target,
    store,
    actions: () => store.uow.read((tx) => tx.human_actions.list(project)),
  };
}
test.each(["linux", "macos"])(
  "%s: opt-in, install, both checks, audited release and drift fence",
  async (os) => {
    const f = setup(os);
    expect(await f.run()).toEqual(mismatch);
    expect(f.adapters.install).not.toHaveBeenCalled();
    f.enroll();
    expect(await f.run()).toEqual(pass);
    expect(f.adapters.install).toHaveBeenCalledBefore(f.adapters.workerCheck);
    expect(f.adapters.workerCheck).toHaveBeenCalledBefore(f.options.check);
    expect(f.isHeld()).toBe(false);
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
    expect(f.actions()[0]?.instructions).toContain(stage);
    expect(f.actions()[0]?.instructions).not.toContain("private-fixture");
    expect(f.adapters.install).toHaveBeenCalledTimes(1);
    manualMachineChecked(f.store, project, machine, f.target.fingerprint);
    expect(f.isHeld()).toBe(true);
    manualWorkerChecked(f.store, project, machine, f.target.fingerprint);
    manualMachineChecked(f.store, project, machine, "different");
    expect(f.isHeld()).toBe(true);
    manualMachineChecked(f.store, project, machine, f.target.fingerprint);
    expect(f.isHeld()).toBe(false);
  },
);
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
