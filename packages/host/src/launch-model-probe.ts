import {
  getHarnessAdapter,
  type LaunchConfig,
  type ResolvedProfile,
} from "@cardigan/roles";

class ResponseLimit extends Error {}

/** An opt-in probe of the explicit provider only. Never follow redirects or echo bodies. */
export async function probeModel(
  resolved: ResolvedProfile,
  secrets: Record<string, string>,
  smoke: boolean,
  limits: LaunchConfig["launch_check"],
) {
  const p = resolved.provider?.definition,
    model = resolved.profile.model;
  if (!p?.base_url || !p.api || !model)
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
  const messages = [{ role: "user", content: "Hi" }];
  const call = async (route: string, body?: unknown) => {
    const response = await fetch(`${base}/${route}`, {
      method: body ? "POST" : "GET",
      ...(body ? { body: JSON.stringify(body) } : {}),
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(limits?.timeout_ms ?? 5000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
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
  try {
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
      if (list.has_more === undefined || list.has_more === false)
        return "接入点未列出此模型";
      const cursor = list.last_id ?? list.data.at(-1)?.id;
      if (
        list.has_more !== true ||
        page >= (limits?.max_pages ?? 16) ||
        typeof cursor !== "string" ||
        !cursor ||
        cursors.has(cursor)
      )
        return "模型列表未查完（分页上限或游标无效）";
      cursors.add(cursor);
      route = `models?${new URLSearchParams({ [anthropic ? "after_id" : "after"]: cursor })}`;
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
