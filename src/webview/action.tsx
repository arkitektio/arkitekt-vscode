import * as React from 'react';
import {createWidgetRegistry, asWidgetRegistry} from '@arkitektio/bsx/ports/engine/defaultRegistry';
import {DependenciesContainer} from '@arkitektio/bsx/ports/dependencies/DependenciesContainer';
import {DependencyTreeNotice} from '@arkitektio/bsx/ports/dependencies/DependencyTreeNotice';
import {useDependencyTree} from '@arkitektio/bsx/ports/dependencies/useDependencyTree';
import {DependencyDefinitionsProvider} from '@arkitektio/bsx/ports/engine/DependencyContext';
import {useAssignForm} from '@arkitektio/bsx/ports/engine/useAssignForm';
import type {ListDependencyFragment} from '@arkitektio/bsx/ports/rekuest';
import {WidgetRegistryProvider} from '@arkitektio/bsx/ports/engine/WidgetsProvider';
import type {ArgPort, PortGroup, ReturnPort} from '@arkitektio/bsx/ports/engine/types';
import {ArgsContainer} from '@arkitektio/bsx/ports/widgets/ArgsContainer';
import {ReturnsContainer} from '@arkitektio/bsx/ports/widgets/returns/ReturnsContainer';
import {Button} from '@arkitektio/bsx/vendor/core/ui/button';
import {Form} from '@arkitektio/bsx/vendor/core/ui/form';
import {send} from './bridge';
import type {Called, ShowAction, TaskEvent, TaskUpdate} from './protocol';

const registry = asWidgetRegistry(createWidgetRegistry());

type Implementation = {
  id: string;
  agent?: {id?: string; name?: string | null; connected?: boolean | null} | null;
  dependencies?: ListDependencyFragment[] | null;
};

type Action = {
  name?: string | null;
  description?: string | null;
  args: ArgPort[];
  returns: ReturnPort[];
  portGroups?: PortGroup[] | null;
  implementations?: Implementation[] | null;
};

const NO_DEPENDENCIES: ListDependencyFragment[] = [];

/** Value of the "Run on" choice that lets the server pick. */
const ANY_AGENT = '';

/** The events that say how it went, past their kind: what the panel names once a task has ended. */
const FAILURE_KINDS = new Set(['FAILED', 'CRITICAL', 'DENIED', 'LOST']);

/** A task's latest returns: a generator yields many, and the last is what it has now. */
const latestReturns = (events: readonly TaskEvent[]): Record<string, unknown> | null => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const returns = events[index]?.returns;
    if (returns) return returns;
  }
  return null;
};

const EventLog = ({events}: {events: readonly TaskEvent[]}) => (
  <ol className="flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
    {events.map(event => (
      <li key={event.id} className={FAILURE_KINDS.has(event.kind) ? 'text-destructive' : undefined}>
        {event.kind}
        {event.progress != null ? ` ${event.progress}%` : ''}
        {event.message ? `: ${event.message}` : ''}
      </li>
    ))}
  </ol>
);

const ActionForm = ({action, hash, task}: {action: Action; hash: string; task: TaskView}) => {
  const connected = React.useMemo(
    () => (action.implementations ?? []).filter(implementation => implementation.agent?.connected),
    [action.implementations],
  );
  // Dependencies belong to an implementation: an action target has nothing to pin them on, so an
  // action that declares any is run on an agent chosen here.
  const needsAnAgent = (action.implementations ?? []).some(implementation => (implementation.dependencies ?? []).length > 0);
  const [chosen, choose] = React.useState<string>(needsAnAgent ? (connected[0]?.id ?? ANY_AGENT) : ANY_AGENT);
  const implementation = connected.find(candidate => candidate.id === chosen);
  const dependencies = implementation?.dependencies ?? NO_DEPENDENCIES;

  const form = useAssignForm({ports: action.args, dependencies});
  const tree = useDependencyTree(implementation ? {id: implementation.id, dependencies} : null, form.control);
  const submit = form.handleSubmit(({args, dependencies: pins}) =>
    send({type: 'call', hash, args, implementation: implementation?.id, dependencies: implementation ? pins : undefined}),
  );

  return (
    <Form {...form}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <DependencyDefinitionsProvider dependencies={dependencies}>
          <ArgsContainer registry={registry} ports={action.args} groups={action.portGroups ?? []} path={['args']} options={{layout: 'stack'}} />
          {connected.length > 1 || (needsAnAgent && connected.length > 0) ? (
            <label className="flex flex-col gap-1 text-sm">
              Run on
              <select
                className="rounded-md border border-input bg-background px-2 py-1 text-sm"
                value={chosen}
                onChange={event => {
                  // Pins are for the agent they were made on. The new one's seed themselves below.
                  form.setValue('dependencies', []);
                  choose(event.target.value);
                }}
              >
                {needsAnAgent ? null : <option value={ANY_AGENT}>Any connected agent</option>}
                {connected.map(candidate => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.agent?.name ?? candidate.id}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {implementation && dependencies.length > 0 ? (
            <DependenciesContainer key={implementation.id} dependencies={dependencies} bound={implementation.agent?.id ?? ''} tree={tree.nodes} />
          ) : null}
        </DependencyDefinitionsProvider>
        <DependencyTreeNotice tree={tree} />
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={task.running || tree.satisfied === false || (needsAnAgent && !implementation)}>
            {task.running ? 'Running…' : 'Run'}
          </Button>
          {task.id && task.running ? (
            <Button type="button" variant="outline" onClick={() => send({type: 'cancel', task: task.id as string})}>
              Cancel
            </Button>
          ) : null}
        </div>
      </form>
    </Form>
  );
};

type TaskView = {id: string | null; running: boolean; events: TaskEvent[]; error: string | null};

const IDLE: TaskView = {id: null, running: false, events: [], error: null};

/** What a task has said so far, from what the extension passes on. */
export const taskReducer = (state: TaskView, message: Called | TaskUpdate | {type: 'reset'}): TaskView => {
  if (message.type === 'reset') return IDLE;
  if (message.type === 'called') {
    return message.task
      ? {id: message.task, running: true, events: [], error: null}
      : {...IDLE, error: message.error ?? 'The call did not start.'};
  }
  if (message.task !== state.id) return state;
  return {
    ...state,
    running: !message.done,
    events: [...state.events, ...message.events],
    error: message.error ?? state.error,
  };
};

export const ActionPage = ({shown, task}: {shown: ShowAction; task: TaskView}) => {
  const action = shown.action as Action | null;
  const returns = latestReturns(task.events);

  if (shown.error) return <p className="p-4 text-sm text-destructive">{shown.error}</p>;
  if (!action) {
    return (
      <div className="flex flex-col gap-2 p-4 text-sm">
        <p>The server does not know this action yet.</p>
        <p className="text-muted-foreground">
          Start the app with <code className="font-mono">arkitekt run dev</code> so it registers its current definition.
          The definition changes when an action's ports do, so run it again after editing them.
        </p>
      </div>
    );
  }

  const connected = (action.implementations ?? []).filter(implementation => implementation.agent?.connected);

  return (
    <WidgetRegistryProvider registry={registry}>
      <div className="flex h-screen flex-col overflow-auto">
        <header className="flex flex-col gap-1 border-b border-border p-4">
          <h1 className="text-base font-semibold">{action.name ?? shown.title}</h1>
          {action.description ? <p className="text-sm text-muted-foreground">{action.description}</p> : null}
          <p className="text-xs text-muted-foreground">
            {connected.length
              ? `Runs on: ${connected.map(implementation => implementation.agent?.name).join(', ')}`
              : 'No agent is connected, so a call waits until one is.'}
          </p>
        </header>
        <main className="flex flex-col gap-6 p-4">
          <ActionForm action={action} hash={shown.hash} task={task} />
          {task.error ? <p className="text-sm text-destructive">{task.error}</p> : null}
          {returns ? (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold">Returned</h2>
              <ReturnsContainer registry={registry} ports={action.returns} values={returns} />
            </section>
          ) : null}
          {task.events.length ? <EventLog events={task.events} /> : null}
        </main>
      </div>
    </WidgetRegistryProvider>
  );
};

export const useTask = () => React.useReducer(taskReducer, IDLE);
