import { createRoot } from "react-dom/client";
import { HelpMarkdown } from "../src/components/HelpMarkdown.js";

// Supported Markdown not yet used by the shipped help documents.
export function mountHelpProseFixture() {
  const sample = document.createElement("div");
  document.querySelector(".help-article")?.replaceChildren(sample);
  const text =
    "帮助正文应保持适合阅读的行宽，同时让宽表格和代码块完整展示。".repeat(12);
  const source = [
    "# 阅读宽度示例",
    text,
    `- ${text}`,
    `1. ${text}`,
    `> ${text}`,
    `\`\`\`\n${"long-code-".repeat(400)}\n\`\`\``,
  ].join("\n\n");
  createRoot(sample).render(<HelpMarkdown source={source} />);
}
