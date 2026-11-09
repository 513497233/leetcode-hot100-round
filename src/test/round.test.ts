import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../round';

const ALL = ['a', 'b', 'c', 'd'];

function state(over: Partial<R.RoundState> = {}): R.RoundState {
  return { ...R.newRound(undefined, 1000), ...over };
}

test('newRound 递增轮次并清空进度', () => {
  const prev = state({ round: 3, synced: ['a'], overrides: { b: 'done' } });
  const next = R.newRound(prev, 5000);
  assert.deepEqual(next, { round: 4, startAt: 5000, synced: [], overrides: {}, lastSyncAt: 0, stats: {} });
});

test('isDone：override 优先于同步结果', () => {
  const cases: { name: string; s: R.RoundState; slug: string; want: boolean }[] = [
    { name: '无同步无 override', s: state(), slug: 'a', want: false },
    { name: '同步到 AC', s: state({ synced: ['a'] }), slug: 'a', want: true },
    { name: '手动标完成', s: state({ overrides: { a: 'done' } }), slug: 'a', want: true },
    { name: '同步到 AC 但手动标未完成', s: state({ synced: ['a'], overrides: { a: 'undone' } }), slug: 'a', want: false },
  ];
  for (const c of cases) assert.equal(R.isDone(c.s, c.slug), c.want, c.name);
});

test('toggle：翻回与同步一致时删掉 override', () => {
  let s = state({ synced: ['a'] });
  s = R.toggle(s, 'a');
  assert.deepEqual(s.overrides, { a: 'undone' });
  s = R.toggle(s, 'a');
  assert.deepEqual(s.overrides, {});
  s = R.toggle(s, 'b');
  assert.deepEqual(s.overrides, { b: 'done' });
  s = R.toggle(s, 'b');
  assert.deepEqual(s.overrides, {});
});

test('mergeSynced 去重并更新同步时间', () => {
  const s = R.mergeSynced(state({ synced: ['a'] }), ['a', 'b'], 9000);
  assert.deepEqual([...s.synced].sort(), ['a', 'b']);
  assert.equal(s.lastSyncAt, 9000);
});

test('remaining / progress', () => {
  const s = state({ synced: ['a', 'b'], overrides: { b: 'undone', c: 'done' } });
  assert.deepEqual(R.remaining(s, ALL), ['b', 'd']);
  assert.deepEqual(R.progress(s, ALL), { done: 2, total: 4 });
});

test('pickRandom 只从给定列表里取，空列表返回 undefined', () => {
  assert.equal(R.pickRandom([], () => 0.5), undefined);
  assert.equal(R.pickRandom(['x', 'y', 'z'], () => 0), 'x');
  assert.equal(R.pickRandom(['x', 'y', 'z'], () => 0.999), 'z');
});

test('parseTime 兼容秒、毫秒、ISO', () => {
  const cases: { in: string | number | null; want: number }[] = [
    { in: '1700000000', want: 1700000000000 },
    { in: 1700000000000, want: 1700000000000 },
    { in: '2023-11-14T22:13:20+00:00', want: 1700000000000 },
  ];
  for (const c of cases) assert.equal(R.parseTime(c.in), c.want, String(c.in));
  assert.ok(Number.isNaN(R.parseTime(null)));
});

test('setStartAt 清空同步结果和统计，保留手动标记', () => {
  const s = state({ synced: ['a'], overrides: { b: 'done' }, lastSyncAt: 5, stats: { a: { count: 2, ac: 1, lastAt: 3, seen: 3 } } });
  const next = R.setStartAt(s, 42);
  assert.equal(next.startAt, 42);
  assert.deepEqual(next.synced, []);
  assert.deepEqual(next.stats, {});
  assert.equal(next.lastSyncAt, 0);
  assert.deepEqual(next.overrides, { b: 'done' });
});

test('normalize 补齐旧状态的 stats 字段', () => {
  const old = { round: 1, startAt: 1, synced: [], overrides: {}, lastSyncAt: 0 } as unknown as R.RoundState;
  assert.deepEqual(R.normalize(old).stats, {});
});

test('needsRecount', () => {
  const s = state({ startAt: 1000, stats: { a: { count: 1, ac: 0, lastAt: 1500, seen: 1500 } } });
  const cases = [
    { name: '本轮之前提交的题不统计', slug: 'b', last: 900, want: false },
    { name: '本轮有提交、从没统计过', slug: 'b', last: 1200, want: true },
    { name: '统计后没有新提交', slug: 'a', last: 1500, want: false },
    { name: '统计后有新提交', slug: 'a', last: 1600, want: true },
  ];
  for (const c of cases) assert.equal(R.needsRecount(s, c.slug, c.last), c.want, c.name);
});

test('applyStats 写入统计并把通过的题并入 synced', () => {
  const s = state({ synced: ['x'], stats: { z: { count: 1, ac: 0, lastAt: 1, seen: 1 } } });
  const next = R.applyStats(
    s,
    { a: { count: 3, ac: 1, lastAt: 9, seen: 9 }, b: { count: 2, ac: 0, lastAt: 8, seen: 8 }, z: { count: 0, ac: 0, lastAt: 0, seen: 2 } },
    100,
  );
  assert.deepEqual([...next.synced].sort(), ['a', 'x']);
  assert.deepEqual(Object.keys(next.stats).sort(), ['a', 'b']);
  assert.equal(next.lastSyncAt, 100);
});

test('parseLocalDate / formatLocalDate', () => {
  assert.equal(R.parseLocalDate('2026-11-04'), new Date(2026, 10, 4).getTime());
  assert.equal(R.parseLocalDate(' 2026-11-04 09:30 '), new Date(2026, 10, 4, 9, 30).getTime());
  for (const bad of ['2026/11/04', '2026-02-31', '2026-11-04 25:00', 'abc']) {
    assert.ok(Number.isNaN(R.parseLocalDate(bad)), bad);
  }
  assert.equal(R.formatLocalDate(new Date(2026, 10, 4, 9, 5).getTime()), '2026-11-04 09:05');
});

test('summarize 按类型/难度汇总并统计提交', () => {
  const problems = [
    { titleSlug: 'a', group: '哈希', difficulty: 'MEDIUM' },
    { titleSlug: 'b', group: '哈希', difficulty: 'EASY' },
    { titleSlug: 'c', group: '链表', difficulty: 'HARD' },
  ];
  const s = state({
    synced: ['a'],
    overrides: { c: 'done' },
    stats: { a: { count: 3, ac: 1, lastAt: 1, seen: 1 }, b: { count: 2, ac: 0, lastAt: 1, seen: 1 } },
  });
  const sum = R.summarize(s, problems);
  assert.equal(sum.done, 2);
  assert.equal(sum.total, 3);
  assert.equal(sum.submissions, 5);
  assert.equal(sum.accepted, 1);
  assert.deepEqual(sum.groups, [{ name: '哈希', done: 1, total: 2 }, { name: '链表', done: 1, total: 1 }]);
  assert.deepEqual(sum.difficulties.map((d) => d.name), ['EASY', 'MEDIUM', 'HARD']);
  assert.equal(sum.rows[2].manual, true);
});
