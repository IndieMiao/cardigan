import { z } from "zod";
import { ToolError } from "../errors.js";
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
  signMobile?: (scope: SigningScope, current: () => void) => Promise<unknown>;
}
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
export function mobileSigningTool(options: MobileSigningOptions) {
  return defineTool({
    name: "request_mobile_signature",
    description:
      "Request the one human-approved APK or iOS archive for the current Run. Returns a local receipt only; never publishes.",
    input: z.object({ platform: z.enum(["android", "ios"]) }).strict(),
    handler: async ({ platform }, ctx) => {
      if (!options.signMobile)
        throw new ToolError("illegal_transition", "移动签名未启用");
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
      try {
        const result = await options.signMobile(scope, current);
        current();
        return result;
      } catch {
        throw new ToolError(
          "illegal_transition",
          "签名未放行，请核对候选授权与签名审计",
        );
      }
    },
  });
}
