import type { RunId } from "@cardigan/domain";
import type { Identity } from "./auth.js";
import type { McpBackend } from "./backend.js";

/** A read of this token's own registration, not a tool call / Run ACK. */
export function runResourceState(
  store: McpBackend,
  identity: Identity,
  key: string,
  now: number,
  expiry = process.env.CARDIGAN_RUN_RESOURCE_MAX_AGE_SECONDS ?? "86400",
): "active" | "ended" | "expired_preview" | "unknown" {
  const parts =
    /^(A-[1-9]\d{0,15})\.(R-[1-9]\d{0,15})\.(R-[1-9]\d{0,15})$/u.exec(key);
  const { assignment, actor, token } = identity;
  if (
    !parts ||
    parts[1] !== assignment.id ||
    assignment.external ||
    !/^[1-9]\d*$/u.test(expiry) ||
    !Number.isSafeInteger(Number(expiry) * 1000)
  )
    return "unknown";
  return store.uow.read((tx) => {
    const session = tx.runs.get(actor.project_id, parts[2] as RunId);
    const task = tx.runs.get(actor.project_id, parts[3] as RunId);
    const generation = assignment.runtime_ref?.launch_generation;
    if (
      !session ||
      !task ||
      session.assignment_id !== assignment.id ||
      task.assignment_id !== assignment.id ||
      (generation && generation.run_id !== session.id) ||
      (session.launch_publication &&
        session.launch_publication.token_id !== token.id)
    )
      return "unknown";
    if (["dispatched", "acked", "running"].includes(task.status))
      return "active";
    const finished = Date.parse(task.finished_at ?? "");
    if (
      !["completed", "failed", "cancelled"].includes(task.status) ||
      !Number.isFinite(finished) ||
      finished > now
    )
      return "unknown";
    return now - finished > Number(expiry) * 1000 ? "expired_preview" : "ended";
  });
}

/** Invalid policy or unsynchronised clocks never authorise a read. */
export function freshResourceNonce(
  nonce: string,
  now = Date.now(),
  skew = process.env.CARDIGAN_RUN_RESOURCE_CLOCK_SKEW_SECONDS ?? "120",
) {
  return (
    /^[a-f0-9]{64}$/u.test(nonce) &&
    /^[1-9]\d*$/u.test(skew) &&
    Number.isSafeInteger(Number(skew) * 1000) &&
    Math.abs(now - Number.parseInt(nonce.slice(0, 16), 16)) <=
      Number(skew) * 1000
  );
}
