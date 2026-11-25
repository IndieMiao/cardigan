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

/**
 * A body reference plus the card the server says it belongs to. A full
 * number (`SEN-C-34`, C-674) also carries the project it names and its
 * project-scoped `local_id`; `id` stays the text as written.
 */
export type LinkableReference = Reference & {
  readonly card_id?: string;
  readonly project_id?: string;
  readonly local_id?: string;
};

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
            ...(reference.project_id === undefined
              ? {}
              : { project_id: reference.project_id }),
            ...(reference.local_id === undefined
              ? {}
              : { local_id: reference.local_id }),
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
  // C-674: a full number links into the project its code names; the open
  // card only stands in for a missing card within the same project.
  const foreign =
    reference.kind !== "pr" &&
    reference.project_id !== undefined &&
    reference.project_id !== projectId;
  if (reference.kind !== "pr" && reference.project_id !== undefined)
    projectId = reference.project_id;
  if (foreign) cardId = undefined;
  const id =
    reference.kind === "pr" ? "" : (reference.local_id ?? reference.id);
  switch (reference.kind) {
    case "card":
      return routeHash({
        kind: "card",
        projectId,
        cardId: id,
      });
    case "decision":
    case "human_action":
    case "delivery":
    case "timeline_entry": {
      const target = reference.card_id ?? cardId;
      if (target === undefined) return undefined;
      const anchor =
        reference.kind === "decision"
          ? `decision-${id}`
          : reference.kind === "human_action"
            ? `human-action-${id}`
            : reference.kind === "delivery"
              ? `delivery-${id}`
              : `entry-${id}`;
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

/** The pre-C-132 `q(n)` / `h(n)` spelling of a `Q-n` / `H-n` id. */
function legacySpelling(kind: string, id: string): string | undefined {
  const match = /^([QH])-([1-9][0-9]*)$/u.exec(id);
  if (!match) return undefined;
  if (kind === "decision" && match[1] === "Q") return `q(${match[2]})`;
  if (kind === "human_action" && match[1] === "H") return `h(${match[2]})`;
  return undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Existing Markdown links and code spans, which must not be rewritten. */
const PROTECTED =
  /(?<ticks>`+)[\s\S]*?\k<ticks>|~~~[\s\S]*?~~~|\[(?:\\.|[^\]\\])*\]\((?:\\.|[^()\\]|\([^()]*\))*\)/gu;

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
    const label = {
      card: "卡片",
      decision: "拍板",
      human_action: "待你执行",
      delivery: "交付",
      timeline_entry: "时间线条目",
    }[reference.kind];
    // C-132: old comments say `q(95)` / `h(16)`; the server resolves them to
    // `Q-95` / `H-16`, so the legacy spelling in the body links there too.
    const legacy = legacySpelling(reference.kind, reference.id);
    return [reference.id, ...(legacy === undefined ? [] : [legacy])].map(
      (text) => [text, `[${text} ${label}](${href})`] as const,
    );
  });
  if (replacements.length === 0) return body;

  const byId = new Map(replacements);
  const token = new RegExp(
    // `-` too: `C-34` inside `SEN-C-34` is another project's number (C-674).
    `(?<![\\[\\w/#-])(?:${[...byId.keys()]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join("|")})(?![\\]\\w#])`,
    "gu",
  );
  // One replacement pass over original text: generated hrefs are never scanned.
  const linkifyText = (text: string) =>
    text.replace(token, (id) => byId.get(id) ?? id);

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
