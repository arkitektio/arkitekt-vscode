import * as vscode from 'vscode';
import {
  analyzeBsx,
  blokViewFor,
  completeBsx,
  hoverBsx,
  signatureBsx,
  sourceCatalog,
  type BlokCheckScope,
  type BsxCompletionKind,
  type BsxEnvironment,
} from './core';
import {fileCatalog, isAddress, type Catalogs} from './catalogs';

/** A blok literal of a Python document, as arkitekt-lsp's `bsx/regions` answers it. */
export type Region = {
  start: vscode.Position;
  end: vscode.Position;
  value: string;
  /** The value is the text as written (no escapes): positions map one to one. */
  exact: boolean;
  /** The blok a check saw here (`panel`, `crop:html`), if one has. */
  blok?: string;
  /**
   * Where that check saw the blok mounted (`arkitekt check --json`): the kinds the mount takes,
   * its dependencies and args, what `deps.*` and `args.*` complete against. Absent: mounted
   * nowhere. What the blok is (its kind and context) and owns (its locals, queries,
   * subscriptions) is read off its own `<Blok>`.
   */
  scope?: BlokCheckScope | null;
};

/** The blok literals of a Python document; none when there is no server to ask. */
export type RegionSource = (document: vscode.TextDocument) => Promise<readonly Region[]>;

/** Where the cursor is in a blok: its BSX, the offset in it, and where it starts in the document. */
type Located = {value: string; offset: number; base: number; env: BsxEnvironment};

const KINDS: Record<BsxCompletionKind, vscode.CompletionItemKind> = {
  component: vscode.CompletionItemKind.Class,
  prop: vscode.CompletionItemKind.Property,
  value: vscode.CompletionItemKind.EnumMember,
  dependency: vscode.CompletionItemKind.Module,
  path: vscode.CompletionItemKind.Field,
  function: vscode.CompletionItemKind.Function,
  action: vscode.CompletionItemKind.Method,
  keyword: vscode.CompletionItemKind.Keyword,
  close: vscode.CompletionItemKind.Snippet,
};

const TRIGGERS = ['<', ' ', '"', "'", '{', '.', '(', ',', '/', ':', '['];

/**
 * What a blok is completed and checked against: where it is mounted (`scope`; null: nowhere) and
 * the catalog its `<Blok catalog>` names (else `fallback`, the `arkitekt.catalog` setting), once
 * that is known here (it ships, or was loaded), else the base catalog. One that is being loaded is
 * the base catalog's until it has arrived.
 */
const environment = (text: string, scope: BlokCheckScope | null, fallback: string | null, catalogs: Catalogs): BsxEnvironment => {
  let named: string | null = null;
  try {
    named = sourceCatalog(text);
  } catch {
    // Markup that does not parse yet names nothing.
  }
  const catalog = named ?? fallback;
  if (catalog && isAddress(catalog) && !catalogs.known(catalog)) void catalogs.load(catalog);
  const target = catalog && catalogs.known(catalog) ? catalog : null;
  return {scope, view: blokViewFor(target)};
};

/** A `.bsx` file's environment: mounted nowhere; its catalog the one its `<Blok>` names, else the `arkitekt.catalog` setting. */
const fileEnvironment = (text: string, catalogs: Catalogs): BsxEnvironment => environment(text, null, fileCatalog(), catalogs);

const locate = async (document: vscode.TextDocument, position: vscode.Position, regions: RegionSource, catalogs: Catalogs): Promise<Located | null> => {
  if (document.languageId === 'bsx') {
    const value = document.getText();
    return {value, offset: document.offsetAt(position), base: 0, env: fileEnvironment(value, catalogs)};
  }
  const offset = document.offsetAt(position);
  for (const region of await regions(document)) {
    if (!region.exact) continue;
    const base = document.offsetAt(region.start);
    if (base <= offset && offset <= document.offsetAt(region.end)) {
      return {
        value: region.value,
        offset: offset - base,
        base,
        env: environment(region.value, region.scope ?? null, region.scope?.catalog ?? null, catalogs),
      };
    }
  }
  return null;
};

/** Completion, hovers and signature help in `.bsx` files and in the bloks of Python files. */
export const registerBsx = (context: vscode.ExtensionContext, regions: RegionSource, catalogs: Catalogs): void => {
  const selector: vscode.DocumentSelector = [
    {language: 'bsx'},
    {language: 'python', scheme: 'file'},
  ];

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      {
        provideCompletionItems: async (document, position) => {
          const at = await locate(document, position, regions, catalogs);
          if (!at) return undefined;
          return completeBsx(at.value, at.offset, at.env).map(item => {
            const completion = new vscode.CompletionItem(item.label, KINDS[item.kind]);
            completion.insertText = item.snippet ? new vscode.SnippetString(item.insertText) : item.insertText;
            completion.detail = item.detail;
            completion.documentation = item.documentation ? new vscode.MarkdownString(item.documentation) : undefined;
            completion.sortText = item.sortText;
            completion.range = new vscode.Range(document.positionAt(at.base + item.from), position);
            return completion;
          });
        },
      },
      ...TRIGGERS,
    ),
    vscode.languages.registerHoverProvider(selector, {
      provideHover: async (document, position) => {
        const at = await locate(document, position, regions, catalogs);
        const hover = at && hoverBsx(at.value, at.offset, at.env);
        if (!at || !hover) return undefined;
        const range = new vscode.Range(document.positionAt(at.base + hover.range.start), document.positionAt(at.base + hover.range.end));
        return new vscode.Hover(new vscode.MarkdownString(hover.contents), range);
      },
    }),
    vscode.languages.registerSignatureHelpProvider(
      selector,
      {
        provideSignatureHelp: async (document, position) => {
          const at = await locate(document, position, regions, catalogs);
          const signature = at && signatureBsx(at.value, at.offset, at.env);
          if (!signature) return undefined;
          const information = new vscode.SignatureInformation(signature.label, signature.documentation);
          information.parameters = signature.parameters.map(
            parameter => new vscode.ParameterInformation(parameter.label, parameter.documentation ? new vscode.MarkdownString(parameter.documentation) : undefined),
          );
          const help = new vscode.SignatureHelp();
          help.signatures = [information];
          help.activeSignature = 0;
          help.activeParameter = signature.activeParameter;
          return help;
        },
      },
      '(',
      ',',
    ),
  );

  // A `.bsx` file has no app to check it: checked unmounted, what its text says about itself, as it is typed.
  const diagnostics = vscode.languages.createDiagnosticCollection('bsx');
  const analyze = (document: vscode.TextDocument) => {
    if (document.languageId !== 'bsx') return;
    const text = document.getText();
    const {markers} = analyzeBsx(text, fileEnvironment(text, catalogs));
    diagnostics.set(
      document.uri,
      markers.map(marker => {
          const range = new vscode.Range(document.positionAt(marker.range.start), document.positionAt(Math.max(marker.range.end, marker.range.start + 1)));
          const diagnostic = new vscode.Diagnostic(range, marker.message, marker.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
          diagnostic.code = marker.code;
          diagnostic.source = 'bsx';
          return diagnostic;
        }),
    );
  };
  context.subscriptions.push(
    diagnostics,
    vscode.workspace.onDidOpenTextDocument(analyze),
    vscode.workspace.onDidChangeTextDocument(event => analyze(event.document)),
    vscode.workspace.onDidCloseTextDocument(document => diagnostics.delete(document.uri)),
    // A catalog arrived, or another is named: what a `.bsx` file's text says may differ.
    catalogs.onDidChange(() => vscode.workspace.textDocuments.forEach(analyze)),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('arkitekt.catalog')) vscode.workspace.textDocuments.forEach(analyze);
    }),
  );
  vscode.workspace.textDocuments.forEach(analyze);
};
