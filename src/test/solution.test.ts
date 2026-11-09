import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../solution';

const CPP = S.LANGS.find((l) => l.slug === 'cpp')!;
const PY = S.LANGS.find((l) => l.slug === 'python3')!;

test('fileName / parseFileName 往返', () => {
  const cases = [
    { id: '1', slug: 'two-sum', lang: CPP, name: '1.two-sum.cpp' },
    { id: '146', slug: 'lru-cache', lang: PY, name: '146.lru-cache.py' },
  ];
  for (const c of cases) {
    assert.equal(S.fileName(c.id, c.slug, c.lang), c.name);
    assert.deepEqual(S.parseFileName(c.name), { frontendId: c.id, slug: c.slug, lang: c.lang });
  }
});

test('parseFileName 拒绝非题解文件', () => {
  for (const name of ['main.cpp', '0001.two-sum.exe', 'two-sum.cpp', '1.Two_Sum.cpp']) {
    assert.equal(S.parseFileName(name), undefined, name);
  }
});

test('extractCode 只取标记之间的代码', () => {
  const snippet = 'class Solution {\npublic:\n};';
  const content = S.initialContent(CPP, '1. 两数之和', 'https://leetcode.cn/problems/two-sum/', snippet);
  assert.equal(S.extractCode(content), snippet);
  const withLocal = content + '\nint main() { return 0; }\n';
  assert.equal(S.extractCode(withLocal), snippet);
});

test('extractCode 没有标记时返回整个文件', () => {
  assert.equal(S.extractCode('class Solution: pass'), 'class Solution: pass');
});

test('initialContent 用对应语言的注释符', () => {
  const content = S.initialContent(PY, 't', 'u', 'class Solution: pass');
  assert.ok(content.includes(`# ${S.CODE_START}`));
  assert.ok(content.includes(`# ${S.CODE_END}`));
});

test('formatTest', () => {
  const cases: { name: string; r: S.CheckResult; input: string; ok: boolean; summary: string; contains: string[] }[] = [
    {
      name: '全部通过',
      r: { run_success: true, code_answer: ['[0,1]', '[1,2]'], expected_code_answer: ['[0,1]', '[1,2]'] },
      input: '[2,7,11,15]\n9\n[3,2,4]\n6',
      ok: true,
      summary: '测试：全部通过（2/2）',
      contains: ['输入：[3,2,4] | 6'],
    },
    {
      name: '有用例错误',
      r: { run_success: true, code_answer: ['[0,1]', '[0,0]'], expected_code_answer: ['[0,1]', '[1,2]'], std_output_list: ['', 'debug\n'] },
      input: '[2,7,11,15]\n9\n[3,2,4]\n6',
      ok: false,
      summary: '测试：未全部通过（1/2）',
      contains: ['用例 2 ✗', '标准输出：debug'],
    },
    {
      name: '编译错误',
      r: { run_success: false, status_code: 20, full_compile_error: "Line 3: expected ';'" },
      input: '',
      ok: false,
      summary: '测试：编译出错',
      contains: ["Line 3: expected ';'"],
    },
  ];
  for (const c of cases) {
    const v = S.formatTest(c.r, c.input);
    assert.equal(v.ok, c.ok, c.name);
    assert.equal(v.summary, c.summary, c.name);
    for (const s of c.contains) assert.ok(v.detail.includes(s), `${c.name}: 缺少 ${s}\n${v.detail}`);
  }
});

test('formatSubmit', () => {
  const ac = S.formatSubmit({
    status_code: 10, total_correct: 63, total_testcases: 63, status_runtime: '4 ms', status_memory: '12 MB', runtime_percentile: 91.234,
  });
  assert.equal(ac.ok, true);
  assert.equal(ac.summary, '提交：通过（63/63）');
  assert.ok(ac.detail.includes('执行用时：4 ms，击败 91.2%'));

  const wa = S.formatSubmit({
    status_code: 11, total_correct: 10, total_testcases: 63, last_testcase: '[3,3]\n6', code_output: '[0,0]', expected_output: '[0,1]',
  });
  assert.equal(wa.ok, false);
  assert.equal(wa.summary, '提交：解答错误（10/63）');
  assert.ok(wa.detail.includes('最后执行的输入：[3,3] | 6'));
  assert.ok(wa.detail.includes('预期：[0,1]'));
});
