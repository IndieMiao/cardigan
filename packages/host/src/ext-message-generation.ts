import { lstatSync } from "node:fs";

export interface ExtGeneration {
  path: string;
  stamp: string;
}
/** YAML is the only publication point; replacement secret files are immutable. */
export function extGenerationStamp(path: string) {
  try {
    const st = lstatSync(path, { throwIfNoEntry: false, bigint: true });
    return st ? `${st.dev}:${st.ino}:${st.ctimeNs}` : "missing";
  } catch {
    return "unavailable";
  }
}
export const currentExtGeneration = (g: ExtGeneration | undefined) =>
  !g || extGenerationStamp(g.path) === g.stamp;
