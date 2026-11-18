import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HC_RELEASE } from "@cardigan/runtime-herdr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { CpuProfileDirectory } from "./cpu-profile-files.js";
import {
  checkWorkerDraft,
  onboardWorker,
  parseWorkerOnboarding,
  readOnboardingYaml,
  WORKER_PROBE_SCRIPT,
  WORKER_PROBES,
  WORKER_STEPS,
  type WorkerOnboardingOptions,
  type WorkerProbe,
  workerOnboardingStatus,
  workerProbeInput,
} from "./worker-onboarding.js";

let root: string;
const dataDir = "/private/controller-data";
function first<T>(values: T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
function input() {
  return {
    version: 1,
    uid: 2201,
    home: "/home/cg_example",
    mcp_url: "https://control.example.ts.net/mcp",
    runtime: {
      version: 1,
      machines: [
        {
          id: "worker-a",
          os: "linux",
          arch: "x64",
          host: "worker.invalid",
          port: 22,
          identity_file: "/private/identity",
          known_hosts_file: "/private/known_hosts",
          host_key_alias: "worker-a",
          projects: [
            {
              project_id: "example",
              user: "cg_example",
              gid: 2201,
              alias: "example-a",
              session: "example-a",
              root: "/workers/example",
              path: "/usr/local/bin:/usr/bin:/bin",
              generation: "one",
              mcp_url: "https://control.example.ts.net/mcp",
              publication: {
                header_max_bytes: 65536,
                file_max_bytes: 1048576,
                batch_max_bytes: 8388608,
                timeout_ms: 30000,
              },
              python: "/usr/bin/python3",
              file_helper: "/workers/example/libexec/worker-files.py",
              git_helper: "/workers/example/libexec/worker-git.py",
            },
          ],
        },
      ],
    },
  };
}
const journalPath = () => join(root, "worker-onboarding/worker-a/example.json");
const draftPath = () =>
  join(root, "worker-onboarding/worker-a/example.runtime-workers.yaml");
function options(): WorkerOnboardingOptions {
  return {
    config: parseWorkerOnboarding(input(), dataDir),
    configRoot: root,
    dataDir,
    mode: "add",
    registration: vi.fn(async () => true),
    probe: vi.fn(async () => true),
    report: vi.fn(),
  };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "worker-wizard-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("add writes an offline-registration intent before effects and private no-replace draft; repeat rechecks all facts", async () => {
  const o = options();
  const registration = vi.fn(async () => {
    expect(
      JSON.parse(readFileSync(journalPath(), "utf8")).steps.registration,
    ).toBe("running");
    return true;
  });
  expect(await onboardWorker({ ...o, registration })).toBe(true);
  const first = workerOnboardingStatus(root, "example", "worker-a");
  const draft = statSync(draftPath());
  expect(statSync(join(root, "worker-onboarding")).mode & 0o777).toBe(0o700);
  expect(statSync(join(root, "worker-onboarding/worker-a")).mode & 0o777).toBe(
    0o700,
  );
  expect(statSync(journalPath()).mode & 0o777).toBe(0o600);
  expect(draft.mode & 0o777).toBe(0o600);
  expect(readOnboardingYaml(draftPath())).toEqual(input().runtime);
  expect(existsSync(join(root, "runtime-workers.yaml"))).toBe(false);
  expect(await onboardWorker({ ...o, registration, mode: "resume" })).toBe(
    true,
  );
  expect(workerOnboardingStatus(root, "example", "worker-a")?.operation).toBe(
    first?.operation,
  );
  expect(statSync(draftPath()).ino).toBe(draft.ino);
  expect(registration).toHaveBeenCalledTimes(2);
  expect(o.probe).toHaveBeenCalledTimes(WORKER_PROBES.length * 2);
  expect(readdirSync(join(root, "worker-onboarding/worker-a"))).toEqual([
    "example.json",
    "example.runtime-workers.yaml",
    "machine.binding",
  ]);
});

test.each(WORKER_PROBES)(
  "%s failure stops later steps; resume rechecks and hides raw errors",
  async (step) => {
    const o = options();
    expect(
      await onboardWorker({
        ...o,
        probe: vi.fn(async (s) => {
          if (s === step) throw new Error("SYNTHETIC_SECRET config body");
          return true;
        }),
      }),
    ).toBe(false);
    const journal = workerOnboardingStatus(root, "example", "worker-a");
    expect(journal?.steps[step]).toBe("blocked");
    for (const later of WORKER_STEPS.slice(WORKER_STEPS.indexOf(step) + 1))
      expect(journal?.steps[later]).toBe("pending");
    expect(readFileSync(journalPath(), "utf8")).not.toContain(
      "SYNTHETIC_SECRET",
    );
    expect(JSON.stringify(vi.mocked(o.report).mock.calls)).not.toContain(
      "SYNTHETIC_SECRET",
    );
    expect(await onboardWorker({ ...o, mode: "resume" })).toBe(true);
    expect(o.probe).toHaveBeenCalledTimes(WORKER_PROBES.length);
  },
);

test("check never registers or creates a runtime draft; status is a read-only snapshot", async () => {
  expect(workerOnboardingStatus(root, "example", "worker-a")).toBeUndefined();
  expect(readdirSync(root)).toEqual([]);
  const o = options();
  expect(await onboardWorker({ ...o, mode: "check" })).toBe(true);
  expect(o.registration).toHaveBeenCalledWith(false);
  expect(existsSync(draftPath())).toBe(false);
  const before = statSync(journalPath()).mtimeMs;
  workerOnboardingStatus(root, "example", "worker-a");
  expect(statSync(journalPath()).mtimeMs).toBe(before);
});

test("registration failure does not create a draft or probe; a crashed running intent can resume", async () => {
  const o = options();
  expect(await onboardWorker({ ...o, registration: async () => false })).toBe(
    false,
  );
  expect(o.probe).not.toHaveBeenCalled();
  expect(existsSync(draftPath())).toBe(false);
  const journal = JSON.parse(readFileSync(journalPath(), "utf8"));
  journal.steps.registration = "running";
  writeFileSync(journalPath(), JSON.stringify(journal));
  expect(await onboardWorker({ ...o, mode: "resume" })).toBe(true);
});

test("live conflict, changed journal configuration and changed draft never overwrite", async () => {
  const o = options();
  const existing = input().runtime;
  first(existing.machines).host = "different.invalid";
  const live = join(root, "runtime-workers.yaml");
  writeFileSync(live, stringify(existing), { mode: 0o600 });
  await expect(onboardWorker(o)).rejects.toThrow("worker_config_conflict");
  expect(o.registration).not.toHaveBeenCalled();
  expect(readOnboardingYaml(live)).toEqual(existing);
  rmSync(live);
  await onboardWorker(o);
  const changed = input();
  changed.uid++;
  await expect(
    onboardWorker({ ...o, config: parseWorkerOnboarding(changed, dataDir) }),
  ).rejects.toThrow("worker_config_changed");
  writeFileSync(draftPath(), stringify(existing));
  await expect(onboardWorker(o)).rejects.toThrow("worker_config_conflict");
  expect(readOnboardingYaml(draftPath())).toEqual(existing);
});

test("confirmed configuration archives old evidence, replaces only its draft and checks every step again", async () => {
  const o = options();
  await onboardWorker(o);
  const old = workerOnboardingStatus(root, "example", "worker-a");
  const changed = input();
  first(first(changed.runtime.machines).projects).session = "short";
  const config = parseWorkerOnboarding(changed, dataDir);
  const resume = { ...o, config, mode: "resume" as const };
  await expect(onboardWorker(resume)).rejects.toThrow("worker_config_changed");
  await expect(
    onboardWorker({ ...resume, confirmConfig: o.config.digest }),
  ).rejects.toThrow("worker_config_confirmation_invalid");
  expect(workerOnboardingStatus(root, "example", "worker-a")).toEqual(old);
  vi.mocked(o.probe).mockClear();
  expect(await onboardWorker({ ...resume, confirmConfig: config.digest })).toBe(
    true,
  );
  expect(o.probe).toHaveBeenCalledTimes(WORKER_PROBES.length);
  expect(readOnboardingYaml(draftPath())).toEqual(changed.runtime);
  const current = workerOnboardingStatus(root, "example", "worker-a");
  expect(current?.digest).toBe(config.digest);
  expect(current?.operation).not.toBe(old?.operation);
  const history = readdirSync(join(root, "worker-onboarding/worker-a")).find(
    (name) => name.endsWith(".history.json"),
  );
  expect(history).toBeDefined();
  expect(
    JSON.parse(
      readFileSync(
        join(root, "worker-onboarding/worker-a", history as string),
        "utf8",
      ),
    ),
  ).toEqual({ journal: old, draft: input().runtime });
  expect(existsSync(join(root, "runtime-workers.yaml"))).toBe(false);
  expect(await onboardWorker(resume)).toBe(true);
});

test.each([undefined, true, false])(
  "check and resume preserve the live allow_remote_launch setting (%s) when rebaselining",
  async (allowRemoteLaunch) => {
    const o = options();
    expect(await onboardWorker(o)).toBe(true);
    const next = input();
    first(first(next.runtime.machines).projects).session = "short";
    const config = parseWorkerOnboarding(next, dataDir);
    const live = join(root, "runtime-workers.yaml");
    const applied = structuredClone(next.runtime);
    if (allowRemoteLaunch !== undefined)
      Object.assign(first(first(applied.machines).projects), {
        allow_remote_launch: allowRemoteLaunch,
      });
    const yaml = stringify(applied);
    writeFileSync(live, yaml, { mode: 0o600 });

    const resume = { ...o, config, mode: "resume" as const };
    expect(
      await onboardWorker({ ...resume, confirmConfig: config.digest }),
    ).toBe(true);
    expect(await onboardWorker(resume)).toBe(true);
    expect(await onboardWorker({ ...o, config, mode: "check" })).toBe(true);
    expect(readFileSync(live, "utf8")).toBe(yaml);
    expect(readOnboardingYaml(draftPath())).toEqual(next.runtime);
  },
);

test("confirmation never bypasses physical or live binding conflicts, and failed rechecks clear passed steps", async () => {
  const o = options();
  await onboardWorker(o);
  const changed = input();
  first(changed.runtime.machines).host = "other.invalid";
  let config = parseWorkerOnboarding(changed, dataDir);
  await expect(
    onboardWorker({
      ...o,
      mode: "resume",
      config,
      confirmConfig: config.digest,
    }),
  ).rejects.toThrow("worker_config_conflict");
  first(changed.runtime.machines).host = "worker.invalid";
  first(first(changed.runtime.machines).projects).session = "short";
  config = parseWorkerOnboarding(changed, dataDir);
  const live = join(root, "runtime-workers.yaml");
  const applied = input().runtime;
  Object.assign(first(first(applied.machines).projects), {
    allow_remote_launch: true,
  });
  writeFileSync(live, stringify(applied), { mode: 0o600 });
  await expect(
    onboardWorker({
      ...o,
      mode: "resume",
      config,
      confirmConfig: config.digest,
    }),
  ).rejects.toThrow("worker_config_conflict");
  expect(readOnboardingYaml(live)).toEqual(applied);
  writeFileSync(live, stringify(changed.runtime));
  expect(
    await onboardWorker({
      ...o,
      mode: "resume",
      config,
      confirmConfig: config.digest,
      probe: async () => false,
    }),
  ).toBe(false);
  expect(
    workerOnboardingStatus(root, "example", "worker-a")?.steps,
  ).toMatchObject({
    registration: "passed",
    draft: "passed",
    ssh: "blocked",
    resources: "pending",
    mcp: "pending",
  });
  expect(readOnboardingYaml(live)).toEqual(changed.runtime);
});

test("unactivated drafts prevent same-machine rebinding and duplicate physical endpoints across IDs", async () => {
  await onboardWorker(options());
  const changed = input();
  first(first(changed.runtime.machines).projects).project_id = "second";
  first(changed.runtime.machines).host = "different.invalid";
  await expect(
    onboardWorker({
      ...options(),
      config: parseWorkerOnboarding(changed, dataDir),
    }),
  ).rejects.toThrow("worker_config_conflict");
  first(changed.runtime.machines).host = "worker.invalid";
  first(changed.runtime.machines).id = "worker-b";
  await expect(
    onboardWorker({
      ...options(),
      config: parseWorkerOnboarding(changed, dataDir),
    }),
  ).rejects.toThrow("worker_config_conflict");
});

test("registration interrupted before draft publication still reserves the physical identity", async () => {
  await onboardWorker({ ...options(), registration: async () => false });
  expect(existsSync(draftPath())).toBe(false);
  const changed = input();
  first(changed.runtime.machines).id = "worker-b";
  const o = options();
  await expect(
    onboardWorker({ ...o, config: parseWorkerOnboarding(changed, dataDir) }),
  ).rejects.toThrow("worker_config_conflict");
  expect(o.registration).not.toHaveBeenCalled();
});

test("same physical machine may add a disjoint project account without replacing existing bindings", () => {
  const current = input().runtime;
  const next = input();
  Object.assign(first(first(next.runtime.machines).projects), {
    project_id: "second",
    user: "cg_second",
    gid: 2202,
    alias: "second-a",
    root: "/workers/second",
    file_helper: "/workers/second/libexec/worker-files.py",
    git_helper: "/workers/second/libexec/worker-git.py",
  });
  expect(() =>
    checkWorkerDraft(parseWorkerOnboarding(next, dataDir), current, dataDir),
  ).not.toThrow();
  expect(first(current.machines).projects).toHaveLength(1);
});

test("RW-2 draft preserves target metadata, rejects conflicting URLs and requires explicit publication limits", () => {
  const value = input();
  const binding = first(first(value.runtime.machines).projects);
  expect(parseWorkerOnboarding(value, dataDir).runtime).toEqual(value.runtime);
  binding.mcp_url = "https://other.example.ts.net/mcp";
  expect(() => parseWorkerOnboarding(value, dataDir)).toThrow(
    "worker_mcp_url_conflict",
  );
  binding.mcp_url = value.mcp_url;
  Object.assign(binding, { mcp_timeout_ms: 0 });
  expect(() => parseWorkerOnboarding(value, dataDir)).toThrow(
    "worker_mcp_url_invalid",
  );
  Object.assign(binding, { mcp_timeout_ms: 10000, publication: undefined });
  expect(() => parseWorkerOnboarding(value, dataDir)).toThrow();
});

test("live binding missing the now-required MCP URL is rejected until the operator migrates it", () => {
  const config = parseWorkerOnboarding(input(), dataDir);
  const current = input().runtime;
  const machine = first(current.machines);
  const { mcp_url: _url, ...legacy } = first(machine.projects);
  const old = { ...current, machines: [{ ...machine, projects: [legacy] }] };
  expect(() => checkWorkerDraft(config, old, dataDir)).toThrow(
    "worker_config_conflict",
  );
  expect(legacy).not.toHaveProperty("mcp_url");
  Object.assign(legacy, { mcp_url: config.mcp_url });
  expect(() => checkWorkerDraft(config, old, dataDir)).not.toThrow();
  Object.assign(legacy, { unknown_field: "SECRET" });
  expect(() => checkWorkerDraft(config, old, dataDir)).toThrow(
    "worker_config_conflict",
  );
});

test("wizard and live targets use the same canonical MCP authority", () => {
  const value = input();
  value.mcp_url = "https://control.example.ts.net:0443/mcp";
  const config = parseWorkerOnboarding(value, dataDir);
  expect(config.mcp_url).toBe("https://control.example.ts.net/mcp");
  expect(config.worker.execution.mcp?.url).toBe(config.mcp_url);
  first(first(value.runtime.machines).projects).mcp_url = value.mcp_url;
  expect(() => checkWorkerDraft(config, value.runtime, dataDir)).not.toThrow();
});

test.each(["truncated", "symlink", "hardlink", "permissions", "unknown_state"])(
  "refuses %s journals without effects",
  async (kind) => {
    await onboardWorker(options());
    if (kind === "truncated") writeFileSync(journalPath(), "{");
    if (kind === "symlink") {
      rmSync(journalPath());
      symlinkSync(join(root, "victim"), journalPath());
    }
    if (kind === "hardlink") linkSync(journalPath(), join(root, "victim"));
    if (kind === "permissions") chmodSync(journalPath(), 0o644);
    if (kind === "unknown_state") {
      const j = JSON.parse(readFileSync(journalPath(), "utf8"));
      j.steps.ssh = "SECRET";
      writeFileSync(journalPath(), JSON.stringify(j));
    }
    const o = options();
    await expect(onboardWorker(o)).rejects.toThrow();
    expect(o.registration).not.toHaveBeenCalled();
    expect(o.probe).not.toHaveBeenCalled();
  },
);

test("rejects linked and writable parent directories and concurrent runs; lock releases after an error", async () => {
  const other = join(root, "other");
  mkdirSync(other, { mode: 0o700 });
  symlinkSync(other, join(root, "worker-onboarding"));
  await expect(onboardWorker(options())).rejects.toThrow();
  rmSync(join(root, "worker-onboarding"));
  chmodSync(root, 0o777);
  await expect(onboardWorker(options())).rejects.toThrow();
  chmodSync(root, 0o700);
  await onboardWorker(options());
  const dir = new CpuProfileDirectory(join(root, "worker-onboarding"));
  const lock = dir.lock(false);
  try {
    expect(lock.acquire()).toBe(true);
    await expect(onboardWorker(options())).rejects.toThrow("worker_busy");
  } finally {
    lock.close();
    dir.close();
  }
  expect(await onboardWorker(options())).toBe(true);
});

test.each([
  "http://control.example.ts.net/mcp",
  "https://control.invalid/mcp",
  "https://user:SECRET@control.example.ts.net/mcp",
  "https://control.example.ts.net/mcp?token=SECRET",
  "https://control.example.ts.net/other",
])("rejects an unsafe MCP endpoint without echoing it", (url) => {
  expect(() =>
    parseWorkerOnboarding({ ...input(), mcp_url: url }, dataDir),
  ).toThrow("worker_mcp_url_invalid");
});

test("private input refuses unknown fields, links and oversized files", () => {
  expect(() =>
    parseWorkerOnboarding({ ...input(), token: "SECRET" }, dataDir),
  ).toThrow("worker_config_invalid");
  const path = join(root, "input.yaml");
  writeFileSync(path, "SECRET", { mode: 0o644 });
  expect(() => readOnboardingYaml(path)).toThrow();
  chmodSync(path, 0o600);
  writeFileSync(path, "x".repeat(65537));
  expect(() => readOnboardingYaml(path)).toThrow();
  rmSync(path);
  symlinkSync(join(root, "missing"), path);
  expect(() => readOnboardingYaml(path)).toThrow();
});

// Execute the actual fixed Python program, with only external observations replaced.
// This catches syntax/HTTP/version policy regressions without network or worker access.
function pythonProbe(
  step: WorkerProbe,
  prelude: string,
  observations: object = {},
) {
  const c = parseWorkerOnboarding(input(), dataDir);
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-B",
      "-c",
      `${prelude}\n${WORKER_PROBE_SCRIPT}`,
      JSON.stringify({ ...workerProbeInput(step, c), ...observations }),
    ],
    { encoding: "utf8", timeout: 3000, env: { PATH: "/usr/bin:/bin" } },
  );
  expect(result.stderr).toBe("");
  return result;
}
test.each([200, 301, 401, 403, 500])(
  "actual MCP probe only accepts unauthenticated HTTP 401, rejects %i",
  (code) => {
    const result = pythonProbe(
      "mcp",
      `import urllib.request, urllib.error\nclass Fake:\n def open(self, request, timeout):\n  assert request.full_url == 'https://control.example.ts.net/mcp'\n  assert not request.has_header('Authorization')\n  raise urllib.error.HTTPError(request.full_url, ${code}, 'SYNTHETIC_SECRET', {}, None)\nurllib.request.build_opener = lambda *args: Fake()`,
    );
    expect(result.status).toBe(code === 401 ? 0 : 1);
    expect(result.stdout).toBe(code === 401 ? "worker_probe_ok\n" : "");
  },
);
test("actual probe hides TLS failures and refuses hc version mismatch", () => {
  expect(
    pythonProbe(
      "mcp",
      "import urllib.request\nclass Fake:\n def open(self, *args, **kwargs): raise ValueError('SECRET TLS')\nurllib.request.build_opener = lambda *args: Fake()",
    ).status,
  ).toBe(1);
  const prelude = `import subprocess, types\ndef fake(command, **kwargs):\n versions = {'hc': 'hc ${HC_RELEASE.version}', 'git': 'git version 2.43.0', 'node': 'v24.0.0', 'pnpm': '11.7.0'}\n return types.SimpleNamespace(returncode=0, stdout=versions[command[0]].encode())\nsubprocess.run = fake`;
  expect(pythonProbe("tools", prelude).status).toBe(0);
  expect(
    pythonProbe(
      "tools",
      prelude.replace(`hc ${HC_RELEASE.version}`, "hc 0.0.0"),
    ).status,
  ).toBe(1);
});

const workerObservations = readFileSync(
  new URL("../test-support/worker-onboarding-observations.py", import.meta.url),
  "utf8",
);
test.each([
  "safe",
  "safe-alternate",
  "safe-no-entry",
  "allowed",
  "allowed-command",
  "password",
  "unknown",
  "wrong-user",
  "exit-zero-denial",
  "missing",
  "timeout",
  "effective-root",
  "implicit-groups",
  "process-implicit-groups",
])("actual account probe requires an explicit sudo denial: %s", (fixture) => {
  const result = pythonProbe("account", workerObservations, { fixture });
  const passed = fixture.startsWith("safe");
  expect(result.status).toBe(passed ? 0 : 1);
  expect(result.stdout).toBe(passed ? "worker_probe_ok\n" : "");
});
test.each([
  "safe",
  "ssh-owned",
  "keys-owned",
  "keys-linked",
  "local-owned",
  "private:.config",
  "private:.cache",
  "private:.local/state",
  "private:.local/share",
  "lock-acl",
  "ancestor-acl",
  "keys-acl",
  "acl-error",
  "missing-private",
  "symlink",
])(
  "actual directory probe verifies HOME, authorization and ACL boundaries: %s",
  (fixture) => {
    const result = pythonProbe("directories", workerObservations, { fixture });
    expect(result.status).toBe(fixture === "safe" ? 0 : 1);
    expect(result.stdout).toBe(fixture === "safe" ? "worker_probe_ok\n" : "");
  },
);
test.each(["safe", "missing-protocol", "wrong-digest", "helper-acl"])(
  "actual helper probe verifies all three protocols: %s",
  (fixture) => {
    const config = parseWorkerOnboarding(input(), dataDir);
    const { helpers } = workerProbeInput("helpers", config);
    const contents = Object.fromEntries(
      Object.keys(helpers).map((path) => [
        path,
        readFileSync(
          new URL(`../../../deploy/${path.split("/").at(-1)}`, import.meta.url),
          "utf8",
        ),
      ]),
    );
    const manifest = { ...helpers };
    if (fixture === "missing-protocol")
      delete manifest[config.worker.execution.fileHelper?.path ?? ""];
    if (fixture === "wrong-digest")
      manifest[config.worker.execution.fileHelper?.path ?? ""] = "0".repeat(64);
    const result = pythonProbe("helpers", workerObservations, {
      fixture,
      helpers: manifest,
      helper_contents: contents,
    });
    expect(result.status).toBe(fixture === "safe" ? 0 : 1);
    expect(result.stdout).toBe(fixture === "safe" ? "worker_probe_ok\n" : "");
  },
);

test.each(["file-git", "file-primitives", "git-primitives"])(
  "configuration rejects helper path reuse: %s",
  (collision) => {
    const value = input();
    const binding = first(first(value.runtime.machines).projects);
    if (collision === "file-git") binding.file_helper = binding.git_helper;
    else if (collision === "file-primitives")
      binding.file_helper = `${binding.root}/libexec/worker-primitives.py`;
    else binding.git_helper = `${binding.root}/libexec/worker-primitives.py`;
    expect(() => parseWorkerOnboarding(value, dataDir)).toThrow(
      "worker_helper_path_conflict",
    );
  },
);
