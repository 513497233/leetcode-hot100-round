// 轮次状态的纯逻辑，不依赖 vscode，便于单测。

export type Override = 'done' | 'undone';

export interface RoundState {
  /** 第几轮，从 1 开始 */
  round: number;
  /** 本轮开始时间（毫秒） */
  startAt: number;
  /** 从提交记录同步到的、本轮内 AC 过的题（titleSlug） */
  synced: string[];
  /** 手动修改，优先级高于同步结果 */
  overrides: Record<string, Override>;
  /** 上次同步时间（毫秒），0 表示从未同步 */
  lastSyncAt: number;
  /** 本轮每道题的提交统计（只含本轮有提交的题） */
  stats: Record<string, SlugStat>;
}

export interface SlugStat {
  /** 本轮提交次数 */
  count: number;
  /** 本轮通过次数 */
  ac: number;
  /** 本轮最后一次提交时间（毫秒） */
  lastAt: number;
  /** 统计时该题在 leetcode 上的「最后提交时间」，用于判断是否需要重新统计 */
  seen: number;
}

/** 兼容旧版本存下来的状态（没有 stats 字段）。 */
export function normalize(s: RoundState): RoundState {
  return { ...s, stats: s.stats ?? {} };
}

export function newRound(prev: RoundState | undefined, now: number): RoundState {
  return {
    round: (prev?.round ?? 0) + 1,
    startAt: now,
    synced: [],
    overrides: {},
    lastSyncAt: 0,
    stats: {},
  };
}

/** 修改本轮开始时间：同步结果和统计都作废，需要重新同步；手动修改保留。 */
export function setStartAt(s: RoundState, startAt: number): RoundState {
  return { ...s, startAt, synced: [], stats: {}, lastSyncAt: 0 };
}

/** 该题是否需要重新统计：本轮有提交，且 leetcode 上的最后提交时间比上次统计时新。 */
export function needsRecount(s: RoundState, slug: string, lastSubmittedAt: number): boolean {
  return lastSubmittedAt >= s.startAt && (s.stats[slug]?.seen ?? -1) < lastSubmittedAt;
}

/** 写入一批题的统计结果，通过过的题并入 synced。 */
export function applyStats(s: RoundState, updates: Record<string, SlugStat>, now: number): RoundState {
  const stats = { ...s.stats };
  for (const [slug, st] of Object.entries(updates)) {
    if (st.count > 0) stats[slug] = st;
    else delete stats[slug];
  }
  const passed = Object.entries(updates).filter(([, st]) => st.ac > 0).map(([slug]) => slug);
  return { ...mergeSynced(s, passed, now), stats };
}

/** 解析用户输入的本地时间：YYYY-MM-DD 或 YYYY-MM-DD HH:mm。无法解析返回 NaN。 */
export function parseLocalDate(input: string): number {
  const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?\s*$/.exec(input);
  if (!m) return NaN;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0'].map(Number);
  const t = new Date(y, mo - 1, d, h, mi);
  // 拒绝 2026-02-31 这类会被 Date 自动进位的日期
  if (t.getFullYear() !== y || t.getMonth() !== mo - 1 || t.getDate() !== d || h > 23 || mi > 59) return NaN;
  return t.getTime();
}

export function formatLocalDate(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- 统计页数据 ----------

export interface ProblemLike {
  titleSlug: string;
  group: string;
  difficulty: string;
}

export interface Bucket {
  name: string;
  done: number;
  total: number;
}

export interface Summary<P extends ProblemLike> {
  done: number;
  total: number;
  submissions: number;
  accepted: number;
  groups: Bucket[];
  difficulties: Bucket[];
  rows: { p: P; done: boolean; manual: boolean; stat: SlugStat | undefined }[];
}

function bucket(list: Bucket[], name: string, done: boolean): void {
  let b = list.find((x) => x.name === name);
  if (!b) list.push((b = { name, done: 0, total: 0 }));
  b.total++;
  if (done) b.done++;
}

export function summarize<P extends ProblemLike>(s: RoundState, problems: P[]): Summary<P> {
  const groups: Bucket[] = [];
  const difficulties: Bucket[] = [];
  let submissions = 0;
  let accepted = 0;
  const rows = problems.map((p) => {
    const done = isDone(s, p.titleSlug);
    bucket(groups, p.group, done);
    bucket(difficulties, p.difficulty, done);
    const stat = s.stats[p.titleSlug];
    submissions += stat?.count ?? 0;
    accepted += stat?.ac ?? 0;
    return { p, done, manual: s.overrides[p.titleSlug] !== undefined, stat };
  });
  const order = ['EASY', 'MEDIUM', 'HARD'];
  difficulties.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  const done = rows.filter((r) => r.done).length;
  return { done, total: problems.length, submissions, accepted, groups, difficulties, rows };
}

export function isDone(s: RoundState, slug: string): boolean {
  const o = s.overrides[slug];
  if (o === 'done') return true;
  if (o === 'undone') return false;
  return s.synced.includes(slug);
}

/** 手动翻转某题的完成状态；翻回与同步结果一致时，删掉 override。 */
export function toggle(s: RoundState, slug: string): RoundState {
  const want = !isDone(s, slug);
  const overrides = { ...s.overrides };
  if (want === s.synced.includes(slug)) {
    delete overrides[slug];
  } else {
    overrides[slug] = want ? 'done' : 'undone';
  }
  return { ...s, overrides };
}

/** 合并新同步到的 AC 题（只增不减：同步只会发现更多 AC）。 */
export function mergeSynced(s: RoundState, slugs: string[], now: number): RoundState {
  const set = new Set([...s.synced, ...slugs]);
  return { ...s, synced: [...set], lastSyncAt: now };
}

export function remaining(s: RoundState, all: string[]): string[] {
  return all.filter((slug) => !isDone(s, slug));
}

export function progress(s: RoundState, all: string[]): { done: number; total: number } {
  return { done: all.length - remaining(s, all).length, total: all.length };
}

export function pickRandom<T>(list: T[], rnd: () => number = Math.random): T | undefined {
  if (list.length === 0) return undefined;
  return list[Math.floor(rnd() * list.length)];
}

/** LeetCode 返回的时间有秒级数字字符串，也可能是 ISO 字符串；统一成毫秒。无法解析返回 NaN。 */
export function parseTime(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number' || /^\d+$/.test(v)) {
    const n = Number(v);
    return n < 1e12 ? n * 1000 : n;
  }
  return Date.parse(v);
}
