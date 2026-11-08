import {
  browserStream,
  type StreamCallbacks,
  type StreamFactory,
  subscribeProject,
} from "./stream.js";
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

/** A list row: the card plus the fields the list filters and columns need. */
export interface CardListItem extends CardView {
  readonly progress: { readonly completed: number; readonly total: number };
  readonly updated_at: string;
  readonly roles: readonly string[];
}

/**
 * A reference the server resolved for a body (`references` of a timeline entry).
 * `exists` decides whether it may become a link: an identifier that names
 * nothing stays text (M5 plan §3.4).
 */
export interface ResolvedReference {
  readonly kind:
    | "card"
    | "timeline_entry"
    | "decision"
    | "human_action"
    | "delivery";
  readonly id: string;
  readonly exists: boolean;
  readonly status: string | null;
  readonly card_id?: string;
}

/** A reference an Agent put in a body, as stored on the entry itself. */
export type Reference =
  | { readonly kind: "card"; readonly id: string }
  | { readonly kind: "timeline_entry"; readonly id: string }
  | { readonly kind: "decision"; readonly id: string }
  | { readonly kind: "human_action"; readonly id: string }
  | { readonly kind: "delivery"; readonly id: string }
  | { readonly kind: "pr"; readonly url: string };

export interface WorkItemView {
  readonly id: string;
  readonly card_id: string;
  readonly title: string;
  readonly kind: "produce" | "verify";
  readonly role_id: string;
  readonly required: boolean;
  readonly status: string;
  readonly depends_on: readonly string[];
  readonly completion_criteria: readonly string[];
  readonly assignment_id?: string;
  readonly target_work_item_id?: string;
}

export interface TimelineEntryView {
  readonly id: string;
  readonly card_id: string;
  readonly event_seq: number;
  readonly event_type?: string | null;
  readonly author_role?: string | null;
  readonly review_id?: string;
  readonly decision_option?: string;
  readonly type:
    | "comment"
    | "instruction"
    | "delivery"
    | "review"
    | "decision_request"
    | "decision_resolved"
    | "human_action"
    | "handoff"
    | "status_change"
    | "system";
  readonly author: string;
  readonly work_item_id?: string;
  readonly delivery_id?: string;
  readonly decision_id?: string;
  readonly human_action_id?: string;
  /** What the body spelled; the server-resolved form is `references`. */
  readonly refs: readonly Reference[];
  /** Resolved references with existence and status (`references` in JSON). */
  readonly references: readonly ResolvedReference[];
  readonly supersedes?: string;
  readonly retracted: boolean;
  readonly body: string;
  readonly mentions: readonly string[];
  readonly created_at: string;
}

export interface DeliveryView {
  readonly id: string;
  readonly work_item_id: string;
  readonly kind: string;
  readonly summary: string;
  readonly subject: { readonly kind: string; readonly value: string };
  readonly branch?: string;
  readonly pr_url?: string;
  readonly status: string;
  readonly supersedes?: string;
  readonly test_results?: readonly { command: string; result: string }[];
  readonly evidence?: readonly { kind: string; details: unknown }[];
  readonly known_gaps?: readonly {
    description: string;
    followup_card_id?: string;
  }[];
}

export interface ReviewView {
  readonly id: string;
  readonly delivery_id: string;
  readonly work_item_id: string;
  readonly verdict: string;
  readonly blocking: boolean;
  readonly target_sha?: string;
  readonly issues?: readonly {
    severity: string;
    description: string;
    must_fix: boolean;
    pre_existing: boolean;
    proof?: string;
  }[];
  readonly recheck_required?: boolean;
}

export interface ReviewMatrixRow {
  readonly delivery_id: string;
  readonly work_item_id: string;
  readonly target_sha: string;
  readonly review_id?: string;
  readonly verdict: string | null;
}

export interface DecisionView {
  readonly trigger?: string | null;
  readonly id: string;
  readonly question: string;
  readonly status: string;
  readonly blocking: boolean;
  readonly decider: string;
  readonly options: readonly {
    readonly key: string;
    readonly description: string;
    readonly impact: string;
  }[];
  readonly recommended: string;
  readonly context?: string;
  readonly resolution?: {
    option: string;
    rationale: string;
    raw_quote: string;
    at: string;
  };
}

export interface HumanActionView {
  readonly id: string;
  readonly instructions: string;
  readonly why_human: string;
  readonly expected_return: string;
  readonly status: string;
}

/** Attachment metadata; the blob is a separate request (`download_path`). */
export interface AttachmentView {
  readonly id: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly kind: "artifact" | "evidence";
  readonly attach_to: { readonly kind: string; readonly id: string };
  readonly uploaded_by: string;
  readonly basis: { readonly id: string; readonly status: string } | null;
  readonly supersedes: string | null;
  readonly inline: boolean;
  readonly download_path: string;
}

export interface CardRelations {
  readonly decisions: readonly {
    readonly id: string;
    readonly question: string;
    readonly status: string;
    readonly blocking: boolean;
    readonly decider: string;
  }[];
  readonly cards: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: string;
  }[];
  readonly pull_requests: readonly {
    readonly delivery_id: string;
    readonly work_item_id: string;
    readonly status: string;
    readonly pr_url: string;
  }[];
}

export interface CardDetail {
  readonly updated_at?: string;
  readonly project_id: string;
  readonly card: CardView;
  readonly work_items: readonly WorkItemView[];
  readonly timeline: readonly TimelineEntryView[];
  readonly deliveries: readonly DeliveryView[];
  readonly reviews: readonly ReviewView[];
  readonly review_matrix: readonly ReviewMatrixRow[];
  readonly decisions: readonly DecisionView[];
  readonly human_actions: readonly HumanActionView[];
  readonly attachments: readonly AttachmentView[];
  readonly relations: CardRelations;
  readonly counts: {
    readonly timeline: number;
    readonly deliveries: number;
    readonly reviews: number;
    readonly open_decisions: number;
  };
}

export interface CommentInput {
  readonly body: string;
  readonly work_item_id?: string;
  readonly mentions?: readonly string[];
}

/** The timeline entry `postComment` returns. */
export interface PostedComment {
  readonly id: string;
  readonly body: string;
  readonly created_at: string;
}

export interface UploadAttachmentInput {
  /** Canonical padded base64. */
  readonly file: string;
  readonly mime: string;
  readonly kind: "artifact" | "evidence";
  readonly attach_to:
    | { readonly kind: "timeline_entry"; readonly id: string }
    | { readonly kind: "delivery"; readonly id: string };
  readonly basis?: string;
  readonly sha256?: string;
}

export interface AttachmentReceipt {
  readonly id: string;
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
  readonly cards: readonly CardListItem[];
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

export interface NeedsCardRef {
  readonly id: string;
  readonly title: string;
}
export interface MergeConfirmationDelivery {
  readonly id: string;
  readonly work_item_id: string;
  readonly work_item_title: string;
  readonly subject: { readonly kind: string; readonly value: string };
  readonly summary: string;
}
export interface MergeConfirmationReview {
  readonly id: string;
  readonly delivery_id: string;
  readonly work_item_id: string;
  readonly work_item_title: string | null;
  readonly role_id: string | null;
  readonly kind: string;
  readonly verdict: string;
  readonly target_sha: string;
  readonly issues: readonly {
    readonly severity: string;
    readonly description: string;
    readonly must_fix: boolean;
    readonly pre_existing: boolean;
    readonly proof?: string;
  }[];
}
export interface MergeConfirmationView {
  readonly completion: {
    readonly id: string;
    readonly work_item_id: string;
    readonly summary: string;
    readonly subject: { readonly kind: string; readonly value: string };
  } | null;
  readonly deliveries: readonly MergeConfirmationDelivery[];
  readonly reviews: readonly MergeConfirmationReview[];
  readonly known_gaps: readonly {
    readonly description: string;
    readonly followup_card_id?: string;
    readonly precondition?: string;
  }[];
}
export interface NeedsDecision extends DecisionView {
  readonly card_id: string | null;
  readonly affected_cards: readonly string[];
  readonly context: string;
  readonly why: string;
  readonly waited_ms: number | null;
  readonly trigger: string | null;
  readonly category: string;
  readonly assignment_id: string | null;
  readonly related_cards: readonly NeedsCardRef[];
  readonly merge_confirmation: MergeConfirmationView | null;
}
export interface NeedsAction
  extends Pick<HumanActionView, "id" | "instructions" | "expected_return"> {
  readonly card_id: string | null;
  readonly why: string;
  readonly waited_ms: number | null;
  readonly due: string | null;
  readonly blocked_work_items: readonly string[];
}
export interface NeedsPage {
  readonly decisions: readonly NeedsDecision[];
  readonly human_actions: readonly NeedsAction[];
  readonly incidents: readonly {
    readonly id: string;
    readonly role_id: string;
    readonly runtime_state: string;
    readonly disconnected_at?: string | null;
    readonly lost_at?: string | null;
    readonly last_run?: RunView | null;
    readonly card_id: string | null;
    readonly waited_ms: number | null;
  }[];
}

export interface SnapshotData {
  readonly cards: readonly CardView[];
  readonly in_progress: readonly CardView[];
  readonly in_review: readonly CardView[];
  readonly blocked: readonly {
    card_id: string;
    work_item_id: string;
    label: string;
  }[];
  readonly waiting: { human: readonly string[]; agent: readonly string[] };
  readonly recent_deliveries: readonly {
    id: string;
    card_id: string | null;
    summary: string;
    status: string;
  }[];
}
export interface RunView {
  readonly id: string;
  readonly assignment_id: string;
  readonly status: string;
  readonly kind: string;
  readonly outcome?: string | null;
  readonly model: string;
  readonly role_version: number;
  readonly agent_cli_version: string;
  readonly started_at?: string;
  readonly finished_at?: string;
  readonly summary: string;
}
export interface ExecutionAssignment {
  readonly id: string;
  readonly role_id: string;
  readonly role_version: number;
  readonly status: string;
  readonly runtime_state: string;
  readonly machine_id: string;
  readonly standing_mode: string | null;
  readonly card_id: string | null;
  readonly card_status: string | null;
  readonly work_item_id: string | null;
  readonly worktree_path: string | null;
  readonly branch: string | null;
  readonly session_ref: string | null;
  readonly runtime_ref: {
    terminal_ref: string;
    runtime_machine: string;
  } | null;
  readonly last_mcp_activity_at: string | null;
  readonly cursors: readonly { card_id: string; acked_seq: number }[];
}
export interface ExecutionData {
  readonly assignments: readonly ExecutionAssignment[];
  readonly runs: readonly RunView[];
  readonly machines: readonly { id: string; label: string; status: string }[];
}

export interface ActivityFilter {
  readonly card_id?: string;
  readonly role?: string;
  readonly actor?: string;
  readonly type?: string;
  readonly category?: string;
  readonly range?: string;
  readonly before?: string;
}
export interface ActivityData {
  readonly cards: readonly { id: string; title: string }[];
  readonly events: readonly {
    id: string;
    card_id: string | null;
    card_title: string | null;
    seq: number;
    type: string;
    role: string;
    created_at: string;
    payload: unknown;
    actor: { kind: string; assignment_id?: string };
  }[];
  readonly next_before: string | null;
  readonly counts: { returned: number; matched: number };
}

export interface CardReadOptions {
  readonly limit?: number;
  readonly at?: string;
}

export interface CardiganClient {
  subscribe(projectId: string, callbacks: StreamCallbacks): () => void;
  activity(projectId: string, filters: ActivityFilter): Promise<ActivityData>;
  snapshot(projectId: string): Promise<SnapshotData>;
  execution(projectId: string): Promise<ExecutionData>;
  needsYou(projectId: string): Promise<NeedsPage>;
  recordDecision(
    projectId: string,
    id: string,
    option: string,
    quote: string,
  ): Promise<void>;
  decisionComment(
    projectId: string,
    id: string,
    action: "request_information" | "explain",
    body: string,
  ): Promise<void>;
  completeAction(projectId: string, id: string, text: string): Promise<void>;
  session(): Promise<SessionInfo>;
  login(password: string): Promise<void>;
  logout(): Promise<void>;
  projects(): Promise<readonly ProjectSummary[]>;
  cards(projectId: string, filter: CardFilter): Promise<CardPage>;
  card(
    projectId: string,
    cardId: string,
    options?: CardReadOptions,
  ): Promise<CardDetail>;
  addComment(
    projectId: string,
    cardId: string,
    input: CommentInput,
  ): Promise<PostedComment>;
  uploadAttachment(
    projectId: string,
    cardId: string,
    input: UploadAttachmentInput,
  ): Promise<AttachmentReceipt>;
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
    private readonly streamFactory: StreamFactory = browserStream,
  ) {}

  subscribe(projectId: string, callbacks: StreamCallbacks): () => void {
    return subscribeProject(projectId, callbacks, this.streamFactory);
  }
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

  async card(
    projectId: string,
    cardId: string,
    options: CardReadOptions = {},
  ): Promise<CardDetail> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.at) params.set("at", options.at);
    const query = params.size ? `?${params}` : "";
    return this.request<CardDetail>(
      `/api/projects/${encodeURIComponent(projectId)}/cards/${encodeURIComponent(cardId)}${query}`,
    );
  }

  async addComment(
    projectId: string,
    cardId: string,
    input: CommentInput,
  ): Promise<PostedComment> {
    return this.request<PostedComment>(
      `/api/projects/${encodeURIComponent(projectId)}/cards/${encodeURIComponent(cardId)}/comments`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  async uploadAttachment(
    projectId: string,
    cardId: string,
    input: UploadAttachmentInput,
  ): Promise<AttachmentReceipt> {
    return this.request<AttachmentReceipt>(
      `/api/projects/${encodeURIComponent(projectId)}/cards/${encodeURIComponent(cardId)}/attachments`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  activity(projectId: string, filters: ActivityFilter): Promise<ActivityData> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters))
      if (value) query.set(key, value);
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/activity?${query}`,
    );
  }
  snapshot(projectId: string): Promise<SnapshotData> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/snapshot`,
    );
  }
  execution(projectId: string): Promise<ExecutionData> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/execution`,
    );
  }
  needsYou(projectId: string): Promise<NeedsPage> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/needs-you`,
    );
  }
  async recordDecision(
    projectId: string,
    id: string,
    option: string,
    quote: string,
  ): Promise<void> {
    await this.write(projectId, `decisions/${encodeURIComponent(id)}/resolve`, {
      option,
      raw_quote: quote,
    });
  }
  async decisionComment(
    projectId: string,
    id: string,
    action: "request_information" | "explain",
    body: string,
  ): Promise<void> {
    await this.write(
      projectId,
      `decisions/${encodeURIComponent(id)}/comments`,
      { action, ...(body.trim() ? { body } : {}) },
    );
  }
  async completeAction(
    projectId: string,
    id: string,
    text: string,
  ): Promise<void> {
    await this.write(
      projectId,
      `human-actions/${encodeURIComponent(id)}/complete`,
      { text },
    );
  }
  private write(
    projectId: string,
    rest: string,
    body: unknown,
  ): Promise<unknown> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/${rest}`,
      { method: "POST", body: JSON.stringify(body) },
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
