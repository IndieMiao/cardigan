/**
 * M5.3 hash routes (plan §2: no routing library).
 *
 * Every URL the app produces must parse back, and anything else must fall
 * through to "no route" so the shell can send the reader to a real screen.
 */
import { expect, test } from "vitest";
import { parseRoute, routeHash } from "./route.js";

test("board, list and card routes round-trip", () => {
  for (const route of [
    { kind: "board", projectId: "p-fictional" },
    { kind: "list", projectId: "p-fictional" },
    { kind: "needs-you", projectId: "p-fictional" },
    { kind: "snapshot", projectId: "p-fictional" },
    { kind: "execution", projectId: "p-fictional" },
    { kind: "card", projectId: "p-fictional", cardId: "C-1" },
  ] as const) {
    expect(parseRoute(routeHash(route))).toEqual(route);
  }
  expect(routeHash({ kind: "board", projectId: "p-fictional" })).toBe(
    "#/p/p-fictional/board",
  );
  expect(
    routeHash({ kind: "card", projectId: "p-fictional", cardId: "C-1" }),
  ).toBe("#/p/p-fictional/cards/C-1");
});

test("identifiers are URL-encoded", () => {
  const hash = routeHash({ kind: "list", projectId: "p/with space" });
  expect(hash).toBe("#/p/p%2Fwith%20space/list");
  expect(parseRoute(hash)).toEqual({ kind: "list", projectId: "p/with space" });
});

test("unknown or incomplete hashes have no route", () => {
  for (const hash of [
    "",
    "#",
    "#/",
    "#/p/p-1",
    "#/p/p-1/not-a-view",
    "#/p//board",
    "#/projects/p-1/board",
    "#/p/p-1/cards",
  ]) {
    expect(parseRoute(hash), hash).toBeUndefined();
  }
});

test("a malformed escape does not throw", () => {
  expect(parseRoute("#/p/%E0%A4%A/board")).toBeUndefined();
});
