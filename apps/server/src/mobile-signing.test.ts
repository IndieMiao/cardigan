import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buffer } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  openMobileArtifact,
  requestMobileSignature,
} from "./mobile-signing.js";

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

test("Run can fetch the exact audited bytes, not a different request, Run, revoked or expired grant", async () => {
  const data = mkdtempSync(join(tmpdir(), "signed-output-"));
  const root = join(data, "mobile-signing");
  mkdirSync(join(root, "outputs"), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(root, "audit.sqlite"));
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
    const id = "1".repeat(32);
    const bytes = Buffer.from([0, 255, 16, 32]);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const spec = {
      ...scope,
      id,
      version: "test",
      app: "example.test",
      build: "sample",
      commit: "1".repeat(40),
      sha256: "2".repeat(64),
      expires: Math.floor(Date.now() / 1000) + 300,
    };
    const ctx = JSON.stringify(scope, Object.keys(scope).sort());
    db.exec(
      "CREATE TABLE grants(id TEXT PRIMARY KEY,scope TEXT UNIQUE,spec TEXT,state TEXT,output TEXT,revoked INTEGER DEFAULT 0)",
    );
    db.prepare(
      "INSERT INTO grants(id,scope,spec,state,output) VALUES(?,?,?,'signed',?)",
    ).run(id, ctx, JSON.stringify(spec), sha);
    writeFileSync(
      join(root, "routes.json"),
      JSON.stringify([{ ...spec, peer: "fixture" }]),
      { mode: 0o600 },
    );
    const path = join(root, "outputs", id);
    writeFileSync(path, bytes, { mode: 0o600 });
    const receipt = await requestMobileSignature(data, scope, () => {});
    const handle = new URLSearchParams(receipt.download.query);
    expect(handle.get("mobile_artifact")).toBe(id);
    const read = (identity = scope) =>
      openMobileArtifact(data, identity, id, () => {});
    const artifact = await read();
    expect(artifact.size).toBe(bytes.length);
    expect(await buffer(artifact.stream)).toEqual(bytes);
    expect(artifact.sha256).toEqual(receipt.sha256);
    await expect(read({ ...scope, run: "R-2" })).rejects.toThrow();
    writeFileSync(path, "changed");
    await expect(read()).rejects.toThrow();
    writeFileSync(path, bytes);
    db.exec("UPDATE grants SET revoked=1");
    await expect(read()).rejects.toThrow();
    db.prepare("UPDATE grants SET revoked=0, spec=?").run(
      JSON.stringify({ ...spec, expires: 1 }),
    );
    await expect(read()).rejects.toThrow();
  } finally {
    db.close();
    rmSync(data, { recursive: true, force: true });
  }
});
