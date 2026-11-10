import { useCallback, useEffect, useState } from "react";
import {
  type CardiganClient,
  describeError,
  HttpCardiganClient,
  type ProjectSummary,
  type SessionInfo,
} from "./api.js";
import { EmptyState } from "./components/Foundation.js";
import { RequestFeedback } from "./components/RequestFeedback.js";
import { routeHash, useRoute } from "./route.js";
import { useProjectStream } from "./useProjectStream.js";
import { useResource } from "./useResource.js";
import { ActivityPage } from "./views/ActivityPage.js";
import { CardDetailPage } from "./views/CardDetailPage.js";
import { CardListPage } from "./views/CardListPage.js";
import { DecisionHistoryPage } from "./views/DecisionHistoryPage.js";
import { ExecutionPage } from "./views/ExecutionPage.js";
import { LoginPage } from "./views/LoginPage.js";
import { NeedsYouPage } from "./views/NeedsYouPage.js";
import { SettingsPage } from "./views/SettingsPage.js";
import { SnapshotPage } from "./views/SnapshotPage.js";

/**
 * Application shell (M5 plan §4 M5.3).
 *
 * Three states, in order: the session is unknown (checking), the session is
 * absent (login page), or the session is live (shell + the route's view). The
 * shell owns the project switcher and the navigation, and nothing else holds
 * application state — no store library for one screen and one parameter.
 */

const defaultClient = new HttpCardiganClient();

type SessionState =
  | { readonly kind: "loading"; readonly interactive?: boolean }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly info: SessionInfo };

export interface AppProps {
  /** Injected by tests; production uses the same-origin HTTP client. */
  readonly client?: CardiganClient;
}

export function App({ client = defaultClient }: AppProps = {}) {
  const [session, setSession] = useState<SessionState>({ kind: "loading" });

  const loadSession = useCallback(
    async (interactive = true) => {
      setSession({ kind: "loading", interactive });
      try {
        setSession({ kind: "ready", info: await client.session() });
      } catch (error) {
        setSession({ kind: "error", message: describeError(error) });
      }
    },
    [client],
  );

  useEffect(() => {
    void loadSession(false);
  }, [loadSession]);

  if (session.kind === "loading") {
    return (
      <main className="centered">
        <RequestFeedback
          pending
          interactive={session.interactive}
          pendingMessage="正在检查登录状态…"
        />
      </main>
    );
  }
  if (session.kind === "error") {
    return (
      <main className="centered">
        <RequestFeedback
          error={session.message}
          retry={() => void loadSession()}
        />
      </main>
    );
  }
  if (!session.info.authenticated) {
    return (
      <LoginPage
        client={client}
        passwordConfigured={session.info.password_configured}
        onLoggedIn={loadSession}
      />
    );
  }
  return <Workbench client={client} onLoggedOut={loadSession} />;
}

type ProjectsState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly projects: readonly ProjectSummary[] };

function Workbench({
  client,
  onLoggedOut,
}: {
  readonly client: CardiganClient;
  readonly onLoggedOut: () => void | Promise<void>;
}) {
  const [route, navigate, invalidHash] = useRoute();
  const [loggingOut, setLoggingOut] = useState(false);
  const loadProjects = useCallback(() => client.projects(), [client]);
  const projectResource = useResource(loadProjects);
  const projects: ProjectsState = projectResource.data
    ? { kind: "ready", projects: projectResource.data }
    : projectResource.error
      ? { kind: "error", message: projectResource.error }
      : { kind: "loading" };

  const selected =
    projects.kind === "ready"
      ? projects.projects.find((p) => p.id === route?.projectId)
      : undefined;

  const live = useProjectStream(client, selected?.id, onLoggedOut);
  const loadNeeds = useCallback(
    () =>
      selected
        ? client.needsYou(selected.id)
        : Promise.resolve({
            decisions: [],
            human_actions: [],
            incidents: [],
            attention: [],
          }),
    [client, selected],
  );
  const needs = useResource(loadNeeds, live.revision);
  const needsCount = needs.data
    ? needs.data.decisions.length +
      needs.data.human_actions.length +
      needs.data.incidents.length +
      (needs.data.attention?.length ?? 0)
    : 0;

  // Land on the first project's board when the URL names no project (or one
  // that no longer exists). An unparseable hash is not a missing project: keep
  // the current screen instead of silently switching projects (M5.S S23).
  useEffect(() => {
    if (projects.kind !== "ready") return;
    if (projects.projects.length === 0) return;
    if (invalidHash !== undefined) return;
    if (route !== undefined && selected !== undefined) return;
    const first = projects.projects[0];
    if (first !== undefined) {
      navigate({ kind: "cards", projectId: first.id });
    }
  }, [projects, route, selected, navigate, invalidHash]);

  // Old board/list URLs are bookmarks: move them to the merged cards route and
  // keep every filter (the old view becomes ?view=list|board).
  useEffect(() => {
    if (route?.kind !== "board" && route?.kind !== "list") return;
    const { projectId, filters } = route;
    navigate({
      kind: "cards",
      projectId,
      filters: { view: route.kind, ...filters },
    });
  }, [route, navigate]);

  async function logout(): Promise<void> {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await client.logout();
      await onLoggedOut();
    } catch {
      // The login gate re-checks the session on the next load either way.
      await onLoggedOut();
    } finally {
      setLoggingOut(false);
    }
  }

  const activeView =
    route?.kind === "card" || route?.kind === "board" || route?.kind === "list"
      ? "cards"
      : (route?.kind ?? "cards");

  return (
    <div className="app">
      <aside className="sidebar" aria-label="Workbench 导航">
        <span className="brand">Cardigan</span>
        {projects.kind === "ready" && projects.projects.length > 0 && (
          <label className="project-switcher">
            <span>项目</span>
            <select
              value={selected?.id ?? ""}
              onChange={(event) => {
                navigate({ kind: activeView, projectId: event.target.value });
              }}
            >
              {projects.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {selected !== undefined && (
          <nav className="nav" aria-label="视图">
            <a
              href={routeHash({ kind: "needs-you", projectId: selected.id })}
              aria-current={activeView === "needs-you" ? "page" : undefined}
            >
              Needs You{" "}
              {needsCount > 0 && (
                <span className="nav-count" title={`${needsCount} 件待处理`}>
                  {needsCount}
                </span>
              )}
            </a>
            {(
              [
                ["工作", [["cards", "卡片"]]],
                [
                  "运行",
                  [
                    ["execution", "执行视图"],
                    ["activity", "项目动态"],
                    ["decision-history", "拍板记录"],
                    ["snapshot", "项目快照"],
                  ],
                ],
                ["项目", [["settings", "设置"]]],
              ] as const
            ).map(([group, links]) => (
              <div className="nav-group" key={group}>
                <h2>{group}</h2>
                {links.map(([kind, label]) => (
                  <a
                    key={kind}
                    href={routeHash({ kind, projectId: selected.id })}
                    aria-current={activeView === kind ? "page" : undefined}
                  >
                    {label}
                  </a>
                ))}
              </div>
            ))}
          </nav>
        )}
        <div className="sidebar-footer">
          {selected && (
            <RequestFeedback
              pending={live.status !== "live"}
              pendingMessage="正在连接实时更新…"
              error={
                live.status === "retrying" ? "连接中断，正在重连" : undefined
              }
            />
          )}
          <RequestFeedback
            interactive
            pending={loggingOut}
            pendingMessage="登出中…"
          />
          <button
            type="button"
            className="logout"
            onClick={() => void logout()}
            disabled={loggingOut}
          >
            登出
          </button>
        </div>
      </aside>

      <main className="content">
        <RequestFeedback
          {...projectResource}
          retry={projectResource.reload}
          pendingMessage="正在加载项目…"
        />
        {projects.kind === "ready" && projects.projects.length === 0 && (
          <EmptyState>
            还没有项目。先在终端运行{" "}
            <code>cardigan project create &lt;id&gt;</code>。
          </EmptyState>
        )}
        {invalidHash !== undefined && route === undefined && (
          <RequestFeedback
            error={`无法识别链接 ${invalidHash}；请从项目导航重新进入。`}
          />
        )}
        {selected && route?.kind === "decision-history" && (
          <DecisionHistoryPage
            client={client}
            projectId={selected.id}
            revision={live.revision}
          />
        )}
        {selected && route?.kind === "settings" && (
          <SettingsPage
            key={selected.id}
            client={client}
            projectId={selected.id}
            revision={live.revision}
          />
        )}
        {selected && route?.kind === "activity" && (
          <ActivityPage
            key={selected.id}
            client={client}
            projectId={selected.id}
            revision={live.revision}
          />
        )}
        {selected && route?.kind === "snapshot" && (
          <SnapshotPage
            key={selected.id}
            client={client}
            projectId={selected.id}
            revision={live.revision}
          />
        )}
        {selected && route?.kind === "execution" && (
          <ExecutionPage
            key={selected.id}
            client={client}
            projectId={selected.id}
            revision={live.revision}
          />
        )}
        {selected !== undefined && route?.kind === "needs-you" && (
          <NeedsYouPage
            resource={needs}
            key={selected.id}
            client={client}
            projectId={selected.id}
            revision={live.revision}
          />
        )}
        {selected !== undefined && route?.kind === "card" && (
          <CardDetailPage
            key={`${selected.id}/${route.cardId}`}
            client={client}
            projectId={selected.id}
            revision={live.cardRevision(route.cardId)}
            cardId={route.cardId}
            {...(route.anchor === undefined ? {} : { anchor: route.anchor })}
          />
        )}
        {selected !== undefined && route?.kind === "cards" && (
          <CardListPage
            client={client}
            key={selected.id}
            projectId={selected.id}
            revision={live.revision}
          />
        )}
      </main>
    </div>
  );
}
