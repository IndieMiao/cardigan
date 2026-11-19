import { useEffect, useRef, useState } from "react";
import { describeWriteError } from "../api.js";

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

/**
 * Instant-save lifecycle of one setting (C-455).
 *
 * - `value` is the last confirmed value: the server value of the newest read,
 *   or the acknowledged write until the next read arrives (`source` changes).
 *   useResource only applies the newest read, which starts after the write.
 * - A failed write keeps its idempotency key for a retry of the same value; a
 *   different value, a success, or a read showing the value retires the key.
 * - Writes never overlap; callers keep controls focusable (`aria-disabled`).
 *   A different value chosen during a write runs after it (the latest intent
 *   wins); repeating the in-flight value is ignored.
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
  write: (value: T, key: string) => Promise<void>;
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
  const [error, setError] = useState("");
  const [message, setMessage] = useNotice();
  const sending = useRef(false);
  const pending = useRef<{ value: T; key: string } | undefined>(undefined);
  const inFlight = useRef<{ value: T } | undefined>(undefined);
  const queued = useRef<{ value: T } | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
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
    if (sending.current) {
      queued.current = same(inFlight.current?.value, next)
        ? undefined
        : { value: next };
      return false;
    }
    sending.current = true;
    inFlight.current = { value: next };
    let ok = false;
    setBusy(true);
    setError("");
    setMessage("");
    const key =
      pending.current && same(pending.current.value, next)
        ? pending.current.key
        : crypto.randomUUID();
    pending.current = { value: next, key };
    try {
      await write(next, key);
      if (pending.current?.key === key) pending.current = undefined;
      if (!mounted.current) return true;
      ok = true;
      setValue(next);
      setMessage(success(next));
      saved();
      return true;
    } catch (cause) {
      if (mounted.current) setError(describeWriteError(cause));
      return false;
    } finally {
      sending.current = false;
      inFlight.current = undefined;
      if (mounted.current) setBusy(false);
      const later = queued.current;
      queued.current = undefined;
      if (later && mounted.current && !(ok && same(later.value, next)))
        void save(later.value);
    }
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
    commit: async (save: (value: number) => Promise<boolean>) => {
      if (!edited.current || !valid || !dirty) return;
      edited.current = false;
      // A failed or deferred write keeps the edit for the next blur or Enter.
      if (!(await save(Number(draft)))) edited.current = true;
    },
  };
}
