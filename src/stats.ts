import * as vscode from 'vscode';
import { Problem } from './api';
import { Summary, formatLocalDate } from './round';

export interface StatsMeta {
  round: number;
  startAt: number;
  lastSyncAt: number;
  account: string;
}

/** 页面里按钮能触发的命令（白名单） */
const ALLOWED = new Set(['hot100.sync', 'hot100.setStartAt', 'hot100.openProblem', 'hot100.toggleDone', 'hot100.newRound']);

const DIFF: Record<string, string> = { EASY: '简单', MEDIUM: '中等', HARD: '困难' };

/** 本轮统计页（webview）。只在打开时渲染。 */
export class StatsPanel {
  private panel: vscode.WebviewPanel | undefined;
  private last: { summary: Summary<Problem>; meta: StatsMeta } | undefined;

  constructor(private readonly exec: (cmd: string, arg?: string) => unknown) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel('hot100.stats', 'Hot100 统计', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.onDidDispose(() => (this.panel = undefined));
    this.panel.webview.onDidReceiveMessage((m: { cmd?: string; arg?: string }) => {
      if (m.cmd && ALLOWED.has(m.cmd)) void this.exec(m.cmd, m.arg);
    });
    if (this.last) this.render();
  }

  update(summary: Summary<Problem>, meta: StatsMeta): void {
    this.last = { summary, meta };
    if (this.panel) this.render();
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private render(): void {
    if (!this.panel || !this.last) return;
    this.panel.webview.html = statsHtml(this.last.summary, this.last.meta, nonce());
  }
}

function pct(done: number, total: number): number {
  return total ? Math.round((done / total) * 100) : 0;
}

function bar(done: number, total: number): string {
  return `<div class="bar"><div style="width:${pct(done, total)}%"></div></div>`;
}

export function statsHtml(s: Summary<Problem>, meta: StatsMeta, n: string): string {
  const days = Math.max(1, Math.ceil((Date.now() - meta.startAt) / 86_400_000));
  const synced = meta.lastSyncAt ? formatLocalDate(meta.lastSyncAt) : '从未';

  const diffRows = s.difficulties
    .map((b) => `<div class="kv"><span>${DIFF[b.name] ?? esc(b.name)}</span><span>${b.done}/${b.total}，剩 ${b.total - b.done}</span></div>${bar(b.done, b.total)}`)
    .join('');

  const groupRows = s.groups
    .map(
      (b) => `<tr><td>${esc(b.name)}</td><td class="num">${b.done}</td><td class="num">${b.total - b.done}</td><td class="num">${b.total}</td><td class="w">${bar(b.done, b.total)}</td></tr>`,
    )
    .join('');

  const problemRows = s.rows
    .map(({ p, done, manual, stat }) => {
      const status = done ? `<span class="ok">✓ 已完成</span>` : `<span class="todo">未完成</span>`;
      return `<tr data-done="${done ? 1 : 0}">
        <td class="num">${esc(p.frontendId)}</td>
        <td><a href="#" data-cmd="hot100.openProblem" data-arg="${esc(p.titleSlug)}">${esc(p.title)}</a></td>
        <td>${esc(p.group)}</td>
        <td class="d-${esc(p.difficulty)}">${DIFF[p.difficulty] ?? esc(p.difficulty)}</td>
        <td>${status}${manual ? ' <span class="tag">手动</span>' : ''}</td>
        <td class="num">${stat?.count ?? 0}</td>
        <td class="num">${stat?.ac ?? 0}</td>
        <td>${stat?.lastAt ? formatLocalDate(stat.lastAt) : '-'}</td>
        <td><a href="#" data-cmd="hot100.toggleDone" data-arg="${esc(p.titleSlug)}">切换</a></td>
      </tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 8px 20px 40px; }
  h1 { font-size: 1.5em; margin-bottom: 4px; }
  .sub { color: var(--vscode-descriptionForeground); margin-bottom: 16px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent); border-radius: 6px; padding: 12px; }
  .card .v { font-size: 1.8em; font-weight: 600; }
  .card .l { color: var(--vscode-descriptionForeground); }
  .bar { height: 6px; background: var(--vscode-editorWidget-background); border-radius: 3px; overflow: hidden; margin: 2px 0 10px; }
  .bar div { height: 100%; background: var(--vscode-progressBar-background); }
  .kv { display: flex; justify-content: space-between; }
  .cols { display: grid; grid-template-columns: minmax(200px, 1fr) 2fr; gap: 24px; margin-bottom: 24px; }
  @media (max-width: 700px) { .cols { grid-template-columns: 1fr; } }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.2)); }
  th { color: var(--vscode-descriptionForeground); font-weight: normal; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.w { width: 35%; }
  td.w .bar { margin: 0; }
  .ok { color: var(--vscode-testing-iconPassed, #73c991); }
  .todo { color: var(--vscode-descriptionForeground); }
  .tag { font-size: .85em; padding: 0 4px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .d-EASY { color: #00af9b; } .d-MEDIUM { color: #ffb800; } .d-HARD { color: #ff2d55; }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 10px; border-radius: 3px; cursor: pointer; margin-right: 6px; }
  button.on, button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .toolbar { margin: 8px 0 12px; }
</style></head>
<body>
  <h1>Hot100 第${meta.round}轮</h1>
  <div class="sub">开始于 ${formatLocalDate(meta.startAt)}（第 ${days} 天） · 上次同步 ${synced} · ${esc(meta.account)}</div>
  <div class="toolbar">
    <button class="primary" data-cmd="hot100.sync">同步</button>
    <button data-cmd="hot100.setStartAt">修改开始时间</button>
    <button data-cmd="hot100.newRound">开始新一轮</button>
  </div>
  <div class="cards">
    <div class="card"><div class="v">${s.done}</div><div class="l">已完成</div></div>
    <div class="card"><div class="v">${s.total - s.done}</div><div class="l">剩余</div></div>
    <div class="card"><div class="v">${pct(s.done, s.total)}%</div><div class="l">完成度</div></div>
    <div class="card"><div class="v">${s.submissions}</div><div class="l">本轮提交次数</div></div>
    <div class="card"><div class="v">${s.submissions ? pct(s.accepted, s.submissions) : 0}%</div><div class="l">提交通过率</div></div>
    <div class="card"><div class="v">${(s.done / days).toFixed(1)}</div><div class="l">平均每天完成</div></div>
  </div>
  <div class="cols">
    <div><h3>按难度</h3>${diffRows}</div>
    <div><h3>按类型</h3>
      <table><thead><tr><th>类型</th><th class="num">已完成</th><th class="num">剩余</th><th class="num">总数</th><th></th></tr></thead>
      <tbody>${groupRows}</tbody></table>
    </div>
  </div>
  <h3>每道题</h3>
  <div class="toolbar">
    <button data-filter="all">全部</button><button data-filter="todo">未完成</button><button data-filter="done">已完成</button>
  </div>
  <table id="problems"><thead><tr>
    <th class="num">题号</th><th>题目</th><th>类型</th><th>难度</th><th>状态</th><th class="num">本轮提交</th><th class="num">通过</th><th>最后提交</th><th></th>
  </tr></thead><tbody>${problemRows}</tbody></table>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const st = vscode.getState() || { filter: 'all' };
  function applyFilter(f) {
    st.filter = f; vscode.setState(st);
    document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('on', b.dataset.filter === f));
    document.querySelectorAll('#problems tbody tr').forEach(tr => {
      const d = tr.dataset.done === '1';
      tr.style.display = f === 'all' || (f === 'done') === d ? '' : 'none';
    });
  }
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-cmd],[data-filter]');
    if (!t) return;
    e.preventDefault();
    if (t.dataset.filter) applyFilter(t.dataset.filter);
    else vscode.postMessage({ cmd: t.dataset.cmd, arg: t.dataset.arg });
  });
  applyFilter(st.filter);
</script>
</body></html>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
