import { expect, test } from "vitest";
import { candidatePushCommand } from "./candidate-push.js";
import { mergePushCommand } from "./merge-push.js";

const input = {
  repo: "fixture/project",
  sha: "a".repeat(40),
  ref: "refs/heads/ci/C-1/D-1/attempt-1",
  token: `ghs_${"a".repeat(190)}.${"b".repeat(195)}`,
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
  expect(input.token).toHaveLength(390);
  expect(args.join(" ")).not.toContain(
    Buffer.from(`x-access-token:${input.token}`).toString("base64"),
  );
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
test.each([1, 2048])(
  "C-349: accepts push token length %i without requiring a prefix",
  (length) => {
    const token = ".".repeat(length);
    const { env } = candidatePushCommand("/fixture", { ...input, token });
    expect(
      Buffer.from(
        env.GIT_CONFIG_VALUE_0.slice("Authorization: Basic ".length),
        "base64",
      ).toString(),
    ).toBe(`x-access-token:${token}`);
  },
);
test.each<[string, string]>([
  ["empty", ""],
  ["oversized", "a".repeat(2049)],
  ...[
    " ",
    "\t",
    "\r",
    "\n",
    "\0",
    "\x1b",
    "\x7f",
    "+",
    "/",
    "=",
    ":",
    "é",
    "\u2028",
  ].map((character, index): [string, string] => [
    `unsafe-${index}`,
    `${input.token}${character}`,
  ]),
])("C-349: rejects %s push tokens with a fixed error", (_label, token) => {
  expect(() => candidatePushCommand("/fixture", { ...input, token })).toThrow(
    "Invalid candidate push",
  );
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
