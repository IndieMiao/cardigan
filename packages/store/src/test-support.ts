import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Actor,
  Assignment,
  Card,
  CardId,
  Event,
  ProjectId,
  TimelineEntry,
  WorkItem,
} from "@cardigan/domain";
import { Store } from "./store.js";

/**
 * Test support: every test gets its own temporary directory, so databases never
 * touch a developer's `.data/` or each other.
 */
export function withTempStore<T>(run: (store: Store, dataDir: string) => T): T {
  const dataDir = mkdtempSync(join(tmpdir(), "cardigan-store-"));
  const store = Store.open({ dataDir });
  try {
    return run(store, dataDir);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

export const project_id = "p-fictional" as ProjectId;

const human: Actor = { kind: "human", project_id };

export function card(overrides: Partial<Card> = {}): Card {
  return {
    id: "C-1" as CardId,
    project_id,
    title: "Fictional card",
    goal: "Prove the store works",
    acceptance_criteria: ["tests pass"],
    source: { kind: "quote", text: "fictional request" },
    out_of_scope: [],
    related_cards: [],
    repo: "example/repo",
    base_branch: "main",
    priority: 1,
    status: "todo",
    template: "dev",
    created_by: "human",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "W-1" as WorkItem["id"],
    card_id: "C-1" as CardId,
    title: "Fictional work item",
    kind: "produce",
    role_id: "coder",
    required: true,
    depends_on: [],
    completion_criteria: [],
    status: "todo",
    ...overrides,
  } as WorkItem;
}

export function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    id: "A-1" as Assignment["id"],
    scope: "work_item",
    work_item_id: "W-1" as WorkItem["id"],
    role_id: "coder",
    role_version: 1,
    status: "active",
    runtime_state: "not_provisioned",
    machine_id: "local",
    runtime_ref: null,
    mcp_token_id: "tok_1",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Assignment;
}

export function event(
  overrides: Partial<Event> & { readonly seq: number },
): Event {
  return {
    id: `01J0000000000000000000000${String(overrides.seq).padStart(2, "0")}` as Event["id"],
    card_id: "C-1" as CardId,
    type: "comment_added",
    actor: human,
    payload: { fictional: true },
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function timelineEntry(
  overrides: Partial<TimelineEntry> & { readonly event_seq: number },
): TimelineEntry {
  const id = `C-1#${overrides.event_seq}` as TimelineEntry["id"];
  return {
    id,
    short_id: id,
    card_id: "C-1" as CardId,
    type: "comment",
    author: "human",
    refs: [],
    retracted: false,
    body: "fictional comment",
    mentions: [],
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
