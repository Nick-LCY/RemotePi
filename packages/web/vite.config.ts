import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // M5 §1 + D1 — react-markdown + remark-gfm + rehype-sanitize
    // pull in ~170 KB raw of transitives (micromark, mdast-util-*,
    // hast-util-*). `manualChunks` here does ONE thing: it routes
    // every module whose path includes one of the heavy
    // markdown-graph entries into a single dedicated `markdown`
    // chunk. This buys chunk-boundary stability (the markdown
    // chunk's hash changes only when a markdown-graph dep
    // changes) and cache separation (long-lived browsers can
    // cache the markdown chunk across deployments that touch
    // only the main bundle).
    //
    // It does NOT, on its own, defer the chunk — Vite / Rollup
    // emit a static `import` for any module reached via a
    // top-level import, which would still bundle the markdown
    // chunk into the first-load graph. The actual deferred load
    // is wired up by `ChatView.tsx` using `React.lazy(() =>
    // import('./AssistantMessageBody.js'))` + a fire-and-forget
    // prewarm `import()` on ChatView mount; the lazy boundary
    // is what keeps the markdown chunk out of the entry chunk.
    // Combined, the entry chunk stays at ~250 KB (the M3
    // baseline + ChatView shell) and the markdown chunk loads
    // on demand when a terminal assistant message first
    // renders (the prewarm effect usually finishes the fetch
    // before that point, so users see no perceptible gap).
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('node_modules/react-markdown') ||
            id.includes('node_modules/remark-gfm') ||
            id.includes('node_modules/rehype-sanitize') ||
            id.includes('node_modules/micromark') ||
            id.includes('node_modules/mdast-util-') ||
            id.includes('node_modules/hast-util-') ||
            id.includes('node_modules/unist-util-') ||
            id.includes('node_modules/vfile')
          ) {
            return 'markdown';
          }
          return undefined;
        },
      },
    },
    // M5 review W1 — don't emit `<link rel="modulepreload">`
    // for the markdown chunk. Vite's default would fetch the
    // 170 KB chunk in parallel with the entry chunk on first
    // load, defeating the lazy boundary. Our warmup effect
    // (`ChatView` mount → fire-and-forget `import('./Assistant
    // MessageBody.js')`) handles the preload intentionally —
    // it kicks off AFTER the entry chunk has started executing
    // so the markdown fetch never blocks the first paint.
    // `polyfill: false` keeps the output minimal (no legacy
    // polyfills; modern browsers only). `resolveDependencies`
    // filters the markdown chunk out of the modulepreload list
    // generated for the entry chunk.
    modulePreload: {
      polyfill: false,
      resolveDependencies: (_filename, deps) => {
        // `deps` is the list of dynamic-import chunks Vite
        // would normally add a `<link rel="modulepreload">`
        // for in the index.html. We drop any dep whose path
        // ends with the markdown chunk filename, so the HTML
        // doesn't pre-fetch the markdown chunk on first load.
        // The chunk is still reachable at runtime via the
        // `React.lazy(() => import(...))` + warmup `import()`
        // in `ChatView`.
        return deps.filter((dep) => {
          const base = dep.split('/').pop() ?? dep;
          return !base.startsWith('markdown-') && !base.startsWith('AssistantMessageBody-');
        });
      },
    },
  },
});
