import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ApiError,
  type CardDetail,
  type CardiganClient,
  type CardPanel,
  type CardReadOptions,
  describeError,
  type PostedComment,
} from "../api.js";
import { AttachmentGrid } from "../components/AttachmentGrid.js";
import { AuthorPrechecks } from "../components/AuthorPrechecks.js";
import { CardActions } from "../components/CardActions.js";
import { CardDependencies } from "../components/CardDependencies.js";
import {
  CardRiskTags,
  CardSource,
  RecentConclusions,
} from "../components/CardIntro.js";
import {
  CardNextStep,
  type NextStepTarget,
} from "../components/CardNextStep.js";
import { CardRecords } from "../components/CardRecords.js";
import { CardSectionNav } from "../components/CardSectionNav.js";
import { CardSidebar, CardWorkItems } from "../components/CardSidebar.js";
import { CardSuperseded } from "../components/CardSuperseded.js";
import { CardTemplate } from "../components/CardTemplate.js";
import { CommentBox } from "../components/CommentBox.js";
import { DecisionRouting } from "../components/DecisionRouting.js";
import {
  EmptyState,
  IdTag,
  LongContent,
  PageTitle,
  StatusTag,
  Time,
} from "../components/Foundation.js";
import {
  CardActionDockSlot,
  CardDetailHeading,
  CardDetailLayout,
  DetailNextStepForms,
  DetailStatusRow,
} from "../components/layout/CardDetailLayout.js";
import { CardBatchChecks } from "../components/MergeBatch.js";
import { MergeBlockers } from "../components/MergeBlockers.js";
import { MergeBlockingControl } from "../components/MergeBlockingControl.js";
import { Markdown, MarkdownBody } from "../components/Operations.js";
import { DecisionContext, PlainSummary } from "../components/PlainSummary.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { StoryDiscussion } from "../components/StoryDiscussion.js";
import {
  StoryOverview,
  useStoryAttachments,
} from "../components/StoryOverview.js";
import { TemplateMarker } from "../components/TemplateMarker.js";
import { Timeline } from "../components/Timeline.js";
import {
  TimelineControls,
  TimelinePager,
} from "../components/TimelineControls.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { routeHash, useRouteFilters } from "../route.js";
import { SUGGESTION_COPY } from "../suggestion-copy.js";
import { useAttachmentRefsState } from "../useAttachmentRefs.js";
import { useResource } from "../useResource.js";
import { MergeConfirmation, SuggestedDecision } from "./NeedsYouPage.js";

/** Timeline entries per read; older pages load as the reader scrolls. */
const PAGE_SIZE = 20;
/** C-696: how long “C-xx 已完成” stays after marking a card done. */
const DONE_NOTICE_MS = 4000;
type PagerStatus = { loading: true } | { error: string } | undefined;
const historyKey = (
  projectId: string,
  cardId: string,
  options: CardReadOptions,
) =>
  JSON.stringify([
    projectId,
    cardId,
    options.at,
    options.type,
    options.author,
    options.limit,
  ]);
/** One newest-first timeline without duplicate rows. */
const mergeTimeline = (
  ...pages: CardDetail["timeline"][]
): CardDetail["timeline"] =>
  [...new Map(pages.flat().map((entry) => [entry.id, entry])).values()].sort(
    (a, b) => b.event_seq - a.event_seq,
  );
/** Other cards' attachments of two pages, the newer read winning. */
const mergeReferenced = (
  current: CardDetail["referenced_attachments"],
  older: CardDetail["referenced_attachments"],
): NonNullable<CardDetail["referenced_attachments"]> => [
  ...new Map(
    [...(older ?? []), ...(current ?? [])].map((a) => [a.id, a]),
  ).values(),
];

export interface CardDetailPageProps {
  readonly client: CardiganClient;
  readonly projectId: string;
  readonly cardId: string;
  readonly anchor?: string;
  /** Embedded in a drawer: do not auto-scroll to the latest timeline entry. */
  readonly inDrawer?: boolean;
  readonly revision?: number;
  readonly onTitleChange?: (title: string, detail: CardDetail) => void;
  /** Include the displayed decision impact in the shared project's live revision. */
  readonly cardRevision?: (
    id: string,
    affectedCards: readonly string[],
  ) => number;
}
export function CardDetailPage(props: CardDetailPageProps) {
  const {
    client,
    projectId,
    cardId,
    anchor: routeAnchor,
    inDrawer = false,
    revision = 0,
    cardRevision,
    onTitleChange,
  } = props;
  const [affectedCards, setAffectedCards] = useState<readonly string[]>([]);
  // C-615: cards whose attachments this page shows as chips; their events
  // (say, turning sensitive) refresh this page too.
  const [referencedCards, setReferencedCards] = useState<readonly string[]>([]);
  const [routeFilters] = useRouteFilters({ kind: "card", projectId, cardId });
  const routeLocation = `${projectId}/${cardId}/${routeAnchor ?? ""}/${routeFilters.type ?? ""}/${routeFilters.author ?? ""}`;
  const [localAnchor, setLocalAnchor] = useState<{
    id: string | undefined;
    routeLocation: string;
  }>();
  const anchor =
    localAnchor?.routeLocation === routeLocation ? localAnchor.id : routeAnchor;
  useEffect(() => {
    setLocalAnchor((current) =>
      current?.routeLocation === routeLocation ? current : undefined,
    );
  }, [routeLocation]);
  const locate = (id: string | undefined) =>
    setLocalAnchor({ id, routeLocation });
  const query = useRef<CardReadOptions>({
    limit: PAGE_SIZE,
    ...(anchor ? { at: anchor } : {}),
    ...(routeFilters.type ? { type: routeFilters.type } : {}),
    ...(routeFilters.author ? { author: routeFilters.author } : {}),
  });
  const history = useRef<
    | { key: string; detail: CardDetail; head?: CardDetail | undefined }
    | undefined
  >(undefined);
  const loadGeneration = useRef(0);
  // Older pages follow only a head read for the current query; after a filter,
  // anchor or card change the old snapshot's cursor must not be paged.
  const [pagerReady, setPagerReady] = useState(false);
  const previousFilters = useRef(
    `${routeFilters.type ?? ""}/${routeFilters.author ?? ""}`,
  );
  const load = useCallback(async () => {
    try {
      const request = ++loadGeneration.current;
      const options = { ...query.current };
      const key = historyKey(projectId, cardId, options);
      // Explicit deep links retain the complete anchor window and its lookups.
      const detail = await client.card(
        projectId,
        cardId,
        client.cardPanel && !options.at
          ? { ...options, section: "overview" }
          : options,
      );
      // Read after the response: an older page may have landed meanwhile.
      const previous =
        history.current?.key === key ? history.current.detail : undefined;
      // C-688: an unchanged head (304) keeps the shown history as it is.
      if (previous && history.current?.head === detail) {
        if (request === loadGeneration.current) setPagerReady(true);
        return previous;
      }
      // A disconnected refresh can skip an entire page. Keep cached history only
      // when the new window connects to it; otherwise restart from its cursor.
      const connected = detail.timeline.some((entry) =>
        previous?.timeline.some((old) => old.id === entry.id),
      );
      const merged =
        previous && connected && detail.timeline_next_cursor !== undefined
          ? {
              ...detail,
              timeline: mergeTimeline(previous.timeline, detail.timeline),
              timeline_next_cursor: previous.timeline_next_cursor ?? null,
            }
          : detail;
      if (request === loadGeneration.current) {
        history.current = { key, detail: merged, head: detail };
        setPagerReady(true);
      }
      return merged;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }, [client, projectId, cardId]);
  const { data, error, reload, pending, interactive, replace } = useResource(
    load,
    cardRevision ? cardRevision(cardId, affectedCards) : revision,
  );
  // Older pages are read beside the live head refresh: at most one at a time,
  // dropped when filters, anchors or the card change while it is in flight.
  const [pager, setPager] = useState<PagerStatus>();
  const paging = useRef<object | undefined>(undefined);
  // Reads still in flight by exact request, kept across resets: returning to a
  // query joins its pending page instead of asking for the same page again.
  const inflight = useRef(new Map<string, Promise<CardDetail>>());
  const resetPaging = useCallback(() => {
    paging.current = undefined;
    setPager(undefined);
    setPagerReady(false);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the card identity is the reset signal.
  useEffect(resetPaging, [projectId, cardId, resetPaging]);
  /** Starts or joins one older-page read; false when there is nothing to read. */
  const loadOlder = useCallback(() => {
    const base = history.current;
    if (paging.current || !base) return false;
    const { timeline, timeline_next_cursor: cursor, counts } = base.detail;
    if (
      cursor === null ||
      (cursor === undefined && timeline.length >= counts.timeline)
    )
      return false;
    const token = {};
    paging.current = token;
    setPager({ loading: true });
    const head = { ...query.current };
    // Servers without cursors widen the head window instead.
    const options =
      cursor === undefined
        ? {
            ...head,
            limit:
              Math.max(head.limit ?? PAGE_SIZE, timeline.length) + PAGE_SIZE,
          }
        : { ...head, before: cursor, limit: PAGE_SIZE };
    const id = JSON.stringify([projectId, cardId, options]);
    let read = inflight.current.get(id);
    if (!read) {
      const started = client.card(
        projectId,
        cardId,
        base.detail.overview ? { ...options, section: "overview" } : options,
      );
      const settle = () => {
        if (inflight.current.get(id) === started) inflight.current.delete(id);
      };
      started.then(settle, settle);
      inflight.current.set(id, started);
      read = started;
    }
    const { key } = base;
    void (async () => {
      try {
        const detail = await read;
        if (paging.current !== token) return;
        const latest = history.current;
        if (cursor === undefined) {
          if (latest?.key === key) {
            query.current = { ...query.current, limit: options.limit };
            history.current = {
              key: historyKey(projectId, cardId, options),
              detail,
            };
            replace(detail);
          }
        } else if (
          latest?.key === key &&
          latest.detail.timeline_next_cursor === cursor
        ) {
          // A disconnected head refresh moves the cursor; that page is skipped
          // and the sentinel asks again from the new cursor.
          const merged = {
            ...latest.detail,
            timeline: mergeTimeline(latest.detail.timeline, detail.timeline),
            timeline_next_cursor: detail.timeline_next_cursor ?? null,
            // C-615: the older page's other-card attachments come with it.
            referenced_attachments: mergeReferenced(
              latest.detail.referenced_attachments,
              detail.referenced_attachments,
            ),
          };
          history.current = { key, detail: merged, head: latest.head };
          replace(merged);
        }
        paging.current = undefined;
        setPager(undefined);
      } catch (error) {
        if (paging.current !== token) return;
        paging.current = undefined;
        setPager({ error: describeError(error) });
      }
    })();
    return true;
  }, [client, projectId, cardId, replace]);
  useEffect(() => {
    if (data?.card.title) onTitleChange?.(data.card.title, data);
  }, [data, onTitleChange]);
  useEffect(() => {
    if (!data) return;
    const ids = [
      ...new Set(
        [...data.decisions, ...(data.merge_confirmations ?? [])]
          .flatMap((decision) =>
            [
              ...(decision.card_id ? [decision.card_id] : []),
              ...(decision.affected_cards ?? []),
              ...(decision.affected_card_views ?? []).map((card) => card.id),
            ].filter((id) => id !== cardId),
          )
          .concat([
            ...(data.card.dependency?.predecessors ?? []).map(
              (card) => card.id,
            ),
            ...(data.card.dependency?.successors ?? []).map((card) => card.id),
            ...(data.card.dependency?.graph?.nodes ?? []).map(
              (card) => card.id,
            ),
            // A story's progress and graph follow its children's own events.
            ...(data.card.story_progress?.children ?? []).map(
              (card) => card.id,
            ),
            // C-567: another card's precheck ending settles this card's wait.
            ...(data.card.checking?.precheck?.cards ?? []),
            ...referencedCards,
          ]),
      ),
    ].sort();
    setAffectedCards((current) =>
      current.length === ids.length && current.every((id, i) => id === ids[i])
        ? current
        : ids,
    );
  }, [data, cardId, referencedCards]);
  useEffect(() => {
    const filterKey = `${routeFilters.type ?? ""}/${routeFilters.author ?? ""}`;
    if (query.current.at === anchor && previousFilters.current === filterKey)
      return;
    query.current = {
      limit: PAGE_SIZE,
      ...(anchor ? { at: anchor } : {}),
      ...(routeFilters.type ? { type: routeFilters.type } : {}),
      ...(routeFilters.author ? { author: routeFilters.author } : {}),
    };
    previousFilters.current = filterKey;
    history.current = undefined;
    resetPaging();
    reload();
  }, [anchor, routeFilters.type, routeFilters.author, reload, resetPaging]);
  const back = routeHash({ kind: "cards", projectId });
  if (data === null)
    return (
      <div>
        <EmptyState>找不到卡片 {cardId}。请核对编号或返回卡片。</EmptyState>
        <a href={back}>返回到卡片</a>
      </div>
    );
  return (
    <>
      <RequestFeedback
        pending={pending}
        interactive={interactive}
        error={error}
        retry={reload}
        pendingMessage={`正在加载卡片 ${cardId}…`}
      />
      {inDrawer && data === undefined && !error && <Skeleton />}
      {data && (
        <CardContent
          key={`${projectId}/${cardId}`}
          detail={data}
          onReferencedCards={setReferencedCards}
          revision={
            cardRevision ? cardRevision(cardId, affectedCards) : revision
          }
          client={client}
          projectId={projectId}
          cardId={cardId}
          anchor={anchor}
          inDrawer={inDrawer}
          onLocate={inDrawer ? locate : undefined}
          onPosted={(comment) => {
            const id = `entry-${comment.id}`;
            locate(id);
            if (!inDrawer)
              window.location.hash = routeHash({
                kind: "card",
                projectId,
                cardId,
                anchor: id,
                filters: routeFilters,
              });
          }}
          onCommentConflict={() => {
            locate(undefined);
            query.current = { limit: PAGE_SIZE };
            resetPaging();
            if (!inDrawer)
              window.location.hash = routeHash({
                kind: "card",
                projectId,
                cardId,
                filters: routeFilters,
              });
            reload();
          }}
          reload={reload}
          anchorReady={!anchor || (query.current.at === anchor && !pending)}
          pager={pager}
          pagerReady={pagerReady}
          loadOlder={loadOlder}
        />
      )}
    </>
  );
}

function CardContent({
  detail: head,
  revision,
  client,
  projectId,
  cardId,
  anchor,
  inDrawer,
  onLocate,
  onPosted,
  onCommentConflict,
  reload,
  pager,
  pagerReady,
  loadOlder,
  anchorReady,
  onReferencedCards,
}: {
  detail: CardDetail;
  onReferencedCards?: Dispatch<SetStateAction<readonly string[]>>;
  revision: number;
  client: CardiganClient;
  projectId: string;
  cardId: string;
  anchor: string | undefined;
  inDrawer: boolean;
  onLocate: ((anchor: string) => void) | undefined;
  onPosted: (comment: PostedComment) => void;
  onCommentConflict: () => void;
  reload: () => void;
  anchorReady: boolean;
  pager: PagerStatus;
  pagerReady: boolean;
  loadOlder: () => boolean;
}) {
  const [filters, setFilters] = useRouteFilters({
    kind: "card",
    projectId,
    cardId,
  });
  const [activeAction, setActiveAction] = useState<"card" | "completion">();
  const [primaryPanels, setPrimaryPanels] = useState<HTMLElement | null>(null);
  const [dock, setDock] = useState<HTMLElement | null>(null);
  // C-696: “C-48 已完成” stays 4 seconds in the shared feedback stack; the
  // panel that held “标记完成” is gone after the reload.
  const [doneNotice, setDoneNotice] = useState("");
  useEffect(() => {
    if (!doneNotice) return;
    const timer = window.setTimeout(() => setDoneNotice(""), DONE_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [doneNotice]);
  const article = useRef<HTMLElement>(null);
  const scroll = useRef<HTMLElement>(null),
    lastAnchor = useRef<string | undefined>(undefined);
  const [selectedSection, setSelectedSection] = useState<string>();
  const [workRevision, setWorkRevision] = useState(0);
  const timelineRoot = useCallback(
    () =>
      inDrawer
        ? (article.current?.closest<HTMLElement>(".drawer-body") ?? null)
        : null,
    [inDrawer],
  );
  const activeSection = selectedSection ?? `card-${cardId}-overview`;
  const section = activeSection.slice(`card-${cardId}-`.length) as
    | CardPanel
    | "overview";
  const panelLoad = useCallback(
    async () =>
      client.cardPanel && section !== "overview"
        ? client.cardPanel(projectId, cardId, section)
        : {},
    [client, section, projectId, cardId],
  );
  const panelData = useResource(
    panelLoad,
    revision + (section === "work" ? workRevision : 0),
    !!head.overview && section !== "overview",
  );
  const detail = head.overview ? { ...head, ...panelData.data } : head;
  const panelReady = !head.overview || !!panelData.data;
  // C-615: numbers on timeline pages the head read did not cover (older
  // pages, rows kept across a refresh) are read on their own.
  const knownAttachments = useMemo(
    () =>
      new Set(
        [...detail.attachments, ...(detail.referenced_attachments ?? [])].map(
          (a) => a.id,
        ),
      ),
    [detail.attachments, detail.referenced_attachments],
  );
  const timelineBodies = useMemo(
    () => detail.timeline.map((entry) => entry.body),
    [detail.timeline],
  );
  const later = useAttachmentRefsState(
    client,
    projectId,
    cardId,
    timelineBodies,
    knownAttachments,
    detail.timeline,
  );
  const laterRefs = later.attachments;
  const referencedAttachments = useMemo(
    () => [...(detail.referenced_attachments ?? []), ...laterRefs],
    [detail.referenced_attachments, laterRefs],
  );
  useEffect(() => {
    const shown = referencedAttachments.map((a) => a.card_id);
    onReferencedCards?.((current) => {
      // While the follow-up read is out, its cards are unknown rather than
      // gone: keep following them, or the page's revision drops, it reloads,
      // asks again and never settles (V-3096). The answer sets the exact list.
      const cards = [
        ...new Set(later.settled ? shown : [...current, ...shown]),
      ].sort();
      return current.length === cards.length &&
        current.every((id, i) => id === cards[i])
        ? current
        : cards;
    });
  }, [referencedAttachments, later.settled, onReferencedCards]);
  const storyAttachments = useStoryAttachments({
    detail: head,
    client,
    projectId,
    cardId,
    revision,
  });
  // C-581: reveal the anchor's panel once per anchor; a live refresh must not
  // pull a reader back from the panel they switched to.
  const revealed = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!anchor) revealed.current = undefined;
    if (!anchor || !anchorReady || revealed.current === anchor) return;
    const target = document.getElementById(anchor);
    const panel = target?.closest<HTMLElement>("[data-card-panel]");
    if (!panel || !article.current?.contains(panel)) return;
    revealed.current = anchor;
    setSelectedSection(panel.id);
  }, [anchor, anchorReady]);
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    if (anchor) return;
    const root = inDrawer
      ? article.current?.closest<HTMLElement>(".drawer-body")
      : (document.scrollingElement ?? document.documentElement);
    if (root) root.scrollTop = 0;
  }, [anchor, inDrawer]);
  // Anchors may render before route filters settle. Follow their row while this
  // snapshot lays out, then stop on interaction or refresh; never move a reader
  // back to the latest entry on an unrelated SSE update.
  // C-581: a refresh re-runs this effect and a new ResizeObserver reports once
  // on observe, so a settled location must not observe or position again.
  // Settling belongs to one visit: navigating away and back (A → B → A) is a
  // new visit and positions again; only refreshes of the same visit stay put.
  const settled = useRef<string | undefined>(undefined),
    visit = useRef<string | undefined>(undefined);
  useEffect(() => {
    const region = scroll.current;
    if (!region) return;
    let position: () => void;
    let initial = true;
    let location: string | undefined;
    if (anchor) {
      location = `${anchor}/${filters.type ?? ""}/${filters.author ?? ""}`;
      if (visit.current !== location) {
        visit.current = location;
        settled.current = undefined;
      }
      if (!anchorReady) {
        // A refresh started after the row was positioned: its follow is over.
        if (lastAnchor.current === location) settled.current = location;
        return;
      }
      if (settled.current === location) return;
      initial = lastAnchor.current !== location;
      position = () => {
        const target = document.getElementById(anchor);
        if (
          !target ||
          target.closest<HTMLElement>("[data-card-panel]")?.id !== activeSection
        )
          return;
        lastAnchor.current = location;
        for (
          let parent = target.parentElement;
          parent;
          parent = parent.parentElement
        )
          if (parent.tagName === "DETAILS")
            (parent as HTMLDetailsElement).open = true;
        (target.closest(".timeline-entry") ?? target).scrollIntoView?.({
          block: "nearest",
        });
      };
    } else {
      // C-205: start at the decision summary; explicit timeline anchors still win.
      lastAnchor.current = undefined;
      settled.current = undefined;
      visit.current = undefined;
      return;
    }
    let following = true;
    const settle = () => {
      if (following) position();
    };
    if (initial) settle();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(settle);
    observer?.observe(article.current ?? region);
    const stop = () => {
      following = false;
      if (lastAnchor.current === location) settled.current = location;
      observer?.disconnect();
    };
    for (const event of ["wheel", "pointerdown", "keydown"])
      window.addEventListener(event, stop, { once: true });
    return () => {
      following = false;
      observer?.disconnect();
      for (const event of ["wheel", "pointerdown", "keydown"])
        window.removeEventListener(event, stop);
    };
  }, [anchor, anchorReady, filters.type, filters.author, activeSection]);
  // C-695: a “下一步” action whose control still lives in a tab opens that
  // tab, brings the control into view and focuses it.
  const [revealing, setRevealing] = useState<{ target: NextStepTarget }>();
  const revealTarget = useCallback(
    (target: NextStepTarget) => {
      setSelectedSection(
        `card-${cardId}-${target === "questions" || target === "comment" ? "timeline" : "overview"}`,
      );
      setRevealing({ target });
    },
    [cardId],
  );
  useEffect(() => {
    const root = article.current;
    if (!revealing || !root) return;
    setRevealing(undefined);
    // Ordered [region, control] candidates: the first region present wins;
    // inside it the first enabled control, else the region itself.
    const answer = "[aria-label$='题回答']:is(input, textarea):not(:disabled)";
    const button = "button:not(:disabled)";
    const candidates: Record<NextStepTarget, [string, string[]][]> = {
      merge: [
        [
          `#card-${cardId}-merge`,
          ["button[type=submit][form]:not(:disabled)", button],
        ],
      ],
      decisions: [[`#card-${cardId}-suggested`, [button]]],
      proposal: [["section[aria-label='拆解方案']", [button]]],
      // The first open question; with none left, the comment box.
      questions: [
        ["section[aria-label='需求澄清']", [answer]],
        ["section.comment-box", ["textarea:not(:disabled)"]],
      ],
      comment: [["section.comment-box", ["textarea:not(:disabled)"]]],
    };
    const list = candidates[revealing.target];
    for (const [index, [region, controls]] of list.entries()) {
      const area = root.querySelector<HTMLElement>(region);
      const control = controls
        .map((selector) => area?.querySelector<HTMLElement>(selector))
        .find(Boolean);
      // A region without a usable control falls through to the next one.
      if (!area || (!control && index < list.length - 1)) continue;
      const target = control ?? area;
      target.scrollIntoView?.({ block: "center" });
      target.focus({ preventScroll: true });
      return;
    }
  }, [revealing, cardId]);
  const card = detail.card;
  const cardPageClass = inDrawer ? "card-page card-page-drawer" : "card-page";
  const completionId =
    detail.overview?.completion_id ??
    [...detail.deliveries]
      .reverse()
      .find((d) => d.kind === "card_completion" && d.status === "accepted")?.id;
  const sectionId = (name: string) => `card-${cardId}-${name}`;
  // C-760: open actions on this card; the owner may move their merge hold.
  const openActions = detail.human_actions.filter(
    (a) => a.status === "open" && a.card_id === cardId,
  );
  const panel = (name: string) => ({
    id: sectionId(name),
    "data-card-panel": true,
    hidden: activeSection !== sectionId(name),
    role: "tabpanel",
    "aria-labelledby": `${sectionId(name)}-tab`,
    tabIndex: 0,
  });
  // C-192: open human decisions (other than merge confirmations) carrying a
  // suggestion can be handled here in one click, like in Needs You.
  const suggested = detail.decisions.filter(
    (q) =>
      q.suggestion &&
      q.decider === "human" &&
      q.trigger !== "merge_confirmation" &&
      ["open", "provisional", "snoozed"].includes(q.status),
  );
  const workCount = detail.overview?.work_count ?? detail.work_items.length;
  const attachmentCount =
    detail.overview?.attachment_count ?? detail.attachments.length;
  const recordCount = head.overview
    ? head.counts.deliveries + head.counts.reviews
    : detail.deliveries.length + detail.reviews.length;
  const sections = [
    { id: sectionId("overview"), label: "概览" },
    ...(workCount
      ? [
          {
            id: sectionId("work"),
            label: "工作项",
            count: workCount,
          },
        ]
      : []),
    ...(recordCount
      ? [
          {
            id: sectionId("records"),
            label: "交付与审核",
            count: recordCount,
          },
        ]
      : []),
    {
      id: sectionId("timeline"),
      label: "时间线",
      count: detail.counts.timeline,
    },
    ...(attachmentCount
      ? [
          {
            id: sectionId("attachments"),
            label: "附件",
            count: attachmentCount,
          },
        ]
      : []),
  ];
  return (
    <CardDetailLayout
      ref={article}
      className={cardPageClass}
      aria-label={`卡片 ${cardId}`}
    >
      <CardActionDockSlot ref={setDock} />
      <header className="card-header">
        {!inDrawer && (
          <CardDetailHeading>
            <PageTitle
              showCapacity={false}
              title={
                <>
                  <IdTag id={card.id} label="" /> {card.title}
                </>
              }
            />
            <TemplateMarker card={card} info={detail.template} force />
          </CardDetailHeading>
        )}
        <DetailStatusRow
          aria-label="卡片状态"
          actions={
            <CardActions
              disabled={!!activeAction && activeAction !== "card"}
              onEditingChange={(editing) =>
                setActiveAction(editing ? "card" : undefined)
              }
              card={card}
              client={client}
              projectId={projectId}
              onSaved={reload}
              formContainer={primaryPanels}
            />
          }
        >
          <StatusTag status={card.status} />
          <span>
            更新于 <Time value={detail.updated_at ?? card.created_at} />
          </span>
          <CardRiskTags tags={card.risk_tags} />
        </DetailStatusRow>
        <CardSuperseded card={card} projectId={projectId} />
        <CardNextStep
          detail={detail}
          client={client}
          projectId={projectId}
          onSaved={reload}
          onReveal={revealTarget}
          completionId={completionId}
          busy={!!activeAction}
          inDrawer={inDrawer}
          dock={dock}
          markDone={(emphasis) => (
            <CardTemplate
              disabled={!!activeAction && activeAction !== "completion"}
              onDone={setDoneNotice}
              onEditingChange={(editing) =>
                setActiveAction(editing ? "completion" : undefined)
              }
              detail={detail}
              client={client}
              projectId={projectId}
              onSaved={reload}
              revision={revision}
              showMetadata={false}
              emphasis={emphasis}
            />
          )}
        />
        <DetailNextStepForms ref={setPrimaryPanels} />
        <RequestFeedback message={doneNotice} />
      </header>
      <div className="card-main">
        <AuthorPrechecks checks={card.prechecks ?? []} projectId={projectId} />
        <CardSectionNav
          sections={sections}
          active={activeSection}
          onSelect={setSelectedSection}
        />
        {head.overview && section !== "overview" && (
          <RequestFeedback
            pending={panelData.pending}
            interactive={false}
            error={panelData.error}
            retry={panelData.reload}
            pendingMessage="正在加载…"
          />
        )}
        <section {...panel("overview")}>
          <CardDependencies card={card} projectId={projectId} client={client} />
          <CardBatchChecks
            card={card}
            projectId={projectId}
            client={client}
            done={reload}
          />
          {!!(
            detail.merge_confirmations?.length ||
            card.merge_check_blockers?.length
          ) && (
            <section
              id={sectionId("merge")}
              className="card-section card-merge"
              aria-label="合并处理"
            >
              <h2 className="visually-hidden">合并处理</h2>
              <MergeBlockers blockers={card.merge_check_blockers ?? []} />
              {detail.merge_confirmations?.map((q) => (
                <MergeConfirmation
                  key={q.id}
                  q={q}
                  client={client}
                  projectId={projectId}
                  done={reload}
                  elapsed={0}
                  inCardHeader
                />
              ))}
            </section>
          )}
          {openActions.length > 0 && (
            <section
              id={sectionId("human-actions")}
              className="card-section"
              aria-label="人工事项"
            >
              <h2>人工事项</h2>
              {openActions.map((a) => (
                <article
                  key={a.id}
                  className="needs-item"
                  aria-label={`人工事项 ${a.id}`}
                >
                  <h3 className="needs-question">
                    <IdTag id={a.id} label="" />{" "}
                    {a.handoff?.title ?? a.instructions.split(/\r?\n/u)[0]}
                  </h3>
                  <MergeBlockingControl
                    client={client}
                    projectId={projectId}
                    action={a}
                    done={reload}
                  />
                </article>
              ))}
            </section>
          )}
          {suggested.length > 0 && (
            <section
              id={sectionId("suggested")}
              className="card-section"
              aria-label={SUGGESTION_COPY.cardSection}
            >
              <h2>{SUGGESTION_COPY.cardSection}</h2>
              {suggested.map((q) => (
                <article
                  key={q.id}
                  className="needs-item"
                  aria-label={`拍板 ${q.id}`}
                >
                  <h3 className="needs-question">{q.question}</h3>
                  <PlainSummary id={q.id} summary={q.plain_summary} />
                  <DecisionRouting decision={q} />
                  <DecisionContext
                    context={q.context}
                    summary={q.plain_summary}
                    legacy={null}
                  />
                  <SuggestedDecision
                    q={q}
                    client={client}
                    projectId={projectId}
                    done={reload}
                  />
                  <p className="hint">
                    {SUGGESTION_COPY.otherOptions}
                    <a href={routeHash({ kind: "needs-you", projectId })}>
                      Needs You
                    </a>
                  </p>
                </article>
              ))}
            </section>
          )}
          {card.story ? (
            <StoryOverview
              detail={detail}
              attachments={storyAttachments}
              client={client}
              projectId={projectId}
              cardId={cardId}
              revision={revision}
              onLocate={onLocate}
              onShowTimeline={() => setSelectedSection(sectionId("timeline"))}
              onSaved={reload}
            />
          ) : (
            <section className="card-purpose" aria-label="目标和验收标准">
              <h2>目标和验收标准</h2>
              <Markdown body={card.goal} />
              <section className="acceptance-criteria">
                <h3>验收标准（{card.acceptance_criteria.length} 项）</h3>
                <LongContent>
                  <ul>
                    {card.acceptance_criteria.map((criterion) => (
                      <li key={criterion}>
                        <MarkdownBody body={criterion} />
                      </li>
                    ))}
                  </ul>
                </LongContent>
              </section>
              {completionId && (
                <section aria-label="完成申请">
                  <h3>完成申请</h3>
                  <p>
                    整体完成申请已通过：
                    <IdTag
                      id={completionId}
                      label="完成申请"
                      href={routeHash({
                        kind: "card",
                        projectId,
                        cardId,
                        anchor: `delivery-${completionId}`,
                      })}
                    />
                  </p>
                </section>
              )}
            </section>
          )}
          <RecentConclusions
            detail={detail}
            projectId={projectId}
            onLocate={onLocate}
          />
          <CardSource detail={detail} projectId={projectId} />
          <CardSidebar detail={detail} projectId={projectId} cardId={cardId} />
        </section>
        {!!workCount && (
          <div {...panel("work")}>
            {(!head.overview || (section === "work" && panelReady)) && (
              <CardWorkItems
                client={client}
                changed={() => {
                  reload();
                  // The write may finish after a switch to a different panel.
                  if (head.overview) setWorkRevision((value) => value + 1);
                }}
                detail={detail}
                projectId={projectId}
                cardId={cardId}
              />
            )}
          </div>
        )}
        {!!recordCount && (
          <section {...panel("records")}>
            {(!head.overview || (section === "records" && panelReady)) && (
              <CardRecords
                detail={detail}
                projectId={projectId}
                onLocate={onLocate}
              />
            )}
          </section>
        )}
        <section
          {...panel("timeline")}
          className="card-section card-timeline"
          aria-label="时间线"
        >
          <TimelineControls
            filters={filters}
            onChange={setFilters}
            loaded={detail.timeline.length}
            total={detail.counts.timeline}
          />
          {detail.card.story && (
            <StoryDiscussion
              story={detail.card.story}
              closed={["done", "cancelled"].includes(detail.card.status)}
              client={client}
              projectId={projectId}
              cardId={cardId}
              reload={reload}
            />
          )}
          <CommentBox
            client={client}
            projectId={projectId}
            cardId={cardId}
            hasPmOps={detail.card.story ? undefined : detail.has_pm_ops}
            attachments={detail.attachments}
            referencedAttachments={referencedAttachments}
            onPosted={onPosted}
            onConflict={onCommentConflict}
          />
          {anchor && (filters.type || filters.author) && (
            <p className="hint">
              已保留链接指向的条目，便于定位；重新筛选后恢复只显示匹配项。
            </p>
          )}
          <section
            className="timeline-records"
            ref={scroll}
            aria-label="时间线记录"
          >
            {(!head.overview || section === "timeline") && (
              <Timeline
                projectId={projectId}
                cardId={cardId}
                entries={detail.timeline}
                attachments={detail.attachments}
                detail={detail}
                referencedAttachments={referencedAttachments}
                typeFilter={filters.type ?? ""}
                authorFilter={filters.author ?? ""}
                anchor={anchor}
              />
            )}
            <TimelinePager
              loaded={detail.timeline.length}
              hasMore={
                detail.timeline_next_cursor === undefined
                  ? detail.timeline.length < detail.counts.timeline
                  : detail.timeline_next_cursor !== null
              }
              status={pager}
              ready={pagerReady && (!head.overview || section === "timeline")}
              scrollRoot={timelineRoot}
              onLoad={loadOlder}
            />
          </section>
        </section>
        {!!attachmentCount && (
          <section
            {...panel("attachments")}
            className="card-section"
            aria-label="附件"
          >
            {(!head.overview || (section === "attachments" && panelReady)) && (
              <AttachmentGrid attachments={detail.attachments} />
            )}
          </section>
        )}
      </div>
    </CardDetailLayout>
  );
}
