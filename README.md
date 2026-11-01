# Arkitekt for VS Code

Bloks in VS Code. It has two layers:

- **The check, through `arkitekt-lsp`.** On save, the language server runs your app's own
  `arkitekt check` and underlines what it finds in the BSX of the blok it is about, in the Python
  file that declares it. A blok you edit after the check is checked as you type, without the app.
  The server runs in the app's environment, so install it there (`uv add --dev arkitekt-lsp`).
  The extension finds it in the workspace's `.venv`, next to the Python extension's interpreter,
  or on PATH, or at `arkitekt.lsp.path`. It starts only in a trusted workspace, because it
  imports your app. With several apps in a folder, each file that declares one is checked as
  itself; click the app in the status bar, or run `Arkitekt: Choose App…`, to pick the one the
  other files belong to.
- **The language, from the Orkestrator's core.** BSX is highlighted inside Python strings (any
  string that opens with a blok root: `<Html>`, `<Scene>`, `<Overlay>`, `<AgentLogo>`,
  `<ActionLogo>`) and in `.bsx` files. Completion, hovers and signature help come from the same
  code the Orkestrator's BlokEditor runs. Inside Python they need the server to find the bloks.
- **A preview of each blok.** The lens above a blok, or `Arkitekt: Preview Blok`, draws it in a
  panel beside the editor, and it follows your typing. It calls nothing: declared dependencies show
  as not bound, and unless `arkitekt.server.actions` is on it reaches no server either. Only components the `ui`, `html`, `logo`,
  `shadcn`, `scene` and `structure` catalogs define can be drawn.

- **Who would satisfy your dependencies, once connected.** Local until you ask: use the button in
  the status bar, or run `Arkitekt: Connect to Server`, with your account on the server at
  `arkitekt.server.url`. Access is read-only and holds until `Arkitekt: Disconnect from Server`.
  Each dependency protocol then gets a count of agents above it, a warning when nobody offers it,
  and the agents on hover. `Arkitekt: Add a Dependency from
  the Server…` (or the lens above your `App(...)`) lets you search the agents, tick the actions and
  states you need, and writes the `@app.declare` class for you.
- **Your actions, with `arkitekt.server.actions`.** A lens above each action opens its form beside
  the code, with the same widgets the Orkestrator draws, pickers included. Run starts it on the
  server's agents and shows its events and returns. The app has to be running somewhere
  (`arkitekt run dev`), or the lens says so. A blok's declared reads and pickers in the preview use
  the server too, but subscriptions do not run in the editor.

## Develop

```bash
pnpm install
pnpm build        # generates the injection grammars, then bundles dist/extension.js and the preview page
pnpm typecheck
```

Open this folder in VS Code and run **Run the extension** (F5).

`syntaxes/bsx.tmLanguage.json` is the grammar. The two `bsx-in-python-*.tmLanguage.json`
injections are generated from it (`pnpm grammars`), with every rule also ending at the Python
string's closing quote. The language core is [`@arkitektio/bsx`](https://github.com/arkitektio/bsx), bundled into the extension.

## Release

semantic-release cuts every release from `main` (`next` for prereleases): the `.vsix` goes onto the
GitHub release, then to the Marketplace as `arkitekt-dev.arkitekt`. The Marketplace trusts this
workflow (`release.yaml`) through a Trusted Publishing policy on the publisher, and no token exists
anywhere.
