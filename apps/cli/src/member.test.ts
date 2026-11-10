import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

test("global member CLI manages the seeded owner and shares avatar rules without a project", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cardigan-member-cli-"));
  const output: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
    env: { CARDIGAN_DATA_DIR: dataDir },
    cwd: dataDir,
    platform: "linux",
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("must not launch");
    },
    captureCommand: async () => {
      throw new Error("must not launch");
    },
  };
  const run = (...args: string[]) => main(["member", ...args], io);
  try {
    for (const command of ["update", "activate", "deactivate"]) {
      expect(await run(command)).toBe(2);
      expect(errors.at(-1)).toContain(
        `缺少成员编号：cardigan member ${command} M-1${command === "update" ? " --name 邵杰" : ""}（用 cardigan member list 查看编号）`,
      );
    }
    expect(await run("update", "--name", "邵杰")).toBe(2);
    expect(errors.at(-1)).toContain("缺少成员编号");
    expect(await run("list")).toBe(0);
    expect(output.join("\n")).toContain("M-1  所有者  所有者");
    expect(
      await run(
        "update",
        "M-1",
        "--name",
        "邵杰",
        "--title",
        "所有者",
        "--avatar",
        "library:liu-bei",
      ),
    ).toBe(0);
    expect(output.join("\n")).toContain("已更新成员 M-1：邵杰");
    expect(await run("activate", "M-1")).toBe(0);
    expect(await run("deactivate", "M-1")).toBe(2);
    expect(errors.join("\n")).toContain("恰好有一个在职所有者");
    for (const role of ["owner", "approver", "observer"])
      expect(
        await run(
          "add",
          "--name",
          "Second",
          "--title",
          "所有者",
          "--role",
          role,
        ),
      ).toBe(2);
    expect(errors.join("\n")).toContain("暂不支持，等以后版本");
    expect(await run("update", "M-1", "--avatar", "library:unknown")).toBe(2);
    expect(await run("update", "M-1", "--role", "observer")).toBe(2);
    expect(await run("update", "E-1", "--name", "Wrong")).toBe(2);
    const file = join(dataDir, "face.png");
    writeFileSync(
      file,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB9sAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    expect(await run("update", "M-1", "--avatar-file", file)).toBe(0);
    const store = Store.open({ dataDir });
    try {
      expect(store.uow.read((tx) => tx.members.list())).toMatchObject([
        {
          id: "M-1",
          name: "邵杰",
          role: "owner",
          status: "active",
          avatar: expect.stringMatching(/^upload:[a-f0-9]{64}$/),
        },
      ]);
      expect(
        store.uow
          .read((tx) => tx.global_events.listAfter(0))
          .map((event) => event.type),
      ).toEqual(["member_created", "member_updated", "member_updated"]);
    } finally {
      store.close();
    }
    expect(await run("update", "M-1", "--avatar", "")).toBe(0);
    expect(await run("list", "--all", "--role", "owner")).toBe(0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
