import type {
  GitCentralPort,
  GitFileDiff,
  RoleRuleChange,
  RoleRuleInventory,
} from "@cardigan/domain";

// These are existing prompt source formats, not configurable exemptions. New formats fail closed.
const rolePath = (p: string) =>
  /(?:^|\/)(?:AGENTS|CLAUDE|SKILL)\.md$/iu.test(p) ||
  /(?:^|[/._-])(?:roles?|prompts?|agents)(?:[/._-]|$)/iu.test(p);
const prohibited =
  /allowed_tools|capabilities|permission|authoriz|delegat|isolation|review|权限|工具|能力|隔离|审核|复核|验收|代确认|代拍|授权|强制交人|对外发布|放宽|豁免/iu;
function classify(f: GitFileDiff): RoleRuleChange {
  const base = {
    id: f.path,
    path: f.path,
    old_mode: f.old_mode,
    new_mode: f.new_mode,
    old_oid: f.old_oid,
    new_oid: f.new_oid,
    status: f.status,
  };
  // Test code and snapshots do not compile into a role's prompt.
  if (/(?:\.test\.[cm]?[jt]sx?|\.snap)$/u.test(f.path))
    return { ...base, category: "ordinary", edits: [] };
  // Unrecognized paths cannot establish a role-body exception. Keep all facts
  // so adding/moving a prompt under an innocent filename cannot hide it.
  if (!rolePath(f.path)) return { ...base, category: "unknown", edits: [] };
  const edits: { id: string; before: string; after: string }[] = [];
  let current: (typeof edits)[number] | undefined;
  for (const line of f.patch.split("\n")) {
    if (line.startsWith("@@ ")) {
      current = { id: `${f.path}:${line}`, before: "", after: "" };
      edits.push(current);
    } else if (current && line.startsWith("-"))
      current.before += `${line.slice(1)}\n`;
    else if (current && line.startsWith("+"))
      current.after += `${line.slice(1)}\n`;
  }
  if (
    f.status !== "M" ||
    f.old_mode !== "100644" ||
    f.new_mode !== "100644" ||
    !edits.length
  )
    return { ...base, category: "unknown", edits };
  if (
    edits.some((e) => prohibited.test(e.before + e.after)) ||
    (f.path === "packages/roles/src/role-pack.ts" &&
      edits.some((e) => {
        try {
          return [e.before, e.after].some((s) =>
            s
              .trimEnd()
              .split("\n")
              .some((l) =>
                prohibited.test(JSON.parse(l.trim().replace(/,$/u, ""))),
              ),
          );
        } catch {
          return true;
        }
      }))
  )
    return { ...base, category: "forbidden", edits };
  const markdown = f.path === "AGENTS.md";
  // In the existing TS pack only complete string-literal entries may change.
  // Any syntax/identifier/tool-list/role-definition change is unknown.
  const promptRegion = (s: string) => {
    const end = s.indexOf("export const DEFAULT_ROLE_KINDS");
    return end > 0 ? s.slice(0, end) : "";
  };
  const before = promptRegion(f.before ?? ""),
    after = promptRegion(f.after ?? "");
  const stripStrings = (s: string) =>
    s.replace(/^\s*"(?:[^"\\]|\\.)*",?\s*$/gmu, "<prompt-string>");
  const strings =
    f.path === "packages/roles/src/role-pack.ts" &&
    before.length > 0 &&
    after.length > 0 &&
    stripStrings(f.before ?? "") === stripStrings(f.after ?? "") &&
    edits.every((e) => {
      const range = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(e.id);
      return (
        range &&
        Number(range[1]) + Number(range[2] ?? 1) <= before.split("\n").length &&
        Number(range[3]) + Number(range[4] ?? 1) <= after.split("\n").length
      );
    }) &&
    edits.every(
      (e) =>
        before.includes(e.before.trimEnd()) &&
        after.includes(e.after.trimEnd()),
    ) &&
    edits.every((e) =>
      [e.before, e.after].every(
        (s) =>
          s.trim().length > 0 &&
          s
            .trimEnd()
            .split("\n")
            .every((l) => /^\s*"(?:[^"\\]|\\.)*",?\s*$/u.test(l)),
      ),
    );
  return { ...base, category: markdown || strings ? "body" : "unknown", edits };
}
export async function collectRoleRuleInventory(
  git: GitCentralPort,
  repository: string,
  base_sha: string,
  sha: string,
): Promise<RoleRuleInventory> {
  const tree_sha = await git.treeOfCommit(repository, sha);
  if (!git.fileDiffs)
    return {
      version: 1,
      base_sha,
      sha,
      tree_sha,
      complete: false,
      changes: [],
    };
  const diffs = await git.fileDiffs(repository, base_sha, sha);
  return {
    version: 1,
    base_sha,
    sha,
    tree_sha,
    complete: true,
    changes: diffs.map(classify),
  };
}
