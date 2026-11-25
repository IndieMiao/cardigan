import {
  parseCapabilityRequirement,
  type WorkItemRequirements,
} from "@cardigan/domain";
import type { CapabilityNoteInput } from "@cardigan/roles";
import { readCapabilityGuides, type Store } from "@cardigan/store";

/**
 * C-726: the usage notes of the capabilities a work item requires, merged
 * for the machine its Run starts on. Undefined when the work item requires
 * no capability, so the launch input (and the Core Prompt) stays exactly as
 * before. The notes are advisory: a read failure never fails the launch.
 */
export function launchCapabilityNotes(
  store: Store,
  project: string,
  machine_id: string,
  requirements: WorkItemRequirements | undefined,
): readonly CapabilityNoteInput[] | undefined {
  const keys = (requirements?.capabilities ?? []).flatMap((requirement) => {
    const parsed = parseCapabilityRequirement(requirement);
    return parsed.ok ? [parsed.value.key] : [];
  });
  if (keys.length === 0) return undefined;
  try {
    return readCapabilityGuides(store, project, {
      machine_id,
      capabilities: keys,
    }).capabilities;
  } catch {
    return undefined;
  }
}
