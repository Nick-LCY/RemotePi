// Vitest specs for the App-level closable TokenModal submit
// handler (M5 task 05 D10 + task 06 review W2).
//
// ## Strategy
//
// We test the extracted pure helper `handleClosableTokenSubmit`
// (from App.tsx) directly, mocking `tokenStorage` + the WsClient
// surface + React's setAuth / setStorageError. No DOM is involved
// — the helper is a plain function that takes refs for the side
// effects.
//
// ## Why these tests live as a separate file
//
// `tokenStorage.write/read` round-trips are already covered by
// `token-storage.test.ts`. `TokenModal` UI is covered by
// `token-modal.test.ts`. This file covers the App-level wiring
// specifically — the "write succeeds → setAuth(readAuth())" path
// and the load-bearing W2 invariant that the handler does NOT
// call `client.connect()` directly (the useEffect is the sole
// connect path; a manual call would race the effect's
// cleanup-then-reconnect).

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleClosableTokenSubmit } from '../App.js';

// ---------------------------------------------------------------------------
// Mock the `tokenStorage` module so we control write/read outcomes
// ---------------------------------------------------------------------------

const mockWrite = vi.fn<(value: string) => boolean>();
const mockRead = vi.fn<() => string | null>();

// The path here is relative to App.tsx (the file under test).
// App.tsx lives at packages/web/src/App.tsx and imports the
// module via './ws/tokenStorage.js' — vitest's module mock
// resolution keys off the import specifier, so we mirror the
// exact specifier App.tsx uses.
vi.mock('../ws/tokenStorage.js', () => ({
  write: (value: string) => mockWrite(value),
  read: () => mockRead(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SubmitArgs {
  writeResult: boolean;
  readResult: string | null;
}

function runSubmit(args: SubmitArgs): {
  connectCalls: number;
  setAuthCalls: Array<{ token: string | null; workDir: string | null; session: string | null }>;
  setStorageErrorCalls: Array<string | null>;
} {
  mockWrite.mockReturnValueOnce(args.writeResult);
  mockRead.mockReturnValueOnce(args.readResult);
  const client = { connect: vi.fn() };
  const setAuth = vi.fn();
  const setStorageError = vi.fn();
  handleClosableTokenSubmit({
    value: 'new-token-value',
    client,
    setAuth,
    setStorageError,
    readAuth: () => {
      const token = mockRead();
      return { token, workDir: null, session: null };
    },
  });
  return {
    connectCalls: client.connect.mock.calls.length,
    setAuthCalls: setAuth.mock.calls.map((c) => c[0] as { token: string | null; workDir: string | null; session: string | null }),
    setStorageErrorCalls: setStorageError.mock.calls.map((c) => c[0] as string | null),
  };
}

beforeEach(() => {
  mockWrite.mockReset();
  mockRead.mockReset();
});

// ---------------------------------------------------------------------------
// W2 — closable submit → connect 恰好一次（经 effect 路径）
// ---------------------------------------------------------------------------

describe('App.handleClosableTokenSubmit — M5 task 06 review W2 single-connect invariant', () => {
  it('1. write 成功 + read 拿到新 token → setAuth(readAuth()) 被调一次，client.connect() 不被调用', () => {
    const result = runSubmit({
      writeResult: true,
      readResult: 'fresh-token-from-localstorage',
    });
    // The handler does NOT call connect() directly — the
    // useEffect([client, auth.token]) effect below is the
    // single, deterministic connect path. A manual call would
    // race the effect's cleanup-then-reconnect and tear down
    // the freshly-opened handshake mid-subprotocol-exchange.
    expect(result.connectCalls).toBe(0);
    // setAuth is called exactly once with the freshly-cached
    // token (no auth.client reference; React-side state flush
    // is the only side effect).
    expect(result.setAuthCalls).toHaveLength(1);
    expect(result.setAuthCalls[0]!.token).toBe('fresh-token-from-localstorage');
    expect(result.setAuthCalls[0]!.workDir).toBeNull();
    expect(result.setAuthCalls[0]!.session).toBeNull();
    // storageError is reset to null at the start of the handler
    // (the inline-error banner clears on every new submit
    // attempt).
    expect(result.setStorageErrorCalls).toEqual([null]);
  });

  it('2. write 失败 → setStorageError 设为错误文案，不调 setAuth，不调 client.connect()', () => {
    const result = runSubmit({
      writeResult: false,
      readResult: 'stale-token', // would not be used; setAuth path is gated
    });
    // No connect, no setAuth — the handler short-circuits on
    // write failure so the user can correct the input and
    // resubmit.
    expect(result.connectCalls).toBe(0);
    expect(result.setAuthCalls).toEqual([]);
    // storageError is set to the bridge-error copy and the
    // clear-at-start null set is overwritten by the error set.
    expect(result.setStorageErrorCalls).toEqual([null, '浏览器禁用了本地存储，无法保存 token']);
  });

  it('3. write 成功 + read 拿到 null（旧 token 被清除）→ setAuth 接 null（auth.token === null 触发 required 模式）', () => {
    const result = runSubmit({
      writeResult: true,
      readResult: null,
    });
    // Defensive path: if the user pasted an empty string or the
    // browser's storage write deleted the value, the handler
    // still flushes React state (setAuth(null) → App's
    // auth.token === null branch renders the required
    // TokenModal). No connect, no storageError.
    expect(result.connectCalls).toBe(0);
    expect(result.setAuthCalls).toHaveLength(1);
    expect(result.setAuthCalls[0]!.token).toBeNull();
    expect(result.setStorageErrorCalls).toEqual([null]);
  });
});