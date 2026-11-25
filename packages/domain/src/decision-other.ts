import type { Decision } from "./entities.js";

/**
 * C-682: every decision a human answers carries a system-owned "其他" option
 * after the raiser's options. It is never stored in `Decision.options`, so a
 * raiser cannot remove it and decisions opened before this change offer it
 * too. Choosing it requires the human's own words, resolves the decision with
 * no option-bound effect, and hands the words back to the raiser (or PM for
 * system-raised decisions) to follow up.
 */
export const DECISION_OTHER_OPTION = "_other";
export const DECISION_OTHER_LABEL = "其他（自己填写）";

export type DecisionOption = Decision["options"][number];

export const decisionOtherOption: DecisionOption = Object.freeze({
  key: DECISION_OTHER_OPTION,
  description: DECISION_OTHER_LABEL,
  impact: "按所有者填写的内容交给发起方跟进，不执行任何预设选项",
});

export const isDecisionOther = (option: string | undefined) =>
  option === DECISION_OTHER_OPTION;

/** Options shown to the human: the raiser's, then the system "其他". */
export function humanDecisionOptions(
  options: readonly DecisionOption[],
): readonly DecisionOption[] {
  return [
    ...options.filter((o) => o.key !== DECISION_OTHER_OPTION),
    decisionOtherOption,
  ];
}

/** Description of a chosen option, including the system "其他". */
export function decisionOptionOf(
  q: Pick<Decision, "options">,
  option: string | undefined,
): DecisionOption | undefined {
  if (isDecisionOther(option)) return decisionOtherOption;
  return q.options.find((o) => o.key === option);
}
