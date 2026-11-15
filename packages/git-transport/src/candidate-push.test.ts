import { expect, test } from "vitest";
import { candidatePushCommand } from "./candidate-push.js";
import { mergePushCommand } from "./merge-push.js";

const input = {
  repo: "fixture/project",
  sha: "a".repeat(40),
  ref: "refs/heads/ci/C-1/D-1/attempt-1",
  token: "ghs_synthetic",
};
test("D3: a candidate push uses App HTTPS credentials in memory, a single non-force ci ref and no helpers", () => {
  const { args, env } = candidatePushCommand("/fixture/central/p.git", input);
  expect(args.slice(-4)).toEqual([
    "--porcelain",
    "--",
    "https://github.com/fixture/project.git",
    `${input.sha}:${input.ref}`,
  ]);
  expect(args).toContain("credential.helper=");
  expect(args).toContain("http.followRedirects=false");
  expect(args.join(" ")).not.toContain(input.token);
  expect(env.GIT_CONFIG_VALUE_0).toBe(
    `Authorization: Basic ${Buffer.from(`x-access-token:${input.token}`).toString("base64")}`,
  );
  expect(env).not.toHaveProperty("SSH_AUTH_SOCK");
  expect(env).not.toHaveProperty("GIT_SSH_COMMAND");
  expect(() =>
    mergePushCommand("/fixture", {
      sha: input.sha,
      branch: "main",
      remote: "https://github.com/fixture/project.git",
    }),
  ).toThrow("Invalid push transport");
});
test.each([
  "refs/heads/main",
  "+refs/heads/ci/C-1/D-1/attempt-1",
  "refs/heads/ci/C-1/D-1/a:main",
  "refs/heads/ci/C-1/D-1/a --force",
  "refs/heads/ci/C-1/../a",
  "refs/tags/ci/C-1/D-1/a",
  "refs/heads/ci/C-1/D-1/a.lock",
])("D3: rejects unsafe candidate ref %s", (ref) => {
  expect(() => candidatePushCommand("/fixture", { ...input, ref })).toThrow(
    "Invalid candidate push",
  );
});
test.each([
  "https://evil/x",
  "fixture/..",
  "fixture/project.git",
  "fixture/project?token=x",
  "fixture/project\n",
])("D3: rejects unsafe repo %s", (repo) => {
  expect(() => candidatePushCommand("/fixture", { ...input, repo })).toThrow(
    "Invalid candidate push",
  );
});
