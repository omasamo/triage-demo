// Bundles the Electron main process (ESM) and preload (CJS). The renderer is built by Vite.
import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: true, external: ['electron', 'node-llama-cpp', 'node:sqlite'], logLevel: 'info' };
await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist-electron/main.mjs', format: 'esm',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
await build({ ...common, entryPoints: ['src/main/preload.ts'], outfile: 'dist-electron/preload.cjs', format: 'cjs' });
