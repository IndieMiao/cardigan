/**
 * C-707: a new device's QR code opens `<Workbench>/#/pair/<code>` (C-705).
 * The code is read when the page starts (or the link is entered into an open
 * page) and the fragment is cleared at once with `history.replaceState`, so it
 * stays neither in the address bar nor in the browser history (also while the
 * login page is shown). It lives only in this module until the machine panel
 * takes it; a reload forgets it.
 */
let pending: string | undefined;
const listeners = new Set<() => void>();
const PAIR_LINK = /^#\/*pair\/([^/?#]{1,40})$/u;

export function capturePairingLink(
  location: Pick<Location, "hash" | "pathname" | "search"> = window.location,
  history: Pick<History, "replaceState" | "state"> = window.history,
): void {
  const match = PAIR_LINK.exec(location.hash);
  if (!match) return;
  let code: string | undefined;
  try {
    code = decodeURIComponent(match[1] ?? "").trim();
  } catch {
    code = undefined;
  }
  // Whatever it holds, the fragment goes: a malformed code is not kept either.
  history.replaceState(history.state, "", location.pathname + location.search);
  if (!code) return;
  pending = code;
  for (const listener of listeners) listener();
}

/**
 * Captures now and whenever the hash changes. Registered before the router's
 * own listener, so the router only ever sees the cleared address.
 */
export function watchPairingLinks(): void {
  capturePairingLink();
  window.addEventListener("hashchange", () => capturePairingLink());
}

/** A captured code the machine panel has not taken yet. */
export function pendingPairingCode(): string | undefined {
  return pending;
}

export function subscribePairingCode(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Hands the captured code over once. */
export function takePairingCode(): string | undefined {
  const code = pending;
  pending = undefined;
  if (code !== undefined) for (const listener of listeners) listener();
  return code;
}
