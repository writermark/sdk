import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: {
      index: 'src/sdk/index.ts',
      react: 'src/sdk/react.ts',
    },
    format: ['esm'],
    dts: true,
    outDir: 'dist',
    clean: true,
    splitting: true,
    external: ['react', 'node:crypto'],
    platform: 'browser',
    target: 'es2020',
    noExternal: [/^(?!react)/],
  },
  {
    entry: { 'vdf-worker': 'src/vdf/vdf-worker.ts' },
    format: ['esm'],
    dts: false,
    outDir: 'dist',
    clean: false,
    splitting: false,
    platform: 'browser',
    target: 'es2020',
    noExternal: [/.*/],
  },
])
