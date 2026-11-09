import * as vscode from 'vscode';
import { Problem } from './api';
import { RoundState, isDone } from './round';

type Node = { kind: 'group'; name: string; items: Problem[] } | { kind: 'problem'; p: Problem };

const DIFF: Record<string, string> = { EASY: '简单', MEDIUM: '中等', HARD: '困难' };

export class ProblemTree implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly getData: () => { problems: Problem[]; state: RoundState }) {}

  refresh(): void {
    this.emitter.fire();
  }

  getChildren(node?: Node): Node[] {
    const { problems } = this.getData();
    if (!node) {
      const groups = new Map<string, Problem[]>();
      for (const p of problems) {
        if (!groups.has(p.group)) groups.set(p.group, []);
        groups.get(p.group)!.push(p);
      }
      return [...groups].map(([name, items]) => ({ kind: 'group', name, items }));
    }
    return node.kind === 'group' ? node.items.map((p) => ({ kind: 'problem', p })) : [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const { state } = this.getData();
    if (node.kind === 'group') {
      const done = node.items.filter((p) => isDone(state, p.titleSlug)).length;
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${done}/${node.items.length}`;
      return item;
    }
    const { p } = node;
    const done = isDone(state, p.titleSlug);
    const item = new vscode.TreeItem(`${p.frontendId}. ${p.title}`, vscode.TreeItemCollapsibleState.None);
    const manual = state.overrides[p.titleSlug] ? ' · 手动' : '';
    item.description = `${DIFF[p.difficulty] ?? p.difficulty}${manual}`;
    item.iconPath = new vscode.ThemeIcon(done ? 'pass-filled' : 'circle-large-outline');
    item.contextValue = 'problem';
    item.tooltip = done ? '本轮已完成（右侧按钮可切换）' : '本轮未完成（右侧按钮可切换）';
    item.command = { command: 'hot100.openProblem', title: '打开题目', arguments: [p.titleSlug] };
    return item;
  }
}

export type { Node };
