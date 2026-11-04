import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { App } from "./App.js";

test("renders the Cardigan title page", () => {
  expect(renderToStaticMarkup(<App />)).toBe("<main><h1>Cardigan</h1></main>");
});
