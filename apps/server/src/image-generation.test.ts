import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authenticate,
  fileAttachmentStore,
  loadCommandState,
  type ToolContext,
  ToolError,
} from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import {
  card_id,
  project_id,
  seedProject,
} from "../../../packages/mcp-server/src/test-support.js";
import {
  IMAGE_GENERATION_EVENT,
  ImageGenerationService,
  redactImageError,
} from "./image-generation.js";
import {
  type ImageGenerationConfig,
  type LoadedImageGenerationConfig,
  parseImageGenerationConfig,
} from "./image-generation-config.js";

vi.setConfig({ testTimeout: 20_000 });
const roots: string[] = [],
  stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
// Synthetic credential; every assertion below checks it never leaks.
const KEY = "sk-synthetic-image-key-0123456789";
const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from("synthetic png body"),
]);
const config = (
  patch: Partial<ImageGenerationConfig> = {},
): ImageGenerationConfig => ({
  contact: "张良",
  provider: {
    name: "sensenjoy",
    base_url: "https://images.invalid/v1",
    api_key_file: "/synthetic/api-key",
    models: ["gpt-image-1", "gpt-image-1-mini"],
    default_model: "gpt-image-1",
    max_n: 4,
    timeout_ms: 60_000,
    max_concurrent: 2,
  },
  projects: { [project_id]: ["coder"] },
  ...patch,
});
type Reply = { status?: number; json: unknown };
const respond = (reply: Reply) =>
  new Response(JSON.stringify(reply.json), {
    status: reply.status ?? 200,
    headers: { "content-type": "application/json" },
  });
const ok: Reply = {
  json: {
    created: 1_700_000_000,
    data: [{ b64_json: PNG.toString("base64"), revised_prompt: "revised" }],
    usage: { total_tokens: 1234, input_tokens: 34, output_tokens: 1200 },
  },
};

function setup(
  options: {
    loaded?: LoadedImageGenerationConfig;
    fetch?: typeof fetch;
    waitMs?: number;
  } = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), "image-generation-"));
  roots.push(dataDir);
  const keyDir = mkdtempSync(join(tmpdir(), "image-key-"));
  roots.push(keyDir);
  const store = Store.open({ dataDir });
  stores.push(store);
  store.createProject({ id: project_id });
  seedProject(store, { allowed_tools: ["generate_image"] });
  store.uow.run((tx) => {
    const card = tx.cards.get(project_id, card_id);
    if (!card) throw new Error("fixture card");
    tx.cards.put(project_id, { ...card, status: "in_progress" });
  });
  const token = store.issueToken({
    project_id,
    assignment_id: "A-1" as never,
    role: { role_version: 1, allowed_tools: ["generate_image"] },
  });
  const auth = authenticate(store, token.token);
  if (!auth.ok) throw new Error("fixture auth");
  const context: ToolContext = { store, identity: auth.value };
  const fetcher = vi.fn(options.fetch ?? (async () => respond(ok)));
  // The service reads the key through the 0600 private-file check.
  const keyFile = join(keyDir, "api-key");
  writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
  const loaded: LoadedImageGenerationConfig = options.loaded ?? {
    status: "ready",
    config: config({
      provider: { ...config().provider, api_key_file: keyFile },
    }),
  };
  const service = new ImageGenerationService({
    store,
    dataDir,
    config: () => loaded,
    fetch: fetcher as unknown as typeof fetch,
    waitMs: options.waitMs ?? 5_000,
  });
  return { store, dataDir, context, service, fetcher };
}
const input = (patch: Record<string, unknown> = {}) => ({
  prompt: "像素风格的木质面板，暖色",
  size: "1024x1024",
  quality: "high" as const,
  n: 1,
  background: "transparent" as const,
  idempotency_key: "k1",
  ...patch,
});
function everything(store: Store, dataDir: string) {
  const events = store.database
    .prepare("SELECT doc FROM events")
    .all()
    .map((r) => String(r.doc));
  const state = store.uow.read((tx) => loadCommandState(tx, project_id));
  return { events, state, dataDir };
}
async function attachmentText(dataDir: string, sha256: string) {
  return Buffer.from(
    (await fileAttachmentStore(dataDir).get(sha256)) ?? new Uint8Array(),
  ).toString("utf8");
}
async function assertNoKey(store: Store, dataDir: string, result: unknown) {
  const { events, state } = everything(store, dataDir);
  expect(JSON.stringify(result)).not.toContain(KEY);
  for (const doc of events) expect(doc).not.toContain(KEY);
  for (const entry of state.timeline) expect(entry.body).not.toContain(KEY);
  for (const a of state.attachments)
    expect(await attachmentText(dataDir, a.sha256)).not.toContain(KEY);
  expect(JSON.stringify(process.env)).not.toContain(KEY);
}

test("text-to-image attaches the images, prompt.txt and provenance.json to the card", async () => {
  const { store, dataDir, context, service, fetcher } = setup();
  const result = (await service.execute(context, input())) as {
    status: string;
    attachments: { images: string[]; prompt: string; provenance: string };
    usage: unknown;
  };
  expect(result.status).toBe("succeeded");
  expect(result.attachments.images).toHaveLength(1);
  expect(result.usage).toEqual((ok.json as { usage: unknown }).usage);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://images.invalid/v1/images/generations");
  expect((init.headers as Record<string, string>).authorization).toBe(
    `Bearer ${KEY}`,
  );
  expect(JSON.parse(String(init.body))).toEqual({
    model: "gpt-image-1",
    prompt: input().prompt,
    n: 1,
    size: "1024x1024",
    quality: "high",
    background: "transparent",
  });
  const { state, events } = everything(store, dataDir);
  const byId = new Map(state.attachments.map((a) => [a.id as string, a]));
  const image = byId.get(result.attachments.images[0] as string);
  expect(image).toMatchObject({ card_id, mime: "image/png", kind: "evidence" });
  expect(
    Buffer.from(
      (await fileAttachmentStore(dataDir).get(image?.sha256 ?? "")) ?? [],
    ).equals(PNG),
  ).toBe(true);
  const prompt = byId.get(result.attachments.prompt);
  expect(prompt?.mime).toBe("text/plain");
  expect(await attachmentText(dataDir, prompt?.sha256 ?? "")).toBe(
    input().prompt,
  );
  const provenance = JSON.parse(
    await attachmentText(
      dataDir,
      byId.get(result.attachments.provenance)?.sha256 ?? "",
    ),
  );
  expect(provenance).toMatchObject({
    provider: "sensenjoy",
    endpoint: "/images/generations",
    card_id,
    request: {
      model: "gpt-image-1",
      size: "1024x1024",
      quality: "high",
      n: 1,
      background: "transparent",
    },
    revised_prompts: ["revised"],
    usage: { total_tokens: 1234 },
  });
  expect(provenance.images[0].sha256).toBe(
    createHash("sha256").update(PNG).digest("hex"),
  );
  // Every call records model, size, quality, n and usage in the event.
  const done = events
    .map((d) => JSON.parse(d))
    .filter(
      (e) =>
        e.type === IMAGE_GENERATION_EVENT && e.payload.status === "succeeded",
    );
  expect(done).toHaveLength(1);
  expect(done[0].actor.kind).toBe("system");
  expect(done[0].payload.request).toMatchObject({
    model: "gpt-image-1",
    size: "1024x1024",
    quality: "high",
    n: 1,
  });
  expect(done[0].payload.usage).toEqual({
    total_tokens: 1234,
    input_tokens: 34,
    output_tokens: 1200,
  });
  // The prompt itself lives only in prompt.txt.
  expect(JSON.stringify(done[0].payload)).not.toContain(input().prompt);
  const entry = state.timeline.find(
    (t) => t.id === done[0].payload.timeline_entry,
  );
  expect(entry?.body).toContain(result.attachments.images[0]);
  await assertNoKey(store, dataDir, result);
});

test("a card image attachment is sent as the reference to the edits endpoint", async () => {
  const { store, dataDir, context, service, fetcher } = setup();
  const digest = createHash("sha256").update(PNG).digest("hex");
  const stored = await fileAttachmentStore(dataDir).put(digest, PNG);
  const reference = store.uow.run((tx) => {
    const id = tx.ids.nextAttachmentId(project_id);
    const entry = tx.ids.nextTimelineEntryId(project_id, card_id);
    tx.attachments.put(project_id, {
      id,
      sha256: digest,
      mime: "image/png",
      size: PNG.byteLength,
      card_id,
      uploaded_by: "human",
      storage_path: stored.storage_path,
      attach_to: { kind: "timeline_entry", id: entry },
      kind: "evidence",
    });
    return id as string;
  });
  const result = (await service.execute(
    context,
    input({ reference_attachments: [reference] }),
  )) as { status: string; reference_attachments: string[] };
  expect(result.status).toBe("succeeded");
  expect(result.reference_attachments).toEqual([reference]);
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://images.invalid/v1/images/edits");
  const form = init.body as FormData;
  expect(form.get("prompt")).toBe(input().prompt);
  expect(form.get("model")).toBe("gpt-image-1");
  const file = form.get("image") as File;
  expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);
  expect(file.type).toBe("image/png");
  // An attachment from elsewhere is never sent.
  await expect(
    service.execute(
      context,
      input({ reference_attachments: ["AT-999"], idempotency_key: "k2" }),
    ),
  ).rejects.toThrow("不是本卡的附件");
  expect(fetcher).toHaveBeenCalledTimes(1);
  await assertNoKey(store, dataDir, result);
});

test("a project or role that is not enabled is refused with who to ask", async () => {
  const other = setup({
    loaded: {
      status: "ready",
      config: config({ projects: { [project_id]: ["ui_ux_designer"] } }),
    },
  });
  await expect(other.service.execute(other.context, input())).rejects.toThrow(
    `项目 ${project_id} 的角色 coder 未开通生图，请找张良在主机生图配置中开通`,
  );
  const none = setup({ loaded: { status: "absent" } });
  const refused = await none.service
    .execute(none.context, input())
    .catch((e) => e);
  expect(refused).toBeInstanceOf(ToolError);
  expect(refused.code).toBe("unauthorized");
  expect(refused.message).toContain("未开通生图，请找主机运维开通");
  const broken = setup({ loaded: { status: "invalid" } });
  await expect(broken.service.execute(broken.context, input())).rejects.toThrow(
    "生图配置无效",
  );
  for (const s of [other, none, broken]) {
    expect(s.fetcher).not.toHaveBeenCalled();
    expect(
      everything(s.store, s.dataDir).events.some((d) =>
        d.includes(IMAGE_GENERATION_EVENT),
      ),
    ).toBe(false);
  }
  // Models and counts stay inside the host allowance.
  const s = setup();
  await expect(
    s.service.execute(s.context, input({ model: "dall-e-9" })),
  ).rejects.toThrow("模型 dall-e-9 未开通");
  await expect(s.service.execute(s.context, input({ n: 5 }))).rejects.toThrow(
    "每次最多生成 4 张",
  );
  expect(s.fetcher).not.toHaveBeenCalled();
});

test("a provider failure is redacted, recorded once and never retried", async () => {
  const { store, dataDir, context, service, fetcher } = setup({
    fetch: async () =>
      respond({
        status: 401,
        json: {
          error: {
            message: `Incorrect API key provided: ${KEY}. Authorization: Bearer ${KEY}`,
          },
        },
      }),
  });
  const result = (await service.execute(context, input())) as {
    status: string;
    reason: string;
    usage: unknown;
  };
  expect(result.status).toBe("failed");
  expect(result.reason).toContain("服务商返回 HTTP 401");
  expect(result.reason).toContain("[已隐去]");
  expect(result.usage).toBeNull();
  // Same key: the recorded result, no second paid request.
  const again = (await service.execute(context, input())) as {
    status: string;
  };
  expect(again.status).toBe("failed");
  expect(fetcher).toHaveBeenCalledTimes(1);
  // Same key with other parameters is a conflict, not a new request.
  await expect(
    service.execute(context, input({ prompt: "另一个提示词" })),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const { state } = everything(store, dataDir);
  expect(state.timeline.some((t) => t.body.includes("生图失败"))).toBe(true);
  await assertNoKey(store, dataDir, result);
});

test("transport errors and timeouts never echo the credential", async () => {
  const { store, dataDir, context, service } = setup({
    fetch: async () => {
      throw new Error(`connect failed for Bearer ${KEY}`);
    },
  });
  const result = (await service.execute(context, input())) as {
    status: string;
    reason: string;
  };
  expect(result.status).toBe("failed");
  expect(result.reason).toContain("生图请求未完成");
  await assertNoKey(store, dataDir, result);
  expect(redactImageError(`x ${KEY} y`, [KEY])).toBe("x [已隐去] y");
  expect(redactImageError("token sk-abcdefghijkl", [])).toBe("token [已隐去]");
});

test("a slow call answers running and the same key later returns the result", async () => {
  let release: (() => void) | undefined;
  const { context, service, fetcher } = setup({
    waitMs: 10,
    fetch: () =>
      new Promise((resolve) => {
        release = () => resolve(respond(ok));
      }),
  });
  const first = (await service.execute(context, input())) as {
    status: string;
    next: string;
  };
  expect(first.status).toBe("running");
  expect(first.next).toContain("同一 idempotency_key");
  release?.();
  await vi.waitFor(async () => {
    const later = (await service.execute(context, input())) as {
      status: string;
    };
    expect(later.status).toBe("succeeded");
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("a job cut off by a restart is reported failed, not re-billed", async () => {
  let release: (() => void) | undefined;
  const first = setup({
    waitMs: 10,
    fetch: () =>
      new Promise((resolve) => {
        release = () => resolve(respond(ok));
      }),
  });
  expect(
    (
      (await first.service.execute(first.context, input())) as {
        status: string;
      }
    ).status,
  ).toBe("running");
  // A new process over the same store does not hold the job.
  const restarted = new ImageGenerationService({
    store: first.store,
    dataDir: first.dataDir,
    config: () => ({ status: "ready", config: config() }),
    fetch: first.fetcher as unknown as typeof fetch,
  });
  restarted.recover();
  const after = (await restarted.execute(first.context, input())) as {
    status: string;
    reason: string;
  };
  expect(after.status).toBe("failed");
  expect(after.reason).toContain("主机在生图过程中重启");
  expect(first.fetcher).toHaveBeenCalledTimes(1);
  release?.();
});

test("the host config names the key file, models and enabled roles only", () => {
  const parsed = parseImageGenerationConfig(
    [
      "contact: 张良",
      "provider:",
      "  name: sensenjoy",
      "  base_url: https://images.invalid/v1/",
      "  api_key_file: ~/.config/cardigan/sensenjoy-image/api-key",
      "  models: [gpt-image-1]",
      "projects:",
      "  sensen-godot:",
      "    roles: [ui_ux_designer]",
    ].join("\n"),
    "/home/host",
  );
  expect(parsed).toEqual({
    contact: "张良",
    provider: {
      name: "sensenjoy",
      base_url: "https://images.invalid/v1",
      api_key_file: "/home/host/.config/cardigan/sensenjoy-image/api-key",
      models: ["gpt-image-1"],
      default_model: "gpt-image-1",
      max_n: 4,
      timeout_ms: 300_000,
      max_concurrent: 4,
    },
    projects: { "sensen-godot": ["ui_ux_designer"] },
  });
  for (const bad of [
    "provider: {base_url: 'https://x/v1', api_key_file: /k, models: [m]}\nextra: 1",
    "provider: {base_url: 'https://x/v1', api_key_file: /k, models: [m], api_key: secret}",
    "provider: {base_url: 'https://u:p@x/v1', api_key_file: /k, models: [m]}",
    "provider: {base_url: 'https://x/v1', api_key_file: relative, models: [m]}",
    "provider: {base_url: 'https://x/v1', api_key_file: /k, models: []}",
    "provider: {base_url: 'https://x/v1', api_key_file: /k, models: [m], default_model: n}",
    "provider: {base_url: 'https://x/v1', api_key_file: /k, models: [m]}\nprojects: {p: {roles: [r], budget: 1}}",
  ])
    expect(() => parseImageGenerationConfig(bad, "/home/host")).toThrow(
      "生图配置无效",
    );
});
