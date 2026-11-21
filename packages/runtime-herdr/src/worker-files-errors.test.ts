import { expect, test, vi } from "vitest";
import { agentProcessCommand } from "./agent-ssh.js";
import { workerFiles } from "./worker-files.js";

vi.mock("./agent-ssh.js", () => ({ agentProcessCommand: vi.fn() }));
test.each([
  ["worker_filename_rejected\n", "worker_filename_rejected"],
  ["worker_disk_error\n", "worker_disk_error"],
  ["worker_permission_denied\n", "worker_permission_denied"],
  ["secret-contents", "unknown (stderr omitted)"],
  ["worker_disk_error\nsecret-contents", "unknown (stderr omitted)"],
])(
  "returns only operation, remote exit and classified stderr",
  async (stderr, summary) => {
    const target = {
      project_id: "test",
      machine_id: "worker",
      session: "fixture",
      generation: "one",
      fingerprint: "a".repeat(64),
    };
    vi.mocked(agentProcessCommand).mockResolvedValue({
      file: process.execPath,
      args: [
        "-e",
        `process.stderr.write(${JSON.stringify(stderr)});process.exitCode=7`,
      ],
    });
    await expect(
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
            timeout_ms: 5000,
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
      ),
    ).rejects.toMatchObject({
      message: `Worker publication rejected: status; exit=7; ${summary}`,
    });
  },
);
