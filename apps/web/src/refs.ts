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

/** A body reference plus the card the server says it belongs to. */
export type LinkableReference = Reference & { readonly card_id?: string };

/** Only the entries a link may point at: resolved and existing. */
export function linkableReferences(
  references: readonly ResolvedReference[],
): LinkableReference[] {
  return references.flatMap((reference) =>
    reference.exists
      ? [
          {
            kind: reference.kind,
            id: reference.id,
            ...(reference.card_id === undefined
              ? {}
              : { card_id: reference.card_id }),
          } as LinkableReference,
        ]
      : [],
  );
}

/**
 * Where a reference points, or `undefined` when it must stay text.
 *
 * Location anchors are card-route parameters, never `#fragment`s: the hash is
 * the route (M5.S S23). `cardId` is the card currently open, used when the
 * server did not attach one to the reference.
 */
export function referenceHref(
  reference: LinkableReference,
  projectId: string,
  cardId?: string,
): string | undefined {
  switch (reference.kind) {
    case "card":
      return routeHash({
        kind: "card",
        projectId,
        cardId: reference.id,
      });
    case "decision":
    case "human_action":
    case "delivery":
    case "timeline_entry": {
      const target = reference.card_id ?? cardId;
      if (target === undefined) return undefined;
      const anchor =
        reference.kind === "decision"
          ? `decision-${reference.id}`
          : reference.kind === "human_action"
            ? `human-action-${reference.id}`
            : reference.kind === "delivery"
              ? `delivery-${reference.id}`
              : `entry-${reference.id}`;
      return routeHash({
        kind: "card",
        projectId,
        cardId: target,
        anchor,
      });
    }
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
  refs: readonly LinkableReference[],
  projectId: string,
  cardId?: string,
): string {
  const replacements = refs.flatMap((reference) => {
    const href = referenceHref(reference, projectId, cardId);
    if (href === undefined || !("id" in reference)) return [];
    const token = new RegExp(
      `(?<![\\[\\w])${escapeRegExp(reference.id)}(?![\\]\\w])`,
      "gu",
    );
    const label = {
      card: "卡片",
      decision: "拍板",
      human_action: "待你执行",
      delivery: "交付",
      timeline_entry: "时间线条目",
    }[reference.kind];
    return [{ token, replacement: `[${reference.id} ${label}](${href})` }];
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
