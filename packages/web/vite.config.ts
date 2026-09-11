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
    // hast-util-*). To stay under the 350 KB build budget we
    // route any module whose path includes one of the heavy
    // markdown-graph entries into a dedicated `markdown` chunk.
    // The main bundle then stays at ~250 KB (the M3 baseline +
    // ChatView / AssistantMessageBody shell), and the markdown
    // chunk (~310 KB raw / ~93 KB gzip) only loads when a
    // terminal assistant message actually renders. The first
    // chat session may show a brief gap before the first
    // assistant reply is fully formatted; subsequent replies
    // (and any same-session reload) hit the cached chunk.
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
  },
});
