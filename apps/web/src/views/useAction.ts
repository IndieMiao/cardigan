import { useRef, useState } from "react";
import { describeWriteError } from "../api.js";

/**
 * One human write at a time with its feedback. The same input retried reuses
 * its idempotency key; a success drops it and calls `done`.
 */
export function useAction(done: () => void) {
  const keys = useRef(new Map<string, string>());
  const sending = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>(),
    [message, setMessage] = useState("");
  return {
    busy,
    error,
    message,
    clearFeedback: () => {
      if (sending.current) return;
      setError(undefined);
      setMessage("");
    },
    run: async (
      input: readonly unknown[],
      action: (key: string) => Promise<void>,
    ) => {
      if (sending.current) return;
      sending.current = true;
      const request = JSON.stringify(input);
      const key = keys.current.get(request) ?? crypto.randomUUID();
      keys.current.set(request, key);
      setBusy(true);
      setError(undefined);
      setMessage("");
      try {
        await action(key);
        keys.current.delete(request);
        setMessage("已提交");
        done();
      } catch (e) {
        setError(describeWriteError(e));
      } finally {
        sending.current = false;
        setBusy(false);
      }
    },
  };
}
