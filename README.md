# BSX for Arkitekt (VS Code)

Bloks in VS Code. It has two layers:

- **The check, through `arkitekt-lsp`.** On save, the language server runs your app's own
  `arkitekt check` and underlines what it finds in the BSX of the blok it is about, in the Python
  file that declares it. A blok you edit after the check is checked as you type, without the app.
  The server runs in the app's environment, so install it there (`uv add --dev arkitekt-lsp`).
  The extension finds it in the workspace's `.venv`, next to the Python extension's interpreter,
  or on PATH, or at `arkitekt.lsp.path`. It starts only in a trusted workspace, because it
  imports your app.
- **The language, from the Orkestrator's core.** BSX is highlighted inside Python strings (any
  string that opens with a blok root: `<Html>`, `<Scene>`, `<Overlay>`, `<AgentLogo>`,
  `<ActionLogo>`) and in `.bsx` files. Completion, hovers and signature help come from the same
  code the Orkestrator's BlokEditor runs. Inside Python they need the server to find the bloks.

## Develop

```bash
pnpm install
pnpm build        # generates the injection grammars, then bundles dist/extension.js
pnpm typecheck
```

Open this folder in VS Code and run **Run the extension** (F5).

`syntaxes/bsx.tmLanguage.json` is the grammar. The two `bsx-in-python-*.tmLanguage.json`
injections are generated from it (`pnpm grammars`), with every rule also ending at the Python
string's closing quote. The language core is `@arkitektio/bsx` (this repo's `packages/bsx`), bundled into the extension.
