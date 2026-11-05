import type { Reference, ResolvedReference } from "./api.js";
import { isHttpLink } from "./markdown.js";
import { routeHash } from "./route.js";

/**
 * Number links (M5 plan §3.4).
 *
 * The frontend never guesses what `C-12` or `D-3` means: it only links the
 * identifiers the server resolved for the body. The server's `references` carry
 * `exists`, so a comment that mentions `C-999999` keeps that number as plain
 * text instead of offering a dead link.
 */

/** Only the entries a link may point at: resolved and existing. */
export function linkableReferences(
  references: readonly ResolvedReference[],
): Reference[] {
  return references.flatMap((reference) =>
    reference.exists
      ? [{ kind: reference.kind, id: reference.id } as Reference]
      : [],
  );
}

/** Where a reference points, or `undefined` when it must stay text. */
export function referenceHref(
  reference: Reference,
  projectId: string,
): string | undefined {
  switch (reference.kind) {
    case "card":
      return routeHash({
        kind: "card",
        projectId,
        cardId: reference.id,
      });
    case "decision":
      return `#decision-${reference.id}`;
    case "human_action":
      return `#human-action-${reference.id}`;
    case "delivery":
      return `#delivery-${reference.id}`;
    case "timeline_entry":
      return `#entry-${reference.id}`;
    case "pr":
      // Only an http(s) address becomes a link; anything else stays text.
      return isHttpLink(reference.url) ? reference.url : undefined;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Existing Markdown links and code spans, which must not be rewritten. */
const PROTECTED = /\[[^\]]*\]\([^)]*\)|`[^`]*`/gu;

/**
 * Rewrite the identifiers of `refs` in `body` as Markdown links, in place.
 *
 * Existing links and inline code keep their text, so running this twice cannot
 * nest links, and an id that is part of a longer word (`ABC-1`) is left alone.
 */
export function linkifyReferences(
  body: string,
  refs: readonly Reference[],
  projectId: string,
): string {
  const replacements = refs.flatMap((reference) => {
    const href = referenceHref(reference, projectId);
    if (href === undefined || !("id" in reference)) return [];
    const token = new RegExp(
      `(?<![\\[\\w])${escapeRegExp(reference.id)}(?![\\]\\w])`,
      "gu",
    );
    return [{ token, replacement: `[${reference.id}](${href})` }];
  });
  if (replacements.length === 0) return body;

  const linkifyText = (text: string): string =>
    replacements.reduce(
      (current, { token, replacement }) => current.replace(token, replacement),
      text,
    );

  let result = "";
  let last = 0;
  for (const match of body.matchAll(PROTECTED)) {
    const start = match.index ?? 0;
    result += linkifyText(body.slice(last, start));
    result += match[0];
    last = start + match[0].length;
  }
  return result + linkifyText(body.slice(last));
}
