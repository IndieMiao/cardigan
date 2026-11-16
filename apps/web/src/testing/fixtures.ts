import type {
  AttachmentView,
  CardDetail,
  CardiganClient,
  CardListItem,
  ProjectSummary,
  SessionInfo,
  TimelineEntryView,
} from "../api.js";

/**
 * Fixtures for the component tests. Production code never imports this module,
 * so Vite never bundles it; it exists so the tests describe one project, one
 * card and one timeline instead of repeating them in every file.
 */

export const NOW = "2026-01-01T00:00:00.000Z";

export const card: CardListItem & CardDetail["card"] = {
  id: "C-1",
  title: "准备发布",
  goal: "把 0.1 发出去",
  acceptance_criteria: ["测试通过", "文档更新"],
  status: "in_progress",
  priority: 1,
  repo: "example/repo",
  base_branch: "main",
  created_at: NOW,
  why: "等你拍板 D-1",
  waiting_on: [{ kind: "decision", ref: "D-1", label: "等你拍板 D-1" }],
  next_owners: [
    { kind: "human", ref: "human" },
    { kind: "role", ref: "reviewer" },
  ],
  related_cards: [],
  progress: { completed: 1, total: 2 },
  updated_at: NOW,
  roles: ["coder", "reviewer"],
};

export function timelineEntry(
  overrides: Partial<TimelineEntryView> = {},
): TimelineEntryView {
  return {
    id: "C-1#2",
    card_id: "C-1",
    event_seq: 2,
    type: "comment",
    author: "assignment:A-1",
    refs: [],
    references: [],
    retracted: false,
    body: "看过了，没问题。",
    mentions: [],
    created_at: NOW,
    ...overrides,
  };
}

export function attachment(
  overrides: Partial<AttachmentView> = {},
): AttachmentView {
  return {
    id: "F-1",
    mime: "image/png",
    size: 1234,
    sha256: "a".repeat(64),
    kind: "evidence",
    attach_to: { kind: "timeline_entry", id: "C-1#2" },
    uploaded_by: "assignment:A-1",
    basis: { id: "D-1", status: "open" },
    supersedes: null,
    inline: true,
    download_path: "/api/projects/p-1/attachments/F-1",
    ...overrides,
  };
}

export function cardDetail(overrides: Partial<CardDetail> = {}): CardDetail {
  return {
    project_id: "p-1",
    card,
    work_items: [
      {
        id: "W-1",
        card_id: "C-1",
        title: "写迁移脚本",
        kind: "produce",
        role_id: "coder",
        required: true,
        status: "delivered",
        depends_on: [],
        completion_criteria: [],
        assignment_id: "A-1",
      },
      {
        id: "W-2",
        card_id: "C-1",
        title: "代码审核",
        kind: "verify",
        role_id: "reviewer",
        required: true,
        status: "ready",
        depends_on: [],
        completion_criteria: ["没有阻塞问题"],
      },
    ],
    timeline: [
      timelineEntry({ id: "C-1#2", event_seq: 2, type: "comment" }),
      timelineEntry({
        id: "C-1#1",
        event_seq: 1,
        type: "decision_request",
        author: "human",
        body: "发布前要不要再跑一次冒烟？见 C-1",
      }),
    ],
    deliveries: [
      {
        id: "V-1",
        work_item_id: "W-1",
        kind: "code",
        summary: "迁移脚本与回滚脚本",
        subject: { kind: "git_head", value: "abc123" },
        status: "submitted",
      },
    ],
    reviews: [],
    review_matrix: [
      {
        delivery_id: "V-1",
        work_item_id: "W-2",
        target_sha: "abc123",
        verdict: null,
      },
    ],
    decisions: [],
    human_actions: [],
    attachments: [attachment({})],
    relations: { decisions: [], cards: [], pull_requests: [] },
    counts: { timeline: 2, deliveries: 1, reviews: 0, open_decisions: 0 },
    ...overrides,
  };
}

export const project: ProjectSummary = {
  id: "p-1",
  name: "Cardigan 自己",
  created_at: NOW,
};

export const loggedIn = async (): Promise<SessionInfo> => ({
  authenticated: true,
  password_configured: true,
});

/** A client whose every method resolves; tests override what they assert. */
export function fakeClient(
  overrides: Partial<CardiganClient> = {},
): CardiganClient {
  return {
    employeeOptions: async () => ({ library: [], roles: [] }),
    createEmployee: async (_projectId, input) => ({
      id: "E-1",
      name: input.name,
      role_id: input.role_id,
    }),
    subscribe: () => () => {},
    activity: async () => ({
      cards: [{ id: card.id, title: card.title }],
      events: [],
      next_before: null,
      counts: { returned: 0, matched: 0 },
    }),
    snapshot: async () => ({
      cards: [],
      in_progress: [],
      in_review: [],
      blocked: [],
      waiting: { human: [], agent: [] },
      recent_deliveries: [],
    }),
    executionCapacity: async () => ({
      agents: [],
      merge_checks: [],
      merge_config_invalid: false,
    }),
    setRunLimit: async () => {},
    execution: async () => ({ assignments: [], runs: [], machines: [] }),
    // Pages the overridden execution view's Runs like the server does, so a
    // test that only fakes `execution` still sees the drawer's Run history.
    executionRuns: async (projectId, assignmentId, before) => {
      const all = (
        overrides.execution ? (await overrides.execution(projectId)).runs : []
      ).filter((run) => run.assignment_id === assignmentId);
      const start =
        before === undefined ? 0 : all.findIndex((r) => r.id === before) + 1;
      const runs = all.slice(start, start + 10);
      return {
        runs,
        total: all.length,
        next_cursor:
          start + runs.length < all.length ? (runs.at(-1)?.id ?? null) : null,
      };
    },
    preferences: async () => ({
      auto_merge_after_minutes: null,
      merge_gate_enabled: false,
      review_max_rounds_ceiling: 20,
    }),
    setPreferences: async () => {},
    setSystemRules: async () => {},
    setManualAssign: async () => {},
    templates: async () => ({ templates: [] }),
    template: async () => {
      throw new Error("Missing template fixture");
    },
    templateHistory: async () => ({ versions: [] }),
    validateTemplate: async () => ({ valid: true, reason: null }),
    manageTemplate: async () => {
      throw new Error("Missing template fixture");
    },
    markCardDone: async () => {},
    roles: async (project_id) => ({
      project_id,
      roles: [],
      default_roles: ["pm", "coder", "reviewer", "designer", "tester"],
      harnesses: ["claude-code", "codex", "pi"],
      allowlists: { produce: [], verify: [], standing: [] },
    }),
    role: async () => {
      throw new Error("role not stubbed");
    },
    roleHistory: async (project_id, role_id) => ({
      project_id,
      role_id,
      versions: [],
    }),
    copyRole: async () => {
      throw new Error("copyRole not stubbed");
    },
    updateRole: async () => {
      throw new Error("updateRole not stubbed");
    },
    setRoleActive: async () => {
      throw new Error("setRoleActive not stubbed");
    },
    rollbackRole: async () => {
      throw new Error("rollbackRole not stubbed");
    },
    setDelegation: async () => {},
    setCrossCardRead: async () => {},
    setAutoMerge: async () => {},
    setAutoMergePaused: async () => {},
    setPmMergeConfirmation: async () => {},
    setPmConfirmRoleRuleImplementations: async () => {},
    setPmConfirmHumanDecidedMerges: async () => {},
    setMergeConfirmSnoozeDefault: async () => {},
    setMergeConfirmSnoozeMax: async () => {},
    setMergeConfirmStallAfter: async () => {},
    setReviewMaxRounds: async () => {},
    setIndependentReviewLimitDelegation: async () => {},
    setBoardLane: async () => {},
    markNoticesRead: async () => {},
    decisionHistory: async () => ({ decisions: [], next_cursor: null }),
    needsYou: async () => ({ decisions: [], human_actions: [], incidents: [] }),
    notices: async () => ({ notices: [], next_cursor: null, unread_count: 0 }),
    recordDecision: async () => undefined,
    applySuggestion: async () => undefined,
    recheckMerge: async () => undefined,
    decisionComment: async () => undefined,
    cancelAction: async () => undefined,
    completeAction: async () => undefined,
    updateCard: async () => undefined,
    cancelCard: async () => undefined,
    supersedeCard: async () => undefined,
    setCardSensitive: async () => ({ changed: true, auto_merge_due_at: null }),
    session: loggedIn,
    login: async () => undefined,
    logout: async () => undefined,
    projects: async () => [project],
    cards: async (_projectId, filter) => ({
      project_id: "p-1",
      filter,
      cards: [card],
      counts: { total: 1, needs_me: 1, agent: 1 },
    }),
    card: async () => cardDetail(),
    addComment: async (projectId, cardId, input) => ({
      id: `${cardId}#99`,
      body: input.body,
      created_at: NOW,
      project_id: projectId,
    }),
    uploadAttachment: async (_projectId, _cardId, input) => ({
      id: input.attach_to.kind === "timeline_entry" ? "F-9" : "F-9",
    }),
    ...overrides,
  };
}
