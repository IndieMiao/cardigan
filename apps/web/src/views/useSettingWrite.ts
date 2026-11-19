import { useEffect, useRef, useState } from "react";
import { describeWriteError } from "../api.js";
import { holdNavigation } from "../route.js";

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

/**
 * Settings saves in flight on this page. While any runs, leaving the page
 * waits for it (`holdNavigation`): after success the reader moves on, after a
 * failure they stay and see it. Closing or reloading the tab asks first.
 */
let saving = 0;
let failed = false;
let release: ((proceed: boolean) => void) | undefined;
const warn = (event: BeforeUnloadEvent) => {
  event.preventDefault();
  event.returnValue = "";
};
function beginSave() {
  if (saving++ > 0) return;
  failed = false;
  release = holdNavigation();
  window.addEventListener("beforeunload", warn);
}
/** Test isolation only: forget saves a test left unfinished. */
export function resetSettingWrites() {
  saving = 0;
  window.removeEventListener("beforeunload", warn);
  release?.(false);
  release = undefined;
}
function endSave(ok: boolean) {
  if (!ok) failed = true;
  if (--saving > 0) return;
  window.removeEventListener("beforeunload", warn);
  const done = release;
  release = undefined;
  done?.(!failed);
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
 * - State belongs to this view; a page shown again edits what its own read
 *   returned.
 */
export function useSettingWrite<T>({
  server,
  source,
  confirmable = true,
  write,
  saved,
  success,
}: {
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
  const pending = useRef<{ value: T; key: string } | undefined>(undefined);
  // Completions reach whichever render is current.
  const latest = useRef({ saved, success });
  latest.current = { saved, success };
  // A view replaced meanwhile (another project) ignores the response.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new read is the trigger.
  useEffect(() => {
    // A read showing the value confirms the write even if its response was lost.
    if (confirmable && pending.current && same(pending.current.value, server)) {
      pending.current = undefined;
      setError("");
    }
  }, [source]);
  const save = async (next: T): Promise<boolean> => {
    if (sending.current) return false;
    sending.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    const key =
      pending.current && same(pending.current.value, next)
        ? pending.current.key
        : crypto.randomUUID();
    pending.current = { value: next, key };
    beginSave();
    let ok = false;
    try {
      await write(next, key);
      ok = true;
      if (!alive.current) return ok;
      pending.current = undefined;
      setValue(next);
      setMessage(latest.current.success(next));
      latest.current.saved();
    } catch (cause) {
      if (alive.current) setError(describeWriteError(cause));
    } finally {
      sending.current = false;
      if (alive.current) setBusy(false);
      endSave(ok);
    }
    return ok;
  };
  const clear = () => {
    setError("");
    setMessage("");
  };
  return { value, busy, error, message, save, clear };
}

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
