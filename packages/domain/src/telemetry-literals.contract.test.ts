import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, test } from "vitest";
import { TELEMETRY_EVENT_TYPES } from "./telemetry.js";

/**
 * C-655: command-state `state.events` holds no telemetry (C-643), and arrays
 * derived from it (`filter`, `map`, spread) lose the journal too. Matching an
 * event's `type` against a telemetry literal by hand therefore finds nothing
 * there. Production code queries telemetry through `eventsOfType` /
 * `eventById` (guarded in tests, see `setTelemetryQueryGuard`); a hand-written
 * match is only allowed on the complete history, a raw stream or a single
 * looked-up event, listed below with the reason.
 */
const ALLOWED: Record<string, { why: string; matches: string[] }> = {
  "packages/domain/src/commands/host-ops-actions.ts": {
    why: "event looked up with eventById",
    matches: ['event?.type !== "run_queued"'],
  },
  "packages/domain/src/commands/resume-attention.ts": {
    why: "loop over fullEventHistory",
    matches: ['e.type === "run_queued"', 'e.type === "run_dispatched"'],
  },
  "packages/domain/src/commands/review-limit-resolution.ts": {
    why: "event looked up with eventById",
    matches: ['event?.type !== "run_queued"'],
  },
  "packages/domain/src/commands/stop-state.ts": {
    why: "loop over fullEventHistory",
    matches: ['event.type === "run_dispatched"'],
  },
  "packages/domain/src/run-recovery.ts": {
    why: "event looked up with eventById",
    matches: ['event.type !== "run_queued"'],
  },
  "packages/host/src/github-dispatch-journal.ts": {
    why: "raw stream read from the event table",
    matches: ['e.type === "github_check_dispatch"'],
  },
  "packages/router/src/route.ts": {
    why: "routes one appended event",
    matches: ['case "run_finished":'],
  },
};

function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  )
    node = node.expression;
  return node;
}

const isTelemetryLiteral = (node: ts.Node) =>
  ts.isStringLiteralLike(node) && TELEMETRY_EVENT_TYPES.has(node.text);

function isTypeAccess(node: ts.Expression): boolean {
  const inner = unwrap(node);
  if (ts.isPropertyAccessExpression(inner)) return inner.name.text === "type";
  return (
    ts.isElementAccessExpression(inner) &&
    ts.isStringLiteralLike(inner.argumentExpression) &&
    inner.argumentExpression.text === "type"
  );
}

const equality = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/**
 * Hand-written telemetry matches on an event's `type`: comparisons with a
 * telemetry literal, `case` labels of a `switch (….type)`, and
 * `[…telemetry…].includes(….type)`.
 */
function telemetryLiteralMatches(path: string, source: string): string[] {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const add = (text: string) => found.push(text.replace(/\s+/g, " ").trim());
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      equality.has(node.operatorToken.kind) &&
      ((isTelemetryLiteral(unwrap(node.right)) && isTypeAccess(node.left)) ||
        (isTelemetryLiteral(unwrap(node.left)) && isTypeAccess(node.right)))
    )
      add(node.getText(file));
    if (
      ts.isCaseClause(node) &&
      isTelemetryLiteral(node.expression) &&
      isTypeAccess(node.parent.parent.expression)
    )
      add(`case ${node.expression.getText(file)}:`);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "includes" &&
      node.arguments[0] &&
      isTypeAccess(node.arguments[0])
    ) {
      const list = unwrap(node.expression.expression);
      if (
        ts.isArrayLiteralExpression(list) &&
        list.elements.some(isTelemetryLiteral)
      )
        add(node.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const root = fileURLToPath(new URL("../../..", import.meta.url));
const skipped = /(^|\/)(node_modules|dist|test-support)(\/|$)/;
const testFile = /\.test\.tsx?$|(^|\/)test-fixtures\.ts$/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (skipped.test(relative(root, path))) return [];
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !testFile.test(entry.name)
      ? [path]
      : [];
  });
}

test("C-655: production code matches telemetry types by hand only where allowed", () => {
  const literal = new RegExp(
    [...TELEMETRY_EVENT_TYPES].map((type) => `["'\`]${type}["'\`]`).join("|"),
  );
  const found: Record<string, string[]> = {};
  for (const path of ["packages", "apps"].flatMap((group) =>
    readdirSync(join(root, group), { withFileTypes: true })
      .map((pkg) => join(root, group, pkg.name, "src"))
      .filter((dir) => existsSync(dir))
      .flatMap(sources),
  )) {
    const source = readFileSync(path, "utf8");
    if (!literal.test(source)) continue;
    const matches = telemetryLiteralMatches(path, source);
    if (matches.length) found[relative(root, path)] = matches.sort();
  }
  expect(found).toEqual(
    Object.fromEntries(
      Object.entries(ALLOWED).map(([path, { matches }]) => [
        path,
        [...matches].sort(),
      ]),
    ),
  );
});

test("C-655: a deliberately wrong telemetry match on a derived array is reported", () => {
  const wrong = `
    const mine = state.events.filter((e) => e.card_id === card.id);
    const started = mine.find((e) => e.type === "run_started");
    const queued = [...state.events].some((e) => "run_queued" == (e).type);
    const dispatched = mine.filter((e) => e["type"] !== "run_dispatched");
    const busy = mine.some((e) => ["run_started", "x"].includes(e.type));
    switch (mine[0]?.type) {
      case "run_finished":
        break;
    }
  `;
  expect(telemetryLiteralMatches("wrong.ts", wrong)).toEqual([
    'e.type === "run_started"',
    '"run_queued" == (e).type',
    'e["type"] !== "run_dispatched"',
    '["run_started", "x"].includes(e.type)',
    'case "run_finished":',
  ]);
  // Business types, indexed lookups and other fields are not hand matches.
  const fine = `
    const submitted = mine.find((e) => e.type === "delivery_submitted");
    const started = eventsOfType(state.events, "run_started");
    const kind = run.status === "run_started";
    d.emit("run_queued", card, {});
    switch (event.kind) {
      case "run_finished":
        break;
    }
  `;
  expect(telemetryLiteralMatches("fine.ts", fine)).toEqual([]);
});
