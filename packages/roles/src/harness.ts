import {
  type AgentBinary,
  HARNESS_CATALOG,
  HARNESSES,
  type Harness,
} from "@cardigan/domain";

export { HARNESSES, type Harness, isHarness } from "@cardigan/domain";
/** Compatibility projection of the public catalog. */
export const HARNESS_BINARY = Object.freeze(
  Object.fromEntries(
    HARNESSES.map((id) => [id, HARNESS_CATALOG[id].binary]),
  ) as Record<Harness, AgentBinary>,
);
