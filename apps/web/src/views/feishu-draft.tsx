import { useSyncExternalStore } from "react";
import type { FeishuSettingsView } from "../api.js";
import { RequestFeedback } from "../components/RequestFeedback.js";
import { routeHash } from "../route.js";
import type { FeishuDraft } from "./feishu-config.js";

/**
 * C-561 (V-2857): an unconfirmed Feishu settings draft the person is not
 * looking at — the panel is hidden behind another settings tab, or the
 * settings page was left. It stays in memory for that project (never in
 * storage, never with credential values: only whether a credential is to be
 * replaced or cleared) until the person returns to it, confirms or discards
 * it. While one is held the shared feedback stack names it once, and closing
 * or reloading the tab asks through the browser.
 */
export interface HeldFeishuDraft {
  readonly project: string;
  /** The read the draft was made against (a stale one is refreshed on preview). */
  readonly base: FeishuSettingsView;
  readonly draft: FeishuDraft;
  /** Shows the panel again while the settings page is still mounted. */
  readonly reveal?: () => void;
}

let held: readonly HeldFeishuDraft[] = [];
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const warn = (event: BeforeUnloadEvent) => event.preventDefault();
function set(next: readonly HeldFeishuDraft[]) {
  if (!held.length && next.length)
    window.addEventListener("beforeunload", warn);
  if (held.length && !next.length)
    window.removeEventListener("beforeunload", warn);
  held = next;
  for (const listener of listeners) listener();
}

export function holdFeishuDraft(entry: HeldFeishuDraft) {
  set([...held.filter((h) => h.project !== entry.project), entry]);
}
export function releaseFeishuDraft(project: string) {
  if (held.some((h) => h.project === project))
    set(held.filter((h) => h.project !== project));
}
export function heldFeishuDraft(project: string) {
  return held.find((h) => h.project === project);
}
/** Test isolation only. */
export function resetFeishuDrafts() {
  set([]);
}

/** Rendered once by the app shell, outside any page. */
export function FeishuDraftNotice() {
  const list = useSyncExternalStore(subscribe, () => held);
  return (
    <>
      {list.map((h) => (
        <RequestFeedback
          key={h.project}
          error="飞书配置有未确认的修改，还没有保存。"
          retry={() => {
            if (h.reveal) h.reveal();
            else
              window.location.hash = routeHash({
                kind: "settings",
                projectId: h.project,
                filters: { tab: "feishu" },
              });
          }}
          retryLabel="继续编辑"
        />
      ))}
    </>
  );
}
