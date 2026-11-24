import {
  type CommandState,
  type ReleaseNote,
  releaseMergedCards,
  releaseNoteEntries,
  releaseNoteHistory,
  releaseNoteVersionError,
} from "@cardigan/domain";
import { HttpRejection } from "./http.js";
import { webAuthorView } from "./read.js";

const withAuthor = (state: CommandState, note: ReleaseNote | null) =>
  note
    ? {
        ...note,
        author_view: webAuthorView(state, note.author),
        created_by_view: webAuthorView(state, note.created_by),
      }
    : null;

/**
 * C-712: `GET /release-notes` lists every version with a note or a verified
 * publication, newest first (`note: null` when not written yet);
 * `?version=` adds that version's revisions and the cards merged for it.
 */
export function releaseNotesView(state: CommandState, url: URL) {
  const entries = releaseNoteEntries(state.events).map((entry) => ({
    ...entry,
    note: withAuthor(state, entry.note),
  }));
  const version = url.searchParams.get("version");
  if (version === null) return { entries };
  if (releaseNoteVersionError(version))
    throw new HttpRejection(400, "validation_failed", "版本号格式无效");
  return {
    entry: entries.find((e) => e.version === version) ?? null,
    history: releaseNoteHistory(state.events, version).map((r) => ({
      ...r,
      author_view: webAuthorView(state, r.author),
    })),
    merged_cards: releaseMergedCards(state, version),
  };
}
