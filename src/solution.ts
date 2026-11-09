// 本地题解文件与判题结果格式化的纯逻辑，不依赖 vscode，便于单测。

export interface Lang {
  slug: string; // leetcode 的 langSlug
  name: string;
  ext: string;
  comment: string;
}

export const LANGS: Lang[] = [
  { slug: 'cpp', name: 'C++', ext: 'cpp', comment: '//' },
  { slug: 'python3', name: 'Python3', ext: 'py', comment: '#' },
  { slug: 'java', name: 'Java', ext: 'java', comment: '//' },
  { slug: 'golang', name: 'Go', ext: 'go', comment: '//' },
  { slug: 'javascript', name: 'JavaScript', ext: 'js', comment: '//' },
  { slug: 'typescript', name: 'TypeScript', ext: 'ts', comment: '//' },
  { slug: 'rust', name: 'Rust', ext: 'rs', comment: '//' },
  { slug: 'c', name: 'C', ext: 'c', comment: '//' },
  { slug: 'csharp', name: 'C#', ext: 'cs', comment: '//' },
  { slug: 'kotlin', name: 'Kotlin', ext: 'kt', comment: '//' },
  { slug: 'swift', name: 'Swift', ext: 'swift', comment: '//' },
];

export const CODE_START = '@hot100 code=start';
export const CODE_END = '@hot100 code=end';

/** 文件名格式：{题号}.{titleSlug}.{扩展名}，例如 1.two-sum.cpp */
export const FILE_NAME_RE = /^(\d+)\.([a-z0-9-]+)\.([a-z]+)$/;

export function fileName(frontendId: string, slug: string, lang: Lang): string {
  return `${frontendId}.${slug}.${lang.ext}`;
}

export function parseFileName(name: string): { frontendId: string; slug: string; lang: Lang } | undefined {
  const m = FILE_NAME_RE.exec(name);
  if (!m) return undefined;
  const lang = LANGS.find((l) => l.ext === m[3]);
  if (!lang) return undefined;
  return { frontendId: m[1], slug: m[2], lang };
}

/** 生成新题解文件内容：标记行之间是提交给 leetcode 的代码，之外可以写本地调试代码。 */
export function initialContent(lang: Lang, title: string, url: string, snippet: string): string {
  const c = lang.comment;
  return [
    `${c} ${title}`,
    `${c} ${url}`,
    '',
    `${c} ${CODE_START}`,
    snippet.trimEnd(),
    `${c} ${CODE_END}`,
    '',
  ].join('\n');
}

/** 取标记行之间的代码；没有标记就提交整个文件。 */
export function extractCode(text: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes(CODE_START));
  const end = lines.findIndex((l, i) => i > start && l.includes(CODE_END));
  if (start < 0 || end < 0) return text;
  return lines.slice(start + 1, end).join('\n');
}

// ---------- 判题结果 ----------

export interface CheckResult {
  state?: string;
  status_code?: number;
  status_msg?: string;
  run_success?: boolean;
  correct_answer?: boolean;
  code_answer?: string[];
  expected_code_answer?: string[];
  std_output_list?: string[];
  compile_error?: string;
  full_compile_error?: string;
  runtime_error?: string;
  full_runtime_error?: string;
  total_correct?: number | null;
  total_testcases?: number | null;
  status_runtime?: string;
  status_memory?: string;
  runtime_percentile?: number | null;
  memory_percentile?: number | null;
  last_testcase?: string;
  input_formatted?: string;
  code_output?: string;
  expected_output?: string;
  std_output?: string;
}

const STATUS_CN: Record<number, string> = {
  10: '通过',
  11: '解答错误',
  12: '超出内存限制',
  13: '输出超限',
  14: '超出时间限制',
  15: '执行出错',
  16: '内部出错',
  20: '编译出错',
};

export function statusText(r: CheckResult): string {
  return (r.status_code !== undefined && STATUS_CN[r.status_code]) || r.status_msg || '未知状态';
}

function errorBlock(r: CheckResult): string[] {
  const ce = r.full_compile_error || r.compile_error;
  if (ce) return ['编译错误：', ce];
  const re = r.full_runtime_error || r.runtime_error;
  if (re) return ['运行错误：', re];
  return [];
}

export interface Verdict {
  ok: boolean;
  /** 一行摘要，用于弹窗 */
  summary: string;
  /** 详细文本，用于输出面板 */
  detail: string;
}

/** 测试（自定义/示例用例）结果。 */
export function formatTest(r: CheckResult, dataInput: string): Verdict {
  const err = errorBlock(r);
  if (err.length || r.run_success === false) {
    const summary = `测试：${statusText(r)}`;
    return { ok: false, summary, detail: [summary, '', ...err, ...lastCase(r)].join('\n') };
  }
  const outs = r.code_answer ?? [];
  const exps = r.expected_code_answer ?? [];
  const n = outs.length;
  const inputLines = dataInput.split('\n');
  const per = n > 0 && inputLines.length % n === 0 ? inputLines.length / n : 0;
  const lines: string[] = [];
  let pass = 0;
  for (let i = 0; i < n; i++) {
    const ok = outs[i] === exps[i];
    if (ok) pass++;
    lines.push(`用例 ${i + 1} ${ok ? '✓' : '✗'}`);
    if (per) lines.push(`  输入：${inputLines.slice(i * per, (i + 1) * per).join(' | ')}`);
    lines.push(`  输出：${outs[i]}`);
    lines.push(`  预期：${exps[i] ?? '(无)'}`);
    const std = r.std_output_list?.[i];
    if (std) lines.push(`  标准输出：${std.trimEnd()}`);
  }
  const allOk = n > 0 && pass === n;
  const summary = `测试：${allOk ? '全部通过' : '未全部通过'}（${pass}/${n}）`;
  return { ok: allOk, summary, detail: [summary, '', ...lines].join('\n') };
}

/** 提交结果。 */
export function formatSubmit(r: CheckResult): Verdict {
  const st = statusText(r);
  const cases = r.total_testcases ? `（${r.total_correct ?? 0}/${r.total_testcases}）` : '';
  if (r.status_code === 10) {
    const pct = (v: number | null | undefined) => (typeof v === 'number' ? `，击败 ${v.toFixed(1)}%` : '');
    const summary = `提交：通过${cases}`;
    return {
      ok: true,
      summary,
      detail: [summary, '', `执行用时：${r.status_runtime ?? '-'}${pct(r.runtime_percentile)}`, `内存消耗：${r.status_memory ?? '-'}${pct(r.memory_percentile)}`].join('\n'),
    };
  }
  const summary = `提交：${st}${cases}`;
  return { ok: false, summary, detail: [summary, '', ...errorBlock(r), ...lastCase(r)].join('\n') };
}

function lastCase(r: CheckResult): string[] {
  const input = r.input_formatted || r.last_testcase;
  const out: string[] = [];
  if (input) out.push(`最后执行的输入：${input.replace(/\n/g, ' | ')}`);
  if (r.code_output) out.push(`输出：${r.code_output}`);
  if (r.expected_output) out.push(`预期：${r.expected_output}`);
  if (r.std_output) out.push(`标准输出：${r.std_output.trimEnd()}`);
  return out;
}
