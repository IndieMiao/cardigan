import { expect, test } from "vitest";
import { mergeFixture } from "./commands/merge/test-fixtures.js";
import {
  assignment,
  human,
  machine,
  ports,
  role,
} from "./commands/test-fixtures.js";
import {
  type Actor,
  type CommandState,
  canDeleteShared,
  HOST_OPS_ROLE_TOOLS,
  normalizeSharedDir,
  normalizeSharedFile,
  projectPreferences,
  ROLE_TOOL_ALLOWLISTS,
  SHARED_FILE_TOOLS,
  SharedFilesError,
  STANDING_ROLE_TOOLS,
  setProjectPreferences,
  sharedContentType,
  sharedDirChain,
  sharedFilesAccess,
  sharedFilesAllows,
} from "./index.js";

/**
 * C-685: the shared file library's pure rules. Every role reads and writes
 * unless the human narrows it per project; deletion is never an Agent's.
 */

test("paths: slashes trimmed, NFC, dangerous segments refused", () => {
  expect(normalizeSharedDir("")).toBe("");
  expect(normalizeSharedDir("/")).toBe("");
  expect(normalizeSharedDir("/美术/角色/")).toBe("美术/角色");
  expect(normalizeSharedFile("art/raw/hero.mp4")).toEqual({
    path: "art/raw/hero.mp4",
    dir: "art/raw",
    name: "hero.mp4",
  });
  expect(normalizeSharedFile("a.txt")).toEqual({
    path: "a.txt",
    dir: "",
    name: "a.txt",
  });
  // Decomposed and composed forms name the same file.
  expect(normalizeSharedFile("café.png").path).toBe("café.png");
  for (const bad of [
    "a/../b",
    "./a",
    "a//b",
    "a\\b",
    "a/b:c",
    "a/\u0000",
    " lead",
    "x".repeat(121),
    Array.from({ length: 17 }, () => "d").join("/"),
  ])
    expect(() => normalizeSharedDir(bad), bad).toThrow(SharedFilesError);
  expect(() => normalizeSharedFile("/")).toThrow(SharedFilesError);
  expect(sharedDirChain("a/b/c")).toEqual(["a", "a/b", "a/b/c"]);
  expect(sharedContentType("Video/MP4")).toBe("video/mp4");
  expect(sharedContentType("not a type")).toBe("application/octet-stream");
  expect(sharedContentType(undefined)).toBe("application/octet-stream");
});

test("access: read_write by default, role entry beats *, and only people delete", () => {
  expect(sharedFilesAccess(undefined, "coder")).toBe("read_write");
  const narrowed = {
    shared_files_access: { "*": "read", pm: "none" },
  } as const;
  expect(sharedFilesAccess(narrowed, "coder")).toBe("read");
  expect(sharedFilesAccess(narrowed, "pm")).toBe("none");
  expect(
    sharedFilesAccess(
      { shared_files_access: { "*": "none", coder: "read_write" } },
      "coder",
    ),
  ).toBe("read_write");
  expect(sharedFilesAllows("read_write", "read_write")).toBe(true);
  expect(sharedFilesAllows("read", "read")).toBe(true);
  expect(sharedFilesAllows("read", "read_write")).toBe(false);
  expect(sharedFilesAllows("none", "read")).toBe(false);
  expect(canDeleteShared({ kind: "human", member_id: null })).toBe(true);
  expect(
    canDeleteShared({
      kind: "assignment",
      project_id: "p",
      assignment_id: "A-1",
      role_id: "pm",
    }),
  ).toBe(false);
});

test("every role kind holds the shared-library tools; there is no delete tool", () => {
  for (const tools of [
    ROLE_TOOL_ALLOWLISTS.produce,
    ROLE_TOOL_ALLOWLISTS.verify,
    ROLE_TOOL_ALLOWLISTS.standing,
    STANDING_ROLE_TOOLS,
    HOST_OPS_ROLE_TOOLS,
  ])
    for (const tool of SHARED_FILE_TOOLS) expect(tools).toContain(tool);
  expect(SHARED_FILE_TOOLS.some((tool) => /delete|remove/u.test(tool))).toBe(
    false,
  );
});

test("only the human narrows shared_files_access, validated and audited", () => {
  const empty: CommandState = {
    project_id: human.project_id,
    machines: [machine()],
    roles: [role("coder"), role("reviewer"), role("pm")],
    cards: [],
    work_items: [],
    assignments: [],
    runs: [],
    deliveries: [],
    reviews: [],
    decisions: [],
    human_actions: [],
    attachments: [],
    cursors: [],
    timeline: [],
    events: [],
  };
  const f = mergeFixture("confirm", 3, { state: empty, ports: ports() });
  const coder = assignment(901, "coder");
  const agent: Actor = {
    kind: "assignment",
    project_id: human.project_id,
    assignment_id: coder.id,
    ...role("coder"),
  };
  const denied = setProjectPreferences(
    f.state,
    agent,
    { shared_files_access: { "*": "none" } },
    f.io,
  );
  expect(denied.ok).toBe(false);
  for (const bad of [
    { "*": "write" },
    { "Bad Role": "read" },
    [] as unknown as Record<string, "read">,
  ]) {
    const invalid = setProjectPreferences(
      f.state,
      human,
      { shared_files_access: bad as Record<string, "read"> },
      f.io,
    );
    expect(invalid.ok, JSON.stringify(bad)).toBe(false);
  }
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { shared_files_access: { "*": "read", coder: "read_write" } },
      f.io,
    ),
  );
  const prefs = projectPreferences(f.state);
  expect(sharedFilesAccess(prefs, "coder")).toBe("read_write");
  expect(sharedFilesAccess(prefs, "reviewer")).toBe("read");
  expect(
    f.state.events
      .filter((e) => e.type === "project_preferences_updated")
      .map((e) => e.payload),
  ).toEqual([
    {
      preference: "shared_files_access",
      old_value: null,
      new_value: { "*": "read", coder: "read_write" },
    },
  ]);
  // `{}` restores the default for every role.
  f.commit(
    setProjectPreferences(f.state, human, { shared_files_access: {} }, f.io),
  );
  expect(sharedFilesAccess(projectPreferences(f.state), "reviewer")).toBe(
    "read_write",
  );
});
