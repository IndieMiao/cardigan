import type { GithubJob } from "./github-client.js";

/** C-611: the compact summary printed by the trusted macOS workflow's last step. */
export const MACOS_RESULT_MARKER = "cardigan-macos-result";
const MAX_LINE = 96 * 1024;
type CaseStatus = "passed" | "failed" | "skipped";
export interface MacosCase {
  readonly title: string;
  readonly status: CaseStatus;
  readonly duration_ms: number;
}
export interface MacosFileResult {
  readonly file: string;
  readonly status: string;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly error?: string;
}
export interface MacosCheckReport {
  readonly candidate_sha: string;
  readonly candidate_tree: string;
  readonly macos: string;
  readonly arch: string;
  readonly hc: string;
  readonly test_step: string;
  readonly exit_code: number | null;
  readonly files: readonly MacosFileResult[];
  readonly real_hc_cases: readonly (MacosCase & { readonly file: string })[];
  readonly timeouts: readonly (MacosCase & {
    readonly file: string;
    /** Marks the case itself recorded (task.meta.cardigan_phases), in order. */
    readonly phases: readonly MacosPhase[];
    readonly file_cases: readonly MacosCase[];
  })[];
}
/** A named point a test reached, in ms since the case started. */
export interface MacosPhase {
  readonly name: string;
  readonly at_ms: number;
}
export interface MacosStepTiming {
  readonly name: string;
  readonly conclusion: string | null;
  readonly seconds: number | null;
}
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
/** Printable, bounded text; candidate-controlled values never carry control characters. */
const text = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && [...v].length <= max && !/[\p{Cc}\p{Cf}]/u.test(v)
    ? v
    : undefined;
const count = (v: unknown): number | undefined =>
  Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : undefined;
function list<T>(v: unknown, max: number, item: (v: unknown) => T | undefined) {
  if (!Array.isArray(v) || v.length > max) return undefined;
  const out = v.map(item);
  return out.every((x) => x !== undefined) ? (out as T[]) : undefined;
}
const caseOf = (v: unknown): MacosCase | undefined => {
  if (!object(v)) return undefined;
  const title = text(v.title, 200),
    duration = count(v.duration_ms);
  if (
    title === undefined ||
    duration === undefined ||
    !["passed", "failed", "skipped"].includes(v.status as string)
  )
    return undefined;
  return { title, status: v.status as CaseStatus, duration_ms: duration };
};
const phaseOf = (v: unknown): MacosPhase | undefined => {
  if (!object(v)) return undefined;
  const name = text(v.name, 80),
    at = count(v.at_ms);
  return name !== undefined && at !== undefined
    ? { name, at_ms: at }
    : undefined;
};
const fileOf =
  (files: readonly string[]) =>
  (v: unknown): string | undefined =>
    typeof v === "string" && files.includes(v) ? v : undefined;

/**
 * Only the last marker line counts: the trusted summary step runs after all
 * candidate code. Invalid or foreign shapes yield no report.
 */
export function parseMacosCheckLog(
  log: string,
  files: readonly string[],
): MacosCheckReport | undefined {
  let encoded: string | undefined;
  for (const line of log.split(/\r?\n/u)) {
    const at = line.indexOf(`${MACOS_RESULT_MARKER} `);
    if (at < 0 || line.length > MAX_LINE) continue;
    const prefix = line.slice(0, at);
    // GitHub prefixes each line with its own ISO timestamp, nothing else.
    if (prefix && !/^\d{4}-\d\d-\d\dT[\d:.]+Z $/u.test(prefix)) continue;
    encoded = line.slice(at + MACOS_RESULT_MARKER.length + 1).trim();
  }
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!object(raw) || raw.version !== 1) return undefined;
  const file = fileOf(files);
  const results = list(raw.files, files.length, (v) => {
    if (!object(v)) return undefined;
    const name = file(v.file),
      status = text(v.status, 20),
      passed = count(v.passed),
      failed = count(v.failed),
      skipped = count(v.skipped),
      error = v.error === undefined ? "" : text(v.error, 300);
    if (
      name === undefined ||
      status === undefined ||
      passed === undefined ||
      failed === undefined ||
      skipped === undefined ||
      error === undefined
    )
      return undefined;
    return {
      file: name,
      status,
      passed,
      failed,
      skipped,
      ...(error ? { error } : {}),
    } satisfies MacosFileResult;
  });
  const real = list(raw.real_hc_cases, 32, (v) => {
    const c = caseOf(v),
      name = object(v) ? file(v.file) : undefined;
    return c && name ? { file: name, ...c } : undefined;
  });
  const timeouts = list(raw.timeouts, 8, (v) => {
    const c = caseOf(v),
      name = object(v) ? file(v.file) : undefined,
      cases = object(v) ? list(v.file_cases, 50, caseOf) : undefined,
      phases = object(v) ? list(v.phases ?? [], 50, phaseOf) : undefined;
    return c &&
      name &&
      cases &&
      phases?.every((p, i) => i === 0 || p.at_ms >= (phases[i - 1]?.at_ms ?? 0))
      ? { file: name, ...c, phases, file_cases: cases }
      : undefined;
  });
  const fields = {
    candidate_sha: text(raw.candidate_sha, 100),
    candidate_tree: text(raw.candidate_tree, 100),
    macos: text(raw.macos, 120),
    arch: text(raw.arch, 20),
    hc: text(raw.hc, 100),
    test_step: text(raw.test_step, 20),
  };
  const exit =
    raw.exit_code === null ? null : (count(raw.exit_code) ?? undefined);
  if (
    !results ||
    new Set(results.map((r) => r.file)).size !== results.length ||
    !real ||
    !timeouts ||
    exit === undefined ||
    Object.values(fields).some((v) => v === undefined)
  )
    return undefined;
  return {
    ...(fields as { [K in keyof typeof fields]: string }),
    exit_code: exit,
    files: results,
    real_hc_cases: real,
    timeouts,
  };
}

/**
 * Why a parsed report cannot count as this check's evidence: it must name the
 * host's candidate commit and tree and cover exactly the requested files.
 */
export function macosReportMismatch(
  report: MacosCheckReport,
  expected: {
    readonly files: readonly string[];
    readonly tested_sha?: string | undefined;
    readonly tree_sha?: string | undefined;
  },
): string | undefined {
  if (
    report.candidate_sha !== expected.tested_sha ||
    report.candidate_tree !== expected.tree_sha
  )
    return "汇总中的候选与本次检查不一致";
  const reported = new Set(report.files.map((f) => f.file));
  if (
    reported.size !== expected.files.length ||
    expected.files.some((f) => !reported.has(f))
  )
    return "汇总未覆盖全部请求的测试文件";
  return undefined;
}
/** Each phase's time until the next mark; the last one runs to the case's end. */
export function macosPhaseTimings(
  phases: readonly MacosPhase[],
  totalMs: number,
): string {
  return phases
    .map((p, i) => {
      const next = phases[i + 1];
      const ms = (next ? next.at_ms : Math.max(totalMs, p.at_ms)) - p.at_ms;
      return next
        ? `${p.name} ${seconds(ms)}`
        : `${p.name}（最后到达，停留 ${seconds(ms)}）`;
    })
    .join(" → ");
}
/** Trusted GitHub step timings of the job; candidate output cannot alter them. */
export function macosStepTimings(job: GithubJob): MacosStepTiming[] {
  return job.steps.slice(0, 64).map((step) => {
    const start = Date.parse(step.started_at ?? ""),
      end = Date.parse(step.completed_at ?? "");
    return {
      name: step.name.slice(0, 200),
      conclusion: step.conclusion,
      seconds:
        Number.isFinite(start) && Number.isFinite(end) && end >= start
          ? Math.round((end - start) / 1000)
          : null,
    };
  });
}
/** One timeline body: environment, per-file counts, real hc cases, exit code and timings. */
export function macosCheckSummary(input: {
  readonly status: string;
  readonly runUrl?: string | undefined;
  readonly testedSha?: string | undefined;
  readonly reason?: string | undefined;
  readonly report?: MacosCheckReport | undefined;
  readonly steps?: readonly MacosStepTiming[] | undefined;
}): string {
  const { report } = input;
  const lines = [`macOS 检查结束：${input.status}`];
  if (input.reason) lines.push(input.reason);
  if (input.testedSha) lines.push(`候选：${input.testedSha}`);
  if (input.runUrl) lines.push(`运行：${input.runUrl}`);
  if (report) {
    lines.push(
      `环境：macOS ${report.macos}，${report.arch}，${report.hc}；测试步骤 ${report.test_step}，退出码 ${report.exit_code ?? "无"}`,
    );
    for (const f of report.files)
      lines.push(
        `- ${f.file}：通过 ${f.passed}，失败 ${f.failed}，跳过 ${f.skipped}（${f.status}）${f.error ? `；${f.error}` : ""}`,
      );
    lines.push(
      report.real_hc_cases.length
        ? `真实 hc 用例：${report.real_hc_cases.map((c) => `${c.title} = ${c.status}`).join("；")}`
        : "真实 hc 用例：未找到",
    );
    for (const t of report.timeouts)
      lines.push(
        `超时：${t.file} › ${t.title}（${seconds(t.duration_ms)}）；${t.phases.length ? `分步计时：${macosPhaseTimings(t.phases, t.duration_ms)}` : "用例未记录分步"}；同文件用例耗时：${t.file_cases.map((c) => `${c.title} ${c.status} ${seconds(c.duration_ms)}`).join("；")}`,
      );
  } else if (input.status !== "not_run" && input.status !== "cancelled")
    lines.push("未取得测试汇总");
  if (
    input.steps?.length &&
    (input.status !== "passed" || report?.timeouts.length)
  )
    lines.push(
      `步骤计时：${input.steps.map((s) => `${s.name} ${s.conclusion ?? "-"} ${s.seconds ?? "?"}s`).join("；")}`,
    );
  return lines.join("\n").slice(0, 12_000);
}
