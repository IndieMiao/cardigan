import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { crc32, inflateSync } from "node:zlib";
import { decisionCategories, states, validateRole } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startFixtureWeb } from "../test-support/fixture-web.mjs";
import {
  FIXTURE_NOW,
  FIXTURE_PROJECT,
  generateFixture,
  PIXEL,
  PROFILES,
  tableDigests,
} from "../test-support/synthetic-fixture.mjs";
import { MERGE_STATUSES } from "../test-support/synthetic-scenarios.mjs";

let root: string;
let out: string;
let store: Store;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "synthetic-fixture-test-"));
  out = join(root, "data");
  await generateFixture({ out, profile: "small" });
  store = Store.open({ dbPath: join(out, "cardigan.db") });
});
afterAll(async () => {
  store?.close();
  await rm(root, { recursive: true, force: true });
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing synthetic fixture value");
  return value;
}

const covers = (values: unknown[], expected: readonly unknown[]) =>
  expect([...new Set(values)].sort()).toEqual([...expected].sort());

test("small data is reproducible across every table and responds to seed changes", async () => {
  const original = JSON.parse(
    await readFile(join(out, "manifest.json"), "utf8"),
  );
  const repeated = await generateFixture({
    out: join(root, "same"),
    profile: "small",
  });
  const different = await generateFixture({
    out: join(root, "different"),
    profile: "small",
    seed: 288,
  });
  expect(repeated).toEqual(original);
  expect(different.tables.cards.sha256).not.toBe(original.tables.cards.sha256);
  expect(original.counts).toEqual({
    ...PROFILES.small,
    cards: PROFILES.small.cards + 1,
  });
  expect(
    store.database.prepare("PRAGMA integrity_check").get()?.integrity_check,
  ).toBe("ok");
  expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("the image placeholder has valid PNG checksums and decodable pixel data", () => {
  const imageData: Buffer[] = [];
  for (let offset = 8; offset < PIXEL.length; ) {
    const length = PIXEL.readUInt32BE(offset);
    const chunk = PIXEL.subarray(offset + 4, offset + 8 + length);
    expect(crc32(chunk)).toBe(PIXEL.readUInt32BE(offset + 8 + length));
    if (chunk.toString("ascii", 0, 4) === "IDAT")
      imageData.push(chunk.subarray(4));
    offset += length + 12;
  }
  expect(inflateSync(Buffer.concat(imageData))).toEqual(
    Buffer.from([0, 86, 130, 200]),
  );
});

test("covers state vocabulary, linked evidence, identities and content boundaries", () => {
  store.uow.read((tx) => {
    const cards = tx.cards.list(FIXTURE_PROJECT);
    covers(
      cards.map((v) => v.status),
      states.card,
    );
    covers(
      cards.flatMap((v) => (v.resolution ? [v.resolution] : [])),
      ["done", "superseded", "duplicate", "wontdo"],
    );
    covers(
      cards.map((v) => v.template),
      tx.card_templates.list(FIXTURE_PROJECT).map((v) => v.id),
    );
    expect(new Set(cards.map((v) => v.risk_tags?.join(","))).size).toBe(8);
    expect(cards.find((v) => v.id === "C-14")?.sensitive).toBe(true);
    expect(cards.find((v) => v.id === "C-3")?.title.length).toBeGreaterThan(
      300,
    );
    expect(cards.find((v) => v.id === "C-3")?.goal.length).toBeGreaterThan(
      5000,
    );
    expect(tx.cards.list("synthetic-empty")).toHaveLength(0);
    expect(tx.cards.list("synthetic-single")).toHaveLength(1);
    const work = tx.work_items.list(FIXTURE_PROJECT);
    for (const kind of ["produce", "verify"] as const) {
      covers(
        work.filter((v) => v.kind === kind).map((v) => v.status),
        states[kind],
      );
      covers(
        work.filter((v) => v.kind === kind).map((v) => v.required),
        [true, false],
      );
    }
    for (const item of work) {
      expect(cards.some((c) => c.id === item.card_id)).toBe(true);
      expect(
        tx.assignments.get(FIXTURE_PROJECT, required(item.assignment_id))
          ?.work_item_id,
      ).toBe(item.id);
      if (item.target_work_item_id)
        expect(
          work.find((v) => v.id === item.target_work_item_id),
        ).toMatchObject({ kind: "produce", card_id: item.card_id });
    }
    const decisions = tx.decisions.list(FIXTURE_PROJECT);
    covers(
      decisions.map((v) => v.kind),
      ["approve", "choose"],
    );
    covers(
      decisions.map((v) => v.category),
      decisionCategories,
    );
    covers(
      decisions.map((v) => v.status),
      states.decision,
    );
    covers(
      decisions
        .filter((v) => v.trigger === "merge_confirmation")
        .map((v) => v.status),
      states.decision,
    );
    expect(
      decisions.some((v) => v.status === "open" && v.decider === "human"),
    ).toBe(true);
    expect(
      decisions.some((v) => v.status === "open" && v.decider === "role:pm"),
    ).toBe(true);
    const soon = required(decisions.find((v) => v.id === "Q-2"));
    const overdue = required(decisions.find((v) => v.id === "Q-3"));
    expect(Date.parse(required(soon.latest_by)) - Date.parse(FIXTURE_NOW)).toBe(
      300000,
    );
    expect(
      Date.parse(required(overdue.latest_by)) - Date.parse(FIXTURE_NOW),
    ).toBe(-300000);
    const actions = tx.human_actions.list(FIXTURE_PROJECT);
    covers(
      actions.map((v) => v.status),
      states.human_action,
    );
    covers(
      actions.map((v) => v.triage),
      ["pm_ops", "human", "host"],
    );
    const reviews = tx.reviews.list(FIXTURE_PROJECT);
    expect(reviews.some((v) => v.verdict === "pass")).toBe(true);
    expect(reviews.some((v) => v.issues.some((i) => i.must_fix))).toBe(true);
    for (const review of reviews) {
      const delivery = required(
        tx.deliveries.get(FIXTURE_PROJECT, review.delivery_id),
      );
      expect(delivery.subject.value).toBe(review.target_sha);
      const author = required(tx.runs.get(FIXTURE_PROJECT, delivery.run_id));
      const reviewer = required(tx.runs.get(FIXTURE_PROJECT, review.run_id));
      expect(author.employee_id).not.toBe(reviewer.employee_id);
    }
    const assignments = tx.assignments.list(FIXTURE_PROJECT);
    expect(
      assignments
        .filter((v) => v.scope === "standing")
        .map((v) => [v.role_id, v.standing_mode]),
    ).toEqual([
      ["pm", "office"],
      ["pm", "ops"],
      ["host_ops", undefined],
    ]);
    expect(tx.employees.list().filter((v) => v.avatar)).toHaveLength(5);
    expect(
      new Set(tx.employees.list().map((v) => v.launch_profile_ref)).size,
    ).toBe(3);
    const timeline = tx.timeline.list(FIXTURE_PROJECT);
    expect(timeline.filter((v) => v.card_id === "C-1")).toHaveLength(0);
    expect(timeline.filter((v) => v.card_id === "C-2")).toHaveLength(1);
    expect(timeline.filter((v) => v.card_id === "C-3")).toHaveLength(300);
    expect(
      tx.attachments.list(FIXTURE_PROJECT).filter((v) => v.card_id === "C-3"),
    ).toHaveLength(12);
    for (const run of tx.runs.list(FIXTURE_PROJECT))
      expect(
        tx.events
          .listAfter(
            FIXTURE_PROJECT,
            required(work.find((w) => w.assignment_id === run.assignment_id))
              .card_id,
            0,
          )
          .some((e) => e.id === run.trigger_event_id),
      ).toBe(true);
  });
  expect(store.webPasswordConfigured()).toBe(false);
  for (const table of ["tokens", "web_sessions"])
    expect(
      store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
    ).toBe(0);
});

test("independent Web renders relationships, merge checks, notices and blobs; preview rejects writes", async () => {
  const before = tableDigests(store.database);
  const staticDir = join(root, "static");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(staticDir);
  await writeFile(
    join(staticDir, "index.html"),
    "<!doctype html><title>Synthetic</title>",
  );
  const preview = await startFixtureWeb({
    out,
    password: "synthetic-preview-password",
    staticDir,
  });
  try {
    expect((await fetch(`${preview.url}/api/projects`)).status).toBe(401);
    const login = await fetch(`${preview.url}/api/login`, {
      method: "POST",
      headers: { origin: preview.url, "content-type": "application/json" },
      body: JSON.stringify({ password: "synthetic-preview-password" }),
    });
    expect(login.status).toBe(200);
    const cookie = required(login.headers.get("set-cookie"));
    const get = async (path: string) => {
      const response = await fetch(preview.url + path, { headers: { cookie } });
      expect(response.status, path).toBe(200);
      return response.json();
    };
    const child = await get("/api/projects/synthetic/cards/C-5");
    expect(child.relations.source_card).toMatchObject({
      id: "C-4",
      decision_id: "Q-1",
    });
    const board = await get("/api/projects/synthetic/cards?limit=50");
    covers(
      board.cards.map((card: { status: string }) => card.status),
      states.card,
    );
    for (const [i, status] of MERGE_STATUSES.entries()) {
      const detail = await get(`/api/projects/synthetic/cards/C-${20 + i}`);
      expect(detail.card.merge_check.status).toBe(status);
    }
    const needs = await get("/api/projects/synthetic/needs-you");
    expect(needs.notices.length).toBeGreaterThan(0);
    await get("/api/projects/synthetic/execution");
    const attachment = await fetch(
      `${preview.url}/api/projects/synthetic/attachments/attachment-1`,
      { headers: { cookie } },
    );
    expect(attachment.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await attachment.arrayBuffer())).toEqual(PIXEL);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      expect(
        (
          await fetch(`${preview.url}/api/projects/synthetic/cards`, {
            method,
            headers: { cookie, origin: preview.url },
          })
        ).status,
      ).toBe(405);
    expect(
      (
        await fetch(`${preview.url}/api/projects`, {
          headers: { cookie, origin: "https://example.invalid" },
        })
      ).status,
    ).toBe(403);
  } finally {
    await preview.close();
  }
  expect(tableDigests(store.database)).toEqual(before);
  expect(store.webPasswordConfigured()).toBe(false);
});

test("preview cannot send credentials to another upstream through normalized request paths", async () => {
  let received = 0;
  const sink = createServer((_req, res) => {
    received++;
    res.end("synthetic-sink");
  });
  await new Promise<void>((resolve, reject) => {
    sink.once("error", reject);
    sink.listen(0, "127.0.0.1", resolve);
  });
  let preview: { url: string; close(): Promise<void> } | undefined;
  try {
    preview = await startFixtureWeb({
      out,
      password: "synthetic-preview-password",
    });
    const login = await fetch(`${preview.url}/api/login`, {
      method: "POST",
      headers: { origin: preview.url, "content-type": "application/json" },
      body: JSON.stringify({ password: "synthetic-preview-password" }),
    });
    expect(login.status).toBe(200);
    const cookie = required(login.headers.get("set-cookie"));
    const address = new URL(preview.url);
    const target = `127.0.0.1:${(sink.address() as AddressInfo).port}`;
    // node:http preserves the raw request target; fetch would normalize it first.
    const raw = (path: string) =>
      new Promise<{ status: number | undefined; body: string }>(
        (resolve, reject) => {
          const req = request(
            {
              hostname: address.hostname,
              port: address.port,
              path,
              headers: { cookie, origin: address.origin },
            },
            (res) => {
              let body = "";
              res.setEncoding("utf8");
              res.on("data", (chunk) => {
                body += chunk;
              });
              res.on("end", () => resolve({ status: res.statusCode, body }));
              res.on("error", reject);
            },
          );
          req.on("error", reject);
          req.end();
        },
      );
    for (const path of [
      `/%2e//${target}/synthetic-probe`,
      `/.//${target}/synthetic-probe`,
      `/part/%2e%2e//${target}/synthetic-probe`,
      `/%2E%2E//${target}/synthetic-probe?check=1`,
      `/%2e/\\${target}/synthetic-probe`,
      `//${target}/synthetic-probe`,
      `http://${target}/synthetic-probe`,
    ]) {
      expect((await raw(path)).status, path).toBe(403);
    }
    expect(received).toBe(0);
    const normal = await raw("/api/projects/synthetic/./cards?limit=1&page=2");
    expect(normal.status).toBe(200);
    expect(JSON.parse(normal.body)).toMatchObject({ page: 2, page_size: 1 });
  } finally {
    await preview?.close();
    await new Promise<void>((resolve, reject) =>
      sink.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("generated role details satisfy the Web presentation and domain contracts", async () => {
  const preview = await startFixtureWeb({
    out,
    password: "synthetic-preview-password",
  });
  try {
    const login = await fetch(`${preview.url}/api/login`, {
      method: "POST",
      headers: { origin: preview.url, "content-type": "application/json" },
      body: JSON.stringify({ password: "synthetic-preview-password" }),
    });
    expect(login.status).toBe(200);
    const headers = { cookie: required(login.headers.get("set-cookie")) };
    const catalog = await fetch(`${preview.url}/api/projects/synthetic/roles`, {
      headers,
    });
    expect(catalog.status).toBe(200);
    const { roles } = await catalog.json();
    expect(roles).toHaveLength(7);
    for (const { role_id } of roles) {
      const response = await fetch(
        `${preview.url}/api/projects/synthetic/roles/${role_id}`,
        { headers },
      );
      expect(response.status).toBe(200);
      const { role } = await response.json();
      expect(validateRole(role).ok, role_id).toBe(true);
      expect(role).toMatchObject({
        role_id,
        version: 1,
        status: "active",
        display_name: expect.any(String),
        harness: expect.any(String),
        launch_profile_ref: expect.any(String),
        core_prompt: expect.any(String),
        instructions: expect.any(String),
        allowed_tools: [],
        capabilities: [],
        abilities: expect.any(Array),
        required_machine_tags: expect.any(Array),
      });
      expect(["produce", "verify", "standing"]).toContain(role.kind);
      expect(["none", "readonly", "write"]).toContain(role.worktree);
      // RoleFields renders these arrays without optional guards.
      for (const key of [
        "allowed_tools",
        "capabilities",
        "abilities",
        "required_machine_tags",
      ]) {
        expect(Array.isArray(role[key]), key).toBe(true);
        expect(
          role[key].every((value: unknown) => typeof value === "string"),
        ).toBe(true);
      }
    }
  } finally {
    await preview.close();
  }
});

test("CLI works with private files inaccessible and refuses existing output", async () => {
  const directory = join(root, "sandboxed");
  const repo = resolve(import.meta.dirname, "../../..");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--permission",
      `--allow-fs-read=${repo}`,
      `--allow-fs-read=${root}`,
      `--allow-fs-write=${root}`,
      join(repo, "apps/server/test-support/synthetic-fixture.mjs"),
      "--out",
      directory,
      "--seed",
      "0",
      "--profile",
      "small",
    ],
    {
      env: {
        ...process.env,
        CARDIGAN_DATA_DIR: "/synthetic-inaccessible-data",
        CARDIGAN_CONFIG_DIR: "/synthetic-inaccessible-config",
        CARDIGAN_PRIORITY_MIGRATION_THRESHOLDS: "1,2,unbounded",
      },
    },
  );
  expect(JSON.parse(stdout)).toMatchObject({ seed: 0, profile: "small" });
  const before = await readFile(join(directory, "manifest.json"));
  await expect(
    generateFixture({ out: directory, profile: "small" }),
  ).rejects.toThrow();
  expect(await readFile(join(directory, "manifest.json"))).toEqual(before);
  await expect(
    generateFixture({ out: join(root, "invalid"), seed: -1 }),
  ).rejects.toThrow();
  await expect(
    generateFixture({ out: join(root, "invalid"), profile: "unknown" }),
  ).rejects.toThrow();
});
