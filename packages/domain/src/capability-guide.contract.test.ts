import { describe, expect, test } from "vitest";
import {
  type Actor,
  authorizeCapabilityGuideWrite,
  type CapabilityGuideEntry,
  credentialLikeContent,
  mergeCapabilityGuides,
  USAGE_NOTE_MAX_LENGTH,
  validateCapabilityGuideTarget,
  validateUsageNote,
} from "./index.js";

const failure = (result: { ok: boolean; error?: { message: string } }) =>
  result.ok ? null : (result.error?.message ?? "");

describe("usage_note length", () => {
  test("accepts exactly the limit and refuses one more character", () => {
    const at = "中".repeat(USAGE_NOTE_MAX_LENGTH);
    expect(validateUsageNote(at)).toEqual({ ok: true, value: at });
    expect(failure(validateUsageNote(`${at}中`))).toContain(
      `最长 ${USAGE_NOTE_MAX_LENGTH} 个字符`,
    );
  });

  test("counts code points, not UTF-16 units", () => {
    const emoji = "😀".repeat(USAGE_NOTE_MAX_LENGTH);
    expect(validateUsageNote(emoji).ok).toBe(true);
  });

  test("trims, normalizes line endings and refuses empty or non-text", () => {
    expect(validateUsageNote("  a\r\nb\rc  \n")).toEqual({
      ok: true,
      value: "a\nb\nc",
    });
    for (const input of ["", "  \n\t ", undefined, 3, { note: "x" }])
      expect(validateUsageNote(input).ok).toBe(false);
  });

  test("refuses control characters but keeps tabs and newlines", () => {
    expect(validateUsageNote("a\tb\nc").ok).toBe(true);
    expect(failure(validateUsageNote("a\u0000b"))).toContain("控制字符");
    expect(failure(validateUsageNote("a\u001bb"))).toContain("控制字符");
  });
});

describe("usage_note refuses credential-like content", () => {
  test.each([
    ["GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["用 github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz 调用"],
    ["key: sk-proj-abcdefghijklmnopqrstuvwxyz"],
    ["aws AKIAABCDEFGHIJKLMNOP"],
    ["slack xoxb-1234567890-abcdefghij"],
    [
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
    ],
    ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop"],
    ["克隆 https://user:hunter2@git.example.com/repo.git"],
    ["password: hunter22"],
    ["API_KEY = 'q8Zr7Lm2Vx'"],
    ["lark.app_secret=correcthorsebatterystaple"],
    ["export ANDROID_KEYSTORE_PASSWORD=s3cretPass"],
    ["凭据 dGhpcyBpcyBhIHNlY3JldCB2YWx1ZTEyMw== 放这里"],
    ["API_TOKEN=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b"],
    ["凭据 Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg 放这里"],
  ])("%s", (note) => {
    expect(credentialLikeContent(note)).not.toBeNull();
    expect(failure(validateUsageNote(note))).toContain("看起来包含凭据");
  });

  test.each([
    [
      "Android 模拟器：`ANDROID_AVD_HOME=~/.android/avd`，用 `emulator -list-avds` 查看。",
    ],
    [
      "测试账号在受管文件 /srv/sensen/secrets/journey-test-accounts.yaml，按 key 读取",
    ],
    ["LARK_TOKEN=$LARK_TOKEN 由启动环境注入；不要回显"],
    ["TOKEN_FILE=/run/cardigan/token，读取后只传给 CLI"],
    ["api_key: <在受管文件里>"],
    ["password: ***"],
    ["auth: required；首次运行 `lark-cli auth status` 检查"],
    ["服务地址 https://auth.example.com:8443/oauth/token"],
    ["签名脚本 tools/android/sign_release_bundle_with_managed_keystore.sh"],
    ["模拟器 Pixel_7_API_34，镜像 system-images;android-34;google_apis;x86_64"],
    ["工作目录 3f2a8c1e-9b7d-4e6f-a5c3-1d2e3f4a5b6c 是随机生成的"],
    ["Godot 4.3 在 /Applications/Godot.app/Contents/MacOS/Godot"],
    // C-724 seed guide: public certificate fingerprints and commit SHAs are digests.
    [
      "证书 SHA-256 是 `298a6ad8ec805eb2a4c92015ad20c437c52984b35ce554694ad5958655fa4034`（这是公开指纹）",
    ],
    ["证书指纹 29:8A:6A:D8:EC:80:5E:B2:A4:C9:20:15:AD:20:C4:37"],
    ["对照 healthz 的 git_sha 03c8a57ac11cb3aa2eca4487b2191da609aafc2f"],
    ["测试账号 qa-c@sensen-test.invalid，键 `accounts.first`"],
    [
      '结构是 `{"base_url", "accounts": {<键>: {"email","password","display_name"}}}`',
    ],
    ["`CARDIGAN_MAPBOX_PUBLIC_FILE=<见 §9.4>`，只传路径，不打印内容"],
    [
      "`ANDROID_ADB_SERVER_PORT=5137`，`ADB_SERVER_SOCKET=localfilesystem:/dev/null`",
    ],
  ])("%s", (note) => {
    expect(credentialLikeContent(note)).toBeNull();
    expect(validateUsageNote(note).ok).toBe(true);
  });
});

describe("targets", () => {
  test("three entry kinds; only machine supplements name a machine", () => {
    expect(
      validateCapabilityGuideTarget({ scope: "capability", key: "godot" }),
    ).toEqual({
      ok: true,
      value: { scope: "capability", key: "godot", machine_id: null },
    });
    expect(
      validateCapabilityGuideTarget({
        scope: "machine",
        key: "android.emulator",
        machine_id: "mac-mini",
      }),
    ).toEqual({
      ok: true,
      value: {
        scope: "machine",
        key: "android.emulator",
        machine_id: "mac-mini",
      },
    });
    expect(
      validateCapabilityGuideTarget({
        scope: "project",
        key: "test-accounts",
        machine_id: null,
      }),
    ).toEqual({
      ok: true,
      value: { scope: "project", key: "test-accounts", machine_id: null },
    });
  });

  test.each([
    [null],
    [{ scope: "role", key: "godot" }],
    [{ scope: "capability", key: "Godot" }],
    [{ scope: "capability", key: "godot>=4" }],
    [{ scope: "capability", key: "a".repeat(65) }],
    [{ scope: "capability", key: "godot", machine_id: "local" }],
    [{ scope: "project", key: "accounts", machine_id: "local" }],
    [{ scope: "machine", key: "godot" }],
    [{ scope: "machine", key: "godot", machine_id: "../x" }],
  ])("refuses %j", (input) => {
    expect(validateCapabilityGuideTarget(input).ok).toBe(false);
  });
});

describe("write authorization", () => {
  const assignment = {
    kind: "assignment",
    project_id: "p",
    assignment_id: "A-1",
    role_id: "pm",
    role_version: 1,
    allowed_tools: ["get_card"],
    capabilities: [],
  } as unknown as Actor;

  test("humans and the host write; Agent Tokens are unauthorized", () => {
    expect(
      authorizeCapabilityGuideWrite({ kind: "human", project_id: "p" }, "p"),
    ).toEqual({ ok: true, value: "human" });
    expect(
      authorizeCapabilityGuideWrite({ kind: "system", project_id: "p" }, "p"),
    ).toEqual({ ok: true, value: "system" });
    const refused = authorizeCapabilityGuideWrite(assignment, "p");
    expect(refused.ok).toBe(false);
    expect(refused.ok ? null : refused.error.code).toBe("unauthorized");
    expect(
      authorizeCapabilityGuideWrite({ kind: "human", project_id: "q" }, "p").ok,
    ).toBe(false);
  });
});

describe("merge capability × machine × project", () => {
  const at = "2026-11-25T00:00:00.000Z";
  const entry = (
    scope: CapabilityGuideEntry["scope"],
    key: string,
    usage_note: string,
    machine_id: string | null = null,
  ): CapabilityGuideEntry => ({
    scope,
    key,
    machine_id,
    usage_note,
    updated_at: at,
    updated_by: "human",
  });
  const entries = [
    entry("capability", "godot", "godot main"),
    entry("capability", "android.emulator", "emulator main"),
    entry("machine", "android.emulator", "mac emulator", "mac-mini"),
    entry("machine", "android.emulator", "ci emulator", "cardigan-ci"),
    entry("machine", "blender", "mac blender only", "mac-mini"),
    entry("project", "test-accounts", "accounts in managed file"),
    entry("project", "signing", "request_mobile_signature"),
  ];

  test("main note plus this machine's supplement, and every project note", () => {
    expect(mergeCapabilityGuides(entries, { machine_id: "mac-mini" })).toEqual({
      machine_id: "mac-mini",
      capabilities: [
        {
          key: "android.emulator",
          usage_note: "emulator main",
          machine_note: "mac emulator",
        },
        {
          key: "blender",
          usage_note: null,
          machine_note: "mac blender only",
        },
        { key: "godot", usage_note: "godot main", machine_note: null },
      ],
      project_notes: [
        { key: "signing", usage_note: "request_mobile_signature" },
        { key: "test-accounts", usage_note: "accounts in managed file" },
      ],
    });
  });

  test("another machine never sees a peer's supplement", () => {
    const merged = mergeCapabilityGuides(entries, {
      machine_id: "cardigan-ci",
    });
    expect(merged.capabilities.map((c) => [c.key, c.machine_note])).toEqual([
      ["android.emulator", "ci emulator"],
      ["godot", null],
    ]);
    expect(
      mergeCapabilityGuides(entries).capabilities.every(
        (c) => c.machine_note === null,
      ),
    ).toBe(true);
  });

  test("requested capabilities are returned exactly, nulls where unwritten", () => {
    expect(
      mergeCapabilityGuides(entries, {
        machine_id: "mac-mini",
        capabilities: ["xcode", "godot", "godot"],
      }).capabilities,
    ).toEqual([
      { key: "godot", usage_note: "godot main", machine_note: null },
      { key: "xcode", usage_note: null, machine_note: null },
    ]);
  });
});
