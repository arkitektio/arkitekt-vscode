import * as vscode from 'vscode';
import {
  analyzeBsx,
  blokContextOf,
  completeBsx,
  emptyBlokScope,
  hoverBsx,
  signatureBsx,
  type BlokCheckScope,
  type BsxCompletionKind,
  type BsxEnvironment,
} from './core';

/** A blok literal of a Python document, as arkitekt-lsp's `bsx/regions` answers it. */
export type Region = {
  start: vscode.Position;
  end: vscode.Position;
  value: string;
  root: string;
  context: string;
  kind: string;
  /** The value is the text as written (no escapes): positions map one to one. */
  exact: boolean;
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
 * The diagnostic families an empty scope cannot get wrong (arkitekt_lsp.live.SCOPE_FREE): a `.bsx`
 * file has no app, so what it reads of one is not told.
 */
const SCOPE_FREE = new Set(['bsx', 'expr', 'callback', 'palette', 'props', 'foreach', 'context', 'logo', 'catalog', 'toast']);

const kindOf = (context: string): BlokCheckScope['kind'] =>
  (context === 'ACTION_LOGO' ? 'action_logo' : context === 'OVERLAY' ? 'action' : 'agent') as BlokCheckScope['kind'];

/** A `.bsx` file's environment: its root names the context; nothing else is declared. */
const fileEnvironment = (text: string): BsxEnvironment => {
  const root = /<([A-Za-z_]\w*)/.exec(text)?.[1];
  const context = (root && blokContextOf(root)) || 'HTML';
  return {scope: emptyBlokScope(kindOf(context), context)};
};

const locate = async (document: vscode.TextDocument, position: vscode.Position, regions: RegionSource): Promise<Located | null> => {
  if (document.languageId === 'bsx') {
    const value = document.getText();
    return {value, offset: document.offsetAt(position), base: 0, env: fileEnvironment(value)};
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
        env: {scope: emptyBlokScope(region.kind as BlokCheckScope['kind'], region.context)},
      };
    }
  }
  return null;
};

/** Completion, hovers and signature help in `.bsx` files and in the bloks of Python files. */
export const registerBsx = (context: vscode.ExtensionContext, regions: RegionSource): void => {
  const selector: vscode.DocumentSelector = [
    {language: 'bsx'},
    {language: 'python', scheme: 'file'},
  ];

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      {
        provideCompletionItems: async (document, position) => {
          const at = await locate(document, position, regions);
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
        const at = await locate(document, position, regions);
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
          const at = await locate(document, position, regions);
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

  // A `.bsx` file has no app to check it: what its text says about itself, as it is typed.
  const diagnostics = vscode.languages.createDiagnosticCollection('bsx');
  const analyze = (document: vscode.TextDocument) => {
    if (document.languageId !== 'bsx') return;
    const text = document.getText();
    const {tree, markers} = analyzeBsx(text, fileEnvironment(text));
    // What the parser refuses is the text's own; of the checker's findings only the scope-free ones.
    const told = tree === null ? markers : markers.filter(marker => SCOPE_FREE.has((marker.code ?? '').split('.')[0]));
    diagnostics.set(
      document.uri,
      told.map(marker => {
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
  );
  vscode.workspace.textDocuments.forEach(analyze);
};
