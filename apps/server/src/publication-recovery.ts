import { withLongOperation } from "@cardigan/host";
import {
  continuePublication,
  interruptedPublication,
  type McpBackend,
  PublicationError,
  type PublicationOptions,
  type PublishInput,
} from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";

type Publisher = NonNullable<PublicationOptions["publishArtifact"]>;

/** Event types of one decision's publication, in the order they are written. */
const PUBLICATION_EVENTS = [
  "artifact_publication_requested",
  "artifact_publication_continued",
  "artifact_publication_claimed",
  "artifact_publication_resumed",
  "artifact_publication_failed",
  "artifact_publication_verified",
] as const;

/**
 * C-609: an artifact upload is a managed long operation the deployment waits
 * for. While the server shuts down, a failure is the shutdown's, not the
 * upload's: it is reported as `interrupted`, records no outcome, and the next
 * server continues it (`resumeInterruptedPublications`).
 */
export function trackedPublisher(
  store: Store,
  publish: Publisher,
): Publisher & { drain(): void } {
  let draining = false;
  const tracked: Publisher = async (
    project,
    attachment,
    request,
    claim,
    current,
  ) => {
    try {
      return await withLongOperation(
        store,
        {
          kind: "artifact_publication",
          project_id: project,
          card_id: attachment.card_id,
          label: "测试包外发",
        },
        () => publish(project, attachment, request, claim, current),
      );
    } catch (error) {
      if (draining) throw new PublicationError("interrupted");
      throw error;
    }
  };
  return Object.assign(tracked, {
    drain: () => {
      draining = true;
    },
  });
}

/**
 * C-609: after a restart, continue every approved publication whose run was
 * cut off without an outcome, one at a time, without waiting for its caller
 * to call again. Each continuation re-checks the original assignment's scope
 * and the approval, keeps the URL and artifact, never overwrites, and is
 * bounded (`MAX_PUBLICATION_CONTINUATIONS`). Never throws.
 */
export async function resumeInterruptedPublications(
  store: Store,
  publish: Publisher,
): Promise<number> {
  let rows: { project_id: string; card_id: string; doc: string }[];
  try {
    rows = store.uow.read(
      () =>
        store.database
          .prepare(
            `SELECT project_id, card_id, doc FROM events
            WHERE type IN (${PUBLICATION_EVENTS.map((t) => `'${t}'`).join(", ")})
            ORDER BY project_id, card_id, seq`,
          )
          .all() as unknown as {
          project_id: string;
          card_id: string;
          doc: string;
        }[],
    );
  } catch {
    return 0;
  }
  const decisions = new Map<
    string,
    {
      project: string;
      events: { type: string; actor: never }[];
      assignment?: string;
      request?: PublishInput;
    }
  >();
  for (const row of rows) {
    let event: {
      type: string;
      actor: { kind: string; assignment_id?: string };
      payload?: Partial<PublishInput>;
    };
    try {
      event = JSON.parse(row.doc);
    } catch {
      continue;
    }
    const decision = event.payload?.decision_id;
    if (typeof decision !== "string") continue;
    const key = JSON.stringify([row.project_id, row.card_id, decision]);
    const entry = decisions.get(key) ?? {
      project: row.project_id,
      events: [],
    };
    entry.events.push(event as never);
    if (
      event.type === "artifact_publication_requested" &&
      event.actor.kind === "assignment" &&
      event.actor.assignment_id
    ) {
      // The latest caller's scope is the one a continuation runs within.
      entry.assignment = event.actor.assignment_id;
      const { attachment_id, decision_id, version, versionCode } =
        event.payload ?? {};
      entry.request = {
        attachment_id,
        decision_id,
        version,
        versionCode,
      } as PublishInput;
    }
    decisions.set(key, entry);
  }
  let continued = 0;
  for (const entry of decisions.values()) {
    if (
      !entry.assignment ||
      !entry.request ||
      !interruptedPublication(entry.events)
    )
      continue;
    continued++;
    try {
      await continuePublication(
        { publishArtifact: publish },
        store as unknown as McpBackend,
        {
          project: entry.project as never,
          assignment: entry.assignment as never,
          request: entry.request,
        },
      );
    } catch {
      /* Audited on its card; a cut-off run is tried again next start. */
    }
  }
  return continued;
}
