import {
  type Attachment,
  approvedReleaseChain,
  approvesPublication,
  type CardId,
  cardReadAccess,
  type DecisionId,
  holdsPublicationTool,
  RELEASE_CHAIN_OPTION,
  releaseChainUrl,
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
    /** `resume`: the prefix holds only this APK; skip its upload and only read back. */
    claim: (url: string, resume?: boolean) => void,
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
      | "in_progress"
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
/**
 * C-612: a failure before the first OSS write consumes nothing, so the same
 * approval is retried as often as needed after a fix. A claimed attempt that
 * ended without verification may be continued with the same approval: the
 * host only writes into an empty prefix or resumes one holding only this
 * release's own files (APK, SHA256SUMS, release.json), writing just the gaps.
 * Only a verified publication or a live attempt in this process refuses.
 */
function verified(
  tx: McpReadContext,
  p: string,
  card: CardId,
  decision: string,
) {
  return tx.events
    .listAfter(p, card, 0)
    .some(
      (e) =>
        e.type === "artifact_publication_verified" &&
        (e.payload as { decision_id?: string })?.decision_id === decision,
    );
}
/**
 * A release chain publishes one APK to one place: once it claimed a URL and
 * digest, it only continues that same receipt (C-612).
 */
function chainClaimedElsewhere(
  tx: McpReadContext,
  p: string,
  card: CardId,
  decision: string,
  receipt: string | undefined,
  sha256: string,
) {
  return tx.events.listAfter(p, card, 0).some((e) => {
    const payload = e.payload as { decision_id?: string; result?: string };
    return (
      e.type === "artifact_publication_claimed" &&
      payload?.decision_id === decision &&
      (receipt === undefined
        ? !payload.result?.endsWith(` · ${sha256}`)
        : payload.result !== receipt)
    );
  });
}
/**
 * One executor per approval and per APK: a second concurrent call for either
 * is refused, never queued.
 */
const running = new Set<string>();
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
      "Publish one signed test APK to this project's configured HTTPS destination. Approval is either a same-card resolved publish approval (option publish) targeting the full artifact_sha256 and attachment_id, with the publish option description exactly `发布到 <final HTTPS APK URL>`, or the card's approved release chain, which covers the signed APK the system bound from the signing receipt. A release chain is one publish approval for intake, signing, signed intake and publication: kind approve, target.subject artifact_sha256 = the unsigned APK digest, and one option `release_chain` described exactly `发布链 <40-hex source commit> 发布到 <https APK URL template>`, where the template may use `<version>` (versionName) and `<sha12>` (first 12 hex of the signed APK digest). Use the chain decision as the basis for the unsigned intake. A failure before any OSS write consumes nothing: fix it and call again with the same decision. After a failure once writing began, calling again with the same (or a new) approval resumes: the files this release already wrote are read back and verified, only the missing ones are written, and nothing is overwritten. Returns verified URL, size and SHA-256; never accepts credentials, commands or paths.",
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
            q?.resolution?.option === RELEASE_CHAIN_OPTION
              ? tx.events.listAfter(p, a.card_id, 0)
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
          const a = authorized(tx);
          // Checked before any host IO; the claim below re-checks atomically.
          if (verified(tx, p, a.card_id, request.decision_id))
            throw new PublicationError("already_claimed");
          if (
            tx.decisions.get(p, request.decision_id as DecisionId)?.resolution
              ?.option === RELEASE_CHAIN_OPTION &&
            chainClaimedElsewhere(
              tx,
              p,
              a.card_id,
              request.decision_id,
              undefined,
              a.sha256,
            )
          )
            throw new PublicationError("already_claimed");
          return a;
        });
        if (!options.publishArtifact) throw new PublicationError("not_enabled");
        const slot = `${p}/${request.decision_id}`,
          bytes = `${p}/sha256/${a.sha256}`;
        if (running.has(slot) || running.has(bytes)) {
          // Another executor holds this approval: refuse without an audit
          // row, so its own outcome stays the last word on the card.
          card = undefined;
          throw new PublicationError("in_progress");
        }
        running.add(slot);
        running.add(bytes);
        try {
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
          const claim = (url: string, resume = false) => {
            revalidate();
            ctx.store.uow.run((tx) => {
              fresh(tx);
              const decision = tx.decisions.get(
                p,
                request.decision_id as DecisionId,
              );
              const chain =
                decision?.resolution?.option === RELEASE_CHAIN_OPTION
                  ? approvedReleaseChain(
                      p,
                      decision,
                      tx.project_preferences?.get(p, p),
                      decision.resolution.via === "delegated"
                        ? tx.events.listAfter(p, undefined, 0)
                        : [],
                    )
                  : undefined;
              if (
                chain
                  ? releaseChainUrl(chain, request.version, a.sha256) !== url
                  : !decision?.options.some(
                      (o) =>
                        o.key === "publish" &&
                        o.description === `发布到 ${url}`,
                    )
              )
                throw new PublicationError("approval");
              if (verified(tx, p, a.card_id, request.decision_id))
                throw new PublicationError("already_claimed");
              const receipt = `${url} · ${a.sha256}`;
              if (
                chain &&
                chainClaimedElsewhere(
                  tx,
                  p,
                  a.card_id,
                  request.decision_id,
                  receipt,
                  a.sha256,
                )
              )
                throw new PublicationError("already_claimed");
              // Only this card's own earlier claim of the same URL and digest proves who wrote the existing files.
              if (
                resume &&
                !tx.events
                  .listAfter(p, a.card_id, 0)
                  .some(
                    (e) =>
                      e.type === "artifact_publication_claimed" &&
                      (e.payload as { result?: string })?.result === receipt,
                  )
              )
                throw new PublicationError("immutable_prefix");
              audit(
                tx,
                ctx,
                a.card_id,
                request,
                "claimed",
                receipt,
                resume
                  ? "（续做：目录中只有本次发布写入的文件，已有的只回读核验，只补写缺项）"
                  : "",
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
        } finally {
          running.delete(slot);
          running.delete(bytes);
        }
      } catch (e) {
        const category =
          e instanceof PublicationError ? e.category : "host_error";
        let note = "";
        if (card) {
          const id = card;
          try {
            note = BEFORE_WRITE.has(category)
              ? "（未写入，修复后可用同一授权直接重试）"
              : category === "upload" || category === "download"
                ? "（可能已写入部分对象，可用同一授权再次调用续做）"
                : "";
            ctx.store.uow.run((tx) =>
              audit(tx, ctx, id, request, "failed", category, note),
            );
          } catch {
            throw new ToolError("validation_failed", "测试包外发审计不可用");
          }
        }
        throw new ToolError(
          category === "scope" || category === "approval"
            ? "forbidden_tool"
            : "validation_failed",
          `测试包外发未放行：${category}${note}`,
        );
      }
    },
  });
}
