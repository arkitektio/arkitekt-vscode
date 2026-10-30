// Bundles the extension and @arkitektio/bsx into one CommonJS file: the extension host loads
// `dist/extension.js`, and `vscode` is the host's own.
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const options = {
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

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}
