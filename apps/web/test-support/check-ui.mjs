import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const src = resolve(root, "apps/web/src");
async function files(dir) {
  return (
    await Promise.all(
      (
        await readdir(dir, { withFileTypes: true })
      ).map((entry) =>
        entry.isDirectory()
          ? files(resolve(dir, entry.name))
          : [resolve(dir, entry.name)],
      ),
    )
  ).flat();
}
const allowedCss = new Set([
  "styles.css",
  "components/ui/theme.css",
  "components/CardLegend.css",
  "components/TemplateMarker.css",
]);
const protectedFiles = new Set([
  "views/CardListPage.tsx",
  "components/Board.tsx",
  "components/BoardCard.tsx",
  "components/FilterBar.tsx",
  "components/Foundation.tsx",
  "components/Drawer.tsx",
  "components/Capacity.tsx",
  "components/Menu.tsx",
  "components/MultiSelect.tsx",
  "components/PageSizeMenu.tsx",
  "components/GroupedTableBody.tsx",
  "components/ViewSwitch.tsx",
]);
export function findings(path, source) {
  const sf = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    ),
    found = [];
  const add = (kind, node) => {
    const text = node.getText(sf).replace(/\s+/g, " ").trim();
    found.push({
      path,
      kind,
      hash: createHash("sha256").update(text).digest("hex").slice(0, 16),
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      text: text.slice(0, 160),
    });
  };
  const ui = path.startsWith("components/ui/"),
    layout = path.startsWith("components/layout/");
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.startsWith("@radix-ui/") &&
      !ui
    )
      add("direct-radix", node);
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      if (
        !ui &&
        !layout &&
        ["select", "button", "input", "style"].includes(tag)
      )
        add(`native-${tag}`, node);
      if (!ui && !layout)
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr)) continue;
          const key = attr.name.getText(sf),
            text = attr.initializer?.getText(sf) ?? "";
          if (
            key === "style" &&
            (!text.startsWith("{{") ||
              /\b(?:width|height|minWidth|maxWidth|minHeight|maxHeight|padding\w*|margin\w*|borderRadius|fontSize|lineHeight|gap|top|bottom|left|right|inset)\s*:/.test(
                text,
              ))
          )
            add("inline-size", attr);
          if (
            key === "className" &&
            /(?:["'`\s])(?:h|w|size|min-h|max-h|min-w|max-w|rounded|bg|text)-(?:\[|\d|red-|blue-|gray-|neutral-)/.test(
              text,
            )
          )
            add("page-token-override", attr);
        }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}
export async function checkUi({ inventory = false } = {}) {
  const found = [],
    failures = [];
  for (const file of await files(src)) {
    const path = relative(src, file);
    if (path.endsWith(".css") && !allowedCss.has(path))
      failures.push(`${path}: extra stylesheet is forbidden`);
    if (
      !path.endsWith(".tsx") ||
      path.includes(".test.") ||
      path.startsWith("testing/")
    )
      continue;
    found.push(...findings(path, await readFile(file, "utf8")));
  }
  if (inventory) return found;
  const baseline = JSON.parse(
    await readFile(
      resolve(root, "apps/web/test-support/ui-legacy.json"),
      "utf8",
    ),
  );
  const key = (f) => `${f.path}:${f.kind}:${f.hash}`;
  const remaining = new Map(baseline.map((f) => [key(f), f.count]));
  for (const f of found) {
    const k = key(f),
      count = remaining.get(k) ?? 0;
    if (
      f.kind === "native-select" ||
      f.kind === "direct-radix" ||
      protectedFiles.has(f.path) ||
      count === 0
    )
      failures.push(
        `${f.path}:${f.line} ${f.kind}: use components/ui or layout (${f.text})`,
      );
    else remaining.set(k, count - 1);
  }
  for (const [k, count] of remaining)
    if (count > 0)
      failures.push(`${k}: remove ${count} obsolete legacy exemption(s)`);
  if (failures.length) throw new Error(failures.join("\n"));
  console.log(
    `UI boundary: passed; ${found.length} exact legacy nodes remain for phases 2/3.`,
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await checkUi();
