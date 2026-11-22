import { expect, test, vi } from "vitest";
import { agentProcessCommand } from "./agent-ssh.js";
import { workerFiles } from "./worker-files.js";
import { workerGitFailure } from "./worker-git.js";
import {
  WorkerPreparationFailure,
  WorkerTransportUnavailable,
} from "./worker-preparation-failure.js";

vi.mock("./agent-ssh.js", () => ({ agentProcessCommand: vi.fn() }));
const target = {
  project_id: "test",
  machine_id: "worker",
  session: "fixture",
  generation: "one",
  fingerprint: "a".repeat(64),
};
const checkStatus = (timeout_ms = 5000) =>
  workerFiles(
    {
      mode: "agent-ssh",
      target,
      dataDir: "/test",
      agentRoot: "/worker",
      gid: 10,
      machine: "worker",
      identityFile: "/id",
      knownHostsFile: "/hosts",
      publication: {
        header_max_bytes: 4096,
        file_max_bytes: 32,
        batch_max_bytes: 64,
        timeout_ms,
      },
      fileHelper: { path: "/helper", python: "/python" },
    },
    {
      project: "test",
      assignment: "A-1",
      run: "R-1",
      generation: "b".repeat(32),
      target: target.fingerprint,
    },
    "status",
  );

test.each([
  ["worker_filename_rejected\n", "worker_filename_rejected"],
  ["worker_disk_error\n", "worker_disk_error"],
  ["worker_permission_denied\n", "worker_permission_denied"],
  ["secret-contents", "unknown (stderr omitted)"],
  ["worker_disk_error\nsecret-contents", "unknown (stderr omitted)"],
])(
  "returns only operation, remote exit and classified stderr",
  async (stderr, summary) => {
    vi.mocked(agentProcessCommand).mockResolvedValue({
      file: process.execPath,
      args: [
        "-e",
        `process.stderr.write(${JSON.stringify(stderr)});process.exitCode=7`,
      ],
    });
    const result = checkStatus();
    await expect(result).rejects.toBeInstanceOf(WorkerPreparationFailure);
    await expect(result).rejects.toMatchObject({
      message: `Worker publication rejected: status; exit=7; ${summary}`,
    });
  },
);

test("a command deadline is not positive evidence of a connection failure", async () => {
  vi.mocked(agentProcessCommand).mockResolvedValueOnce({
    file: process.execPath,
    args: [
      "-e",
      "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{},5000));",
    ],
  });
  const slow = checkStatus(250);
  await expect(slow).rejects.toBeInstanceOf(WorkerPreparationFailure);
  await expect(slow).rejects.not.toBeInstanceOf(WorkerTransportUnavailable);
  vi.mocked(agentProcessCommand).mockResolvedValueOnce({
    file: process.execPath,
    args: [
      "-e",
      "process.stderr.write('ssh: connect to host fixture port 22: Connection refused');process.exitCode=255",
    ],
  });
  await expect(checkStatus()).rejects.toBeInstanceOf(
    WorkerTransportUnavailable,
  );
});

test("a missing local SSH entry is sanitized but not a worker fault; an invalid remote reply is", async () => {
  vi.mocked(agentProcessCommand).mockRejectedValueOnce(
    new Error("fixture-private-path"),
  );
  const setup = checkStatus();
  await expect(setup).rejects.toThrow("SSH entry unavailable");
  await expect(setup).rejects.not.toBeInstanceOf(WorkerPreparationFailure);
  vi.mocked(agentProcessCommand).mockResolvedValueOnce({
    file: process.execPath,
    args: ["-e", "process.stdout.write('not-json')"],
  });
  await expect(checkStatus()).rejects.toBeInstanceOf(WorkerPreparationFailure);
});

test.each([
  ["prepare", { code: 255, stderr: "Connection refused" }, true],
  ["prepare", { code: "ENOENT" }, false],
  [
    "receive-pack",
    { code: 128, stderr: "local repository: Permission denied" },
    false,
  ],
  ["receive-pack", { code: 128, stderr: "worker_git_rejected\n" }, true],
] as const)("attributes Git %s failure %j", (op, failure, remote) => {
  const error = workerGitFailure(op, failure);
  expect(error instanceof WorkerPreparationFailure).toBe(remote);
  expect(error).toMatchObject({ executionExited: false });
});
