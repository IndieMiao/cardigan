/**
 * The Workbench API client (M5 plan §3.1, §3.2, §4 M5.1/M5.3).
 *
 * The session lives in an HttpOnly cookie the browser attaches by itself, so
 * this module never sees, stores or forwards a token. Every call is same-origin
 * with `credentials: "same-origin"`; a non-GET request carries the JSON
 * `Content-Type` the server requires and the browser adds the matching
 * `Origin`, which is what the CSRF check looks at.
 */

export interface SessionInfo {
  readonly authenticated: boolean;
  readonly password_configured: boolean;
}

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly created_at: string;
}

export interface WaitingOnItem {
  readonly kind: "decision" | "human_action" | "review" | "blocked";
  readonly ref: string;
  readonly label: string;
}

export interface NextOwnerItem {
  readonly kind: "human" | "role" | "assignment";
  readonly ref: string;
}

export type CardStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "review"
  | "awaiting_merge"
  | "done"
  | "cancelled";

/** The card view the API returns; `status`, `why` and `next_owners` are derived. */
export interface CardView {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly acceptance_criteria: readonly string[];
  readonly status: CardStatus;
  readonly priority: number;
  readonly repo: string;
  readonly base_branch: string;
  readonly created_at: string;
  readonly deadline?: string;
  readonly why: string;
  readonly waiting_on: readonly WaitingOnItem[];
  readonly next_owners: readonly NextOwnerItem[];
  readonly related_cards: readonly string[];
}

export interface CardCounts {
  readonly total: number;
  readonly needs_me: number;
  readonly agent: number;
}

export type CardFilter = "all" | "needs_me" | "agent";

export interface CardPage {
  readonly project_id: string;
  readonly filter: CardFilter;
  readonly cards: readonly CardView[];
  readonly counts: CardCounts;
}

/** A failure the UI can explain: HTTP status plus the server's error code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface CardiganClient {
  session(): Promise<SessionInfo>;
  login(password: string): Promise<void>;
  logout(): Promise<void>;
  projects(): Promise<readonly ProjectSummary[]>;
  cards(projectId: string, filter: CardFilter): Promise<CardPage>;
}

interface ErrorBody {
  readonly error?: { readonly code?: string; readonly message?: string };
}

export class HttpCardiganClient implements CardiganClient {
  /**
   * `fetchImpl` is injected by tests; production uses the global `fetch`, which
   * sends the cookie and the `Origin` header without any help from this code.
   */
  constructor(
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async session(): Promise<SessionInfo> {
    return this.request<SessionInfo>("/api/session");
  }

  async login(password: string): Promise<void> {
    await this.request("/api/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  }

  async logout(): Promise<void> {
    await this.request("/api/logout", { method: "POST", body: "{}" });
  }

  async projects(): Promise<readonly ProjectSummary[]> {
    const body = await this.request<{ projects: ProjectSummary[] }>(
      "/api/projects",
    );
    return body.projects;
  }

  async cards(projectId: string, filter: CardFilter): Promise<CardPage> {
    return this.request<CardPage>(
      `/api/projects/${encodeURIComponent(projectId)}/cards?filter=${filter}`,
    );
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: string } = {},
  ): Promise<T> {
    const method = init.method ?? "GET";
    const response = await this.fetchImpl(path, {
      method,
      credentials: "same-origin",
      headers:
        init.body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    if (!response.ok) {
      throw await toApiError(response, method, path);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }
}

async function toApiError(
  response: Response,
  method: string,
  path: string,
): Promise<ApiError> {
  let body: ErrorBody = {};
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    // A non-JSON error (a proxy, a crash) still has to surface as a failure.
  }
  const code = body.error?.code ?? `http_${response.status}`;
  const message =
    body.error?.message ?? `${method} ${path} 失败（${response.status}）`;
  return new ApiError(response.status, code, message);
}

/** Human-readable Chinese explanation of a failed request. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    // The login endpoint answers 401 for a wrong password; every other 401 is a
    // session that expired or was revoked by a password change.
    if (error.code === "invalid_credentials") return "密码不对。";
    if (error.status === 401) return "会话已失效，请重新登录。";
    if (error.status === 429) return "尝试次数太多，请稍后再试。";
    if (error.status === 403) return "请求被拒绝（来源校验未通过）。";
    return `请求失败：${error.message}`;
  }
  if (error instanceof TypeError) {
    return "连不上 Workbench 服务，确认 cardigan server 还在运行。";
  }
  return error instanceof Error ? error.message : String(error);
}
