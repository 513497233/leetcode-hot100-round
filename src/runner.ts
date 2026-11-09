import * as vscode from 'vscode';
import { LeetCodeCn, Problem, QuestionDetail, problemUrl } from './api';
import * as S from './solution';

/** 本地写题：生成题解文件、展示题面、云端测试、提交。 */
export class Runner implements vscode.CodeLensProvider {
  private readonly details = new Map<string, QuestionDetail>();
  private readonly results = vscode.window.createOutputChannel('Hot100 结果');
  private descPanel: vscode.WebviewPanel | undefined;
  /** 题面页当前对应的本地题解文件，页面上的测试/提交按钮作用于它 */
  private descFile: vscode.Uri | undefined;
  private busy = false;

  constructor(
    private readonly client: () => Promise<LeetCodeCn>,
    private readonly hasCookie: () => Promise<boolean>,
    private readonly onSubmitted: (slug: string, accepted: boolean) => Promise<void>,
    private readonly log: vscode.OutputChannel,
  ) {}

  dispose(): void {
    this.results.dispose();
    this.descPanel?.dispose();
  }

  // ---------- 题解文件 ----------

  private async detail(slug: string): Promise<QuestionDetail> {
    const cached = this.details.get(slug);
    if (cached) return cached;
    const d = await (await this.client()).questionDetail(slug);
    this.details.set(slug, d);
    return d;
  }

  private config() {
    return vscode.workspace.getConfiguration('hot100');
  }

  async chooseLanguage(): Promise<S.Lang | undefined> {
    const current = this.config().get<string>('language');
    const pick = await vscode.window.showQuickPick(
      S.LANGS.map((l) => ({ label: l.name, description: l.slug === current ? '当前' : undefined, lang: l })),
      { title: '选择刷题语言' },
    );
    if (!pick) return undefined;
    await this.config().update('language', pick.lang.slug, vscode.ConfigurationTarget.Global);
    return pick.lang;
  }

  private async language(): Promise<S.Lang | undefined> {
    const slug = this.config().get<string>('language');
    return S.LANGS.find((l) => l.slug === slug) ?? (await this.chooseLanguage());
  }

  async chooseProblemsDir(): Promise<vscode.Uri | undefined> {
    const picked = await vscode.window.showOpenDialog({
      title: '选择存放题解文件的目录',
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    if (!picked?.[0]) return undefined;
    await this.config().update('problemsDir', picked[0].fsPath, vscode.ConfigurationTarget.Global);
    return picked[0];
  }

  private async problemsDir(): Promise<vscode.Uri | undefined> {
    const dir = this.config().get<string>('problemsDir');
    return dir ? vscode.Uri.file(dir) : await this.chooseProblemsDir();
  }

  /** 打开（必要时创建）本地题解文件，并在旁边显示题面。 */
  async openProblem(p: Problem): Promise<void> {
    try {
      const lang = await this.language();
      if (!lang) return;
      const dir = await this.problemsDir();
      if (!dir) return;
      const file = vscode.Uri.joinPath(dir, S.fileName(p.frontendId, p.titleSlug, lang));
      const d = await this.detail(p.titleSlug);
      if (!(await exists(file))) {
        const snippet = d.snippets.find((s) => s.langSlug === lang.slug)?.code;
        if (snippet === undefined) {
          vscode.window.showErrorMessage(`这道题不支持 ${lang.name}`);
          return;
        }
        const content = S.initialContent(lang, `${d.frontendId}. ${d.title}`, problemUrl(p.titleSlug), snippet);
        await vscode.workspace.fs.createDirectory(dir);
        await vscode.workspace.fs.writeFile(file, Buffer.from(content, 'utf8'));
        this.log.appendLine(`创建题解文件 ${file.fsPath}`);
      }
      const doc = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
      this.showDescription(d, file);
    } catch (e) {
      vscode.window.showErrorMessage(`打开题目失败：${errMsg(e)}`);
    }
  }

  showDescription(d: QuestionDetail, file: vscode.Uri): void {
    if (!this.descPanel) {
      this.descPanel = vscode.window.createWebviewPanel(
        'hot100.description',
        '题面',
        { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
        // 只允许带 nonce 的自有脚本，题面 HTML 里的脚本不会执行
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this.descPanel.onDidDispose(() => (this.descPanel = undefined));
      this.descPanel.webview.onDidReceiveMessage((m: { cmd?: string }) => {
        const f = this.descFile;
        if (!f) return;
        if (m.cmd === 'test') void this.test(f, false);
        else if (m.cmd === 'testCustom') void this.test(f, true);
        else if (m.cmd === 'submit') void this.submit(f);
        else if (m.cmd === 'openFile') void vscode.window.showTextDocument(f, { viewColumn: vscode.ViewColumn.One });
        else if (m.cmd === 'browser') {
          const parsed = S.parseFileName(f.path.split('/').pop() ?? '');
          if (parsed) void vscode.env.openExternal(vscode.Uri.parse(problemUrl(parsed.slug)));
        }
      });
    }
    this.descFile = file;
    this.descPanel.title = `${d.frontendId}. ${d.title}`;
    this.descPanel.webview.html = descriptionHtml(d, file.path.split('/').pop() ?? '', nonce());
    this.descPanel.reveal(vscode.ViewColumn.Two, true);
  }

  async showDescriptionFor(uri?: vscode.Uri): Promise<void> {
    const target = await this.resolveTarget(uri, false);
    if (!target) return;
    try {
      this.showDescription(await this.detail(target.slug), target.uri);
    } catch (e) {
      vscode.window.showErrorMessage(`获取题面失败：${errMsg(e)}`);
    }
  }

  // ---------- 测试 / 提交 ----------

  /** 解析要测试/提交的文件：命令参数里的 uri，否则当前编辑器。会先保存文件。 */
  private async resolveTarget(uri: vscode.Uri | undefined, save: boolean) {
    const doc = uri
      ? await vscode.workspace.openTextDocument(uri)
      : vscode.window.activeTextEditor?.document;
    if (!doc) {
      vscode.window.showErrorMessage('没有打开的题解文件');
      return undefined;
    }
    const name = doc.uri.path.split('/').pop() ?? '';
    const parsed = S.parseFileName(name);
    if (!parsed) {
      vscode.window.showErrorMessage(`不是 Hot100 题解文件：${name}（文件名需形如 1.two-sum.cpp）`);
      return undefined;
    }
    if (save && doc.isDirty) await doc.save();
    return { ...parsed, uri: doc.uri, code: S.extractCode(doc.getText()) };
  }

  private async ensureBound(): Promise<boolean> {
    if (await this.hasCookie()) return true;
    const pick = await vscode.window.showWarningMessage('测试和提交需要先绑定 leetcode.cn 账号。', '绑定账号');
    if (pick) await vscode.commands.executeCommand('hot100.setCookie');
    return this.hasCookie();
  }

  async test(uri: vscode.Uri | undefined, custom: boolean): Promise<void> {
    await this.judge(uri, 'test', custom);
  }

  async submit(uri: vscode.Uri | undefined): Promise<void> {
    await this.judge(uri, 'submit', false);
  }

  private async judge(uri: vscode.Uri | undefined, mode: 'test' | 'submit', custom: boolean): Promise<void> {
    if (this.busy) {
      vscode.window.showInformationMessage('上一次测试/提交还没结束');
      return;
    }
    const target = await this.resolveTarget(uri, true);
    if (!target || !(await this.ensureBound())) return;
    this.busy = true;
    try {
      const api = await this.client();
      const d = await this.detail(target.slug);
      let dataInput = d.exampleTestcases;
      if (mode === 'test' && custom) {
        const input = await vscode.window.showInputBox({
          title: '自定义测试用例',
          prompt: '每个参数一行，用 \\n 分隔；多组用例直接接着写',
          value: dataInput.replace(/\n/g, '\\n'),
          ignoreFocusOut: true,
        });
        if (input === undefined) return;
        dataInput = input.replace(/\\n/g, '\n');
      }
      const label = mode === 'test' ? '云端测试' : '提交';
      const verdict = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `${label} ${d.frontendId}. ${d.title}` },
        async (progress) => {
          progress.report({ message: '发送中…' });
          const tick = (n: number) => progress.report({ message: `判题中…${n}s` });
          if (mode === 'test') {
            const id = await api.runTest(target.slug, d.questionId, target.lang.slug, target.code, dataInput);
            return S.formatTest(await api.waitResult<S.CheckResult>(id, target.slug, tick), dataInput);
          }
          const id = await api.submit(target.slug, d.questionId, target.lang.slug, target.code);
          const r = await api.waitResult<S.CheckResult>(id, target.slug, tick);
          await this.onSubmitted(target.slug, r.status_code === 10);
          return S.formatSubmit(r);
        },
      );
      this.results.clear();
      this.results.appendLine(`${d.frontendId}. ${d.title}  [${target.lang.name}]  ${new Date().toLocaleString()}`);
      this.results.appendLine(verdict.detail);
      this.results.show(true);
      if (verdict.ok) vscode.window.showInformationMessage(verdict.summary);
      else vscode.window.showWarningMessage(verdict.summary);
    } catch (e) {
      this.log.appendLine(`${mode} 失败：${errMsg(e)}`);
      vscode.window.showErrorMessage(`${mode === 'test' ? '测试' : '提交'}失败：${errMsg(e)}`);
    } finally {
      this.busy = false;
    }
  }

  // ---------- CodeLens：在代码上方显示 测试 / 提交 按钮 ----------

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const name = doc.uri.path.split('/').pop() ?? '';
    if (!S.parseFileName(name)) return [];
    let line = 0;
    for (let i = 0; i < doc.lineCount; i++) {
      if (doc.lineAt(i).text.includes(S.CODE_START)) {
        line = i;
        break;
      }
    }
    const range = new vscode.Range(line, 0, line, 0);
    const args = [doc.uri];
    return [
      new vscode.CodeLens(range, { title: '$(beaker) 测试', command: 'hot100.test', arguments: args }),
      new vscode.CodeLens(range, { title: '$(edit) 自定义用例测试', command: 'hot100.testCustom', arguments: args }),
      new vscode.CodeLens(range, { title: '$(cloud-upload) 提交', command: 'hot100.submit', arguments: args }),
      new vscode.CodeLens(range, { title: '$(book) 题面', command: 'hot100.showDescription', arguments: args }),
    ];
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function descriptionHtml(d: QuestionDetail, fileName: string, n: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.6; padding: 0 16px 24px; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 8px 12px; border-radius: 4px; white-space: pre-wrap; }
  code { font-family: var(--vscode-editor-font-family); }
  img { max-width: 100%; }
  .bar { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
         padding: 8px 0; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.25)); }
  button { border: none; border-radius: 3px; padding: 4px 12px; cursor: pointer;
           background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  .file { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: .9em; cursor: pointer; }
</style></head>
<body>
  <div class="bar">
    <button data-cmd="test">▶ 测试</button>
    <button data-cmd="testCustom">自定义用例测试</button>
    <button class="primary" data-cmd="submit">⬆ 提交</button>
    <button data-cmd="browser">在浏览器打开</button>
    <span class="file" data-cmd="openFile" title="跳到题解文件">${escapeHtml(fileName)}</span>
  </div>
  <h2>${escapeHtml(`${d.frontendId}. ${d.title}`)}</h2>${d.content}
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  document.querySelector('.bar').addEventListener('click', (e) => {
    const t = e.target.closest('[data-cmd]');
    if (t) vscode.postMessage({ cmd: t.dataset.cmd });
  });
</script>
</body></html>`;
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
