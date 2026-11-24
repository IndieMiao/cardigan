import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vitest";
import { memoryLogger } from "./log.js";
import { resolveQualifiedToolArgs } from "./qualified-args.js";
import { startMcpServer } from "./server.js";
import {
  acceptingVerifierFor,
  card_id,
  project_id,
  seedProject,
} from "./test-support.js";

const own = { id: project_id, code: () => "FIC" };

test("C-675: own full numbers become short ones under id keys only", () => {
  expect(
    resolveQualifiedToolArgs(
      {
        card_id: "FIC-C-1",
        refs: [
          { kind: "timeline_entry", id: "FIC-C-1#2" },
          { kind: "card", id: "C-3" },
        ],
        attach_to: { kind: "delivery", id: "FIC-D-4" },
        affected_cards: ["FIC-C-5", "C-6"],
        attachment_id: "FIC-attachment-7",
        resume_when: { kind: "card_merged", target_id: "FIC-C-8" },
        body: "FIC-C-1",
        summary: "see FIC-C-1",
        idempotency_key: "FIC-C-1",
      },
      own,
    ),
  ).toEqual({
    ok: true,
    value: {
      card_id: "C-1",
      refs: [
        { kind: "timeline_entry", id: "C-1#2" },
        { kind: "card", id: "C-3" },
      ],
      attach_to: { kind: "delivery", id: "D-4" },
      affected_cards: ["C-5", "C-6"],
      attachment_id: "attachment-7",
      resume_when: { kind: "card_merged", target_id: "C-8" },
      body: "FIC-C-1",
      summary: "see FIC-C-1",
      idempotency_key: "FIC-C-1",
    },
  });
});

test("C-675: another project's full number is refused; text mentioning it is not", () => {
  let read = 0;
  const lazy = {
    id: project_id,
    code: () => {
      read += 1;
      return "FIC";
    },
  };
  // Without any full number the code is not even read.
  const plain = { card_id: "C-1", body: "SEN-C-1" };
  expect(resolveQualifiedToolArgs(plain, lazy)).toEqual({
    ok: true,
    value: plain,
  });
  expect(read).toBe(0);
  expect(
    resolveQualifiedToolArgs(
      { card_id: "C-1", affected_cards: ["FIC-C-2", "SEN-C-2"] },
      lazy,
    ),
  ).toEqual({
    ok: false,
    error: {
      code: "validation_failed",
      message: `完整编号 SEN-C-2 不属于本会话的项目 ${project_id}（FIC）；只能操作本项目的编号`,
    },
  });
});

test("C-675: tools take the token project's full numbers end to end", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cardigan-mcp-qualified-"));
  const store = Store.open({ dataDir });
  try {
    store.createProject({ id: project_id, code: "FIC" });
    store.createProject({ id: "p-other", code: "SEN" });
    const allowed = ["get_card"] as const;
    const seeded = seedProject(store, { allowed_tools: allowed });
    const issued = store.issueToken({
      project_id,
      assignment_id: seeded.assignment.id,
      role: {
        role_version: seeded.assignment.role_version,
        allowed_tools: allowed,
      },
      token: "fictional-qualified-token",
    });
    const server = await startMcpServer({
      store,
      deliveryVerifier: acceptingVerifierFor,
      log: memoryLogger().log,
    });
    try {
      const client = new Client({ name: "fictional", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: {
            headers: { Authorization: `Bearer ${issued.token}` },
          },
        }),
      );
      const full = await client.callTool({
        name: "get_card",
        arguments: { card_id: "FIC-C-1" },
      });
      expect(full.isError).toBeFalsy();
      expect((full.structuredContent as { card: { id: string } }).card.id).toBe(
        card_id,
      );
      const foreign = await client.callTool({
        name: "get_card",
        arguments: { card_id: "SEN-C-1" },
      });
      expect(foreign.isError).toBe(true);
      expect(foreign.structuredContent).toEqual({
        error: {
          code: "validation_failed",
          message: `完整编号 SEN-C-1 不属于本会话的项目 ${project_id}（FIC）；只能操作本项目的编号`,
        },
      });
      await client.close();
    } finally {
      await server.close();
    }
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
