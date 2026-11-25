import type { CardId, TimelineEntryId } from "./ids.js";

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
  | { readonly action: "accept_defaults"; readonly group_id: TimelineEntryId }
  | {
      /**
       * C-715: the whole checklist in one entry. Every open question not in
       * `answers` takes its recommended default, as with "accept_defaults".
       */
      readonly action: "submit_answers";
      readonly group_id: TimelineEntryId;
      readonly answers: readonly {
        readonly number: number;
        readonly answer: string;
      }[];
    };

export type StoryDiscussion =
  | { readonly action: "ask"; readonly questions: readonly StoryQuestion[] }
  | StoryReply
  | {
      readonly action: "propose";
      /** C-503: a confirmable, versioned proposal; omitted keeps the text-only proposal. */
      readonly children?: readonly StoryProposalChildInput[];
    };

/** One planned child card as the Office submits it. */
export interface StoryProposalChildInput {
  readonly title: string;
  readonly template_id: string;
  readonly goal: string;
  /** At least one non-empty review point. */
  readonly acceptance_criteria: readonly string[];
  /** 1-based numbers of other children in the same proposal. */
  readonly depends_on?: readonly number[];
  /** Existing same-project cards the child waits for. */
  readonly depends_on_cards?: readonly CardId[];
  /**
   * C-733: children with prerequisites wait for them by default (backlog, then
   * todo once all complete); `false` keeps the child in backlog for PM.
   */
  readonly wait_for_dependencies?: boolean;
  readonly priority?: number;
  /** The role expected to own the work; shown for review, not an assignment. */
  readonly owner_role: string;
  readonly state_and_save?: unknown;
  readonly repo?: string;
  readonly base_branch?: string;
}

export type StoryProposalChild = Omit<
  StoryProposalChildInput,
  "acceptance_criteria" | "depends_on" | "priority"
> & {
  readonly acceptance_criteria: readonly string[];
  readonly depends_on: readonly number[];
  readonly priority: number;
};

export interface StoryProposal {
  readonly version: number;
  readonly entry_id: TimelineEntryId;
  readonly submitted_at: string;
  readonly children: readonly StoryProposalChild[];
  /** Written once by the human confirmation that created every child. */
  readonly confirmed?: {
    readonly at: string;
    readonly entry_id: TimelineEntryId;
    readonly card_ids: readonly CardId[];
  };
}

/** The upper bound of children one proposal may open in a single transaction. */
export const STORY_PROPOSAL_MAX_CHILDREN = 50;

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
  /** C-503: every versioned proposal in submission order; only the last is current. */
  readonly proposals?: readonly StoryProposal[];
}

export function currentStoryProposal(
  story: StoryState | undefined,
): StoryProposal | undefined {
  return story?.proposals?.at(-1);
}

/** One round per group with a real human response, never per question or implicit default. */
export function storyDiscussionRounds(story: StoryState) {
  return (story.question_groups ?? []).filter((group) =>
    group.questions.some(
      (q) => q.resolution && q.resolution.source !== "proposal_default",
    ),
  ).length;
}

/**
 * The card-level conditions under which the current proposal may be confirmed
 * (dependency start is checked separately). Shared by the command, Needs You
 * and the Web so none offers an action the server will refuse.
 */
export function storyProposalConfirmable(card: {
  readonly status: string;
  readonly hold?: unknown;
  readonly story?: StoryState;
}): boolean {
  const proposal = currentStoryProposal(card.story);
  return (
    !!proposal &&
    !proposal.confirmed &&
    !card.hold &&
    !["backlog", "done", "cancelled"].includes(card.status)
  );
}
