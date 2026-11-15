import { createPrivateKey, sign } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, relative } from "node:path";
import { CheckExecutorUnavailable } from "./check-executor.js";
import { CHECKOUT_LIMITS } from "./checkout-limits.js";
import type { GithubMergeGateExecutor } from "./merge-gate-executors.js";
import { secureCredentialFile } from "./merge-push-config.js";

export type GithubFailureCategory =
  | "auth"
  | "api"
  | "security"
  | "dispatch_unknown"
  | "card_busy";
/** Only fixed categories escape a credential/API boundary, never cause/body/URL. */
export class GithubExecutorError extends CheckExecutorUnavailable {
  constructor(category: GithubFailureCategory) {
    super(category);
  }
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
  readonly html_url: string;
  readonly created_at: string;
}
/** Host-only REST client. No response text or credential enters diagnostics. */
export class GithubClient {
  #cached?: { token: string; expires: number };
  #refresh: Promise<string> | undefined;
  constructor(
    private readonly options: {
      config: GithubMergeGateExecutor;
      dataDir: string;
      fetch?: typeof fetch;
      now?: () => number;
    },
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  async token(): Promise<string> {
    if (this.#cached && this.now() < this.#cached.expires - 60_000)
      return this.#cached.token;
    if (this.#refresh) return this.#refresh;
    this.#refresh = this.exchange();
    try {
      return await this.#refresh;
    } finally {
      this.#refresh = undefined;
    }
  }
  private async exchange(): Promise<string> {
    try {
      const { config, dataDir } = this.options;
      const path = await secureCredentialFile(
        dataDir,
        relative(dataDir, config.privateKeyFile),
      );
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
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
            metadata: "read",
          },
        },
      );
      const expires = Date.parse(body.expires_at as string);
      if (
        typeof body.token !== "string" ||
        !/^[A-Za-z0-9_-]+$/u.test(body.token) ||
        !Number.isFinite(expires) ||
        expires <= this.now() + 60_000
      )
        throw new Error("Invalid installation token");
      this.#cached = { token: body.token, expires };
      return body.token;
    } catch {
      throw new GithubExecutorError("auth");
    }
  }
  private async request(
    path: string,
    token: string,
    method = "GET",
    body?: unknown,
  ): Promise<{ body: Record<string, unknown>; link: string | null }> {
    try {
      const response = await (this.options.fetch ?? fetch)(
        `https://api.github.com/${path}`,
        {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(CHECKOUT_LIMITS.remoteCommandMs),
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      if (!response.ok) throw new Error("API failed");
      if (response.status === 204) return { body: {}, link: null };
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw new Error("Invalid response");
      return {
        body: result as Record<string, unknown>,
        link: response.headers.get("link"),
      };
    } catch {
      throw new GithubExecutorError("api");
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
      { ref, inputs },
    );
    // GitHub may return 204 (traditional) or a run id when supported.
    const id = result.workflow_run_id ?? result.id;
    if (id === undefined) return undefined;
    if (!Number.isSafeInteger(id) || (id as number) <= 0)
      throw new GithubExecutorError("security");
    return id as number;
  }
  async run(id: number): Promise<GithubRun> {
    if (!Number.isSafeInteger(id) || id < 1)
      throw new GithubExecutorError("security");
    const { body } = await this.request(
      `repos/${this.options.config.repo}/actions/runs/${id}`,
      await this.token(),
    );
    return body as unknown as GithubRun;
  }

  async runs(branch: string, since: string): Promise<readonly GithubRun[]> {
    const path = `repos/${this.options.config.repo}/actions/workflows/${encodeURIComponent(basename(this.options.config.workflow))}/runs`;
    // Fix both ends before paging, so new dispatches do not continually move
    // the target behind the first page during recovery.
    const query = new URLSearchParams({
      event: "workflow_dispatch",
      branch,
      created: `${since}..${new Date(this.now()).toISOString()}`,
      per_page: "100",
    });
    const runs: GithubRun[] = [];
    let page = 1;
    while (true) {
      const paged = new URLSearchParams(query);
      paged.set("page", String(page));
      const { body, link } = await this.request(
        `${path}?${paged}`,
        await this.token(),
      );
      if (
        !Array.isArray(body.workflow_runs) ||
        !Number.isSafeInteger(body.total_count) ||
        (body.total_count as number) < 0
      )
        throw new GithubExecutorError("security");
      const batch = body.workflow_runs as GithubRun[];
      runs.push(...batch);
      const next = this.nextPage(link, path, query, page);
      if (
        runs.length > (body.total_count as number) ||
        (next !== undefined && batch.length === 0)
      )
        throw new GithubExecutorError("security");
      if (next === undefined && runs.length === body.total_count) return runs;
      if (batch.length === 0 || runs.length === body.total_count)
        throw new GithubExecutorError("api");
      // Some intermediaries omit Link. The documented total_count still
      // prevents silently accepting an incomplete first page.
      page = next ?? page + 1;
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
