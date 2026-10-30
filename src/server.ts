import {existsSync} from 'node:fs';
import {delimiter, dirname, isAbsolute, join} from 'node:path';
import * as vscode from 'vscode';

const EXECUTABLE = process.platform === 'win32' ? 'arkitekt-lsp.exe' : 'arkitekt-lsp';
const BIN = process.platform === 'win32' ? 'Scripts' : 'bin';

type PythonExtension = {
  environments?: {getActiveEnvironmentPath(resource?: vscode.Uri): {path: string}};
};

/** The Python extension's interpreter for `folder`, if it is installed and has one. */
const selectedInterpreter = async (folder: vscode.WorkspaceFolder | undefined): Promise<string | undefined> => {
  const extension = vscode.extensions.getExtension<PythonExtension>('ms-python.python');
  if (!extension) return undefined;
  try {
    const api = extension.isActive ? extension.exports : await extension.activate();
    return api.environments?.getActiveEnvironmentPath(folder?.uri).path;
  } catch {
    return undefined;
  }
};

/**
 * Where `arkitekt-lsp` is: the `arkitekt.lsp.path` setting, the workspace's `.venv`, next to the
 * Python extension's interpreter, or on PATH. It has to be the app's own environment: the server
 * imports the app to check it.
 */
export const findServer = async (folder: vscode.WorkspaceFolder | undefined): Promise<string | undefined> => {
  const configured = vscode.workspace.getConfiguration('arkitekt', folder).get<string>('lsp.path')?.trim();
  if (configured) return isAbsolute(configured) || !folder ? configured : join(folder.uri.fsPath, configured);
  const candidates: string[] = [];
  if (folder) candidates.push(join(folder.uri.fsPath, '.venv', BIN, EXECUTABLE));
  const interpreter = await selectedInterpreter(folder);
  if (interpreter) candidates.push(join(dirname(interpreter), EXECUTABLE));
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory) candidates.push(join(directory, EXECUTABLE));
  }
  return candidates.find(candidate => existsSync(candidate));
};

/** What the server is told it is configured with: the `arkitekt` section, as it reads it. */
export const serverSettings = (folder: vscode.WorkspaceFolder | undefined): Record<string, unknown> => {
  const config = vscode.workspace.getConfiguration('arkitekt', folder);
  return {
    check: {onSave: config.get<boolean>('check.onSave', true), timeout: config.get<number>('check.timeout', 120)},
    target: config.get<string>('target', '') || null,
    server: {connect: config.get<boolean>('server.connect', false), url: config.get<string>('server.url', '')},
  };
};
