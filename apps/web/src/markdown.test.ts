/**
 * M5.3 XSS: Agent-written bodies (plan §3.2, §3.7).
 *
 * The rule the plan states is that a card's Markdown may never execute: raw
 * HTML is escaped and only `http`, `https` and in-site paths become links. These
 * tests feed hostile bodies through the renderer the app actually uses.
 */
import { expect, test } from "vitest";
import { isAllowedLink, renderMarkdown } from "./markdown.js";

test("raw HTML in a body is escaped, not parsed", () => {
  const html = renderMarkdown(
    'hello <img src=x onerror="alert(1)"> <script>alert(2)</script>',
  );
  expect(html).toContain("&lt;img");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<script>");
});

test("a javascript: link keeps its text and loses its href", () => {
  const html = renderMarkdown("[点我](javascript:alert(1))");
  // The whole construct stays literal text: no anchor, no href to click.
  expect(html).toContain("点我");
  expect(html).not.toMatch(/<a[^>]+href=/iu);
});

test("an encoded or obfuscated javascript: link is dropped as well", () => {
  for (const target of [
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    "javascript&#58;alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
  ]) {
    const html = renderMarkdown(`[x](${target})`);
    expect(html, target).not.toMatch(/href="(javascript|data):/iu);
  }
});

test("an image with a javascript: source is dropped", () => {
  const html = renderMarkdown("![alt](javascript:alert(1))");
  expect(html).not.toContain("<img");
  expect(html).toContain("alt");
});

test("http, https and in-site links are rendered, external ones hardened", () => {
  const external = renderMarkdown("[文档](https://example.com/doc)");
  expect(external).toContain('href="https://example.com/doc"');
  expect(external).toContain('target="_blank"');
  expect(external).toContain('rel="noopener noreferrer"');

  const internal = renderMarkdown("[卡片](/p/p-1/cards/C-1)");
  expect(internal).toContain('href="/p/p-1/cards/C-1"');
  expect(internal).not.toContain("target=");

  const anchor = renderMarkdown("[时间线](#timeline)");
  expect(anchor).toContain('href="#timeline"');
});

test("protocol-relative and file links are refused", () => {
  for (const target of [
    "//evil.example/x",
    "file:///etc/passwd",
    "ftp://x/y",
  ]) {
    expect(isAllowedLink(target), target).toBe(false);
    expect(renderMarkdown(`[x](${target})`), target).not.toContain("href=");
  }
  expect(isAllowedLink("http://127.0.0.1:7781/")).toBe(true);
  expect(isAllowedLink("/api/projects")).toBe(true);
});

test("ordinary Markdown still works", () => {
  const html = renderMarkdown("**粗**\n\n- 一\n- 二\n");
  expect(html).toContain("<strong>粗</strong>");
  expect(html).toContain("<li>一</li>");
});
