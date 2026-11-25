import type { Actor } from "../entities.js";
import { appendEvents } from "../event-index.js";
import type { DecisionId } from "../ids.js";
import { parseId } from "../ids.js";
import {
  RELEASE_NOTE_EVENT,
  type ReleaseMergedCards,
  type ReleaseNote,
  type ReleaseNoteEntry,
  type ReleaseNoteRevision,
  type ReleaseNoteSource,
  type ReleaseNoteWritten,
  releaseMergedCards,
  releaseNoteBodyError,
  releaseNoteEntries,
  releaseNoteHistory,
  releaseNotes,
  releaseNoteVersionError,
  verifiedPublications,
} from "../release-notes.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";

export interface WriteReleaseNoteInput {
  readonly version: string;
  readonly body: string;
  /** Publication decision of this version; inferred from its publication. */
  readonly decision_id?: string | undefined;
  /** Must match the version's publication when given. */
  readonly version_code?: number | undefined;
  /** Revision the writer edited (0 for a new note); a mismatch is rejected. */
  readonly base_revision?: number | undefined;
}

export interface WriteReleaseNoteResult {
  readonly note: ReleaseNote;
  /** False when the body and links were already exactly this. */
  readonly changed: boolean;
  readonly merged_cards: ReleaseMergedCards;
}

/**
 * C-712: create or revise one version's release note (PM or the human).
 * `publish_artifact` reuses it for its optional note, authorized by holding
 * the publication tool and only for the version it has just verified.
 */
export function writeReleaseNote(
  state: CommandState,
  actor: Actor,
  input: WriteReleaseNoteInput,
  ports: CommandPorts,
  via: "write_release_note" | "publish_artifact" = "write_release_note",
) {
  return command(state, actor, via, ports, (d): WriteReleaseNoteResult => {
    const publications = verifiedPublications(d.state.events).filter(
      (p) => p.version === input.version,
    );
    if (via === "write_release_note") {
      d.pm();
      d.projectAccess();
    } else
      ensure(
        actor.kind === "assignment" &&
          publications.some((p) => p.decision_id === input.decision_id),
        "forbidden_tool",
        "发布时附带的发版说明只能写给刚发布的版本",
      );
    const versionError = releaseNoteVersionError(input.version);
    ensure(!versionError, "validation_failed", versionError ?? "");
    // Notes belong to versions this project has actually published.
    ensure(
      publications.length > 0,
      "validation_failed",
      "这个版本还没有成功发布，发布后再写发版说明（也可在 publish_artifact 时附带）",
    );
    const bodyError = releaseNoteBodyError(input.body);
    ensure(!bodyError, "validation_failed", bodyError ?? "");
    ensure(
      input.version_code === undefined ||
        (Number.isSafeInteger(input.version_code) && input.version_code > 0),
      "validation_failed",
      "versionCode 必须是正整数",
    );
    const current = releaseNotes(d.state.events).get(input.version);
    ensure(
      input.base_revision === undefined ||
        input.base_revision === (current?.revision ?? 0),
      "stale_target",
      current
        ? `发版说明已被改为第 ${current.revision} 版，请刷新后再改`
        : "这个版本还没有发版说明，请刷新后再写",
    );
    const linked = (id: DecisionId | null) =>
      publications.some((p) => p.decision_id === id);
    // An inherited link that no publication of this version confirms follows
    // the version's latest publication.
    let decision_id: DecisionId | null =
      current?.decision_id && linked(current.decision_id)
        ? current.decision_id
        : null;
    if (input.decision_id !== undefined) {
      const parsed = parseId("decision", input.decision_id);
      ensure(parsed.ok, "validation_failed", "发布拍板编号无效");
      const q = d.get("decisions", parsed.value.id);
      ensure(
        q.category === "publish",
        "validation_failed",
        "关联的拍板必须是发布拍板",
      );
      ensure(
        linked(q.id),
        "validation_failed",
        "关联的拍板与这个版本的发布记录不一致",
      );
      decision_id = q.id;
    } else if (decision_id === null)
      decision_id = publications.at(-1)?.decision_id ?? null;
    const published = publications.find((p) => p.decision_id === decision_id);
    const version_code =
      published?.version_code ?? publications.at(-1)?.version_code ?? null;
    ensure(
      input.version_code === undefined || input.version_code === version_code,
      "validation_failed",
      "versionCode 与这个版本的发布记录不一致",
    );
    const source: ReleaseNoteSource =
      via === "publish_artifact"
        ? "publish_artifact"
        : actor.kind === "human"
          ? "workbench"
          : "write_release_note";
    const changed =
      !current ||
      current.body !== input.body ||
      current.decision_id !== decision_id ||
      current.version_code !== version_code;
    if (changed) {
      const payload: ReleaseNoteWritten = {
        version: input.version,
        version_code,
        decision_id,
        body: input.body,
        revision: (current?.revision ?? 0) + 1,
        source,
      };
      d.emit(RELEASE_NOTE_EVENT, undefined, { ...payload });
    }
    const note = releaseNotes(appendEvents(d.state.events, d.events)).get(
      input.version,
    );
    ensure(note, "invariant_violation", "发版说明写入失败");
    return {
      note,
      changed,
      merged_cards: releaseMergedCards(d.state, input.version),
    };
  });
}

export interface ReleaseNoteQuery {
  /** One version with its full revision history. */
  readonly version?: string;
}

export type ReleaseNoteListing =
  | { readonly entries: readonly ReleaseNoteEntry[] }
  | {
      readonly entry: ReleaseNoteEntry | null;
      readonly history: readonly ReleaseNoteRevision[];
      readonly merged_cards: ReleaseMergedCards;
    };

/** Read-only listing for PM (`list_release_notes`) and the Workbench. */
export function listReleaseNotes(
  state: CommandState,
  actor: Actor,
  query: ReleaseNoteQuery = {},
) {
  return command(
    state,
    actor,
    "list_release_notes",
    undefined,
    (d): ReleaseNoteListing => {
      d.pm();
      d.projectAccess();
      const entries = releaseNoteEntries(state.events);
      if (query.version === undefined) return { entries };
      const versionError = releaseNoteVersionError(query.version);
      ensure(!versionError, "validation_failed", versionError ?? "");
      return {
        entry: entries.find((e) => e.version === query.version) ?? null,
        history: releaseNoteHistory(state.events, query.version),
        merged_cards: releaseMergedCards(state, query.version),
      };
    },
  );
}
