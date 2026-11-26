import { type ReactNode, useRef, useState } from "react";
import {
  type CardDetail,
  type CardiganClient,
  describeWriteError,
  type WorkItemView,
} from "../api.js";
import {
  exclusionReason,
  requirementParts,
  selectionSummary,
} from "../machine-labels.js";
import { isHttpLink } from "../markdown.js";
import { routeHash } from "../route.js";
import { runPresence } from "../run-presence.js";
import { cardNextSteps } from "./CardNextStep.js";
import { DecisionRouting } from "./DecisionRouting.js";
import { EmployeeIdentity } from "./EmployeeIdentity.js";
import { EmptyState, IdTag, StatusTag, Time } from "./Foundation.js";
import {
  CardDetailInlineOwner,
  DetailFact,
  DetailFactGroup,
  DetailFacts,
} from "./layout/CardDetailLayout.js";
import { DialogFeedback } from "./layout/DialogFeedbackLayout.js";
import { Menu } from "./Menu.js";
import { PRIORITY_LEVELS } from "./Priority.js";
import { RequestFeedback } from "./RequestFeedback.js";
import { templateIdentity } from "./TemplateMarker.js";
import { Button } from "./ui/button.js";
import { Checkbox } from "./ui/checkbox.js";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFields,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.js";
import { RadioChoice } from "./ui/input.js";
import { MoreButton } from "./ui/more-button.js";
import { Prose } from "./ui/prose.js";
import { Textarea } from "./ui/textarea.js";

const OPEN_DECISION = ["open", "provisional", "snoozed"];

/**
 * C-699: the overview's facts column. Status, next owners and blockers live
 * in the status row and “下一步”; only the card's standing facts stay here.
 */
export function CardOverviewFacts({
  detail,
  projectId,
  cardId,
}: {
  detail: CardDetail;
  projectId: string;
  cardId: string;
}) {
  const { card, overview, work_items, relations } = detail;
  const workCount = overview?.work_count ?? work_items.length;
  const completed =
    overview?.completed_work_count ??
    work_items.filter((w) => ["accepted", "passed"].includes(w.status)).length;
  const verifiers =
    overview?.verifiers ??
    work_items
      .filter((w) => w.kind === "verify")
      .map((w) => ({
        ...w,
        verdict: detail.review_matrix.findLast((r) => r.work_item_id === w.id)
          ?.verdict,
      }));
  const dependency = card.dependency;
  const next = cardNextSteps(detail).current;
  const shown = next.kind === "decision" ? next.ref : undefined;
  const link = (anchor: string) =>
    routeHash({ kind: "card", projectId, cardId, anchor });
  const related =
    relations.cards.length +
    relations.pull_requests.length +
    relations.decisions.length;
  const facts: {
    readonly key: string;
    readonly label: string;
    readonly value: ReactNode;
  }[] = [
    {
      key: "template",
      label: "模板",
      value: templateIdentity(card, detail.template).name,
    },
    {
      key: "priority",
      label: "优先级",
      value: PRIORITY_LEVELS[card.priority]?.label ?? "—",
    },
    ...(workCount
      ? [
          {
            key: "work",
            label: "工作项",
            value: `${completed}/${workCount} 完成`,
          },
        ]
      : []),
    ...(verifiers.length
      ? [
          {
            key: "verify",
            label: "验收",
            value: verifiers.map((w) => (
              <DetailFactGroup key={w.id}>
                <IdTag
                  id={w.id}
                  label={w.title ?? w.role_id}
                  href={link(`work-item-${w.id}`)}
                />{" "}
                {w.verdict ? <StatusTag status={w.verdict} /> : "未结论"}
              </DetailFactGroup>
            )),
          },
        ]
      : []),
    ...(dependency &&
    (dependency.predecessors.length || dependency.successors.length)
      ? [
          {
            key: "dependency",
            label: "依赖",
            value: (
              <>
                <span>前置 {dependency.predecessors.length}</span>
                <span>后续 {dependency.successors.length}</span>
                <span>最长链 {dependency.critical_path_length}</span>
              </>
            ),
          },
        ]
      : []),
    { key: "created", label: "创建", value: <Time value={card.created_at} /> },
    {
      key: "related",
      label: "关联",
      value: related ? (
        <>
          {relations.cards.map((c) => (
            <IdTag
              key={c.id}
              id={c.id}
              label=""
              detail={`${c.id} ${c.title}`}
              href={routeHash({ kind: "card", projectId, cardId: c.id })}
            />
          ))}
          {relations.pull_requests.map((p) =>
            isHttpLink(p.pr_url) ? (
              <a
                key={p.delivery_id}
                href={p.pr_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {p.pr_url}
              </a>
            ) : (
              <span key={p.delivery_id} className="plain-url">
                {p.pr_url}
              </span>
            ),
          )}
          {relations.decisions.map((d) => {
            const open = detail.decisions.find(
              (q) => q.id === d.id && OPEN_DECISION.includes(q.status),
            );
            return (
              // Deep links to a decision land here when its timeline entry is
              // not on the loaded page.
              <DetailFactGroup
                key={d.id}
                id={
                  detail.timeline.some((e) => e.decision_id === d.id)
                    ? `decision-summary-${d.id}`
                    : `decision-${d.id}`
                }
              >
                <IdTag
                  id={d.id}
                  detail={`${d.id} ${d.question}`}
                  href={link(`decision-${d.id}`)}
                />
                {/* The decision “下一步” shows already says its own reason. */}
                {open && open.id !== shown && (
                  <DecisionRouting decision={open} />
                )}
              </DetailFactGroup>
            );
          })}
        </>
      ) : (
        "—"
      ),
    },
  ];
  return (
    <DetailFacts compact>
      {facts.map((fact) => (
        <DetailFact key={fact.key} label={fact.label}>
          {fact.value}
        </DetailFact>
      ))}
    </DetailFacts>
  );
}

export function CardWorkItems({
  detail,
  projectId,
  cardId,
  client,
  changed,
}: {
  detail: CardDetail;
  projectId: string;
  cardId: string;
  client?: CardiganClient;
  changed?: () => void;
}) {
  const work_items = detail.work_items;
  const completed = work_items.filter((item) =>
    ["accepted", "passed"].includes(item.status),
  ).length;
  const link = (anchor: string) =>
    routeHash({ kind: "card", projectId, cardId, anchor });
  // C-778: the template's primary slot can move to another open producer.
  const primaryKey = detail.template?.primary_work_item_key ?? null;
  const replaceable =
    !!client &&
    primaryKey !== null &&
    !["done", "cancelled", "awaiting_merge"].includes(detail.card.status);
  const successors = work_items.filter(
    (w) =>
      w.kind === "produce" &&
      w.template_key === undefined &&
      w.status !== "cancelled" &&
      !w.replaced_by_work_item_id,
  );
  return (
    <section className="card-section" aria-label="工作项">
      <div className="work-items">
        <p>
          已完成 {completed}/{work_items.length}
        </p>
        {!work_items.length && <EmptyState>这张卡还没有工作项。</EmptyState>}
        <ul className="work-item-list">
          {work_items.map((item) => {
            const delivery = [
              ...(detail.work_delivery_links ?? detail.deliveries),
            ]
              .reverse()
              .find(
                (d) => d.work_item_id === item.id && d.status !== "superseded",
              );
            return (
              <li
                key={item.id}
                id={`work-item-${item.id}`}
                className="work-item"
              >
                <details>
                  <summary>
                    <span className="work-item-caption">
                      <IdTag id={item.id} label={item.title} />{" "}
                      <StatusTag
                        status={
                          item.verification_activity?.status ?? item.status
                        }
                        {...(item.verification_activity
                          ? { label: item.verification_activity.label }
                          : {})}
                      />
                      {item.manual_assign &&
                        item.verification_activity?.status !==
                          "manual_assign" && <span>手动指派</span>}
                    </span>
                  </summary>
                  <p>
                    {item.assignee && (
                      <>
                        <CardDetailInlineOwner>
                          <EmployeeIdentity
                            {...item.assignee}
                            showTitle={false}
                            avatarSize={24}
                            presence={runPresence(item.run_presence)}
                          />
                        </CardDetailInlineOwner>{" "}
                      </>
                    )}
                    {item.assignment_id ? (
                      <IdTag id={item.assignment_id} label={item.role_id} />
                    ) : (
                      `尚未指派 ${item.role_id}`
                    )}
                  </p>
                  <MachinePlacement item={item} />
                  {client &&
                    !["done", "cancelled"].includes(detail.card.status) && (
                      <ManualAssignControl
                        key={`${item.id}:${item.manual_assign}`}
                        item={item}
                        client={client}
                        projectId={projectId}
                        changed={changed}
                      />
                    )}
                  {client &&
                    replaceable &&
                    primaryKey !== null &&
                    item.kind === "produce" &&
                    item.template_key === primaryKey &&
                    successors.length > 0 && (
                      <PrimaryReplacement
                        item={item}
                        cardId={detail.card.id}
                        templateKey={primaryKey}
                        successors={successors}
                        client={client}
                        projectId={projectId}
                        changed={changed}
                      />
                    )}
                  {delivery && (
                    <p>
                      <IdTag
                        id={delivery.id}
                        label="交付"
                        href={link(`delivery-${delivery.id}`)}
                      />{" "}
                      <StatusTag status={delivery.status} />
                    </p>
                  )}
                  <Prose text={item.completion_criteria.join("；")}>
                    <p>
                      依据：
                      {item.completion_criteria.join("；") || "未列出验收依据"}
                    </p>
                  </Prose>
                </details>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/** MC-5: what the work item asks of a machine and where it was placed, and why. */
function MachinePlacement({ item }: { readonly item: WorkItemView }) {
  const requirements = requirementParts(item.requirements);
  const selection = item.machine_selection;
  const excluded =
    selection && selection.status !== "deferred"
      ? (selection.excluded ?? [])
      : [];
  return (
    <>
      {requirements.length > 0 && <p>运行需求：{requirements.join("；")}</p>}
      {selection && (
        <p>
          选机：{selectionSummary(selection)}
          {selection.status !== "deferred" && (
            <>
              {" "}
              <Time value={selection.at} />
            </>
          )}
        </p>
      )}
      {excluded.length > 0 && (
        <ul className="plain-list" aria-label={`${item.id} 未选机器`}>
          {excluded.map((machine) => (
            <li key={machine.machine_id}>
              未选 {machine.machine_id}：
              {machine.reasons.map(exclusionReason).join("；")}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * C-778: “替换为…” moves the primary production slot; writing happens only
 * when the dialog is confirmed.
 */
function PrimaryReplacement({
  item,
  cardId,
  templateKey,
  successors,
  client,
  projectId,
  changed,
}: {
  item: WorkItemView;
  cardId: string;
  templateKey: string;
  successors: readonly WorkItemView[];
  client: CardiganClient;
  projectId: string;
  changed?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const more = useRef<HTMLButtonElement>(null);
  const opening = useRef(false);
  // Retain the key of an uncertain request so a retry stays idempotent.
  const keys = useRef(new Map<string, string>());
  const valid =
    successors.some((w) => w.id === target) && reason.trim().length > 0;
  const title = `替换主产出项 ${item.id}`;
  return (
    <>
      <Menu
        label={`${item.id} 工作项操作`}
        onCloseAutoFocus={(event) => {
          if (opening.current) {
            event.preventDefault();
            opening.current = false;
          }
        }}
        trigger={<MoreButton ref={more} label={`${item.id} 工作项操作`} />}
        items={[
          {
            id: "replace-primary",
            label: "替换为…",
            onSelect: () => {
              opening.current = true;
              setError("");
              setOpen(true);
            },
          },
        ]}
      />
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !pending) setOpen(false);
        }}
      >
        {open && (
          <DialogContent
            aria-describedby={undefined}
            onEscapeKeyDown={(event) => {
              if (pending) event.preventDefault();
            }}
            onInteractOutside={(event) => {
              if (pending) event.preventDefault();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              more.current?.focus();
            }}
          >
            <form
              aria-label={title}
              onSubmit={async (event) => {
                event.preventDefault();
                if (pending || !valid) return;
                const input = {
                  replacement_work_item_id: target,
                  card_id: cardId,
                  template_key: templateKey,
                  reason: reason.trim(),
                };
                const request = JSON.stringify(input);
                const key = keys.current.get(request) ?? crypto.randomUUID();
                keys.current.set(request, key);
                setPending(true);
                setError("");
                try {
                  await client.replacePrimaryWorkItem(
                    projectId,
                    item.id,
                    input,
                    key,
                  );
                  keys.current.delete(request);
                  setOpen(false);
                  changed?.();
                } catch (failure) {
                  setError(describeWriteError(failure));
                } finally {
                  setPending(false);
                }
              }}
            >
              <DialogHeader>
                <DialogTitle>{title}</DialogTitle>
              </DialogHeader>
              <DialogBody>
                <DialogFields>
                  <fieldset disabled={pending}>
                    <legend>替换为</legend>
                    {successors.map((w) => (
                      <RadioChoice
                        key={w.id}
                        name={`replace-${item.id}`}
                        checked={target === w.id}
                        onChange={() => setTarget(w.id)}
                      >
                        {w.id} {w.title}（{w.role_id}）
                      </RadioChoice>
                    ))}
                  </fieldset>
                  <label>
                    替换原因
                    <Textarea
                      required
                      rows={3}
                      value={reason}
                      disabled={pending}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                </DialogFields>
                <DialogFeedback>
                  <RequestFeedback
                    interactive
                    pending={pending}
                    pendingMessage="正在提交…"
                    error={error}
                  />
                </DialogFeedback>
              </DialogBody>
              <DialogFooter>
                <DialogClose asChild>
                  <Button size="regular" disabled={pending}>
                    取消
                  </Button>
                </DialogClose>
                <Button
                  type="submit"
                  size="regular"
                  variant="destructive"
                  disabled={!valid || pending}
                >
                  确认替换
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

function ManualAssignControl({
  item,
  client,
  projectId,
  changed,
}: {
  item: WorkItemView;
  client: CardiganClient;
  projectId: string;
  changed?: (() => void) | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div>
      <label>
        <Checkbox
          checked={item.manual_assign === true}
          disabled={busy}
          onCheckedChange={async (checked) => {
            const enabled = checked === true;
            setBusy(true);
            setError("");
            try {
              await client.setManualAssign(
                projectId,
                item.id,
                enabled,
                crypto.randomUUID(),
              );
              changed?.();
            } catch (failure) {
              setError(describeWriteError(failure));
            } finally {
              setBusy(false);
            }
          }}
        />
        手动指派（跳过自动指派和催办）
      </label>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
