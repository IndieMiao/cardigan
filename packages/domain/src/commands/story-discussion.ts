import type { Card } from "../entities.js";
import type { TimelineEntryId } from "../ids.js";
import { isRoleActive } from "../role.js";
import { storyTerminal } from "../story.js";
import type {
  StoryDiscussion,
  StoryQuestionGroup,
} from "../story-discussion.js";
import { requireCardDependencyStart } from "./card-dependencies.js";
import { type CommandDraft, ensure, text } from "./core.js";

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
    return {
      lines: ["拆解方案", ...groups.flatMap(defaultLines)],
      apply: (id: TimelineEntryId) =>
        save(
          groups.map((g) =>
            settleStoryQuestionDefaults(g, id, "proposal_default"),
          ),
        ),
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
