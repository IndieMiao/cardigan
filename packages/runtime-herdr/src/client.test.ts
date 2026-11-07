import { afterEach, expect, test, vi } from "vitest";
import { RuntimeFailure, result } from "./client.js";

afterEach(() => vi.unstubAllEnvs());
const rejected = (error: unknown) =>
  result(async () => {
    throw error;
  });

test("unexpected programming errors retain their message without stack, cause or child output", async () => {
  const error = Object.assign(
    new TypeError("this.live is not a function", {
      cause: new Error("private-cause"),
    }),
    {
      stdout: "private-stdout",
      stderr: "private-stderr",
      stack: "private-stack",
    },
  );
  expect(await rejected(error)).toEqual({
    ok: false,
    error: {
      code: "runtime_unavailable",
      message: "Runtime operation failed: this.live is not a function",
    },
  });
});

test("typed runtime failures preserve their existing error code and safe message", async () => {
  expect(
    await rejected(
      new RuntimeFailure("runtime_timeout", "hc command timed out"),
    ),
  ).toEqual({
    ok: false,
    error: { code: "runtime_timeout", message: "hc command timed out" },
  });
});

test.each([
  'MCP_TOKEN="fictional token value"',
  '{"api_key":"fictional token value"}',
  "Authorization: Bearer fictional-token-value",
  "password=fictional-token-value",
  "https://user:fictional-token-value@example.invalid/failed",
  "-----BEGIN OPENSSH PRIVATE KEY-----\nfictional-token-value\n-----END OPENSSH PRIVATE KEY-----",
])("unexpected messages redact credentials in %s", async (message) => {
  const response = await rejected(new Error(`capture failed: ${message}`));
  expect(response).toMatchObject({
    ok: false,
    error: { code: "runtime_unavailable" },
  });
  if (response.ok) throw new Error("Expected failure");
  expect(response.error.message).toContain("capture failed:");
  expect(response.error.message).toContain("[redacted]");
  expect(response.error.message).not.toMatch(/fictional[- ]token[- ]value/);
});

test("known environment credentials are removed even without a label in the message", async () => {
  vi.stubEnv("CARDIGAN_TEST_API_KEY", "fixture-unlabelled-value");
  const response = await rejected(
    new SyntaxError('Invalid response "fixture-unlabelled-value"'),
  );
  expect(JSON.stringify(response)).not.toContain("fixture-unlabelled-value");
  expect(JSON.stringify(response)).toContain("Invalid response");
});

test("non-Error throws never serialize arbitrary objects or credentials", async () => {
  expect(
    await rejected({ message: "private-message", token: "private-token" }),
  ).toEqual({
    ok: false,
    error: { code: "runtime_unavailable", message: "Runtime operation failed" },
  });
});
