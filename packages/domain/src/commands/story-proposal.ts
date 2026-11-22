import type { Actor, Card } from "../entities.js";
import type { CardId } from "../ids.js";
import { storyTerminal } from "../story.js";
import {
  currentStoryProposal,
  type StoryProposal,
} from "../story-discussion.js";
import { requireCardDependencyStart } from "./card-dependencies.js";
import { type CommandPorts, type CommandState, ensure } from "./core.js";
import { createCardInDraft } from "./pm.js";
import {
  checkStoryChild,
  storyChildForm,
  storyProposalOrder,
} from "./story-discussion.js";
import { commandWithReadyVerifiers as command } from "./system-rules.js";

export interface ConfirmStoryProposalParams {
  readonly card_id: CardId;
  /** The version the human saw; any other version is refused. */
  readonly version: number;
}

export interface ConfirmStoryProposalResult {
  readonly card_id: CardId;
  readonly version: number;
  readonly card_ids: readonly CardId[];
  /** True when this version had already been confirmed: nothing was opened. */
  readonly replayed: boolean;
}

/**
 * C-503: the human's one confirmation of the current proposal opens every child
 * card in this one transaction. Any refusal rolls all of them back. Only the
 * human may confirm; PM, Office, delegation and accepted defaults never do.
 */
export function confirmStoryProposal(
  state: CommandState,
  actor: Actor,
  p: ConfirmStoryProposalParams,
  ports: CommandPorts,
) {
  return command(
    state,
    actor,
    "confirm_story_proposal",
    ports,
    (d): ConfirmStoryProposalResult => {
      ensure(
        d.actor.kind === "human",
        "unauthorized",
        "只有人能确认拆解方案并开卡",
      );
      const story = d.card(p.card_id);
      ensure(story.story, "validation_failed", "只有需求卡有拆解方案");
      const current = currentStoryProposal(story.story);
      ensure(current, "illegal_transition", "需求卡还没有可确认的拆解方案");
      ensure(
        Number.isSafeInteger(p.version) && p.version === current.version,
        "stale_target",
        `拆解方案已更新到第 ${current.version} 版，请刷新后再确认`,
        { current_version: current.version },
      );
      if (current.confirmed)
        return {
          card_id: story.id,
          version: current.version,
          card_ids: current.confirmed.card_ids,
          replayed: true,
        };
      ensure(
        !storyTerminal(story),
        "illegal_transition",
        "需求卡已结束，不能再开子卡",
      );
      ensure(
        !story.hold && story.status !== "backlog",
        "illegal_transition",
        "需求卡尚未排期或已暂停",
      );
      requireCardDependencyStart(d, story);
      const created = openChildren(d, story, current);
      const card_ids = created.map((c) => c.id);
      const latest = d.card(story.id);
      const event = d.emit(
        "story_proposal_confirmed",
        story.id,
        { version: current.version, card_ids },
        {
          type: "status_change",
          body: `已确认拆解方案第 ${current.version} 版，开出 ${card_ids.length} 张子卡：${card_ids.join("、")}`,
          refs: [
            { kind: "timeline_entry", id: current.entry_id },
            ...card_ids.map((id) => ({ kind: "card" as const, id })),
          ],
        },
      );
      // Sequences are per card: match the story card as well, not a child's notice.
      const entry = d.timeline.find(
        (e) => e.card_id === story.id && e.event_seq === event.seq,
      );
      ensure(entry, "invariant_violation", "缺少确认记录");
      d.put("cards", {
        ...latest,
        story: {
          ...latest.story,
          proposals: (latest.story?.proposals ?? []).map((proposal) =>
            proposal.version === current.version
              ? {
                  ...proposal,
                  confirmed: { at: d.now, entry_id: entry.id, card_ids },
                }
              : proposal,
          ),
        },
      });
      return {
        card_id: story.id,
        version: current.version,
        card_ids,
        replayed: false,
      };
    },
  );
}

function openChildren(
  d: Parameters<typeof createCardInDraft>[0],
  story: Card,
  proposal: StoryProposal,
): Card[] {
  const order = storyProposalOrder(proposal.children);
  ensure(
    order.length === proposal.children.length,
    "validation_failed",
    "拆解方案的子卡依赖不能成环",
  );
  const opened = new Map<number, Card>();
  for (const index of order) {
    const child = proposal.children[index];
    ensure(child, "invariant_violation", "拆解方案子卡缺失");
    const number = index + 1;
    const siblings = child.depends_on.map((k) => {
      const card = opened.get(k - 1);
      ensure(card, "invariant_violation", "依赖的子卡尚未创建");
      return card.id;
    });
    const depends_on_cards = [...siblings, ...(child.depends_on_cards ?? [])];
    // Name the child on refusal; the whole confirmation still rolls back.
    const card = checkStoryChild(number, child.title, () =>
      createCardInDraft(
        d,
        {
          ...storyChildForm(
            story.id,
            child,
            `需求卡 ${story.id} 拆解方案第 ${proposal.version} 版第 ${number} 张（${proposal.entry_id}）`,
          ),
          story_source: {
            card_id: story.id,
            version: proposal.version,
            entry_id: proposal.entry_id,
            number,
          },
          ...(depends_on_cards.length ? { depends_on_cards } : {}),
        },
        { registered_repo_only: true },
      ),
    );
    opened.set(index, card);
  }
  // Proposal order: card_ids[i] is the card opened for child i + 1.
  return proposal.children.map((_, i) => {
    const card = opened.get(i);
    ensure(card, "invariant_violation", "拆解方案子卡缺失");
    return card;
  });
}
