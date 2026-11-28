import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { stringify } from "yaml";
import {
  workerDraftForm,
  workerDraftLayout,
  workerWizardForm,
} from "./worker-wizard-form.js";

const form = {
  machine_id: "worker-a",
  label: "Test",
  os: "linux",
  arch: "x64",
  host: "private.invalid",
  port: 22,
  account: "cg_example",
  uid: 2201,
  gid: 2201,
  mcp_url: "https://private.example.ts.net/mcp",
};
const data = "/private/controller";
let root = "";
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});
function write(values: Record<string, unknown>) {
  root = mkdtempSync(join(tmpdir(), "worker-draft-"));
  const draft = workerWizardForm(root, data, "example", values);
  writeFileSync(
    join(root, "worker-worker-a-example.yaml"),
    stringify(draft.raw),
    { mode: 0o600 },
  );
  return draft;
}

test.each([
  ["Linux /srv", { ...form }, undefined],
  ["SteamOS /home", { ...form, layout: "home" }, "home"],
  ["macOS", { ...form, os: "macos", arch: "arm64" }, undefined],
])(
  "C-846: a written %s draft gives back the form it came from",
  (_name, values, layout) => {
    const draft = write(values);
    expect(workerDraftLayout(root, "example", "worker-a")).toBe(layout);
    const again = workerDraftForm(root, data, "example", "worker-a", "Test");
    expect(again).toEqual(values);
    const rebuilt = workerWizardForm(root, data, "example", again ?? {});
    expect(rebuilt.raw).toEqual(draft.raw);
    expect(rebuilt.commands).toEqual(draft.commands);
  },
);

test("C-846: no draft is nothing; a draft edited by hand is a conflict", () => {
  root = mkdtempSync(join(tmpdir(), "worker-draft-"));
  expect(workerDraftLayout(root, "example", "worker-a")).toBeUndefined();
  expect(
    workerDraftForm(root, data, "example", "worker-a", "Test"),
  ).toBeUndefined();
  const draft = workerWizardForm(root, data, "example", form);
  writeFileSync(
    join(root, "worker-worker-a-example.yaml"),
    stringify({ ...draft.raw, timeout_ms: 4500 }),
    { mode: 0o600 },
  );
  expect(() =>
    workerDraftForm(root, data, "example", "worker-a", "Test"),
  ).toThrow("worker_config_conflict");
  expect(() => workerDraftLayout(root, "example", "../x")).toThrow();
});
