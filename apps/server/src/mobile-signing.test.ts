import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { requestMobileSignature } from "./mobile-signing.js";

test("host and worker protocol, isolation gates and fixed platform recipes", () => {
  expect(() =>
    execFileSync(
      "/usr/bin/python3",
      [
        "-IB",
        fileURLToPath(
          new URL("../test-support/mobile-signing-test.py", import.meta.url),
        ),
      ],
      { stdio: "pipe", timeout: 20000 },
    ),
  ).not.toThrow();
}, 25_000);
test("an unprovisioned control plane cannot start a signer or expose a path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "signing-disabled-"));
  try {
    await expect(
      requestMobileSignature(
        dir,
        {
          project: "project",
          machine: "remote",
          card: "C-1",
          run: "R-1",
          assignment: "A-1",
          platform: "ios",
          worker_uid: 42,
        },
        () => {},
      ),
    ).rejects.toThrow(/^Signing unavailable$/u);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
