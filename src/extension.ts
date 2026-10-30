import * as vscode from 'vscode';
import {LanguageClient, State, type LanguageClientOptions, type ServerOptions} from 'vscode-languageclient/node';
import {registerBsx, type Region} from './bsx';
import {findServer, serverSettings} from './server';

type WireRegion = Omit<Region, 'start' | 'end'> & {
  start: {line: number; character: number};
  end: {line: number; character: number};
};

type Status = {state: 'checking' | 'ok' | 'failed'; app: string; errors?: number; warnings?: number; message?: string | null};

type RekuestStatus = {state: 'connecting' | 'login' | 'connected' | 'offline' | 'off'; url: string; message?: string | null};

let client: LanguageClient | undefined;

const regionCache = new Map<string, {version: number; regions: readonly Region[]}>();

/** The blok literals of a Python document, from arkitekt-lsp; none while it is not running. */
const regionsOf = async (document: vscode.TextDocument): Promise<readonly Region[]> => {
  const key = document.uri.toString();
  const cached = regionCache.get(key);
  if (cached && cached.version === document.version) return cached.regions;
  if (!client || client.state !== State.Running) return [];
  try {
    const answer = await client.sendRequest<{regions: WireRegion[]}>('bsx/regions', {textDocument: {uri: key}});
    const regions = answer.regions.map(region => ({
      ...region,
      start: new vscode.Position(region.start.line, region.start.character),
      end: new vscode.Position(region.end.line, region.end.character),
    }));
    regionCache.set(key, {version: document.version, regions});
    return regions;
  } catch {
    return [];
  }
};

const showStatus = (item: vscode.StatusBarItem, status: Status) => {
  const counts = [status.errors ? `$(error) ${status.errors}` : '', status.warnings ? `$(warning) ${status.warnings}` : ''].filter(Boolean).join(' ');
  if (status.state === 'checking') item.text = `$(sync~spin) ${status.app}`;
  else if (status.state === 'ok') item.text = `$(check) ${status.app}${counts ? ` ${counts}` : ''}`;
  else item.text = `$(error) ${status.app}${counts ? ` ${counts}` : ''}`;
  item.tooltip = status.message ?? (status.state === 'checking' ? 'arkitekt check is running' : 'arkitekt check: click to check again');
  item.show();
};

const showRekuest = (item: vscode.StatusBarItem, status: RekuestStatus) => {
  if (status.state === 'off') {
    item.hide();
    return;
  }
  const icon = {connecting: '$(sync~spin)', login: '$(key)', connected: '$(plug)', offline: '$(debug-disconnect)'}[status.state];
  item.text = `${icon} rekuest`;
  item.tooltip = status.message ?? `${status.url}: ${status.state === 'connected' ? 'read-only, click to ask again' : status.state}`;
  item.show();
};

const start = async (context: vscode.ExtensionContext, output: vscode.OutputChannel, item: vscode.StatusBarItem, rekuest: vscode.StatusBarItem) => {
  if (client) return;
  const folder = vscode.workspace.workspaceFolders?.[0];
  const command = await findServer(folder);
  if (!command) {
    item.text = '$(circle-slash) arkitekt-lsp';
    item.tooltip = "No arkitekt-lsp in the app's environment: add it there (uv add --dev arkitekt-lsp), or set arkitekt.lsp.path.";
    item.show();
    return;
  }
  const serverOptions: ServerOptions = {command, args: ['--stdio'], options: {cwd: folder?.uri.fsPath}};
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{language: 'python', scheme: 'file'}],
    initializationOptions: serverSettings(folder),
    synchronize: {configurationSection: 'arkitekt'},
    outputChannel: output,
  };
  client = new LanguageClient('arkitekt', 'Arkitekt', serverOptions, clientOptions);
  context.subscriptions.push(
    client.onNotification('arkitekt/status', (status: Status) => showStatus(item, status)),
    client.onNotification('arkitekt/rekuest', (status: RekuestStatus) => showRekuest(rekuest, status)),
  );
  output.appendLine(`Starting ${command}`);
  await client.start();
};

export const activate = async (context: vscode.ExtensionContext): Promise<void> => {
  const output = vscode.window.createOutputChannel('Arkitekt');
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  item.command = 'arkitekt.check';
  const rekuest = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9);
  rekuest.command = 'arkitekt.rekuest.refresh';
  context.subscriptions.push(output, item, rekuest);

  registerBsx(context, regionsOf);

  context.subscriptions.push(
    vscode.commands.registerCommand('arkitekt.check', async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (!client || client.state !== State.Running) {
        void vscode.window.showInformationMessage('arkitekt-lsp is not running: checking needs a trusted workspace and arkitekt-lsp in the app\'s environment.');
        return;
      }
      if (!document || document.languageId !== 'python') {
        void vscode.window.showInformationMessage('Open a Python file of the app to check it.');
        return;
      }
      await client.sendNotification('arkitekt/check', {textDocument: {uri: document.uri.toString()}});
    }),
    vscode.commands.registerCommand('arkitekt.restart', async () => {
      if (client) await client.restart();
      else await start(context, output, item, rekuest);
    }),
    vscode.commands.registerCommand('arkitekt.rekuest.refresh', async () => {
      if (client?.state === State.Running) await client.sendNotification('arkitekt/rekuest/refresh', {});
    }),
    vscode.commands.registerCommand('arkitekt.showOutput', () => output.show()),
    vscode.workspace.onDidCloseTextDocument(document => regionCache.delete(document.uri.toString())),
  );

  // The server imports the app to check it: only a trusted workspace runs it.
  if (vscode.workspace.isTrusted) await start(context, output, item, rekuest);
  else context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => void start(context, output, item, rekuest)));
};

export const deactivate = async (): Promise<void> => {
  await client?.stop();
  client = undefined;
};
