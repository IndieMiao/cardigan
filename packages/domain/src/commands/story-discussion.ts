import type { Card } from "../entities.js";
import type { CardId, TimelineEntryId } from "../ids.js";
import { parseCardPriority } from "../priority.js";
import { isRoleActive } from "../role.js";
import { storyTerminal } from "../story.js";
import {
  STORY_PROPOSAL_MAX_CHILDREN,
  type StoryDiscussion,
  type StoryProposalChild,
  type StoryProposalChildInput,
  type StoryQuestionGroup,
} from "../story-discussion.js";
import {
  requireCardDependencyStart,
  validateCardDependencyRefs,
} from "./card-dependencies.js";
import { attempt, type CommandDraft, ensure, text } from "./core.js";
import { type CreateCardParams, prepareCardCreation } from "./pm.js";

/** Called inside the proposal transaction. Human answers are never overwritten. */
export function settleStoryQuestionDefaults(
  group: StoryQuestionGroup,
  entry_id: TimelineEntryId,
  source: "accepted_default" | "proposal_default",
): StoryQuestionGroup {
  return {
    ...group,
    questions: group.questions.map((q) =>
      q.resolution
        ? q
        : { ...q, resolution: { source, value: q.recommended, entry_id } },
    ),
  };
}

/** The fields create_card validates; only confirmation adds real sibling IDs and provenance. */
export function storyChildForm(
  parent_card_id: CardId,
  child: StoryProposalChildInput,
  sourceText = child.goal,
): CreateCardParams {
  return {
    parent_card_id,
    title: child.title,
    goal: child.goal,
    template_id: child.template_id,
    acceptance_criteria: child.acceptance_criteria,
    source: { kind: "quote", text: sourceText },
    ...(child.priority === undefined ? {} : { priority: child.priority }),
    ...(child.wait_for_dependencies === undefined
      ? {}
      : { wait_for_dependencies: child.wait_for_dependencies }),
    ...(child.state_and_save === undefined
      ? {}
      : {
          state_and_save: child.state_and_save as NonNullable<
            Card["state_and_save"]
          >,
        }),
    ...(child.repo === undefined ? {} : { repo: child.repo }),
    ...(child.base_branch === undefined
      ? {}
      : { base_branch: child.base_branch }),
  };
}

export function checkStoryChild<T>(
  number: number,
  title: string,
  operation: () => T,
): T {
  const result = attempt(operation);
  if (result.ok) return result.value;
  const message = result.error.message.replace(
    /^(.+) is required$/u,
    "缺少 $1",
  );
  ensure(
    false,
    result.error.code,
    `第 ${number} 张子卡「${title}」无法开出：${message}`,
    { child: number },
  );
}

function proposalChildren(
  d: CommandDraft,
  story: Card,
  inputs: readonly StoryProposalChildInput[],
): StoryProposalChild[] {
  ensure(
    Array.isArray(inputs) &&
      inputs.length > 0 &&
      inputs.length <= STORY_PROPOSAL_MAX_CHILDREN,
    "validation_failed",
    `拆解方案须有 1～${STORY_PROPOSAL_MAX_CHILDREN} 张子卡`,
  );
  const children = inputs.map((c, i): StoryProposalChild => {
    const n = i + 1;
    text(c.title, `第 ${n} 张子卡的标题`);
    text(c.goal, `第 ${n} 张子卡的目标`);
    text(c.template_id, `第 ${n} 张子卡的模板`);
    text(c.owner_role, `第 ${n} 张子卡的负责角色`);
    ensure(
      d.state.roles.some((r) => r.role_id === c.owner_role),
      "validation_failed",
      `第 ${n} 张子卡的负责角色 ${c.owner_role} 未在项目登记`,
    );
    // Structured proposals always carry review points, whatever the template.
    const acceptance = c.acceptance_criteria;
    ensure(
      Array.isArray(acceptance) &&
        acceptance.length > 0 &&
        acceptance.every((a) => typeof a === "string" && a.trim()),
      "validation_failed",
      `第 ${n} 张子卡至少需要一条非空验收要点`,
    );
    const priority = parseCardPriority(c.priority ?? 0);
    ensure(
      priority !== undefined,
      "validation_failed",
      `第 ${n} 张子卡的优先级无效`,
    );
    const depends_on = [...new Set<number>(c.depends_on ?? [])];
    ensure(
      depends_on.every(
        (k) =>
          Number.isSafeInteger(k) && k >= 1 && k <= inputs.length && k !== n,
      ),
      "validation_failed",
      `第 ${n} 张子卡的依赖须为方案内其它子卡的序号`,
    );
    const cards = [...new Set<CardId>(c.depends_on_cards ?? [])];
    ensure(
      c.wait_for_dependencies === undefined ||
        typeof c.wait_for_dependencies === "boolean",
      "validation_failed",
      `第 ${n} 张子卡的等待前置标记必须为布尔值`,
    );
    checkStoryChild(n, c.title, () => {
      prepareCardCreation(d, storyChildForm(story.id, c), {
        registered_repo_only: true,
      });
      if (cards.length) validateCardDependencyRefs(d, cards);
    });
    return {
      title: c.title,
      template_id: c.template_id,
      goal: c.goal,
      acceptance_criteria: [...acceptance],
      depends_on,
      ...(cards.length ? { depends_on_cards: cards } : {}),
      ...(c.wait_for_dependencies === undefined
        ? {}
        : { wait_for_dependencies: c.wait_for_dependencies }),
      priority,
      owner_role: c.owner_role,
      ...(c.state_and_save === undefined
        ? {}
        : { state_and_save: c.state_and_save }),
      ...(c.repo === undefined ? {} : { repo: c.repo }),
      ...(c.base_branch === undefined ? {} : { base_branch: c.base_branch }),
    };
  });
  const order = storyProposalOrder(children);
  if (order.length !== children.length) {
    const blocked = children.findIndex((_, i) => !order.includes(i)) + 1;
    ensure(
      false,
      "validation_failed",
      `第 ${blocked} 张子卡的依赖无法满足：拆解方案的子卡依赖不能成环`,
      { child: blocked },
    );
  }
  return children;
}

/**
 * 0-based creation order: a child after everything it depends on, otherwise in
 * proposal order. A cycle leaves its members out.
 */
export function storyProposalOrder(
  children: readonly Pick<StoryProposalChild, "depends_on">[],
): number[] {
  const order: number[] = [];
  const placed = new Set<number>();
  while (order.length < children.length) {
    const next = children.findIndex(
      (c, i) => !placed.has(i) && c.depends_on.every((k) => placed.has(k - 1)),
    );
    if (next < 0) break;
    placed.add(next);
    order.push(next);
  }
  return order;
}

function defaultLines(group: StoryQuestionGroup) {
  return group.questions.flatMap((q, i) =>
    q.resolution ? [] : [`${group.id} 第 ${i + 1} 题按默认：${q.recommended}`],
  );
}

/** Prepare the timeline text and commit the matching state under its durable entry ID. */
export function storyDiscussionChange(
  d: CommandDraft,
  card: Card,
  action: StoryDiscussion,
) {
  const story = card.story;
  ensure(
    story && !storyTerminal(card),
    "illegal_transition",
    "只能在未结束的需求卡上澄清问题",
  );
  const groups = story.question_groups ?? [];
  const save = (question_groups: readonly StoryQuestionGroup[]) =>
    d.put("cards", { ...card, story: { ...story, question_groups } });
  if (action.action === "ask" || action.action === "propose") {
    ensure(
      d.assignment?.scope === "standing" &&
        d.assignment.role_id === "pm" &&
        d.assignment.standing_mode === "office" &&
        isRoleActive(d.state.roles, "pm"),
      "unauthorized",
      "只有常驻 PM Office 可发起问题或提交拆解方案",
    );
    if (action.action === "ask") {
      ensure(
        action.questions.length > 0,
        "validation_failed",
        "清单至少需要一题",
      );
      const questions = action.questions.map(
        ({ question, recommended, impact }) => {
          text(question, "question");
          text(recommended, "recommended");
          text(impact, "impact");
          return { question, recommended, impact };
        },
      );
      return {
        lines: questions.map(
          (q, i) =>
            `${i + 1}. ${q.question}\n   推荐：${q.recommended}\n   影响：${q.impact}`,
        ),
        apply: (id: TimelineEntryId) => save([...groups, { id, questions }]),
      };
    }
    ensure(
      !card.hold && card.status !== "backlog",
      "illegal_transition",
      "需求卡尚未排期或已暂停",
    );
    requireCardDependencyStart(d, card);
    const children =
      action.children === undefined
        ? undefined
        : proposalChildren(d, card, action.children);
    const proposals = story.proposals ?? [];
    const version = (proposals.at(-1)?.version ?? 0) + 1;
    return {
      lines: [
        children
          ? `拆解方案第 ${version} 版（${children.length} 张子卡）\n${children
              .map((c, i) => `${i + 1}. ${c.title}`)
              .join("\n")}`
          : "拆解方案",
        ...groups.flatMap(defaultLines),
      ],
      apply: (id: TimelineEntryId) =>
        d.put("cards", {
          ...card,
          story: {
            ...story,
            question_groups: groups.map((g) =>
              settleStoryQuestionDefaults(g, id, "proposal_default"),
            ),
            ...(children
              ? {
                  proposals: [
                    ...proposals,
                    { version, entry_id: id, submitted_at: d.now, children },
                  ],
                }
              : {}),
          },
        }),
    };
  }
  ensure(d.actor.kind === "human", "unauthorized", "只有人可回答需求问题");
  const group = groups.find((g) => g.id === action.group_id);
  ensure(group, "validation_failed", "本卡没有该问题清单");
  const update = (next: StoryQuestionGroup) =>
    save(groups.map((g) => (g.id === next.id ? next : g)));
  if (action.action === "accept_defaults") {
    ensure(
      group.questions.some((q) => !q.resolution),
      "illegal_transition",
      "该清单已全部回答或按默认处理",
    );
    return {
      lines: defaultLines(group),
      apply: (id: TimelineEntryId) =>
        update(settleStoryQuestionDefaults(group, id, "accepted_default")),
    };
  }
  if (action.action === "submit_answers") {
    ensure(
      group.questions.some((q) => !q.resolution),
      "illegal_transition",
      "该清单已全部回答或按默认处理",
    );
    ensure(
      Array.isArray(action.answers),
      "validation_failed",
      "answers is required",
    );
    const answers = new Map<number, string>();
    for (const { number, answer } of action.answers) {
      const question = group.questions[number - 1];
      ensure(
        Number.isSafeInteger(number) && question,
        "validation_failed",
        "题号不存在",
      );
      ensure(!answers.has(number), "validation_failed", `第 ${number} 题重复`);
      ensure(
        !question.resolution,
        "illegal_transition",
        `第 ${number} 题已回答或按默认处理`,
      );
      text(answer, "answer");
      answers.set(number, answer);
    }
    return {
      lines: group.questions.flatMap((q, i) => {
        if (q.resolution) return [];
        const answer = answers.get(i + 1);
        return [
          answer === undefined
            ? `${group.id} 第 ${i + 1} 题按默认：${q.recommended}`
            : `${group.id} 第 ${i + 1} 题：${answer}`,
        ];
      }),
      apply: (entry_id: TimelineEntryId) =>
        update({
          ...group,
          questions: group.questions.map((q, i) => {
            if (q.resolution) return q;
            const answer = answers.get(i + 1);
            return {
              ...q,
              resolution:
                answer === undefined
                  ? {
                      source: "accepted_default" as const,
                      value: q.recommended,
                      entry_id,
                    }
                  : { source: "answer" as const, value: answer, entry_id },
            };
          }),
        }),
    };
  }
  const index = action.number - 1;
  ensure(
    Number.isSafeInteger(index) && group.questions[index],
    "validation_failed",
    "题号不存在",
  );
  ensure(
    !group.questions[index].resolution,
    "illegal_transition",
    "该题已回答或按默认处理",
  );
  text(action.answer, "answer");
  return {
    lines: [`${group.id} 第 ${action.number} 题：${action.answer}`],
    apply: (entry_id: TimelineEntryId) =>
      update({
        ...group,
        questions: group.questions.map((q, i) =>
          i === index
            ? {
                ...q,
                resolution: {
                  source: "answer",
                  value: action.answer,
                  entry_id,
                },
              }
            : q,
        ),
      }),
  };
}
