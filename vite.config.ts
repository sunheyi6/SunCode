import { resolve } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron';
import electronRenderer from 'vite-plugin-electron-renderer';

export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          // vanilla-colorful custom elements
          isCustomElement: (tag) => tag.endsWith('-color-picker') || tag === 'hex-input',
        },
      },
    }),
    electron([
      // Main process
      {
        entry: 'src/main/index.ts',
        onstart(args) {
          args.startup();
        },
        vite: {
          build: {
            outDir: 'dist-electron/main',
            rollupOptions: {
              external: [
                'electron',
                'electron-log',
                'electron-log/main',
                'electron-updater',
                '@earendil-works/pi-ai',
                '@modelcontextprotocol/sdk',
              ],
            },
          },
          resolve: {
            alias: {
              '@': resolve(__dirname, 'src'),
              '@shared': resolve(__dirname, 'src/shared'),
            },
          },
        },
      },
      // Preload script
      {
        onstart(args) {
          args.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron/main',
            lib: {
              entry: 'src/main/preload.ts',
              formats: ['cjs'],
              fileName: () => 'preload.cjs',
            },
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
      // Agent Worker Thread — 关键！之前漏掉了
      {
        entry: 'src/worker/agent-worker.ts',
        onstart(args) {
          args.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron/worker',
            rollupOptions: {
              external: [
                'electron',
                '@earendil-works/pi-ai',
                '@modelcontextprotocol/sdk',
                'node:worker_threads',
                'node:fs',
                'node:fs/promises',
                'node:path',
                'node:child_process',
                'node:os',
                'node:process',
              ],
            },
          },
          resolve: {
            alias: {
              '@': resolve(__dirname, 'src'),
              '@shared': resolve(__dirname, 'src/shared'),
            },
          },
        },
      },
    ]),
    electronRenderer(),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  root: '.',
  server: {
    // SUNCODE_DEV_PORT overrides the default port — useful when the
    // product (or another project) is already on 5173.
    port: Number(process.env.SUNCODE_DEV_PORT) || 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
