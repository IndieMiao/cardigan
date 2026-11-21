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
import { isStoryTemplate } from "../templates.js";
import { requireCardDependencyStart } from "./card-dependencies.js";
import { type CommandDraft, ensure, text } from "./core.js";
import { creatableCardTemplate } from "./pm.js";

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

/**
 * Shape checks a proposal can pass without opening cards. Template forms such as
 * the repository or the UI save plan are rechecked by `create_card` on confirm.
 */
function proposalChildren(
  d: CommandDraft,
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
    const template = creatableCardTemplate(d, c.template_id);
    ensure(
      !isStoryTemplate(template),
      "validation_failed",
      `第 ${n} 张子卡不能是需求卡`,
    );
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
    for (const id of cards) d.card(id);
    return {
      title: c.title,
      template_id: c.template_id,
      goal: c.goal,
      acceptance_criteria: [...acceptance],
      depends_on,
      ...(cards.length ? { depends_on_cards: cards } : {}),
      priority,
      owner_role: c.owner_role,
      ...(c.state_and_save === undefined
        ? {}
        : { state_and_save: c.state_and_save }),
      ...(c.repo === undefined ? {} : { repo: c.repo }),
      ...(c.base_branch === undefined ? {} : { base_branch: c.base_branch }),
    };
  });
  ensure(
    storyProposalOrder(children).length === children.length,
    "validation_failed",
    "拆解方案的子卡依赖不能成环",
  );
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
        : proposalChildren(d, action.children);
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
