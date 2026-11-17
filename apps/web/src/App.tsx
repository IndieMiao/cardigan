import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CardiganClient,
  describeError,
  HttpCardiganClient,
  type ProjectSummary,
  type SessionInfo,
} from "./api.js";
import { CapacityProvider } from "./components/Capacity.js";
import { EmptyState } from "./components/Foundation.js";
import {
  AppContent,
  AppShell,
  AppSidebar,
} from "./components/layout/AppShell.js";
import { PageLoader } from "./components/PageLoader.js";
import { RequestFeedback } from "./components/RequestFeedback.js";
import { ServiceUpdatingFeedback } from "./components/ServiceUpdatingFeedback.js";
import { NavIcon, SidebarNav } from "./components/SidebarNav.js";
import * as Dialog from "./components/ui/dialog.js";
import { SelectControl } from "./components/ui/select-control.js";
import {
  ActivityPage,
  CardDetailPage,
  DecisionHistoryPage,
  ExecutionPage,
  HelpPage,
  NeedsYouPage,
  SettingsPage,
  SnapshotPage,
} from "./lazy-pages.js";
import { routeHash, useRoute } from "./route.js";
import {
  type ServiceUpdatingNotice,
  serviceUpdatingNotice,
} from "./service-retry.js";
import { useNeedsResource } from "./useNeedsResource.js";
import { useProjectStream } from "./useProjectStream.js";
import { useResource } from "./useResource.js";
import { CardListPage } from "./views/CardListPage.js";
import { LoginPage } from "./views/LoginPage.js";

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
  /** C-250: the retry notice the client reports to; injected by tests. */
  readonly serviceNotice?: ServiceUpdatingNotice;
}

export function App({
  client = defaultClient,
  serviceNotice = serviceUpdatingNotice,
}: AppProps = {}) {
  return (
    <>
      <ServiceUpdatingFeedback notice={serviceNotice} />
      <AppSession client={client} />
    </>
  );
}

function AppSession({ client }: { readonly client: CardiganClient }) {
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
      <AppContent className="centered">
        <RequestFeedback
          pending
          interactive={session.interactive}
          pendingMessage="正在检查登录状态…"
        />
      </AppContent>
    );
  }
  if (session.kind === "error") {
    return (
      <AppContent className="centered">
        <RequestFeedback
          error={session.message}
          retry={() => void loadSession()}
        />
      </AppContent>
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
  return (
    <Workbench
      client={client}
      build={session.info.build}
      onLoggedOut={loadSession}
    />
  );
}

type ProjectsState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly projects: readonly ProjectSummary[] };

const NARROW_QUERY = "(max-width: 760px)";

function Workbench({
  client,
  build,
  onLoggedOut,
}: {
  readonly client: CardiganClient;
  readonly build: SessionInfo["build"];
  readonly onLoggedOut: () => void | Promise<void>;
}) {
  const [route, navigate, invalidHash] = useRoute();
  const [loggingOut, setLoggingOut] = useState(false);
  // C-209: below the 760px breakpoint the sidebar becomes a modal drawer.
  // The top bar only exists on narrow screens, so wide screens (and screen
  // readers there) see a single Needs You link.
  const [narrow, setNarrow] = useState(
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia(NARROW_QUERY).matches,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const focusMainOnClose = useRef(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(NARROW_QUERY);
    const sync = (event: MediaQueryListEvent) => {
      setNarrow(event.matches);
      if (!event.matches) setDrawerOpen(false);
    };
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
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
  const needs = useNeedsResource(
    client,
    selected?.id,
    live.revision,
    live.needsKey,
  );
  const needsCount = needs.data?.total_pending ?? 0;

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

  const projectSwitcher = projects.kind === "ready" &&
    projects.projects.length > 0 && (
      <label className="project-switcher">
        <span>项目</span>
        <SelectControl
          value={selected?.id ?? ""}
          onValueChange={(event) => {
            navigate({ kind: activeView, projectId: event });
          }}
        >
          {projects.projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </SelectControl>
      </label>
    );
  const feedback = (
    <>
      {selected && (
        <RequestFeedback
          pending={live.status !== "live"}
          pendingMessage="正在连接实时更新…"
          error={live.status === "retrying" ? "连接中断，正在重连" : undefined}
        />
      )}
      <RequestFeedback
        interactive
        pending={loggingOut}
        pendingMessage="登出中…"
      />
    </>
  );
  const navProps = {
    build,
    projectId: selected?.id,
    activeView,
    needsCount,
    loggingOut,
    onLogout: () => void logout(),
  };

  return (
    <AppShell className="app">
      {narrow && (
        <header className="mobile-header">
          <Dialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
            <Dialog.Trigger asChild>
              <button
                type="button"
                className="icon-button"
                aria-label="打开导航"
              >
                <NavIcon name="menu" />
              </button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="nav-drawer-overlay" />
              <Dialog.Content
                className="nav-drawer sidebar-panel"
                aria-describedby={undefined}
                onOpenAutoFocus={(event) => {
                  event.preventDefault();
                  closeRef.current?.focus();
                }}
                onCloseAutoFocus={(event) => {
                  // Choosing an entry moves on to the page; Escape, the overlay
                  // and the close button return to the menu button (default).
                  if (!focusMainOnClose.current) return;
                  focusMainOnClose.current = false;
                  event.preventDefault();
                  mainRef.current?.focus();
                }}
              >
                <Dialog.Title className="visually-hidden">
                  项目导航
                </Dialog.Title>
                <SidebarNav
                  {...navProps}
                  projectSwitcher={projectSwitcher}
                  feedback={feedback}
                  onNavigate={() => {
                    focusMainOnClose.current = true;
                    setDrawerOpen(false);
                  }}
                  brandAction={
                    <Dialog.Close asChild>
                      <button
                        ref={closeRef}
                        type="button"
                        className="icon-button"
                        aria-label="关闭导航"
                      >
                        <NavIcon name="close" />
                      </button>
                    </Dialog.Close>
                  }
                />
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
          <span className="brand">Cardigan</span>
          {selected !== undefined && (
            <a
              className="mobile-needs"
              href={routeHash({ kind: "needs-you", projectId: selected.id })}
              aria-label={
                needsCount > 0
                  ? `Needs You，${needsCount} 件待处理`
                  : "Needs You"
              }
              aria-current={activeView === "needs-you" ? "page" : undefined}
            >
              <NavIcon name="inbox" />
              {needsCount > 0 && (
                <span className="nav-count">{needsCount}</span>
              )}
            </a>
          )}
        </header>
      )}
      <AppSidebar className="sidebar sidebar-panel" aria-label="Workbench 导航">
        <SidebarNav
          {...navProps}
          projectSwitcher={projectSwitcher}
          feedback={feedback}
        />
      </AppSidebar>

      <AppContent
        className="content"
        id="main-content"
        ref={mainRef}
        tabIndex={-1}
      >
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
        {selected && (
          <CapacityProvider
            key={selected.id}
            client={client}
            projectId={selected.id}
            revision={live.revision + live.capacityRevision}
            canEdit
          >
            <PageLoader key={`${selected?.id}/${route?.kind}`}>
              {selected && route?.kind === "help" && (
                <HelpPage projectId={selected.id} />
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
                  contextRevision={live.contextRevision}
                />
              )}
              {selected !== undefined && route?.kind === "needs-you" && (
                <NeedsYouPage
                  counts={needs}
                  key={selected.id}
                  client={client}
                  projectId={selected.id}
                  revision={live.revision}
                  invalidation={live.needsKey}
                />
              )}
              {selected !== undefined && route?.kind === "card" && (
                <CardDetailPage
                  key={`${selected.id}/${route.cardId}`}
                  client={client}
                  projectId={selected.id}
                  cardRevision={live.cardRevision}
                  cardId={route.cardId}
                  {...(route.anchor === undefined
                    ? {}
                    : { anchor: route.anchor })}
                />
              )}
              {selected !== undefined && route?.kind === "cards" && (
                <CardListPage
                  client={client}
                  key={selected.id}
                  projectId={selected.id}
                  revision={live.revision}
                  changedCards={live.changedCards}
                  changedCardsSince={live.changedCardsSince}
                />
              )}
            </PageLoader>
          </CapacityProvider>
        )}
      </AppContent>
    </AppShell>
  );
}
