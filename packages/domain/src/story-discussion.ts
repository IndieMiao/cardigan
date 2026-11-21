import type { TimelineEntryId } from "./ids.js";

export type StoryQuestion = {
  readonly question: string;
  readonly recommended: string;
  readonly impact: string;
};

export type StoryReply =
  | {
      readonly action: "answer";
      readonly group_id: TimelineEntryId;
      readonly number: number;
      readonly answer: string;
    }
  | { readonly action: "accept_defaults"; readonly group_id: TimelineEntryId };

export type StoryDiscussion =
  | { readonly action: "ask"; readonly questions: readonly StoryQuestion[] }
  | StoryReply
  | { readonly action: "propose" };

export interface StoryQuestionGroup {
  readonly id: TimelineEntryId;
  readonly questions: readonly (StoryQuestion & {
    readonly resolution?: {
      readonly source: "answer" | "accepted_default" | "proposal_default";
      readonly value: string;
      readonly entry_id: TimelineEntryId;
    };
  })[];
}

export interface StoryState {
  readonly summary_entry_id?: TimelineEntryId;
  readonly question_groups?: readonly StoryQuestionGroup[];
}

/** One round per group with a real human response, never per question or implicit default. */
export function storyDiscussionRounds(story: StoryState) {
  return (story.question_groups ?? []).filter((group) =>
    group.questions.some(
      (q) => q.resolution && q.resolution.source !== "proposal_default",
    ),
  ).length;
}
