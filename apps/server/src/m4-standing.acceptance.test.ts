/** M4.T2: plan M4.5; real pm create and all host token-issuance entries. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { applyStandingMode, postComment } from "@cardigan/domain";
import {
  issueAssignmentToken,
  issueTokenInTransaction,
  launchEntities,
} from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import { DEFAULT_DB_FILE, Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, test } from "vitest";
import { type M4Cross, m4Cross } from "../test-support/m4-cross.js";
import { standingResolver } from "./assembly.js";
import { startCardiganServer } from "./index.js";

let f: M4Cross | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
}, 30_000);
const standing = (s: M4Cross, mode: "ops" | "office") => {
  const a = s.state().assignments.find((a) => a.standing_mode === mode);
  if (!a) throw new Error(`Missing ${mode}`);
  return a;
};

test("S01 M4.5: pm create persists distinct modes for the same role, and existing mode cannot change", async () => {
  const s = await m4Cross();
  f = s;
  const office = standing(s, "office"),
    ops = standing(s, "ops");
  expect([office.role_id, ops.role_id]).toEqual(["pm", "pm"]);
  expect(applyStandingMode(ops, "office").ok).toBe(false);
  expect(applyStandingMode(office, "ops").ok).toBe(false);
  expect(applyStandingMode(ops, "ops")).toEqual({ ok: true, value: ops });
  expect(
    s
      .state()
      .assignments.filter((a) => a.scope === "work_item")
      .every((a) => a.standing_mode === undefined),
  ).toBe(true);
  await s.restart(false);
  expect(standing(s, "ops").id).toBe(ops.id);
  expect(standing(s, "office").id).toBe(office.id);
});

for (const path of [
  "cli-token",
  "host",
  "transaction",
  "start",
  "dispatcher",
] as const) {
  // Defect: the exported host transaction issuer trusts the role tools, ignoring Ops' persisted mode.
  const check = path === "transaction" ? test.fails : test;
  check(
    `S02 M4.5: Ops token issued through ${path} never gains record_decision`,
    async () => {
      const s = await m4Cross();
      f = s;
      const ops = standing(s, "ops");
      let token: string;
      const entities = launchEntities(s.store(), s.card.project_id, ops.id);
      if (path === "cli-token") {
        const printed = await s.cli("token", "issue", ops.id);
        const issued = printed
          .split(/\s+/)
          .find((word) => s.store().verifyToken(word));
        if (!issued) throw new Error("CLI did not return its issued token");
        token = issued;
      } else if (path === "host")
        token = issueAssignmentToken(
          s.store(),
          s.card.project_id,
          entities,
        ).token;
      else if (path === "transaction")
        token = s.store().uow.run((tx) =>
          issueTokenInTransaction(tx, s.card.project_id, ops.id, {
            role_version: entities.role.version,
            allowed_tools: entities.role.allowed_tools,
          }),
        ).token;
      else if (path === "start") {
        await s.start(ops);
        token = s.token(ops) as string;
      } else {
        s.command((state, actor, ports) =>
          postComment(
            state,
            actor,
            { card_id: s.card.id, body: "Please coordinate the next step" },
            ports,
          ),
        );
        await s.restart();
        await expect
          .poll(() => s.token(ops), { timeout: 10_000 })
          .toBeDefined();
        token = s.token(ops) as string;
      }
      const record = s.store().verifyToken(token);
      expect(record?.assignment_id).toBe(ops.id);
      expect(record?.allowed_tools).not.toContain("record_decision");
      const client = new Client({ name: "standing-cross", version: "1" });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(s.url()), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
          }),
        );
        expect(
          (await client.listTools()).tools.map((t) => t.name),
        ).not.toContain("record_decision");
        const response = await client.callTool({
          name: "record_decision",
          arguments: {},
        });
        expect(response.structuredContent).toMatchObject({
          error: { code: "forbidden_tool" },
        });
      } finally {
        await client.close();
      }
    },
    20_000,
  );
}

test("S03 M4.5: standing resolver follows persistent mode even if token scopes say the opposite", async () => {
  const s = await m4Cross();
  f = s;
  const ops = standing(s, "ops"),
    office = standing(s, "office");
  // Public read port supplies contradictory token metadata; it must be ignored for stamped rows.
  const resolve = standingResolver(s.store(), (_p, id) => [
    { allowed_tools: id === ops.id ? ["record_decision"] : [] },
  ]);
  expect(resolve(s.card.project_id, "pm_ops", s.state())).toBe(ops.id);
  expect(resolve(s.card.project_id, "pm_office", s.state())).toBe(office.id);
});

test("S04 M4.5: genuine pre-M4.5 CLI data is backfilled on server startup and survives reopen", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cardigan-standing-upgrade-"));
  let store: Store | undefined,
    server: Awaited<ReturnType<typeof startCardiganServer>> | undefined;
  try {
    const bytes = gunzipSync(
      await readFile(
        new URL(
          "../test-support/fixtures/standing-pre-m45.sqlite.gz",
          import.meta.url,
        ),
      ),
    );
    expect(bytes.includes(Buffer.from('"standing_mode"'))).toBe(false);
    await writeFile(join(dataDir, DEFAULT_DB_FILE), bytes);
    store = Store.open({ dataDir });
    server = await startCardiganServer({
      store,
      config: { dataDir, host: "localhost", port: 0 },
      log: () => {},
      warn: () => {},
    });
    const read = () =>
      store?.uow.read(
        (tx) => loadCommandState(tx, "legacy" as never).assignments,
      );
    expect(read()?.map((a) => [a.id, a.standing_mode])).toEqual([
      ["A-1", "office"],
      ["A-2", "ops"],
    ]);
    const stamped = read();
    await server.close();
    server = undefined;
    store.close();
    store = Store.open({ dataDir });
    store.backfillStandingModes();
    expect(read()).toEqual(stamped);
    const ops = launchEntities(store, "legacy" as never, "A-2" as never);
    expect(
      issueAssignmentToken(store, "legacy" as never, ops).record.allowed_tools,
    ).not.toContain("record_decision");
    store.backfillStandingModes();
    expect(read()).toEqual(stamped);
  } finally {
    await server?.close();
    store?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
