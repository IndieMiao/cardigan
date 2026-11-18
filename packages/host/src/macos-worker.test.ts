import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { parse, stringify } from "yaml";
import { parseRuntimeWorkers } from "./runtime-workers-config.js";
import {
  checkWorkerDraft,
  onboardWorker,
  parseWorkerOnboarding,
  type WorkerProbe,
  workerOnboardingStatus,
  workerProbeInput,
  workerProbeScript,
} from "./worker-onboarding.js";

const guide = readFileSync(
  new URL("../../../docs/macos-worker.md", import.meta.url),
  "utf8",
);
const input = () => parse(/```yaml\n([\s\S]*?)```/u.exec(guide)?.[1] ?? "");
const config = () => parseWorkerOnboarding(input(), "/controller/data");
const fixtures = (name: string) =>
  readFileSync(new URL(`../test-support/${name}.py`, import.meta.url), "utf8");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("documented macos and legacy darwin normalize to the same identity; Intel fails explicitly", () => {
  const source = input();
  expect(parseRuntimeWorkers(source.runtime, "/controller/data")[0]?.os).toBe(
    "darwin",
  );
  expect(() =>
    checkWorkerDraft(config(), source.runtime, "/controller/data"),
  ).not.toThrow();
  expect(config().worker).toMatchObject({ os: "darwin", arch: "arm64" });
  source.runtime.machines[0].os = "darwin";
  expect(parseWorkerOnboarding(source, "/controller/data").digest).toBe(
    config().digest,
  );
  for (const arch of ["x64", "x86_64"]) {
    source.runtime.machines[0].arch = arch;
    expect(() => parseWorkerOnboarding(source, "/controller/data")).toThrow(
      "worker_macos_arm64_required",
    );
  }
});

test.each(["label", "hc_path", "path"])(
  "rejects incomplete or ambiguous launchd configuration: %s",
  (field) => {
    const source = input();
    if (field === "path")
      source.runtime.machines[0].projects[0].path = "/usr/bin:/bin";
    else source.launchd[field] = "invalid";
    expect(() => parseWorkerOnboarding(source, "/controller/data")).toThrow(
      "worker_launchd_config_invalid",
    );
  },
);

test.each([
  undefined,
  {},
  { "worker-b": { limit: 1, max_limit: 1 } },
  { "worker-a": 1 },
  { "worker-a": { limit: 1 } },
  { "worker-a": { limit: 2, max_limit: 1 } },
])(
  "macOS requires explicit physical-machine capacity and resume rechecks it (%j)",
  async (machines) => {
    const root = mkdtempSync(join(tmpdir(), "mac-worker-"));
    roots.push(root);
    const file = join(root, "run-capacity.yaml");
    if (machines) writeFileSync(file, stringify({ machines }), { mode: 0o600 });
    const report = vi.fn(),
      probe = vi.fn(async () => true);
    const options = {
      config: config(),
      configRoot: root,
      dataDir: "/controller/data",
      mode: "add" as const,
      registration: async () => true,
      report,
      probe,
    };
    expect(await onboardWorker(options)).toBe(false);
    expect(probe.mock.calls.some(([step]) => step === "resources")).toBe(false);
    expect(
      workerOnboardingStatus(root, "example", "worker-a")?.steps.resources,
    ).toBe("blocked");
    writeFileSync(
      file,
      stringify({ machines: { "worker-a": { limit: 1, max_limit: 1 } } }),
      { mode: 0o600 },
    );
    expect(await onboardWorker({ ...options, mode: "resume" })).toBe(true);
    expect(report).toHaveBeenCalledWith("resources", "passed", "ok", undefined);
  },
);

function probe(step: WorkerProbe, fixture: string) {
  const c = config();
  const request = workerProbeInput(step, c);
  const contents = Object.fromEntries(
    Object.keys(request.helpers).map((path) => [
      path,
      readFileSync(
        new URL(`../../../deploy/${path.split("/").at(-1)}`, import.meta.url),
        "utf8",
      ),
    ]),
  );
  const common = ["account", "directories", "helpers", "resources"].includes(
    step,
  )
    ? fixtures("worker-onboarding-observations")
    : "";
  // Actual program; only OS/process/network observations are synthetic. This is
  // not evidence that a real Mac, launchd service or GUI permission was verified.
  const fixtureCode = `${common}\n${fixtures("macos-onboarding-observations")}`;
  const source = workerProbeScript(c).replace(
    "\ntry:\n    main()",
    `\n${fixtureCode}\ntry:\n    main()`,
  );
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-B",
      "-c",
      source,
      JSON.stringify({ ...request, fixture, helper_contents: contents }),
    ],
    {
      encoding: "utf8",
      timeout: 3000,
      env: { PATH: "/usr/bin:/bin" },
    },
  );
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(fixture === "safe" ? "worker_probe_ok\n" : "");
  expect(result.status).toBe(fixture === "safe" ? 0 : 1);
}

test.each([
  "safe",
  "dscl-uid",
  "allowed",
  "password",
  "process-admin",
  "intel",
])("Darwin directory-service and process credentials: %s", (fixture) =>
  probe("account", fixture),
);
test.each([
  "safe",
  "ancestor-acl",
  "keys-acl",
  "acl-error",
  "symlink",
  "private:.cache",
  "keys-owned",
])("Darwin directory ACLs and parent ownership: %s", (fixture) =>
  probe("directories", fixture),
);
test.each(["safe", "helper-acl"])("Darwin helper integrity: %s", (fixture) =>
  probe("helpers", fixture),
);
test.each(["safe", "intel-tool", "rosetta", "signature", "version"])(
  "native tools are inspected before execution: %s",
  (fixture) => probe("tools", fixture),
);
test.each([
  "safe",
  "plist-acl",
  "plist-owner",
  "ProgramArguments",
  "UserName",
  "WorkingDirectory",
  "EnvironmentVariables",
  "InitGroups",
  "KeepAlive",
  "loaded-path",
  "loaded-user",
  "loaded-args",
  "loaded-env",
  "loaded-cwd",
  "unloaded",
  "unknown-pid",
  "root-pid",
  "reused-pid",
  "wrong-executable",
])("LaunchDaemon must match the installed and running service: %s", (fixture) =>
  probe("resources", fixture),
);
test.each(["safe", "forbidden"])(
  "Darwin MCP requires unauthenticated refusal: %s",
  (fixture) => probe("mcp", fixture),
);
