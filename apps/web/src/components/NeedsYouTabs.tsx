import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type {
  CardiganClient,
  NeedsCounts,
  NeedsPage,
  NeedsTab,
} from "../api.js";
import { useNeedsResource } from "../useNeedsResource.js";
import { useResource } from "../useResource.js";
import { PageTitle } from "./Foundation.js";
import { Feedback } from "./Operations.js";
import { RequestFeedbackScope } from "./RequestFeedback.js";
import { Skeleton } from "./ui/skeleton.js";

const tabs = [
  ["decisions", "待拍板"],
  ["merges", "合并确认"],
  ["actions", "待你执行"],
  ["later", "稍后"],
  ["notices", "知会"],
] as const;
export type NeedsCountsResource = ReturnType<typeof useResource<NeedsCounts>>;
type PanelResource = ReturnType<typeof useResource<NeedsPage>>;
type Props = {
  client: CardiganClient;
  projectId: string;
  revision?: number;
  invalidation?: string;
  renderPanel: (resource: PanelResource) => ReactNode;
};
export function NeedsYouTabs(props: Props & { counts?: NeedsCountsResource }) {
  return props.counts ? (
    <Tabs {...props} counts={props.counts} key={props.projectId} />
  ) : (
    <Loader {...props} key={props.projectId} />
  );
}
function Loader(props: Props) {
  const counts = useNeedsResource(
    props.client,
    props.projectId,
    props.revision ?? 0,
    props.invalidation ?? String(props.revision ?? 0),
  );
  return <Tabs {...props} counts={counts} />;
}
function Tabs(props: Props & { counts: NeedsCountsResource }) {
  const { counts } = props;
  const id = useId();
  const [selected, setSelected] = useState<NeedsTab>();
  const [visited, setVisited] = useState<readonly NeedsTab[]>([]);
  const refs = useRef(new Map<NeedsTab, HTMLButtonElement>());
  const choose = (tab: NeedsTab) => {
    setSelected(tab);
    setVisited((old) => (old.includes(tab) ? old : [...old, tab]));
  };
  useEffect(() => {
    if (selected || !counts.data) return;
    const first =
      tabs.find(([key]) => (counts.data?.tabs[key].count ?? 0) > 0)?.[0] ??
      "decisions";
    // Enabling the buttons and choosing a default are separate commits.
    // An intervening click already selected and visited its panel.
    setSelected((current) => current ?? first);
    setVisited((current) => (current.length ? current : [first]));
  }, [counts.data, selected]);
  return (
    <section className="needs-page" aria-label="Needs You">
      <PageTitle
        title="Needs You"
        count={
          counts.data?.total_pending
            ? `${counts.data.total_pending} 件事等你处理`
            : undefined
        }
      />
      <Feedback
        pending={counts.pending}
        interactive={counts.interactive}
        error={counts.error}
        retry={counts.reload}
      />
      <div className="needs-tabs" role="tablist" aria-label="Needs You 内容">
        {tabs.map(([key, label], index) => {
          const count = counts.data?.tabs[key];
          return (
            <button
              key={key}
              ref={(node) => {
                if (node) refs.current.set(key, node);
                else refs.current.delete(key);
              }}
              type="button"
              role="tab"
              disabled={!counts.data}
              id={`${id}-${key}-tab`}
              aria-controls={`${id}-${key}-panel`}
              aria-selected={selected === key}
              tabIndex={selected === key ? 0 : -1}
              className={
                count?.attention ? "needs-tab has-attention" : "needs-tab"
              }
              onClick={() => choose(key)}
              onKeyDown={(event) => {
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % tabs.length
                    : event.key === "ArrowLeft"
                      ? (index + tabs.length - 1) % tabs.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? tabs.length - 1
                          : undefined;
                if (next === undefined) return;
                event.preventDefault();
                const target = tabs[next];
                if (target) {
                  choose(target[0]);
                  refs.current.get(target[0])?.focus();
                }
              }}
            >
              <span>{label}</span>
              <span className="needs-tab-count">{count?.count ?? "—"}</span>
              {!!count?.attention && (
                <span className="visually-hidden">
                  ，{count.attention} 项待处理或未读
                </span>
              )}
            </button>
          );
        })}
      </div>
      {counts.data &&
        tabs.map(([key]) => (
          <div
            key={key}
            role="tabpanel"
            id={`${id}-${key}-panel`}
            aria-labelledby={`${id}-${key}-tab`}
            hidden={selected !== key}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: ARIA tab panels are keyboard focus targets, including empty panels.
            tabIndex={0}
          >
            {visited.includes(key) && (
              <Panel {...props} section={key} active={selected === key} />
            )}
          </div>
        ))}
      {!counts.data && counts.pending && <Skeleton />}
    </section>
  );
}
function Panel({
  client,
  projectId,
  revision = 0,
  invalidation,
  section,
  active,
  renderPanel,
  counts,
}: Props & {
  section: NeedsTab;
  active: boolean;
  counts: NeedsCountsResource;
}) {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const version = useRef(invalidation);
  version.current = invalidation;
  const load = useCallback(
    () => client.needsYouSection(projectId, section, version.current),
    [client, projectId, section],
  );
  const resource = useResource(load, revision, active && visible);
  const reload = () => {
    version.current = undefined;
    counts.reload();
    resource.reload();
  };
  return (
    <RequestFeedbackScope hidden={!active}>
      {renderPanel({ ...resource, reload })}
    </RequestFeedbackScope>
  );
}
