import type { ReactNode } from "react";
import type { BuildInfo } from "../api.js";
import { type Route, routeHash } from "../route.js";
import { BuildVersion } from "./BuildVersion.js";
import { Tooltip } from "./Tooltip.js";

/**
 * C-209 sidebar navigation (design D-700 structure, D-709 dark palette).
 *
 * The same body renders in the wide-screen sidebar and in the narrow-screen
 * drawer. Groups: Needs You and 卡片 on top without a heading, the 观察 group
 * for read-mostly project views, and the tools (设置, then C-206's 帮助, then
 * 登出) at the bottom. Icons are hand-drawn inline SVGs that share one line
 * style; colours come from the theme variables only.
 */

const iconPaths = {
  inbox: (
    <>
      <path d="M4 4h16l2 11v5H2v-5L4 4Z" />
      <path d="M2 15h6l2 3h4l2-3h6" />
    </>
  ),
  cards: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M15 4v16" />
    </>
  ),
  execution: <path d="M4 20V4M4 20h16M8 15l4-6 4 4 4-8" />,
  activity: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  decisions: (
    <path d="m4 7 1.5 1.5L8 6M11 7h9M4 13l1.5 1.5L8 12M11 13h9M4 19h4M11 19h9" />
  ),
  snapshot: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  settings: (
    <>
      <path d="M4 6h2m4 0h10M4 12h10m4 0h2M4 18h4m4 0h8" />
      <circle cx="8" cy="6" r="2" />
      <circle cx="16" cy="12" r="2" />
      <circle cx="10" cy="18" r="2" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 16h.01" />
    </>
  ),
  folder: (
    <path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6Z" />
  ),
  logout: <path d="M10 4H4v16h6M9 12h12m-4-4 4 4-4 4" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
} as const;

export type NavIconName = keyof typeof iconPaths;

/** 24×24 line icon drawn in `currentColor`; decorative next to a label. */
export function NavIcon({ name }: { readonly name: NavIconName }) {
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {iconPaths[name]}
    </svg>
  );
}

type ViewKind =
  | "cards"
  | "execution"
  | "activity"
  | "decision-history"
  | "snapshot"
  | "settings"
  | "help"
  | "shared-files";

const observeLinks: readonly (readonly [ViewKind, string, NavIconName])[] = [
  ["execution", "执行视图", "execution"],
  ["activity", "项目动态", "activity"],
  ["decision-history", "拍板记录", "decisions"],
  ["snapshot", "项目快照", "snapshot"],
];

export interface SidebarNavProps {
  readonly build?: BuildInfo | undefined;
  readonly projectId: string | undefined;
  readonly activeView: Route["kind"];
  readonly needsCount: number;
  /** Brand row extra, e.g. the drawer's close button. */
  readonly brandAction?: ReactNode;
  /** Project switcher, rendered under the brand when projects are loaded. */
  readonly projectSwitcher?: ReactNode;
  /** Connection and logout feedback, shown right above the tools. */
  readonly feedback?: ReactNode;
  readonly loggingOut: boolean;
  readonly onLogout: () => void;
  /** Called after an entry is activated (the drawer closes itself). */
  readonly onNavigate?: () => void;
}

export function SidebarNav({
  build,
  projectId,
  activeView,
  needsCount,
  brandAction,
  projectSwitcher,
  feedback,
  loggingOut,
  onLogout,
  onNavigate,
}: SidebarNavProps) {
  const link = (kind: ViewKind, label: string, icon: NavIconName) =>
    projectId !== undefined && (
      <a
        key={kind}
        className="nav-item"
        href={routeHash({ kind, projectId })}
        aria-current={activeView === kind ? "page" : undefined}
        onClick={onNavigate}
      >
        <NavIcon name={icon} />
        <span>{label}</span>
      </a>
    );
  return (
    <>
      <div className="brand-row">
        <div className="brand-identity">
          <span className="brand">Cardigan</span>
          {build && <BuildVersion build={build} />}
        </div>
        {brandAction}
      </div>
      {projectSwitcher}
      {projectId !== undefined && (
        <nav className="nav" aria-label="视图">
          <div className="nav-links">
            <Tooltip
              content={needsCount > 0 ? `${needsCount} 件待处理` : undefined}
            >
              <a
                className="nav-item needs-link"
                href={routeHash({ kind: "needs-you", projectId })}
                aria-current={activeView === "needs-you" ? "page" : undefined}
                onClick={onNavigate}
              >
                <NavIcon name="inbox" />
                <span>Needs You</span>{" "}
                {needsCount > 0 && (
                  <span className="nav-count">{needsCount}</span>
                )}
              </a>
            </Tooltip>
            {link("cards", "卡片", "cards")}
          </div>
          <div className="nav-group">
            <h2>观察</h2>
            {observeLinks.map(([kind, label, icon]) => link(kind, label, icon))}
          </div>
        </nav>
      )}
      <div className="sidebar-footer">
        {feedback}
        <nav className="nav-links nav-tools" aria-label="工具">
          {link("shared-files", "共享文件", "folder")}
          {link("settings", "设置", "settings")}
          {link("help", "帮助", "help")}
          <button
            type="button"
            className="nav-item logout"
            onClick={onLogout}
            disabled={loggingOut}
          >
            <NavIcon name="logout" />
            <span>登出</span>
          </button>
        </nav>
      </div>
    </>
  );
}
