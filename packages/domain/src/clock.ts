import type { Timestamp } from "./entities.js";

export interface Clock {
  now(): Timestamp;
}
