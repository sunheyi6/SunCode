import { resolve } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron';
import electronRenderer from 'vite-plugin-electron-renderer';

export default defineConfig({
  plugins: [
    vue(),
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
              external: ['electron', '@earendil-works/pi-ai', '@modelcontextprotocol/sdk'],
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
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
