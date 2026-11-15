import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { CentralGitTransport } from "./central.js";

const fake = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: Object.assign(() => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: fake.exec,
  }),
}));

import { candidateDeleteCommand } from "./candidate-delete.js";

const input = {
  repo: "fixture/project",
  sha: "a".repeat(40),
  ref: "refs/heads/ci/C-1/D-1/attempt-1",
  token: "ghs_synthetic",
};
test("D5: deletion carries an exact SHA lease, one empty-source refspec and in-memory authentication", () => {
  const { args, env } = candidateDeleteCommand("/fixture", input);
  expect(args.slice(-5)).toEqual([
    "--porcelain",
    `--force-with-lease=${input.ref}:${input.sha}`,
    "--",
    "https://github.com/fixture/project.git",
    `:${input.ref}`,
  ]);
  expect(args.join(" ")).not.toContain(input.token);
  expect(args).toContain("credential.helper=");
  expect(args).toContain("http.followRedirects=false");
  expect(env).not.toHaveProperty("SSH_AUTH_SOCK");
});
test.each([
  "refs/heads/main",
  "refs/heads/ci-evil/C-1/D-1/a",
  "+refs/heads/ci/C-1/D-1/a",
  "refs/heads/ci/C-1/../a",
  "refs/heads/ci/C-1/D-1/a:main",
  "refs/tags/ci/C-1/D-1/a",
  "refs/heads/ci/C-1/D-1/a\n",
])("D5: refuses deletion outside the candidate namespace: %s", (ref) => {
  expect(() => candidateDeleteCommand("/fixture", { ...input, ref })).toThrow();
});
test.each([
  { sha: "main" },
  { sha: "" },
  { repo: "https://evil/x" },
  { token: "bad\nheader" },
])("D5: refuses invalid deletion identity %o", (override) => {
  expect(() =>
    candidateDeleteCommand("/fixture", { ...input, ...override }),
  ).toThrow();
});

test.each(["delete", "absent", "reused", "changedAfterQuery", "failure"])(
  "D5: fake Git remote %s is idempotent and cannot remove a changed branch",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "candidate-delete-"));
    const central = join(root, "central"),
      repository = join(central, "fixture.git");
    await mkdir(central, { mode: 0o700 });
    await mkdir(repository, { mode: 0o700 });
    const transport = new CentralGitTransport({ dataDir: root });
    fake.exec.mockReset();
    fake.exec.mockImplementation(async (_file, args) => {
      if (mode === "failure") throw new Error("ghs_synthetic private stderr");
      if (args.includes("ls-remote"))
        return {
          stdout:
            mode === "absent"
              ? ""
              : `${mode === "reused" ? "b".repeat(40) : input.sha}\t${input.ref}\n`,
          stderr: "",
        };
      if (mode === "changedAfterQuery") throw new Error("stale info");
      return { stdout: "", stderr: "" };
    });
    try {
      expect(await transport.deleteCandidateCommit(repository, input)).toBe(
        ["delete", "absent"].includes(mode),
      );
      expect(
        fake.exec.mock.calls.filter((call) => call[1].includes("push")),
      ).toHaveLength(["delete", "changedAfterQuery"].includes(mode) ? 1 : 0);
      if (mode === "delete")
        expect(fake.exec.mock.calls[1]?.[1]).toContain(
          `--force-with-lease=${input.ref}:${input.sha}`,
        );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
