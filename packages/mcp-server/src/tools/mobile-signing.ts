import type { Readable } from "node:stream";
import type { AttachmentStore } from "@cardigan/domain";
import { z } from "zod";
import { ToolError } from "../errors.js";
import {
  type ChainCandidate,
  type ChainGrant,
  prepareReleaseChain,
  signedIntake,
} from "./release-chain-signing.js";
import { defineTool, type ToolContext } from "./types.js";

export interface SigningScope {
  project: string;
  worker_uid: number;
  machine: string;
  card: string;
  assignment: string;
  run: string;
  platform: "android" | "ios";
}
export interface MobileSigningOptions {
  openMobileArtifact?: (
    scope: SigningScope,
    id: string,
    current: () => void,
  ) => Promise<{ size: number; sha256: string; stream: Readable }>;
  signMobile?: (scope: SigningScope, current: () => void) => Promise<unknown>;
  /** C-612: register and approve this Run's release-chain candidate (idempotent). */
  chainSigning?: (
    scope: SigningScope,
    candidate: ChainCandidate,
    current: () => void,
  ) => Promise<ChainGrant>;
  readonly dataDir?: string;
  readonly attachmentStore?: AttachmentStore;
}
const signedReceipt = (
  r: unknown,
): r is { status: "signed"; request_id: string; sha256: string } =>
  typeof r === "object" &&
  r !== null &&
  (r as { status?: unknown }).status === "signed" &&
  typeof (r as { request_id?: unknown }).request_id === "string" &&
  typeof (r as { sha256?: unknown }).sha256 === "string";
const denied = () => new ToolError("unauthorized", "当前任务未获移动签名授权");

function signingScope(
  ctx: ToolContext,
  platform: SigningScope["platform"],
): SigningScope {
  ctx.revalidateToken?.();
  const { actor, token } = ctx.identity;
  if (!actor.allowed_tools.includes("request_mobile_signature")) throw denied();
  return ctx.store.uow.read((tx) => {
    const p = actor.project_id;
    const a = tx.assignments.get(p, actor.assignment_id);
    if (
      a?.status !== "active" ||
      a.scope !== "work_item" ||
      a.runtime_state !== "running" ||
      a.role_version !== token.role_version ||
      !a.runtime_ref ||
      a.runtime_ref.machine_id !== a.machine_id
    )
      throw denied();
    const w = tx.work_items.get(p, a.work_item_id);
    if (
      w?.kind !== "produce" ||
      w.assignment_id !== a.id ||
      w.status !== "in_progress" ||
      tx.cards.get(p, w.card_id)?.status !== "in_progress"
    )
      throw denied();
    const runs = tx.runs
      .list(p)
      .filter((r) => r.assignment_id === a.id && r.status === "running");
    const r = runs[0];
    if (
      runs.length !== 1 ||
      !r ||
      r.pending_finish ||
      r.dispatch_stop ||
      r.inactivity_stop ||
      r.role_version !== token.role_version ||
      r.launch_publication?.phase !== "started" ||
      !r.launch_publication.process ||
      !Number.isSafeInteger(r.launch_publication.process.uid) ||
      r.launch_publication.process.uid <= 0 ||
      a.runtime_ref.launch_generation?.run_id !== r.id ||
      a.runtime_ref.launch_generation.generation !==
        r.launch_publication.generation ||
      r.launch_publication.token_id !== token.id ||
      r.launch_publication.target.machine_id !== a.machine_id ||
      r.launch_publication.target.project_id !== p
    )
      throw denied();
    return {
      project: p,
      worker_uid: r.launch_publication.process.uid,
      machine: a.machine_id,
      card: w.card_id,
      assignment: a.id,
      run: r.id,
      platform,
    };
  });
}
export function mobileAccess(
  ctx: ToolContext,
  platform: SigningScope["platform"],
) {
  const scope = signingScope(ctx, platform);
  const current = () => {
    const fresh = signingScope(ctx, platform);
    if (
      fresh.run !== scope.run ||
      fresh.worker_uid !== scope.worker_uid ||
      fresh.machine !== scope.machine ||
      fresh.card !== scope.card
    )
      throw denied();
  };
  return { scope, current };
}
export function mobileSigningTool(options: MobileSigningOptions) {
  return defineTool({
    name: "request_mobile_signature",
    description:
      "Request the one approved APK or iOS archive for the current Run. Approval is the operator's per-candidate approval or, for an Android test package, the card's approved release chain: the chain's unsigned package stored on this card is registered and approved automatically for this Run, and once signed the signed APK is stored on the card by the server (release_chain.signed_attachment_id, digest computed by the server; no download, re-upload or read-back needed; signed_intake=retry means call again). Call this tool directly, not through a shell or HTTP client. It returns within seconds: status=queued (not yet claimed, no request_id), pending (claimed under request_id, with phase), unconfirmed (claimed, the attempt ended without a result, e.g. a server restart; the next call continues the same request_id), or signed (a receipt re-validated against the ledger, with a read-only download for this Run). Keep this Run open and call again with the same platform about every poll_after_seconds. Repeated calls never sign twice: an input transfer cut off before dispatch is resent under the same request_id, a dispatched request is only looked up. An error means the request was refused before any claim: stop and report. Never publishes.",
    input: z.object({ platform: z.enum(["android", "ios"]) }).strict(),
    handler: async ({ platform }, ctx) => {
      if (!options.signMobile)
        throw new ToolError("illegal_transition", "移动签名未启用");
      const { scope, current } = mobileAccess(ctx, platform);
      const chain = await prepareReleaseChain(options, ctx, scope, current);
      let result: unknown;
      try {
        result = await options.signMobile(scope, current);
        current();
      } catch {
        throw new ToolError(
          "illegal_transition",
          "签名未放行，请核对候选授权与签名审计",
        );
      }
      if (
        !chain ||
        !signedReceipt(result) ||
        result.request_id !== chain.request_id
      )
        return result;
      return {
        ...result,
        release_chain: await signedIntake(
          options,
          ctx,
          scope,
          current,
          chain,
          result,
        ),
      };
    },
  });
}
