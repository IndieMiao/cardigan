// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import {
  capturePairingLink,
  pendingPairingCode,
  subscribePairingCode,
  takePairingCode,
} from "./pairing-link.js";

test("C-707: a pairing link is cleared with replaceState and its code handed over once", () => {
  const replaceState = vi.fn();
  const history = { replaceState, state: { kept: true } };
  const heard = vi.fn();
  const stop = subscribePairingCode(heard);
  capturePairingLink(
    { hash: "#/pair/ABCD-EFGH", pathname: "/", search: "?x=1" },
    history,
  );
  expect(replaceState).toHaveBeenCalledWith({ kept: true }, "", "/?x=1");
  expect(pendingPairingCode()).toBe("ABCD-EFGH");
  expect(heard).toHaveBeenCalledTimes(1);
  expect(takePairingCode()).toBe("ABCD-EFGH");
  expect(takePairingCode()).toBeUndefined();
  stop();
});

test("C-707: other routes are left alone; a malformed link is cleared without keeping it", () => {
  const replaceState = vi.fn();
  const history = { replaceState, state: null };
  capturePairingLink(
    { hash: "#/p/p-1/settings", pathname: "/", search: "" },
    history,
  );
  capturePairingLink({ hash: "#/pair/", pathname: "/", search: "" }, history);
  expect(replaceState).not.toHaveBeenCalled();
  capturePairingLink(
    { hash: "#/pair/%E0%A4%A", pathname: "/", search: "" },
    history,
  );
  expect(replaceState).toHaveBeenCalledTimes(1);
  expect(pendingPairingCode()).toBeUndefined();
});
