import { expect, test } from "vitest";
import { findings } from "../../test-support/check-ui.mjs";

test.each(["select", "button", "input", "style"])(
  "blocks new native %s in business code",
  (tag) => {
    expect(
      findings("views/NewPage.tsx", `const Page=()=> <${tag} />`).map(
        (f: { kind: string }) => f.kind,
      ),
    ).toContain(`native-${tag}`);
  },
);
test("blocks inline dimensions, arbitrary utility values and direct Radix imports", () => {
  const code =
    'import * as Select from "@radix-ui/react-select"; const Page=()=> <Button style={{width:40}} className="h-[40px]" />;';
  expect(
    findings("views/NewPage.tsx", code).map((f: { kind: string }) => f.kind),
  ).toEqual(["direct-radix", "inline-size", "page-token-override"]);
});
test("allows semantic UI components and primitive internals", () => {
  expect(
    findings(
      "views/NewPage.tsx",
      'const Page=()=> <Button variant="primary"/>',
    ),
  ).toEqual([]);
  expect(
    findings("components/ui/button.tsx", "const Button=()=> <button/>"),
  ).toEqual([]);
});

test.each([
  "md:h-8",
  "hover:rounded-lg",
  "!w-4",
  "rounded-lg",
  "text-sm",
  "px-6",
  "bg-zinc-800",
  "bg-white",
  "gap-2",
  "md:hover:!p-4",
])("blocks styling escape %s", (className) => {
  expect(
    findings(
      "views/New.tsx",
      `const Page=()=> <Button className="${className}"/>`,
    ).some((f: { kind: string }) => f.kind === "page-token-override"),
  ).toBe(true);
});
test.each([
  'style={{"width":40}}',
  "style={{...big}}",
  'style={{"--control":"40px"}}',
  "{...big}",
  "{...{style:{width:40}}}",
])("blocks inline or spread escape %s", (props) => {
  expect(
    findings(
      "views/New.tsx",
      `import {Button} from '../components/ui/button.js'; const big={style:{width:40}}; const Page=()=> <Button ${props}/>`,
    ).length,
  ).toBeGreaterThan(0);
});
test.each([
  'const T="select";const Page=()=> <T/>;',
  'const T="select";const Page=()=> React.createElement(T);',
  'const Page=()=> createElement("select");',
  "const Page=()=> <textarea/>;",
])("blocks aliased and imperative native controls: %s", (code) => {
  expect(
    findings("views/New.tsx", code).some((f: { kind: string }) =>
      f.kind.startsWith("native-"),
    ),
  ).toBe(true);
});
test.each([
  'export * from "@radix-ui/react-select";',
  'export {Root} from "@radix-ui/react-select";',
  'const x=import("@radix-ui/react-select");',
  'const x=require("@radix-ui/react-select");',
])("blocks TS module reexports: %s", (code) => {
  expect(
    findings("views/escape.ts", code).map((f: { kind: string }) => f.kind),
  ).toContain("direct-radix");
});

test("exemption entries cannot exceed the frozen reviewed census", async () => {
  const { validateExemptions } = await import(
    "../../test-support/check-ui.mjs"
  );
  const item = {
    path: "views/Old.tsx",
    kind: "native-button",
    hash: "known",
    count: 1,
  };
  expect(validateExemptions([item], [item])).toEqual([]);
  expect(validateExemptions([], [item])).toEqual([]);
  expect(validateExemptions([{ ...item, hash: "new" }], [item])).not.toEqual(
    [],
  );
  expect(validateExemptions([{ ...item, count: 2 }], [item])).not.toEqual([]);
});
test("legacy styles only shrink and theme rejects page selectors", async () => {
  const { cssFindings } = await import("../../test-support/check-ui.mjs");
  expect(cssFindings("styles.css", "a {}\n", "a {}\nb {}\n")).toEqual([]);
  expect(cssFindings("styles.css", "a {}\nc {}\n", "a {}\nb {}\n")).not.toEqual(
    [],
  );
  expect(
    cssFindings("components/ui/theme.css", ".cards-page {padding:0;}"),
  ).not.toEqual([]);
  expect(
    cssFindings("components/ui/theme.css", ".ui-button {padding:0;}"),
  ).toEqual([]);
});
