import * as vscode from 'vscode';
import {isCatalogTarget, knownCatalog, parseSpecCatalog, registerBlokCatalog} from './core';

/** Asks arkitekt-lsp; rejects while it is not running. */
type Ask = <T>(method: string, params: object) => Promise<T>;

/** What `arkitekt/catalog` answers: the catalog and those it extends, as published, nearest the base first. */
type Published = {id: string | null; catalogs: string[]; error: string | null};

/** The address a catalog is published at. Nothing else is ever asked for. */
export const isAddress = (catalog: unknown): catalog is string => typeof catalog === 'string' && catalog.startsWith('https://') && isCatalogTarget(catalog);

/** The catalogs the workspace names (`arkitekt.catalogs`): only addresses, each once. */
export const configuredCatalogs = (folder?: vscode.WorkspaceFolder): string[] => [
  ...new Set(vscode.workspace.getConfiguration('arkitekt', folder).get<unknown[]>('catalogs', []).filter(isAddress)),
];

/** The catalog a `.bsx` file is written for (`arkitekt.catalog`); null: the base catalog. */
export const fileCatalog = (): string | null => vscode.workspace.getConfiguration('arkitekt').get<string>('catalog', '').trim() || null;

/**
 * The published catalogs this window completes against, beyond the two that ship with the
 * extension (the base catalog and the Orkestrator's).
 *
 * The extension pulls nothing itself: it asks arkitekt-lsp (`arkitekt/catalog`), which pulls over
 * https only, capped in size and time, keeps what it pulled, and answers the JSON as published.
 * Here it is parsed as a catalog and registered as data: a catalog adds component names, props
 * and docs to completion, hovers and checks. Nothing of it is run, and the preview draws none of
 * its components: it has no implementation of them.
 */
export class Catalogs implements vscode.Disposable {
  /** Asked for and not had: not asked again until a reload, or the server restarts. */
  private readonly failed = new Map<string, string>();
  private readonly pending = new Map<string, Promise<boolean>>();
  private readonly changed = new vscode.EventEmitter<void>();
  /** A catalog became known: what completes, and what a check of the text finds, may differ. */
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly ask: Ask,
    private readonly output: vscode.OutputChannel,
  ) {}

  /** Whether completion can already read `catalog`. A name that is no address is the app's own: nothing to load. */
  known(catalog: string | null | undefined): boolean {
    return !catalog || knownCatalog(catalog) !== undefined;
  }

  /**
   * Makes `catalog` known, once: resolves true when it is. Never throws; a catalog that cannot
   * be had is said in the output and leaves completion on the base catalog.
   */
  load(catalog: string, options: {refresh?: boolean} = {}): Promise<boolean> {
    if (!isAddress(catalog)) return Promise.resolve(false);
    if (!options.refresh) {
      if (knownCatalog(catalog)) return Promise.resolve(true);
      if (this.failed.has(catalog)) return Promise.resolve(false);
    }
    const running = this.pending.get(catalog);
    if (running) return running;
    const loading = this.pull(catalog, options.refresh === true).finally(() => this.pending.delete(catalog));
    this.pending.set(catalog, loading);
    return loading;
  }

  private async pull(catalog: string, refresh: boolean): Promise<boolean> {
    let answer: Published;
    try {
      answer = await this.ask<Published>('arkitekt/catalog', {id: catalog, refresh});
    } catch (error) {
      // The server is not running (or too old to answer): asked again once it is.
      this.output.appendLine(`Catalog ${catalog}: not loaded, arkitekt-lsp did not answer (${error instanceof Error ? error.message : String(error)}).`);
      return false;
    }
    if (answer.error || answer.catalogs.length === 0) {
      const why = answer.error ?? 'the server knows it but has no published copy';
      this.failed.set(catalog, why);
      this.output.appendLine(`Catalog ${catalog}: not loaded. ${why}`);
      return false;
    }
    try {
      for (const text of answer.catalogs) {
        const raw = JSON.parse(text) as unknown;
        // The server checked it already; here only that it is the shape of a catalog, and published at an address.
        if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as {components?: unknown}).components) || !isAddress((raw as {id?: unknown}).id)) {
          throw new Error('what was answered is not a published catalog');
        }
        const parsed = parseSpecCatalog(raw, catalog);
        // A reload replaces nothing: a catalog only adds, and a version's contents do not change.
        if (!knownCatalog(parsed.id ?? '')) registerBlokCatalog(parsed);
      }
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      this.failed.set(catalog, why);
      this.output.appendLine(`Catalog ${catalog}: not loaded, it is not a catalog this version reads. ${why}`);
      return false;
    }
    this.failed.delete(catalog);
    this.output.appendLine(`Catalog ${catalog}: loaded.`);
    this.changed.fire();
    return knownCatalog(catalog) !== undefined;
  }

  /** Loads what the workspace names. `refresh` pulls each again, also those that failed. */
  async loadConfigured(options: {refresh?: boolean} = {}): Promise<{loaded: string[]; failed: [string, string][]}> {
    if (options.refresh) this.failed.clear();
    const named = configuredCatalogs(vscode.workspace.workspaceFolders?.[0]);
    const results = await Promise.all(named.map(async catalog => [catalog, await this.load(catalog, options)] as const));
    return {
      loaded: results.filter(([, ok]) => ok).map(([catalog]) => catalog),
      failed: results.filter(([, ok]) => !ok).map(([catalog]) => [catalog, this.failed.get(catalog) ?? 'arkitekt-lsp is not running'] as [string, string]),
    };
  }

  /** The server came up anew: what it could not hand out before, it may now. */
  retry(): void {
    this.failed.clear();
  }

  dispose(): void {
    this.changed.dispose();
  }
}
