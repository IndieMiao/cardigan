import type { StoryQuestionGroup, StoryReply } from "@cardigan/domain";
import { useRef, useState } from "react";
import {
  type CardiganClient,
  type CardView,
  describeWriteError,
} from "../api.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";

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
    <section aria-label="需求澄清">
      <h3>需求澄清 · {story.discussion_rounds ?? 0} 轮</h3>
      {story.question_groups?.map((group) => (
        <QuestionGroup
          key={group.id}
          group={group}
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
    </section>
  );
}

function QuestionGroup({
  group,
  closed,
  submit,
}: {
  group: StoryQuestionGroup;
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
    <fieldset disabled={busy}>
      <legend>问题清单 {group.id}</legend>
      <ol>
        {group.questions.map((q, i) => {
          const number = i + 1,
            answer = (drafts[number] ?? "").trim();
          return (
            <li key={`${group.id}-${number}`}>
              <strong>{q.question}</strong>
              <p>
                推荐：{q.recommended} · 影响：{q.impact}
              </p>
              {q.resolution ? (
                <p>
                  {q.resolution.source === "answer" ? "已回答" : "按默认"}：
                  {q.resolution.value}
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
            </li>
          );
        })}
      </ol>
      {!closed && group.questions.some((q) => !q.resolution) && (
        <Button
          variant="outline"
          onClick={() =>
            void send({ action: "accept_defaults", group_id: group.id })
          }
        >
          整组按默认
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
