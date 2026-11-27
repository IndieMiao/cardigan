import {
  getHarnessAdapter,
  type LaunchConfig,
  type ResolvedProfile,
} from "@cardigan/roles";

class ResponseLimit extends Error {}
/** The status only; the response body is never read or kept. */
class HttpStatus extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/**
 * The credentialed request helper shared by the probe and the model listing:
 * the explicit endpoint only, no redirects, a timeout and a byte limit, and
 * never a response body or the credential in an error.
 */
function providerClient(
  resolved: ResolvedProfile,
  secrets: Record<string, string>,
  limits: LaunchConfig["launch_check"],
  fetchImpl: typeof fetch = fetch,
  /** C-564: an overall deadline; aborts the request and the body read. */
  signal?: AbortSignal,
) {
  const p = resolved.provider?.definition;
  if (!p?.base_url || !p.api)
    throw new Error("联网检查需要明确的接入点 URL、协议和模型 ID");
  const url = new URL(p.base_url);
  const anthropic = p.api === "anthropic-messages";
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (anthropic) headers["anthropic-version"] = "2023-06-01";
  const refs = Object.keys(p.secret_env);
  const key = getHarnessAdapter(resolved.profile.harness).probeCredential(p);
  if (refs.length && (!key || !p.secret_env[key]))
    throw new Error("无法确定该接入点的检查凭据");
  if (key) {
    if (url.protocol !== "https:")
      throw new Error("带凭据的联网检查要求 HTTPS");
    const ref = p.secret_env[key];
    const token = ref && Object.hasOwn(secrets, ref) && secrets[ref];
    if (!token) throw new Error("缺少联网检查凭据");
    if (anthropic && key !== "ANTHROPIC_AUTH_TOKEN")
      headers["x-api-key"] = token;
    else headers.authorization = `Bearer ${token}`;
  }
  const base =
    url.href.replace(/\/+$/u, "") + (url.pathname === "/" ? "/v1" : "");
  const call = async (route: string, body?: unknown) => {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(limits?.timeout_ms ?? 5000);
    const response = await fetchImpl(`${base}/${route}`, {
      method: body ? "POST" : "GET",
      ...(body ? { body: JSON.stringify(body) } : {}),
      headers,
      redirect: "error",
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpStatus(response.status);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel();
        signal.throwIfAborted();
      }
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      if (size > (limits?.max_bytes ?? 2 * 1024 * 1024)) {
        await reader.cancel();
        throw new ResponseLimit();
      }
      chunks.push(r.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
  /** The next page of a `/models` listing, or `undefined` at the end. */
  const nextPage = (
    list: { has_more?: unknown; last_id?: unknown; data: unknown[] },
    page: number,
    cursors: Set<string>,
  ): string | undefined | null => {
    if (list.has_more === undefined || list.has_more === false)
      return undefined;
    const last = list.data.at(-1) as { id?: unknown } | null | undefined;
    const cursor = list.last_id ?? last?.id;
    if (
      list.has_more !== true ||
      page >= (limits?.max_pages ?? 16) ||
      typeof cursor !== "string" ||
      !cursor ||
      cursors.has(cursor)
    )
      return null;
    cursors.add(cursor);
    return `models?${new URLSearchParams({ [anthropic ? "after_id" : "after"]: cursor })}`;
  };
  return { p, anthropic, call, nextPage };
}

/** A model ID as a listing may show it: one short line of printable text. */
const listedId = (id: unknown): id is string =>
  typeof id === "string" &&
  id.length > 0 &&
  id.length <= 256 &&
  /^[^\p{Cc}]+$/u.test(id) &&
  id.trim() === id;

/** The most model IDs one listing keeps; more makes the listing partial. */
export const MAX_LISTED_MODELS = 5000;

/**
 * Walk the Provider's `GET /models` pages (OpenAI-compatible or Anthropic)
 * within the probe's limits, handing each page's plain IDs to `visit` until
 * it returns true. Never calls inference. Any failure (including the
 * deadline `signal`) throws a generic error without the response.
 */
async function walkModels(
  resolved: ResolvedProfile,
  secrets: Record<string, string>,
  limits: LaunchConfig["launch_check"],
  visit: (ids: string[]) => boolean,
  options: { fetch?: typeof fetch; signal?: AbortSignal },
): Promise<"done" | "stopped" | "limit"> {
  const client = providerClient(
    resolved,
    secrets,
    limits,
    options.fetch,
    options.signal,
  );
  const cursors = new Set<string>();
  let route: string | undefined = "models";
  try {
    for (let page = 1; route; page++) {
      const list = await client.call(route).catch((error) => {
        if (error instanceof ResponseLimit) return null;
        throw error;
      });
      if (list === null) return "limit";
      if (!Array.isArray(list?.data)) throw new Error();
      const ids = (list.data as { id?: unknown }[])
        .map((item) => item?.id)
        .filter(listedId);
      if (visit(ids)) return "stopped";
      const next = client.nextPage(list, page, cursors);
      if (next === null) return "limit";
      route = next;
    }
  } catch {
    throw new Error("接入点模型列表读取失败");
  }
  return "done";
}

/**
 * C-564: the model IDs the Provider lists. `complete` is false when a page,
 * size or cursor limit, or the cap of `MAX_LISTED_MODELS`, cut it short.
 */
export async function listProviderModels(
  resolved: ResolvedProfile,
  secrets: Record<string, string>,
  limits: LaunchConfig["launch_check"],
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ ids: string[]; complete: boolean }> {
  const ids = new Set<string>();
  let truncated = false;
  const end = await walkModels(
    resolved,
    secrets,
    limits,
    (page) => {
      for (const id of page) {
        if (ids.has(id)) continue;
        if (ids.size >= MAX_LISTED_MODELS) {
          truncated = true;
          return true;
        }
        ids.add(id);
      }
      return false;
    },
    options,
  );
  return { ids: [...ids], complete: end === "done" && !truncated };
}

/**
 * C-564: whether the Provider lists `model`, page by page until found. The
 * ID is only compared on the host; it is never sent anywhere, and nothing
 * calls inference. "incomplete" when a limit stopped the search first.
 */
export async function findProviderModel(
  resolved: ResolvedProfile,
  secrets: Record<string, string>,
  limits: LaunchConfig["launch_check"],
  model: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<"listed" | "not_listed" | "incomplete"> {
  const end = await walkModels(
    resolved,
    secrets,
    limits,
    (ids) => ids.includes(model),
    options,
  );
  return end === "stopped"
    ? "listed"
    : end === "done"
      ? "not_listed"
      : "incomplete";
}

/** An opt-in probe of the explicit provider only. Never follow redirects or echo bodies. */
export async function probeModel(
  resolved: ResolvedProfile,
  secrets: Record<string, string>,
  smoke: boolean,
  limits: LaunchConfig["launch_check"],
  /** C-549: a Provider probe lists the first page of models, no model needed. */
  listOnly = false,
) {
  const model = resolved.profile.model;
  if (
    !resolved.provider?.definition.base_url ||
    !resolved.provider.definition.api ||
    (!model && !listOnly) ||
    (listOnly && smoke)
  )
    throw new Error("联网检查需要明确的接入点 URL、协议和模型 ID");
  const { p, anthropic, call, nextPage } = providerClient(
    resolved,
    secrets,
    limits,
  );
  const messages = [{ role: "user", content: "Hi" }];
  try {
    if (listOnly) {
      const list = await call("models");
      if (!Array.isArray(list?.data)) throw new Error();
      return undefined;
    }
    let route = "models";
    const cursors = new Set<string>();
    for (let page = 1; ; page++) {
      const list = await call(route).catch((error) => {
        if (error instanceof ResponseLimit) return null;
        throw error;
      });
      if (list === null) return "模型列表未查完（响应超过读取上限）";
      if (!Array.isArray(list.data)) throw new Error();
      if (list.data.some((item: { id?: string } | null) => item?.id === model))
        break;
      const next = nextPage(list, page, cursors);
      if (next === undefined) return "接入点未列出此模型";
      if (next === null) return "模型列表未查完（分页上限或游标无效）";
      route = next;
    }
    if (smoke) {
      const responses = p.api === "openai-responses";
      const result = await call(
        anthropic ? "messages" : responses ? "responses" : "chat/completions",
        responses
          ? { model, input: "Hi", max_output_tokens: 16 }
          : { model, messages, max_tokens: 1 },
      );
      if (
        !Array.isArray(
          anthropic
            ? result?.content
            : responses
              ? result?.output
              : result?.choices,
        ) ||
        result.error
      )
        throw new Error();
    }
  } catch {
    return "接入点检查失败（请核对协议、凭据和模型）";
  }
  return undefined;
}

/**
 * C-821: outcome of one recovery probe. Only a status code and a fixed
 * failure class leave the probe: never the credential, the request, the
 * response body or an error message.
 */
export type UpstreamModelProbe =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly failure:
        | "http_status"
        | "timeout"
        | "connection_error"
        | "invalid_response"
        | "not_configured";
      readonly status?: number;
    };

/**
 * C-821: one minimal model request (one input token, one output token) to the
 * launch profile's explicit endpoint, with the launch configuration's own
 * credential. No model listing, no redirects, a timeout and a byte limit.
 */
export async function probeUpstreamModel(
  resolved: ResolvedProfile,
  secrets: Record<string, string>,
  limits: LaunchConfig["launch_check"],
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<UpstreamModelProbe> {
  const model = resolved.profile.model;
  let client: ReturnType<typeof providerClient>;
  try {
    if (!model) throw new Error();
    client = providerClient(
      resolved,
      secrets,
      limits,
      options.fetch,
      options.signal,
    );
  } catch {
    return { ok: false, failure: "not_configured" };
  }
  const { p, anthropic, call } = client;
  const responses = p.api === "openai-responses";
  try {
    const result = await call(
      anthropic ? "messages" : responses ? "responses" : "chat/completions",
      responses
        ? { model, input: "Hi", max_output_tokens: 16 }
        : { model, messages: [{ role: "user", content: "Hi" }], max_tokens: 1 },
    );
    const content = anthropic
      ? result?.content
      : responses
        ? result?.output
        : result?.choices;
    return Array.isArray(content) && !result.error
      ? { ok: true }
      : { ok: false, failure: "invalid_response" };
  } catch (error) {
    if (error instanceof HttpStatus)
      return { ok: false, failure: "http_status", status: error.status };
    if (error instanceof ResponseLimit || error instanceof SyntaxError)
      return { ok: false, failure: "invalid_response" };
    const name = (error as { name?: unknown } | null)?.name;
    return {
      ok: false,
      failure:
        name === "TimeoutError" || name === "AbortError"
          ? "timeout"
          : "connection_error",
    };
  }
}
