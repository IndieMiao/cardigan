import {
  parseId,
  parseTimelineEntryId,
  type ReadableIdKind,
} from "@cardigan/domain";
import { z } from "zod";
import { unwrap } from "./execute.js";

export const id = <K extends ReadableIdKind>(kind: K) =>
  z
    .string()
    .refine((s) => parseId(kind, s).ok, `Invalid ${kind} ID`)
    .transform((s) => unwrap(parseId(kind, s)).id);
export const entryId = z
  .string()
  .refine((s) => parseTimelineEntryId(s).ok, "Invalid timeline entry ID")
  .transform((s) => unwrap(parseTimelineEntryId(s)).id);
export const idempotency_key = z
  .string()
  .min(1)
  .max(200)
  .refine((key) => key.trim().length > 0, "Idempotency key must not be blank");
