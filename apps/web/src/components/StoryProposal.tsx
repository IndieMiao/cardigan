import { type StoryProposal, storyProposalConfirmable } from "@cardigan/domain";
import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  type CardDetail,
  type CardiganClient,
  describeWriteError,
} from "../api.js";
import { registerLeaveGuard } from "../leave-guard.js";
import { parseRoute, routeHash } from "../route.js";
import { EmptyState, StatusTag } from "./Foundation.js";
import { IdTag } from "./IdTag.js";
import {
  ChecklistActions,
  ChecklistAlert,
  ChecklistDetails,
  ChecklistItem,
  ChecklistPanel,
} from "./layout/ChecklistLayout.js";
import { SettingsDiscardDialog } from "./layout/SettingsLayout.js";
import { Markdown, MarkdownBody } from "./Operations.js";
import { PRIORITY_LEVELS } from "./Priority.js";
import { RequestFeedback } from "./RequestFeedback.js";
import { Button } from "./ui/button.js";
import { Textarea } from "./ui/textarea.js";

/** A failed confirmation, kept beside the proposal it was about. */
export type StoryRefusal = {
  readonly message: string;
  readonly stale: boolean;
};

/** One wording for a refused confirmation, on the story card and in Needs You. */
export function storyRefusal(cause: unknown): StoryRefusal {
  if (cause instanceof ApiError && cause.code === "stale_target")
    return { stale: true, message: "拆解方案已更新，请刷新后再确认" };
  const reason = describeWriteError(cause).replace(/^请求失败：/u, "");
  return { stale: false, message: `开卡失败：${reason}` };
}

/**
 * Drafts survive the ways out a page cannot intercept (browser back/forward)
 * and a new proposal version arriving while writing; every other way out asks
 * first. Keyed by card, so a draft follows the story to its newest version.
 */
const drafts = new Map<string, string>();
const draftKey = (projectId: string, cardId: string) =>
  `${projectId}/${cardId}`;

/**
 * C-503: the story's current decomposition proposal. Only the newest version
 * can be confirmed; one click opens every child card, and a change request is
 * an ordinary comment replying to the proposal.
 */
export function StoryProposalSection({
  detail,
  client,
  projectId,
  cardId,
  onSaved,
}: {
  detail: CardDetail;
  client: CardiganClient;
  projectId: string;
  cardId: string;
  onSaved: () => void;
}) {
  const proposals = detail.card.story?.proposals ?? [];
  const current = proposals.at(-1);
  return (
    <section className="card-purpose" aria-label="拆解方案">
      <h2>拆解方案</h2>
      {current ? (
        <ProposalPanel
          // A new version starts with fresh confirmation state.
          key={current.version}
          proposal={current}
          closed={["done", "cancelled"].includes(detail.card.status)}
          // The same condition the server and Needs You use.
          confirmable={
            storyProposalConfirmable(detail.card) &&
            // Unmet prerequisites without an early start: the server refuses.
            (!!detail.card.early_start ||
              !detail.card.dependency?.waiting_on.length)
          }
          client={client}
          projectId={projectId}
          cardId={cardId}
          onSaved={onSaved}
        />
      ) : (
        <EmptyState>没有拆解方案</EmptyState>
      )}
    </section>
  );
}

function ProposalPanel({
  proposal,
  closed,
  confirmable,
  client,
  projectId,
  cardId,
  onSaved,
}: {
  proposal: StoryProposal;
  closed: boolean;
  confirmable: boolean;
  client: CardiganClient;
  projectId: string;
  cardId: string;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<StoryRefusal>();
  const [message, setMessage] = useState("");
  // A draft written against an earlier version reopens on this one.
  const [commenting, setCommenting] = useState(() =>
    drafts.has(draftKey(projectId, cardId)),
  );
  const sending = useRef(false);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  // One key per version: a retry after a lost reply cannot open cards twice.
  const key = useRef(crypto.randomUUID());
  const confirmed = proposal.confirmed;
  const entryHref = routeHash({
    kind: "card",
    projectId,
    cardId,
    anchor: `entry-${proposal.entry_id}`,
  });
  async function confirm() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setRefusal(undefined);
    try {
      const result = await client.confirmStoryProposal(
        projectId,
        cardId,
        proposal.version,
        key.current,
      );
      setMessage(`已开出 ${result.card_ids.length} 张子卡`);
      onSaved();
    } catch (cause) {
      const refused = storyRefusal(cause);
      setRefusal(refused);
      // A stale version disables confirmation: hand focus to "刷新".
      if (refused.stale)
        requestAnimationFrame(() => refreshButton.current?.focus());
      else confirmButton.current?.focus();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <ChecklistPanel
        // Buttons stay focusable while confirming; see aria-disabled below.
        disabled={false}
        title={
          <>
            第 {proposal.version} 版
            <IdTag id={proposal.entry_id} label="" href={entryHref} />
            {confirmed ? (
              <StatusTag status="resolved" label="已开卡" />
            ) : (
              <StatusTag status="open" label="待确认" />
            )}
          </>
        }
        actions={
          !confirmed &&
          !closed && (
            <>
              {refusal && (
                <ChecklistAlert>
                  <span>{refusal.message}</span>
                  {refusal.stale && (
                    <Button
                      ref={refreshButton}
                      variant="outline"
                      onClick={() => {
                        setRefusal(undefined);
                        onSaved();
                      }}
                    >
                      刷新
                    </Button>
                  )}
                </ChecklistAlert>
              )}
              <ChecklistActions>
                {confirmable && (
                  <Button
                    ref={confirmButton}
                    variant="primary"
                    aria-disabled={busy || undefined}
                    disabled={refusal?.stale}
                    onClick={() => void confirm()}
                    aria-label={`确认开卡：拆解方案第 ${proposal.version} 版`}
                  >
                    确认开卡
                  </Button>
                )}
                {!commenting && (
                  <Button variant="outline" onClick={() => setCommenting(true)}>
                    提修改意见
                  </Button>
                )}
              </ChecklistActions>
            </>
          )
        }
      >
        {proposal.children.map((child, i) => {
          const number = i + 1;
          const opened = confirmed?.card_ids[i];
          const after = [
            ...child.depends_on.map((k) => `第 ${k} 张`),
            ...(child.depends_on_cards ?? []),
          ];
          return (
            <ChecklistItem
              key={number}
              title={
                <>
                  {child.title}
                  {opened && (
                    <>
                      {" "}
                      <IdTag
                        id={opened}
                        label=""
                        href={routeHash({
                          kind: "card",
                          projectId,
                          cardId: opened,
                        })}
                      />
                    </>
                  )}
                </>
              }
              context={[
                `模板 ${child.template_id}`,
                `负责 ${child.owner_role}`,
                `优先级 ${PRIORITY_LEVELS[child.priority]?.label ?? child.priority}`,
                after.length ? `依赖 ${after.join("、")}` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            >
              <ChecklistDetails summary="目标与验收要点">
                <Markdown body={child.goal} />
                {child.acceptance_criteria.length > 0 && (
                  <ul aria-label={`第 ${number} 张验收要点`}>
                    {child.acceptance_criteria.map((criterion) => (
                      <li key={criterion}>
                        <MarkdownBody body={criterion} />
                      </li>
                    ))}
                  </ul>
                )}
              </ChecklistDetails>
            </ChecklistItem>
          );
        })}
      </ChecklistPanel>
      {commenting && !confirmed && !closed && (
        <ChangeRequest
          proposal={proposal}
          client={client}
          projectId={projectId}
          cardId={cardId}
          onClose={() => setCommenting(false)}
          onSent={onSaved}
        />
      )}
      <RequestFeedback message={message} />
    </>
  );
}

/** A change request is a comment replying to the proposal; it is saved on send. */
function ChangeRequest({
  proposal,
  client,
  projectId,
  cardId,
  onClose,
  onSent,
}: {
  proposal: StoryProposal;
  client: CardiganClient;
  projectId: string;
  cardId: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const draftId = draftKey(projectId, cardId);
  const [body, setBody] = useState(() => drafts.get(draftId) ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const sending = useRef(false);
  const keys = useRef(new Map<string, string>());
  const field = useRef<HTMLTextAreaElement>(null);
  const dirty = body.trim().length > 0;
  const { ask, dialog } = useLeaveGuard(dirty, projectId, cardId, () =>
    drafts.delete(draftId),
  );
  useEffect(() => field.current?.focus(), []);
  useEffect(() => {
    if (body) drafts.set(draftId, body);
    else drafts.delete(draftId);
  }, [draftId, body]);
  const discard = () => {
    drafts.delete(draftId);
    onClose();
  };
  return (
    <form
      className="card-action-form"
      aria-label={`对拆解方案第 ${proposal.version} 版提修改意见`}
      onSubmit={async (event) => {
        event.preventDefault();
        const text = body.trim();
        if (sending.current || !text) return;
        sending.current = true;
        setBusy(true);
        setError("");
        const input = {
          body: `对拆解方案第 ${proposal.version} 版的修改意见：\n\n${text}`,
          reply_to: proposal.entry_id,
        };
        const payload = JSON.stringify(input);
        const key = keys.current.get(payload) ?? crypto.randomUUID();
        keys.current.set(payload, key);
        try {
          await client.addComment(projectId, cardId, input, key);
          keys.current.delete(payload);
          drafts.delete(draftId);
          setBody("");
          setMessage("修改意见已发送");
          onSent();
          onClose();
        } catch (cause) {
          setError(describeWriteError(cause));
        } finally {
          sending.current = false;
          setBusy(false);
        }
      }}
    >
      <fieldset disabled={busy}>
        <label>
          修改意见
          <Textarea
            ref={field}
            required
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        {error && (
          <ChecklistAlert>
            <span>发送失败：{error}</span>
          </ChecklistAlert>
        )}
        <div className="card-action-buttons">
          <Button type="submit" disabled={!dirty}>
            发送意见
          </Button>
          <Button type="button" variant="ghost" onClick={() => ask(discard)}>
            取消
          </Button>
        </div>
      </fieldset>
      <RequestFeedback message={message} />
      {dialog}
    </form>
  );
}

/**
 * An unsent change request: closing or reloading the tab asks through the
 * browser; links to another page and "取消" ask through the dialog.
 */
function useLeaveGuard(
  dirty: boolean,
  projectId: string,
  cardId: string,
  forget: () => void,
) {
  const forgetRef = useRef(forget);
  forgetRef.current = forget;
  const [pending, setPending] = useState<() => void>();
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    const click = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[href^='#']")
          : null;
      if (!link || link.target === "_blank") return;
      const href = link.getAttribute("href") ?? "";
      const route = parseRoute(href);
      // Anchors within this card keep the page and the draft.
      if (
        route &&
        route.projectId === projectId &&
        ((route.kind === "card" && route.cardId === cardId) ||
          route.filters?.card === cardId)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setPending(() => () => {
        forgetRef.current();
        window.location.hash = href;
      });
    };
    // Closing the card drawer (button, Escape, outside click) asks too.
    const unregister = registerLeaveGuard((leave) => {
      setPending(() => () => {
        forgetRef.current();
        leave();
      });
      return true;
    });
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", click, true);
    return () => {
      unregister();
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", click, true);
    };
  }, [dirty, projectId, cardId]);
  const ask = (leave: () => void) => {
    if (dirty) setPending(() => leave);
    else leave();
  };
  const dialog = (
    <SettingsDiscardDialog
      title="放弃未发送的修改意见？"
      open={pending !== undefined}
      onKeep={() => setPending(undefined)}
      onDiscard={() => {
        const leave = pending;
        setPending(undefined);
        leave?.();
      }}
    />
  );
  return { ask, dialog };
}
