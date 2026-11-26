import type { StoryQuestionGroup, StoryReply } from "@cardigan/domain";
import { useEffect, useRef, useState } from "react";
import {
  type CardiganClient,
  type CardView,
  describeWriteError,
} from "../api.js";
import { referenceHref } from "../refs.js";
import { IdTag } from "./IdTag.js";
import {
  ChecklistActions,
  ChecklistField,
  ChecklistItem,
  ChecklistNote,
  ChecklistPanel,
  ChecklistSection,
} from "./layout/ChecklistLayout.js";
import { RequestFeedback } from "./RequestFeedback.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { useDraftLeaveGuard } from "./useDraftLeaveGuard.js";

/** How a question was settled (also listed in the story overview). */
export const STORY_RESOLUTION_LABELS = {
  answer: "已回答",
  accepted_default: "已接受默认",
  proposal_default: "未答，方案按默认",
} as const;

export function StoryDiscussion({
  story,
  closed,
  client,
  projectId,
  cardId,
  reload,
}: {
  story: NonNullable<CardView["story"]>;
  closed: boolean;
  client: CardiganClient;
  projectId: string;
  cardId: string;
  reload: () => void;
}) {
  return (
    <ChecklistSection
      label="需求澄清"
      title={`需求澄清 · ${story.discussion_rounds ?? 0} 轮`}
    >
      {story.question_groups?.map((group) => (
        <QuestionGroup
          key={group.id}
          group={group}
          href={referenceHref(
            { kind: "timeline_entry", id: group.id },
            projectId,
            cardId,
          )}
          closed={closed}
          projectId={projectId}
          cardId={cardId}
          submit={async (reply, key) => {
            await client.addComment(
              projectId,
              cardId,
              {
                body:
                  reply.action === "accept_defaults"
                    ? "清单按默认"
                    : "提交回答",
                story_discussion: reply,
              },
              key,
            );
            reload();
          }}
        />
      ))}
    </ChecklistSection>
  );
}

/**
 * C-715: unsent answers survive the ways out a page cannot intercept (browser
 * back/forward); every other way out asks first. Keyed by card and checklist.
 */
const drafts = new Map<string, Record<number, string>>();

function QuestionGroup({
  group,
  href,
  closed,
  projectId,
  cardId,
  submit,
}: {
  group: StoryQuestionGroup;
  href: string | undefined;
  closed: boolean;
  projectId: string;
  cardId: string;
  submit: (reply: StoryReply, key: string) => Promise<void>;
}) {
  const draftId = `${projectId}/${cardId}/${group.id}`;
  const [answers, setAnswers] = useState(() => drafts.get(draftId) ?? {});
  const [busy, setBusy] = useState(false),
    [sent, setSent] = useState(false),
    [error, setError] = useState("");
  const retryKeys = useRef(new Map<string, string>());
  const open = group.questions.flatMap((q, i) => (q.resolution ? [] : [i + 1]));
  const filled = open.flatMap((number) => {
    const answer = (answers[number] ?? "").trim();
    return answer ? [{ number, answer }] : [];
  });
  const editable = !closed && !sent && open.length > 0;
  const forget = () => drafts.delete(draftId);
  const { ask, dialog } = useDraftLeaveGuard(
    editable && filled.length > 0,
    projectId,
    cardId,
    forget,
    "放弃未提交的回答？",
  );
  useEffect(() => {
    if (editable && Object.values(answers).some((a) => a.trim()))
      drafts.set(draftId, answers);
    else drafts.delete(draftId);
  }, [draftId, editable, answers]);
  async function send(reply: StoryReply) {
    if (busy || sent) return;
    setBusy(true);
    setError("");
    const payload = JSON.stringify(reply),
      key = retryKeys.current.get(payload) ?? crypto.randomUUID();
    retryKeys.current.set(payload, key);
    try {
      await submit(reply, key);
      retryKeys.current.delete(payload);
      forget();
      // Locked until the reloaded checklist shows the server's resolutions.
      setSent(true);
    } catch (e) {
      setError(describeWriteError(e));
    } finally {
      setBusy(false);
    }
  }
  const defaults = open.length - filled.length;
  return (
    <>
      <ChecklistPanel
        disabled={busy || (sent && open.length > 0)}
        title={
          <>
            问题清单 <IdTag id={group.id} label="" href={href} />
          </>
        }
        actions={
          !closed &&
          open.length > 0 && (
            <ChecklistActions>
              <Button
                variant="primary"
                onClick={() =>
                  void send({
                    action: "submit_answers",
                    group_id: group.id,
                    answers: filled,
                  })
                }
              >
                提交
              </Button>
              {defaults > 0 && (
                <ChecklistNote>{defaults} 题按推荐</ChecklistNote>
              )}
              <Button
                variant="outline"
                onClick={() =>
                  ask(
                    () =>
                      void send({
                        action: "accept_defaults",
                        group_id: group.id,
                      }),
                  )
                }
              >
                整组按默认
              </Button>
            </ChecklistActions>
          )
        }
      >
        {group.questions.map((q, i) => {
          const number = i + 1;
          return (
            <ChecklistItem
              key={`${group.id}-${number}`}
              title={q.question}
              context={
                <>
                  推荐：{q.recommended} · 影响：{q.impact}
                </>
              }
            >
              {q.resolution ? (
                <p>
                  {STORY_RESOLUTION_LABELS[q.resolution.source]}：
                  {q.resolution.value}
                </p>
              ) : (
                !closed && (
                  <ChecklistField>
                    <Input
                      aria-label={`第 ${number} 题回答`}
                      value={answers[number] ?? ""}
                      onChange={(e) =>
                        setAnswers({ ...answers, [number]: e.target.value })
                      }
                    />
                  </ChecklistField>
                )
              )}
            </ChecklistItem>
          );
        })}
      </ChecklistPanel>
      {error && <RequestFeedback error={error} />}
      {dialog}
    </>
  );
}
