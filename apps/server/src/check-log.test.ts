import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMergeCheckLog } from "@cardigan/host";
import {
  authenticate,
  CheckLogReadLimitError,
  serverTools,
} from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { afterEach, expect, test } from "vitest";
import { readMergeCheckLogRange } from "./web/merge-check-log.js";

const roots: string[] = [];
afterEach(async () => {
  for (const dir of roots.splice(0))
    await rm(dir, { force: true, recursive: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "cg-private-log-"));
  roots.push(dir);
  const directory = join(dir, "merge-gate", "logs", "test");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "attempt-1.log");
  await writeFile(path, "甲🙂乙 abc", { mode: 0o600 });
  const read = (offset: number, limit: number) =>
    readMergeCheckLogRange({
      dataDir: dir,
      projectId: "test",
      attempt: "attempt-1",
      offset,
      limit,
    });
  return { dir, directory, path, read };
}

test("private log reader pages UTF-8 by byte offset, preserving EOF and character boundaries", async () => {
  const f = await fixture();
  expect(await f.read(0, 6)).toMatchObject({
    text: "甲",
    next_offset: 3,
    size: 14,
  });
  expect(await f.read(3, 7)).toMatchObject({ text: "🙂乙", next_offset: 10 });
  expect(await f.read(4, 8)).toMatchObject({ text: "乙 a", next_offset: 12 });
  expect(await f.read(14, 6)).toMatchObject({ text: "", next_offset: 14 });
  expect(await f.read(100, 6)).toMatchObject({ text: "", next_offset: 14 });
});

test("a limit smaller than the next character reports a terminal limit refusal, not an empty non-EOF page", async () => {
  const f = await fixture();
  await expect(f.read(0, 1)).rejects.toBeInstanceOf(CheckLogReadLimitError);
  await expect(f.read(3, 3)).rejects.toBeInstanceOf(CheckLogReadLimitError);
  expect(await f.read(0, 3)).toMatchObject({ text: "甲", next_offset: 3 });
  expect(await f.read(3, 4)).toMatchObject({ text: "🙂", next_offset: 7 });
  expect(await f.read(14, 1)).toMatchObject({ text: "", next_offset: 14 });
});

test.each(["file_link", "directory_link", "hardlink", "mode", "missing"])(
  "rejects unsafe private log: %s",
  async (kind) => {
    const f = await fixture();
    if (kind === "hardlink")
      await link(f.path, join(f.directory, "another.log"));
    else if (kind === "mode") await chmod(f.path, 0o644);
    else if (kind === "directory_link") {
      const moved = join(f.dir, "elsewhere");
      await mkdir(moved);
      await rm(f.directory, { recursive: true });
      await symlink(moved, f.directory);
    } else {
      await rm(f.path);
      if (kind === "file_link")
        await symlink(join(f.dir, "outside.log"), f.path);
    }
    await expect(f.read(0, 64)).rejects.toThrow();
  },
);

test("server reader port returns only host-redacted synthetic credentials through the registered MCP tool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cg-redacted-port-"));
  roots.push(dir);
  const secret = "fictional-env-value-942874";
  const writer = await createMergeCheckLog({
    dataDir: dir,
    project: "test",
    attempt: "attempt-1",
    env: { DEMO_SECRET: secret },
  });
  writer.append(
    "unit",
    `FAIL example\n${secret}\nAuthorization: Bearer fictional-bearer\napi_key=fictional-key\n甲🙂乙`,
  );
  await writer.finish({
    status: "failed",
    checks: [],
    cleanup_errors: [],
  } as never);
  const store = Store.open({ dataDir: dir });
  try {
    store.uow.run((tx) => {
      tx.cards.put("test" as never, { id: "C-1" } as never);
      tx.work_items.put(
        "test" as never,
        {
          id: "W-1",
          card_id: "C-1",
          kind: "produce",
          assignment_id: "A-1",
          status: "in_progress",
        } as never,
      );
      tx.assignments.put(
        "test" as never,
        {
          id: "A-1",
          scope: "work_item",
          work_item_id: "W-1",
          role_id: "coder",
          role_version: 1,
          status: "active",
          machine_id: "local",
          mcp_token_id: "fixture-token",
        } as never,
      );
      tx.events.append(
        "test" as never,
        {
          id: "event-1",
          seq: 1,
          card_id: "C-1",
          type: "merge_check_finished",
          actor: { kind: "system", project_id: "test" },
          payload: {
            attempt_id: "attempt-1",
            status: "failed",
            log_ref: "/ignored",
          },
          created_at: "2026-01-01",
        } as never,
      );
    });
    const issued = store.issueToken({
      project_id: "test" as never,
      assignment_id: "A-1" as never,
      role: { role_version: 1, allowed_tools: ["get_check_log"] },
    });
    const identity = authenticate(store, issued.token);
    if (!identity.ok) throw new Error("auth");
    const tool = serverTools({
      deliveryVerifier: () => {
        throw new Error("unused verifier");
      },
      checkLogReader: (input) =>
        readMergeCheckLogRange({
          dataDir: dir,
          projectId: input.project_id,
          attempt: input.attempt_id,
          offset: input.offset,
          limit: input.limit,
        }),
    }).find((t) => t.name === "get_check_log");
    const result = (await tool?.handler(
      { card_id: "C-1", attempt_id: "attempt-1" },
      { store, identity: identity.value },
    )) as { text: string };
    for (const value of [
      secret,
      "fictional-bearer",
      "fictional-key",
      "/ignored",
    ])
      expect(result.text).not.toContain(value);
    expect(result.text).toContain("甲🙂乙");
    expect(result.text).toContain("[REDACTED]");
  } finally {
    store.close();
  }
});
