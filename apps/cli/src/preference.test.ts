import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

let dataDir: string,
  io: CliIo,
  output: string[],
  errors: string[],
  store: Store;
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-preference-cli-"));
  output = [];
  errors = [];
  io = {
    env: { CARDIGAN_DATA_DIR: dataDir },
    cwd: dataDir,
    platform: "linux",
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    signals: { on: () => {}, off: () => {} },
    spawnInherit: () => {
      throw new Error("No Agent needed");
    },
    captureCommand: async () => {
      throw new Error("No Git needed");
    },
  };
  expect(await main(["project", "create", "preferences"], io)).toBe(0);
  store = Store.open({ dataDir });
});
afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});
const run = (args: string[]) => {
  output = [];
  errors = [];
  return main(args, io);
};

test("C-239: human configures auto-review switch, explicit cap and paths without defaults", async () => {
  for (const [name, empty, setting] of [
    ["system-review-limit-raise", "false", "on"],
    ["system-review-limit-max-raises", "null", "2"],
    ["role-rule-paths", "null", '["packages/roles/**","AGENTS.md"]'],
  ] as const) {
    expect(await run(["preference", "get", name])).toBe(0);
    expect(output).toContain(`${name}: ${empty}`);
    expect(await run(["preference", "set", name, setting])).toBe(0);
  }
  const preferences = () =>
    store.uow.read((tx) =>
      tx.project_preferences.get("preferences", "preferences"),
    );
  expect(preferences()).toMatchObject({
    system_review_limit_raise: true,
    system_review_limit_max_raises: 2,
    role_rule_paths: ["packages/roles/**", "AGENTS.md"],
  });
  for (const [name, invalid] of [
    ["system-review-limit-raise", "yes"],
    ["system-review-limit-max-raises", "0"],
    ["system-review-limit-max-raises", "1.5"],
    ["system-review-limit-max-raises", "9007199254740992"],
    ["role-rule-paths", '["../roles"]'],
    ["role-rule-paths", "not-json"],
  ] as const)
    expect(await run(["preference", "set", name, invalid])).not.toBe(0);
  expect(preferences()?.system_review_limit_max_raises).toBe(2);
  for (const name of ["system-review-limit-max-raises", "role-rule-paths"])
    expect(await run(["preference", "set", name, "off"])).toBe(0);
  expect(preferences()).toMatchObject({
    system_review_limit_max_raises: null,
    role_rule_paths: null,
  });
  const audit = store.uow
    .read((tx) => tx.events.listAfter("preferences", undefined, 0))
    .filter((e) => e.type === "project_preferences_updated");
  expect(audit).toHaveLength(5);
  expect(audit.every((e) => e.actor.kind === "human")).toBe(true);
});

test("preference get/set persists minutes and off, with project isolation", async () => {
  expect(await run(["preference", "get", "auto-merge-after"])).toBe(0);
  expect(output).toContain("auto-merge-after: off");
  expect(await run(["preference", "set", "auto-merge-after", "10"])).toBe(0);
  expect(
    await run([
      "preference",
      "get",
      "auto-merge-after",
      "--project",
      "preferences",
    ]),
  ).toBe(0);
  expect(output).toContain("auto-merge-after: 10");
  expect(await run(["project", "create", "other"])).toBe(0);
  expect(
    await run(["preference", "get", "auto-merge-after", "--project", "other"]),
  ).toBe(0);
  expect(output).toContain("auto-merge-after: off");
  expect(
    await run([
      "preference",
      "set",
      "auto-merge-after",
      "off",
      "--project",
      "preferences",
    ]),
  ).toBe(0);
  expect(
    store.uow.read((tx) =>
      tx.project_preferences.get("preferences", "preferences"),
    )?.auto_merge_after_minutes,
  ).toBeNull();
  expect(
    store.uow
      .read((tx) => tx.events.listAfter("preferences", undefined, 0))
      .filter((e) => e.type === "project_preferences_updated"),
  ).toHaveLength(2);
});

test("independent review grant defaults off and enabling records the approved three-use budget", async () => {
  const key = "independent-review-limit-delegation";
  expect(await run(["preference", "get", key])).toBe(0);
  expect(await run(["preference", "set", key, "on"])).toBe(0);
  expect(
    store.uow.read((tx) =>
      tx.project_preferences.get("preferences", "preferences"),
    ),
  ).toMatchObject({
    independent_review_limit_delegation: true,
    independent_review_limit_delegation_max: 3,
  });
  for (const max of ["1", "2", "4", "0", "1.5", "off"])
    expect(await run(["preference", "set", `${key}-max`, max])).not.toBe(0);
  expect(await run(["preference", "set", key, "off"])).toBe(0);
  expect(
    store.uow.read((tx) =>
      tx.project_preferences.get("preferences", "preferences"),
    ),
  ).toMatchObject({
    independent_review_limit_delegation: false,
    independent_review_limit_delegation_max: 3,
  });
});
test("precheck waiting and independent review grants persist separately when toggled together", async () => {
  const wait = "code-review-waits-for-precheck";
  const grant = "independent-review-limit-delegation";
  const preferences = () =>
    store.uow.read((tx) =>
      tx.project_preferences.get("preferences", "preferences"),
    );
  for (const key of [wait, grant]) {
    expect(await run(["preference", "get", key])).toBe(0);
    expect(output.join("\n")).toContain(`${key}: off`);
    expect(await run(["preference", "set", key, "on"])).toBe(0);
  }
  expect(preferences()).toMatchObject({
    code_review_waits_for_precheck: true,
    independent_review_limit_delegation: true,
    independent_review_limit_delegation_max: 3,
  });
  const beforeInvalid = preferences();
  expect(await run(["preference", "set", wait, "3"])).not.toBe(0);
  expect(await run(["preference", "set", `${grant}-max`, "4"])).not.toBe(0);
  expect(preferences()).toEqual(beforeInvalid);

  expect(await run(["preference", "set", wait, "off"])).toBe(0);
  expect(preferences()).toMatchObject({
    code_review_waits_for_precheck: false,
    independent_review_limit_delegation: true,
    independent_review_limit_delegation_max: 3,
  });
  expect(await run(["preference", "set", wait, "on"])).toBe(0);
  expect(await run(["preference", "set", grant, "off"])).toBe(0);
  expect(preferences()).toMatchObject({
    code_review_waits_for_precheck: true,
    independent_review_limit_delegation: false,
    independent_review_limit_delegation_max: 3,
  });
  expect(await run(["preference", "get", wait])).toBe(0);
  expect(output).toContain(`${wait}: on`);
  expect(await run(["preference", "get", `${grant}-max`])).toBe(0);
  expect(output.join("\n")).toContain(`${grant}-max: 3`);
  expect(await run(["project", "create", "other"])).toBe(0);
  for (const key of [wait, grant]) {
    expect(await run(["preference", "get", key, "--project", "other"])).toBe(0);
    expect(output.join("\n")).toContain(`${key}: off`);
  }
});

test.each(["0", "1441", "1.5", "-10", "NaN", "1e2", "on"])(
  "rejects invalid minutes %s",
  async (minutes) => {
    expect(
      await run(["preference", "set", "auto-merge-after", minutes]),
    ).not.toBe(0);
    expect(
      store.uow.read((tx) => tx.project_preferences.list("preferences")),
    ).toEqual([]);
  },
);

test("merge-confirm-stall-after defaults to 60, persists minutes with an audit event and rejects off", async () => {
  expect(await run(["preference", "get", "merge-confirm-stall-after"])).toBe(0);
  expect(output).toContain("merge-confirm-stall-after: 60");
  expect(
    await run(["preference", "set", "merge-confirm-stall-after", "90"]),
  ).toBe(0);
  expect(output).toContain("merge-confirm-stall-after: 90");
  expect(
    store.uow.read((tx) =>
      tx.project_preferences.get("preferences", "preferences"),
    ),
  ).toMatchObject({
    merge_confirm_stall_after_minutes: 90,
    auto_merge_after_minutes: null,
  });
  expect(
    store.uow
      .read((tx) => tx.events.listAfter("preferences", undefined, 0))
      .filter((e) => e.type === "project_preferences_updated")
      .map((e) => e.payload),
  ).toEqual([
    {
      old_value: 60,
      new_value: 90,
      preference: "merge_confirm_stall_after_minutes",
    },
  ]);
  for (const bad of ["off", "0", "1441", "1.5"])
    expect(
      await run(["preference", "set", "merge-confirm-stall-after", bad]),
    ).not.toBe(0);
});

test("review round limits default to 5 and 3, persist with audit events and reject values outside 1..20", async () => {
  expect(await run(["preference", "get", "review-max-rounds"])).toBe(0);
  expect(output).toContain("review-max-rounds: 5 (只影响之后新建的审核项)");
  expect(
    await run(["preference", "get", "independent-review-max-rounds"]),
  ).toBe(0);
  expect(output).toContain(
    "independent-review-max-rounds: 3 (只影响之后新建的审核项)",
  );
  expect(await run(["preference", "set", "review-max-rounds", "7"])).toBe(0);
  expect(output).toContain("review-max-rounds: 7 (只影响之后新建的审核项)");
  expect(
    await run(["preference", "set", "independent-review-max-rounds", "4"]),
  ).toBe(0);
  expect(
    store.uow.read((tx) =>
      tx.project_preferences.get("preferences", "preferences"),
    ),
  ).toMatchObject({ review_max_rounds: 7, independent_review_max_rounds: 4 });
  expect(
    store.uow
      .read((tx) => tx.events.listAfter("preferences", undefined, 0))
      .filter((e) => e.type === "project_preferences_updated")
      .map((e) => e.payload),
  ).toEqual([
    { old_value: 5, new_value: 7, preference: "review_max_rounds" },
    { old_value: 3, new_value: 4, preference: "independent_review_max_rounds" },
  ]);
  for (const key of ["review-max-rounds", "independent-review-max-rounds"])
    for (const ok of ["11", "20"]) {
      expect(await run(["preference", "set", key, ok])).toBe(0);
      expect(output).toContain(`${key}: ${ok} (只影响之后新建的审核项)`);
    }
  for (const key of ["review-max-rounds", "independent-review-max-rounds"])
    for (const bad of ["off", "0", "21", "1.5", "-1"])
      expect(await run(["preference", "set", key, bad])).not.toBe(0);
});

test("delegation preferences persist separately from merge settings and reject fixed-risk categories", async () => {
  expect(await run(["preference", "get", "decision-delegation"])).toBe(0);
  expect(output.join("\n")).toContain("general: on (PM 代拍)");
  expect(await run(["preference", "set", "auto-merge-after", "10"])).toBe(0);
  expect(
    await run(["preference", "set", "decision-delegation", "general", "off"]),
  ).toBe(0);
  expect(await run(["preference", "get", "decision-delegation"])).toBe(0);
  expect(output.join("\n")).toContain("general: off (由人确认)");
  expect(await run(["preference", "get", "auto-merge-after"])).toBe(0);
  expect(output).toContain("auto-merge-after: 10");
  for (const category of ["spending", "account", "permission", "data_deletion"])
    expect(
      await run(["preference", "set", "decision-delegation", category, "on"]),
    ).not.toBe(0);
  expect(
    await run(["preference", "set", "decision-delegation", "unknown", "on"]),
  ).not.toBe(0);
});

test("PM merge confirmation defaults on and the human can switch it from the CLI", async () => {
  expect(await run(["preference", "get", "pm-merge-confirmation"])).toBe(0);
  expect(output).toEqual(["pm-merge-confirmation: on (PM 代确认合并)"]);
  expect(await run(["preference", "set", "pm-merge-confirmation", "off"])).toBe(
    0,
  );
  expect(output).toContain("pm-merge-confirmation: off (由人确认)");
  expect(await run(["preference", "get", "pm-merge-confirmation"])).toBe(0);
  expect(output).toEqual(["pm-merge-confirmation: off (由人确认)"]);
  expect(
    await run(["preference", "set", "pm-merge-confirmation", "maybe"]),
  ).not.toBe(0);
});

test("P2a-14 ⑧: reviewer-browser is off by default and the human can switch it", async () => {
  expect(await run(["preference", "get", "reviewer-browser"])).toBe(0);
  expect(output).toEqual([
    "reviewer-browser: off (灰度中，截图核对由 PM Office 或人核实)",
  ]);
  expect(await run(["preference", "set", "reviewer-browser", "on"])).toBe(0);
  expect(output).toContain(
    "reviewer-browser: on (界面卡的截图核对须由独立复核员审核通过，PM 才能代确认)",
  );
  expect(
    store.uow.read((tx) =>
      tx.project_preferences.get("preferences", "preferences"),
    )?.enable_reviewer_browser,
  ).toBe(true);
  expect(await run(["preference", "set", "reviewer-browser", "off"])).toBe(0);
  expect(await run(["preference", "get", "reviewer-browser"])).toBe(0);
  expect(output).toEqual([
    "reviewer-browser: off (灰度中，截图核对由 PM Office 或人核实)",
  ]);
  for (const bad of [
    ["set", "reviewer-browser", "maybe"],
    ["set", "reviewer-browser", "10"],
    ["set", "reviewer-browser"],
  ])
    expect(await run(["preference", ...bad])).not.toBe(0);
});

test("merge-confirm-snooze-default defaults to 240, persists minutes with an audit event and rejects off", async () => {
  expect(await run(["preference", "get", "merge-confirm-snooze-default"])).toBe(
    0,
  );
  expect(output).toContain("merge-confirm-snooze-default: 240");
  expect(
    await run(["preference", "set", "merge-confirm-snooze-default", "90"]),
  ).toBe(0);
  expect(output).toContain("merge-confirm-snooze-default: 90");
  expect(
    store.uow.read((tx) =>
      tx.project_preferences.get("preferences", "preferences"),
    ),
  ).toMatchObject({
    merge_confirm_snooze_default_minutes: 90,
    auto_merge_after_minutes: null,
  });
  expect(
    store.uow
      .read((tx) => tx.events.listAfter("preferences", undefined, 0))
      .filter((e) => e.type === "project_preferences_updated")
      .map((e) => e.payload),
  ).toEqual([
    {
      old_value: 240,
      new_value: 90,
      preference: "merge_confirm_snooze_default_minutes",
    },
  ]);
  for (const bad of ["off", "0", "1441", "1.5"])
    expect(
      await run(["preference", "set", "merge-confirm-snooze-default", bad]),
    ).not.toBe(0);
});

test("C-193: snooze cap get/set validates both bounds, persists and audits once", async () => {
  expect(await run(["preference", "get", "merge-confirm-snooze-max"])).toBe(0);
  expect(output).toContain("merge-confirm-snooze-max: 4320");
  for (const minutes of ["60", "60", "10080"])
    expect(
      await run(["preference", "set", "merge-confirm-snooze-max", minutes]),
    ).toBe(0);
  expect(await run(["preference", "get", "merge-confirm-snooze-max"])).toBe(0);
  expect(output).toContain("merge-confirm-snooze-max: 10080");
  for (const bad of ["off", "59", "10081", "60.5", "NaN", "1e2"])
    expect(
      await run(["preference", "set", "merge-confirm-snooze-max", bad]),
    ).not.toBe(0);
  expect(errors.join(" ")).toContain("60 到 10080");
  expect(
    store.uow.read((tx) =>
      tx.project_preferences.get("preferences", "preferences"),
    ),
  ).toMatchObject({ merge_confirm_snooze_max_minutes: 10080 });
  expect(
    store.uow
      .read((tx) => tx.events.listAfter("preferences", undefined, 0))
      .filter((e) => e.type === "project_preferences_updated"),
  ).toMatchObject([
    {
      actor: { kind: "human" },
      payload: {
        preference: "merge_confirm_snooze_max_minutes",
        old_value: 4320,
        new_value: 60,
      },
    },
    {
      actor: { kind: "human" },
      payload: {
        preference: "merge_confirm_snooze_max_minutes",
        old_value: 60,
        new_value: 10080,
      },
    },
  ]);
});

test("context preferences use remaining percentages, persist and reject reversed thresholds", async () => {
  expect(await run(["preference", "get", "context-handoff-remaining"])).toBe(0);
  expect(output).toContain("context-handoff-remaining: 20");
  expect(await run(["preference", "get", "context-restart-remaining"])).toBe(0);
  expect(output).toContain("context-restart-remaining: 15");
  expect(
    await run(["preference", "set", "context-handoff-remaining", "30.5"]),
  ).toBe(0);
  expect(
    await run(["preference", "set", "context-restart-remaining", "25"]),
  ).toBe(0);
  expect(output).toContain("context-restart-remaining: 25");
  for (const bad of ["off", "-1", "0", "100", "NaN", "30.5", "90"]) {
    expect(
      await run(["preference", "set", "context-restart-remaining", bad]),
    ).not.toBe(0);
  }
  expect(await run(["preference", "get", "context-restart-remaining"])).toBe(0);
  expect(output).toContain("context-restart-remaining: 25");
});

test("C-265: tick-profile is off by default; the human switches it with an audit event", async () => {
  expect(await run(["preference", "get", "tick-profile"])).toBe(0);
  expect(output).toEqual([
    "tick-profile: off (CARDIGAN_TICK_PROFILE=1 仍可强制打开)",
  ]);
  expect(await run(["preference", "set", "tick-profile", "on"])).toBe(0);
  expect(output).toEqual([
    "tick-profile: on (server 在下一个循环周期开始计时)",
  ]);
  expect(
    store.uow.read((tx) =>
      tx.project_preferences.get("preferences", "preferences"),
    )?.tick_profile,
  ).toBe(true);
  expect(await run(["preference", "set", "tick-profile", "off"])).toBe(0);
  expect(
    store.uow
      .read((tx) => tx.events.listAfter("preferences", undefined, 0))
      .filter(
        (e) =>
          e.type === "project_preferences_updated" &&
          e.payload.preference === "tick_profile",
      )
      .map((e) => [e.actor.kind, e.payload.old_value, e.payload.new_value]),
  ).toEqual([
    ["human", false, true],
    ["human", true, false],
  ]);
  for (const bad of [
    ["set", "tick-profile", "maybe"],
    ["set", "tick-profile", "1"],
    ["set", "tick-profile"],
  ])
    expect(await run(["preference", ...bad])).not.toBe(0);
});

test("C-298 code review waiting is off by default and persists only through human preferences", async () => {
  expect(
    await run(["preference", "get", "code-review-waits-for-precheck"]),
  ).toBe(0);
  expect(output).toContain("code-review-waits-for-precheck: off");
  expect(
    await run(["preference", "set", "code-review-waits-for-precheck", "on"]),
  ).toBe(0);
  expect(output).toContain("code-review-waits-for-precheck: on");
  expect(
    store.uow.read((tx) =>
      tx.project_preferences.get("preferences", "preferences"),
    )?.code_review_waits_for_precheck,
  ).toBe(true);
  expect(
    await run(["preference", "set", "code-review-waits-for-precheck", "maybe"]),
  ).not.toBe(0);
});

test("human can read the default-on role-body preference and explicitly turn it off/on", async () => {
  const get = ["preference", "get", "pm-confirm-role-rule-implementations"];
  expect(await main(get, io)).toBe(0);
  expect(output.at(-1)).toContain("on");
  for (const setting of ["off", "on"]) {
    expect(
      await main(
        ["preference", "set", "pm-confirm-role-rule-implementations", setting],
        io,
      ),
    ).toBe(0);
    expect(await main(get, io)).toBe(0);
    expect(output.at(-1)).toContain(`: ${setting}`);
  }
  expect(
    await main(
      ["preference", "set", "pm-confirm-role-rule-implementations", "yes"],
      io,
    ),
  ).not.toBe(0);
});

test("C-238 shadow preference and human-chosen path lists persist without defaults or merge enablement", async () => {
  expect(await run(["preference", "get", "system-merge-shadow"])).toBe(0);
  expect(output.join("\n")).toContain("off (只记录，不合并)");
  expect(await run(["preference", "get", "system-merge-shadow-policy"])).toBe(
    0,
  );
  expect(output).toContain("null");
  const policy = {
    role_rule_paths: ["roles/**"],
    release_paths: ["publish/**"],
  };
  expect(
    await run([
      "preference",
      "set",
      "system-merge-shadow-policy",
      JSON.stringify(policy),
    ]),
  ).toBe(0);
  expect(await run(["preference", "set", "system-merge-shadow", "on"])).toBe(0);
  expect(await run(["preference", "get", "system-merge-shadow-policy"])).toBe(
    0,
  );
  expect(output).toContain(JSON.stringify(policy));
  expect(
    await run([
      "preference",
      "set",
      "system-merge-shadow-policy",
      '{"role_rule_paths":["../bad"],"release_paths":[]}',
    ]),
  ).not.toBe(0);
  expect(
    await run(["preference", "set", "system-merge-shadow-policy", "null"]),
  ).toBe(0);
  expect(
    store.uow.read((tx) => tx.project_preferences.list("preferences"))[0],
  ).toMatchObject({
    system_merge_shadow: true,
    system_merge_shadow_policy: null,
    auto_merge_after_minutes: null,
  });
});

test("role delegation and shadow preferences persist independently", async () => {
  const policy = { role_rule_paths: ["roles/**"], release_paths: [] };
  for (const [key, value] of [
    ["system-merge-shadow-policy", JSON.stringify(policy)],
    ["system-merge-shadow", "on"],
    ["pm-confirm-role-rule-implementations", "off"],
  ]) {
    expect(await run(["preference", "set", key!, value!])).toBe(0);
    expect(await run(["preference", "get", key!])).toBe(0);
    expect(output.join("\n")).toContain(value!);
  }
  expect(
    store.uow.read((tx) => tx.project_preferences.list("preferences"))[0],
  ).toMatchObject({
    system_merge_shadow: true,
    system_merge_shadow_policy: policy,
    pm_confirm_role_rule_implementations: false,
  });
  expect(await run(["preference", "set", "system-merge-shadow", "off"])).toBe(
    0,
  );
  expect(
    await run(["preference", "get", "pm-confirm-role-rule-implementations"]),
  ).toBe(0);
  expect(output.join("\n")).toContain(": off");
});

test("human-decided merge preference defaults on, round-trips and rejects an Agent token", async () => {
  const key = "pm-confirm-human-decided-merges";
  expect(await run(["preference", "get", key])).toBe(0);
  expect(output.join("\n")).toContain(`${key}: on`);
  expect(await run(["preference", "set", key, "off"])).toBe(0);
  expect(await run(["preference", "get", key])).toBe(0);
  expect(output.join("\n")).toContain(`${key}: off`);
  expect(await run(["preference", "set", key, "maybe"])).not.toBe(0);
  expect(
    await main(["preference", "set", key, "on"], {
      ...io,
      env: { ...io.env, CARDIGAN_TOKEN: "fixture-agent-token" },
    }),
  ).not.toBe(0);
  expect(
    store.uow.read((tx) =>
      tx.project_preferences.get("preferences", "preferences"),
    )?.pm_confirm_human_decided_merges,
  ).toBe(false);
  expect(await run(["preference", "set", key, "on"])).toBe(0);
  expect(output.join("\n")).toContain(`${key}: on`);
});
