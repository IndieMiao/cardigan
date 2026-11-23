import type { Attachment, TimelineEntry } from "./entities.js";

/**
 * C-615: attachment numbers written in Markdown bodies.
 *
 * A body names an attachment by its plain number (`attachment-123`), as an
 * Agent writes it in `post_comment`. A Workbench comment may also name a file
 * it uploads itself as `attachment-new-N`: the N-th file the comment's author
 * uploaded to that comment (files are uploaded after the comment is accepted,
 * so they have no number yet). Reads resolve those to the real number.
 *
 * One rule for the comment box, the server and the renderer: a number is a
 * reference unless it touches an ASCII letter, digit, `_` or `-` (so `见
 * attachment-12` and `见attachment-12的` both count), and never inside code
 * (fenced, indented or inline) or a link destination / autolink, which stay
 * literal text.
 */
const REFERENCE =
  /(?<![A-Za-z0-9_-])attachment-(new-)?([1-9][0-9]*)(?![A-Za-z0-9_-])/gu;

export interface AttachmentRefMatch {
  readonly start: number;
  readonly end: number;
  /** The text matched: `attachment-12` or `attachment-new-1`. */
  readonly token: string;
  /** `attachment-new-N`: a file uploaded with the comment itself. */
  readonly pending: boolean;
  /** The 12 of `attachment-12`, the N of `attachment-new-N`. */
  readonly number: number;
}

/**
 * Every reference in a Markdown body, in order. `literals: false` treats the
 * whole text as prose: for a text run a Markdown parser already isolated.
 */
export function attachmentRefMatches(
  text: string,
  options: { readonly literals?: boolean } = {},
): AttachmentRefMatch[] {
  const literal = options.literals === false ? [] : markdownLiteralRanges(text);
  const matches: AttachmentRefMatch[] = [];
  for (const match of text.matchAll(REFERENCE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (literal.some(([from, to]) => start < to && end > from)) continue;
    matches.push({
      start,
      end,
      token: match[0],
      pending: match[1] !== undefined,
      number: Number(match[2]),
    });
  }
  return matches;
}

/** The attachment numbers a body names (not `attachment-new-N`), once each. */
export function attachmentReferenceIds(text: string): string[] {
  return [
    ...new Set(
      attachmentRefMatches(text)
        .filter((m) => !m.pending)
        .map((m) => m.token),
    ),
  ];
}

/** Replace references; `undefined` keeps the original text. */
export function replaceAttachmentRefs(
  text: string,
  replace: (match: AttachmentRefMatch) => string | undefined,
): string {
  let out = "";
  let last = 0;
  for (const match of attachmentRefMatches(text)) {
    out += text.slice(last, match.start) + (replace(match) ?? match.token);
    last = match.end;
  }
  return last === 0 ? text : out + text.slice(last);
}

/**
 * The body with every `attachment-new-N` replaced by the number the N-th
 * upload of the entry's author to this entry got (in number order, which is
 * upload order). An N not uploaded (yet) stays as written.
 */
export function resolvePendingAttachmentRefs(
  body: string,
  entry: Pick<TimelineEntry, "id" | "author" | "card_id">,
  attachments: readonly Pick<
    Attachment,
    "id" | "attach_to" | "uploaded_by" | "card_id"
  >[],
): string {
  if (!body.includes("attachment-new-")) return body;
  const own = entryUploads(entry, attachments);
  if (!own.length) return body;
  return replaceAttachmentRefs(body, (match) =>
    match.pending ? own[match.number - 1] : undefined,
  );
}

/** The ids the entry's author uploaded to the entry, in upload order. */
export function entryUploads(
  entry: Pick<TimelineEntry, "id" | "author" | "card_id">,
  attachments: readonly Pick<
    Attachment,
    "id" | "attach_to" | "uploaded_by" | "card_id"
  >[],
): string[] {
  return attachments
    .filter(
      (a) =>
        a.attach_to.kind === "timeline_entry" &&
        a.attach_to.id === entry.id &&
        (!a.card_id || a.card_id === entry.card_id) &&
        a.uploaded_by === entry.author,
    )
    .map((a) => ({
      id: a.id,
      n: Number(/^attachment-([1-9][0-9]*)$/u.exec(a.id)?.[1] ?? Number.NaN),
    }))
    .filter((a) => Number.isSafeInteger(a.n))
    .sort((a, b) => a.n - b.n)
    .map((a) => a.id);
}

/**
 * Where a Markdown body is literal: fenced and indented code blocks, inline
 * code spans, autolinks and inline link destinations. Approximates CommonMark
 * closely enough to agree with the renderer on what is prose.
 */
export function markdownLiteralRanges(
  text: string,
): (readonly [number, number])[] {
  const ranges: (readonly [number, number])[] = [];
  const prose: (readonly [number, number])[] = [];
  let fence: { readonly char: string; readonly length: number } | undefined;
  let fenceStart = 0;
  let blankBefore = true;
  let indented = false;
  let list = false;
  let proseStart = 0;
  let at = 0;
  while (at <= text.length) {
    const newline = text.indexOf("\n", at);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(at, end);
    const next = newline < 0 ? text.length + 1 : newline + 1;
    if (fence) {
      const close = /^ {0,3}(`+|~+)[ \t]*$/u.exec(line)?.[1];
      if (close?.[0] === fence.char && close.length >= fence.length) {
        ranges.push([fenceStart, end]);
        fence = undefined;
        proseStart = next;
        blankBefore = true;
      }
      at = next;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    const blank = line.trim() === "";
    if (
      open &&
      !(
        open[0] === "`" &&
        line.slice(line.indexOf(open) + open.length).includes("`")
      )
    ) {
      if (at > proseStart) prose.push([proseStart, at]);
      fence = { char: open[0] ?? "`", length: open.length };
      fenceStart = at;
      indented = false;
    } else if (
      !blank &&
      !list &&
      /^(?: {4}|\t)/u.test(line) &&
      (blankBefore || indented)
    ) {
      if (at > proseStart) prose.push([proseStart, at]);
      ranges.push([at, end]);
      proseStart = next;
      indented = true;
    } else if (!blank) {
      indented = false;
      // An indented line under a list item continues the item, not code.
      if (/^ {0,3}(?:[-*+]|[0-9]{1,9}[.)])(?:[ \t]|$)/u.test(line)) list = true;
      else if (blankBefore && !/^[ \t]/u.test(line)) list = false;
    }
    blankBefore = blank;
    at = next;
  }
  if (fence) ranges.push([fenceStart, text.length]);
  else if (proseStart < text.length) prose.push([proseStart, text.length]);
  for (const [from, to] of prose)
    ranges.push(...inlineLiterals(text, from, to));
  return ranges.sort((a, b) => a[0] - b[0]);
}

/** Code spans, then autolinks and link destinations outside them. */
function inlineLiterals(
  text: string,
  from: number,
  to: number,
): (readonly [number, number])[] {
  const ranges: (readonly [number, number])[] = [];
  const part = text.slice(from, to);
  const ticks = /`+/gu;
  let match = ticks.exec(part);
  while (match) {
    const open = match.index;
    let slashes = 0;
    while (part[open - 1 - slashes] === "\\") slashes += 1;
    if (slashes % 2 === 1) {
      ticks.lastIndex = open + 1;
      match = ticks.exec(part);
      continue;
    }
    const length = match[0].length;
    const closer = new RegExp(`(?<!\`)\`{${length}}(?!\`)`, "gu");
    closer.lastIndex = open + length;
    const close = closer.exec(part);
    if (close) {
      ranges.push([from + open, from + close.index + length]);
      ticks.lastIndex = close.index + length;
    }
    match = ticks.exec(part);
  }
  const inCode = (i: number) => ranges.some(([a, b]) => i >= a && i < b);
  const links = [
    // <https://…> autolinks
    /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/gu,
    // ](destination "title")
    /\]\(\s*(?:<[^>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/gu,
  ];
  const extra: (readonly [number, number])[] = [];
  for (const pattern of links)
    for (const link of part.matchAll(pattern)) {
      const start = from + (link.index ?? 0);
      if (!inCode(start)) extra.push([start, start + link[0].length]);
    }
  return [...ranges, ...extra];
}
