import { attachmentRefMatches } from "@cardigan/domain";
import MarkdownIt from "markdown-it";
import {
  type AttachmentRefs,
  type AttachmentRefTarget,
  formatBytes,
} from "./attachment-refs.js";
import { idBadgeClass, idType } from "./id-types.js";

/**
 * Markdown rendering for Agent-written bodies (M5 plan §3.2, §3.7).
 *
 * Two rules make this safe to put in the page: `html: false` means raw HTML in
 * the body is escaped and never parsed, and `validateLink` drops any scheme but
 * `http`, `https` and same-origin paths — so `javascript:`, `data:` and `//evil`
 * links survive only as their visible text. The output is HTML produced by
 * markdown-it's own escaping, not the author's markup.
 */

const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: true,
});

/** Only `http(s)` URLs and in-site paths (`/…`, `#…`) are allowed. */
export function isAllowedLink(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();
  // Control characters (including newlines and tabs) are stripped by browsers
  // before the scheme is read, so reject them outright instead of guessing.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return false;
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    return true;
  }
  // A same-site path starts with a single slash; `//host` is another origin.
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return true;
  if (trimmed.startsWith("#")) return true;
  return false;
}

/**
 * Only absolute `http(s)` URLs. Used where a same-site path makes no sense — a
 * pull-request address comes from an Agent's delivery and must not become a
 * `javascript:` or `data:` link just because React happens to block it.
 */
export function isHttpLink(url: string): boolean {
  const trimmed = url.trim();
  if (!isAllowedLink(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  return lower.startsWith("http://") || lower.startsWith("https://");
}

markdown.validateLink = (url: string) => isAllowedLink(url);

const defaultLinkOpen =
  markdown.renderer.rules.link_open ??
  ((tokens, index, options, _environment, self) =>
    self.renderToken(tokens, index, options));

markdown.renderer.rules.link_open = (
  tokens,
  index,
  options,
  environment,
  self,
) => {
  const token = tokens[index];
  const href = String(token?.attrGet("href") ?? "");
  // Decorate an existing internal number link; never create or resolve one.
  // Only a single text label is eligible, so code/formatting stays untouched.
  const label = tokens[index + 1];
  if (
    href.startsWith("#/p/") &&
    label?.type === "text" &&
    tokens[index + 2]?.type === "link_close"
  ) {
    const match = /^(\S+)(?: (.+))?$/u.exec(label.content);
    const id = match?.[1] ?? "";
    // Keep the historical spelling visible, as linkifyReferences does.
    const canonical = id.replace(
      /^([qh])\(([1-9][0-9]*)\)$/u,
      (_, prefix, n) => `${prefix.toUpperCase()}-${n}`,
    );
    const type = idType(canonical);
    if (type) {
      token?.attrJoin("class", "id-tag");
      label.type = "id_reference";
      label.meta = { id, canonical, description: match?.[2] ?? type.label };
    }
  }
  if (/^https?:\/\//i.test(href)) {
    // An external page must not get a handle on this window.
    token?.attrSet("target", "_blank");
    token?.attrSet("rel", "noopener noreferrer");
  }
  return defaultLinkOpen(tokens, index, options, environment, self);
};

markdown.renderer.rules.id_reference = (tokens, index) => {
  const meta = tokens[index]?.meta;
  if (!meta) return "";
  const { id, canonical, description } = meta;
  if (
    typeof id !== "string" ||
    typeof canonical !== "string" ||
    typeof description !== "string"
  )
    return "";
  const escapeHtml = markdown.utils.escapeHtml;
  return `<span data-ui="id-badge" class="${idBadgeClass(canonical)}">${escapeHtml(id)}</span> <span class="id-description">${escapeHtml(description)}</span>`;
};

/** A column whose longest cell is longer than this many characters wraps. */
const WIDE_CELL = 8;

/**
 * Table cells for both Markdown renderers (this one and HelpMarkdown).
 *
 * markdown-it writes the column alignment (`:---`, `:---:`, `---:`) as an
 * inline `style`; cells keep only `data-align` instead, so theme.css owns the
 * look and no author-controlled style reaches the page. A column with a cell
 * longer than {@link WIDE_CELL} characters is marked `data-wide`: it wraps at a
 * minimum reading width, and every other column stays on one line, so a narrow
 * table never squeezes a column to one character per line.
 */
export function markdownTables(md: typeof markdown): void {
  md.core.ruler.push("table_cells", (state) => {
    let columns: ReturnType<typeof md.parse>[number][][] = [];
    let wide: boolean[] = [];
    let column = 0;
    state.tokens.forEach((token, index) => {
      if (token.type === "table_open") {
        columns = [];
        wide = [];
      } else if (token.type === "tr_open") {
        column = 0;
      } else if (token.type === "th_open" || token.type === "td_open") {
        const align = /^text-align:(left|center|right)$/u.exec(
          String(token.attrGet("style") ?? ""),
        )?.[1];
        token.attrs = null;
        if (align) token.attrSet("data-align", align);
        const cells = columns[column] ?? [];
        cells.push(token);
        columns[column] = cells;
        const text = (state.tokens[index + 1]?.children ?? [])
          .map((child) => child.content)
          .join("");
        if (Array.from(text).length > WIDE_CELL) wide[column] = true;
        column += 1;
      } else if (token.type === "table_close") {
        columns.forEach((cells, i) => {
          if (wide[i]) for (const cell of cells) cell.attrSet("data-wide", "");
        });
      }
    });
  });
}
markdown.use(markdownTables);

// Wide tables scroll inside their own box instead of widening the body.
markdown.renderer.rules.table_open = (tokens, index, options, _env, self) =>
  `<div class="ui-markdown-table">${self.renderToken(tokens, index, options)}`;
markdown.renderer.rules.table_close = (tokens, index, options, _env, self) =>
  `${self.renderToken(tokens, index, options)}</div>\n`;

/**
 * C-615: `attachment-123` in body text becomes a chip when `env.attachments`
 * knows it (the reader may see it); anything else stays text. Link labels and
 * code are left alone. Runs after `text_join`, so the number is one text token.
 */
markdown.core.ruler.push("attachment_refs", (state) => {
  const refs = (state.env as { attachments?: AttachmentRefs } | undefined)
    ?.attachments;
  if (!refs?.size) return;
  for (const block of state.tokens) {
    if (block.type !== "inline" || !block.children) continue;
    let links = 0;
    const children: typeof block.children = [];
    for (const token of block.children) {
      if (token.type === "link_open") links += 1;
      if (token.type === "link_close") links -= 1;
      if (token.type !== "text" || links > 0) {
        children.push(token);
        continue;
      }
      let last = 0;
      // The parser already split off code and links: all of it is prose.
      for (const match of attachmentRefMatches(token.content, {
        literals: false,
      })) {
        const target = refs.get(match.token);
        if (!target) continue;
        const at = match.start;
        if (at > last) {
          const text = new state.Token("text", "", 0);
          text.content = token.content.slice(last, at);
          children.push(text);
        }
        const chip = new state.Token("attachment_ref", "", 0);
        chip.meta = { target };
        children.push(chip);
        last = match.end;
      }
      if (last === 0) children.push(token);
      else if (last < token.content.length) {
        const text = new state.Token("text", "", 0);
        text.content = token.content.slice(last);
        children.push(text);
      }
    }
    block.children = children;
  }
});

const ICONS = {
  image:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  pdf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h2.5a1.5 1.5 0 0 1 0 3H8v-3zm0 3v2"/>',
  text: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  video:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>',
} as const;

/** The chip's markup; every value is escaped, `href` is a same-site path. */
export function attachmentChip(target: AttachmentRefTarget): string {
  const esc = markdown.utils.escapeHtml;
  const icon = `<svg class="ui-attachment-ref-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[target.kind]}</svg>`;
  const name = `<span class="ui-attachment-ref-name">${esc(target.name)}</span>`;
  const where = target.cardId ? ` · ${target.cardId}` : "";
  const href = target.href;
  if (href === undefined || !isAllowedLink(href) || !href.startsWith("/"))
    return `<span class="ui-attachment-ref" data-kind="${target.kind}" data-pending="" title="${esc(`${target.name} · 待上传 · ${formatBytes(target.size)}`)}">${icon}${name}</span>`;
  const title = esc(
    `${target.name} · ${target.id}${where} · ${formatBytes(target.size)}`,
  );
  const open =
    target.kind === "file"
      ? " download"
      : ' target="_blank" rel="noopener noreferrer"';
  const peek =
    target.kind === "image" && target.thumbnail?.startsWith("/")
      ? `<span class="ui-attachment-ref-peek ui-tip" aria-hidden="true"><img src="${esc(target.thumbnail)}" alt="" loading="lazy"></span>`
      : "";
  const preview =
    target.kind === "image" && target.preview?.startsWith("/")
      ? ` data-preview="${esc(target.preview)}"`
      : "";
  return `<a class="ui-attachment-ref" href="${esc(href)}" data-attachment-ref="${esc(target.id)}" data-kind="${target.kind}" data-mime="${esc(target.mime)}"${preview} title="${title}"${open}>${icon}${name}${peek}</a>`;
}

markdown.renderer.rules.attachment_ref = (tokens, index) => {
  const target = (
    tokens[index]?.meta as { target?: AttachmentRefTarget } | undefined
  )?.target;
  return target ? attachmentChip(target) : "";
};

/** Render one body to HTML; the caller owns the container element. */
export function renderMarkdown(
  source: string,
  options: { readonly attachments?: AttachmentRefs } = {},
): string {
  return markdown.render(
    source,
    options.attachments ? { attachments: options.attachments } : {},
  );
}

/** Long paragraph-only prose is secondary; structured or short content stays prominent. */
export function isLongPlainProse(text: string): boolean {
  if (Array.from(text.replace(/\s/gu, "")).length < 160) return false;
  const tokens = markdown.parse(text, {});
  return (
    tokens.length > 0 &&
    tokens.every(
      (token) =>
        ["paragraph_open", "paragraph_close", "inline"].includes(token.type) &&
        (token.children ?? []).every((child) =>
          ["text", "softbreak", "hardbreak"].includes(child.type),
        ),
    )
  );
}
