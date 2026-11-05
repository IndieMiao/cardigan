import MarkdownIt from "markdown-it";

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
  if (/^https?:\/\//i.test(href)) {
    // An external page must not get a handle on this window.
    token?.attrSet("target", "_blank");
    token?.attrSet("rel", "noopener noreferrer");
  }
  return defaultLinkOpen(tokens, index, options, environment, self);
};

/** Render one body to HTML; the caller owns the container element. */
export function renderMarkdown(source: string): string {
  return markdown.render(source);
}
