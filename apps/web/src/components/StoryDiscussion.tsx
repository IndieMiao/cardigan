import type { StoryQuestionGroup, StoryReply } from "@cardigan/domain";
import { useRef, useState } from "react";
import {
  type CardiganClient,
  type CardView,
  describeWriteError,
} from "../api.js";
import { referenceHref } from "../refs.js";
import { IdTag } from "./IdTag.js";
import {
  ChecklistItem,
  ChecklistPanel,
  ChecklistSection,
} from "./layout/ChecklistLayout.js";
import { RequestFeedback } from "./RequestFeedback.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";

const resolutionLabels = {
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
          submit={async (reply, key) => {
            await client.addComment(
              projectId,
              cardId,
              {
                body: reply.action === "answer" ? "回答问题" : "清单按默认",
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

function QuestionGroup({
  group,
  href,
  closed,
  submit,
}: {
  group: StoryQuestionGroup;
  href: string | undefined;
  closed: boolean;
  submit: (reply: StoryReply, key: string) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const retryKeys = useRef(new Map<string, string>());
  async function send(reply: StoryReply) {
    if (busy) return;
    setBusy(true);
    setError("");
    const payload = JSON.stringify(reply),
      key = retryKeys.current.get(payload) ?? crypto.randomUUID();
    retryKeys.current.set(payload, key);
    try {
      await submit(reply, key);
    } catch (e) {
      setError(describeWriteError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ChecklistPanel
        disabled={busy}
        title={
          <>
            问题清单 <IdTag id={group.id} label="" href={href} />
          </>
        }
        actions={
          !closed &&
          group.questions.some((q) => !q.resolution) && (
            <Button
              variant="outline"
              onClick={() =>
                void send({ action: "accept_defaults", group_id: group.id })
              }
            >
              整组按默认
            </Button>
          )
        }
      >
        {group.questions.map((q, i) => {
          const number = i + 1,
            answer = (drafts[number] ?? "").trim();
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
                  {resolutionLabels[q.resolution.source]}：{q.resolution.value}
                </p>
              ) : (
                !closed && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (answer)
                        void send({
                          action: "answer",
                          group_id: group.id,
                          number,
                          answer,
                        });
                    }}
                  >
                    <Input
                      aria-label={`第 ${number} 题回答`}
                      value={drafts[number] ?? ""}
                      onChange={(e) =>
                        setDrafts({ ...drafts, [number]: e.target.value })
                      }
                    />
                    <Button type="submit" variant="outline" disabled={!answer}>
                      回答
                    </Button>
                  </form>
                )
              )}
            </ChecklistItem>
          );
        })}
      </ChecklistPanel>
      {error && <RequestFeedback error={error} />}
    </>
  );
}
