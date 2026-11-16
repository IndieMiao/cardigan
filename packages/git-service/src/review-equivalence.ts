import type {
  Delivery,
  DeliveryEvidence,
  GitCentralPort,
} from "@cardigan/domain";
import type ts from "typescript";

/** Compare syntax tokens, preserving literal text, comments, ASI and parse structure. */
function syntax(
  path: string,
  text: string,
  parser: typeof import("typescript"),
): string | undefined {
  if (!/\.(?:[cm]?[jt]sx?|json)$/u.test(path) || text.length > 1024 * 1024)
    return;
  if (path.endsWith(".json")) {
    try {
      JSON.parse(text);
    } catch {
      return;
    }
  }
  const source = parser.createSourceFile(
    path,
    text,
    parser.ScriptTarget.Latest,
    true,
  );
  if (
    (source as ts.SourceFile & { parseDiagnostics: readonly unknown[] })
      .parseDiagnostics.length
  )
    return;
  function node(n: ts.Node): unknown {
    const comments = (ranges: readonly ts.CommentRange[] | undefined) =>
      (ranges ?? []).map((range) => text.slice(range.pos, range.end));
    const children = n
      .getChildren(source)
      .filter(
        (c) =>
          c.kind !== parser.SyntaxKind.SemicolonToken &&
          !(
            n.kind === parser.SyntaxKind.SyntaxList &&
            c.kind === parser.SyntaxKind.CommaToken
          ),
      );
    return [
      n.kind,
      comments(parser.getLeadingCommentRanges(text, n.pos)),
      comments(parser.getTrailingCommentRanges(text, n.end)),
      children.length
        ? children.map(node)
        : parser.isStringLiteral(n) &&
            !parser.isExpressionStatement(n.parent) &&
            n.parent.kind !== parser.SyntaxKind.JsxAttribute
          ? n.text
          : n.getText(source),
    ];
  }
  return JSON.stringify([
    text.startsWith("#!") ? text.split("\n")[0] : null,
    node(source),
  ]);
}

function snapshot(
  path: string,
  text: string,
  parser: typeof import("typescript"),
) {
  if (
    !/(^|\/)__snapshots__\/[^/]+\.snap$/u.test(path) ||
    !/^\/\/ (?:Vitest|Jest) Snapshot v1/u.test(text)
  )
    return false;
  const source = parser.createSourceFile(
    "snapshot.js",
    text,
    parser.ScriptTarget.Latest,
    true,
    parser.ScriptKind.JS,
  );
  if (
    (source as ts.SourceFile & { parseDiagnostics: readonly unknown[] })
      .parseDiagnostics.length
  )
    return false;
  return source.statements.every((statement) => {
    if (
      !parser.isExpressionStatement(statement) ||
      !parser.isBinaryExpression(statement.expression)
    )
      return false;
    const { left, right, operatorToken } = statement.expression;
    return (
      operatorToken.kind === parser.SyntaxKind.EqualsToken &&
      parser.isElementAccessExpression(left) &&
      parser.isIdentifier(left.expression) &&
      left.expression.text === "exports" &&
      !!left.argumentExpression &&
      (parser.isStringLiteral(left.argumentExpression) ||
        parser.isNoSubstitutionTemplateLiteral(left.argumentExpression)) &&
      parser.isNoSubstitutionTemplateLiteral(right)
    );
  });
}
const identity = { name: "Cardigan", email: "cardigan@localhost" };

/** Remove baseline changes by merging BOTH versions onto the same trusted main. */
export async function reviewEquivalence(
  git: GitCentralPort,
  repository: string,
  baseline: string,
  previous: Delivery,
  sha: string,
): Promise<DeliveryEvidence | undefined> {
  if (
    previous.subject.kind !== "git_head" ||
    !git.fileDiffs ||
    ["rejected", "superseded"].includes(previous.status)
  )
    return;
  try {
    const old = previous.subject.value;
    const [before, after] = await Promise.all([
      git.mergeTree(repository, baseline, old),
      git.mergeTree(repository, baseline, sha),
    ]);
    // Ambiguous conflict resolutions require a reviewer. Never trust a commit message.
    if (after.conflicts.length) return;
    let kind = "baseline";
    const paths: string[] = [];
    if (before.tree !== after.tree) {
      const commits = await Promise.all(
        [before, after].map((merge) =>
          git.commitTree(repository, {
            tree: merge.tree,
            parents: [baseline],
            message: "Review equivalence comparison",
            author: identity,
          }),
        ),
      );
      const [oldCommit, newCommit] = commits;
      if (!oldCommit || !newCommit) return;
      const changes = await git.fileDiffs(repository, oldCommit, newCommit);
      if (
        before.conflicts.some(
          (path) => !changes.some((change) => change.path === path),
        )
      )
        return;
      if (!changes.length) return;
      for (const file of changes) {
        if (
          file.status !== "M" ||
          file.old_mode !== file.new_mode ||
          file.old_mode !== "100644" ||
          file.before === undefined ||
          file.after === undefined ||
          file.before.includes("\0") ||
          file.after.includes("\0")
        )
          return;
        const expected = before.conflicts.includes(file.path)
          ? authorSide(file.before, baseline, old)
          : file.before;
        if (expected === undefined) return;
        if (expected === file.after) {
          paths.push(file.path);
          continue;
        }
        // Read-only servers and baseline-only deliveries need no compiler startup.
        const parser = (await import("typescript")).default;
        if (
          !(
            snapshot(file.path, expected, parser) &&
            snapshot(file.path, file.after, parser)
          )
        ) {
          const oldSyntax = syntax(file.path, expected, parser);
          if (
            oldSyntax === undefined ||
            oldSyntax !== syntax(file.path, file.after, parser)
          )
            return;
        }
        paths.push(file.path);
      }
      kind = before.conflicts.length ? "conflict" : "format_or_snapshot";
    }
    return {
      kind: "diff",
      details: {
        review_equivalence: {
          version: 1,
          previous_delivery_id: previous.id,
          old_sha: old,
          new_sha: sha,
          old_tree: await git.treeOfCommit(repository, old),
          new_tree: await git.treeOfCommit(repository, sha),
          baseline_sha: baseline,
          compared_old_tree: before.tree,
          compared_new_tree: after.tree,
          kind,
          paths,
        },
      },
    };
  } catch {
    return;
  }
}

/** Only a deterministic text resolution retaining the reviewed author's side is provable. */
function authorSide(
  text: string,
  baseline: string,
  old: string,
): string | undefined {
  const start = `<<<<<<< ${baseline}\n`,
    end = `>>>>>>> ${old}`;
  const lines = text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const out: string[] = [];
  let phase = 0,
    resolved = 0;
  for (const line of lines) {
    if (line === start && phase === 0) {
      phase = 1;
      continue;
    }
    if (line === "=======\n" && phase === 1) {
      phase = 2;
      continue;
    }
    if ((line === `${end}\n` || line === end) && phase === 2) {
      phase = 0;
      resolved++;
      continue;
    }
    if (/^(?:<{7}|={7}|>{7}|\|{7})/u.test(line)) return;
    if (phase !== 1) out.push(line);
  }
  return phase === 0 && resolved > 0 ? out.join("") : undefined;
}
