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
    const unionPaths: string[] = [];
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
      // C-782: lazily re-render the reviewed merge with merge-base sections.
      let diff3: Map<string, string | undefined> | undefined;
      const unionResolved = async (path: string, resolved: string) => {
        if (!diff3) {
          const merge = await git.mergeTree(repository, baseline, old, {
            conflictStyle: "diff3",
          });
          const commit = await git.commitTree(repository, {
            tree: merge.tree,
            parents: [baseline],
            message: "Review equivalence comparison",
            author: identity,
          });
          diff3 = new Map(
            (await git.fileDiffs?.(repository, commit, newCommit))?.map(
              (change) => [change.path, change.before],
            ),
          );
        }
        const text = diff3.get(path);
        return text !== undefined && bothSides(text, baseline, old, resolved);
      };
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
        const conflicted = before.conflicts.includes(file.path);
        const expected = conflicted
          ? authorSide(file.before, baseline, old)
          : file.before;
        if (
          conflicted &&
          expected !== file.after &&
          (await unionResolved(file.path, file.after))
        ) {
          paths.push(file.path);
          unionPaths.push(file.path);
          continue;
        }
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
          ...(unionPaths.length ? { union_paths: unionPaths } : {}),
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

/**
 * C-782: in a diff3 rendering, every conflict hunk keeps the reviewed author's
 * side verbatim. A hunk whose merge base is empty (both sides only inserted
 * lines at the same place) may instead keep both inserted blocks verbatim in
 * either order, the same content a clean merge would have produced had one
 * line separated them. Every other line must equal the automatic merge.
 */
function bothSides(
  text: string,
  baseline: string,
  old: string,
  after: string,
): boolean {
  const start = `<<<<<<< ${baseline}\n`,
    end = `>>>>>>> ${old}`;
  const lines = text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const segments: (string | { main: string; base: string; author: string })[] =
    [];
  let phase = 0,
    plain = "",
    main = "",
    base = "",
    author = "";
  for (const line of lines) {
    if (line === start && phase === 0) {
      segments.push(plain);
      plain = main = base = author = "";
      phase = 1;
      continue;
    }
    if (/^\|{7}(?: [^\n]*)?\n$/u.test(line) && phase === 1) {
      phase = 2;
      continue;
    }
    if (line === "=======\n" && phase === 2) {
      phase = 3;
      continue;
    }
    if ((line === `${end}\n` || line === end) && phase === 3) {
      segments.push({ main, base, author });
      phase = 0;
      continue;
    }
    if (/^(?:<{7}|={7}|>{7}|\|{7})/u.test(line)) return false;
    if (phase === 0) plain += line;
    else if (phase === 1) main += line;
    else if (phase === 2) base += line;
    else author += line;
  }
  if (phase !== 0 || segments.length < 2) return false;
  segments.push(plain);
  // Forward set of reachable offsets: at most three choices per hunk.
  let reachable = new Set([0]);
  for (const segment of segments) {
    const choices =
      typeof segment === "string"
        ? [segment]
        : segment.base === "" && segment.main !== "" && segment.author !== ""
          ? [
              segment.author,
              segment.main + segment.author,
              segment.author + segment.main,
            ]
          : [segment.author];
    const next = new Set<number>();
    for (const offset of reachable)
      for (const choice of choices)
        if (after.startsWith(choice, offset)) next.add(offset + choice.length);
    if (!next.size) return false;
    reachable = next;
  }
  return reachable.has(after.length);
}
