import {
  type Actor,
  assign,
  type Clock,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  createCard,
  createWorkItem,
  parseId,
  postComment,
  type Result,
  recordDecision,
  reportBlocker,
  requestDecision,
  requestHumanAction,
  states,
  type ToolName,
  updateCard,
  updateWorkItem,
} from "@cardigan/domain";
import { z } from "zod";
import { defineTool } from "../tools/types.js";
import { executeCommand } from "./execute.js";
import { entryId, id, idempotency_key } from "./schemas.js";

const text = z.string().min(1);
const subject = z.object({
  kind: z.enum(["git_head", "artifact_sha256", "doc_version"]),
  value: text,
});
const refs = z.array(
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("card"), id: id("card") }),
    z.object({ kind: z.literal("timeline_entry"), id: entryId }),
    z.object({ kind: z.literal("delivery"), id: id("delivery") }),
    z.object({ kind: z.literal("decision"), id: id("decision") }),
    z.object({ kind: z.literal("human_action"), id: id("human_action") }),
    z.object({ kind: z.literal("pr"), url: z.url() }),
  ]),
);
const viaAuthor = z
  .string()
  .refine(
    (s) =>
      s === "human" ||
      s === "system" ||
      (s.startsWith("assignment:") && parseId("assignment", s.slice(11)).ok),
    "Invalid author",
  );
const schemas = {
  post_comment: {
    card_id: id("card"),
    body: text,
    work_item_id: id("work_item").optional(),
    mentions: z.array(text).optional(),
    reply_to: entryId.optional(),
    refs: refs.optional(),
    supersedes: entryId.optional(),
  },
  report_blocker: {
    work_item_id: id("work_item"),
    reason: text,
    needs: z.enum(["role", "human"]),
  },
  request_decision: {
    card_id: id("card").optional(),
    kind: z.enum(["choose", "approve"]),
    category: z.enum([
      "general",
      "spending",
      "account",
      "permission",
      "data_deletion",
    ]),
    question: text,
    context: text,
    options: z
      .array(z.object({ key: text, description: text, impact: text }))
      .min(1),
    recommended: text,
    affected_cards: z.array(id("card")),
    affected_work_items: z.array(id("work_item")),
    blocking: z.boolean(),
    decider: z.union([z.literal("human"), z.string().regex(/^role:.+/u)]),
    target: z
      .union([z.object({ delivery_id: id("delivery") }), z.object({ subject })])
      .optional(),
  },
  record_decision: {
    decision_id: id("decision"),
    option: text,
    rationale: text,
    raw_quote: text,
    via_chain: z.array(viaAuthor).optional(),
    batch: text.optional(),
  },
  request_human_action: {
    card_id: id("card"),
    instructions: text,
    why_human: text,
    expected_return: text,
    blocked_work_items: z.array(id("work_item")),
    due: text.optional(),
  },
  create_card: {
    title: text,
    goal: text,
    acceptance_criteria: z.array(text).min(1),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("quote"), text }),
      z.object({ kind: z.literal("decision"), decision_id: id("decision") }),
    ]),
    repo: text,
    base_branch: text,
    out_of_scope: z.array(text).optional(),
    related_cards: z.array(id("card")).optional(),
    priority: z.number().optional(),
    deadline: text.optional(),
    template: text.optional(),
  },
  update_card: {
    card_id: id("card"),
    title: text.optional(),
    goal: text.optional(),
    acceptance_criteria: z.array(text).min(1).optional(),
    priority: z.number().optional(),
    status: z.enum(states.card).optional(),
  },
  create_work_item: {
    card_id: id("card"),
    title: text,
    kind: z.enum(["produce", "verify"]),
    role_id: text,
    required: z.boolean(),
    completion_criteria: z.array(text),
    depends_on: z.array(id("work_item")).optional(),
    target_work_item_id: id("work_item").optional(),
    max_review_rounds: z.number().int().positive().optional(),
  },
  update_work_item: {
    work_item_id: id("work_item"),
    title: text.optional(),
    completion_criteria: z.array(text).optional(),
    required: z.boolean().optional(),
    status: z.enum([...states.produce, ...states.verify]).optional(),
    max_review_rounds: z.number().int().positive().optional(),
  },
  assign: {
    work_item_id: id("work_item"),
    role_id: text,
    role_version: z.number().int().positive().optional(),
    machine_id: text.optional(),
  },
};

export function managementTools(clock?: Clock) {
  function wire<P, T>(
    name: keyof typeof schemas & ToolName,
    description: string,
    reduce: (
      s: CommandState,
      a: Actor,
      p: P,
      ports: CommandPorts,
    ) => Result<CommandEffect<T>>,
  ) {
    return defineTool({
      name,
      description,
      input: z.object({ ...schemas[name], idempotency_key }),
      handler: ({ idempotency_key, ...params }, context) =>
        executeCommand(
          context,
          name,
          idempotency_key,
          params as P,
          reduce,
          clock,
        ),
    });
  }
  return [
    wire("post_comment", "Post a comment and references.", postComment),
    wire("report_blocker", "Report a work item blocker.", reportBlocker),
    wire("request_decision", "Request a scoped decision.", requestDecision),
    wire(
      "record_decision",
      "Record a decision through PM Office.",
      recordDecision,
    ),
    wire(
      "request_human_action",
      "Request an action only a human can perform.",
      requestHumanAction,
    ),
    wire(
      "create_card",
      "Create a card from the development template.",
      createCard,
    ),
    wire("update_card", "Update card metadata or planning state.", updateCard),
    wire(
      "create_work_item",
      "Create a producing or verifying work item.",
      createWorkItem,
    ),
    wire(
      "update_work_item",
      "Update work item metadata or permitted resumption.",
      updateWorkItem,
    ),
    wire(
      "assign",
      "Assign work and return newly issued credentials once.",
      assign,
    ),
  ];
}
