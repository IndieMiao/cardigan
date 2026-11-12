/** C-164: trusted operational limits, independent of candidate code and stdin. */
export const CHECKOUT_LIMITS = {
  handshakeMs: 30_000,
  lockWaitMs: 30_000,
  entryMs: 70_000,
  graceMs: 120_000,
  remoteCommandMs: 60_000,
  orphanAgeMs: 60_000,
  sweepIntervalMs: 60_000,
  killGraceMs: 500,
} as const;

/** A phase marker, removed synchronously before any checkout work starts. */
export const CHECKOUT_HANDSHAKE_TITLE = "cardigan-check-handshake-v1";
