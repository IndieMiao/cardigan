import type { GitCentralPort, GitFileDiff, RoleRuleChange, RoleRuleInventory } from "@cardigan/domain";

// These are existing prompt source formats, not configurable exemptions. New formats fail closed.
const rolePath = (p: string) => /(?:^|\/)(?:AGENTS|CLAUDE|SKILL)\.md$/iu.test(p) || /(?:^|[\/._-])(?:roles?|prompts?|agents)(?:[\/._-]|$)/iu.test(p);
const prohibited = /allowed_tools|capabilities|permission|authoriz|delegat|isolation|review|权限|工具|能力|隔离|审核|复核|验收|代确认|代拍|授权|强制交人|对外发布|放宽|豁免/iu;
function classify(f: GitFileDiff): RoleRuleChange {
  const base = { id: f.path, path: f.path, old_mode: f.old_mode, new_mode: f.new_mode, old_oid: f.old_oid, new_oid: f.new_oid, status: f.status };
  // Test code and snapshots do not compile into a role's prompt.
  if (!rolePath(f.path) || /(?:\.test\.[cm]?[jt]sx?|\.snap)$/u.test(f.path)) return {...base, category: "ordinary", edits: []};
  const edits: {id: string; before: string; after: string}[] = [];
  let current: typeof edits[number] | undefined;
  for (const line of f.patch.split("\n")) {
    if (line.startsWith("@@ ")) {
      current = {id: `${f.path}:${line}`, before: "", after: ""};
      edits.push(current);
    } else if (current && line.startsWith("-")) current.before += `${line.slice(1)}\n`;
    else if (current && line.startsWith("+")) current.after += `${line.slice(1)}\n`;
  }
  if (f.status !== "M" || f.old_mode !== "100644" || f.new_mode !== "100644" || !edits.length)
    return {...base, category: "unknown", edits};
  if (edits.some(e => prohibited.test(e.before + e.after))) return {...base, category: "forbidden", edits};
  const markdown = f.path === "AGENTS.md";
  // In the existing TS pack only complete string-literal entries may change.
  // Any syntax/identifier/tool-list/role-definition change is unknown.
  const strings = f.path === "packages/roles/src/role-pack.ts" && edits.every(e =>
    [e.before, e.after].every(s => s.trim().length > 0 && s.trimEnd().split("\n").every(l => /^\s*"(?:[^"\\]|\\.)*",?\s*$/u.test(l))));
  return {...base, category: markdown || strings ? "body" : "unknown", edits};
}
export async function collectRoleRuleInventory(git: GitCentralPort, repository: string, base_sha: string, sha: string): Promise<RoleRuleInventory> {
  const tree_sha = await git.treeOfCommit(repository, sha);
  if (!git.fileDiffs) return {version: 1, base_sha, sha, tree_sha, complete: false, changes: []};
  const diffs = await git.fileDiffs(repository, base_sha, sha);
  return {version: 1, base_sha, sha, tree_sha, complete: true, changes: diffs.map(classify)};
}
