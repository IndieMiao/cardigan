import {
  categoryAuthorization,
  categoryDelegated,
} from "./decision-authorization.js";
import type { Attachment, Decision, Event } from "./entities.js";
import type { ProjectPreferences } from "./preferences.js";

export function holdsPublicationTool(a: {
  role_id: string;
  scope: string;
  standing_mode?: string | undefined;
}) {
  return (
    a.role_id === "release_ops" ||
    (a.role_id === "pm" &&
      a.scope === "standing" &&
      a.standing_mode === "office")
  );
}

/** Consent is for these bytes, not a general project preference, merge, or signature. */
export function approvesPublication(
  project: string,
  a: Attachment,
  q: Decision | undefined,
  preferences: ProjectPreferences | undefined,
  events: readonly Event[],
) {
  if (
    !q ||
    q.category !== "publish" ||
    q.trigger ||
    q.superseded_by ||
    q.status !== "resolved" ||
    q.resolution?.option !== "publish" ||
    q.card_id !== a.card_id ||
    q.attachment_ids?.length !== 1 ||
    q.attachment_ids[0] !== a.id ||
    q.kind !== "approve" ||
    !("subject" in q.target) ||
    q.target.subject.kind !== "artifact_sha256" ||
    q.target.subject.value !== a.sha256
  )
    return false;
  const r = q.resolution;
  if (r.resolved_by === "human" && r.via === "needs_you") return true;
  const grant = categoryAuthorization(events, "publish");
  return (
    !q.human_required_reason &&
    q.decider === "role:pm" &&
    r.via === "delegated" &&
    r.resolved_by.startsWith("assignment:") &&
    grant !== undefined &&
    preferences?.id === project &&
    categoryDelegated(preferences, events, "publish") &&
    r.proxy_authority ===
      `project:${project}/decision_delegation/publish/event:${grant.id}`
  );
}
