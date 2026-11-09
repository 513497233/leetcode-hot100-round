import * as vscode from 'vscode';
import { LeetCodeCn, Problem, problemUrl } from './api';
import { ProblemTree, Node } from './tree';
import { Runner } from './runner';
import { StatsPanel } from './stats';
import * as R from './round';

const STATE_KEY = 'hot100.round.v1';
const PROBLEMS_KEY = 'hot100.problems.v1';
const COOKIE_KEY = 'hot100.cookie';
const AUTO_SYNC_INTERVAL_MS = 60_000;
const SYNC_CONCURRENCY = 4;

/** 绑定状态：unbound=没存 Cookie；expired=存了但 leetcode.cn 显示未登录；unknown=网络等原因没查成 */
type Account = { kind: 'unbound' } | { kind: 'bound'; username: string } | { kind: 'expired' } | { kind: 'unknown'; error: string };

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('Hot100 Round');
  let problems: Problem[] = context.globalState.get<Problem[]>(PROBLEMS_KEY) ?? [];
  let state: R.RoundState = R.normalize(context.globalState.get<R.RoundState>(STATE_KEY) ?? R.newRound(undefined, Date.now()));
  let account: Account = { kind: 'unknown', error: '检查中' };
  let syncing = false;

  const tree = new ProblemTree(() => ({ problems, state }));
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'hot100.randomPick';
  statusBar.show();
  context.subscriptions.push(log, statusBar, vscode.window.registerTreeDataProvider('hot100.problems', tree));

  const slugs = () => problems.map((p) => p.titleSlug);
  const stats = new StatsPanel((cmd, arg) => vscode.commands.executeCommand(cmd, arg));
  context.subscriptions.push(stats);

  const accountText = (): string => {
    switch (account.kind) {
      case 'bound':
        return `已绑定：${account.username}`;
      case 'unbound':
        return '未绑定账号';
      case 'expired':
        return 'Cookie 已失效，请重新绑定';
      default:
        return `绑定状态未知（${account.error}）`;
    }
  };

  const render = () => {
    const { done, total } = R.progress(state, slugs());
    const warn = account.kind === 'unbound' || account.kind === 'expired' ? '$(warning) ' : '';
    statusBar.text = `${warn}$(flame) Hot100 第${state.round}轮 ${done}/${total}`;
    const synced = state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString() : '从未';
    statusBar.tooltip = [
      `账号：${accountText()}`,
      `本轮开始于 ${new Date(state.startAt).toLocaleString()}`,
      `上次同步：${synced}`,
      '点击随机一道本轮未做的题',
    ].join('\n');
    tree.refresh();
    stats.update(R.summarize(state, problems), {
      round: state.round,
      startAt: state.startAt,
      lastSyncAt: state.lastSyncAt,
      account: accountText(),
    });
  };

  const saveState = async (s: R.RoundState) => {
    state = s;
    await context.globalState.update(STATE_KEY, state);
    render();
  };

  const cookie = () => context.secrets.get(COOKIE_KEY);
  const client = async () => new LeetCodeCn(await cookie());

  const refreshAccount = async (): Promise<Account> => {
    const c = await cookie();
    if (!c) {
      account = { kind: 'unbound' };
    } else {
      try {
        const me = await new LeetCodeCn(c).whoami();
        account = me.signedIn ? { kind: 'bound', username: me.username } : { kind: 'expired' };
      } catch (e) {
        account = { kind: 'unknown', error: errMsg(e) };
      }
    }
    log.appendLine(`账号状态：${accountText()}`);
    render();
    return account;
  };

  const loadProblems = async () => {
    try {
      problems = await (await client()).fetchHot100();
      await context.globalState.update(PROBLEMS_KEY, problems);
      log.appendLine(`拉取 Hot100 列表成功：${problems.length} 题`);
    } catch (e) {
      log.appendLine(`拉取 Hot100 列表失败：${errMsg(e)}`);
      if (problems.length === 0) {
        vscode.window.showErrorMessage(`Hot100 列表拉取失败：${errMsg(e)}`);
      }
    }
    render();
  };

  /** 从提交记录同步本轮 AC 过的题。silent=true 时不弹进度条/成功提示（用于自动同步）。 */
  const sync = async (silent: boolean) => {
    if (syncing) return;
    const c = await cookie();
    if (!c) {
      if (!silent) {
        const pick = await vscode.window.showWarningMessage('还没绑定 leetcode.cn 账号，无法同步提交记录。', '绑定账号');
        if (pick) await vscode.commands.executeCommand('hot100.setCookie');
      }
      return;
    }
    syncing = true;
    const run = async (report: (msg: string) => void) => {
      const api = new LeetCodeCn(c);
      const startAt = state.startAt;
      const before = new Set(state.synced);
      let targets: { slug: string; seen: number }[];
      const last = await api.lastSubmittedAt();
      if (last) {
        // 只统计本轮有提交、且自上次统计后又有新提交的题
        targets = slugs()
          .filter((s) => R.needsRecount(state, s, last.get(s) ?? 0))
          .map((s) => ({ slug: s, seen: last.get(s)! }));
      } else {
        // 拿不到最后提交时间：手动同步全量统计，自动同步只查还没通过的题，避免请求太多
        log.appendLine('userProgressQuestionList 不可用，退化为逐题统计');
        const now = Date.now();
        targets = slugs()
          .filter((s) => !silent || !state.synced.includes(s))
          .map((s) => ({ slug: s, seen: now }));
      }
      const updates: Record<string, R.SlugStat> = {};
      let checked = 0;
      const queue = [...targets];
      const worker = async () => {
        for (let t = queue.shift(); t; t = queue.shift()) {
          updates[t.slug] = { ...(await api.submissionsSince(t.slug, startAt)), seen: t.seen };
          report(`统计提交记录 ${++checked}/${targets.length}`);
        }
      };
      await Promise.all(Array.from({ length: SYNC_CONCURRENCY }, worker));
      // 同步期间如果开了新一轮/改了开始时间，丢弃这次结果
      if (state.startAt !== startAt) return;
      await saveState(R.applyStats(state, updates, Date.now()));
      const added = state.synced.filter((s) => !before.has(s)).length;
      log.appendLine(`同步完成：统计 ${targets.length} 题，新增通过 ${added} 题`);
      if (!silent) {
        const { done, total } = R.progress(state, slugs());
        vscode.window.showInformationMessage(`同步完成，本轮 ${done}/${total}（新增 ${added}）`);
      }
    };
    try {
      if (silent) {
        await run(() => undefined);
      } else {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Hot100 同步中' },
          (p) => run((message) => p.report({ message })),
        );
      }
    } catch (e) {
      log.appendLine(`同步失败：${errMsg(e)}`);
      if (!silent) vscode.window.showErrorMessage(`同步失败：${errMsg(e)}（Cookie 可能已过期）`);
    } finally {
      syncing = false;
    }
  };

  const runner = new Runner(
    client,
    async () => !!(await cookie()),
    async (slug, accepted) => {
      // 本地提交 AC，直接记入本轮；提交次数等后台同步刷新
      if (accepted) await saveState(R.mergeSynced(state, [slug], state.lastSyncAt));
      void sync(true);
    },
    log,
  );
  context.subscriptions.push(
    runner,
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, runner),
  );

  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  const findProblem = (slug: string) => problems.find((p) => p.titleSlug === slug);

  reg('hot100.setCookie', async () => {
    const input = await vscode.window.showInputBox({
      title: '绑定 leetcode.cn 账号',
      prompt: '浏览器登录 leetcode.cn → 开发者工具 → 任一请求的 Request Headers 里复制整段 Cookie（需包含 LEETCODE_SESSION 和 csrftoken）',
      password: true,
      ignoreFocusOut: true,
    });
    if (!input) return;
    const c = input.trim().replace(/^cookie:\s*/i, '');
    if (!c.includes('LEETCODE_SESSION=') || !c.includes('csrftoken=')) {
      vscode.window.showErrorMessage('Cookie 里缺少 LEETCODE_SESSION 或 csrftoken');
      return;
    }
    try {
      const me = await new LeetCodeCn(c).whoami();
      if (!me.signedIn) {
        vscode.window.showErrorMessage('Cookie 无效或已过期：leetcode.cn 显示未登录');
        return;
      }
      await context.secrets.store(COOKIE_KEY, c);
      account = { kind: 'bound', username: me.username };
      render();
      vscode.window.showInformationMessage(`已绑定账号：${me.username}`);
      await sync(false);
    } catch (e) {
      vscode.window.showErrorMessage(`验证 Cookie 失败：${errMsg(e)}`);
    }
  });

  reg('hot100.signOut', async () => {
    await context.secrets.delete(COOKIE_KEY);
    account = { kind: 'unbound' };
    render();
    vscode.window.showInformationMessage('已解绑 leetcode.cn 账号（本轮进度保留）');
  });

  reg('hot100.whoami', async () => {
    const a = await refreshAccount();
    if (a.kind === 'bound') {
      vscode.window.showInformationMessage(accountText());
      return;
    }
    const pick = await vscode.window.showWarningMessage(accountText(), '绑定账号');
    if (pick) await vscode.commands.executeCommand('hot100.setCookie');
  });

  reg('hot100.sync', () => sync(false));

  reg('hot100.openProblem', async (slug: string) => {
    const p = findProblem(slug);
    if (p) await runner.openProblem(p);
  });

  reg('hot100.openInBrowser', (node?: Node) => {
    if (node?.kind === 'problem') void vscode.env.openExternal(vscode.Uri.parse(problemUrl(node.p.titleSlug)));
  });

  reg('hot100.randomPick', async () => {
    if (problems.length === 0) await loadProblems();
    const left = R.remaining(state, slugs());
    const slug = R.pickRandom(left);
    if (!slug) {
      const pick = await vscode.window.showInformationMessage(`第${state.round}轮 Hot100 已全部完成 🎉`, '开始新一轮');
      if (pick) await vscode.commands.executeCommand('hot100.newRound');
      return;
    }
    const p = findProblem(slug)!;
    vscode.window.showInformationMessage(`随机到：${p.frontendId}. ${p.title}（本轮还剩 ${left.length} 题）`);
    await runner.openProblem(p);
  });

  reg('hot100.newRound', async () => {
    const { done, total } = R.progress(state, slugs());
    const ok = await vscode.window.showWarningMessage(
      `结束第${state.round}轮（${done}/${total}），开始第${state.round + 1}轮？本轮之前的提交不再计入。`,
      { modal: true },
      '开始新一轮',
    );
    if (!ok) return;
    await saveState(R.newRound(state, Date.now()));
    vscode.window.showInformationMessage(`第${state.round}轮开始`);
  });

  reg('hot100.setStartAt', async () => {
    const input = await vscode.window.showInputBox({
      title: `设置第${state.round}轮开始时间`,
      prompt: '格式 YYYY-MM-DD 或 YYYY-MM-DD HH:mm（本地时间）。修改后会按新时间重新统计本轮，手动标记保留。',
      value: R.formatLocalDate(state.startAt),
      ignoreFocusOut: true,
      validateInput: (v) => {
        const t = R.parseLocalDate(v);
        if (Number.isNaN(t)) return '格式不对，例如 2026-11-04 或 2026-11-04 09:00';
        if (t > Date.now()) return '开始时间不能晚于现在';
        return undefined;
      },
    });
    if (input === undefined) return;
    await saveState(R.setStartAt(state, R.parseLocalDate(input)));
    log.appendLine(`本轮开始时间改为 ${R.formatLocalDate(state.startAt)}`);
    await sync(false);
  });

  reg('hot100.showStats', () => {
    stats.show();
    render();
  });

  reg('hot100.toggleDone', async (arg?: Node | string) => {
    const slug = typeof arg === 'string' ? arg : arg?.kind === 'problem' ? arg.p.titleSlug : undefined;
    if (slug) await saveState(R.toggle(state, slug));
  });

  reg('hot100.test', (uri?: vscode.Uri) => runner.test(uri, false));
  reg('hot100.testCustom', (uri?: vscode.Uri) => runner.test(uri, true));
  reg('hot100.submit', (uri?: vscode.Uri) => runner.submit(uri));
  reg('hot100.showDescription', (uri?: vscode.Uri) => runner.showDescriptionFor(uri));
  reg('hot100.chooseLanguage', () => runner.chooseLanguage());
  reg('hot100.chooseProblemsDir', () => runner.chooseProblemsDir());

  // 在浏览器里做完题切回 VS Code 时自动同步
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((w) => {
      if (w.focused && Date.now() - state.lastSyncAt > AUTO_SYNC_INTERVAL_MS) void sync(true);
    }),
  );

  await context.globalState.update(STATE_KEY, state);
  render();
  await loadProblems();
  await refreshAccount();
  void sync(true);
}

export function deactivate(): void {}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
