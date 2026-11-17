import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  src = resolve(root, "apps/web/src");
// Reviewed source is immutable history. Editing the JSON cannot authorize new exceptions.
const LEGACY_CENSUS = "19977ef68f2ae244a4ed7e97957e72a83a713cfe";
// The imported foundation is integrated with the reviewed main baseline.
// Its execution diagnostics/maintenance styles predate this migration gate.
const STYLE_BASE = "99587a67c29facfa4f9cb5e990e26a533b0f0ff9";
const legacyCss = [
  "styles.css",
  "components/CardLegend.css",
  "components/TemplateMarker.css",
];
const sharedCss = ["components/ui/theme.css", "components/layout/layout.css"];
const nativeTags = new Set(["select", "button", "input", "textarea", "style"]);
const key = (f) => `${f.path}:${f.kind}:${f.hash}`;
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
async function files(dir) {
  return (
    await Promise.all(
      (
        await readdir(dir, { withFileTypes: true })
      ).map((e) =>
        e.isDirectory() ? files(resolve(dir, e.name)) : [resolve(dir, e.name)],
      ),
    )
  ).flat();
}
export function forbiddenUtility(value) {
  return value.split(/\s+/).some((word) => {
    const utility = (word.split(/:(?![^[]*\])/).at(-1) ?? "").replace(
      /^!|!$/g,
      "",
    );
    return /^(?:-?(?:h|w|size|min-h|max-h|min-w|max-w|rounded(?:-[trblsexy]{1,2})?|text|bg|font|leading|tracking|p[trblxyse]?|m[trblxyse]?|gap(?:-[xy])?|space-[xy]|border(?:-[trblxyse])?|ring|outline|shadow|opacity)-|\[)/.test(
      utility,
    );
  });
}
export function findings(path, source) {
  const sf = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
    found = [],
    bindings = new Map(),
    uiNames = new Set();
  const ui = path.startsWith("components/ui/"),
    layout = path.startsWith("components/layout/");
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
  const collect = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    )
      bindings.set(node.name.text, node.initializer);
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.includes("/ui/")
    ) {
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named))
        for (const e of named.elements) uiNames.add(e.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  const dereference = (node, seen = new Set()) => {
    if (!node) return node;
    if (
      ts.isJsxExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return dereference(node.expression, seen);
    if (
      ts.isIdentifier(node) &&
      bindings.has(node.text) &&
      !seen.has(node.text)
    ) {
      seen.add(node.text);
      return dereference(bindings.get(node.text), seen);
    }
    return node;
  };
  const strings = (node, seen = new Set()) => {
    node = dereference(node);
    if (!node || seen.has(node)) return [];
    seen.add(node);
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isTemplateExpression(node))
      return [
        node.head.text,
        ...node.templateSpans.flatMap((s) => [
          ...strings(s.expression, seen),
          s.literal.text,
        ]),
      ];
    const values = [];
    // A truthy callback result stops forEachChild before later siblings.
    ts.forEachChild(node, (c) => {
      values.push(...strings(c, seen));
    });
    return values;
  };
  const unsafeStyle = (node) => {
    node = dereference(node);
    if (!node || !ts.isObjectLiteralExpression(node)) return true;
    return node.properties.some(
      (p) =>
        !ts.isPropertyAssignment(p) ||
        !["pointerEvents", "cursor"].includes(
          p.name.getText(sf).replace(/["']/g, ""),
        ),
    );
  };
  const checkProps = (props, owner) => {
    props = dereference(props);
    if (!props || !ts.isObjectLiteralExpression(props)) {
      add("unsafe-prop-spread", owner);
      return;
    }
    for (const p of props.properties) {
      if (ts.isSpreadAssignment(p)) {
        checkProps(p.expression, owner);
        continue;
      }
      if (!ts.isPropertyAssignment(p)) {
        add("unsafe-prop-spread", owner);
        continue;
      }
      const name = p.name.getText(sf).replace(/["']/g, "");
      if (name === "style" && unsafeStyle(p.initializer))
        add("inline-size", owner);
      if (name === "className" && strings(p.initializer).some(forbiddenUtility))
        add("page-token-override", owner);
    }
  };
  const visit = (node) => {
    if (!ui) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        strings(node.moduleSpecifier).some((s) => s.startsWith("@radix-ui/"))
      )
        add("direct-radix", node);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          node.expression.getText(sf) === "require") &&
        strings(node.arguments[0]).some((s) => s.startsWith("@radix-ui/"))
      )
        add("direct-radix", node);
    }
    if (
      !ui &&
      !layout &&
      ts.isCallExpression(node) &&
      /(?:^|\.)createElement$/.test(node.expression.getText(sf))
    ) {
      const tag = dereference(node.arguments[0]);
      if (tag && ts.isStringLiteralLike(tag) && nativeTags.has(tag.text))
        add(`native-${tag.text}`, node);
      if (
        node.arguments[1] &&
        tag &&
        ts.isStringLiteralLike(tag) &&
        nativeTags.has(tag.text)
      )
        checkProps(node.arguments[1], node);
    }
    if (
      !ui &&
      !layout &&
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
    ) {
      const alias = dereference(node.tagName),
        tag =
          alias && ts.isStringLiteralLike(alias)
            ? alias.text
            : node.tagName.getText(sf);
      if (nativeTags.has(tag)) add(`native-${tag}`, node);
      for (const attr of node.attributes.properties) {
        if (ts.isJsxSpreadAttribute(attr)) {
          if (uiNames.has(tag) || nativeTags.has(tag))
            checkProps(attr.expression, attr);
          continue;
        }
        const name = attr.name.getText(sf);
        if (name === "style" && unsafeStyle(attr.initializer))
          add("inline-size", attr);
        if (
          name === "className" &&
          strings(attr.initializer).some(forbiddenUtility)
        )
          add("page-token-override", attr);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}
export function validateExemptions(current, frozen) {
  const allowed = new Map(frozen.map((f) => [key(f), f.count])),
    seen = new Set(),
    errors = [];
  let total = 0;
  for (const f of current) {
    const k = key(f);
    total += f.count;
    if (
      seen.has(k) ||
      !Number.isSafeInteger(f.count) ||
      f.count < 1 ||
      f.count > (allowed.get(k) ?? 0)
    )
      errors.push(`Unreviewed legacy exemption: ${k}`);
    seen.add(k);
  }
  if (total > 176) errors.push("Legacy budget exceeds 176");
  return errors;
}
export function cssFindings(path, css, baseline) {
  const errors = [];
  if (baseline !== undefined) {
    const counts = new Map();
    for (const line of baseline.split("\n"))
      counts.set(line, (counts.get(line) ?? 0) + 1);
    if (css.split("\n").length > baseline.split("\n").length)
      errors.push(`${path}: legacy stylesheet line budget grew`);
    for (const line of css.split("\n")) {
      if (!line.trim()) continue;
      const count = counts.get(line) ?? 0;
      if (!count)
        errors.push(
          `${path}: only deletion is allowed in legacy CSS (${line.trim()})`,
        );
      else counts.set(line, count - 1);
    }
    return errors;
  }
  if (sharedCss.includes(path)) {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of clean.matchAll(/([^{}]+)\{/g)) {
      const selector = match[1].trim();
      if (selector.startsWith("@")) continue;
      for (const m of selector.matchAll(/\.([a-zA-Z_][\w-]*)/g))
        if (!/^(ui-|id-)/.test(m[1]) && !["status", "lucide"].includes(m[1]))
          errors.push(
            `${path}: page-specific selector .${m[1]} belongs in a layout component`,
          );
    }
  }
  return errors;
}
export async function checkUi({ inventory = false } = {}) {
  const found = [],
    failures = [],
    all = await files(src);
  const readHistory = (rev, path) =>
    execFileSync("git", ["show", `${rev}:${path}`], {
      cwd: root,
      encoding: "utf8",
    });
  for (const file of all) {
    const path = relative(src, file),
      text = await readFile(file, "utf8");
    if (path.endsWith(".css")) {
      if (legacyCss.includes(path)) {
        if (!inventory)
          failures.push(
            ...cssFindings(
              path,
              text,
              readHistory(STYLE_BASE, `apps/web/src/${path}`),
            ),
          );
      } else if (sharedCss.includes(path))
        failures.push(...cssFindings(path, text));
      else if (
        path.startsWith("components/layout/") &&
        path.endsWith(".module.css")
      ) {
        const owner = file.replace(/\.module\.css$/, ".tsx");
        if (
          !all.includes(owner) ||
          !(await readFile(owner, "utf8")).includes(
            `./${path.split("/").at(-1)}`,
          )
        )
          failures.push(
            `${path}: CSS module requires its paired layout TSX owner`,
          );
        if (
          /(?:\d+(?:\.\d+)?)\s*(?:px|rem|em)\b/.test(
            text.replace(/@media[^{}]+/g, ""),
          )
        )
          failures.push(`${path}: layout dimensions must use tokens`);
      } else failures.push(`${path}: extra stylesheet is forbidden`);
    }
    if (
      !/\.tsx?$/.test(path) ||
      path.includes(".test.") ||
      path.startsWith("testing/")
    )
      continue;
    found.push(...findings(path, text));
  }
  if (inventory) return found;
  const baseline = JSON.parse(
      await readFile(
        resolve(root, "apps/web/test-support/ui-legacy.json"),
        "utf8",
      ),
    ),
    frozen = JSON.parse(
      readHistory(LEGACY_CENSUS, "apps/web/test-support/ui-legacy.json"),
    );
  failures.push(...validateExemptions(baseline, frozen));
  const remaining = new Map(baseline.map((f) => [key(f), f.count]));
  for (const f of found) {
    const count = remaining.get(key(f)) ?? 0;
    if (
      [
        "native-select",
        "native-textarea",
        "direct-radix",
        "unsafe-prop-spread",
        "page-token-override",
      ].includes(f.kind) ||
      protectedFiles.has(f.path) ||
      count === 0
    )
      failures.push(
        `${f.path}:${f.line} ${f.kind}: use components/ui or layout (${f.text})`,
      );
    else remaining.set(key(f), count - 1);
  }
  for (const [k, n] of remaining)
    if (n > 0) failures.push(`${k}: remove ${n} obsolete exemption(s)`);
  if (failures.length) throw new Error(failures.join("\n"));
  console.log(
    `UI boundary: passed; ${found.length}/176 reviewed legacy nodes remain.`,
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await checkUi();
