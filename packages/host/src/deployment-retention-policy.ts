import {
  type CommandState,
  categoryAuthorization,
  categoryDelegated,
  hostOpsPending,
} from "@cardigan/domain";

export interface RetentionPolicy {
  revision: number;
  releases: number;
  snapshots: number;
  daily_days: number;
  released_days: number;
  approval?: { sha256: string; pm_review: string; data_deletion: string };
}
export function parseRetention(raw: unknown): RetentionPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid retention policy");
  const { approval, ...values } = raw as Record<string, unknown>;
  const p = {
    revision: 1,
    releases: 5,
    snapshots: 5,
    daily_days: 7,
    released_days: 3,
  };
  for (const [key, value] of Object.entries(values)) {
    if (
      !Object.hasOwn(p, key) ||
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > 36500
    )
      throw new Error("Invalid retention setting");
    p[key as keyof typeof p] = value;
  }
  if (approval === undefined) return p;
  const a = approval as RetentionPolicy["approval"];
  if (
    !a ||
    Object.keys(a).sort().join() !== "data_deletion,pm_review,sha256" ||
    typeof a.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(a.sha256) ||
    ![a.pm_review, a.data_deletion].every(
      (id) => typeof id === "string" && /^Q-[1-9][0-9]*$/u.test(id),
    )
  )
    throw new Error("Invalid retention approval");
  return { ...p, approval: a };
}

/** Only released Assignments on the shared local target; unknown Run states are live. */
export function eligibleRuns(
  s: CommandState,
  days: number,
  now: number,
  target: string,
) {
  const blocked = new Set<string>(
    s.runs
      .filter((r) => !["completed", "failed", "cancelled"].includes(r.status))
      .map((r) => r.assignment_id),
  );
  const runOwner = new Map<string, string>(
    s.runs.map((r) => [r.id, r.assignment_id]),
  );
  const open = new Set<string>(
    s.human_actions.filter((h) => h.status === "open").map((h) => h.id),
  );
  const protectedWork = new Set(
    s.human_actions
      .filter((h) => open.has(h.id))
      .flatMap((h) => [
        ...h.blocked_work_items,
        ...(h.follow_up_work_items ?? []),
      ]),
  );
  for (const h of s.human_actions)
    if (open.has(h.id) && h.host_assignment_id)
      blocked.add(h.host_assignment_id);
  for (const e of s.events) {
    if (e.type !== "human_action_requested") continue;
    const p = e.payload as {
      human_action_id?: string;
      assignment_id?: string;
      run_id?: string;
      preparation_run_id?: string;
    };
    if (!p.human_action_id || !open.has(p.human_action_id)) continue;
    if (p.assignment_id) blocked.add(p.assignment_id);
    const owner = runOwner.get(p.run_id ?? p.preparation_run_id ?? "");
    if (owner) blocked.add(owner);
  }
  return new Map<string, number>(
    s.assignments
      .filter(
        (a) =>
          a.machine_id === "local" &&
          /^A-[1-9][0-9]*$/u.test(a.id) &&
          a.status === "released" &&
          Date.parse(a.released_at ?? "") < now - days * 86400000 &&
          (!a.runtime_ref?.target ||
            a.runtime_ref.target.fingerprint === target) &&
          !blocked.has(a.id) &&
          !hostOpsPending(s.events, a.id) &&
          (!a.work_item_id || !protectedWork.has(a.work_item_id)),
      )
      .map((a) => [a.id, Date.parse(a.released_at ?? "")]),
  );
}

/** Host config alone, a role comment, a rejected option or Q-970 cannot enable deletion. */
export function approved(
  s: CommandState,
  a: NonNullable<RetentionPolicy["approval"]>,
) {
  function bound(id: string) {
    const q = s.decisions.find(
      (q) =>
        q.id === id &&
        q.status === "resolved" &&
        q.kind === "approve" &&
        "subject" in q.target &&
        q.target.subject.kind === "artifact_sha256" &&
        q.target.subject.value === a.sha256,
    );
    if (
      !q?.card_id ||
      !s.attachments.some(
        (f) =>
          q.attachment_ids?.includes(f.id) &&
          f.card_id === q.card_id &&
          f.sha256 === a.sha256 &&
          !f.streamed_artifact?.expired,
      )
    )
      return;
    return q;
  }
  const pm = bound(a.pm_review),
    del = bound(a.data_deletion);
  const by = pm?.resolution?.resolved_by;
  if (
    !pm ||
    !del ||
    pm.card_id !== del.card_id ||
    !by?.startsWith("assignment:") ||
    !s.assignments.some(
      (x) => `assignment:${x.id}` === by && x.role_id === "pm",
    ) ||
    pm.resolution?.option !== "enable_retention" ||
    del.resolution?.option !== "enable_retention" ||
    del.category !== "data_deletion"
  )
    return false;
  if (del.resolution.resolved_by === "human") return true;
  const audit = categoryAuthorization(s.events, "data_deletion");
  return (
    del.resolution.via === "delegated" &&
    categoryDelegated(
      s.project_preferences?.find((p) => p.id === s.project_id),
      s.events,
      "data_deletion",
    ) &&
    del.resolution.proxy_authority ===
      `project:${s.project_id}/decision_delegation/data_deletion/event:${audit?.id}`
  );
}
