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
