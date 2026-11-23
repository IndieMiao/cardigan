import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { registerChainCandidate } from "./mobile-signing.js";

const HOST = fileURLToPath(
  new URL("../../../deploy/mobile-signing/host.py", import.meta.url),
);
test("the real host registers and approves a release-chain candidate once per Run", async () => {
  const data = mkdtempSync(join(tmpdir(), "chain-grant-"));
  const root = join(data, "mobile-signing");
  mkdirSync(root, { mode: 0o700 });
  try {
    const scope = {
      project: "project",
      machine: "worker",
      assignment: "A-1",
      run: "R-1",
      card: "C-1",
      platform: "android" as const,
      worker_uid: 42,
    };
    writeFileSync(
      join(root, "routes.json"),
      JSON.stringify([
        {
          project: "project",
          machine: "worker",
          platform: "android",
          app: "example.test",
          version: "test-v1",
          peer: "fixture",
        },
      ]),
      { mode: 0o600 },
    );
    const bytes = Buffer.from("unsigned-apk");
    const candidate = (b = bytes, decision = "Q-1") => ({
      decision,
      commit: "c".repeat(40),
      sha256: createHash("sha256").update(b).digest("hex"),
      size: b.length,
      build: "attachment-7",
      source: async () => Readable.from([b]),
    });
    const current = vi.fn();
    const first = await registerChainCandidate(
      data,
      scope,
      candidate(),
      current,
    );
    expect(first).toMatchObject({ status: "new" });
    expect(first.request_id).toMatch(/^[0-9a-f]{32}$/u);
    expect(current).toHaveBeenCalled();
    await expect(
      registerChainCandidate(data, scope, candidate(), current),
    ).resolves.toEqual({ ...first, status: "existing" });
    await expect(
      registerChainCandidate(
        data,
        scope,
        candidate(Buffer.from("other")),
        current,
      ),
    ).resolves.toEqual({ ...first, status: "other" });
    // Another chain never adopts this Run's candidate.
    await expect(
      registerChainCandidate(data, scope, candidate(bytes, "Q-2"), current),
    ).resolves.toEqual({ ...first, status: "other" });
    const shown = JSON.parse(
      execFileSync(
        "/usr/bin/python3",
        ["-IB", HOST, root, "show", first.request_id],
        {
          encoding: "utf8",
        },
      ),
    );
    expect(shown).toMatchObject({
      state: "approved",
      revoked: false,
      candidate: {
        app: "example.test",
        version: "test-v1",
        commit: "c".repeat(40),
        build: "attachment-7",
        sha256: candidate().sha256,
        run: "R-1",
      },
    });
    // Bytes that do not match the bound digest register nothing.
    await expect(
      registerChainCandidate(
        data,
        { ...scope, run: "R-2" },
        {
          ...candidate(),
          source: async () => Readable.from([Buffer.from("x")]),
        },
        current,
      ),
    ).rejects.toThrow(/^Signing unavailable$/u);
    await expect(
      registerChainCandidate(
        data,
        { ...scope, run: "R-2" },
        candidate(),
        () => {
          throw new Error("Run gone");
        },
      ),
    ).rejects.toThrow("Run gone");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
