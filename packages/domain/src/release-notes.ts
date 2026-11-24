import type { Author, Card, Event } from "./entities.js";
import { eventsOfType } from "./event-index.js";
import type { CardId, DecisionId } from "./ids.js";

/**
 * C-712: release notes. One note per project and published version: the
 * user-facing "what's new" text PM writes for a test build it publishes
 * (`publish_artifact`). Every write is a `release_note_written` event on the
 * project stream; the note is folded from those events, so every revision
 * stays traceable. Notes never gate a publication or a merge.
 */
export const RELEASE_NOTE_EVENT = "release_note_written";
/** Body length ceiling in characters (configurable default). */
export const RELEASE_NOTE_MAX_LENGTH = 4000;
/** Without a previous publication, how many recently merged cards to list. */
export const RELEASE_NOTE_RECENT_CARDS = 20;
/** Most merged cards listed for one release; the rest are counted. */
export const RELEASE_NOTE_CARD_LIMIT = 100;
/** Same shape as `publish_artifact`'s version. */
export const RELEASE_NOTE_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u;
/** The sentence `publish_artifact` returns when the version has no note yet. */
export const RELEASE_NOTE_MISSING_HINT =
  "本版本还没有发版说明，可用 write_release_note 补写";

export type ReleaseNoteSource =
  | "write_release_note"
  | "publish_artifact"
  | "workbench";

/** Payload of one `release_note_written` event. */
export interface ReleaseNoteWritten {
  readonly version: string;
  readonly version_code: number | null;
  readonly decision_id: DecisionId | null;
  readonly body: string;
  readonly revision: number;
  readonly source: ReleaseNoteSource;
}

export interface ReleaseNoteRevision {
  readonly revision: number;
  readonly body: string;
  readonly author: Author;
  readonly at: string;
  readonly source: ReleaseNoteSource;
}

export interface ReleaseNote {
  readonly version: string;
  readonly version_code: number | null;
  /** The publication decision the note belongs to, once known. */
  readonly decision_id: DecisionId | null;
  readonly body: string;
  /** Author of the current revision. */
  readonly author: Author;
  readonly created_by: Author;
  readonly created_at: string;
  readonly updated_at: string;
  readonly revision: number;
}

/** One version on the release-note list: a note, a publication, or both. */
export interface ReleaseNoteEntry {
  readonly version: string;
  readonly version_code: number | null;
  readonly decision_id: DecisionId | null;
  /** Latest verified publication of this version; null while unpublished. */
  readonly published_at: string | null;
  readonly note: ReleaseNote | null;
}

export interface MergedCardRef {
  readonly id: CardId;
  readonly title: string;
  readonly merged_at: string;
}

/** Cards merged for a release, as reference for writing its note. */
export interface ReleaseMergedCards {
  /** `since_last_publication`, or `recent` when there is no earlier one. */
  readonly basis: "since_last_publication" | "recent";
  readonly since: {
    readonly version: string;
    readonly published_at: string;
  } | null;
  /** This version's own publication time, when it has one. */
  readonly until: string | null;
  readonly note: string;
  /** Newest merge first. */
  readonly cards: readonly MergedCardRef[];
  /** Cards in the range beyond those listed. */
  readonly omitted: number;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const authorOf = (event: Pick<Event, "actor">): Author =>
  event.actor.kind === "assignment"
    ? `assignment:${event.actor.assignment_id}`
    : event.actor.kind;

/** A body error message, or undefined when the body can be saved. */
export function releaseNoteBodyError(body: unknown): string | undefined {
  if (typeof body !== "string" || body.trim().length === 0)
    return "发版说明正文不能为空";
  if ([...body].length > RELEASE_NOTE_MAX_LENGTH)
    return `发版说明正文不能超过 ${RELEASE_NOTE_MAX_LENGTH} 字`;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(body))
    return "发版说明正文不能含控制字符";
  return undefined;
}

export function releaseNoteVersionError(version: unknown): string | undefined {
  return typeof version === "string" && RELEASE_NOTE_VERSION.test(version)
    ? undefined
    : "版本号格式无效";
}

function written(event: Event): ReleaseNoteWritten | undefined {
  const p = record(event.payload);
  if (
    typeof p.version !== "string" ||
    typeof p.body !== "string" ||
    typeof p.revision !== "number"
  )
    return undefined;
  return {
    version: p.version,
    version_code: typeof p.version_code === "number" ? p.version_code : null,
    decision_id:
      typeof p.decision_id === "string" ? (p.decision_id as DecisionId) : null,
    body: p.body,
    revision: p.revision,
    source:
      p.source === "publish_artifact" || p.source === "workbench"
        ? p.source
        : "write_release_note",
  };
}

/** Every revision of one version's note, oldest first. */
export function releaseNoteHistory(
  events: readonly Event[],
  version: string,
): readonly ReleaseNoteRevision[] {
  return eventsOfType(events, RELEASE_NOTE_EVENT).flatMap((e) => {
    const w = e.card_id ? undefined : written(e);
    return w && w.version === version
      ? [
          {
            revision: w.revision,
            body: w.body,
            author: authorOf(e),
            at: e.created_at,
            source: w.source,
          },
        ]
      : [];
  });
}

/** Current note per version, folded from the project stream in order. */
export function releaseNotes(
  events: readonly Event[],
): ReadonlyMap<string, ReleaseNote> {
  const notes = new Map<string, ReleaseNote>();
  for (const e of eventsOfType(events, RELEASE_NOTE_EVENT)) {
    if (e.card_id) continue;
    const w = written(e);
    if (!w) continue;
    const previous = notes.get(w.version);
    const author = authorOf(e);
    notes.set(w.version, {
      version: w.version,
      version_code: w.version_code ?? previous?.version_code ?? null,
      decision_id: w.decision_id ?? previous?.decision_id ?? null,
      body: w.body,
      author,
      created_by: previous?.created_by ?? author,
      created_at: previous?.created_at ?? e.created_at,
      updated_at: e.created_at,
      revision: w.revision,
    });
  }
  return notes;
}

export interface VerifiedPublication {
  readonly version: string;
  readonly version_code: number | null;
  readonly decision_id: DecisionId | null;
  readonly card_id: CardId | undefined;
  readonly at: string;
}

/** Verified publications in history order (`artifact_publication_verified`). */
export function verifiedPublications(
  events: readonly Event[],
): readonly VerifiedPublication[] {
  return eventsOfType(events, "artifact_publication_verified")
    .flatMap((e) => {
      const p = record(e.payload);
      if (typeof p.version !== "string") return [];
      return [
        {
          version: p.version,
          version_code:
            typeof p.versionCode === "number" ? p.versionCode : null,
          decision_id:
            typeof p.decision_id === "string"
              ? (p.decision_id as DecisionId)
              : null,
          card_id: e.card_id,
          at: e.created_at,
        },
      ];
    })
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

const timeKey = (entry: ReleaseNoteEntry) =>
  entry.published_at ?? entry.note?.created_at ?? "";

/**
 * Every version with a note or a verified publication, newest first: by the
 * latest publication time (or the note's creation while unpublished), then
 * version code, then version.
 */
export function releaseNoteEntries(
  events: readonly Event[],
): readonly ReleaseNoteEntry[] {
  const notes = releaseNotes(events);
  const published = new Map<string, VerifiedPublication>();
  for (const p of verifiedPublications(events)) published.set(p.version, p);
  const versions = new Set([...notes.keys(), ...published.keys()]);
  return [...versions]
    .map((version): ReleaseNoteEntry => {
      const note = notes.get(version) ?? null;
      const p = published.get(version);
      return {
        version,
        version_code: note?.version_code ?? p?.version_code ?? null,
        decision_id: note?.decision_id ?? p?.decision_id ?? null,
        published_at: p?.at ?? null,
        note,
      };
    })
    .sort(
      (a, b) =>
        timeKey(b).localeCompare(timeKey(a)) ||
        (b.version_code ?? -1) - (a.version_code ?? -1) ||
        b.version.localeCompare(a.version),
    );
}

/**
 * Cards merged since the previous successful publication of another version,
 * up to this version's own publication (or now while unpublished), by
 * `card_merged` time. Without a previous publication, the most recently
 * merged cards. Each card is listed once, at its latest merge in range.
 */
export function releaseMergedCards(
  state: { readonly events: readonly Event[]; readonly cards: readonly Card[] },
  version: string,
): ReleaseMergedCards {
  const publications = verifiedPublications(state.events);
  const own = publications.filter((p) => p.version === version).at(-1);
  const until = own?.at ?? null;
  const previous = publications
    .filter((p) => p.version !== version && (until === null || p.at < until))
    .at(-1);
  const titles = new Map(state.cards.map((c) => [c.id as string, c.title]));
  const latest = new Map<CardId, string>();
  for (const e of eventsOfType(state.events, "card_merged")) {
    if (!e.card_id || !titles.has(e.card_id)) continue;
    if (until !== null && e.created_at > until) continue;
    if (previous && e.created_at <= previous.at) continue;
    const seen = latest.get(e.card_id);
    if (!seen || e.created_at > seen) latest.set(e.card_id, e.created_at);
  }
  const merged = [...latest]
    .map(([id, merged_at]) => ({
      id,
      title: titles.get(id) ?? "",
      merged_at,
    }))
    .sort(
      (a, b) =>
        b.merged_at.localeCompare(a.merged_at) || b.id.localeCompare(a.id),
    );
  const limit = previous ? RELEASE_NOTE_CARD_LIMIT : RELEASE_NOTE_RECENT_CARDS;
  const cards = merged.slice(0, limit);
  return {
    basis: previous ? "since_last_publication" : "recent",
    since: previous
      ? { version: previous.version, published_at: previous.at }
      : null,
    until,
    note: previous
      ? `上次成功发布 ${previous.version} 以来合并的 ${merged.length} 张卡`
      : `没有更早的成功发布记录，列出最近合并的 ${cards.length} 张卡`,
    cards,
    omitted: previous ? merged.length - cards.length : 0,
  };
}
