import { execFileSync, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { parse } from "yaml";
import {
  parseWorkerOnboarding,
  probeWorker,
  workerProbeInput,
} from "./worker-onboarding.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "worker-probe-"));
  vi.mocked(spawn).mockReset();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function config(platform = "linux") {
  const guide = readFileSync(
    new URL(`../../../docs/${platform}-worker.md`, import.meta.url),
    "utf8",
  );
  const yaml = /```yaml\n([\s\S]*?)```/u.exec(guide)?.[1];
  if (!yaml) throw new Error("Guide missing YAML");
  const value = parse(yaml);
  for (const [key, name] of [
    ["identity_file", "key"],
    ["known_hosts_file", "known_hosts"],
  ]) {
    const path = join(root, name as string);
    writeFileSync(path, "SYNTHETIC_CREDENTIAL", { mode: 0o600 });
    value.runtime.machines[0][key as string] = path;
  }
  return parseWorkerOnboarding(value, "/private/controller-data");
}
function output(text: string, code: number | null = 0, overflow = false) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    kill: vi.fn(),
  });
  vi.mocked(spawn).mockImplementationOnce(() => {
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(text));
      if (overflow) child.stdout.emit("data", Buffer.alloc(4097));
      child.emit("close", code);
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
  return child;
}

test("documented input works with pinned SSH, clean environment and a bounded fixed command", async () => {
  const c = config();
  output("worker_probe_ok\n");
  expect(await probeWorker("ssh", c)).toBe(true);
  const [command, args, options] = vi.mocked(spawn).mock.calls[0] ?? [];
  expect(command).toBe("ssh");
  expect(args).toEqual(
    expect.arrayContaining([
      "StrictHostKeyChecking=yes",
      "BatchMode=yes",
      "ForwardAgent=no",
      "IdentityAgent=none",
      "-F",
      "/dev/null",
    ]),
  );
  expect(options).toMatchObject({
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 15000,
    killSignal: "SIGKILL",
  });
  expect(JSON.stringify(args)).not.toContain("SYNTHETIC_CREDENTIAL");
  expect(JSON.stringify(args)).not.toContain("sudo");
});

test.each([
  ["", 255],
  ["worker_probe_ok\n", null],
  ["SECRET\nworker_probe_ok\n", 0],
])(
  "SSH failure, timeout or unexpected output stays blocked",
  async (text, code) => {
    const c = config();
    output(text as string, code as number | null);
    expect(await probeWorker("ssh", c)).toBe(false);
  },
);

test("oversized output cannot pass even after a valid success marker and zero exit", async () => {
  const c = config();
  const child = output("worker_probe_ok\n", 0, true);
  expect(await probeWorker("ssh", c)).toBe(false);
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
});

test("SSH credentials must be private before a process can be started", async () => {
  const c = config();
  chmodSync(c.worker.execution.identityFile, 0o644);
  expect(await probeWorker("ssh", c)).toBe(false);
  expect(spawn).not.toHaveBeenCalled();
});

test("Python probes ignore worker site customizations and never write bytecode", async () => {
  const c = config();
  output("worker_probe_ok\n");
  expect(await probeWorker("account", c)).toBe(true);
  const args = vi.mocked(spawn).mock.calls[0]?.[1] as readonly string[];
  expect(args.at(-1)).toContain("'-I' '-B' '-c'");
});

test("macOS checks the bootstrap Python architecture before executing the isolated probe", async () => {
  const c = config("macos");
  output("worker_probe_ok\n");
  expect(await probeWorker("tools", c)).toBe(true);
  const args = vi.mocked(spawn).mock.calls[0]?.[1] as readonly string[];
  const remote = args.at(-1) ?? "";
  expect(remote).toContain("/opt/homebrew/bin");
  expect(remote).toContain("/usr/bin/lipo -verify_arch arm64");
  expect(remote.indexOf("/usr/bin/lipo")).toBeLessThan(remote.indexOf("exec"));
  expect(remote).toContain("'-I' '-B' '-c'");
});

test.each([
  ["arm64", "arm64", true],
  ["arm64", "arm64e", true],
  ["arm64", "x86_64", false],
  ["arm64", "arm64_unknown", false],
  ["x86_64", "arm64e", false],
] as const)(
  "bootstrap on %s inspects %s before execution (synthetic)",
  async (machine, architecture, accepted) => {
    output("worker_probe_ok\n");
    await probeWorker("tools", config("macos"));
    const args = vi.mocked(spawn).mock.calls[0]?.[1] as readonly string[];
    const remote: string[] = JSON.parse(
      execFileSync(
        "python3",
        [
          "-I",
          "-B",
          "-c",
          "import json,shlex,sys;print(json.dumps(shlex.split(sys.argv[1])))",
          args.at(-1) ?? "",
        ],
        { encoding: "utf8" },
      ),
    );
    const bootstrap = remote[remote.indexOf("/bin/sh") + 2];
    if (!bootstrap) throw new Error("Missing bootstrap");
    const uname = join(root, "uname"),
      lipo = join(root, "lipo"),
      python = join(root, "python");
    writeFileSync(uname, `#!/bin/sh\nprintf '%s\\n' '${machine}'\n`, {
      mode: 0o700,
    });
    writeFileSync(
      lipo,
      `#!/bin/sh\n[ "$1" = -verify_arch ] && [ "$2" = '${architecture}' ]\n`,
      { mode: 0o700 },
    );
    writeFileSync(python, "#!/bin/sh\nprintf 'executed\\n'\n", { mode: 0o700 });
    const result = spawnSync(
      "/bin/sh",
      [
        "-c",
        bootstrap
          .replaceAll("/usr/bin/uname", '"$WORKER_TEST_UNAME"')
          .replaceAll("/usr/bin/lipo", '"$WORKER_TEST_LIPO"'),
        "worker-probe",
        python,
      ],
      {
        encoding: "utf8",
        env: {
          PATH: "/usr/bin:/bin",
          WORKER_TEST_UNAME: uname,
          WORKER_TEST_LIPO: lipo,
        },
        timeout: 3000,
      },
    );
    expect(result.status).toBe(accepted ? 0 : 1);
    expect(result.stdout).toBe(accepted ? "executed\n" : "");
    expect(result.stderr).toBe("");
  },
);

test.each(["file-git", "file-primitives", "git-primitives"])(
  "probe rejects a bypassed configuration with helper collision before SSH: %s",
  async (collision) => {
    const c = config();
    const e = c.worker.execution;
    const path =
      collision === "file-git"
        ? e.gitHelper?.path
        : `${e.agentRoot}/libexec/worker-primitives.py`;
    const invalid = {
      ...c,
      worker: {
        ...c.worker,
        execution: {
          ...e,
          ...(collision === "git-primitives"
            ? {
                gitHelper: { python: "/usr/bin/python3", path: path as string },
              }
            : {
                fileHelper: {
                  python: "/usr/bin/python3",
                  path: path as string,
                },
              }),
        },
      },
    };
    expect(() => workerProbeInput("helpers", invalid)).toThrow(
      "worker_helper_path_conflict",
    );
    expect(await probeWorker("helpers", invalid)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  },
);
