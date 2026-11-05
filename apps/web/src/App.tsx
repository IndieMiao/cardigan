import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CardiganClient,
  describeError,
  HttpCardiganClient,
  type ProjectSummary,
  type SessionInfo,
} from "./api.js";
import { routeHash, useRoute } from "./route.js";
import { CardDetailPage } from "./views/CardDetailPage.js";
import { CardListPage } from "./views/CardListPage.js";
import { ExecutionPage } from "./views/ExecutionPage.js";
import { LoginPage } from "./views/LoginPage.js";
import { NeedsYouPage } from "./views/NeedsYouPage.js";
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
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly info: SessionInfo };

export interface AppProps {
  /** Injected by tests; production uses the same-origin HTTP client. */
  readonly client?: CardiganClient;
}

export function App({ client = defaultClient }: AppProps = {}) {
  const [session, setSession] = useState<SessionState>({ kind: "loading" });

  const loadSession = useCallback(async () => {
    try {
      setSession({ kind: "ready", info: await client.session() });
    } catch (error) {
      setSession({ kind: "error", message: describeError(error) });
    }
  }, [client]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  if (session.kind === "loading") {
    return (
      <main className="centered">
        <p className="loading" role="status">
          正在检查登录状态…
        </p>
      </main>
    );
  }
  if (session.kind === "error") {
    return (
      <main className="centered">
        <div className="error-panel" role="alert">
          <p>{session.message}</p>
          <button type="button" onClick={() => void loadSession()}>
            重试
          </button>
        </div>
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
  const [route, navigate] = useRoute();
  const [projects, setProjects] = useState<ProjectsState>({ kind: "loading" });
  const [loggingOut, setLoggingOut] = useState(false);
  const latest = useRef(0);

  const loadProjects = useCallback(() => {
    const request = latest.current + 1;
    latest.current = request;
    setProjects({ kind: "loading" });
    client.projects().then(
      (list) => {
        if (latest.current === request) {
          setProjects({ kind: "ready", projects: list });
        }
      },
      (error: unknown) => {
        if (latest.current === request) {
          setProjects({ kind: "error", message: describeError(error) });
        }
      },
    );
  }, [client]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const selected =
    projects.kind === "ready"
      ? projects.projects.find((p) => p.id === route?.projectId)
      : undefined;

  // Land on the first project's board when the URL names no project (or one
  // that no longer exists).
  useEffect(() => {
    if (projects.kind !== "ready") return;
    if (projects.projects.length === 0) return;
    if (route !== undefined && selected !== undefined) return;
    const first = projects.projects[0];
    if (first !== undefined) {
      navigate({ kind: "board", projectId: first.id });
    }
  }, [projects, route, selected, navigate]);

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

  const activeView = route && route.kind !== "card" ? route.kind : "board";

  return (
    <div className="app">
      <header className="topbar">
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
            {(
              [
                ["snapshot", "项目快照"],
                ["execution", "执行视图"],
              ] as const
            ).map(([kind, label]) => (
              <a
                key={kind}
                href={routeHash({ kind, projectId: selected.id })}
                aria-current={activeView === kind ? "page" : undefined}
              >
                {label}
              </a>
            ))}
            <a
              href={routeHash({ kind: "needs-you", projectId: selected.id })}
              aria-current={activeView === "needs-you" ? "page" : undefined}
            >
              Needs You
            </a>
            <a
              href={routeHash({ kind: "board", projectId: selected.id })}
              aria-current={activeView === "board" ? "page" : undefined}
            >
              看板
            </a>
            <a
              href={routeHash({ kind: "list", projectId: selected.id })}
              aria-current={activeView === "list" ? "page" : undefined}
            >
              列表
            </a>
          </nav>
        )}
        <button
          type="button"
          className="logout"
          onClick={() => void logout()}
          disabled={loggingOut}
        >
          {loggingOut ? "登出中…" : "登出"}
        </button>
      </header>

      <main className="content">
        {projects.kind === "loading" && (
          <p className="loading" role="status">
            正在加载项目…
          </p>
        )}
        {projects.kind === "error" && (
          <div className="error-panel" role="alert">
            <p>{projects.message}</p>
            <button type="button" onClick={loadProjects}>
              重试
            </button>
          </div>
        )}
        {projects.kind === "ready" && projects.projects.length === 0 && (
          <p className="empty">
            还没有项目。先在终端运行{" "}
            <code>cardigan project create &lt;id&gt;</code>。
          </p>
        )}
        {selected && route?.kind === "snapshot" && (
          <SnapshotPage
            key={selected.id}
            client={client}
            projectId={selected.id}
          />
        )}
        {selected && route?.kind === "execution" && (
          <ExecutionPage
            key={selected.id}
            client={client}
            projectId={selected.id}
          />
        )}
        {selected !== undefined && route?.kind === "needs-you" && (
          <NeedsYouPage
            key={selected.id}
            client={client}
            projectId={selected.id}
          />
        )}
        {selected !== undefined && route?.kind === "card" && (
          <CardDetailPage
            client={client}
            projectId={selected.id}
            cardId={route.cardId}
          />
        )}
        {selected !== undefined &&
          (route?.kind === "board" ||
            route?.kind === "list" ||
            route === undefined) && (
            <CardListPage
              client={client}
              projectId={selected.id}
              view={route?.kind === "list" ? "list" : "board"}
            />
          )}
      </main>
    </div>
  );
}
