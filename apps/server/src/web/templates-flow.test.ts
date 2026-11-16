import { builtinCardTemplates } from "@cardigan/domain";
import { expect, test } from "vitest";
import { fixture } from "../../../../packages/domain/src/commands/test-fixtures.js";
import { templateHistory, templateList } from "./read.js";

test.each([1, 4, 5])(
  "web template catalog and history use flow %s registration",
  (version) => {
    const base = fixture();
    const state = {
      ...base,
      card_templates: [...builtinCardTemplates],
      project_preferences: [
        {
          id: base.project_id,
          auto_merge_after_minutes: null,
          flow_version: version,
        },
      ],
    };
    const list = templateList(state);
    expect(list.find((t) => t?.id === "dev")?.version).toBe(
      version === 5 ? 2 : 1,
    );
    expect(list.some((t) => t?.id === "product")).toBe(version === 5);
    expect(templateHistory(state, "dev").map((t) => t.version)).toEqual(
      version === 5 ? [2, 1] : [1],
    );
    expect(templateHistory(state, "product")).toHaveLength(
      version === 5 ? 1 : 0,
    );
  },
);
