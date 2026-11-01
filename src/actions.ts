import * as vscode from 'vscode';
import {answerQuery, pageHtml, type AskServer} from './preview';
import type {Call, Cancel, FromPage, ShowAction, TaskUpdate} from './webview/protocol';

/**
 * A panel beside the editor with one action's form: the same engine and widgets as the Orkestrator's
 * (`@arkitektio/bsx/ports`), its ports as the server has them, because that is what checks a call.
 * The page holds no token. A call and every read go through the language server.
 */
export class ActionPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private shown: {hash: string; title: string} | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly ask: AskServer,
  ) {}

  async open(hash: string, title: string): Promise<void> {
    this.shown = {hash, title};
    if (this.panel) this.panel.reveal(vscode.ViewColumn.Beside, true);
    else this.panel = this.createPanel();
    this.panel.title = `Run: ${title}`;
    await this.show();
  }

  /** What the language server says a task reported. A task another panel started is nobody's here. */
  onTask(update: Omit<TaskUpdate, 'type'>): void {
    void this.panel?.webview.postMessage({type: 'task', ...update});
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private async show(): Promise<void> {
    if (!this.panel || !this.shown) return;
    const {hash, title} = this.shown;
    const message: ShowAction = {type: 'action', title, hash, action: null};
    try {
      const answer = await this.ask<{action?: unknown; error?: string}>('arkitekt/action', {hash});
      message.action = answer.action ?? null;
      if (answer.error) message.error = answer.error;
    } catch (error) {
      message.error = error instanceof Error ? error.message : String(error);
    }
    await this.panel?.webview.postMessage(message);
  }

  private async call({hash, args, implementation, dependencies}: Call): Promise<void> {
    let answer: {task?: string; error?: string};
    try {
      answer = await this.ask<{task?: string; error?: string}>('arkitekt/call', {
        hash,
        argsJson: JSON.stringify(args),
        implementation,
        dependenciesJson: JSON.stringify(dependencies ?? []),
      });
    } catch (error) {
      answer = {error: error instanceof Error ? error.message : String(error)};
    }
    await this.panel?.webview.postMessage({type: 'called', ...answer});
  }

  private async cancel({task}: Cancel): Promise<void> {
    const answer = await this.ask<{error?: string}>('arkitekt/cancel', {task}).catch((error: unknown) => ({error: String(error)}));
    if (answer.error) void vscode.window.showWarningMessage(`Could not cancel the task: ${answer.error}`);
  }

  private createPanel(): vscode.WebviewPanel {
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel(
      'arkitekt.actionPanel',
      'Run Action',
      {viewColumn: vscode.ViewColumn.Beside, preserveFocus: true},
      // The form holds what was typed, and a running task's events arrive while it may be hidden.
      {enableScripts: true, localResourceRoots: [dist], retainContextWhenHidden: true},
    );
    panel.webview.html = pageHtml(panel.webview, dist);
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'images', 'icon.png');
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.shown = undefined;
    });
    panel.webview.onDidReceiveMessage((message: FromPage) => {
      if (message?.type === 'ready') void this.show();
      if (message?.type === 'query') void answerQuery(panel.webview, message, this.ask);
      if (message?.type === 'call') void this.call(message);
      if (message?.type === 'cancel') void this.cancel(message);
    });
    return panel;
  }
}
