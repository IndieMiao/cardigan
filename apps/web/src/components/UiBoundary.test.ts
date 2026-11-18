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
  'wide ? "h-12" : "quiet"',
  'wide ? "quiet" : "h-12"',
  'cn("quiet", "h-12")',
  'cn("quiet", "active", "h-12")',
  'cn("quiet", wide ? "active" : "h-12")',
  'cn("quiet", { "h-12": wide })',
  '["quiet", "h-12"].join(" ")',
])("blocks token overrides in every expression branch: %s", (expression) => {
  for (const props of [
    `className={${expression}}`,
    `{...{className: ${expression}}}`,
  ]) {
    expect(
      findings(
        "views/NewPage.tsx",
        `import {Button} from '../components/ui/button.js'; const Page=()=> <Button ${props} />;`,
      ).map((f: { kind: string }) => f.kind),
    ).toEqual(["page-token-override"]);
  }
});
test.each([
  'wide ? "quiet" : "active"',
  'cn("quiet", "active")',
  'cn("quiet", wide ? "active" : "muted")',
])("allows semantic classes in compound expressions: %s", (expression) => {
  expect(
    findings(
      "views/NewPage.tsx",
      `const Page=()=> <Button className={${expression}} />;`,
    ),
  ).toEqual([]);
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

test.each([
  'import {FilterBar as Local} from "../components/FilterBar.js"; const Page=()=> <Local fields={[]} />;',
  'const Page=()=> <div className="ui-action-row"><Button>立即刷新</Button></div>;',
  'const Page=()=> <SelectControl prefix="状态"/>;',
  'const Page=()=> <SelectControl aria-label="自动刷新"/>;',
  'const classes="ui-refresh-controls"; const Page=()=> <div className={classes}/>;',
  'const props={className:"filter-controls"}; const Page=()=> <div {...props}/>;',
  'const Page=()=> React.createElement("div", {className:"ui-action-row"});',
])("rejects page-local skeleton composition: %s", (code) => {
  expect(
    findings("views/NewPage.tsx", code).some(
      (f: { kind: string }) => f.kind === "page-skeleton",
    ),
  ).toBe(true);
});
test.each([
  'import * as F from "../components/FilterBar.js"; const Page=()=> <F.FilterBar/>;',
  'import {FilterBar} from "../components/FilterBar.js"; const Alias=FilterBar; const Page=()=> <Alias/>;',
  "const Page=()=> <PageToolbar fields={[{render:()=> <SelectControl/>}]}/>;",
  'const Page=()=> <svg><path d="M0 0"/></svg>;',
  'const Page=()=> createElement("svg");',
  "const Page=()=> <ViewSwitch options={[]}/>;",
])("rejects aliases and hand-written view icons: %s", (code) => {
  expect(
    findings("views/NewPage.tsx", code).some(
      (f: { kind: string }) => f.kind === "page-skeleton",
    ),
  ).toBe(true);
});
test("allows shared skeleton and ordinary form selects", () => {
  expect(
    findings(
      "views/NewPage.tsx",
      "const Page=()=> <PageToolbar fields={[]}><RefreshGroup/><CardsViewSwitch/><FilterSelect/></PageToolbar>;",
    ),
  ).toEqual([]);
  expect(
    findings(
      "views/Settings.tsx",
      'const Page=()=> <SelectControl aria-label="运行方式"/>;',
    ),
  ).toEqual([]);
  expect(
    findings(
      "components/RefreshGroup.tsx",
      'const RefreshGroup=()=> <div className="ui-refresh-controls"/>;',
    ),
  ).toEqual([]);
});

test.each([
  'const Page=()=> <PageToolbar fields={[]}><SelectControl aria-label="状态"/></PageToolbar>;',
  "const Page=()=> <PageToolbar fields={[]}><section><><SelectControl/></></section></PageToolbar>;",
  "const controls=<SelectControl/>; const Page=()=> <PageToolbar fields={[]}>{controls}</PageToolbar>;",
  'const fields=[{key:"state",render:()=> <SelectControl aria-label="状态"/>}]; const Page=()=> <PageToolbar fields={fields}/>;',
  "const renderField=()=> <SelectControl/>; const fields=[{render:renderField}]; const Page=()=> <PageToolbar fields={fields}/>;",
  "function renderField(){return <SelectControl/>} const fields=[{render:renderField}]; const Page=()=> <PageToolbar fields={fields}/>;",
  "const field={render:()=> <SelectControl/>}; const first=[field]; const fields=useMemo(()=> [...first],[]); const Page=()=> <PageToolbar fields={fields}/>;",
  "const fields=[{render:()=> <SelectControl/>}]; const props={fields}; const Page=()=> <PageToolbar {...props}/>;",
  "const controls=<SelectControl/>; const props={children:controls}; const Page=()=> <PageToolbar {...props}/>;",
  "const fields=[{render:()=> <SelectControl/>}]; const props={fields}; const Page=()=> <PageToolbar {...{...props}}/>;",
  "const fields=[{render:()=> <SelectControl/>}]; const Page=()=> React.createElement(PageToolbar,{fields});",
  "const Page=()=> React.createElement(PageToolbar,{},React.createElement(SelectControl));",
  'import {PageToolbar as Toolbar} from "../components/PageToolbar.js"; import {SelectControl as RawSelect} from "../components/ui/select-control.js"; const fields=[{render:()=> <RawSelect/>}]; const Page=()=> <Toolbar fields={fields}/>;',
])(
  "rejects raw toolbar selects across JSX and local field references: %s",
  (code) => {
    const matches = findings("views/NewPage.tsx", code).filter(
      (f: { kind: string }) => f.kind === "page-skeleton",
    );
    expect(matches).toHaveLength(1);
  },
);

test.each([
  'const props={"aria-label":"自动刷新"}; const Page=()=> <SelectControl {...props}/>;',
  'const refresh="自动刷新"; const props={"aria-label":refresh}; const Page=()=> <SelectControl {...props}/>;',
  'const base={"aria-label":"自动刷新"}; const props={...base}; const Page=()=> <SelectControl {...props}/>;',
  'const props=active ? {"aria-label":"自动刷新"} : {"aria-label":"状态"}; const Page=()=> <SelectControl {...props}/>;',
  'const props={ ["aria-label"]:"自动刷新" }; const Page=()=> <SelectControl {...props}/>;',
  'const prefix="状态"; const props={prefix}; const Page=()=> <SelectControl {...props}/>;',
  'const props={"className":"ui-action-row"}; const Page=()=> <div {...props}/>;',
  'const props={"aria-label":"自动刷新"}; const Page=()=> React.createElement(SelectControl,props);',
])(
  "checks equivalent skeleton attributes inside property spreads: %s",
  (code) => {
    expect(
      findings("views/NewPage.tsx", code).some(
        (f: { kind: string }) => f.kind === "page-skeleton",
      ),
    ).toBe(true);
  },
);

test.each([
  'const props={"aria-label":"运行方式"}; const Form=()=> <SelectControl {...props}/>;',
  'const props={"aria-label":"运行方式"}; const nested={...props}; const Form=()=> React.createElement(SelectControl,nested);',
  "const field={render:()=> <SelectControl/>}; const Page=()=> <><PageToolbar fields={[]}/><Form fields={[field]}/></>;",
  "const fields=[{render:()=> <SelectControl/>}]; const Page=()=> <PageToolbar values={fields} fields={[]}/>;",
  "function Form(){const fields=[{render:()=> <SelectControl/>}];return <FormLayout fields={fields}/>;} function Page(){const fields=[{render:()=> <FilterSelect/>}];return <PageToolbar fields={fields}/>;}",
  "const fields=[{render:()=> <SelectControl/>}]; function Page({fields}){return <PageToolbar fields={fields}/>;}",
  'const props={"aria-label":"自动刷新"}; function Form(){const props={"aria-label":"运行方式"};return <SelectControl {...props}/>;}',
])(
  "does not classify ordinary form controls as toolbar filters: %s",
  (code) => {
    expect(findings("views/NewPage.tsx", code)).toEqual([]);
  },
);

test("uses the field binding in each lexical scope and stops cyclic aliases", () => {
  const scoped = findings(
    "views/NewPage.tsx",
    "function Page(){const fields=[{render:()=> <SelectControl/>}];return <PageToolbar fields={fields}/>;} function Form(){const fields=[{render:()=> <FilterSelect/>}];return <FormLayout fields={fields}/>;}",
  );
  expect(
    scoped.filter((f: { kind: string }) => f.kind === "page-skeleton"),
  ).toHaveLength(1);
  expect(
    findings(
      "views/NewPage.tsx",
      "const fields=[{render:()=> <FilterSelect/>,next:fields}]; const props={...props,fields}; const Page=()=> <PageToolbar {...props}/>;",
    ),
  ).toEqual([]);
});
