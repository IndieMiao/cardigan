import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type Actor,
  type Clock,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  completeHumanAction,
  type DomainError,
  issueInstruction,
  parseId,
  parseTimelineEntryId,
  postComment,
  prepareAttachment,
  type ReadableIdKind,
  type Result,
  recordDecision,
  uploadAttachment,
} from "@cardigan/domain";
import {
  decodeAttachment,
  fileAttachmentStore,
  loadCommandState,
  MAX_ATTACHMENT_BASE64,
  MAX_MCP_BODY_BYTES,
  persistEffect,
  ToolError,
} from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";
import { z } from "zod";
import {
  HttpRejection,
  methodNotAllowed,
  readJsonBody,
  sendJson,
} from "./http.js";

const text = z
  .string()
  .refine((s) => s.trim().length > 0, "Text must not be blank");
const id = <K extends ReadableIdKind>(kind: K) =>
  z
    .string()
    .refine((s) => parseId(kind, s).ok, `Invalid ${kind} ID`)
    .transform((s) => must(parseId(kind, s)).id);
const entryId = z
  .string()
  .refine((s) => parseTimelineEntryId(s).ok)
  .transform((s) => must(parseTimelineEntryId(s)).id);
const comment = z.object({
  body: text,
  work_item_id: id("work_item").optional(),
  mentions: z.array(text).optional(),
  reply_to: entryId.optional(),
  supersedes: entryId.optional(),
});
const instruction = z.object({ body: text, work_item_id: id("work_item") });
const decision = z.object({
  option: text,
  rationale: z.string().optional(),
  raw_quote: z.string().optional(),
});
const clarification = z.object({
  action: z.enum(["request_information", "explain"]),
  body: text.optional(),
});
const action = z.object({ text, attachments: z.array(text).optional() });
const attachment = z.object({
  file: z.string().max(MAX_ATTACHMENT_BASE64),
  mime: text,
  kind: z.enum(["artifact", "evidence"]),
  attach_to: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("delivery"), id: id("delivery") }),
    z.object({ kind: z.literal("timeline_entry"), id: entryId }),
  ]),
  basis: id("decision").optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  supersedes: text.optional(),
});
// Zod's optional fields include undefined in their inferred value types; domain omits them.
function defined<T extends object>(
  input: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined),
  ) as { [K in keyof T]: Exclude<T[K], undefined> };
}
function parsed<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new HttpRejection(
      400,
      "validation_failed",
      "Invalid request parameters",
      result.error.issues,
    );
  return result.data;
}
function rejected(error: DomainError): never {
  const status =
    error.code === "not_found"
      ? 404
      : ["unauthorized", "forbidden_tool"].includes(error.code)
        ? 403
        : error.code === "validation_failed"
          ? 400
          : 409;
  throw new HttpRejection(status, error.code, error.message);
}
function must<T>(result: Result<T>): T {
  if (!result.ok) return rejected(result.error);
  return result.value;
}
export interface WriteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly store: Store;
  readonly project_id: string;
  readonly clock: Clock;
  readonly dataDir: string;
  /** Recheck the session after body/file IO and inside the command transaction. */
  readonly authorize: () => unknown;
}
/** One human command, one fresh project snapshot and one atomic effect; failures roll back. */
function run<T>(
  c: WriteContext,
  reduce: (
    s: CommandState,
    a: Actor,
    p: CommandPorts,
  ) => Result<CommandEffect<T>>,
): T {
  return c.store.uow.run((tx) => {
    c.authorize();
    const effect = must(
      reduce(
        loadCommandState(tx, c.project_id),
        { kind: "human", project_id: c.project_id },
        { clock: c.clock, ids: tx.ids },
      ),
    );
    persistEffect(tx, c.project_id, effect);
    return effect.data;
  });
}
const routes =
  /^\/(cards|decisions|human-actions)\/([^/]+)\/(comments|instructions|attachments|resolve|complete)$/u;
/** Returns false for read routes, leaving M5.1's handlers and method checks intact. */
export async function serveWrite(
  c: WriteContext,
  rest: string,
): Promise<boolean> {
  const match = routes.exec(rest);
  if (!match) return false;
  const [, group, encoded, operation] = match;
  let key: string;
  try {
    key = decodeURIComponent(encoded ?? "");
  } catch {
    throw new HttpRejection(
      400,
      "validation_failed",
      "Malformed identifier encoding",
    );
  }
  const supported =
    group === "cards"
      ? ["comments", "instructions", "attachments"]
      : group === "decisions"
        ? ["comments", "resolve"]
        : ["complete"];
  if (!supported.includes(operation ?? "")) return false;
  if (c.req.method !== "POST") methodNotAllowed(["POST"]);
  const body = await readJsonBody(
    c.req,
    operation === "attachments" ? MAX_MCP_BODY_BYTES : undefined,
  );
  c.authorize();
  let output: unknown;
  if (group === "cards") {
    const card_id = parsed(id("card"), key);
    if (operation === "comments") {
      const p = defined(parsed(comment, body));
      output = run(c, (s, a, ports) =>
        postComment(s, a, { ...p, card_id }, ports),
      );
    } else if (operation === "instructions") {
      const p = parsed(instruction, body);
      output = run(c, (s, a, ports) =>
        issueInstruction(s, a, { ...p, card_id }, ports),
      );
    } else {
      const { file, sha256, ...p } = defined(parsed(attachment, body));
      let decoded: ReturnType<typeof decodeAttachment>;
      try {
        decoded = decodeAttachment(file, sha256);
      } catch (error) {
        if (error instanceof ToolError) rejected(error.toDomainError());
        throw error;
      }
      const receipt = must(
        await prepareAttachment(
          decoded.digest,
          decoded.content,
          fileAttachmentStore(c.dataDir),
        ),
      );
      // Published content-addressed blobs remain on rejection: another upload may already share them.
      output = run(c, (s, a, ports) =>
        uploadAttachment(s, a, { ...p, card_id }, receipt, ports),
      );
    }
  } else if (group === "decisions") {
    const decision_id = parsed(id("decision"), key);
    if (operation === "resolve") {
      const p = parsed(decision, body),
        raw_quote = p.raw_quote?.trim()
          ? p.raw_quote
          : `在 Needs You 选择了 ${p.option}`;
      output = run(c, (s, a, ports) =>
        recordDecision(
          s,
          a,
          {
            decision_id,
            option: p.option,
            raw_quote,
            rationale: p.rationale?.trim() ? p.rationale : raw_quote,
          },
          ports,
        ),
      );
    } else {
      const p = parsed(clarification, body);
      output = run(c, (s, a, ports) => {
        const q = s.decisions.find((q) => q.id === decision_id);
        if (!q) throw new HttpRejection(404, "not_found", "Decision not found");
        if (!q.card_id)
          throw new HttpRejection(
            400,
            "validation_failed",
            "A project-level decision has no card timeline for comments",
          );
        const target =
          p.action === "explain"
            ? s.assignments.find(
                (x) =>
                  x.scope === "standing" &&
                  x.standing_mode === "office" &&
                  x.role_id === "pm" &&
                  x.status === "active",
              )?.id
            : q.raised_by.startsWith("assignment:")
              ? q.raised_by.slice(11)
              : undefined;
        if (!target)
          throw new HttpRejection(
            400,
            "validation_failed",
            "No Assignment is available for this clarification",
          );
        return postComment(
          s,
          a,
          {
            card_id: q.card_id,
            body:
              p.body ??
              (p.action === "explain"
                ? "请 PM 解释各选项的后果。"
                : "请补充这项决策所需的信息。"),
            refs: [{ kind: "decision", id: q.id }],
            mentions: [`@${target}`],
          },
          ports,
        );
      });
    }
  } else {
    const human_action_id = parsed(id("human_action"), key),
      p = defined(parsed(action, body));
    output = run(c, (s, a, ports) =>
      completeHumanAction(s, a, { ...p, human_action_id }, ports),
    );
  }
  sendJson(c.res, 200, output);
  return true;
}
