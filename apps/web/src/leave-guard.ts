/**
 * C-503: in-app ways out that the page itself performs (closing the card
 * drawer) ask an unsent draft first. A guard returns true when it took over;
 * it then calls `leave` itself once the person chooses to discard.
 */
type LeaveGuard = (leave: () => void) => boolean;

const guards = new Set<LeaveGuard>();

export function registerLeaveGuard(guard: LeaveGuard): () => void {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

/** Leave now, unless a registered draft asks first. */
export function guardLeave(leave: () => void): void {
  for (const guard of guards) if (guard(leave)) return;
  leave();
}
