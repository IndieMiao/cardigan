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
    /**
     * Durably claim the decision for `url`. `existing` (C-609): the prefix
     * already holds this release's objects, which is accepted only to
     * continue this decision's own interrupted claim for the same URL and
     * artifact; otherwise it throws.
     */
    claim: (url: string, existing?: boolean) => void,
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
function audit(
  tx: TransactionContext,
  ctx: ToolContext,
  card: CardId,
  request: PublishInput,
  phase: "claimed" | "resumed" | "failed" | "verified",
  result: string,
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
    body: `测试包外发 ${phase} · ${request.attachment_id} · ${request.decision_id} · ${result}`,
    refs: [],
    mentions: [],
    retracted: false,
    created_at: at,
  });
}
/**
 * C-609: decisions whose publication runs in this process. A claim with no
 * verified result that is not in flight here was cut off (e.g. by a server
 * restart) and may be continued under the same approval.
 */
const inFlight = new Set<string>();

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
      const flight = JSON.stringify([p, request.decision_id]);
      let flying = false;
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
        const a = ctx.store.uow.read(authorized);
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
        const claim = (url: string, existing = false) => {
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
            const mine = tx.events
              .listAfter(p, a.card_id, 0)
              .filter(
                (e) =>
                  (e.payload as { decision_id?: string })?.decision_id ===
                  request.decision_id,
              );
            const claimed = mine.find(
              (e) => e.type === "artifact_publication_claimed",
            );
            const target = `${url} · ${a.sha256}`;
            if (claimed) {
              // Continue only the same URL and artifact, never a verified or
              // running publication; the objects are re-verified, never
              // overwritten.
              if (
                (claimed.payload as { result?: string }).result !== target ||
                mine.some((e) => e.type === "artifact_publication_verified") ||
                inFlight.has(flight)
              )
                throw new PublicationError("already_claimed");
              audit(tx, ctx, a.card_id, request, "resumed", target);
            } else {
              if (existing) throw new PublicationError("immutable_prefix");
              audit(tx, ctx, a.card_id, request, "claimed", target);
            }
            inFlight.add(flight);
            flying = true;
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
        if (card) {
          const id = card;
          try {
            ctx.store.uow.run((tx) =>
              audit(tx, ctx, id, request, "failed", category),
            );
          } catch {
            throw new ToolError("validation_failed", "测试包外发审计不可用");
          }
        }
        throw new ToolError(
          category === "scope" || category === "approval"
            ? "forbidden_tool"
            : "validation_failed",
          `测试包外发未放行：${category}`,
        );
      } finally {
        if (flying) inFlight.delete(flight);
      }
    },
  });
}
