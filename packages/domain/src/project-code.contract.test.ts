import { expect, test } from "vitest";
import {
  extractQualifiedReferences,
  isProjectCode,
  qualifyId,
  splitQualifiedId,
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
