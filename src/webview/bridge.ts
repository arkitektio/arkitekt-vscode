import type {FromPage, ToPage} from './protocol';

declare const acquireVsCodeApi: () => {postMessage: (message: FromPage) => void};

const vscode = acquireVsCodeApi();

export const send = (message: FromPage): void => vscode.postMessage(message);

type Pending = {resolve: (data: Record<string, unknown>) => void; reject: (error: Error) => void};

const pending = new Map<number, Pending>();
let nextId = 1;

/**
 * Runs a read on one service, through the extension and the language server: the page holds no
 * token and reaches no server itself. The language server refuses anything but a query, so what a
 * page says it sent does not matter.
 */
export const serviceQuery = (service: string, document: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, {resolve, reject});
    send({type: 'query', id, service, document, variables});
  });
};

/** Listens for what the extension says; an answer to a query goes to whoever asked it. */
export const listen = (told: (message: Exclude<ToPage, {type: 'answer'}>) => void): (() => void) => {
  const received = (event: MessageEvent<ToPage>) => {
    const message = event.data;
    if (message?.type !== 'answer') {
      if (message) told(message);
      return;
    }
    const waiting = pending.get(message.id);
    pending.delete(message.id);
    if (message.error !== undefined) waiting?.reject(new Error(message.error));
    else waiting?.resolve(message.data ?? {});
  };
  window.addEventListener('message', received);
  return () => window.removeEventListener('message', received);
};
