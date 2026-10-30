import * as vscode from 'vscode';

export type RekuestStatus = {state: 'connecting' | 'login' | 'connected' | 'offline' | 'off'; url: string; message?: string | null};

export type Challenge = {url: string; code: string; link: string; expiresIn: number};

type Server = {
  running(): boolean;
  notify(method: string, params: object): Promise<void>;
  request<T>(method: string, params: object): Promise<T>;
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Writes where the setting already is: a workspace's value would outrank one written globally. */
const write = async (key: string, value: unknown, folder: vscode.WorkspaceFolder | undefined): Promise<void> => {
  const config = vscode.workspace.getConfiguration('arkitekt', folder);
  const seen = config.inspect(key);
  // These settings hold per window, so never per folder: in a window of one folder, a value in its
  // .vscode/settings.json reads as the folder's, and Workspace is how to write it.
  const inWorkspace = seen?.workspaceValue !== undefined || seen?.workspaceFolderValue !== undefined;
  await config.update(key, value, inWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
};

/**
 * The read-only login at a coordination server, started from the editor. Logged in is a setting
 * (`arkitekt.server.connect`), so it holds across restarts; the login itself is the server's, this
 * shows it. The status item is the way in: nothing here talks to anyone until it is asked to.
 */
export class RekuestLogin {
  private status: RekuestStatus = {state: 'off', url: ''};
  private challenge: Challenge | undefined;
  /** The user just asked for this: their browser may open, and they are told how it ended. */
  private asked = false;
  private endProgress: (() => void) | undefined;

  constructor(
    private readonly item: vscode.StatusBarItem,
    private readonly server: Server,
    private readonly folder: () => vscode.WorkspaceFolder | undefined,
  ) {}

  get connected(): boolean {
    return this.status.state === 'connected';
  }

  private get url(): string {
    return vscode.workspace.getConfiguration('arkitekt', this.folder()).get<string>('server.url', '') || 'https://go.arkitekt.live';
  }

  /** The server is up, with no connection unless the settings say so and it says otherwise. */
  reset(): void {
    this.endProgress?.();
    this.challenge = undefined;
    this.onStatus({state: 'off', url: this.url});
  }

  onStatus(status: RekuestStatus): void {
    this.status = status;
    this.draw();
    if (status.state === 'connecting' || status.state === 'login') return;
    this.endProgress?.();
    this.challenge = undefined;
    // Off on its own says nothing about what was asked: moving to another server passes through it.
    if (status.state === 'off' || !this.asked) return;
    this.asked = false;
    if (status.state === 'connected') {
      void vscode.window.showInformationMessage(`Arkitekt: logged in to ${hostOf(status.url)}, read-only.`);
    } else if (status.state === 'offline') {
      void vscode.window.showErrorMessage(`Arkitekt: could not log in to ${hostOf(status.url)}: ${status.message ?? 'no answer'}`, 'Try Again').then(choice => {
        if (choice) void this.logIn();
      });
    }
  }

  onChallenge(challenge: Challenge): void {
    this.challenge = challenge;
    this.draw();
    if (this.asked) {
      void this.approve(challenge);
      return;
    }
    // Not asked for just now: a login that ended. The browser opens only on a click.
    void vscode.window.showInformationMessage(`Arkitekt: log in to ${hostOf(challenge.url)} again to see who satisfies your dependencies.`, 'Log In', 'Not Now').then(choice => {
      if (choice === 'Log In') {
        this.asked = true;
        void this.approve(challenge);
      } else if (choice === 'Not Now') {
        void this.cancel();
      }
    });
  }

  private async approve(challenge: Challenge): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(challenge.link));
    this.endProgress?.();
    void vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Arkitekt: approve code ${challenge.code} in your browser`,
        cancellable: true,
      },
      (_, cancelled) =>
        new Promise<void>(resolve => {
          this.endProgress = () => {
            this.endProgress = undefined;
            resolve();
          };
          cancelled.onCancellationRequested(() => void this.cancel());
        }),
    );
  }

  async logIn(url?: string): Promise<void> {
    if (!this.server.running()) {
      void vscode.window.showInformationMessage("arkitekt-lsp is not running: logging in needs a trusted workspace and arkitekt-lsp in the app's environment.");
      return;
    }
    this.asked = true;
    const folder = this.folder();
    // The url first: moved the other way round, the server would start out for the old one.
    if (url) await write('server.url', url, folder);
    await write('server.connect', true, folder);
    await this.server.notify('arkitekt/rekuest/login', url ? {url} : {});
  }

  /** Stops waiting for an approval: the code simply runs out, there is no login to end. */
  async cancel(): Promise<void> {
    this.asked = false;
    this.endProgress?.();
    await write('server.connect', false, this.folder());
  }

  async logOut(): Promise<void> {
    this.asked = false;
    const url = this.status.url || this.url;
    try {
      await this.server.request('arkitekt/rekuest/logout', {});
    } catch {
      // A server too old to know about it: what it holds runs out by itself.
    }
    await write('server.connect', false, this.folder());
    void vscode.window.showInformationMessage(`Arkitekt: logged out of ${hostOf(url)}.`);
  }

  private async otherServer(): Promise<void> {
    const url = await vscode.window.showInputBox({
      title: 'Log in to which coordination server?',
      value: this.url,
      validateInput: value => (/^https?:\/\/\S+$/.test(value.trim()) ? undefined : 'A url, with http:// or https://'),
    });
    if (url) await this.logIn(url.trim());
  }

  /** What the status item offers, by how things stand. */
  async menu(): Promise<void> {
    const {state} = this.status;
    const host = hostOf(this.status.url || this.url);
    type Choice = vscode.QuickPickItem & {run(): unknown};
    const choices: Choice[] = [];
    if (state === 'connected') {
      choices.push(
        {label: '$(add) Add a Dependency…', description: 'browse the agents', run: () => vscode.commands.executeCommand('arkitekt.addDependency')},
        {label: '$(refresh) Ask Again', description: 'who satisfies each dependency', run: () => this.server.notify('arkitekt/rekuest/refresh', {})},
        {label: '$(sign-out) Log Out', description: host, run: () => this.logOut()},
        {label: '$(server) Log In to Another Server…', run: () => this.otherServer()},
      );
    } else if (state === 'connecting' || state === 'login') {
      const challenge = this.challenge;
      if (challenge) {
        choices.push(
          {label: '$(link-external) Open the Approval Page', run: () => vscode.env.openExternal(vscode.Uri.parse(challenge.link))},
          {label: `$(copy) Copy the Code ${challenge.code}`, run: () => vscode.env.clipboard.writeText(challenge.code)},
        );
      }
      choices.push({label: '$(close) Cancel', run: () => this.cancel()});
    } else {
      choices.push(
        {label: `$(sign-in) Log In to ${host}`, description: 'read-only', run: () => this.logIn()},
        {label: '$(server) Log In to Another Server…', run: () => this.otherServer()},
      );
    }
    const chosen = await vscode.window.showQuickPick(choices, {title: `Arkitekt: ${this.status.message ?? host}`});
    await chosen?.run();
  }

  private draw(): void {
    const {state, url, message} = this.status;
    const host = hostOf(url || this.url);
    const look = {
      off: ['$(account) Log In', `Local only. Click to log in to ${host}, read-only, and see who satisfies your dependencies.`],
      connecting: ['$(sync~spin) Arkitekt', `Connecting to ${host}`],
      login: ['$(key) Approve Login', this.challenge ? `Approve code ${this.challenge.code} in your browser` : `Approve this editor at ${host}`],
      connected: ['$(plug) Arkitekt', `Logged in to ${host}, read-only`],
      offline: ['$(debug-disconnect) Arkitekt', `${host}: ${message ?? 'no answer'}. Local checks still work.`],
    }[state];
    [this.item.text, this.item.tooltip] = look;
    this.item.show();
  }
}
