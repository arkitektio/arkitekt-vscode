import * as vscode from 'vscode';

type Server = {request: <T>(method: string, params: object) => Promise<T>};
type App = {target: string; file: string; line: number; project: string};

/** Check again, or choose the app: helper files follow the choice, and its file opens to be checked. */
export const chooseApp = async (server: Server, check: () => Thenable<unknown>): Promise<void> => {
  let answer: {apps: App[]; target: string | null};
  try {
    answer = await server.request('arkitekt/apps', {});
  } catch {
    void vscode.window.showErrorMessage('Arkitekt: choosing an app needs arkitekt-lsp 1.2 or newer in the app\'s environment.');
    return;
  }
  const current = (target: string | null): string | undefined => (target === answer.target ? 'current' : undefined);
  const projects = new Set(answer.apps.map(app => app.project));

  type Item = vscode.QuickPickItem & {run?: () => Thenable<unknown>; app?: App; clears?: boolean};
  const items: Item[] = [
    {label: '$(sync) Check Again', run: check},
    {label: 'Apps', kind: vscode.QuickPickItemKind.Separator},
    ...answer.apps.map(app => ({
      app,
      label: app.target,
      description: [current(app.target), projects.size > 1 ? vscode.workspace.asRelativePath(app.project) : undefined].filter(Boolean).join(' · ') || undefined,
    })),
    {label: '$(circle-slash) Default', description: current(null) ?? 'ARKITEKT_APP, else app.py', clears: true},
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Which app?',
    placeHolder: answer.apps.length ? 'Search the apps of this workspace' : 'No file in this workspace declares an App',
    matchOnDescription: true,
  });
  if (!picked) return;
  if (picked.run) {
    await picked.run();
    return;
  }

  // The language client reads settings without a folder: a folder's own value would never reach the server.
  const target = picked.app?.target ?? '';
  await vscode.workspace.getConfiguration('arkitekt').update('target', target, vscode.ConfigurationTarget.Workspace);
  if (picked.app) {
    const position = new vscode.Position(picked.app.line, 0);
    await vscode.window.showTextDocument(vscode.Uri.file(picked.app.file), {selection: new vscode.Range(position, position)});
  }
};
