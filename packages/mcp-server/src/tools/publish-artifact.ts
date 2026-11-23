import {
  type Attachment,
  approvesPublication,
  type CardId,
  cardReadAccess,
  type DecisionId,
  holdsPublicationTool,
  type TransactionContext,
} from "@cardigan/domain";
import { z } from "zod";
import type { McpReadContext } from "../backend.js";
import { ToolError } from "../errors.js";
import { defineTool, type ToolContext } from "./types.js";

const input = z
  .object({
    attachment_id: z.string().regex(/^attachment-[1-9][0-9]{0,15}$/u),
    decision_id: z.string().regex(/^Q-[1-9][0-9]{0,15}$/u),
    version: z
      .string()
      .max(80)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u),
    versionCode: z.number().int().positive().max(2100000000),
  })
  .strict();
export type PublishInput = z.infer<typeof input>;
export interface PublicationOptions {
  publishArtifact?: (
    project: string,
    a: Attachment,
    request: PublishInput,
    claim: (url: string) => void,
    current: () => void,
  ) => Promise<{ url: string; size: number; sha256: string }>;
}
/** Never put raw tool/SDK errors, paths or configuration into responses or audits. */
export class PublicationError extends Error {
  constructor(
    readonly category:
      | "not_enabled"
      | "scope"
      | "approval"
      | "already_claimed"
      | "retry_exhausted"
      | "configuration"
      | "artifact"
      | "signature"
      | "manifest"
      | "immutable_prefix"
      | "upload"
      | "download"
      | "host_error",
  ) {
    super(category);
  }
}
/** Host stages that fail before the first OSS write; the approval is not claimed by them. */
const BEFORE_WRITE = new Set<string>([
  "configuration",
  "artifact",
  "signature",
  "manifest",
  "immutable_prefix",
  "host_error",
]);
/** One original attempt plus one retry after fixing a failure that wrote nothing. */
export const PUBLICATION_ATTEMPTS = 2;
function attempts(
  tx: McpReadContext,
  p: string,
  card: CardId,
  decision: string,
) {
  let claimed = false,
    failed = 0;
  for (const e of tx.events.listAfter(p, card, 0)) {
    const payload = e.payload as { decision_id?: string; result?: string };
    if (payload?.decision_id !== decision) continue;
    if (e.type === "artifact_publication_claimed") claimed = true;
    if (
      e.type === "artifact_publication_failed" &&
      BEFORE_WRITE.has(payload.result ?? "")
    )
      failed++;
  }
  return { claimed, failed };
}
function audit(
  tx: TransactionContext,
  ctx: ToolContext,
  card: CardId,
  request: PublishInput,
  phase: "claimed" | "failed" | "verified",
  result: string,
  note = "",
) {
  const actor = ctx.identity.actor,
    p = actor.project_id,
    at = new Date().toISOString(),
    seq = tx.ids.nextEventSequence(p, card);
  tx.events.append(p, {
    id: tx.ids.nextEventId(),
    seq,
    card_id: card,
    type: `artifact_publication_${phase}`,
    actor,
    created_at: at,
    payload: { ...request, result },
  });
  const id = tx.ids.nextTimelineEntryId(p, card);
  tx.timeline.put(p, {
    id,
    short_id: id,
    card_id: card,
    event_seq: seq,
    type: "system",
    author: "system",
    body: `测试包外发 ${phase} · ${request.attachment_id} · ${request.decision_id} · ${result}${note}`,
    refs: [],
    mentions: [],
    retracted: false,
    created_at: at,
  });
}
export function publicationTool(options: PublicationOptions) {
  return defineTool({
    name: "publish_artifact",
    description:
      "Publish one signed test APK to this project's configured HTTPS destination. Requires a same-card resolved publish approval (option publish) targeting the full artifact_sha256 and attachment_id, with the publish option description exactly `发布到 <final HTTPS APK URL>`. Returns verified URL, size and SHA-256; never accepts credentials, commands or paths.",
    input,
    handler: async (request, ctx) => {
      const { actor, token } = ctx.identity,
        p = actor.project_id;
      let card: CardId | undefined;
      const authorized = (tx: McpReadContext) => {
        const owner = tx.assignments.get(p, actor.assignment_id),
          a = tx.attachments.get(p, request.attachment_id);
        if (
          !actor.allowed_tools.includes("publish_artifact") ||
          owner?.status !== "active" ||
          owner.role_id !== actor.role_id ||
          owner.role_version !== token.role_version ||
          !holdsPublicationTool(owner) ||
          !a
        )
          throw new PublicationError("scope");
        const work =
          owner.scope === "work_item"
            ? tx.work_items.get(p, owner.work_item_id)
            : undefined;
        if (
          (owner.scope === "work_item" && work?.card_id !== a.card_id) ||
          cardReadAccess({
            project_id: p,
            assignment: owner,
            card: tx.cards.get(p, a.card_id),
            work_items: work ? [work] : [],
          }) !== "full"
        )
          throw new PublicationError("scope");
        card = a.card_id;
        const q = tx.decisions.get(p, request.decision_id as DecisionId);
        if (
          !approvesPublication(
            p,
            a,
            q,
            tx.project_preferences?.get(p, p),
            q?.resolution?.via === "delegated"
              ? tx.events.listAfter(p, undefined, 0)
              : [],
          )
        )
          throw new PublicationError("approval");
        return a;
      };
      try {
        if (!ctx.revalidateToken) throw new PublicationError("scope");
        const revalidate = () => {
          try {
            ctx.revalidateToken?.();
          } catch {
            throw new PublicationError("scope");
          }
        };
        revalidate();
        const a = ctx.store.uow.read((tx) => {
          const a = authorized(tx),
            used = attempts(tx, p, a.card_id, request.decision_id);
          // Checked before any host IO; the claim below re-checks atomically.
          if (used.claimed) throw new PublicationError("already_claimed");
          if (used.failed >= PUBLICATION_ATTEMPTS)
            throw new PublicationError("retry_exhausted");
          return a;
        });
        if (!options.publishArtifact) throw new PublicationError("not_enabled");
        const fresh = (tx: McpReadContext) => {
          const now = authorized(tx);
          if (
            now.card_id !== a.card_id ||
            now.sha256 !== a.sha256 ||
            now.size !== a.size ||
            now.streamed_artifact?.expired
          )
            throw new PublicationError("artifact");
        };
        const claim = (url: string) => {
          revalidate();
          ctx.store.uow.run((tx) => {
            fresh(tx);
            const decision = tx.decisions.get(
              p,
              request.decision_id as DecisionId,
            );
            if (
              !decision?.options.some(
                (o) => o.key === "publish" && o.description === `发布到 ${url}`,
              )
            )
              throw new PublicationError("approval");
            if (attempts(tx, p, a.card_id, request.decision_id).claimed)
              throw new PublicationError("already_claimed");
            audit(
              tx,
              ctx,
              a.card_id,
              request,
              "claimed",
              `${url} · ${a.sha256}`,
            );
          });
        };
        const result = await options.publishArtifact(
          p,
          a,
          request,
          claim,
          () => {
            revalidate();
            ctx.store.uow.read(fresh);
          },
        );
        revalidate();
        ctx.store.uow.run((tx) => {
          fresh(tx);
          audit(
            tx,
            ctx,
            a.card_id,
            request,
            "verified",
            `${result.url} · ${result.size} bytes · SHA-256 ${result.sha256}`,
          );
        });
        return result;
      } catch (e) {
        const category =
          e instanceof PublicationError ? e.category : "host_error";
        let note = "";
        if (card) {
          const id = card;
          try {
            ctx.store.uow.run((tx) => {
              const before = BEFORE_WRITE.has(category)
                ? attempts(tx, p, id, request.decision_id)
                : undefined;
              if (before && !before.claimed) {
                const left = PUBLICATION_ATTEMPTS - before.failed - 1;
                note =
                  left > 0
                    ? `（未写入，修复后可用同一拍板重试 ${left} 次）`
                    : "（未写入，本拍板重试已用尽，请重新发起外发拍板）";
              }
              audit(tx, ctx, id, request, "failed", category, note);
            });
          } catch {
            throw new ToolError("validation_failed", "测试包外发审计不可用");
          }
        }
        throw new ToolError(
          category === "scope" ||
            category === "approval" ||
            category === "retry_exhausted"
            ? "forbidden_tool"
            : "validation_failed",
          `测试包外发未放行：${category}${note}`,
        );
      }
    },
  });
}
