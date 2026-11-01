import {randomBytes} from 'node:crypto';
import * as vscode from 'vscode';
import type {Region, RegionSource} from './bsx';
import type {FromPage, Query, ShowBlok} from './webview/protocol';

type Target = {uri: vscode.Uri; line: number};

/** A request to arkitekt-lsp; rejects while it is not running. */
export type AskServer = <T>(method: string, params: object) => Promise<T>;

/** Whether `arkitekt.server.actions` lets a page reach the server. */
const actionsEnabled = (uri: vscode.Uri): boolean => vscode.workspace.getConfiguration('arkitekt', uri).get<boolean>('server.actions', false);

/** Runs a page's read through the language server, which alone holds a session, and hands it the answer. */
export const answerQuery = async (webview: vscode.Webview, query: Query, ask: AskServer): Promise<void> => {
  const answer = (fields: {data?: Record<string, unknown>; error?: string}) => webview.postMessage({type: 'answer', id: query.id, ...fields});
  try {
    const {service, document, variables} = query;
    await answer(await ask<{data?: Record<string, unknown>; error?: string}>('arkitekt/query', {service, document, variablesJson: JSON.stringify(variables)}));
  } catch (error) {
    await answer({error: error instanceof Error ? error.message : String(error)});
  }
};

/** The page both panels show; what it draws is what it is told next. */
export const pageHtml = (webview: vscode.Webview, dist: vscode.Uri): string => {
  const nonce = randomBytes(16).toString('base64');
  const source = webview.cspSource;
  const uri = (...path: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(dist, ...path)).toString();
  // Styles are inline because a blok's classes are compiled in the page; a scene decodes models with wasm in a worker.
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' 'wasm-unsafe-eval' ${source}`,
    `style-src 'unsafe-inline' ${source}`,
    `img-src ${source} data: blob:`,
    `font-src ${source} data:`,
    `connect-src ${source} data: blob:`,
    'worker-src blob:',
  ].join('; ');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="${uri('webview.css')}" />
  </head>
  <body>
    <div id="root" data-draco="${uri('draco')}/"></div>
    <script nonce="${nonce}" src="${uri('webview.js')}"></script>
  </body>
</html>`;
};

const REFRESH_MS = 120;

const isBsx = (document: vscode.TextDocument): boolean => document.languageId === 'bsx';

/** The region at or nearest to `line`: a literal keeps its place as the document around it changes. */
const nearest = (regions: readonly Region[], line: number): Region | undefined =>
  regions.reduce<Region | undefined>((best, region) => {
    if (!best) return region;
    return Math.abs(region.start.line - line) < Math.abs(best.start.line - line) ? region : best;
  }, undefined);

/** How far edits above `line` moved it. */
const shifted = (line: number, event: vscode.TextDocumentChangeEvent): number =>
  event.contentChanges.reduce((at, change) => {
    if (change.range.end.line >= line) return at;
    const added = change.text.split('\n').length - 1;
    return at + added - (change.range.end.line - change.range.start.line);
  }, line);

/**
 * A panel beside the editor that draws one blok and follows its text as it is typed. Dependencies
 * are unbound and the page refuses every call. With `arkitekt.server.actions` its declared reads and
 * pickers reach the server through the language server, and otherwise it talks to nothing. A webview is
 * the only way to run the renderer that a published extension can use: one inside the editor needs
 * the proposed `createWebviewTextEditorInset`, which the Marketplace refuses.
 */
export class BlokPreview implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private target: Target | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly regions: RegionSource,
    private readonly ask: AskServer,
  ) {
    this.subscriptions = [
      vscode.workspace.onDidChangeTextDocument(event => {
        if (!this.target || event.document.uri.toString() !== this.target.uri.toString()) return;
        this.target.line = shifted(this.target.line, event);
        this.schedule();
      }),
    ];
  }

  /** Draws the blok at `line` of `document`. */
  async open(document: vscode.TextDocument, line: number): Promise<void> {
    this.target = {uri: document.uri, line};
    if (this.panel) this.panel.reveal(vscode.ViewColumn.Beside, true);
    else this.panel = this.createPanel();
    await this.send();
  }

  /** Asks again: a check has finished, so a blok's scope may have changed. */
  refresh(): void {
    if (this.target) this.schedule();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.panel?.dispose();
    this.subscriptions.forEach(subscription => subscription.dispose());
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.send(), REFRESH_MS);
  }

  private async send(): Promise<void> {
    if (!this.panel || !this.target) return;
    const document = await vscode.workspace.openTextDocument(this.target.uri);
    const message = await this.messageFor(document, this.target);
    if (message) {
      this.panel.title = `Preview: ${message.title}`;
      await this.panel.webview.postMessage(message);
    }
  }

  private async messageFor(document: vscode.TextDocument, target: Target): Promise<ShowBlok | undefined> {
    const name = document.uri.path.split('/').pop() ?? 'blok';
    if (isBsx(document)) return {type: 'show', title: name, source: document.getText(), scope: null, live: actionsEnabled(document.uri)};
    const region = nearest(await this.regions(document), target.line);
    // Text that does not tokenize yet can hide every blok for a moment: keep what is drawn.
    if (!region) return undefined;
    target.line = region.start.line;
    return {type: 'show', title: region.blok ?? `${name}:${region.root}`, source: region.value, scope: region.scope ?? null, live: actionsEnabled(document.uri)};
  }

  private createPanel(): vscode.WebviewPanel {
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel(
      'arkitekt.blokPreview',
      'Blok Preview',
      {viewColumn: vscode.ViewColumn.Beside, preserveFocus: true},
      {enableScripts: true, localResourceRoots: [dist]},
    );
    panel.webview.html = pageHtml(panel.webview, dist);
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'images', 'icon.png');
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.target = undefined;
    });
    // The page says when it can listen: when it first loads, and each time it comes back from hidden.
    panel.webview.onDidReceiveMessage((message: FromPage) => {
      if (message?.type === 'ready') void this.send();
      if (message?.type === 'query') void answerQuery(panel.webview, message, this.ask);
    });
    return panel;
  }

}

/** A lens above each blok of a Python document, and at the top of a `.bsx` file. */
export const registerPreview = (
  context: vscode.ExtensionContext,
  regions: RegionSource,
  regionsChanged: vscode.Event<void>,
  ask: AskServer,
): BlokPreview => {
  const preview = new BlokPreview(context.extensionUri, regions, ask);

  const lensOf = (document: vscode.TextDocument, line: number) =>
    new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
      title: '$(open-preview) Preview',
      tooltip: 'Draw this blok beside the editor',
      command: 'arkitekt.previewBlok',
      arguments: [document.uri, line],
    });

  context.subscriptions.push(
    preview,
    vscode.languages.registerCodeLensProvider([{language: 'bsx'}, {language: 'python', scheme: 'file'}], {
      onDidChangeCodeLenses: regionsChanged,
      provideCodeLenses: async document =>
        isBsx(document) ? [lensOf(document, 0)] : (await regions(document)).map(region => lensOf(document, region.start.line)),
    }),
    vscode.commands.registerCommand('arkitekt.previewBlok', async (uri?: vscode.Uri, line?: number) => {
      // From the palette: the blok the cursor is in or nearest to.
      const editor = vscode.window.activeTextEditor;
      const document = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
      if (!document || (!isBsx(document) && !nearest(await regions(document), 0))) {
        void vscode.window.showInformationMessage('Open a .bsx file, or a Python file with a blok, to preview it.');
        return;
      }
      await preview.open(document, line ?? editor?.selection.active.line ?? 0);
    }),
  );
  return preview;
};
