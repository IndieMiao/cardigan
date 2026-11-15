import type { TestReviewBinding } from "@cardigan/domain";

const shellQuote = (path: string) => `'${path.replaceAll("'", `'"'"'`)}'`;

/** Run context, not a role/tool permission change. Only the host supplies it. */
export function testReviewPrompt(proof: TestReviewBinding | undefined): string {
  if (!proof) return "本次按完整复核处理；没有当前有效的测试增量证明。";
  return [
    "增量复核（只改测试）：本次不消耗完整审核轮数，仍须本人提交新的审核结论。",
    `当前交付 ${proof.delivery_id}，完整 SHA ${proof.new_sha}，tree ${proof.new_tree}。`,
    `上一版 ${proof.previous_delivery_id}，SHA ${proof.old_sha}，有效通过 ${proof.previous_review_id}。`,
    `可信基线 ${proof.baseline_sha}，tree ${proof.baseline_tree}；配置 ${proof.policy_version} / ${proof.policy_digest}。`,
    "本卡所有改动文件：",
    ...proof.files.map((file) => `- ${JSON.stringify(file)}`),
    "逐段 diff（逐个查看，不能仅看净差异）：",
    ...proof.ranges.map(
      (range) =>
        `- git --literal-pathspecs diff ${range.base} ${range.head} -- ${range.files.map(shellQuote).join(" ")}`,
    ),
    "排除的基线合并证明：",
    ...proof.baseline_merges.map(
      (merge) =>
        `- ${merge.commit}: ${merge.first_parent} + ${merge.baseline_parent}，重算 tree ${merge.tree}`,
    ),
    "逐项确认：没有放松断言、加长超时、跳过用例或改弱夹具。发现任一弱化按普通 must_fix 提交，允许报告本次新引入的问题。",
    "只审核上述本卡测试差异；证明失效时须完整复核，提交结论时主机再次核对资格与当前交付。",
  ].join("\n");
}
