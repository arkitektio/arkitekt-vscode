import * as vscode from 'vscode';

type Action = {key: string; name?: string | null; signature: string; missing: string[]};
type State = {key: string; missing: string[]};
type Agent = {id: string; name: string; connected: boolean; app?: string | null; version?: string | null; className: string; actions: Action[]; states: State[]};

type Server = {request<T>(method: string, params: object): Promise<T>};

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Search covers the detail too, so typing an action's name finds every agent that offers it. */
const pickAgent = (agents: () => Promise<Agent[]>): Promise<Agent | undefined> =>
  new Promise(resolve => {
    const pick = vscode.window.createQuickPick<vscode.QuickPickItem & {agent: Agent}>();
    pick.title = 'Add a dependency: which agent?';
    pick.placeholder = 'Search by agent, app, action or state';
    pick.matchOnDescription = true;
    pick.matchOnDetail = true;
    pick.busy = true;
    let settled = false;
    const finish = (agent: Agent | undefined) => {
      if (settled) return;
      settled = true;
      resolve(agent);
      pick.hide();
      pick.dispose();
    };
    pick.onDidAccept(() => finish(pick.selectedItems[0]?.agent));
    pick.onDidHide(() => finish(undefined));
    pick.show();
    agents().then(
      found => {
        pick.items = [...found]
          .sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name))
          .map(agent => ({
            agent,
            label: `$(${agent.connected ? 'circle-filled' : 'circle-outline'}) ${agent.name}`,
            description: agent.app ? `${agent.app}${agent.version ? `@${agent.version}` : ''}` : undefined,
            detail: `${plural(agent.actions.length, 'action')}, ${plural(agent.states.length, 'state')}: ${[...agent.actions, ...agent.states].map(offer => offer.key).join(', ')}`,
          }));
        pick.busy = false;
        if (found.length === 0) pick.placeholder = 'No agents on this server';
      },
      (error: unknown) => {
        finish(undefined);
        void vscode.window.showErrorMessage(`Arkitekt: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  });

const needs = (missing: string[]): string | undefined => (missing.length ? `needs ${missing.join(', ')}: added as a comment` : undefined);

/** Pick an agent, tick what it offers, name the class: the code goes into the file and is checked. */
export const addDependency = async (server: Server, connected: () => boolean, logIn: () => Promise<void>): Promise<void> => {
  if (!connected()) {
    const choice = await vscode.window.showInformationMessage('Arkitekt: log in first, to see which agents there are.', 'Log In');
    if (choice) await logIn();
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'python') {
    void vscode.window.showInformationMessage('Arkitekt: open the Python file that declares your app.');
    return;
  }
  const uri = editor.document.uri.toString();
  const agent = await pickAgent(async () => {
    const answer = await server.request<{agents?: Agent[]; error?: string}>('arkitekt/rekuest/offers', {uri});
    if (answer.error) throw new Error(answer.error);
    return answer.agents ?? [];
  });
  if (!agent) return;

  type Item = vscode.QuickPickItem & {action?: string; state?: string};
  const offered: Item[] = [
    ...agent.actions.map(action => ({
      action: action.key,
      label: `$(symbol-method) ${action.signature}`,
      description: needs(action.missing) ?? action.name ?? undefined,
    })),
    ...agent.states.map(state => ({state: state.key, label: `$(symbol-field) ${state.key}`, description: needs(state.missing) ?? 'state'})),
  ];
  if (offered.length === 0) {
    void vscode.window.showInformationMessage(`Arkitekt: ${agent.name} offers no actions or states.`);
    return;
  }
  const picked = await vscode.window.showQuickPick(offered, {
    title: `Add a dependency: what do you need from ${agent.name}?`,
    placeHolder: 'Search, and tick what your app calls or reads',
    canPickMany: true,
    matchOnDescription: true,
  });
  if (!picked?.length) return;

  const className = await vscode.window.showInputBox({
    title: 'Add a dependency: name its class',
    value: agent.className,
    validateInput: value => (/^[A-Za-z_]\w*$/.test(value) ? undefined : 'A Python class name'),
  });
  if (!className) return;

  const answer = await server.request<{line?: number; error?: string}>('arkitekt/rekuest/declare', {
    uri,
    agent: agent.id,
    className,
    actions: picked.flatMap(item => (item.action ? [item.action] : [])),
    states: picked.flatMap(item => (item.state ? [item.state] : [])),
  });
  if (answer.error) {
    void vscode.window.showErrorMessage(`Arkitekt: ${answer.error}`);
    return;
  }
  const position = new vscode.Position(answer.line ?? 0, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  // Saving is what checks it, and the check is what puts the count above it.
  await editor.document.save();
};
