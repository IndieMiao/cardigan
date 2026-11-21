import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import { afterEach, expect, test, vi } from "vitest";
import { workerHelperDigests } from "./worker-helper-release.js";
import { stageWorkerUpgrade, upgradeMaterials } from "./worker-upgrade.js";

const transport = vi.hoisted(() => vi.fn());
vi.mock("@cardigan/runtime-herdr", async (original) => ({
  ...(await original<typeof import("@cardigan/runtime-herdr")>()),
  agentProcessCommand: transport,
}));
const root = "/worker/sample";
const worker: Extract<ExecutionConfig, { mode: "agent-ssh" }> = {
  mode: "agent-ssh",
  machine: "sample",
  agentRoot: root,
  user: "sample",
  gid: 1001,
  dataDir: "/fixture",
  identityFile: "/private/key",
  knownHostsFile: "/private/hosts",
  fileHelper: {
    python: "/usr/bin/python3",
    path: `${root}/libexec/worker-files.py`,
  },
  gitHelper: {
    python: "/usr/bin/python3",
    path: `${root}/libexec/worker-git.py`,
  },
  target: {
    machine_id: "remote",
    project_id: "sample",
    generation: "1",
    session: "sample",
    fingerprint: "a".repeat(64),
  },
};
const cleanup: string[] = [];
const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
afterEach(() => {
  for (const p of cleanup.splice(0))
    rmSync(p, { recursive: true, force: true });
  vi.resetAllMocks();
});
test.each(["linux", "darwin"])(
  "stages only release bytes for %s and pins both files checked inside the private copy",
  async (os) => {
    const tmp = mkdtempSync(join(tmpdir(), "upgrade-test-"));
    cleanup.push(tmp);
    const stage = join(tmp, "stage");
    // Run the actual fixed receiver with a synthetic unprivileged target and private test temp.
    transport.mockImplementation(async (_execution, args: string[]) => ({
      file: args[0],
      args: [...args.slice(1, -1), stage],
    }));
    const terminal = await stageWorkerUpgrade(worker, os);
    const { dir } = upgradeMaterials(worker, os);
    expect(terminal.command).toContain(
      os === "linux" ? "sha256sum" : "shasum -a 256",
    );
    expect(terminal.command).not.toMatch(/[\n\r]/u);
    for (const name of ["deploy.tar.gz", "upgrade.py"])
      expect(terminal.command).toContain(
        `${digest(readFileSync(join(stage, name)))}  ${name}`,
      );
    for (const [name, expected] of Object.entries(workerHelperDigests()))
      expect(
        digest(
          execFileSync("tar", [
            "-xzOf",
            join(stage, "deploy.tar.gz"),
            `deploy/${name}`,
          ]),
        ),
      ).toBe(expected);
    // Manual staging must ship the operator template, not the enrolled root entry.
    const template = readFileSync(
      new URL("../../../deploy/manual-worker-upgrade.py", import.meta.url),
    );
    expect(
      readFileSync(join(stage, "upgrade.py")).subarray(0, template.length),
    ).toEqual(template);
    // Execute only the copy/check shell, as this user, substituting a harmless completion marker.
    const copy = terminal.command
      .replace("/usr/bin/sudo ", "")
      .replaceAll(dir, stage)
      .replace(
        os === "linux"
          ? "/root/cardigan-upgrade."
          : "/private/var/root/cardigan-upgrade.",
        `${tmp}/private.`,
      )
      .replace("/usr/bin/python3 -IB upgrade.py", "echo verified");
    expect(execFileSync("sh", ["-c", copy], { encoding: "utf8" })).toContain(
      "verified",
    );
    writeFileSync(join(stage, "upgrade.py"), "modified");
    expect(() => execFileSync("sh", ["-c", copy], { stdio: "pipe" })).toThrow();
    expect(transport.mock.calls[0]?.[1].join(" ")).not.toContain("sudo");
  },
);

test("does not prepare an installer for a nonstandard helper destination", () => {
  expect(() =>
    upgradeMaterials(
      {
        ...worker,
        fileHelper: {
          python: "/usr/bin/python3",
          path: "/other/worker-files.py",
        },
      },
      "linux",
    ),
  ).toThrow("worker_binding_unavailable");
});

test("does not advertise a command if the worker cannot confirm both staged digests", async () => {
  transport.mockResolvedValue({
    file: "/usr/bin/python3",
    args: [
      "-IB",
      "-c",
      "import sys; sys.stdin.buffer.read(); print('wrong digest')",
    ],
  });
  await expect(stageWorkerUpgrade(worker, "linux")).rejects.toThrow(
    "worker_release_staging_failed",
  );
});

test("replays both operator sequences in temporary directories without root", () => {
  execFileSync("/usr/bin/python3", [
    "-IB",
    new URL("../test-support/worker-upgrade.py", import.meta.url).pathname,
  ]);
});
