/** C-807: the background sync preflights browser uploads and keeps the owner's to-do in step. */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  loadCommandState,
  Offsite,
  OssError,
  type OssTransport,
} from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  type FakeOss,
  startFakeOss,
  writeStorageConfig,
} from "../../../packages/mcp-server/test-support/fake-oss.js";
import { recordStorageCors } from "./offsite-cors-notice.js";
import {
  OFFSITE_CORS_RECHECK_MS,
  OFFSITE_CORS_RECHECK_OK_MS,
  type OffsiteCorsReport,
  OffsiteSync,
} from "./offsite-sync.js";
import { workbenchOrigins } from "./web/config.js";

const ORIGINS = ["https://gs66.example.ts.net", "https://cardigan.example"];
let root: string, dataDir: string, configDir: string;
let fake: FakeOss, clock: Date;
let store: Store;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cardigan-offsite-cors-"));
  dataDir = join(root, "data");
  configDir = join(root, "config");
  await mkdir(dataDir, { mode: 0o700 });
  clock = new Date("2026-11-27T03:00:00.000Z");
  fake = await startFakeOss(() => clock);
  store = Store.open({ dbPath: ":memory:" });
  store.createProject({ id: "cardigan" });
});
afterEach(async () => {
  store.close();
  await fake.close();
  await rm(root, { recursive: true, force: true });
});

type Bucket = "none" | "rule" | "other" | "down";
/** Answers preflights like OSS; records what was sent. */
function bucket(state: { mode: Bucket }) {
  const sent: {
    url: string;
    method: string;
    headers: Record<string, string>;
  }[] = [];
  const transport: OssTransport = async (url, init) => {
    sent.push({ url, method: init.method, headers: { ...init.headers } });
    if (state.mode === "down") throw new OssError("network");
    const origin = init.headers.origin ?? "";
    const reply = (statusCode: number, headers: object, body = "") =>
      Object.assign(Readable.from([Buffer.from(body)]), {
        statusCode,
        headers,
      }) as unknown as IncomingMessage;
    if (state.mode === "none")
      return reply(
        403,
        {},
        "<Message>CORS is not enabled for this bucket.</Message>",
      );
    if (state.mode === "other" || !ORIGINS.includes(origin))
      return reply(
        403,
        {},
        "<Message>CORSResponse: This CORS request is not allowed.</Message>",
      );
    return reply(200, {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "PUT,GET,HEAD",
      "access-control-allow-headers": "content-type,x-oss-forbid-overwrite",
    });
  };
  return { transport, sent };
}

async function harness(state: { mode: Bucket }) {
  const offsite = new Offsite({
    dataDir,
    storageDir: await writeStorageConfig(configDir, fake),
    role: "background",
    now: () => clock,
  });
  const reports: OffsiteCorsReport[] = [];
  const b = bucket(state);
  const sync = new OffsiteSync({
    offsite,
    store,
    now: () => clock,
    corsOrigins: ORIGINS,
    corsTransport: b.transport,
    onCors: (report) => {
      reports.push(report);
      recordStorageCors(store, report, { now: () => clock.toISOString() });
    },
  });
  return {
    offsite,
    sync,
    reports,
    sent: b.sent,
    status: async () =>
      JSON.parse(
        await readFile(join(dataDir, "offsite", "status.json"), "utf8"),
      ),
    actions: () =>
      store.uow.read((tx) => loadCommandState(tx, "cardigan")).human_actions,
  };
}
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

test("C-807: a bucket without CORS shows on health, opens one to-do, and both clear once the rule is added", async () => {
  const state = { mode: "none" as Bucket };
  const h = await harness(state);
  await h.sync.tick();

  // Health: the reason and the rule, for every Workbench origin.
  const view = h.offsite.status();
  expect(view.alerts).toContain("cors_blocked");
  expect(view.cors?.blocked).toEqual({
    reason: "not_enabled",
    rule: {
      origins: ORIGINS,
      methods: ["PUT", "GET", "HEAD"],
      headers: ["content-type", "x-oss-forbid-overwrite"],
    },
  });
  expect(
    (await h.status()).cors.results.map((r: { verdict: string }) => r.verdict),
  ).toEqual(["not_enabled", "not_enabled"]);
  // One preflight per origin, without any credential or signed URL.
  expect(h.sent).toHaveLength(2);
  for (const req of h.sent) {
    expect(req.method).toBe("OPTIONS");
    expect(req.url).not.toContain("?");
    expect(req.headers.authorization).toBeUndefined();
    expect(Object.keys(req.headers).sort()).toEqual([
      "access-control-request-headers",
      "access-control-request-method",
      "origin",
    ]);
  }
  // The status file and the to-do never hold a secret or a signed URL.
  const written = JSON.stringify([await h.status(), h.actions()]);
  for (const secret of [
    fake.credentials.access_key_id,
    fake.credentials.access_key_secret,
    "x-oss-signature",
    "x-oss-credential",
  ])
    expect(written).not.toContain(secret);

  const [action] = h.actions();
  expect(action).toMatchObject({ status: "open", category: "account" });
  expect(action?.instructions).toContain("跨域设置");

  // Within the recheck window nothing is sent again.
  await h.sync.tick();
  expect(h.sent).toHaveLength(2);
  expect(h.reports).toHaveLength(1);

  // The owner adds the rule: the next recheck clears health and the to-do.
  state.mode = "rule";
  advance(OFFSITE_CORS_RECHECK_MS);
  await h.sync.tick();
  expect(h.sent).toHaveLength(4);
  expect(h.offsite.status().alerts).not.toContain("cors_blocked");
  expect(h.offsite.status().cors?.blocked).toBeUndefined();
  expect(h.actions().map((a) => [a.status, a.cancellation?.source])).toEqual([
    ["cancelled", "storage_rechecked"],
  ]);
  expect(h.reports.at(-1)?.refused).toEqual([]);

  // A passing check is repeated only after the longer interval.
  advance(OFFSITE_CORS_RECHECK_MS);
  await h.sync.tick();
  expect(h.sent).toHaveLength(4);
  advance(OFFSITE_CORS_RECHECK_OK_MS);
  await h.sync.tick();
  expect(h.sent).toHaveLength(6);
  expect(h.reports).toHaveLength(2);
});

test("C-807: a rule for other origins is refused with not_allowed", async () => {
  const h = await harness({ mode: "other" });
  await h.sync.tick();
  expect(h.offsite.status().cors?.blocked?.reason).toBe("not_allowed");
  expect(h.reports.at(-1)?.refused).toEqual(
    ORIGINS.map((origin) => ({ origin, reason: "not_allowed" })),
  );
  expect(h.actions()).toHaveLength(1);
});

test("C-807: an unreachable bucket neither opens nor closes the to-do", async () => {
  const state = { mode: "none" as Bucket };
  const h = await harness(state);
  await h.sync.tick();
  expect(h.actions().map((a) => a.status)).toEqual(["open"]);
  state.mode = "down";
  advance(OFFSITE_CORS_RECHECK_MS);
  await h.sync.tick();
  expect(h.reports).toHaveLength(1);
  expect(h.actions().map((a) => a.status)).toEqual(["open"]);
  // Nothing proves a refusal now, so health drops the CORS alert.
  expect(h.offsite.status().cors?.origins.map((o) => o.verdict)).toEqual([
    "unreachable",
    "unreachable",
  ]);
  expect(h.offsite.status().alerts).not.toContain("cors_blocked");
});

test("C-807: without Workbench origins nothing is sent", async () => {
  const h = await harness({ mode: "none" });
  const sync = new OffsiteSync({
    offsite: h.offsite,
    store,
    now: () => clock,
    corsTransport: bucket({ mode: "none" }).transport,
  });
  await sync.tick();
  expect(h.offsite.status().cors).toBeUndefined();
  expect(h.actions()).toEqual([]);
});

test("C-807: the checked origins are the public ones, or the loopback listener", () => {
  expect(workbenchOrigins({ port: 7781, publicOrigins: ORIGINS })).toEqual(
    ORIGINS,
  );
  expect(workbenchOrigins({ port: 7781, publicOrigins: [] })).toEqual([
    "http://localhost:7781",
    "http://127.0.0.1:7781",
  ]);
  expect(workbenchOrigins({ port: 0, publicOrigins: [] })).toEqual([]);
});

test("C-807: without the platform project the report is a no-op", () => {
  const other = Store.open({ dbPath: ":memory:" });
  try {
    other.createProject({ id: "p" });
    recordStorageCors(
      other,
      {
        bucket: "cardigan-fixture",
        region: "us-west-1",
        origins: ORIGINS,
        refused: [{ origin: ORIGINS[0] as string, reason: "not_enabled" }],
      },
      { now: () => clock.toISOString() },
    );
    expect(
      other.uow.read((tx) => loadCommandState(tx, "p")).human_actions,
    ).toEqual([]);
  } finally {
    other.close();
  }
});
