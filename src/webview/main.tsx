import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {parseBsxPartial} from '@arkitektio/bsx/bsx/index';
import {declaredQueries, demoModel, liveModel, parseBlokDeclarations} from '@arkitektio/bsx/renderer/declarations';
import type {BlokReadExecutor} from '@arkitektio/bsx/renderer/runtime/reads';
import type {BlokComponentNode} from '@arkitektio/bsx/renderer/runtime/types';
import {configureBlokPlatform, declareBlokUi} from '@arkitektio/bsx/runtime';
import {configurePortHost} from '@arkitektio/bsx/ports/host';
import {hostedStructure} from '@arkitektio/bsx/ports/structure/index';
import {threeScene} from '@arkitektio/bsx/scene';
import {shadcnExtras, shadcnHtml, shadcnLogo, shadcnUi} from '@arkitektio/bsx/shadcn';
import {BlokRenderer} from '@arkitektio/bsx/web';
import {ActionPage, useTask} from './action';
import {listen, send, serviceQuery} from './bridge';
import type {ShowAction, ShowBlok} from './protocol';

const NAME = 'vscode-preview';

/** The global catalogs. structure@1 asks a server through the port host; a service's own module is not here. */
const catalog = declareBlokUi({
  name: NAME,
  description: 'Bloks previewed in VS Code',
  implements: [shadcnUi, shadcnHtml, shadcnLogo, shadcnExtras, threeScene, hostedStructure],
}).catalog;

/** VS Code marks the theme on `body`, and changes it there while the page is open. */
const isDark = (): boolean => !document.body.classList.contains('vscode-light') && !document.body.classList.contains('vscode-high-contrast-light');

const syncTheme = () => document.documentElement.classList.toggle('dark', isDark());

const subscribeTheme = (changed: () => void): (() => void) => {
  const observer = new MutationObserver(() => {
    syncTheme();
    changed();
  });
  observer.observe(document.body, {attributes: true, attributeFilter: ['class']});
  return () => observer.disconnect();
};

const useColorScheme = (): 'light' | 'dark' =>
  React.useSyncExternalStore(subscribeTheme, () => (isDark() ? 'dark' : 'light'));

const say = (message: string, options?: {description?: string}) => {
  console.info(options?.description ? `${message}: ${options.description}` : message);
};

configureBlokPlatform({
  catalog,
  useColorScheme,
  dracoDecoderPath: document.getElementById('root')?.dataset.draco ?? '',
  toast: Object.assign(say, {success: say, info: say, warning: say, error: say}),
});

// A picker's query goes where a declared read does; everything else keeps the package's default.
configurePortHost({
  useServiceQuery: service => (document, variables) => {
    if (!service) return Promise.reject(new Error('No service named to run the query on.'));
    return serviceQuery(service, document, variables);
  },
});

/** A declared read, asked through the extension. Subscriptions are the one kind the editor has no way to follow. */
const readExecutor: BlokReadExecutor = {
  query: (service, document, variables) => serviceQuery(service, document, variables),
  subscribe: (service, _document, _variables, sink) => {
    sink.error(new Error(`The editor cannot follow a subscription on ${service}.`));
    return () => undefined;
  },
};

/** A preview calls nothing: the renderer drops what this refuses before it starts. */
const refuseEveryCall = () => true;

const keysOf = (entries: unknown): string[] =>
  (Array.isArray(entries) ? entries : []).flatMap(entry => {
    const key = (entry as {key?: unknown} | null)?.key;
    return typeof key === 'string' ? [key] : [];
  });

type Scope = {dependencies?: unknown; locals?: unknown; queries?: unknown; subscriptions?: unknown};

class DrawingBoundary extends React.Component<{resetKey: unknown; children: React.ReactNode}, {error: Error | null}> {
  override state = {error: null as Error | null};

  static getDerivedStateFromError(error: Error) {
    return {error};
  }

  override componentDidUpdate(previous: {resetKey: unknown}) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({error: null});
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return <p className="p-4 text-sm text-destructive">This blok could not be drawn: {this.state.error.message}</p>;
  }
}

const Preview = ({message}: {message: ShowBlok}) => {
  const parsed = React.useMemo(() => parseBsxPartial(message.source), [message.source]);
  // A half-typed source can stop parsing for a moment: keep what was drawn.
  const last = React.useRef<BlokComponentNode | null>(null);
  if (parsed.tree) last.current = parsed.tree;
  const tree = last.current;
  const scope = message.scope as Scope | null;

  const roots = React.useMemo(() => (tree ? [tree] : []), [tree]);
  const declarations = React.useMemo(
    () => parseBlokDeclarations({componentTree: roots, locals: scope?.locals, queries: scope?.queries, subscriptions: scope?.subscriptions}),
    [roots, scope],
  );
  const live = message.live;
  const model = React.useMemo(
    () => (live ? liveModel(roots, declarations) : {data: demoModel(roots, declarations), statuses: undefined}),
    [live, roots, declarations],
  );
  const queries = React.useMemo(() => (live ? declaredQueries(declarations) : []), [live, declarations]);
  const unbound = React.useMemo(() => keysOf(scope?.dependencies), [scope]);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-3 py-1 text-xs text-muted-foreground">
        <span className="truncate font-mono">{message.title}</span>
        <span className="shrink-0">
          {live ? 'live reads' : 'demo'}
          {unbound.length ? `: ${unbound.join(', ')} not bound` : ''}
        </span>
      </header>
      {parsed.error ? <p className="shrink-0 border-b border-border px-3 py-1 text-xs text-destructive">{parsed.error.message}</p> : null}
      <main className="min-h-0 flex-1 overflow-auto p-3">
        {tree ? (
          <DrawingBoundary resetKey={tree}>
            <BlokRenderer
              surfaceId={`preview-${message.title}`}
              catalog={catalog}
              uiComponents={roots}
              initialState={model.data}
              statuses={model.statuses}
              queries={queries}
              readExecutor={live ? readExecutor : undefined}
              unboundDependencies={unbound}
              refuseAction={refuseEveryCall}
              chrome="minimal"
            />
          </DrawingBoundary>
        ) : (
          <p className="text-sm text-muted-foreground">The preview shows once the source starts to parse.</p>
        )}
      </main>
    </div>
  );
};

const App = () => {
  const [shown, setShown] = React.useState<ShowBlok | ShowAction | null>(null);
  const [task, tell] = useTask();
  React.useEffect(() => {
    const stop = listen(message => {
      if (message.type === 'called' || message.type === 'task') {
        tell(message);
        return;
      }
      // Another action is another form: what the last one's task said does not belong to it.
      if (message.type === 'action') tell({type: 'reset'});
      setShown(message);
    });
    send({type: 'ready'});
    return stop;
  }, [tell]);
  if (!shown) return null;
  if (shown.type === 'action') return <ActionPage key={shown.hash} shown={shown} task={task} />;
  return <Preview key={shown.title} message={shown} />;
};

syncTheme();
const element = document.getElementById('root');
if (element) createRoot(element).render(<App />);
