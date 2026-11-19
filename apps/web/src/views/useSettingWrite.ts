import {
  createContext,
  createElement,
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

/** Closing or reloading the tab asks first while a settings save is in flight. */
let saving = 0;
const warn = (event: BeforeUnloadEvent) => {
  event.preventDefault();
  event.returnValue = "";
};
function beginSave() {
  if (saving++ === 0) window.addEventListener("beforeunload", warn);
}
function endSave() {
  if (--saving === 0) window.removeEventListener("beforeunload", warn);
}

/** A failure shown this recently may not have been seen before leaving. */
const UNSEEN_MS = 500;

/** The settings panel a setting is shown in (provided by SettingsPage). */
export interface SettingPlace {
  project: string;
  panel: "preferences" | "authorization";
  /** Shows the panel when it is hidden behind another one. */
  reveal: () => void;
}
export const SettingPlaceContext = createContext<SettingPlace | undefined>(
  undefined,
);

/**
 * A failed save the reader is not looking at (C-455#326): they left the
 * settings page, or switched to another panel, before it answered. Shown once
 * in the shared feedback stack by `SettingsSaveNotice` until the setting is in
 * view again, saved again, or the action is used.
 */
interface SaveNotice {
  key: string;
  message: string;
  project: string;
  panel: SettingPlace["panel"];
}
let notice: SaveNotice | undefined;
const noticeListeners = new Set<() => void>();
const reveals = new Map<string, () => void>();
function showNotice(next: SaveNotice | undefined) {
  notice = next;
  for (const listener of noticeListeners) listener();
}
function clearNotice(key: string) {
  if (notice?.key === key) showNotice(undefined);
}
const subscribe = (listener: () => void) => {
  noticeListeners.add(listener);
  return () => noticeListeners.delete(listener);
};

/** Rendered once by the app shell, outside any page. */
export function SettingsSaveNotice() {
  const current = useSyncExternalStore(subscribe, () => notice);
  const back = () => {
    if (!current) return;
    showNotice(undefined);
    const reveal = reveals.get(current.key);
    if (reveal) return reveal();
    window.location.hash = routeHash({
      kind: "settings",
      projectId: current.project,
      ...(current.panel === "authorization"
        ? { filters: { tab: "authorization" } }
        : {}),
    });
  };
  return createElement(RequestFeedback, {
    error: current?.message,
    retry: current ? back : undefined,
    retryLabel: "回到设置",
  });
}

/** Test isolation only: forget saves and notices a test left behind. */
export function resetSettingWrites() {
  saving = 0;
  window.removeEventListener("beforeunload", warn);
  reveals.clear();
  showNotice(undefined);
}

/**
 * Instant-save lifecycle of one setting (C-455).
 *
 * - `value` is the last confirmed value: the server value of the newest read,
 *   or the acknowledged write until the next read arrives (`source` changes).
 *   useResource only applies the newest read, which starts after the write.
 * - One save at a time: a change while saving is ignored (callers mark the
 *   control `aria-disabled` and keep it focusable).
 * - A failed write keeps its idempotency key for a retry of the same value; a
 *   different value, a success, or a read showing the value retires the key.
 * - Leaving never waits: the save still completes. A failure the reader is no
 *   longer looking at is reported once (`SettingsSaveNotice`); success adds
 *   nothing. A page shown again edits what its own read returned.
 */
export function useSettingWrite<T>({
  name,
  failure,
  server,
  source,
  confirmable = true,
  write,
  saved,
  success,
}: {
  /** The setting's name, for a failure reported away from it. */
  name: string;
  /** What did not happen, e.g. 未能撤销“对外发布”授权; defaults to 未能保存“name”. */
  failure?: (value: T) => string;
  server: T;
  /** Identity of the read that produced `server`; a new read resets `value`. */
  source: unknown;
  /** False when `server` is a derived default that cannot confirm a write. */
  confirmable?: boolean;
  write: Write<T>;
  saved: () => void;
  success: (value: T) => string;
}) {
  const [value, setValue] = useState(server);
  const [read, setRead] = useState(source);
  if (read !== source) {
    setRead(source);
    setValue(server);
  }
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useNotice();
  // The latest failure shown here, kept for a leave right after it.
  const shown = useRef<{ text: string; at: number } | undefined>(undefined);
  const pending = useRef<{ value: T; key: string } | undefined>(undefined);
  const place = useContext(SettingPlaceContext);
  const visible = useFeedbackVisible();
  const key = `${place?.project ?? ""}:${name}`;
  // Completions reach whichever render is current.
  const latest = useRef({ saved, success, failure, visible });
  latest.current = { saved, success, failure, visible };
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
      // A failure that answered as the reader was leaving (a link or Back
      // changes the address a moment later) or behind another panel may not
      // have been seen: report it once here too.
      const last = shown.current;
      if (
        last &&
        place &&
        (!latest.current.visible || Date.now() - last.at < UNSEEN_MS)
      )
        showNotice({
          key,
          message: last.text,
          project: place.project,
          panel: place.panel,
        });
    };
  }, [key, place]);
  // In view again: the row shows the failure itself.
  useEffect(() => {
    if (visible) clearNotice(key);
  }, [visible, key]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new read is the trigger.
  useEffect(() => {
    // A read showing the value confirms the write even if its response was lost.
    if (confirmable && pending.current && same(pending.current.value, server)) {
      pending.current = undefined;
      setError("");
    }
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
    if (sending.current) return false;
    sending.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    shown.current = undefined;
    clearNotice(key);
    const idempotency =
      pending.current && same(pending.current.value, next)
        ? pending.current.key
        : crypto.randomUUID();
    pending.current = { value: next, key: idempotency };
    beginSave();
    let ok = false;
    try {
      await write(next, idempotency);
      ok = true;
      if (!alive.current) return ok;
      pending.current = undefined;
      setValue(next);
      setMessage(latest.current.success(next));
      latest.current.saved();
    } catch (cause) {
      const text = `${latest.current.failure?.(next) ?? `未能保存“${name}”`}，请回到设置重试`;
      if (alive.current) {
        setError(describeWriteError(cause));
        shown.current = { text, at: Date.now() };
      }
      if (!inView() && place)
        showNotice({
          key,
          message: text,
          project: place.project,
          panel: place.panel,
        });
    } finally {
      sending.current = false;
      if (alive.current) setBusy(false);
      endSave();
    }
    return ok;
  };
  const clear = () => {
    setError("");
    setMessage("");
    shown.current = undefined;
  };
  return { value, busy, error, message, save, clear };
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
