import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProjectId, requestDecision } from "@cardigan/domain";
import {
  formatAttachmentLimit,
  loadCommandState,
  MAX_ATTACHMENT_BYTES,
} from "@cardigan/mcp-server";
import { routeEvent } from "@cardigan/router";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { humanActor, runCommand } from "./host.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";
import { registerTemplateRoles } from "./template-fixtures.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

const project = "p-content" as ProjectId;
let dataDir: string, store: Store, io: CliIo;
let output: string[], errors: string[];
const snapshot = (id = project) =>
  store.uow.read((tx) => loadCommandState(tx, id));
async function run(args: string[]) {
  output = [];
  errors = [];
  return main(args, io);
}
async function createCard(id = project) {
  const setup = Store.open({ dataDir });
  try {
    registerTemplateRoles(setup, id);
  } finally {
    setup.close();
  }
  expect(
    await run([
      "card",
      "create",
      "--project",
      id,
      "--template",
      "dev",
      "--title",
      "Fixture",
      "--goal",
      "Fixture",
      "--acceptance",
      "Fixture",
      "--repo",
      "example/repo",
    ]),
  ).toBe(0);
}
function file(name: string, content: string | Buffer = "evidence") {
  writeFileSync(join(dataDir, name), content);
  return name;
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-cli-content-"));
  io = {
    env: { CARDIGAN_DATA_DIR: dataDir },
    cwd: dataDir,
    platform: "linux",
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("must not spawn");
    },
    captureCommand: async () => {
      throw new Error("must not spawn");
    },
  };
  expect(
    await run([
      "project",
      "create",
      project,
      "--code",
      `T${project
        .replace(/[^a-z0-9]/gu, "")
        .slice(0, 3)
        .toUpperCase()}`,
    ]),
  ).toBe(0);
  await createCard();
  store = Store.open({ dataDir });
});
afterEach(() => {
  store?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test.each([false, true])(
  "posts exact Markdown as human (text file: %s)",
  async (fromFile) => {
    const body = "  # 结论\n\n```ts\n  a = b\n```\n";
    const args = fromFile
      ? ["--text-file", file("body.md", body)]
      : [`--text=${body}`];
    expect(await run(["comment", "add", "C-1", ...args])).toBe(0);
    const entry = snapshot().timeline.at(-1);
    expect(entry).toMatchObject({ type: "comment", body, author: "human" });
    expect(snapshot().events.at(-1)).toMatchObject({
      type: "comment_posted",
      actor: humanActor(project),
    });
    expect(output).toEqual([`已发表评论 ${entry?.id}`]);
    expect(errors).toEqual([`数据目录：${dataDir}`]);
  },
);

test.each([false, true])(
  "CLI body mentions resolve and route all four target types (text file: %s)",
  async (fromFile) => {
    // createCard already registered the template roles in beforeEach.
    expect(
      await run([
        "employee",
        "add",
        "--name",
        "诸葛亮 Mary",
        "--title",
        "开发",
        "--role",
        "coder",
      ]),
    ).toBe(0);
    expect(await run(["assign", "W-1", "--role", "coder"])).toBe(0);
    for (const mention of ["@A-1", "@W-1", "@coder", "@诸葛亮 Mary"]) {
      const body = `请 ${mention} 检查`;
      const args = fromFile
        ? ["--text-file", file("mentions.md", body)]
        : ["--text", body];
      expect(await run(["comment", "add", "C-1", ...args])).toBe(0);
      const state = snapshot();
      expect(state.timeline.at(-1)?.mentions).toEqual([mention]);
      const event = state.events.at(-1);
      if (!event) throw new Error("Missing comment event");
      const routed = routeEvent({ event, snapshot: state });
      expect(routed.problems).toEqual([]);
      expect(routed.notifications.map((n) => n.recipient)).toEqual([
        { kind: "assignment", assignment_id: "A-1" },
      ]);
    }
  },
);

test("attaches multiple binary/text files to the new comment using shared verified storage", async () => {
  const binary = Buffer.from([0, 1, 255, 128, 10]);
  expect(
    await run([
      "comment",
      "add",
      "C-1",
      "--text",
      "Evidence",
      "--file",
      file("image.PNG", binary),
      `--file=${file("report=a.md", "# Report")}`,
      "--note=测试证据",
    ]),
  ).toBe(0);
  const state = snapshot(),
    comment = state.timeline.find((e) => e.type === "comment");
  expect(state.attachments).toHaveLength(2);
  for (const [i, content] of [binary, Buffer.from("# Report")].entries()) {
    const attachment = state.attachments[i];
    const digest = createHash("sha256").update(content).digest("hex");
    expect(attachment).toMatchObject({
      uploaded_by: "human",
      kind: "evidence",
      sha256: digest,
      mime: i === 0 ? "image/png" : "text/markdown",
      original_filename: i === 0 ? "image.PNG" : "report=a.md",
      note: "测试证据",
      size: content.length,
      attach_to: { kind: "timeline_entry", id: comment?.id },
    });
    const path = join(dataDir, "attachments", digest);
    expect(readFileSync(path)).toEqual(content);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(output.join("\n")).toContain(`已上传附件 ${attachment?.id}`);
  }
  expect(output.join("\n")).toContain(`已发表评论 ${comment?.id}`);
});

test.each(["a".repeat(201), "line\nline"])(
  "invalid attachment notes roll back the comment and attachments",
  async (note) => {
    const before = snapshot();
    expect(
      await run([
        "attachment",
        "add",
        "C-1",
        "--file",
        file("note.txt"),
        "--note",
        note,
      ]),
    ).toBe(2);
    expect(snapshot()).toEqual(before);
  },
);

test("standalone evidence creates an anchor or uses the requested existing entry", async () => {
  const path = file("evidence.log");
  expect(
    await run([
      "attachment",
      "add",
      "C-1",
      "--file",
      path,
      "--note",
      "日志说明",
    ]),
  ).toBe(0);
  const first = snapshot();
  const comment = first.timeline.find((e) => e.type === "comment");
  expect(comment).toMatchObject({ body: "上传附件", author: "human" });
  expect(first.attachments[0]).toMatchObject({
    original_filename: "evidence.log",
    note: "日志说明",
    kind: "evidence",
    mime: "text/plain",
    attach_to: { id: comment?.id },
  });
  expect(
    await run([
      "attachment",
      "add",
      "C-1",
      "--file",
      path,
      "--entry",
      comment?.id ?? "",
    ]),
  ).toBe(0);
  expect(snapshot().timeline.filter((e) => e.type === "comment")).toHaveLength(
    1,
  );
  expect(snapshot().attachments[1]?.attach_to).toEqual(
    first.attachments[0]?.attach_to,
  );
  expect(output.join("\n")).not.toContain("已发表评论");
});

test("artifact requires an existing decision and rolls back the generated anchor on rejection", async () => {
  const path = file("artifact.pdf");
  const args = [
    "attachment",
    "add",
    "C-1",
    "--file",
    path,
    "--kind",
    "artifact",
  ];
  const before = snapshot();
  expect(await run(args)).toBe(2);
  expect(errors.join("\n")).toContain("必须提供 --basis");
  expect(await run([...args, "--basis", "q(99)"])).toBe(2);
  expect(errors.join("\n")).toContain("拍板在当前项目中不存在");
  expect(snapshot()).toEqual(before);
  const decision = runCommand(store, {
    project_id: project,
    actor: humanActor(project),
    reduce: (s, a, p) =>
      requestDecision(
        s,
        a,
        {
          category: "general",
          kind: "choose",
          question: "Fixture?",
          context: "Fixture",
          options: [{ key: "yes", description: "Yes", impact: "Fixture" }],
          recommended: "yes",
          affected_cards: [],
          affected_work_items: [],
          blocking: false,
          decider: "human",
          plain_summary: TEST_PLAIN_SUMMARY,
        },
        p,
      ),
  });
  // C-132: the legacy q(n) spelling resolves to the stored Q-n decision.
  expect(decision.key).toMatch(/^Q-[1-9][0-9]*$/u);
  expect(
    await run([
      ...args,
      "--basis",
      decision.key.replace(/^Q-(\d+)$/u, "q($1)"),
    ]),
  ).toBe(0);
  expect(snapshot().attachments[0]).toMatchObject({
    kind: "artifact",
    basis: decision.key,
  });
});

test.each([
  ["comment", "add", "C-1"],
  ["comment", "add", "C-1", "--text", "x", "--text-file", "body.md"],
  ["comment", "add", "C-1", "--text", " "],
  ["comment", "add", "C-1", "--text"],
  ["comment", "add", "C-1", "--text", "--file", "a.txt"],
  ["comment", "add", "C-1", "--text=x", "--text=y"],
  ["comment", "add", "C-1", "--text=x", "--note=y"],
  ["comment", "add", "W-1", "--text=x"],
  ["comment", "add", "C-1", "C-2", "--text=x"],
  ["comment", "add", "--text=x"],
  ["attachment", "add", "C-1"],
  ["attachment", "add", "C-1", "--file=a.txt", "--file=b.txt"],
  ["attachment", "add", "C-1", "--file=a.txt", "--kind=other"],
  ["attachment", "add", "C-1", "--file=a.txt", "--basis=invalid"],
  ["attachment", "add", "C-1", "--file=a.txt", "--entry=invalid"],
  ["attachment", "add", "C-1", "--file=a.txt", "--project="],
  ["comment"],
  ["attachment", "remove"],
])("rejects invalid arguments without writes: %j", async (...args) => {
  const before = snapshot();
  expect(await run(args)).toBe(2);
  expect(errors.join("\n")).toContain("用法：");
  expect(output).toEqual([]);
  expect(snapshot()).toEqual(before);
});

test("rejects missing, blank, unknown and oversized files before posting a comment", async () => {
  const before = snapshot();
  for (const [flags, message] of [
    [["--text-file=missing.md"], "无法读取文件"],
    [[`--text-file=${file("blank.md", " \n")}`], "评论正文不能为空"],
    [["--text=x", "--file=missing.txt"], "无法读取文件"],
    [["--text=x", "--file=bad.exe"], "不支持的附件类型"],
    [["--text=x", "--file=unknown"], "无扩展名"],
    [
      [
        "--text=x",
        `--file=${file("large.txt", Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))}`,
      ],
      `超过 ${formatAttachmentLimit(MAX_ATTACHMENT_BYTES)}`,
    ],
    [
      ["--text=x", `--file=${file("valid.txt")}`, "--file=bad.exe"],
      "不支持的附件类型",
    ],
    [["--text-file=."], "不是普通文件"],
  ] as const) {
    expect(await run(["comment", "add", "C-1", ...flags])).toBe(2);
    expect(errors.join("\n")).toContain(message);
    expect(snapshot()).toEqual(before);
    expect(output).toEqual([]);
  }
});

test("enforces card and entry scope without writing partial records", async () => {
  await createCard();
  const path = file("evidence.txt"),
    before = snapshot();
  for (const [card, entry, message] of [
    ["C-99", "C-1#1", "卡片 C-99 在当前项目中不存在"],
    ["C-1", "C-1#999", "挂载条目在当前项目中不存在"],
    ["C-1", "C-2#1", "属于另一张卡片"],
  ]) {
    expect(
      await run([
        "attachment",
        "add",
        card as string,
        "--file",
        path,
        "--entry",
        entry as string,
      ]),
    ).toBe(2);
    expect(errors.join("\n")).toContain(message);
    expect(snapshot()).toEqual(before);
  }
  expect(await run(["comment", "add", "C-99", "--text=x"])).toBe(2);
  expect(errors.join("\n")).toContain(
    "无法发表评论 C-99：卡片 C-99 在当前项目中不存在（not_found）",
  );
  expect(snapshot()).toEqual(before);
});

test("a database failure on the second attachment rolls back all records; retry succeeds", async () => {
  const before = snapshot();
  const args = [
    "comment",
    "add",
    "C-1",
    "--text=x",
    "--file",
    file("one.txt"),
    "--file",
    file("two.txt", "second"),
  ];
  store.database.exec(
    "CREATE TRIGGER fail_second BEFORE INSERT ON attachments WHEN NEW.id = 'attachment-2' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
  );
  expect(await run(args)).toBe(1);
  expect(output).toEqual([]);
  expect(snapshot()).toEqual(before);
  store.database.exec("DROP TRIGGER fail_second");
  expect(await run(args)).toBe(0);
  expect(snapshot().attachments).toHaveLength(2);
});

test("rejects corrupted existing blobs without posting a second comment", async () => {
  const path = file("evidence.txt");
  const args = ["comment", "add", "C-1", "--text=x", "--file", path];
  expect(await run(args)).toBe(0);
  const before = snapshot(),
    attachment = before.attachments[0];
  writeFileSync(join(dataDir, attachment?.storage_path ?? ""), "corrupt");
  expect(await run(args)).toBe(2);
  expect(errors.join("\n")).toContain(
    "无法上传附件 C-1：附件存储失败，请检查数据目录权限和已存文件的完整性（validation_failed）",
  );
  expect(snapshot()).toEqual(before);
});

test("uses explicit project/data directory before env, and env project before sole-project fallback", async () => {
  const other = "p-other" as ProjectId;
  expect(
    await run([
      "project",
      "create",
      other,
      "--code",
      `T${other
        .replace(/[^a-z0-9]/gu, "")
        .slice(0, 3)
        .toUpperCase()}`,
    ]),
  ).toBe(0);
  await createCard(other);
  io.env.CARDIGAN_PROJECT = other;
  expect(await run(["comment", "add", "C-1", "--text=env"])).toBe(0);
  expect(snapshot(other).timeline.at(-1)?.body).toBe("env");
  io.env.CARDIGAN_DATA_DIR = join(dataDir, "wrong");
  expect(
    await run([
      "attachment",
      "add",
      "C-1",
      "--file",
      file("data.txt"),
      "--project",
      project,
      "--data-dir",
      ".",
    ]),
  ).toBe(0);
  expect(snapshot().attachments).toHaveLength(1);
  expect(snapshot(other).attachments).toHaveLength(0);
  expect(errors).toEqual([`数据目录：${dataDir}`]);
  io.env.CARDIGAN_DATA_DIR = dataDir;
  delete io.env.CARDIGAN_PROJECT;
  const before = snapshot();
  expect(await run(["comment", "add", "C-1", "--text=ambiguous"])).toBe(2);
  // C-675: both projects have C-1, so the refusal names the full numbers.
  expect(errors.join("\n")).toContain("C-1 在多个项目里都有");
  expect(snapshot()).toEqual(before);
});

test.each([["--help"], ["comment", "--help"], ["attachment", "add", "--help"]])(
  "help describes both human commands: %j",
  async (...args) => {
    expect(await run(args)).toBe(0);
    for (const text of [
      "comment add",
      "attachment add",
      "--text-file",
      "--basis",
      "--entry",
    ])
      expect(output.join("\n")).toContain(text);
  },
);
