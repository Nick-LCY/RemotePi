// M1 hello worker — fetch handler returns a greeting. References
// @remotepi/shared at the type level to prove the workspace link works
// across the monorepo. M2 will replace this with the WebSocket / DO logic.
import { PROTOCOL_VERSION } from '@remotepi/shared';

export default {
  fetch(_request: Request): Response {
    return new Response(`hello from remotepi-hello (protocol v${PROTOCOL_VERSION})`, {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
} satisfies ExportedHandler;
