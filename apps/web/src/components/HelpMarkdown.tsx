import MarkdownIt from "markdown-it";
import { createElement, Fragment, type ReactNode } from "react";
import { idType } from "../id-types.js";
import { isAllowedLink, markdownTables } from "../markdown.js";
import { STATUS_LABELS } from "../status.js";
import { StatusTag } from "./Foundation.js";
import { IdBadge, IdTag } from "./IdTag.js";

const markdown = new MarkdownIt({ html: false, linkify: false }).use(
  markdownTables,
);
type Token = ReturnType<typeof markdown.parse>[number];
markdown.validateLink = (url) => isAllowedLink(url) && !/\\|%5c/iu.test(url);

// Parser tags are allowlisted and attributes are selected below, never spread.
// Raw HTML remains text, including HTML that resembles an example component.
const tags = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "em",
  "strong",
  "s",
  "a",
]);

function renderTokens(tokens: readonly Token[], inLink = false): ReactNode[] {
  let index = 0;
  let headers: string[] = [];
  let column = 0;
  function level(linked: boolean): ReactNode[] {
    const children: ReactNode[] = [];
    while (index < tokens.length) {
      const key = index;
      const token = tokens[index++];
      if (!token) break;
      if (token.nesting === -1) break;
      let child: ReactNode;
      if (token.nesting === 1) {
        if (token.tag === "table") headers = [];
        if (token.tag === "tr") column = 0;
        if (token.tag === "th") headers.push(tokens[index]?.content ?? "");
        const cellLabel = token.tag === "td" ? headers[column++] : undefined;
        const nested = level(linked || token.tag === "a");
        const href = String(token.attrGet("href") ?? "");
        if (
          token.hidden ||
          !tags.has(token.tag) ||
          (token.tag === "a" && !markdown.validateLink(href))
        ) {
          child = nested;
        } else {
          const tag = /^h[1-6]$/u.test(token.tag)
            ? `h${Math.min(6, Number(token.tag[1]) + 1)}`
            : token.tag;
          child = createElement(
            tag,
            token.tag === "a"
              ? {
                  href,
                  ...(/^https?:\/\//iu.test(href)
                    ? { target: "_blank", rel: "noopener noreferrer" }
                    : {}),
                }
              : token.tag === "ol"
                ? { start: token.attrGet("start") ?? undefined }
                : token.tag === "td" || token.tag === "th"
                  ? {
                      "data-label": cellLabel,
                      "data-align": token.attrGet("data-align") ?? undefined,
                      "data-wide":
                        token.attrGet("data-wide") === null ? undefined : "",
                    }
                  : {},
            nested,
          );
          // Same table look as every other Markdown body; help keeps its
          // narrow-screen record layout.
          if (tag === "table")
            child = (
              <div className="ui-markdown-table" data-layout="stacked">
                {child}
              </div>
            );
        }
      } else if (token.type === "inline") {
        child = renderTokens(token.children ?? [], linked);
      } else if (token.type === "code_inline") {
        const status = token.content.startsWith("status:")
          ? token.content.slice(7)
          : "";
        child = idType(token.content) ? (
          linked ? (
            <IdBadge id={token.content} />
          ) : (
            <IdTag id={token.content} />
          )
        ) : Object.hasOwn(STATUS_LABELS, status) ? (
          <StatusTag status={status} />
        ) : (
          <code>{token.content}</code>
        );
      } else if (token.type === "fence" || token.type === "code_block") {
        child = (
          <pre>
            <code>{token.content}</code>
          </pre>
        );
      } else if (token.type === "hardbreak") {
        child = <br />;
      } else if (token.type === "softbreak") {
        child = "\n";
      } else if (token.type === "hr") {
        child = <hr />;
      } else {
        // Text, raw HTML and image alt text use React escaping. No HTML sink,
        // arbitrary props, image requests or dynamic component names.
        child = token.content;
      }
      children.push(<Fragment key={key}>{child}</Fragment>);
    }
    return children;
  }
  return level(inLink);
}

export function HelpMarkdown({ source }: { source: string }) {
  return (
    <div className="help-markdown">
      {renderTokens(markdown.parse(source, {}))}
    </div>
  );
}
