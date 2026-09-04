// WSS endpoint resolution. The production default targets the worker domain
// per PRD §4; `VITE_WSS_URL` is the escape hatch for staging/dev. Vite's
// `import.meta.env.DEV` is true under `vite`/`vite build --mode development`
// and false for production builds, so we get a sensible dev default
// (ws://localhost:8787/web — i.e. local `wrangler dev`) without committing
// a `.env.development` file (which `.gitignore` would exclude via `.env.*`).

/** Production default — Cloudflare worker at the canonical domain. */
const PROD_DEFAULT_WSS_URL = 'wss://remote-pi.sankabox.com/web';

/** Local development default — `worker/` running under `wrangler dev`. */
const DEV_DEFAULT_WSS_URL = 'ws://localhost:8787/web';

/**
 * Resolve the WSS URL. `VITE_WSS_URL` wins when non-empty so staging or
 * a remote `wrangler dev` override is honored without rebuilding. In dev
 * builds the dev default kicks in; in production builds the prod default
 * kicks in.
 */
export function resolveWssUrl(): string {
  // `import.meta.env.VITE_WSS_URL` is typed `any` by Vite's default
  // ambient declarations; we narrow to string ourselves so the
  // environment-variable override is actually checked before falling
  // back to the dev/prod defaults below.
  const env: unknown = import.meta.env.VITE_WSS_URL;
  if (typeof env === 'string' && env.length > 0) {
    return env;
  }
  return import.meta.env.DEV ? DEV_DEFAULT_WSS_URL : PROD_DEFAULT_WSS_URL;
}
