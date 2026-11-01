/** A blok to draw. `live`: a read it declares may reach the server; else everything is its demo. */
export type ShowBlok = {
  type: 'show';
  title: string;
  source: string;
  /** Snake_case `BlokCheckScope`, as the check report writes it. Null: no check has seen this blok. */
  scope: unknown;
  live: boolean;
};

/** An action to draw a form for: as the server knows it, or why it cannot be asked for. */
export type ShowAction = {
  type: 'action';
  title: string;
  hash: string;
  action: unknown;
  error?: string;
};

export type TaskEvent = {
  id: string;
  kind: string;
  returns?: Record<string, unknown> | null;
  message?: string | null;
  progress?: number | null;
  createdAt?: string;
};

/** What a task reported since the last time. */
export type TaskUpdate = {type: 'task'; task: string; events: TaskEvent[]; done: boolean; error?: string};

/** The task a call started, or why it did not. */
export type Called = {type: 'called'; task?: string; error?: string};

/** The answer to a `Query` with this `id`. */
export type Answer = {type: 'answer'; id: number; data?: Record<string, unknown>; error?: string};

export type ToPage = ShowBlok | ShowAction | TaskUpdate | Called | Answer;

export type Query = {type: 'query'; id: number; service: string; document: string; variables: Record<string, unknown>};

/** `implementation` chooses the agent, else the server picks one. Pins only travel with one. */
export type Call = {type: 'call'; hash: string; args: Record<string, unknown>; implementation?: string; dependencies?: unknown[]};

export type Cancel = {type: 'cancel'; task: string};

export type FromPage = {type: 'ready'} | Query | Call | Cancel;
