import { expect, test } from "vitest";
import {
  describeQualifiedInputError,
  extractQualifiedReferences,
  isProjectCode,
  localInputKind,
  qualifiedInputProject,
  qualifyId,
  qualifyText,
  splitQualifiedId,
  splitQualifiedInput,
  suggestProjectCode,
  validateProjectCode,
} from "./project-code.js";
import { extractReferences } from "./references.js";

test("C-674: codes are 3–4 uppercase letters or digits starting with a letter", () => {
  for (const code of ["CDG", "SEN", "A12", "SEN2", "ABCD"])
    expect(isProjectCode(code), code).toBe(true);
  for (const code of ["cdg", "CD", "ABCDE", "1AB", "A-B", "SÉN", " SEN", ""])
    expect(isProjectCode(code), code).toBe(false);
  expect(validateProjectCode("SEN", ["CDG"])).toEqual({
    ok: true,
    value: "SEN",
  });
  const taken = validateProjectCode("SEN", ["CDG", "SEN"]);
  expect(taken.ok === false && taken.error.message).toContain(
    "已被其它项目使用",
  );
  expect(validateProjectCode("sen", []).ok).toBe(false);
});

test("C-674: suggestions take three characters and move to four on conflict", () => {
  expect(suggestProjectCode("sensen-godot", [])).toBe("SEN");
  expect(suggestProjectCode("sensen-godot", ["SEN"])).toBe("SENS");
  expect(suggestProjectCode("sensen-godot", ["SEN", "SENS"])).toBe("SENE");
  expect(suggestProjectCode("cardigan", [])).toBe("CAR");
  // Leading digits and punctuation are skipped; short names are padded.
  expect(suggestProjectCode("42-ab", [])).toBe("ABX");
  expect(suggestProjectCode("森森", [])).toBe("PRJ");
  expect(suggestProjectCode("ab", ["ABX"])).toBe("ABX1");
  // Always free and valid, even when every stem+character is taken.
  const crowded = [
    "SEN",
    ..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((c) => `SEN${c}`),
  ];
  const code = suggestProjectCode("sen", crowded);
  expect(isProjectCode(code)).toBe(true);
  expect(crowded).not.toContain(code);
});

test("C-674: full numbers prefix project-scoped ids only", () => {
  expect(qualifyId("SEN", "C-34")).toBe("SEN-C-34");
  expect(qualifyId("SEN", "C-34#12")).toBe("SEN-C-34#12");
  for (const id of [
    "Q-1291",
    "H-46",
    "A-1415",
    "W-2",
    "D-3",
    "V-4",
    "R-5",
    "MB-6",
  ])
    expect(qualifyId("CDG", id)).toBe(`CDG-${id}`);
  // Employees and members are global; unknown or already-full ids stay.
  for (const id of ["E-2", "M-1", "SEN-C-34", "local", "Q-1#2"])
    expect(qualifyId("CDG", id)).toBe(id);
  expect(qualifyId(undefined, "C-34")).toBe("C-34");
  expect(splitQualifiedId("SEN-C-34")).toEqual({ code: "SEN", id: "C-34" });
  expect(splitQualifiedId("SEN-MB-3")).toEqual({ code: "SEN", id: "MB-3" });
  expect(splitQualifiedId("C-34")).toBeUndefined();
  expect(splitQualifiedId("SEN-E-2")).toBeUndefined();
});

test("C-674: bodies yield full numbers, which never resolve as the short number", () => {
  const body =
    "见 SEN-C-34、CDG-Q-1291、SEN-C-34#12、SEN-H-46，和本项目的 C-34；XSENA-C-1、SEN-C-0、SEN-E-2 不算";
  expect(extractQualifiedReferences(body)).toEqual([
    { kind: "card", id: "C-34", qualified: "SEN-C-34", code: "SEN" },
    { kind: "decision", id: "Q-1291", qualified: "CDG-Q-1291", code: "CDG" },
    {
      kind: "timeline_entry",
      id: "C-34#12",
      qualified: "SEN-C-34#12",
      code: "SEN",
    },
    { kind: "human_action", id: "H-46", qualified: "SEN-H-46", code: "SEN" },
  ]);
  // Old comments are unchanged: short numbers still resolve in this project.
  expect(extractReferences(body)).toEqual([{ kind: "card", id: "C-34" }]);
});

test("C-676: text leaving the project gets full numbers for short ones only", () => {
  expect(
    qualifyText(
      "CDG",
      "C-12、C-12#3、Q-4、H-5、W-6、D-7、A-8、R-9、V-10、MB-11 已处理",
    ),
  ).toBe(
    "CDG-C-12、CDG-C-12#3、CDG-Q-4、CDG-H-5、CDG-W-6、CDG-D-7、CDG-A-8、CDG-R-9、CDG-V-10、CDG-MB-11 已处理",
  );
  // Full numbers, global ids, paths, links and look-alikes stay as written.
  const kept =
    "SEN-C-34、SEN-C-34#2、E-2、M-1、docs/plans/C-12.md、https://w.invalid/#/p/x/cards/C-12?at=C-12%231、C-0、XC-1、C-1a、C-1-b";
  expect(qualifyText("CDG", kept)).toBe(kept);
  expect(qualifyText(undefined, "C-12")).toBe("C-12");
  expect(qualifyText("cdg", "C-12")).toBe("C-12");
});

test("C-675: input full numbers include attachments; global ids and text are not full numbers", () => {
  expect(splitQualifiedInput("SEN-C-34")).toEqual({ code: "SEN", id: "C-34" });
  expect(splitQualifiedInput("SEN-C-34#12")).toEqual({
    code: "SEN",
    id: "C-34#12",
  });
  expect(splitQualifiedInput("CDG-attachment-3")).toEqual({
    code: "CDG",
    id: "attachment-3",
  });
  expect(splitQualifiedInput("CDG-MB-2")).toEqual({ code: "CDG", id: "MB-2" });
  for (const value of [
    "C-34",
    "CDG-E-5",
    "CDG-M-2",
    "cdg-C-1",
    "CDG-C-0",
    "CDG-C-1 ",
    "CDG-C-1x",
    "CDG-attachment-",
  ])
    expect(splitQualifiedInput(value), value).toBeUndefined();
  expect(localInputKind("C-3")).toBe("card");
  expect(localInputKind("C-3#4")).toBe("timeline_entry");
  expect(localInputKind("Q-1")).toBe("decision");
  expect(localInputKind("H-1")).toBe("human_action");
  expect(localInputKind("attachment-9")).toBe("attachment");
  expect(localInputKind("MB-1")).toBe("merge_batch");
  for (const value of ["E-1", "M-1", "SEN-C-1", "C-x", "branch"])
    expect(localInputKind(value), value).toBeUndefined();
});

test("C-675: full numbers pick one project; an unknown code, two projects or a disagreeing project are refused", () => {
  const codes: Record<string, string> = { CDG: "cardigan", SEN: "sensen" };
  const of = (code: string) => codes[code];
  expect(qualifiedInputProject(["C-1", "text"], of)).toEqual({
    ok: true,
    value: undefined,
  });
  expect(qualifiedInputProject(["SEN-C-34", "SEN-Q-2", "C-1"], of)).toEqual({
    ok: true,
    value: "sensen",
  });
  expect(qualifiedInputProject(["SEN-C-34"], of, "sensen")).toEqual({
    ok: true,
    value: "sensen",
  });
  const mismatch = qualifiedInputProject(["SEN-C-34"], of, "cardigan");
  expect(
    mismatch.ok === false && describeQualifiedInputError(mismatch.error),
  ).toBe("完整编号 SEN-C-34 属于项目 sensen，与指定的项目 cardigan 不一致");
  const mixed = qualifiedInputProject(["CDG-C-1", "SEN-C-2"], of);
  expect(mixed.ok === false && describeQualifiedInputError(mixed.error)).toBe(
    "完整编号 CDG-C-1、SEN-C-2 属于不同项目，一次只能操作一个项目",
  );
  const unknown = qualifiedInputProject(["ZZZ-C-1"], of);
  expect(
    unknown.ok === false && describeQualifiedInputError(unknown.error),
  ).toBe("完整编号 ZZZ-C-1 的代号 ZZZ 没有登记给任何项目");
});
