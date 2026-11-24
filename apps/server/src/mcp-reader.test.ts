import type { Actor, ToolName } from "@cardigan/domain";
import {
  type Identity,
  readProjectSnapshot,
  type ToolContext,
  ToolError,
  toDomainError,
} from "@cardigan/mcp-server";
import { afterEach, expect, test } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { McpReader } from "./mcp-reader.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

function fixture() {
  const f = dispatchFixture();
  const first = f.create();
  f.create();
  f.store.uow.run((tx) => {
    const role = tx.roles.get(f.project, {
      role_id: "coder",
      role_version: first.assignment.role_version,
    });
    if (!role) throw new Error("Missing coder role");
    tx.roles.put(f.project, {
      ...role,
      allowed_tools: [...role.allowed_tools, "project_snapshot"],
    });
  });
  const base = f.actorFor(first.assignment);
  const actor = {
    ...base,
    allowed_tools: [...base.allowed_tools, "project_snapshot" as ToolName],
  } as Extract<Actor, { kind: "assignment" }>;
  const reader = new McpReader({ dbPath: `${f.dataDir}/cardigan.db` });
  cleanups.push(() => f.close());
  cleanups.push(() => reader.close());
  const timings: Record<string, number> = {};
  const context = (who = actor) =>
    ({
      store: f.store,
      identity: { actor: who } as Identity,
      recordTiming: (stage: string, ms: number) => {
        timings[stage] = ms;
      },
    }) as ToolContext;
  return { f, actor, reader, context, timings };
}

test("C-648: the worker returns the inline read on its own read-only connection", async () => {
  const { f, actor, reader, context, timings } = fixture();
  const inline = readProjectSnapshot(f.store, actor, {});
  expect(inline.snapshot.cards).toHaveLength(2);
  expect(await reader.projectSnapshot(context(), {})).toEqual(inline);
  expect(timings).toEqual({
    read_worker: expect.any(Number),
    read_roundtrip: expect.any(Number),
  });
  // A later commit on the caller's connection is visible to the next read.
  f.create();
  const next = await reader.projectSnapshot(context(), {
    read_audit_employee_id: "E-1",
  });
  expect(next).toEqual(
    readProjectSnapshot(f.store, actor, { read_audit_employee_id: "E-1" }),
  );
  expect(next.snapshot.cards).toHaveLength(3);
  expect(next.audit).toEqual([]);
});

test("C-648: worker refusals keep their domain code and never write", async () => {
  const { f, actor, reader, context } = fixture();
  const before = f.store.uow.read((tx) =>
    tx.events.listAfter(f.project, undefined, 0),
  );
  const unknown = { ...actor, assignment_id: "A-999" } as typeof actor;
  const refused = await reader
    .projectSnapshot(context(unknown), {})
    .catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(ToolError);
  expect(toDomainError(refused)).toMatchObject({ code: "unauthorized" });
  const forbidden = await reader
    .projectSnapshot(context({ ...actor, allowed_tools: [] }), {})
    .catch(toDomainError);
  expect(forbidden).toMatchObject({ code: "forbidden_tool" });
  expect(
    f.store.uow.read((tx) => tx.events.listAfter(f.project, undefined, 0)),
  ).toEqual(before);
});

test("C-648: a failed worker rejects its pending read and the next read starts a new one", async () => {
  const { actor, f, reader, context } = fixture();
  await reader.projectSnapshot(context(), {});
  const pending = reader.projectSnapshot(context(), {});
  const worker = (reader as unknown as { worker: { terminate(): unknown } })
    .worker;
  await worker.terminate();
  await expect(pending).rejects.toThrow("参考资料读取失败。");
  expect(await reader.projectSnapshot(context(), {})).toEqual(
    readProjectSnapshot(f.store, actor, {}),
  );
  const closing = reader
    .projectSnapshot(context(), {})
    .catch((error: unknown) => error);
  await reader.close();
  expect(await closing).toMatchObject({ message: "MCP reader closed" });
  expect(() => reader.projectSnapshot(context(), {})).toThrow(
    "MCP reader is closed",
  );
});
