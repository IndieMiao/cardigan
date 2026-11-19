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

type Write<T> = (value: T, key: string) => Promise<void>;
interface Listener {
  start(): void;
  idle(): void;
  done(value: unknown): void;
  failed(message: string): void;
}
/**
 * Write state of one setting of one project, shared by every mounted view of
 * it and kept across navigation: a view that remounts joins the same queue,
 * and a failure nobody saw is shown by the next view of that setting.
 */
interface Channel {
  sending: boolean;
  inFlight: { value: unknown } | undefined;
  queued: { value: unknown; write: Write<unknown> } | undefined;
  /** Idempotency key of the newest write not yet confirmed. */
  pending: { value: unknown; key: string } | undefined;
  unseenError: string | undefined;
  /**
   * A write confirmed while no view listened. The next view may hold a read
   * that started before it, so it shows this value and reads again.
   */
  unseenDone: { value: unknown } | undefined;
  listeners: Set<Listener>;
}
const channels = new Map<string, Channel>();
const channel = (id: string) => {
  let found = channels.get(id);
  if (!found) {
    found = {
      sending: false,
      inFlight: undefined,
      queued: undefined,
      pending: undefined,
      unseenError: undefined,
      unseenDone: undefined,
      listeners: new Set(),
    };
    channels.set(id, found);
  }
  return found;
};
/** Test isolation only: forget every shared write channel. */
export function resetSettingWrites() {
  channels.clear();
}

async function run(c: Channel, next: unknown, write: Write<unknown>) {
  c.sending = true;
  c.inFlight = { value: next };
  for (const l of c.listeners) l.start();
  const key =
    c.pending && same(c.pending.value, next)
      ? c.pending.key
      : crypto.randomUUID();
  c.pending = { value: next, key };
  let ok = false;
  try {
    await write(next, key);
    ok = true;
    if (c.pending?.key === key) c.pending = undefined;
    c.unseenError = undefined;
    c.unseenDone = c.listeners.size ? undefined : { value: next };
    for (const l of c.listeners) l.done(next);
  } catch (cause) {
    const message = describeWriteError(cause);
    if (c.listeners.size) for (const l of c.listeners) l.failed(message);
    else c.unseenError = message;
  } finally {
    c.sending = false;
    c.inFlight = undefined;
    const later = c.queued;
    c.queued = undefined;
    if (later && !(ok && same(later.value, next)))
      void run(c, later.value, later.write);
    else for (const l of c.listeners) l.idle();
  }
  return ok;
}

/**
 * Instant-save lifecycle of one setting (C-455).
 *
 * - `value` is the last confirmed value: the server value of the newest read,
 *   or the acknowledged write until the next read arrives (`source` changes).
 *   useResource only applies the newest read, which starts after the write.
 * - A failed write keeps its idempotency key for a retry of the same value; a
 *   different value, a success, or a read showing the value retires the key.
 * - Writes of one setting never overlap, across views and navigation (`id`
 *   names the project and setting). A different value chosen during a write
 *   runs after it (the latest intent wins, including one made in a remounted
 *   view); repeating the in-flight value is ignored. Callers keep controls
 *   focusable (`aria-disabled`).
 */
export function useSettingWrite<T>({
  id,
  server,
  source,
  confirmable = true,
  write,
  saved,
  success,
}: {
  /** Project and setting, e.g. `p-1:auto-merge-after`. */
  id: string;
  server: T;
  /** Identity of the read that produced `server`; a new read resets `value`. */
  source: unknown;
  /** False when `server` is a derived default that cannot confirm a write. */
  confirmable?: boolean;
  write: Write<T>;
  saved: () => void;
  success: (value: T) => string;
}) {
  const c = channel(id);
  const [value, setValue] = useState(server);
  const [read, setRead] = useState(source);
  if (read !== source) {
    setRead(source);
    setValue(server);
  }
  const [busy, setBusy] = useState(c.sending);
  const [error, setError] = useState("");
  const [message, setMessage] = useNotice();
  // Completions reach whichever render is current.
  const latest = useRef({ saved, success });
  latest.current = { saved, success };
  useEffect(() => {
    const listener: Listener = {
      start() {
        setBusy(true);
        setError("");
        setMessage("");
      },
      idle() {
        setBusy(false);
      },
      done(next) {
        setValue(next as T);
        setMessage(latest.current.success(next as T));
        latest.current.saved();
      },
      failed(text) {
        setError(text);
      },
    };
    c.listeners.add(listener);
    setBusy(c.sending);
    if (c.unseenError) {
      setError(c.unseenError);
      c.unseenError = undefined;
    }
    const unseen = c.unseenDone;
    if (unseen) {
      c.unseenDone = undefined;
      setValue(unseen.value as T);
      latest.current.saved();
    }
    return () => {
      c.listeners.delete(listener);
    };
  }, [c, setMessage]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new read is the trigger.
  useEffect(() => {
    // A read showing the value confirms the write even if its response was lost.
    if (confirmable && c.pending && same(c.pending.value, server)) {
      c.pending = undefined;
      setError("");
    }
  }, [source]);
  const save = async (next: T): Promise<boolean> => {
    if (c.sending) {
      c.queued = same(c.inFlight?.value, next)
        ? undefined
        : { value: next, write: write as Write<unknown> };
      return false;
    }
    return run(c, next, write as Write<unknown>);
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
