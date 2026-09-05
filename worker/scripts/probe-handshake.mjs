#!/usr/bin/env node
/**
 * Handshake probe for a local wrangler worker.
 *
 * Usage:
 *   node worker/scripts/probe-handshake.mjs [ws://host:port/path]
 *
 * The request deliberately includes the token as the second subprotocol
 * element. The printed headers make the server's WebSocket subprotocol
 * selection visible without relying on a browser's stricter handshake check.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';

const target = process.argv[2] ?? 'ws://127.0.0.1:8788/web';
const url = new URL(target);
if (url.protocol !== 'ws:' && url.protocol !== 'http:') {
  throw new Error(`unsupported protocol: ${url.protocol}`);
}

const request = http.request({
  protocol: url.protocol === 'ws:' ? 'http:' : url.protocol,
  hostname: url.hostname,
  port: url.port || (url.protocol === 'https:' ? 443 : 80),
  path: `${url.pathname}${url.search}`,
  method: 'GET',
  headers: {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Protocol': 'remotepi.v1, test-token',
  },
});

request.on('upgrade', (response, socket) => {
  // rawHeaders preserves response header ordering and duplicate headers.
  console.log(`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}`);
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    console.log(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
  }
  socket.destroy();
  process.exit(0);
});

request.on('response', (response) => {
  console.log(`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}`);
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    console.log(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
  }
  response.resume();
  response.on('end', () => process.exit(response.statusCode === 101 ? 0 : 1));
});

request.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});

request.setTimeout(10_000, () => {
  console.error('handshake probe timed out');
  request.destroy();
  process.exit(1);
});

request.end();
