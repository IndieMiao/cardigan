import { createPrivateKey, sign } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, relative } from "node:path";
import { CheckExecutorUnavailable } from "./check-executor.js";
import { githubDeadline } from "./github-deadline.js";
import { GithubRateLimit, GithubRetryLater } from "./github-rate-limit.js";
import type { GithubMergeGateExecutor } from "./merge-gate-executors.js";
import { CHECK_OUTPUT_LIMIT } from "./merge-gate-log.js";
import { secureCredentialFile } from "./merge-push-config.js";

export type GithubFailureCategory =
  | "auth"
  | "api"
  | "security"
  | "recovery_incomplete"
  | "dispatch_unknown"
  | "card_busy";
/** Only fixed categories escape a credential/API boundary, never cause/body/URL. */
export class GithubExecutorError extends CheckExecutorUnavailable {
  constructor(category: GithubFailureCategory) {
    super(category);
  }
}
/** Fixed 404 evidence; only unbound dispatch discovery may defer this error. */
export class GithubNotFoundError extends GithubExecutorError {
  constructor() {
    super("api");
    this.diagnostic = "HTTP 404";
  }
}
/** Transport text may contain an Authorization header, signed URL or private key.
 * Preserve only provider status / known transport causes across this boundary. */
function transportFailure(category: GithubFailureCategory, cause: unknown) {
  const error = new GithubExecutorError(category);
  if (cause instanceof GithubExecutorError)
    error.diagnostic = cause.diagnostic ?? cause.message;
  else if (cause instanceof Error) {
    const underlying = cause.cause ?? cause;
    const code =
      underlying && typeof underlying === "object" && "code" in underlying
        ? underlying.code
        : undefined;
    const detail =
      typeof code === "string" &&
      [
        "ETIMEDOUT",
        "ECONNRESET",
        "ECONNREFUSED",
        "ENOTFOUND",
        "EAI_AGAIN",
        "CERT_HAS_EXPIRED",
        "CERT_NOT_YET_VALID",
        "ERR_TLS_CERT_ALTNAME_INVALID",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        "SELF_SIGNED_CERT_IN_CHAIN",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_SOCKET",
      ].includes(code)
        ? code
        : cause.name === "TimeoutError"
          ? "GitHub operation timed out"
          : cause.name === "AbortError"
            ? "GitHub operation aborted"
            : undefined;
    if (detail) error.diagnostic = detail;
  }
  return error;
}
export interface GithubRun {
  readonly id: number;
  readonly run_attempt: number;
  readonly path: string;
  readonly event: string;
  readonly head_branch: string;
  readonly head_sha: string;
  readonly actor: { readonly login: string };
  readonly triggering_actor?: { readonly login: string };
  readonly display_title: string;
  readonly name?: string;
  readonly html_url: string;
  readonly created_at: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly run_started_at?: string;
}
/** Compare only the fields used as trusted binding evidence, not provider metadata. */
export function sameGithubRun(a: GithubRun, b: GithubRun): boolean {
  const identity = (run: GithubRun) => [
    run.id,
    run.run_attempt,
    run.path,
    run.event,
    run.head_branch,
    run.head_sha,
    run.actor?.login,
    run.triggering_actor?.login,
    run.display_title,
    run.html_url,
    run.created_at,
  ];
  return JSON.stringify(identity(a)) === JSON.stringify(identity(b));
}
/** Host-only REST client. No response text or credential enters diagnostics. */
export interface GithubStep {
  readonly name: string;
  readonly number: number;
  readonly status: string;
  readonly conclusion: string | null;
}
export interface GithubJob {
  readonly id: number;
  readonly run_id: number;
  readonly run_attempt: number;
  readonly head_sha: string;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly steps: readonly GithubStep[];
}
export class GithubClient {
  private readonly rate: GithubRateLimit;
  #cached?: { token: string; expires: number };
  #refresh: Promise<string> | undefined;
  constructor(
    private readonly options: {
      config: GithubMergeGateExecutor;
      dataDir: string;
      fetch?: typeof fetch;
      now?: () => number;
      rate?: GithubRateLimit;
    },
  ) {
    this.rate = options.rate ?? new GithubRateLimit(undefined, options.now);
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  async token(): Promise<string> {
    if (this.#cached && this.now() < this.#cached.expires - 60_000)
      return this.#cached.token;
    if (this.#refresh) return this.#refresh;
    this.#refresh = githubDeadline((signal) => this.exchange(signal)).catch(
      (error: unknown) => {
        if (
          error instanceof GithubExecutorError ||
          error instanceof GithubRetryLater
        )
          throw error;
        throw transportFailure("auth", error);
      },
    );
    try {
      return await this.#refresh;
    } finally {
      this.#refresh = undefined;
    }
  }
  private async exchange(signal: AbortSignal): Promise<string> {
    try {
      const { config, dataDir } = this.options;
      const path = await secureCredentialFile(
        dataDir,
        relative(dataDir, config.privateKeyFile),
      );
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let pem: Buffer;
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o7777) !== 0o600
        )
          throw new Error("Invalid private key");
        pem = await file.readFile();
      } finally {
        await file.close();
      }
      let jwt: string;
      try {
        const key = createPrivateKey(pem);
        if (key.asymmetricKeyType !== "rsa") throw new Error("Invalid App key");
        const now = Math.floor(this.now() / 1000);
        const unsigned = [
          Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
            "base64url",
          ),
          Buffer.from(
            JSON.stringify({
              iat: now - 60,
              exp: now + 540,
              iss: String(config.appId),
            }),
          ).toString("base64url"),
        ].join(".");
        jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
      } finally {
        pem.fill(0);
      }
      const { body } = await this.request(
        `app/installations/${config.installationId}/access_tokens`,
        jwt,
        "POST",
        {
          repositories: [config.repo.split("/")[1]],
          permissions: {
            actions: "write",
            contents: "write",
            workflows: "write",
            metadata: "read",
          },
        },
        undefined,
        signal,
      );
      signal.throwIfAborted();
      const expires = Date.parse(body.expires_at as string);
      if (
        typeof body.token !== "string" ||
        // Q-661: local credential boundary, not a provider length guarantee.
        !/^[A-Za-z0-9_.-]{1,2048}$/u.test(body.token) ||
        !Number.isFinite(expires) ||
        expires <= this.now() + 60_000
      )
        throw new Error("Invalid installation token");
      this.#cached = { token: body.token, expires };
      return body.token;
    } catch (error) {
      if (error instanceof GithubRetryLater) throw error;
      throw transportFailure("auth", error);
    }
  }
  private async request(
    path: string,
    token: string,
    method = "GET",
    body?: unknown,
    etag?: string,
    signal?: AbortSignal,
  ): Promise<{
    body: Record<string, unknown>;
    link: string | null;
    etag?: string;
    unchanged?: boolean;
  }> {
    try {
      return await githubDeadline(async (deadline) => {
        const refund = this.rate.reserve();
        const response = await (this.options.fetch ?? fetch)(
          `https://api.github.com/${path}`,
          {
            method,
            redirect: "error",
            signal: deadline,
            headers: {
              ...(etag ? { "If-None-Match": etag } : {}),
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "Content-Type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
        );
        deadline.throwIfAborted();
        if (response.status === 304) {
          refund();
          return { body: {}, link: null, unchanged: true };
        }
        if (response.status === 403 || response.status === 429)
          this.rate.backoff(response.headers.get("retry-after"));
        if (response.status === 404) throw new GithubNotFoundError();
        if (!response.ok) {
          const error = new GithubExecutorError("api");
          error.diagnostic = `HTTP ${response.status}`;
          throw error;
        }
        if (response.status === 204 || response.status === 202)
          return { body: {}, link: null };
        let result: unknown;
        try {
          result = await response.json();
        } catch (cause) {
          if (!(cause instanceof SyntaxError)) throw cause;
          const error = new GithubExecutorError("api");
          error.diagnostic = "Invalid GitHub response JSON";
          throw error;
        }
        if (!result || typeof result !== "object" || Array.isArray(result)) {
          const error = new GithubExecutorError("api");
          error.diagnostic = "Invalid GitHub response object";
          throw error;
        }
        const responseEtag = response.headers.get("etag");
        return {
          body: result as Record<string, unknown>,
          link: response.headers.get("link"),
          ...(responseEtag ? { etag: responseEtag } : {}),
        };
      }, signal);
    } catch (error) {
      if (
        error instanceof GithubRetryLater ||
        error instanceof GithubExecutorError
      )
        throw error;
      throw transportFailure(
        signal?.aborted ? "recovery_incomplete" : "api",
        error,
      );
    }
  }
  async dispatch(
    ref: string,
    inputs: Readonly<Record<string, string>>,
  ): Promise<number | undefined> {
    const { config } = this.options;
    const { body: result } = await this.request(
      `repos/${config.repo}/actions/workflows/${encodeURIComponent(basename(config.workflow))}/dispatches`,
      await this.token(),
      "POST",
      { ref, inputs, return_run_details: true },
    );
    // GitHub may return 204 (traditional) or a run id when supported.
    const id = result.workflow_run_id ?? result.id;
    if (id === undefined) return undefined;
    if (!Number.isSafeInteger(id) || (id as number) <= 0)
      throw new GithubExecutorError("security");
    return id as number;
  }
  async run(id: number, signal?: AbortSignal): Promise<GithubRun> {
    if (!Number.isSafeInteger(id) || id < 1)
      throw new GithubExecutorError("security");
    const { body } = await this.request(
      `repos/${this.options.config.repo}/actions/runs/${id}`,
      await this.token(),
      "GET",
      undefined,
      undefined,
      signal,
    );
    return body as unknown as GithubRun;
  }

  async runs(
    branch: string,
    since: string,
    signal?: AbortSignal,
    onObserved?: (page: readonly unknown[]) => void,
  ): Promise<readonly GithubRun[]> {
    try {
      return await githubDeadline(
        (deadline) => this.discover(branch, since, deadline, onObserved),
        signal,
      );
    } catch (error) {
      if (
        error instanceof GithubRetryLater ||
        error instanceof GithubExecutorError
      )
        throw error;
      throw transportFailure("recovery_incomplete", error);
    }
  }
  private async discover(
    branch: string,
    since: string,
    signal: AbortSignal,
    onObserved?: (page: readonly unknown[]) => void,
  ) {
    // GitHub's created filter has second precision. Fix the upper bound once;
    // subdivision must not extend the recovery interval while it is scanned.
    const from = Math.floor(Date.parse(since) / 1000);
    const to = Math.floor(this.now() / 1000);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to)
      throw new GithubExecutorError("security");
    const path = `repos/${this.options.config.repo}/actions/workflows/${encodeURIComponent(basename(this.options.config.workflow))}/runs`;
    const windows: [number, number][] = [[from, to]];
    const found = new Map<number, GithubRun>();
    // Parent pages are incomplete discovery, but their observed identities
    // remain evidence. Subdivision cannot erase a conflict or a vanished ID.
    const observed = new Map<number, GithubRun>();
    const saturated: { start: number; end: number; count: number }[] = [];
    const add = (target: Map<number, GithubRun>, run: GithubRun) => {
      const previous = target.get(run.id);
      if (previous && !sameGithubRun(previous, run))
        throw new GithubExecutorError("security");
      target.set(run.id, run);
    };
    while (windows.length) {
      const [start, end] = windows.pop()!;
      const query = new URLSearchParams({
        event: "workflow_dispatch",
        branch,
        created: `${new Date(start * 1000).toISOString()}..${new Date(end * 1000).toISOString()}`,
        per_page: "100",
      });
      const windowRuns = new Map<number, GithubRun>();
      let total: number | undefined;
      for (let page = 1; ; page++) {
        if (signal?.aborted)
          throw new GithubExecutorError("recovery_incomplete");
        const paged = new URLSearchParams(query);
        paged.set("page", String(page));
        const { body, link } = await this.request(
          `${path}?${paged}`,
          await this.token(),
          "GET",
          undefined,
          undefined,
          signal,
        );
        if (signal?.aborted)
          throw new GithubExecutorError("recovery_incomplete");
        // A bad count, Link, sibling or time window invalidates this enumeration, not
        // the fact that GitHub returned an identifiable candidate on this very page.
        // These are only hints. The unchanged validation below gates every successful list.
        if (Array.isArray(body.workflow_runs)) onObserved?.(body.workflow_runs);
        if (
          !Array.isArray(body.workflow_runs) ||
          !Number.isSafeInteger(body.total_count) ||
          (body.total_count as number) < 0 ||
          body.workflow_runs.length > 100
        )
          throw new GithubExecutorError("security");
        const next = this.nextPage(link, path, query, page);
        if (total !== undefined && total !== body.total_count)
          throw new GithubExecutorError("recovery_incomplete");
        total = body.total_count as number;
        const before = windowRuns.size;
        for (const candidate of body.workflow_runs) {
          const run = candidate as GithubRun;
          const created = Date.parse(run?.created_at);
          if (
            !run ||
            !Number.isSafeInteger(run.id) ||
            run.id < 1 ||
            !Number.isFinite(created) ||
            created < start * 1000 ||
            created >= (end + 1) * 1000
          )
            throw new GithubExecutorError("security");
          add(observed, run);
          add(windowRuns, run);
        }
        if (windowRuns.size > total) throw new GithubExecutorError("security");
        // Filtered workflow queries expose at most 1000 records. Treat a
        // saturated count conservatively, including providers clamping counts.
        if (total >= 1000) {
          if (start === end)
            throw new GithubExecutorError("recovery_incomplete");
          saturated.push({ start, end, count: total });
          const middle = Math.floor((start + end) / 2);
          // Inclusive overlap preserves boundary records; global ID dedup
          // must still detect identity changes. Adjacent seconds become leaves.
          windows.push([middle === start ? end : middle, end], [start, middle]);
          break;
        }

        if (next === undefined && windowRuns.size === total) {
          for (const run of windowRuns.values()) add(found, run);
          break;
        }
        // Empty/repeated pages, count drift or a capped/incomplete result must
        // never produce a partial successful scan or an unbounded page loop.
        if (
          windowRuns.size === before ||
          windowRuns.size === total ||
          page >= 10
        )
          throw new GithubExecutorError("recovery_incomplete");
        // Some intermediaries omit Link: use the count and rebuild the URL.
      }
    }
    for (const id of observed.keys()) {
      if (!found.has(id)) throw new GithubExecutorError("recovery_incomplete");
    }
    // Reconcile parent counts too: subdivision must not hide count drift.
    // Exactly 1000 can be a clamped provider count; it is only a lower bound.
    for (const { start, end, count } of saturated) {
      const actual = [...found.values()].filter((run) => {
        const created = Date.parse(run.created_at);
        return created >= start * 1000 && created < (end + 1) * 1000;
      }).length;
      if (actual < count || (count > 1000 && actual !== count))
        throw new GithubExecutorError("recovery_incomplete");
    }
    return [...found.values()];
  }
  /** D4 lists once per maintenance cycle; missing bound ids are queried directly. */
  async pollRuns(etag?: string, signal?: AbortSignal) {
    const result = await this.request(
      `repos/${this.options.config.repo}/actions/workflows/${encodeURIComponent(basename(this.options.config.workflow))}/runs?per_page=100`,
      await this.token(),
      "GET",
      undefined,
      etag,
      signal,
    );
    if (result.unchanged) return { unchanged: true as const };
    if (!Array.isArray(result.body.workflow_runs))
      throw new GithubExecutorError("security");
    return {
      unchanged: false as const,
      runs: result.body.workflow_runs as GithubRun[],
      etag: result.etag,
    };
  }
  async jobs(id: number, signal?: AbortSignal): Promise<readonly GithubJob[]> {
    if (!Number.isSafeInteger(id) || id < 1)
      throw new GithubExecutorError("security");
    const { body, link } = await this.request(
      `repos/${this.options.config.repo}/actions/runs/${id}/attempts/1/jobs?per_page=100`,
      await this.token(),
      "GET",
      undefined,
      undefined,
      signal,
    );
    if (
      !Array.isArray(body.jobs) ||
      body.total_count !== body.jobs.length ||
      link?.includes('rel="next"')
    )
      throw new GithubExecutorError("security");
    return body.jobs as GithubJob[];
  }
  async cancel(id: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(id) || id < 1)
      throw new GithubExecutorError("security");
    await this.request(
      `repos/${this.options.config.repo}/actions/runs/${id}/cancel`,
      await this.token(),
      "POST",
      undefined,
      undefined,
      signal,
    );
  }
  async jobLog(id: number): Promise<string> {
    if (!Number.isSafeInteger(id) || id < 1)
      throw new GithubExecutorError("security");
    try {
      return await githubDeadline(async (signal) => {
        const token = await this.token();
        signal.throwIfAborted();
        this.rate.reserve();
        const init = {
          redirect: "manual" as const,
          signal,
        };
        let response = await (this.options.fetch ?? fetch)(
          `https://api.github.com/repos/${this.options.config.repo}/actions/jobs/${id}/logs`,
          { ...init, headers: { Authorization: `Bearer ${token}` } },
        );
        signal.throwIfAborted();
        if (response.status === 403 || response.status === 429)
          this.rate.backoff(response.headers.get("retry-after"));
        if (response.status === 302) {
          const url = new URL(response.headers.get("location") ?? "");
          if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.port ||
            !(
              url.hostname.endsWith(".blob.core.windows.net") ||
              url.hostname.endsWith(".actions.githubusercontent.com")
            )
          )
            throw new GithubExecutorError("security");
          // Signed storage URLs never receive the App token and cannot redirect again.
          this.rate.reserve();
          response = await (this.options.fetch ?? fetch)(url, {
            ...init,
            redirect: "error",
          });
        }
        signal.throwIfAborted();
        if (!response.ok || !response.body)
          throw new GithubExecutorError("api");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const part = await reader.read();
            signal.throwIfAborted();
            if (part.done) break;
            size += part.value.length;
            if (size > CHECK_OUTPUT_LIMIT) throw new GithubExecutorError("api");
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel();
        }
        return Buffer.concat(chunks).toString("utf8");
      });
    } catch (error) {
      if (error instanceof GithubRetryLater) throw error;
      throw new GithubExecutorError("api");
    }
  }
  private nextPage(
    link: string | null,
    path: string,
    query: URLSearchParams,
    page: number,
  ): number | undefined {
    if (!link) return undefined;
    let next: number | undefined;
    for (const part of link.split(",")) {
      const match =
        /^\s*<([^>]+)>\s*;\s*rel="?(next|prev|first|last)"?\s*$/u.exec(part);
      if (!match) throw new GithubExecutorError("security");
      if (match[2] !== "next") continue;
      let url: URL;
      try {
        url = new URL(match[1] as string);
      } catch {
        throw new GithubExecutorError("security");
      }
      const number = Number(url.searchParams.get("page"));
      if (
        next !== undefined ||
        url.origin !== "https://api.github.com" ||
        url.username ||
        url.password ||
        url.hash ||
        url.pathname !== `/${path}` ||
        url.searchParams.size !== query.size + 1 ||
        !Number.isSafeInteger(number) ||
        number !== page + 1 ||
        [...query].some(([key, value]) => url.searchParams.get(key) !== value)
      )
        throw new GithubExecutorError("security");
      next = number;
    }
    // Only the validated page number is used. Never send a credential to a
    // response-provided URL, even when the Link header looks well formed.
    return next;
  }
}
