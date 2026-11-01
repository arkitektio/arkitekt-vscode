// Bundles the extension, and the page its preview panel shows:
// - `dist/extension.js`: the extension and @arkitektio/bsx in one CommonJS file. The extension host
//   loads it, and `vscode` is the host's own.
// - `dist/webview.js`: the blok renderer for the browser, one file so no chunk has to be found by
//   URL inside a webview. Its stylesheet is built by the Tailwind CLI (the `build` script).
// - `dist/draco/`: three's model decoder, which a scene fetches at run time.
import {cpSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const require = createRequire(import.meta.url);

/** bsx's runtime Tailwind imports stylesheets as text (`x.css?raw`), as Vite takes them. */
const rawImports = {
  name: 'raw-imports',
  setup(build) {
    build.onResolve({filter: /\?raw$/}, args => ({
      path: require.resolve(args.path.slice(0, -'?raw'.length), {paths: [args.resolveDir]}),
      namespace: 'raw',
    }));
    build.onLoad({filter: /.*/, namespace: 'raw'}, args => ({
      contents: readFileSync(args.path, 'utf8'),
      loader: 'text',
    }));
  },
};

const extension = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
};

const webview = {
  entryPoints: ['src/webview/main.tsx'],
  outfile: 'dist/webview.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
  jsx: 'automatic',
  define: {'process.env.NODE_ENV': watch ? '"development"' : '"production"'},
  minify: !watch,
  sourcemap: watch,
  plugins: [rawImports],
  logLevel: 'info',
};

// Found from three's entry (build/): its `exports` list neither its package file nor this folder.
const three = dirname(dirname(require.resolve('three')));
cpSync(join(three, 'examples/jsm/libs/draco/gltf'), 'dist/draco', {recursive: true});

if (watch) {
  const contexts = await Promise.all([esbuild.context(extension), esbuild.context(webview)]);
  await Promise.all(contexts.map(context => context.watch()));
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
}
