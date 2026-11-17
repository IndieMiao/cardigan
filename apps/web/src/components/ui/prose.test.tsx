// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { isLongPlainProse } from "../../markdown.js";
import { DetailProse, Prose } from "./prose.js";

afterEach(cleanup);
const long = "说明".repeat(80);
test("prose uses visible character length, preserving short and structured content", () => {
  expect(isLongPlainProse("字".repeat(159))).toBe(false);
  expect(isLongPlainProse("字".repeat(160))).toBe(true);
  expect(isLongPlainProse("短句" + " \n".repeat(100))).toBe(false);
  expect(isLongPlainProse(`${long}\n\n${long}`)).toBe(true);
  for (const body of [
    `# 标题\n\n${long}`,
    `- ${long}`,
    `> ${long}`,
    `\`\`\`\n${long}\n\`\`\``,
    `| 标题 |\n|---|\n| ${long} |`,
    `**${long}**`,
    `![${long}](/image.png)`,
  ])
    expect(isLongPlainProse(body)).toBe(false);
});
test("muted prose is confined to detail surfaces and retains the original text", () => {
  const view = render(
    <Prose text={long}>
      <p>{long}</p>
    </Prose>,
  );
  expect(view.container.querySelector(".ui-prose-muted")).toBeNull();
  view.rerender(
    <DetailProse value={true}>
      <Prose text={long}>
        <p>{long}</p>
      </Prose>
    </DetailProse>,
  );
  expect(view.container.querySelector(".ui-prose-muted")?.textContent).toBe(
    long,
  );
  view.rerender(
    <DetailProse value={true}>
      <Prose text="简短结论">
        <p>简短结论</p>
      </Prose>
    </DetailProse>,
  );
  expect(view.container.querySelector(".ui-prose-muted")).toBeNull();
});
