import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { BoundedOutput } from "./bounded-check-output.js";
import { MIN_REDACTED_ENV_BYTES } from "./check-environment.js";
import { pruneCheckLogs, saveCheckLog } from "./check-log-storage.js";
import { checkInfraFlaky, checkTimedOutOnly } from "./merge-check-timeout.js";
import type { CheckoutResult } from "./temporary-checkout.js";
import {
  bindWorkerCheckout,
  type InfraFlakyRule,
  type VerifiedCheckoutContext,
  type WorkerFailureContext,
  type WorkerFailureIdentity,
} from "./worker-failure-context.js";

export const CHECK_OUTPUT_LIMIT = 2 * 1024 * 1024;
export const CHECK_SUMMARY_LIMIT = 12000;
const MASK = "[REDACTED]";
const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
function normalizeOutput(value: string, github = false): string {
  const normalized = stripVTControlCharacters(value).replace(
    /[\p{Cc}\p{Cf}]/gu,
    (character) => ("\n\r\t".includes(character) ? character : ""),
  );
  return github
    ? normalized.replace(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,9}Z /gmu,
        "",
      )
    : normalized;
}
function redactor(
  env: Readonly<Record<string, string>>,
  github = false,
  redactPaths = false,
) {
  const values = [
    ...new Set(
      Object.values(env)
        .filter(
          (value) =>
            /[\r\n]/u.test(value) ||
            Buffer.byteLength(value, "utf8") >= MIN_REDACTED_ENV_BYTES,
        )
        .flatMap((value) => {
          let uri = value;
          try {
            uri = encodeURIComponent(value);
          } catch {}
          return [
            value,
            ...value.split(/[\r\n]+/u),
            uri,
            JSON.stringify(value).slice(1, -1),
            Buffer.from(value).toString("base64"),
          ]
            .map((variant) => normalizeOutput(variant, github))
            .filter(Boolean);
        }),
    ),
  ].sort((a, b) => b.length - a.length);
  const pattern = values.length
    ? new RegExp(values.map(escapeRegex).join("|"), "gu")
    : undefined;
  return {
    redact(value: string) {
      let text = normalizeOutput(value, github);
      if (pattern) text = text.replace(pattern, () => MASK);
      text = text
        .replace(
          /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
          MASK,
        )
        .replace(/-----+(?:BEGIN|END) [A-Z ]*PRIVATE KEY-----+/gu, MASK)
        .replace(/(\b(?:bearer|basic)[ \t]+)\S+/giu, `$1${MASK}`)
        // An unquoted value with spaces has no trustworthy end delimiter.
        .replace(
          /((?:["'](?:[A-Z_][A-Z0-9_]*|password|secret|token|api_key)["'][ \t]*[:=]|\b[A-Z_][A-Z0-9_]*[ \t]*=|\b[A-Z_][A-Z0-9_]+[ \t]*:)[ \t]*)[^\n]*/gu,
          `$1${MASK}`,
        )
        .replace(
          /(\b(?:api[_-]?key|token|password|secret)[ \t]*[:=][ \t]*)[^\n]*/giu,
          `$1${MASK}`,
        )
        .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_.-]+/gu, MASK);
      if (text.includes("://"))
        text = text.replace(/\S+/gu, (word) =>
          word.includes("://")
            ? word.startsWith("##[error]")
              ? "##[error][URL]"
              : "[URL]"
            : word,
        );
      return redactPaths
        ? text.replace(/(?<![\w.-])(?:[A-Za-z]:[\\/]|\/)[^\s]+/gu, "[私有路径]")
        : text;
    },
  };
}
function clip(text: string, limit: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  let at = limit;
  while (at > 0 && at < bytes.length && ((bytes[at] ?? 0) & 0xc0) === 0x80)
    at--;
  return bytes.subarray(0, at).toString("utf8");
}
/** All parts must already be redacted; preserve the existing UTF-8 summary budget. */
export function boundedCheckSummary(...parts: readonly string[]): string {
  if (!parts.length) return "";
  const separator = "；";
  const perPart = Math.max(
    0,
    Math.floor(
      (CHECK_SUMMARY_LIMIT -
        Buffer.byteLength(separator) * (parts.length - 1)) /
        parts.length,
    ),
  );
  return parts.map((part) => clip(part, perPart)).join(separator);
}
/** Restore the approved failure projection: no argv, raw stack/cause or private paths. */
export function safeCheckDiagnostic(
  error: unknown,
  env: Readonly<Record<string, string>>,
): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "检查操作失败，未返回错误说明";
  const line =
    redactor(env, false, true)
      .redact(message)
      .split(/\r?\n/u)
      .find((value) => value.trim()) ?? "检查操作失败";
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  const knownCode =
    typeof code === "string" &&
    [
      "EACCES",
      "EPERM",
      "ENOSPC",
      "ENOENT",
      "EIO",
      "EROFS",
      "EMFILE",
      "ENFILE",
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EPIPE",
    ].includes(code)
      ? `[${code}] `
      : "";
  return clip(
    knownCode +
      (/^(?:Error:\s*)?Command failed\b/iu.test(line)
        ? "子进程执行失败（命令参数已省略）"
        : line),
    CHECK_SUMMARY_LIMIT,
  );
}
async function privateDirectory(path: string, create: boolean) {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
      await chmod(path, 0o700);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const entry = await lstat(path);
  if (
    !entry.isDirectory() ||
    entry.uid !== process.getuid?.() ||
    (entry.mode & 0o777) !== 0o700 ||
    (await realpath(path)) !== path
  )
    throw new Error(
      "Merge check logs require a private host-owned directory without symlinks",
    );
}
/** One host queue owns the active writer; files are created exclusively and never contain raw output. */
export async function createMergeCheckLog(input: {
  readonly dataDir: string;
  readonly resume?: boolean;
  readonly failureExcerptBytes?: number;
  readonly infraFlakyRules?: readonly InfraFlakyRule[];
  readonly workerContext?: WorkerFailureContext;
  readonly workerIdentity?: WorkerFailureIdentity;
  readonly project: string;
  readonly attempt: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly redactPaths?: boolean;
}) {
  if (
    !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(input.project) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(input.attempt)
  )
    throw new Error("Invalid merge check log identity");
  const data = resolve(input.dataDir);
  for (let parent = dirname(data); ; parent = dirname(parent)) {
    const entry = await lstat(parent);
    if (
      !entry.isDirectory() ||
      ![0, process.getuid?.()].includes(entry.uid) ||
      (entry.mode & 0o022 && !(entry.mode & 0o1000))
    )
      throw new Error("Untrusted merge check log ancestor");
    if (parent === dirname(parent)) break;
  }
  await privateDirectory(data, false);
  const directory = join(data, "merge-gate", "logs", input.project);
  for (const path of [
    join(data, "merge-gate"),
    join(data, "merge-gate", "logs"),
    directory,
  ])
    await privateDirectory(path, true);
  const log_ref = `${input.attempt}.log`,
    path = join(directory, log_ref);
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  ).catch(async (error: NodeJS.ErrnoException) => {
    if (!input.resume || error.code !== "EEXIST") throw error;
    const handle = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600
    ) {
      await handle.close();
      throw new Error("Unsafe resumed check log");
    }
    return handle;
  });
  const filter = redactor(
      input.env ?? {},
      input.failureExcerptBytes !== undefined,
      input.redactPaths,
    ),
    output = new Map<string, BoundedOutput>();
  // Include individual lines of multiline configured values; the summary parser
  // intentionally never retains the surrounding raw block. Mask unconfigured
  // assignment values too (including quoted values containing whitespace).
  const jobKey =
    input.failureExcerptBytes !== undefined ? { open: false } : undefined;
  const fragments = Object.values(input.env ?? {})
    .flatMap((v) => normalizeOutput(v).split(/[\r\n]+/u))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const fragmentPattern = fragments.length
    ? new RegExp(fragments.map(escapeRegex).join("|"), "gu")
    : undefined;
  const redactLine = (line: string) =>
    filter
      .redact(line)
      .replace(/(\b[A-Za-z_]\w*[ \t]*=[ \t]*)[^\n]*/gu, `$1${MASK}`);
  const summarizeLine = (safe: string) =>
    fragmentPattern ? safe.replace(fragmentPattern, MASK) : safe;
  const header = filter.redact(
    `合并检查 ${input.project} / ${input.attempt}\n`,
  );
  try {
    await file.chmod(0o600);
    await file.writeFile(header);
  } finally {
    await file.close();
  }
  let finished = false;
  const workerContext = input.workerContext;
  const workerRules = input.infraFlakyRules
    ? [...input.infraFlakyRules]
    : undefined;
  const workerIdentity = input.workerIdentity
    ? { ...input.workerIdentity }
    : undefined;
  return {
    log_ref,
    verifiedCheckout(context: VerifiedCheckoutContext) {
      return !finished && workerContext
        ? bindWorkerCheckout(workerContext, context)
        : false;
    },
    resetOutput(name: string) {
      if (!finished) {
        output.delete(name);
        if (jobKey) jobKey.open = false;
      }
    },
    append(name: string, text: string) {
      if (finished) throw new Error("Merge check log is already closed");
      let buffer = output.get(name);
      if (!buffer) {
        buffer = new BoundedOutput(
          CHECK_OUTPUT_LIMIT,
          (line) =>
            normalizeOutput(line, input.failureExcerptBytes !== undefined),
          redactLine,
          summarizeLine,
          jobKey,
        );
        output.set(name, buffer);
      }
      buffer.append(text);
    },
    async finish(
      result: CheckoutResult,
      bound?: { readonly run_id: number; readonly html_url: string },
    ) {
      if (finished) throw new Error("Merge check log is already closed");
      finished = true;
      const safe: CheckoutResult = {
        ...result,
        checks: result.checks.map((c) => ({
          ...c,
          name: filter.redact(c.name),
        })),
        cleanup_errors: result.cleanup_errors.map(filter.redact),
        ...(result.reason ? { reason: filter.redact(result.reason) } : {}),
      };
      const failed = result.checks.find(
        (c) => !["passed", "not_run", "skipped"].includes(c.status),
      );
      // A partial download cannot provide redaction boundaries or retry evidence.
      if (result.logFailure) output.clear();
      for (const buffer of output.values()) buffer.seal();
      const failures =
        output.get(failed?.name ?? "executor")?.failure.lines() ?? [];
      const baseSummary =
        result.status === "passed"
          ? result.checks.some((c) => c.status === "skipped")
            ? "本次范围内的检查已通过"
            : "检查全部通过"
          : clip(
              filter.redact(
                [
                  failed
                    ? `检查 ${failed.name} 未通过（${failed.status}，退出码 ${failed.exit_code ?? "无"}）`
                    : `${result.status === "interrupted" ? "合并检查已取消" : "合并检查未通过"}：${result.reason ?? result.status}`,
                  ...failures,
                ]
                  .join("\n")
                  .split(/\r?\n/u)
                  .slice(0, 20)
                  .join("\n"),
              ),
              CHECK_SUMMARY_LIMIT,
            );
      // This link is constructed solely from the verified run and numeric job id,
      // never from log text, a Location header or an exception message.
      const locator =
        result.logFailure && result.logSource
          ? `\n日志获取失败（${result.logFailure}）：${result.logSource.url}${result.logSource.jobId ? `/job/${result.logSource.jobId}` : ""}`
          : "";
      const summary =
        clip(baseSummary, CHECK_SUMMARY_LIMIT - Buffer.byteLength(locator)) +
        locator;
      const firstFail =
        result.status === "passed" || input.failureExcerptBytes === undefined
          ? undefined
          : namesForExcerpt();
      function namesForExcerpt() {
        const buffer = output.get(failed?.name ?? "executor");
        if (buffer) {
          const text = buffer.text();
          const match = /(?:^|\n)[^\n]*?\bFAIL\b/u.exec(text);
          if (match?.index !== undefined)
            return clip(
              summarizeLine(text.slice(match.index).trimStart()),
              input.failureExcerptBytes ?? 4096,
            );
        }
        return undefined;
      }
      // C-116: classified from the full retained output, before it is cleared.
      const completeEvidence =
        !result.logFailure &&
        !result.logAttributionIncomplete &&
        !result.manual_attention &&
        ![...output.values()].some((b) => b.incomplete);
      const timeout_only =
        completeEvidence &&
        checkTimedOutOnly(
          result.status,
          result.checks,
          (name) => output.get(name)?.text() ?? "",
        );
      const infra_flaky =
        completeEvidence &&
        [...output.keys()].every((name) =>
          result.checks.some((check) => check.name === name),
        ) &&
        checkInfraFlaky(
          result.status,
          result.checks,
          (name) => output.get(name)?.text() ?? "",
          {
            ...(workerRules ? { rules: workerRules } : {}),
            ...(workerContext ? { context: workerContext } : {}),
            ...(workerIdentity ? { identity: workerIdentity } : {}),
          },
        );
      const names = [
        ...new Set([...result.checks.map((c) => c.name), ...output.keys()]),
      ];
      await privateDirectory(directory, false);
      const writeError = await saveCheckLog(path, async (handle) => {
        await handle.writeFile(
          header + (result.status === "passed" ? "" : `\n${summary}\n`),
        );
        for (const name of names) {
          await handle.writeFile(
            `\n=== ${filter.redact(name)} ===\n${output.get(name)?.text() ?? "未输出内容\n"}`,
          );
        }
        if (result.status === "passed")
          await handle.writeFile(`\n${summary}\n`);
        if (safe.cleanup_errors.length)
          await handle.writeFile(
            `\n清理提示：\n${safe.cleanup_errors.join("\n")}\n`,
          );
      });
      output.clear();
      let note = "";
      if (writeError) {
        // Only a known body I/O failure *after* binding/step validation may
        // degrade diagnostics instead of failing the check. Never accept a URL from output.
        const url = bound?.html_url;
        const match =
          url &&
          /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/([1-9]\d*)$/u.exec(
            url,
          );
        if (
          !bound ||
          !match ||
          Number(match[1]) !== bound.run_id ||
          (result.logSource && result.logSource.url !== url) ||
          result.checks.map((c) => c.name).join(",") !==
            "install,build,test,lint,deps,e2e"
        )
          throw new Error(`检查日志写入失败 [${writeError}]`);
        note = `本地日志保存失败（${writeError}，已尝试三次），可从远端重试读取；${result.logFailure ? `日志获取失败（${result.logFailure}）；` : ""}检查结论不变：${url}${result.logSource?.jobId ? `/job/${result.logSource.jobId}` : ""}`;
      } else {
        try {
          await pruneCheckLogs(directory);
        } catch {
          note = "旧日志清理未完成，本次日志已保存";
        }
      }
      return {
        ...safe,
        summary: note
          ? clip(
              baseSummary,
              CHECK_SUMMARY_LIMIT - Buffer.byteLength(note + locator) - 2,
            ) +
            "\n" +
            note +
            (writeError ? "" : locator)
          : summary,
        log_ref,
        timeout_only,
        infra_flaky,
        ...(firstFail ? { failure_excerpt: firstFail } : {}),
      };
    },
  };
}
