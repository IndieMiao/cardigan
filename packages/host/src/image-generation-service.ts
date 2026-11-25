import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  authorizeImageGeneration,
  type CardId,
  type ImageBackground,
  type ImageGenerationRequester,
  type ImageQuality,
  imageReferencesOnCard,
} from "@cardigan/domain";
import {
  fileAttachmentStore,
  type GenerateImageInput,
  loadCommandState,
  type ToolContext,
  ToolError,
  unwrap,
} from "@cardigan/mcp-server";
import type { Store, StoreTransactionContext } from "@cardigan/store";
import type {
  ImageGenerationConfig,
  LoadedImageGenerationConfig,
} from "./image-generation-config.js";
import {
  IMAGE_GENERATION_DEFAULT_CONTACT,
  loadImageGenerationConfig,
} from "./image-generation-config.js";
import { readPrivateConfig } from "./probe-config.js";

export const IMAGE_GENERATION_EVENT = "image_generation";
export interface ImageGenerationRequest {
  readonly model: string;
  readonly size: string;
  readonly quality: ImageQuality;
  readonly n: number;
  readonly background: ImageBackground;
  readonly reference_attachments: readonly {
    readonly id: string;
    readonly sha256: string;
    readonly mime: string;
  }[];
  /** The prompt itself is only in prompt.txt; the event keeps its digest. */
  readonly prompt_sha256: string;
  readonly prompt_chars: number;
}
/** One provider call; every state change is a system event on the card. */
export interface ImageGenerationJob {
  readonly id: string;
  readonly project_id: string;
  readonly card_id: CardId;
  readonly requester: Omit<ImageGenerationRequester, "project_id" | "card_id">;
  readonly idempotency_key: string;
  readonly provider: string;
  readonly endpoint: "generations" | "edits";
  readonly request: ImageGenerationRequest;
  readonly status: "running" | "succeeded" | "failed";
  readonly created_at: string;
  readonly finished_at?: string;
  /** Provider-reported usage, recorded as returned; never budget-gated. */
  readonly usage?: unknown;
  readonly attachments?: {
    readonly images: readonly string[];
    readonly prompt: string;
    readonly provenance: string;
  };
  readonly timeline_entry?: string;
  readonly reason?: string;
}
type Fetch = typeof fetch;
export interface ImageGenerationServiceOptions {
  readonly store: Store;
  readonly dataDir: string;
  readonly config: () => LoadedImageGenerationConfig;
  readonly fetch?: Fetch;
  /** How long a call waits for its result before answering `running`. */
  readonly waitMs?: number;
  readonly now?: () => number;
}
const WAIT_MS = 50_000;
const ERROR_TEXT_LIMIT = 300;
const INTERRUPTED =
  "主机在生图过程中重启，结果未知；未自动重试，需要时换一个 idempotency_key 重新请求";

/** Host config path, beside the other host-only settings. */
export function imageGenerationConfigLoader(configDir: string) {
  return () =>
    loadImageGenerationConfig(join(configDir, "image-generation.yaml"));
}

/** Remove every credential form from provider or transport text. */
export function redactImageError(
  text: string,
  secrets: readonly string[],
): string {
  let out = text;
  for (const secret of secrets)
    if (secret.length >= 4) out = out.split(secret).join("[已隐去]");
  out = out
    .replace(/(bearer\s+)[^\s"',;]+/giu, "$1[已隐去]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/gu, "[已隐去]")
    .replace(/[\r\n\t]+/gu, " ")
    .trim();
  return out.length > ERROR_TEXT_LIMIT
    ? `${out.slice(0, ERROR_TEXT_LIMIT)}…`
    : out;
}
function imageMime(bytes: Uint8Array): string | undefined {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b.subarray(0, 4).toString("latin1") === "RIFF" &&
    b.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  return undefined;
}
const EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
/** A provider failure whose text is already safe to show. */
class ProviderFailure extends Error {}

export class ImageGenerationService {
  private readonly active = new Map<string, Promise<void>>();
  constructor(private readonly options: ImageGenerationServiceOptions) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private iso() {
    return new Date(this.now()).toISOString();
  }
  jobs(project_id?: string): ImageGenerationJob[] {
    const jobs = new Map<string, ImageGenerationJob>();
    for (const row of this.options.store.database
      .prepare("SELECT doc FROM events WHERE type = ? ORDER BY seq")
      .all(IMAGE_GENERATION_EVENT)) {
      const event = JSON.parse(String(row.doc));
      if (event.actor?.kind !== "system") continue;
      const job = event.payload as ImageGenerationJob;
      if (project_id === undefined || job.project_id === project_id)
        jobs.set(job.id, job);
    }
    return [...jobs.values()];
  }
  private save(tx: StoreTransactionContext, job: ImageGenerationJob): number {
    const seq = tx.ids.nextEventSequence(job.project_id, job.card_id);
    tx.events.append(job.project_id, {
      id: tx.ids.nextEventId(),
      seq,
      card_id: job.card_id,
      actor: { kind: "system", project_id: job.project_id },
      type: IMAGE_GENERATION_EVENT,
      payload: JSON.parse(JSON.stringify(job)),
      created_at: this.iso(),
    });
    return seq;
  }
  private note(
    tx: StoreTransactionContext,
    job: ImageGenerationJob,
    seq: number,
    body: string,
    entry = tx.ids.nextTimelineEntryId(job.project_id, job.card_id),
  ) {
    tx.timeline.put(job.project_id, {
      id: entry,
      short_id: entry,
      card_id: job.card_id,
      event_seq: seq,
      type: "system",
      author: "system",
      body,
      refs: [],
      mentions: [],
      retracted: false,
      created_at: this.iso(),
    });
    return entry;
  }
  /** Refusals name the project, role and who enables them. */
  private granted(requester: ImageGenerationRequester): ImageGenerationConfig {
    const loaded = this.options.config();
    if (loaded.status !== "ready")
      throw new ToolError(
        "unauthorized",
        `本主机${loaded.status === "invalid" ? "的生图配置无效" : "未开通生图"}，请找${IMAGE_GENERATION_DEFAULT_CONTACT}开通`,
      );
    const { config } = loaded;
    if (!config.projects[requester.project_id]?.includes(requester.role_id))
      throw new ToolError(
        "unauthorized",
        `项目 ${requester.project_id} 的角色 ${requester.role_id} 未开通生图，请找${config.contact}在主机生图配置中开通`,
      );
    return config;
  }
  async execute(
    context: ToolContext,
    input: GenerateImageInput,
  ): Promise<unknown> {
    context.revalidateToken?.();
    const actor = context.identity.actor;
    const requester = this.options.store.uow.read((tx) =>
      unwrap(
        authorizeImageGeneration(loadCommandState(tx, actor.project_id), actor),
      ),
    );
    const config = this.granted(requester);
    const provider = config.provider;
    const model = input.model ?? provider.default_model;
    if (!provider.models.includes(model))
      throw ToolError.validation(
        `模型 ${model} 未开通，可用：${provider.models.join("、")}`,
      );
    const n = input.n ?? 1;
    if (n > provider.max_n)
      throw ToolError.validation(`每次最多生成 ${provider.max_n} 张`);
    const refs = [...(input.reference_attachments ?? [])];
    const claim = this.options.store.uow.run((tx) => {
      context.revalidateToken?.();
      const state = loadCommandState(tx, requester.project_id);
      const current = unwrap(authorizeImageGeneration(state, actor));
      if (JSON.stringify(current) !== JSON.stringify(requester))
        throw new ToolError("stale_target", "请求者或卡片已变化，请重试");
      const bad = imageReferencesOnCard(state, current.card_id, refs);
      if (bad) throw ToolError.validation(bad);
      const request: ImageGenerationRequest = {
        model,
        size: input.size ?? "auto",
        quality: input.quality ?? "auto",
        n,
        background: input.background ?? "auto",
        reference_attachments: refs.map((id) => {
          const a = state.attachments.find((x) => x.id === id);
          if (!a) throw ToolError.validation(`参考图 ${id} 不是本卡的附件`);
          return { id, sha256: a.sha256, mime: a.mime };
        }),
        prompt_sha256: sha256(Buffer.from(input.prompt, "utf8")),
        prompt_chars: input.prompt.length,
      };
      const existing = this.jobs(current.project_id).find(
        (j) =>
          j.requester.assignment_id === current.assignment_id &&
          j.idempotency_key === input.idempotency_key,
      );
      if (existing) {
        if (JSON.stringify(existing.request) !== JSON.stringify(request))
          throw new ToolError(
            "idempotency_conflict",
            "同一 idempotency_key 已用于不同的生图参数",
          );
        return { job: existing, fresh: false };
      }
      if (this.active.size >= provider.max_concurrent)
        throw new ToolError(
          "illegal_transition",
          "主机生图并发已满，请稍后再试",
        );
      const job: ImageGenerationJob = {
        id: randomUUID().replaceAll("-", ""),
        project_id: current.project_id,
        card_id: current.card_id,
        requester: {
          work_item_id: current.work_item_id,
          assignment_id: current.assignment_id,
          role_id: current.role_id,
        },
        idempotency_key: input.idempotency_key,
        provider: provider.name,
        endpoint: refs.length > 0 ? "edits" : "generations",
        request,
        status: "running",
        created_at: this.iso(),
      };
      this.save(tx, job);
      return { job, fresh: true };
    });
    if (claim.fresh) {
      const work = this.run(claim.job, input.prompt, config)
        .catch(() => undefined)
        .finally(() => this.active.delete(claim.job.id));
      this.active.set(claim.job.id, work);
    } else if (claim.job.status === "running" && !this.active.has(claim.job.id))
      this.recover();
    return this.wait(claim.job);
  }
  /** Running jobs this process does not hold were cut off by a restart. */
  recover(): void {
    this.options.store.uow.run((tx) => {
      for (const job of this.jobs())
        if (job.status === "running" && !this.active.has(job.id)) {
          const next: ImageGenerationJob = {
            ...job,
            status: "failed",
            finished_at: this.iso(),
            reason: INTERRUPTED,
          };
          this.note(tx, next, this.save(tx, next), `生图中断：${INTERRUPTED}`);
        }
    });
  }
  private async wait(job: ImageGenerationJob): Promise<unknown> {
    const work = this.active.get(job.id);
    if (work) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        work,
        new Promise((resolve) => {
          timer = setTimeout(resolve, this.options.waitMs ?? WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    const current = this.options.store.uow.read(() =>
      this.jobs(job.project_id).find((j) => j.id === job.id),
    );
    return imageGenerationView(current ?? job);
  }
  private async run(
    job: ImageGenerationJob,
    prompt: string,
    config: ImageGenerationConfig,
  ): Promise<void> {
    let key = "";
    try {
      key = this.key(config, job);
      const result = await this.call(job, prompt, config, key);
      await this.succeed(job, prompt, result);
    } catch (error) {
      const reason =
        error instanceof ProviderFailure
          ? redactImageError(error.message, [key])
          : error instanceof Error && error.name === "TimeoutError"
            ? `服务商请求超时（${Math.round(config.provider.timeout_ms / 1000)} 秒）`
            : `生图请求未完成：${redactImageError(
                error instanceof Error ? error.message : String(error),
                [key],
              )}`;
      this.fail(job, reason);
    }
  }
  /** Read the credential only now, from the host-owned 0600 file. */
  private key(config: ImageGenerationConfig, job: ImageGenerationJob) {
    let source: string | undefined;
    try {
      source = readPrivateConfig(config.provider.api_key_file);
    } catch {
      source = undefined;
    }
    const key = source?.trim() ?? "";
    if (!key || /\s/u.test(key))
      throw new ProviderFailure(
        `主机生图凭据不可用（${job.provider}），请找${config.contact}核对主机配置`,
      );
    return key;
  }
  private async call(
    job: ImageGenerationJob,
    prompt: string,
    config: ImageGenerationConfig,
    key: string,
  ) {
    const fetcher = this.options.fetch ?? fetch;
    const signal = AbortSignal.timeout(config.provider.timeout_ms);
    const r = job.request;
    const fields: Record<string, string> = {
      model: r.model,
      prompt,
      n: String(r.n),
      ...(r.size === "auto" ? {} : { size: r.size }),
      ...(r.quality === "auto" ? {} : { quality: r.quality }),
      ...(r.background === "auto" ? {} : { background: r.background }),
    };
    let body: string | FormData;
    const headers: Record<string, string> = {
      authorization: `Bearer ${key}`,
    };
    if (job.endpoint === "edits") {
      const form = new FormData();
      for (const [name, value] of Object.entries(fields))
        form.append(name, value);
      const store = fileAttachmentStore(this.options.dataDir);
      const field = r.reference_attachments.length > 1 ? "image[]" : "image";
      for (const [index, ref] of r.reference_attachments.entries()) {
        const bytes = await store.get(ref.sha256);
        if (!bytes)
          throw new ProviderFailure(`参考图 ${ref.id} 的内容在主机上不可读`);
        const mime = imageMime(bytes) ?? ref.mime;
        form.append(
          field,
          new Blob([new Uint8Array(bytes)], { type: mime }),
          `reference-${index + 1}.${EXTENSION[mime] ?? "png"}`,
        );
      }
      body = form;
    } else {
      headers["content-type"] = "application/json";
      body = JSON.stringify({ ...fields, n: r.n });
    }
    const response = await fetcher(
      `${config.provider.base_url}/images/${job.endpoint}`,
      { method: "POST", headers, body, signal, redirect: "error" },
    );
    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const message = (parsed as { error?: { message?: unknown } } | undefined)
        ?.error?.message;
      throw new ProviderFailure(
        `服务商返回 HTTP ${response.status}${
          typeof message === "string" ? `：${message}` : ""
        }`,
      );
    }
    const data = (parsed as { data?: unknown } | undefined)?.data;
    if (!Array.isArray(data) || data.length === 0)
      throw new ProviderFailure("服务商没有返回图片");
    const images: Buffer[] = [];
    const revised: string[] = [];
    for (const item of data as Record<string, unknown>[]) {
      if (typeof item?.revised_prompt === "string")
        revised.push(item.revised_prompt);
      if (typeof item?.b64_json === "string") {
        images.push(Buffer.from(item.b64_json, "base64"));
      } else if (
        typeof item?.url === "string" &&
        /^https?:\/\//u.test(item.url)
      ) {
        // The provider's own link: fetched without the credential.
        const download = await fetcher(item.url, { signal });
        if (!download.ok)
          throw new ProviderFailure(
            `下载生成的图片失败：HTTP ${download.status}`,
          );
        images.push(Buffer.from(await download.arrayBuffer()));
      } else throw new ProviderFailure("服务商返回的图片格式无法识别");
    }
    const usage = (parsed as { usage?: unknown }).usage;
    return {
      images,
      revised,
      usage:
        usage === undefined
          ? null
          : JSON.parse(redactImageError(JSON.stringify(usage), [key])),
      created: (parsed as { created?: unknown }).created ?? null,
    };
  }
  private async succeed(
    job: ImageGenerationJob,
    prompt: string,
    result: {
      images: Buffer[];
      revised: string[];
      usage: unknown;
      created: unknown;
    },
  ) {
    const store = fileAttachmentStore(this.options.dataDir);
    const files: {
      bytes: Buffer;
      mime: string;
      name: string;
      note: string;
    }[] = [];
    for (const [index, bytes] of result.images.entries()) {
      const mime = imageMime(bytes);
      if (!mime) throw new ProviderFailure("服务商返回的内容不是图片");
      files.push({
        bytes,
        mime,
        name: `image-${job.id.slice(0, 8)}-${index + 1}.${EXTENSION[mime]}`,
        note: `生图 ${index + 1}/${result.images.length}（${job.request.model}）`,
      });
    }
    const finished = this.iso();
    const provenance = {
      version: 1,
      job_id: job.id,
      provider: job.provider,
      endpoint: `/images/${job.endpoint}`,
      project_id: job.project_id,
      card_id: job.card_id,
      requester: job.requester,
      request: job.request,
      created_at: job.created_at,
      finished_at: finished,
      provider_created: result.created,
      revised_prompts: result.revised,
      usage: result.usage,
      images: files.map((f) => ({
        file: f.name,
        mime: f.mime,
        size: f.bytes.byteLength,
        sha256: sha256(f.bytes),
      })),
    };
    files.push(
      {
        bytes: Buffer.from(prompt, "utf8"),
        mime: "text/plain",
        name: `prompt-${job.id.slice(0, 8)}.txt`,
        note: "生图提示词",
      },
      {
        bytes: Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`),
        mime: "application/json",
        name: `provenance-${job.id.slice(0, 8)}.json`,
        note: "生图来源记录",
      },
    );
    const stored: ((typeof files)[number] & {
      digest: string;
      path: string;
    })[] = [];
    for (const f of files) {
      const digest = sha256(f.bytes);
      stored.push({
        ...f,
        digest,
        path: (await store.put(digest, f.bytes)).storage_path,
      });
    }
    this.options.store.uow.run((tx) => {
      const entry = tx.ids.nextTimelineEntryId(job.project_id, job.card_id);
      const ids = stored.map((f) => {
        const id = tx.ids.nextAttachmentId(job.project_id);
        tx.attachments.put(job.project_id, {
          id,
          sha256: f.digest,
          mime: f.mime,
          size: f.bytes.byteLength,
          card_id: job.card_id,
          uploaded_by: "system",
          storage_path: f.path,
          attach_to: { kind: "timeline_entry", id: entry },
          kind: "evidence",
          original_filename: f.name,
          note: f.note,
        });
        return id as string;
      });
      const provenanceId = ids.pop() as string;
      const promptId = ids.pop() as string;
      const next: ImageGenerationJob = {
        ...job,
        status: "succeeded",
        finished_at: finished,
        usage: result.usage,
        attachments: {
          images: ids,
          prompt: promptId,
          provenance: provenanceId,
        },
        timeline_entry: entry,
      };
      const r = job.request;
      this.note(
        tx,
        next,
        this.save(tx, next),
        `生图完成（${job.requester.assignment_id}，${r.model}，${r.size}，${r.quality}，n=${r.n}${
          r.reference_attachments.length
            ? `，参考图 ${r.reference_attachments.map((a) => a.id).join("、")}`
            : ""
        }）：图片 ${ids.join("、")}；提示词 ${promptId}；来源记录 ${provenanceId}`,
        entry,
      );
    });
  }
  private fail(job: ImageGenerationJob, reason: string) {
    this.options.store.uow.run((tx) => {
      const next: ImageGenerationJob = {
        ...job,
        status: "failed",
        finished_at: this.iso(),
        usage: null,
        reason,
      };
      this.note(
        tx,
        next,
        this.save(tx, next),
        `生图失败（${job.requester.assignment_id}，${job.request.model}）：${reason}。未自动重试；需要时换一个 idempotency_key 重新请求。`,
      );
    });
  }
}

/** What the Agent sees: no credential, path or provider address. */
export function imageGenerationView(job: ImageGenerationJob) {
  return {
    job_id: job.id,
    status: job.status,
    model: job.request.model,
    size: job.request.size,
    quality: job.request.quality,
    n: job.request.n,
    background: job.request.background,
    reference_attachments: job.request.reference_attachments.map((a) => a.id),
    ...(job.usage === undefined ? {} : { usage: job.usage }),
    ...(job.attachments ? { attachments: job.attachments } : {}),
    ...(job.timeline_entry ? { timeline_entry: job.timeline_entry } : {}),
    ...(job.reason ? { reason: job.reason } : {}),
    ...(job.status === "running"
      ? {
          next: "仍在生成：用同一 idempotency_key 再次调用查看结果，完成后也会写入卡片时间线",
        }
      : {}),
  };
}
