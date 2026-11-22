import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buffer } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
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

const FAKE = fileURLToPath(
  new URL("../test-support/mobile-signing-fake-host.py", import.meta.url),
);
const jobScope = (run: string) => ({
  project: "project",
  machine: "worker",
  card: "C-1",
  run,
  assignment: "A-1",
  platform: "android" as const,
  worker_uid: 42,
});
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  for (let i = 0; i < 250; i++) {
    const value = await read();
    if (done(value)) return value;
    await delay(20);
  }
  throw new Error("condition not reached");
}
type Answer = Awaited<ReturnType<typeof requestMobileSignature>>;
// Poll past the legitimate in-progress answers. Every one must be well formed:
// queued never carries a request number, pending always carries this one.
async function settle(read: () => Promise<Answer>) {
  return until(read, (r) => {
    if (r.status === "queued") expect(r.request_id).toBeNull();
    if (r.status === "pending") expect(r.request_id).toBe("1".repeat(32));
    return r.status !== "queued" && r.status !== "pending";
  });
}
const accepted = (read: () => Promise<Answer>) =>
  until(read, (r) => r.status !== "queued");
function fakeHost(kind: string) {
  const data = mkdtempSync(join(tmpdir(), "signing-job-"));
  const ctl = join(data, "ctl");
  mkdirSync(ctl);
  writeFileSync(join(ctl, "kind"), kind);
  return {
    data,
    ctl,
    spawns: () =>
      existsSync(join(ctl, "spawns"))
        ? readFileSync(join(ctl, "spawns"), "utf8").trim().split("\n")
        : [],
    program: ["/usr/bin/python3", "-IB", FAKE, ctl],
  };
}

test("first call is accepted at once; polls of the same Run follow one job to its receipt", async () => {
  const host = fakeHost("slow");
  const scope = jobScope("R-7");
  let fenced = 0;
  const call = () =>
    requestMobileSignature(host.data, scope, () => fenced++, {
      program: host.program,
      acceptWaitMs: 300,
    });
  try {
    const started = Date.now();
    const first = await accepted(call);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(first).toMatchObject({
      status: "pending",
      request_id: "1".repeat(32),
      platform: "android",
      phase: "transferring",
      mode: "sign",
      deadline_seconds: 900,
      poll_after_seconds: 30,
    });
    expect(await call()).toMatchObject({
      status: "pending",
      phase: "transferring",
    });
    expect(fenced).toBe(0);
    writeFileSync(join(host.ctl, "ready"), "");
    await until(call, (r) => r.status === "pending" && r.phase === "signing");
    expect(fenced).toBe(1);
    writeFileSync(join(host.ctl, "signed"), "");
    const receipt = await until(call, (r) => r.status === "signed");
    expect(receipt).toEqual({
      status: "signed",
      request_id: "1".repeat(32),
      sha256: "a".repeat(64),
      platform: "android",
      download: {
        method: "GET",
        query: `?mobile_artifact=${"1".repeat(32)}&platform=android`,
        requires_bearer: true,
      },
    });
    // Every poll above joined the one helper: nothing was resent. The
    // receipt was re-validated against the ledger before it was returned.
    expect(host.spawns()).toEqual(["slow", "check"]);
    // After the job settles, a later call asks the ledger again (lookup only).
    writeFileSync(join(host.ctl, "kind"), "stored");
    expect(await settle(call)).toEqual(receipt);
    expect(host.spawns()).toEqual(["slow", "check", "stored", "check"]);
  } finally {
    rmSync(host.data, { recursive: true, force: true });
  }
}, 20_000);

test("a helper past its reported deadline is terminated; the next poll looks the same request up", async () => {
  const host = fakeHost("hang");
  const call = () =>
    requestMobileSignature(host.data, jobScope("R-8"), () => {}, {
      program: host.program,
      acceptWaitMs: 100,
      graceMs: 200,
      killMs: 2_000,
    });
  try {
    expect(await accepted(call)).toMatchObject({
      status: "pending",
      deadline_seconds: 1,
    });
    await until(
      async () => existsSync(join(host.ctl, "terminated")),
      (gone) => gone,
    );
    writeFileSync(join(host.ctl, "kind"), "lookup");
    expect(await settle(call)).toMatchObject({
      status: "signed",
      request_id: "1".repeat(32),
    });
    expect(host.spawns()).toEqual(["hang", "lookup", "check"]);
  } finally {
    rmSync(host.data, { recursive: true, force: true });
  }
}, 20_000);

test("a Run that is no longer current at the fence never commits", async () => {
  const host = fakeHost("stored");
  try {
    expect(
      await requestMobileSignature(
        host.data,
        jobScope("R-9"),
        () => {
          throw new Error("stale Run");
        },
        { program: host.program, acceptWaitMs: 5_000, killMs: 2_000 },
      ),
      // Claimed but never dispatched: from now on only a lookup is possible.
    ).toMatchObject({ status: "unconfirmed", request_id: "1".repeat(32) });
    expect(existsSync(join(host.ctl, "committed"))).toBe(false);
  } finally {
    rmSync(host.data, { recursive: true, force: true });
  }
}, 20_000);

test("before the durable claim the call reports queued without a request number", async () => {
  const host = fakeHost("unclaimed");
  const call = () =>
    requestMobileSignature(host.data, jobScope("R-10"), () => {}, {
      program: host.program,
      acceptWaitMs: 100,
    });
  try {
    expect(await call()).toEqual({
      status: "queued",
      request_id: null,
      platform: "android",
      elapsed_seconds: expect.any(Number),
      poll_after_seconds: 5,
    });
    expect(await call()).toMatchObject({ status: "queued", request_id: null });
    writeFileSync(join(host.ctl, "claim"), "");
    // After the claim, pending (with the number) is a legitimate step.
    expect(await settle(call)).toMatchObject({
      status: "signed",
      request_id: "1".repeat(32),
    });
    expect(host.spawns()).toEqual(["unclaimed", "check"]);
  } finally {
    rmSync(host.data, { recursive: true, force: true });
  }
}, 20_000);

test("a claimed attempt that ended without a result is unconfirmed, then looked up, never re-signed", async () => {
  const host = fakeHost("lost");
  const call = () =>
    requestMobileSignature(host.data, jobScope("R-11"), () => {}, {
      program: host.program,
      acceptWaitMs: 2_000,
    });
  try {
    expect(await settle(call)).toEqual({
      status: "unconfirmed",
      request_id: "1".repeat(32),
      platform: "android",
      poll_after_seconds: 60,
    });
    // E.g. the operator reconciled peer_signed; the ledger only allows lookup.
    writeFileSync(join(host.ctl, "kind"), "lookup");
    // Side by side (V-2954): a restarted server has no job memory at all...
    vi.resetModules();
    const restarted = await import("./mobile-signing.js");
    // A fresh module instance: its in-flight job table starts empty.
    expect(restarted.requestMobileSignature).not.toBe(requestMobileSignature);
    expect(
      await settle(() =>
        restarted.requestMobileSignature(
          host.data,
          jobScope("R-11"),
          () => {},
          { program: host.program, acceptWaitMs: 2_000 },
        ),
      ),
    ).toMatchObject({ status: "signed", request_id: "1".repeat(32) });
    // ...and the live server, which remembers the failed attempt, must not
    // need a restart: its next poll looks the same request up as well.
    expect(await settle(call)).toMatchObject({
      status: "signed",
      request_id: "1".repeat(32),
    });
    expect(host.spawns()).toEqual([
      "lost",
      "lookup",
      "check",
      "lookup",
      "check",
    ]);
  } finally {
    rmSync(host.data, { recursive: true, force: true });
  }
}, 20_000);

test("a success the ledger no longer releases is not reported, and a refusal before the claim throws", async () => {
  const host = fakeHost("slow");
  const call = () =>
    requestMobileSignature(host.data, jobScope("R-12"), () => {}, {
      program: host.program,
      acceptWaitMs: 100,
    });
  try {
    expect(await accepted(call)).toMatchObject({ status: "pending" });
    writeFileSync(join(host.ctl, "ready"), "");
    // Revoked (or expired) after signing, before the next poll.
    writeFileSync(join(host.ctl, "revoked"), "");
    writeFileSync(join(host.ctl, "signed"), "");
    await expect(until(call, () => false)).rejects.toThrow(
      /^Signing unavailable$/u,
    );
    writeFileSync(join(host.ctl, "kind"), "refused");
    await expect(call()).rejects.toThrow(/^Signing unavailable$/u);
    expect(host.spawns()).toEqual(["slow", "check", "refused"]);
  } finally {
    rmSync(host.data, { recursive: true, force: true });
  }
}, 20_000);
