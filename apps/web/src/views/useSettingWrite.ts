import {
  createContext,
  createElement,
  Fragment,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { describeWriteError } from "../api.js";
import {
  RequestFeedback,
  useFeedbackVisible,
} from "../components/RequestFeedback.js";
import { parseRoute, routeHash } from "../route.js";
import {
  onSettingsRead,
  readStart,
  settingKey,
  settingsTick,
} from "../settings-clock.js";

export { trackSettingsRead } from "../settings-clock.js";

/** Success notices leave the shared feedback stack after a short while. */
export function useNotice() {
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), 4000);
    return () => window.clearTimeout(timer);
  }, [message]);
  return [message, setMessage] as const;
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

type Write<T> = (value: T, key: string) => Promise<void>;

/** Every view of the settings subscribes to saves in flight and notices. */
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Last write end per project and setting. */
const writeEnds = new Map<string, number>();
/** Newest read per project and setting: when it started and what it showed. */
const confirmed = new Map<string, { at: number; value: unknown }>();
/**
 * Saves in flight per project and setting, shared by every view of it: a
 * page shown again while the first request runs cannot send a second one.
 * Closing or reloading the tab asks first while any save is in flight.
 */
const inflight = new Set<string>();
const warn = (event: BeforeUnloadEvent) => {
  event.preventDefault();
  event.returnValue = "";
};
function beginSave(key: string) {
  if (inflight.size === 0) window.addEventListener("beforeunload", warn);
  inflight.add(key);
  emit();
}
function endSave(key: string, at: number) {
  inflight.delete(key);
  writeEnds.set(key, at);
  if (inflight.size === 0) window.removeEventListener("beforeunload", warn);
  emit();
}

/** A failure shown this recently (monotonic clock) may not have been seen before leaving. */
const UNSEEN_MS = 500;

/** The settings panel a setting is shown in (provided by SettingsPage). */
export interface SettingPlace {
  project: string;
  panel: "preferences" | "authorization" | "capacity";
  /** Shows the panel when it is hidden behind another one. */
  reveal: () => void;
}
export const SettingPlaceContext = createContext<SettingPlace | undefined>(
  undefined,
);

/**
 * A failed save the reader is not looking at (C-455#326): they left the
 * settings page, or switched to another panel, before it answered. Each
 * failed setting is listed once in the shared feedback stack by
 * `SettingsSaveNotice` until it is in view again, saved again, confirmed by a
 * read, or its action is used.
 */
interface SaveNotice {
  key: string;
  message: string;
  /** What failed and why (names the setting), shown on the row when a view takes the notice over. */
  cause: string;
  /** The value that was not saved; a read showing it retires the notice. */
  value: unknown;
  project: string;
  panel: SettingPlace["panel"];
}
let notices: readonly SaveNotice[] = [];
const reveals = new Map<string, () => void>();
function showNotice(next: SaveNotice) {
  notices = [...notices.filter((n) => n.key !== next.key), next];
  emit();
}
function clearNotice(key: string) {
  if (!notices.some((n) => n.key === key)) return;
  notices = notices.filter((n) => n.key !== key);
  emit();
}
/** Record what a read shows, newest read wins (also with no row mounted). */
function confirmRead(key: string, at: number, value: unknown) {
  const known = confirmed.get(key);
  if (!known || at > known.at) confirmed.set(key, { at, value });
  // A read showing the value that was not confirmed retires its notice.
  const reported = notices.find((n) => n.key === key);
  if (reported && same(reported.value, value)) clearNotice(key);
}
onSettingsRead(confirmRead);

/** Rendered once by the app shell, outside any page: one entry per failure. */
export function SettingsSaveNotice() {
  const list = useSyncExternalStore(subscribe, () => notices);
  // The row takes the notice over once it is in view (it shows the failure
  // itself), so the way back leaves the notice until then.
  const back = (failed: SaveNotice) => {
    const reveal = reveals.get(failed.key);
    if (reveal) return reveal();
    window.location.hash = routeHash({
      kind: "settings",
      projectId: failed.project,
      ...(failed.panel === "preferences"
        ? {}
        : { filters: { tab: failed.panel } }),
    });
  };
  return createElement(
    Fragment,
    null,
    ...list.map((failed) =>
      createElement(RequestFeedback, {
        key: failed.key,
        error: failed.message,
        retry: () => back(failed),
        retryLabel: "回到设置",
      }),
    ),
  );
}

/** Test isolation only: forget saves and notices a test left behind. */
export function resetSettingWrites() {
  inflight.clear();
  writeEnds.clear();
  confirmed.clear();
  window.removeEventListener("beforeunload", warn);
  reveals.clear();
  notices = [];
  emit();
}

/**
 * Instant-save lifecycle of one setting (C-455).
 *
 * - `value` is the last confirmed value: the server value of the newest read,
 *   or the acknowledged write until the next read arrives (`source` changes).
 *   useResource only applies the newest read, which starts after the write.
 * - One save at a time per project and setting, across views: a change while
 *   saving is ignored (callers mark the control `aria-disabled` and keep it
 *   focusable). A view shown again meanwhile reads again when it ends, and
 *   stays busy until that read arrives: its old value cannot seed an edit.
 * - A failed write keeps its idempotency key for a retry of the same value; a
 *   different value, a success, or a read showing the value retires the key.
 * - Leaving never waits: the save still completes. A failure the reader is no
 *   longer looking at is reported once (`SettingsSaveNotice`); success adds
 *   nothing. A page shown again edits what its own read returned.
 */
export function useSettingWrite<T>({
  name,
  id = name,
  failure,
  server,
  source,
  confirmable = true,
  sharedSource = false,
  write,
  saved,
  success,
}: {
  /** The setting's name, for a failure reported away from it. */
  name: string;
  /** Stable identity when the name is only a display label (defaults to it). */
  id?: string;
  /** What did not happen, e.g. 未能撤销“对外发布”授权; defaults to 未能保存“name”. */
  failure?: (value: T) => string;
  server: T;
  /** Identity of the read that produced `server`; a new read resets `value`. */
  source: unknown;
  /** False when `server` is a derived default that cannot confirm a write. */
  confirmable?: boolean;
  /**
   * The read outlives this page (the shared capacity read): a write ending
   * after the view is gone reads it again via `saved`.
   */
  sharedSource?: boolean;
  write: Write<T>;
  saved: () => void;
  success: (value: T) => string;
}) {
  const [value, setValue] = useState(server);
  const [read, setRead] = useState(source);
  /** When this view's own acknowledged write ended: it knows `value` since then. */
  const [ownEnd, setOwnEnd] = useState<number | undefined>(undefined);
  if (read !== source) {
    setRead(source);
    setValue(server);
    setOwnEnd(undefined);
  }
  const [error, setError] = useState("");
  const [message, setMessage] = useNotice();
  /**
   * The latest failure on this row and whether the reader may have missed it:
   * `seen` once shown in view, `reported` once in the shared notice.
   */
  const shown = useRef<
    | {
        text: string;
        cause: string;
        value: unknown;
        at: number;
        seen: boolean;
        reported: boolean;
      }
    | undefined
  >(undefined);
  const pending = useRef<{ value: T; key: string } | undefined>(undefined);
  const place = useContext(SettingPlaceContext);
  const visible = useFeedbackVisible();
  const key = settingKey(place?.project ?? "", id);
  // Completions reach whichever render is current.
  const latest = useRef({
    saved,
    success,
    failure,
    visible,
    server,
    stale: false,
  });
  latest.current = { saved, success, failure, visible, server, stale: false };
  const current = useSyncExternalStore(subscribe, () =>
    notices.find((n) => n.key === key),
  );
  // Busy while any view's request for this project and setting runs.
  const busy = useSyncExternalStore(subscribe, () => inflight.has(key));
  // Any write of this setting that ended after this view's read started makes
  // that read old: read again, whichever view wrote and whenever it mounted.
  const ended = useSyncExternalStore(subscribe, () => writeEnds.get(key) ?? 0);
  // Until that read arrives the value is known to be old: nothing may edit or
  // send it (a draft seeded from it would write it back). A failed read leaves
  // the page's load error and retry in view.
  const since = ownEnd ?? readStart(source);
  const stale = since !== undefined && since < ended;
  latest.current.stale = stale;
  useEffect(() => {
    const at = readStart(source);
    if (at !== undefined && at < ended) latest.current.saved();
  }, [ended, source]);
  // A view replaced meanwhile (another project) ignores the response.
  const alive = useRef(true);
  const home = useRef("");
  useEffect(() => {
    alive.current = true;
    home.current = window.location.hash;
    if (place) reveals.set(key, place.reveal);
    return () => {
      alive.current = false;
      if (reveals.get(key) === place?.reveal) reveals.delete(key);
      // A failure not yet reported that the reader may have missed: never
      // in view, or shown just as they left (a link or Back changes the
      // address a moment later). Report it once here.
      const last = shown.current;
      if (
        last &&
        place &&
        !last.reported &&
        (!last.seen || performance.now() - last.at < UNSEEN_MS)
      )
        showNotice({
          key,
          message: last.text,
          cause: last.cause,
          value: last.value,
          project: place.project,
          panel: place.panel,
        });
    };
  }, [key, place]);
  // In view: the row takes this setting's notice over and shows the failure
  // itself, unless its read already shows the value that was not confirmed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: inView reads refs and the project in `key`.
  useEffect(() => {
    if (!visible) return;
    if (shown.current) shown.current.seen = true;
    if (current?.key !== key || !inView()) return;
    clearNotice(key);
    if (confirmable && same(current.value, latest.current.server)) return;
    setError(current.cause);
    shown.current = {
      text: current.message,
      cause: current.cause,
      value: current.value,
      at: performance.now(),
      seen: true,
      reported: false,
    };
  }, [visible, key, current, confirmable]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new read is the trigger.
  useEffect(() => {
    if (!confirmable) return;
    const at = readStart(source);
    if (at !== undefined) confirmRead(key, at, server);
    // A read showing the value confirms the write even if its response was lost.
    if (pending.current && same(pending.current.value, server))
      pending.current = undefined;
    // ...and retires its failure here and in the shared notice.
    if (shown.current && same(shown.current.value, server)) {
      shown.current = undefined;
      setError("");
    }
    const reported = notices.find((n) => n.key === key);
    if (reported && same(reported.value, server)) clearNotice(key);
  }, [source]);
  /** Still on this project's settings with the panel shown (URL already counts). */
  const inView = () => {
    if (!alive.current || !latest.current.visible) return false;
    const hash = window.location.hash;
    if (hash === home.current) return true;
    const route = parseRoute(hash);
    return route?.kind === "settings" && route.projectId === place?.project;
  };
  const save = async (next: T): Promise<boolean> => {
    if (inflight.has(key) || latest.current.stale) return false;
    const startedAt = settingsTick();
    beginSave(key);
    setError("");
    setMessage("");
    shown.current = undefined;
    clearNotice(key);
    const idempotency =
      pending.current && same(pending.current.value, next)
        ? pending.current.key
        : crypto.randomUUID();
    pending.current = { value: next, key: idempotency };
    let ok = false;
    try {
      await write(next, idempotency);
      ok = true;
      if (!alive.current) return ok;
      pending.current = undefined;
      setValue(next);
      setMessage(latest.current.success(next));
    } catch (thrown) {
      // A read that started after this write began already shows its value:
      // the write took effect and only its reply was lost.
      const read = confirmed.get(key);
      if (
        confirmable &&
        read &&
        read.at > startedAt &&
        same(read.value, next)
      ) {
        if (alive.current) pending.current = undefined;
        return true;
      }
      const what = latest.current.failure?.(next) ?? `未能保存“${name}”`;
      const text = `${what}，请回到设置重试`;
      // Named, so failures shown together stay identifiable.
      const cause = `${what}：${describeWriteError(thrown)}`;
      const away = !inView();
      if (alive.current) {
        setError(cause);
        shown.current = {
          text,
          cause,
          value: next,
          at: performance.now(),
          seen: !away,
          reported: away && !!place,
        };
      }
      if (away && place)
        showNotice({
          key,
          message: text,
          cause,
          value: next,
          project: place.project,
          panel: place.panel,
        });
    } finally {
      const end = settingsTick();
      // Only an acknowledged write tells this view the value: after a failure
      // it may still have taken effect, so the view waits for the read again.
      if (ok && alive.current) setOwnEnd(end);
      endSave(key, end);
      // With no view mounted, nothing reacts to the write's end. A source
      // that outlives the page (the shared capacity read) is read again here
      // so it shows the result and confirms or keeps a failure (C-479).
      if (!alive.current && sharedSource) latest.current.saved();
    }
    return ok;
  };
  const clear = () => {
    setError("");
    setMessage("");
    shown.current = undefined;
  };
  // `busy` locks editing; `saving` is the request in flight (the page shows
  // its own loading while the read again runs).
  return {
    value,
    busy: busy || stale,
    saving: busy,
    error,
    message,
    save,
    clear,
  };
}

/** Failure wording for an on/off setting. */
export const toggleFailure = (name: string) => (next: boolean) =>
  next ? `未能开启“${name}”` : `未能关闭“${name}”`;

/**
 * Integer draft over a confirmed value: follows new confirmed values unless it
 * holds an unsaved edit, and is dirty against the last confirmed write.
 * Only a user edit commits: a blur or Enter without an edit since the last
 * commit (for example tabbing through a read-only field) writes nothing.
 */
export function useNumberDraft(confirmed: number, min: number, max: number) {
  const [draft, setDraft] = useState(String(confirmed));
  const [shown, setShown] = useState(confirmed);
  const edited = useRef(false);
  // Bumped when another control decides, so an older commit stays settled.
  const decided = useRef(0);
  if (shown !== confirmed) {
    setShown(confirmed);
    if (draft === String(shown)) setDraft(String(confirmed));
  }
  const valid =
    /^\d+$/.test(draft) && Number(draft) >= min && Number(draft) <= max;
  const dirty = draft !== String(confirmed);
  return {
    draft,
    setDraft: (value: string) => {
      edited.current = true;
      setDraft(value);
    },
    valid,
    dirty,
    /** Another control decided (e.g. a switch): the edit is no longer pending. */
    settle: () => {
      edited.current = false;
      decided.current++;
    },
    commit: async (save: (value: number) => Promise<boolean>) => {
      if (!edited.current || !valid || !dirty) return;
      edited.current = false;
      const at = decided.current;
      // A failed or deferred write keeps the edit for the next blur or Enter,
      // unless another control decided meanwhile (it cancelled the edit).
      if (!(await save(Number(draft))) && decided.current === at)
        edited.current = true;
    },
  };
}
