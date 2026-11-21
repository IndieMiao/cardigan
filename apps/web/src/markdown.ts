import MarkdownIt from "markdown-it";
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

/** Render one body to HTML; the caller owns the container element. */
export function renderMarkdown(source: string): string {
  return markdown.render(source);
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
