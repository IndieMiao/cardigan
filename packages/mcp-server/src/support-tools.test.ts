import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assignment, Attachment, Decision, Run } from "@cardigan/domain";
import { toolNames } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  fileAttachmentStore,
  MAX_ATTACHMENT_BYTES,
  MAX_MCP_BODY_BYTES,
  sha256,
} from "./attachments.js";
import { memoryLogger } from "./log.js";
import { type RunningServer, startMcpServer } from "./server.js";
import {
  acceptingVerifierFor,
  card_id,
  NOW,
  project_id,
  seedProject,
  serverCard,
} from "./test-support.js";

let store: Store, server: RunningServer, coder: Client, office: Client;
let dataDir: string, token: string, sequence: number;
let clients: Client[];
let blobs: ReturnType<typeof fileAttachmentStore>;
let logger: ReturnType<typeof memoryLogger>;
const content = Buffer.from("Private attachment fixture content");
const upload = {
  card_id,
  file: content.toString("base64"),
  mime: "text/plain",
  kind: "evidence",
  attach_to: { kind: "timeline_entry", id: "C-1#1" },
};
const decision = {
  card_id,
  kind: "choose",
  category: "general",
  question: "Continue?",
  context: "Fixture",
  options: [{ key: "go", description: "Continue", impact: "Ready" }],
  recommended: "go",
  affected_cards: [],
  affected_work_items: [],
  blocking: true,
  decider: "human",
};
async function connect(assignment: Assignment) {
  const issued = store.issueToken({
    id: assignment.mcp_token_id,
    project_id,
    assignment_id: assignment.id,
    role: { role_version: 1, allowed_tools: toolNames },
  });
  const client = new Client({ name: "support-test", version: "1" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${issued.token}` } },
    }),
  );
  token = issued.token;
  return client;
}
const call = (
  client: Client,
  name: string,
  args: object = {},
  key = `request-${++sequence}`,
) => client.callTool({ name, arguments: { idempotency_key: key, ...args } });
const code = (result: Awaited<ReturnType<typeof call>>) =>
  (result.structuredContent as { error?: { code: string } })?.error?.code;
async function ok<T>(
  client: Client,
  name: string,
  args: object = {},
  key?: string,
): Promise<T> {
  const result = await call(client, name, args, key);
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(
    true,
  );
  return result.structuredContent as unknown as T;
}
const counts = () =>
  store.uow.read((tx) => ({
    attachments: tx.attachments.list(project_id).length,
    events: tx.events.listAfter(project_id, card_id, 0).length,
    timeline: tx.timeline.list(project_id).length,
    cache: store.database.prepare("SELECT COUNT(*) AS n FROM idempotency").get()
      ?.n,
  }));
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "cardigan-attachments-"));
  store = Store.open({ dbPath: ":memory:" });
  clients = [];
  sequence = 0;
  logger = memoryLogger();
  const { assignment } = seedProject(store, { allowed_tools: toolNames });
  const pm: Assignment = {
    id: "A-2" as never,
    scope: "standing",
    role_id: "pm",
    role_version: 1,
    status: "active",
    runtime_state: "idle",
    runtime_ref: null,
    machine_id: "local",
    mcp_token_id: "fixture-pm",
    created_at: NOW,
  };
  store.uow.run((tx) => {
    tx.assignments.put(project_id, pm);
    tx.roles.put(project_id, {
      role_id: "pm",
      role_version: 1,
      allowed_tools: toolNames,
      capabilities: [],
    });
    for (const a of [assignment, pm])
      tx.runs.put(project_id, {
        id: tx.ids.next(project_id, "run"),
        assignment_id: a.id,
        trigger_event_id: tx.ids.nextEventId(),
        kind: "initial",
        status: "running",
        role_version: 1,
        model: "fixture-model",
        agent_cli_version: "1",
        outcome: null,
        summary: "",
      });
  });
  blobs = fileAttachmentStore(dataDir);
  const put = blobs.put.bind(blobs);
  vi.spyOn(blobs, "put").mockImplementation((digest, bytes) => {
    // This would fail if prepareAttachment were called under a write/read transaction.
    store.uow.run(() => undefined);
    return put(digest, bytes);
  });
  server = await startMcpServer({
    store,
    deliveryVerifier: acceptingVerifierFor,
    dataDir,
    attachmentStore: blobs,
    clock: { now: () => NOW },
    log: logger.log,
  });
  coder = await connect(assignment);
  office = await connect(pm);
});
afterEach(async () => {
  expect(JSON.stringify(logger.entries)).not.toContain(upload.file);
  expect(JSON.stringify(logger.entries)).not.toContain(token);
  await Promise.all(clients.map((client) => client.close()));
  await server.close();
  store.close();
  await rm(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test("all planned tools are advertised; concurrent attachment uploads and replays commit once", async () => {
  expect((await office.listTools()).tools.map((t) => t.name).sort()).toEqual(
    [...toolNames].sort(),
  );
  const args = {
    ...upload,
    sha256: sha256(content),
    storage_path: "ignored",
    uploaded_by: "human",
  };
  const before = counts();
  const [first, second] = await Promise.all(
    [0, 1].map(() =>
      ok<Attachment>(coder, "upload_attachment", args, "upload-once"),
    ),
  );
  expect(first).toMatchObject({
    sha256: sha256(content),
    size: content.length,
    uploaded_by: "assignment:A-1",
    storage_path: `attachments/${sha256(content)}`,
  });
  expect(second).toEqual(first);
  const writes = vi.mocked(blobs.put).mock.calls.length;
  expect(await ok(coder, "upload_attachment", args, "upload-once")).toEqual(
    first,
  );
  expect(
    code(
      await call(
        coder,
        "upload_attachment",
        { ...args, mime: "text/markdown" },
        "upload-once",
      ),
    ),
  ).toBe("idempotency_conflict");
  expect(blobs.put).toHaveBeenCalledTimes(writes);
  expect(counts()).toEqual({
    attachments: before.attachments + 1,
    events: before.events + 1,
    timeline: before.timeline + 1,
    cache: Number(before.cache) + 1,
  });
  expect(await blobs.get(sha256(content))).toEqual(content);
  expect(await readdir(join(dataDir, "attachments"))).toEqual([
    sha256(content),
  ]);
  expect(
    (await stat(join(dataDir, "attachments", sha256(content)))).mode & 0o777,
  ).toBe(0o600);
  const cache = store.database.prepare("SELECT * FROM idempotency").all();
  expect(JSON.stringify(cache)).not.toContain(upload.file);
});

test("artifacts require an existing basis and support both attachment target types", async () => {
  expect(
    code(
      await call(coder, "upload_attachment", { ...upload, kind: "artifact" }),
    ),
  ).toBe("validation_failed");
  expect(
    code(
      await call(coder, "upload_attachment", {
        ...upload,
        kind: "artifact",
        basis: "q(999)",
      }),
    ),
  ).toBe("not_found");
  const q = await ok<Decision>(office, "request_decision", decision);
  store.uow.run((tx) =>
    tx.deliveries.put(project_id, {
      id: "D-1" as never,
      work_item_id: "W-1" as never,
      run_id: "R-1" as never,
      kind: "doc",
      summary: "Fixture",
      subject: { kind: "doc_version", value: "v1" },
      evidence: [],
      attachments: [],
      known_gaps: [],
      requested_verifiers: [],
      status: "submitted",
    }),
  );
  const first = await ok<Attachment>(coder, "upload_attachment", upload);
  const artifact = await ok<Attachment>(coder, "upload_attachment", {
    ...upload,
    kind: "artifact",
    basis: q.key,
    supersedes: first.id,
    attach_to: { kind: "delivery", id: "D-1" },
  });
  expect(artifact).toMatchObject({
    basis: q.key,
    supersedes: first.id,
    attach_to: { kind: "delivery", id: "D-1" },
  });
  expect(await readdir(join(dataDir, "attachments"))).toEqual([
    sha256(content),
  ]);
});

test("10 MiB passes through HTTP; oversized, malformed and checksum-mismatched content is refused", async () => {
  const large = Buffer.alloc(MAX_ATTACHMENT_BYTES, 0x61);
  expect(
    await ok(coder, "upload_attachment", {
      ...upload,
      file: large.toString("base64"),
    }),
  ).toMatchObject({ size: MAX_ATTACHMENT_BYTES, sha256: sha256(large) });
  const writes = vi.mocked(blobs.put).mock.calls.length;
  for (const file of [
    Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64"),
    "YQ",
    "YR==",
    "YQ==\n",
    "!!!!",
    "a===",
    "data:text/plain;base64,YQ==",
  ])
    expect(
      code(await call(coder, "upload_attachment", { ...upload, file })),
    ).toBe("validation_failed");
  for (const digest of ["0".repeat(64), "../outside"])
    expect(
      code(
        await call(coder, "upload_attachment", { ...upload, sha256: digest }),
      ),
    ).toBe("validation_failed");
  expect(blobs.put).toHaveBeenCalledTimes(writes);
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      padding: "x".repeat(MAX_MCP_BODY_BYTES),
    }),
  });
  expect(response.status).toBe(413);
  // Full-suite CPU load can exceed 5 seconds while encoding and checking 10 MiB bodies.
}, 30_000);

test("late transaction failure retains blobs, rolls back all DB writes, and can be retried", async () => {
  const shared = await ok<Attachment>(coder, "upload_attachment", upload);
  const before = counts();
  store.database.exec(
    "CREATE TRIGGER fail_attachment BEFORE INSERT ON events WHEN NEW.type = 'attachment_uploaded' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
  );
  for (const file of [
    upload.file,
    Buffer.from("Unreferenced blob").toString("base64"),
  ]) {
    expect(
      (
        await call(
          coder,
          "upload_attachment",
          { ...upload, file },
          "retry-upload",
        )
      ).isError,
    ).toBe(true);
    expect(counts()).toEqual(before);
    expect(await blobs.get(sha256(Buffer.from(file, "base64")))).toEqual(
      Buffer.from(file, "base64"),
    );
  }
  expect(await readFile(join(dataDir, shared.storage_path))).toEqual(content);
  store.database.exec("DROP TRIGGER fail_attachment");
  const retried = await ok<Attachment>(
    coder,
    "upload_attachment",
    upload,
    "retry-upload",
  );
  expect(retried.id).toBe("attachment-2");
  expect(counts()).toEqual({
    attachments: before.attachments + 1,
    events: before.events + 1,
    timeline: before.timeline + 1,
    cache: Number(before.cache) + 1,
  });
});

test("upload reduction sees a fresh snapshot after IO and storage failures expose no file paths", async () => {
  const put = blobs.put.bind(blobs);
  vi.mocked(blobs.put).mockImplementationOnce(async (digest, bytes) => {
    const receipt = await put(digest, bytes);
    store.uow.run((tx) => {
      const current = tx.assignments.get(project_id, "A-1" as never);
      if (current)
        tx.assignments.put(project_id, { ...current, status: "suspended" });
    });
    return receipt;
  });
  const before = counts();
  expect(code(await call(coder, "upload_attachment", upload))).toBe(
    "unauthorized",
  );
  expect(counts()).toEqual(before);
  expect(await blobs.get(sha256(content))).toEqual(content);
  vi.mocked(blobs.put).mockRejectedValueOnce(
    new Error(`Private path ${dataDir}`),
  );
  const failure = await call(office, "upload_attachment", upload);
  expect(failure.structuredContent).toEqual({
    error: { code: "validation_failed", message: "Attachment storage failed" },
  });
  expect(JSON.stringify(failure)).not.toContain(dataDir);
});

test("the file port validates digests, detects corrupt shared files and uses CARDIGAN_DATA_DIR", async () => {
  vi.stubEnv("CARDIGAN_DATA_DIR", dataDir);
  const port = fileAttachmentStore();
  expect(await port.get(sha256(content))).toBeUndefined();
  await expect(port.put("../outside", content)).rejects.toThrow();
  await expect(port.put("0".repeat(64), content)).rejects.toThrow();
  await port.put(sha256(content), content);
  await writeFile(join(dataDir, "attachments", sha256(content)), "corrupt");
  await expect(port.get(sha256(content))).rejects.toThrow(/checksum/);
  expect(code(await call(coder, "upload_attachment", upload))).toBe(
    "validation_failed",
  );
  expect(counts().attachments).toBe(0);
  expect(await readdir(join(dataDir, "attachments"))).toEqual([
    sha256(content),
  ]);
});

test("heartbeat and finish_run enforce ownership, persist only once and do not complete business work", async () => {
  const before = counts();
  const beat = { run_id: "R-1", note: "Working" };
  expect(await ok(coder, "heartbeat", beat, "beat-once")).toMatchObject({
    heartbeat_at: NOW,
    heartbeat_note: "Working",
    status: "running",
  });
  expect(counts()).toEqual({ ...before, cache: Number(before.cache) + 1 });
  expect(code(await call(coder, "heartbeat", { run_id: "R-2" }))).toBe(
    "unauthorized",
  );
  expect(
    code(
      await call(coder, "finish_run", {
        run_id: "R-2",
        outcome: "completed",
        summary: "No",
      }),
    ),
  ).toBe("unauthorized");
  const finish = {
    run_id: "R-1",
    outcome: "completed",
    summary: "Finished Run",
  };
  const ended = await ok<Run>(coder, "finish_run", finish, "finish-once");
  expect(ended).toMatchObject({
    status: "completed",
    outcome: "completed",
    finished_at: NOW,
  });
  expect(await ok(coder, "finish_run", finish, "finish-once")).toEqual(ended);
  expect(await ok(coder, "heartbeat", beat, "beat-once")).toMatchObject({
    status: "running",
  });
  expect(code(await call(coder, "heartbeat", beat))).toBe("illegal_transition");
  expect(counts()).toEqual({
    ...before,
    events: before.events + 1,
    cache: Number(before.cache) + 2,
  });
  expect(
    store.uow.read((tx) => tx.cards.get(project_id, card_id))?.status,
  ).toBe("todo");
});

test("PM queries derive current project views without writes or idempotency keys", async () => {
  const q = await ok<Decision>(office, "request_decision", decision);
  await ok(office, "request_human_action", {
    card_id,
    instructions: "Connect device",
    why_human: "Device",
    expected_return: "Connected",
    blocked_work_items: [],
  });
  store.uow.run((tx) =>
    tx.cards.put("other-project", {
      ...serverCard,
      project_id: "other-project",
      title: "Private other project",
    }),
  );
  const before = counts();
  const writes = vi.spyOn(store, "runIdempotent");
  const snapshot = await office.callTool({
    name: "project_snapshot",
    arguments: { project_id: "other-project" },
  });
  expect(snapshot.isError).not.toBe(true);
  expect(snapshot.structuredContent).toMatchObject({
    project_id,
    cards: [
      {
        id: card_id,
        open_decisions: [q.id],
        why: `等你拍板 ${q.key}`,
        waiting_on: [
          { kind: "decision", ref: q.key },
          { kind: "human_action", ref: "h(1)" },
        ],
      },
    ],
  });
  expect(JSON.stringify(snapshot)).not.toContain("Private other project");
  const needs = await office.callTool({
    name: "list_needs_you",
    arguments: {},
  });
  expect(needs.isError).not.toBe(true);
  expect(needs.structuredContent).toMatchObject({
    decisions: [{ id: q.id, why: "Continue?" }],
    human_actions: [{ key: "h(1)", why: "Device" }],
  });
  for (const name of ["project_snapshot", "list_needs_you"])
    expect(code(await call(coder, name))).toBe("forbidden_tool");
  expect(writes).not.toHaveBeenCalled();
  expect(counts()).toEqual(before);
});
